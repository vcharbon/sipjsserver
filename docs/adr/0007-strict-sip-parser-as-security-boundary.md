# ADR 0007 — Strict SIP parser as security boundary

**Status:** Accepted (2026-05-18)

## Context

External SIP traffic is adversarial. The PROTOS c07-sip fuzzing corpus
(4 527 mutated INVITEs) and the secusiptest compliance suite measure
how many shapes a parser silently accepts; before this change the
sipjsserver parser tolerated 543 grammar gaps that downstream code had
to defend against individually.

The leniency had a real cost: each accepted-but-malformed message
forced a downstream rule to re-validate the wire form (sip-parser
adapter parameter stripping, jssip's lenient transport, the lenient
`parseHostPort` accepting `10.10.10.256:5060`, etc.). The secusiptest
policy classifier had to reimplement nine strict-grammar rules as
"stack-bug" entries — explicitly tagged as belonging inside the parser
but living in test code as a workaround.

This ADR makes those nine rules first-class parser-time rejections.

## Decision

Treat the SIP parser as the **security boundary**: every external
packet either parses to a well-formed SipMessage or fails fast with
`SipParseError`. Nine rules move into the parser:

| Rule (secusiptest tag) | RFC anchor | Where it fires |
|---|---|---|
| `via_branch_missing_magic_cookie` | RFC 3261 §8.1.1.7 | `extract-fields.ts`, topmost Via only |
| `via_sentby_host_malformed` | RFC 3261 §25.1 (`host`) | `validateStrictHost` — IPv4 octets ≤ 255, no leading zeros, hostname labels alphanum-start, IPv6 bracket-content passes |
| `via_sentby_multiple_colons` | RFC 3261 §25.1 (`hostport`) | raw colon count in sent-by, outside `[...]`, before `;` |
| `via_sent_protocol_malformed` | RFC 3261 §25.1 (`sent-protocol`) | `checkSentProtocol` — three non-empty `1*tchar` tokens, LWS permitted around `/` |
| `via_non_standard_transport` | RFC 3261 §7.1 (`other-transport`) | `SipParserLimits.allowedTransports` allowlist; fail-closed default `{UDP,TCP,TLS,SCTP,WS,WSS}` |
| `invalid_sip_uri_grammar` | RFC 3261 §25.1 (`SIP-URI`) | `validateStrictSipUri` on Request-URI / From / To / Contact eagerly; lazy URI-bearing headers (PAI/Diversion/History-Info/etc., Refer-To) tighten when consumed |
| `invalid_numeric_header` | RFC 3261 §20.14/16/19/22/23, RFC 4028 §4/5 | numeric-header registry in `headers.ts` with `strictNonNegativeDecimal` |
| `cseq_missing_method` | RFC 3261 §20.16 | CSeq strict pass — digits + non-empty method, both requests and responses |
| `sdp_body_malformed` | RFC 4566 §5 | `validateSdpBody` exported from `SdpUtils.ts`, callable on demand (REFER blind-transfer path stays graceful; secusiptest invokes directly) |

The framework piece: `extractCommonFields` / `extractRequestFields` /
`extractResponseFields` gain a `mode: "wire" | "hydrate"` parameter.
Wire-parsed messages run every gate above; `hydrateRequest` /
`hydrateResponse` (test scaffolding, B2BUA re-INVITE construction) pass
`mode = "hydrate"` and only the pre-existing baseline checks fire.
A new `SipParser.lenientLayer` is exposed for harness rule self-tests
that need to mutate wire bytes and observe per-rule rejection without
the parser pre-empting.

### Float-injection countermeasure

`parseInt(value, 10)` silently accepts `1.5e10`, `0x10`, `+10`, `-10`,
`" 10 "`, `1_000`, `NaN`, `Infinity`. Every numeric SIP header is
parsed via `strictNonNegativeDecimal(s, max)` — a byte-level
`[0-9]+`-only scan with mid-loop overflow detection. No `parseInt`
remains in the header validation path. The helper lives in
`src/sip/parsers/custom/scanner.ts`.

### What was rejected from the design space

- **No `kind` discriminator on `SipParseError`.** The reason text
  carries the rule identity (e.g. `"Top Via branch missing magic
  cookie..."`). Adds zero blast radius to the ~50 existing
  construction sites. secusiptest matches on substrings.
- **No second `SdpValidationError` plumbed into `SipParser.parse`.**
  SDP validation stays on-demand — invoked only where the B2BUA
  manipulates SDP (REFER blind-transfer path uses tolerant
  `extractCodecProfile` by design). A pass-through B2BUA forwarding
  malformed SDP is RFC-correct.

## Trade-offs

### Throughput cost

Custom-parser micro-benchmark (`bench/sip-parser-bench.ts`, 1 M
iterations per message type, single core):

