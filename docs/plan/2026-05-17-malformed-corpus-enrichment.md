# Malformed-packet corpus enrichment — public protocol bases

## Context

The parser-compliance suite at [tests/sip/parser-compliance.test.ts](../../tests/sip/parser-compliance.test.ts) currently carries exactly one source: RFC 4475 — 13 valid cases (`3.1.1.*`) and 19 invalid cases (`3.1.2.*`). That is the entirety of our **axis 1** coverage as pinned in [CONTEXT.md](../../CONTEXT.md) under *Abuse classes → Malformed packet*.

The Spark plan ([docs/plan/design-in-detail-a-reflective-spark.md:134](design-in-detail-a-reflective-spark.md)) explicitly out-of-scopes corpus enrichment with a one-liner: *"extend [parser-compliance.test.ts] with PROTOS-style and other public RFC-malformed samples. Separate plan; small."* This is that plan.

Three observations motivate doing this now rather than later:

1. **The three-parser pass/lenient matrix is the most valuable artefact we have for picking a default parser**, and 19 invalid cases is too small a sample to discriminate. Doubling-to-tripling the invalid set will redistribute the `knownLenient` table in interesting ways.
2. **Axes 2 and 3** (Spark plan) assume axis 1 is handled by the parser before traffic reaches the rule engine. The structural argument that "sipp can only generate RFC-grammar-valid bytes" only holds if the parser actually rejects everything else. A weak axis-1 corpus understates the risk that a malformed packet slips through and lands in the dispatcher.
3. **IPv6 is entirely uncovered.** RFC 4475 is IPv4-only by construction. RFC 5118 was published specifically to cover the IPv6 SIP edge cases (bracket handling in Via/Contact, scope-zone IDs, AAAA-host display-name interaction). We accept IPv6 traffic; we test none of its torture cases.

## License constraint (decided up front)

This repo is MIT-licensed. Any corpus we vendor must be MIT-compatible. **PROTOS c07-sip is GPL v2** — confirmed via the OUSPG distribution page and the Kali / BlackArch packagings. GPL v2 fixtures cannot be vendored into an MIT repo without either relicensing the project or creating a redistribution violation. **PROTOS is therefore dropped from this plan.** No fetch-on-demand workaround either: even a `.gitignored` corpus pulled by a test-time script would still mix GPL-licensed test data with MIT-licensed test code at runtime, which is the contamination we are avoiding.

This decision is recorded here rather than in a separate ADR because it changes nothing about shipped behaviour — it only narrows the corpus sources.

## Goals

- Expand the **invalid** corpus by ~2× — from 19 cases to ≥ 35 — using two MIT-compatible public sources.
- Add the first **IPv6** SIP torture cases (RFC 5118), both valid and invalid.
- Capture **regression coverage for past SIP CVEs** in adjacent stacks (Asterisk, Kamailio, FreeSWITCH, OpenSIPS) as one fixture per CVE. Naming convention `cve-NNNN-NNNNN-shortname.ts`. We are not the affected stack, but the malformed-byte shapes that broke them are the same shapes our parser must reject. Each fixture is reconstructed from the public CVE write-up; we author the bytes, so the fixture file itself is MIT (same as the rest of the repo).
- Keep the per-parser `knownFailValid` / `knownLenient` annotation pattern unchanged — extension only, no refactor.
- Surface a **per-source rejection-rate scorecard** in the test output that tells us, per parser, "of N cases in source X, parser Y rejected M". This is the artefact that informs the parser default decision.

## Non-goals

- **No coverage-guided fuzzing.** No AFL++, no boofuzz harness, no continuous-fuzz job. Fuzzing is a separate decision with its own infrastructure cost (corpus minimisation, crash triage, CI runtime budget). Static fixture extension is the cheap, deterministic win; fuzzing comes later if axis-1 incidents keep appearing.
- **No axis 2/3/4 enrichment.** Volume and out-of-sequence belong to the Spark plan; nefarious-injection belongs to the future risk-inventory plan referenced in `project_internal_dns_attack_risk`.
- **No parser-implementation changes.** If a new fixture exposes a real bug in the custom parser, it lands in `knownFailValid` or `knownLenient` with a TODO comment and a follow-up issue — not a hurried fix in this plan.
- **No new test runner.** Reuse the existing `describe.each(parsers)` pattern with one new describe block per source.

## Design

### Sources, in priority order

| Source | Cases | Type | License | Implementation cost |
|---|---|---|---|---|
| **RFC 5118** — IPv6 SIP torture | ~10 valid + ~10 invalid | Standards-track RFC, public | RFC text is freely usable; the fixture file we transcribe is our own MIT code | Transcribe from the RFC, same `sipMsg` template style as 4475 |
| **CVE regression PoCs** | 1 per CVE (~15 worth porting) | Reconstructed by us from public CVE write-ups | We author the bytes → fixture file is MIT, same as the rest of the repo | Hand-curate; one buffer per CVE |

### Directory layout

```
tests/sip/fixtures/
├── rfc4475-valid.ts          # existing, untouched
├── rfc4475-invalid.ts        # existing, untouched
├── rfc5118-ipv6.ts           # NEW — valid + invalid IPv6 cases from RFC 5118
└── cve-regression/           # NEW — one file per CVE
    ├── index.ts              # re-exports a Map<caseId, Buffer>
    ├── cve-2008-3263-asterisk-from-overflow.ts
    ├── cve-2017-7474-kamailio-tps-loop.ts
    └── ...                   # one per CVE, see catalogue below
```

### CVE catalogue (initial set)

Pulled from public CVE write-ups in adjacent SIP stacks. Each is one malformed message that crashed/hung/overflowed a real stack — exactly the regression shape worth capturing. Final list confirmed during implementation; this is a starting point, not a contract.

- CVE-2008-3263 (Asterisk) — oversized `From` header overflow.
- CVE-2011-2535 (Asterisk) — RTCP-related but with SIP delivery vector.
- CVE-2017-7474 (Kamailio) — `tps_limit` loop on crafted Contact.
- CVE-2018-8825 (FreeSWITCH) — Contact-header parsing OOB.
- CVE-2020-15859 (Kamailio) — auth header parsing.
- CVE-2021-37624 (FreeSWITCH) — INVITE without authentication credential-bypass shape.
- CVE-2022-23537 (PJSIP) — STUN over SIP transport buffer overflow shape.
- CVE-2023-22042 (Asterisk) — `pjsip` `Contact` header denial.
- CVE-2023-37790 (OpenSIPS) — `Contact` header parsing crash.
- (target ~15 by ship; drop any whose PoC isn't reconstructible from public sources)

A CVE we cannot reproduce from public information goes in `cve-regression/README.md` as "wanted but unattainable" rather than half-implemented.

### Test wiring

Three new describe blocks in [parser-compliance.test.ts](../../tests/sip/parser-compliance.test.ts), all reusing the existing `describe.each(parsers)` pattern:

1. `"$name — RFC 5118 IPv6 torture (valid)"` — same shape as the existing valid-cases block; new `knownFailValid` entries keyed by `5118.*`.
2. `"$name — RFC 5118 IPv6 torture (invalid)"` — same shape as the existing invalid-cases block; new `knownLenient` entries keyed by `5118.*`.
3. `"$name — CVE regression (must reject)"` — every CVE fixture must be rejected by every parser. A CVE that any parser accepts is a real parser-strictness gap.

**Update after first run:** the no-leniency stance proved aspirational. The first three CVEs (CVE-2023-27598/27599/28098, all OpenSIPS) are rejected by jssip but accepted by both sip-parser and our custom parser — three gaps in our own strictness that were exactly the kind of bug this test was designed to surface. To ship the test green while keeping the gaps loud, we use the same `knownLenient`-style table as the RFC-4475 invalid block, but with two differences: (a) the table is named `knownCveLenient` to mark intent, and (b) each entry carries an inline comment naming the parser-side fix that should retire it. The `throw new Error("... now rejects ...")` regression-detector path is identical to the existing pattern, so when we tighten the custom parser, the test will tell us to remove the entry.

### Per-source scorecard output

The current test output is per-case pass/fail. After this plan, the suite additionally emits a summary at the end of each parser's section:

```
[parser=custom]   RFC 4475:        13/13 valid parsed, 11/19 invalid rejected
[parser=custom]   RFC 5118:        10/10 valid parsed,  9/10 invalid rejected
[parser=custom]   CVE-regression:  15/15 rejected
```

Implementation: a `console.log` in an `afterAll` per describe block, using a per-parser counter built up by the case loop. Not pretty, but visible in CI logs and grep-able. A structured JSON dump is out of scope.

### File changes

- [tests/sip/parser-compliance.test.ts](../../tests/sip/parser-compliance.test.ts) — three new describe blocks, extend `knownFailValid` and `knownLenient` maps with `5118.*` keys. Add `afterAll` scorecard emitter.
- New: [tests/sip/fixtures/rfc5118-ipv6.ts](../../tests/sip/fixtures/) — IPv6 torture cases. Reuse `sipMsg` template tag from [rfc4475-valid.ts](../../tests/sip/fixtures/rfc4475-valid.ts).
- New: [tests/sip/fixtures/cve-regression/](../../tests/sip/fixtures/) — directory with one fixture per CVE plus `index.ts` re-export.
- No changes to parser implementations. No changes to [src/sip/parsers/](../../src/sip/parsers/).

## Verification

- `npm run typecheck` clean.
- `npm run test:fake` — three new describe blocks pass. Pre-existing 4475 results unchanged byte-for-byte in the per-parser scorecard.
- Manually inspect the scorecard output for the custom parser. Expectation: rejection rate on CVE-regression is 100 %. A lower number is a finding to record and triage (separate issue), not a blocker for this plan.
- One sampled CVE fixture is sanity-checked manually: feed it to `curl` against a dev B2BUA and confirm it's parser-rejected at ingest (`b2bua_parse_dropped_total` increments), never reaches dispatcher. This isn't part of the automated suite — it's a one-time confidence check on the seam.

## Out of scope (for future plans)

- **Coverage-guided fuzzing** (boofuzz, AFL++ with SIP harness). Different infrastructure cost; defer until the static-corpus extension surfaces enough findings to justify it.
- **Stateful protocol fuzzing** (tlsfuzzer-style sequences). This is axis 3 territory; the Spark plan already owns archetype-based sequencing. Coverage-guided stateful fuzzing is a separate, larger plan.
- **Field-by-field anomaly generation** (the PROTOS *methodology*, as distinct from its corpus). A generator that emits, say, "for every header H, emit message with H overlong / H truncated / H with embedded CR / H with high-bit bytes / …" would be procedurally richer than the static corpus. Out of scope here; flagged for a future plan if the static corpus hits a ceiling.
- **Wire-level deviations from non-UDP transports.** Our axis 1 corpus is UDP-only because the B2BUA accepts only UDP today. If TCP/TLS/WS transports land, the corpus must be revisited (e.g. CRLF-injection cases behave differently with framed transports).

## ADR

No ADR required. This plan adds test coverage without changing any contract, gate, verdict semantic, or shipped behaviour. The PROTOS license decision is recorded inline above rather than in a separate ADR.