| Message | Before | After | Delta |
|---|---|---|---|
| INVITE | 6.5 μs / 153 740 msg/s | 9.5 μs / 105 776 msg/s | +46 % per-msg, −31 % throughput |
| 200 OK | 6.2 μs / 161 925 msg/s | 9.0 μs / 110 694 msg/s | +45 % per-msg, −32 % throughput |
| BYE | 5.6 μs / 180 121 msg/s | 8.4 μs / 118 841 msg/s | +50 % per-msg, −34 % throughput |

The hot path now spends ~3 μs more per message on: strict
sent-protocol scan per Via, strict host validation per Via, strict
SIP-URI ABNF on four URIs (Request-URI / From / To / Contact),
top-Via magic-cookie check, transport allowlist lookup, CSeq paranoid
digit + method scan, multi-colon raw scan, numeric-header registry
in the header loop.

At production call rates (typically 10–100 CPS per worker), parser
cost is dominated by Effect fiber overhead, rule engine, and Redis
I/O — the 30 % parse-side slowdown is invisible. For extreme
shed-test scenarios where the LB pushes microsecond budgets per
packet, the same `SipParserLimits` knobs can disable individual gates
(e.g. operators who control their upstream may opt out of the
allowlist).

### RFC 4475 divergence

Three torture-test fixtures from RFC 4475 §3.1.1 no longer pass:

| Fixture | What it tests | Why we reject |
|---|---|---|
| 3.1.1.1 — wsinv | tortuous valid INVITE | top Via uses `branch=390skdjuw` — RFC 2543 legacy, no magic cookie |
| 3.1.1.7 — long values | extremely long headers | top Via `Via: SIP/2.0/TCP sip33.example.com` — no branch param at all |
| 3.1.1.10 — varied transports | `Via: SIP/2.0/UNKNOWN …` | RFC 4475 says we should accept; our default allowlist rejects |

RFC 4475 was written in 2006 with maximum backward-compat in mind.
RFC 3261 §8.1.1.7 itself only "SHOULD" require the magic cookie on
receive — but every modern stack treats magic-cookie-less branches as
a security signal, and the project's threat model is adversarial
external traffic, not interop with 2543 proxies. We diverge by design.

The three fixtures are explicitly marked in `knownFailValid` /
`knownStrictReject` in `tests/sip/parser-compliance.test.ts` with a
pointer to this ADR.

### sip-parser adapter

The npm `sip-parser` (Formup) library canonicalises Via / From /
Contact values, **stripping all parameters** before the adapter sees
them. Our magic-cookie check fires on the resulting `branch=undefined`.
sip-parser is a third-party benchmark, not a production code path, so
its fixtures now uniformly fail under the strict pipeline. This is a
pre-existing sip-parser limitation surfaced (not caused) by ADR-0007.

## Consequences

### Observable

- `b2bua_parse_dropped_total` rises in proportion to the share of
  upstream traffic that's RFC-loose. Operators who see a jump after
  upgrade should compare their upstream stack against the rule list
  above before assuming a new attack.
- secusiptest's PROTOS scorecard shifts ~650 cases from
  `rejected_by_policy` → `rejected_by_parser`. The nine `stack-bug`
  policy rules can be retired from the secusiptest classifier.

### Configurability

`SipParserLimits` grows two fields:

```ts
allowedTransports: ReadonlySet<string>  // default {UDP,TCP,TLS,SCTP,WS,WSS}
wireGrammar: boolean                    // default true; false for harness/test scaffolding
```

Override per layer: `SipParser.withLimits({ allowedTransports: new
Set([..., "SCCP"]) })`.

### Test-harness scaffolding

`hydrateRequest` / `hydrateResponse` automatically use `mode =
"hydrate"`; existing tests that construct synthetic messages with
shorthand Via values (`{ name: "Via", value: "via-1" }`) keep working.
The RFC rule self-tests (`tests/harness/rules/rfc/`) parse via
`SipParser.lenientLayer` so they can mutate the wire bytes and
observe the rule fire.

## Alternatives considered

- **Per-rule kind discriminator on SipParseError.** Rejected — adds
  noise to ~50 construction sites with no consumer that needs
  structural attribution today. Reason text is sufficient.
- **Separate validator pass after parse.** Rejected — would leave
  the secusiptest workaround half-retired (cases would still need a
  second classification step on our side rather than theirs).
- **Off-by-default strict mode.** Rejected — the goal is fail-closed
  defaults. Operators with legacy upstream stacks opt out by name.

## References

- [secusiptest report](../../../secusiptest/reports/protos-accepted-cases.json)
  — pre-change scorecard (750 / 1571 / 2205 split).
- [bench/sip-parser-bench.ts](../../bench/sip-parser-bench.ts)
  — perf measurement harness.
- RFC 3261 §8.1.1.7, §20.14/16/19/22, §25.1
- RFC 4566 §5
- RFC 4475 §3.1.1.1, §3.1.1.7, §3.1.1.10
- RFC 4028 §4, §5 (Session-Expires / Min-SE)
