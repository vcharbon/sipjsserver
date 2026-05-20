# Integrating a compiled SIP parser (C or Rust) for UDP ingest

## Context

The B2BUA currently parses every inbound UDP datagram in pure TypeScript via a
hand-written zero-regex state machine ([src/sip/parsers/custom/](../../src/sip/parsers/custom/)),
benchmarked at **9.5 µs/msg, 105k msg/sec single-core** ([bench/sip-parser-bench.ts](../../bench/sip-parser-bench.ts)).
Strict ADR-0007 validation and a CVE-regression corpus
([tests/sip/fixtures/cve-regression/](../../tests/sip/fixtures/cve-regression/),
[tests/sip/parser-compliance.test.ts](../../tests/sip/parser-compliance.test.ts))
just landed.

Goals (per user):
- **Throughput / latency**: lift the per-core ceiling.
- **CVE / security posture**: lean on a parser hardened against real-world fuzz exposure.

Constraints:
- Keep the pure-JS adapter selectable as a fallback (the existing adapter
  pattern in [src/sip/parsers/](../../src/sip/parsers/) stays — `custom` is one of three).
- Prebuilt binaries shipped via npm; no compile-on-install.
- Must run inside K8s (glibc base image; musl/Alpine optional but desirable).
- No change to the downstream contract: `messages: Stream.Stream<UdpPacket>` and
  `SipMessage` shape ([src/sip/types.ts](../../src/sip/types.ts)) remain authoritative.

Critical insight from exploration: the parser is **not** the current hot
bottleneck. The Tier-1 admission brake ([src/sip/UdpTransport.ts:82-98](../../src/sip/UdpTransport.ts#L82-L98))
runs a byte-scan **before** parsing under load, and the bench's 9.5 µs/msg
sits comfortably above ordinary line rate. A naive "swap JS parse for FFI parse"
loses: an N-API call round-trip costs ~100–500 ns and the materialisation of
the `SipMessage` JS object dominates parse time itself. **The real CPU win
arrives only when native code owns the UDP socket** and we amortise the FFI
boundary across many packets — emitting pre-parsed `SipMessage` values
into a `Stream` via threadsafe callbacks. That is the user's stated target
and what the recommendation below pursues.

---

## Architectural alternatives

Four shapes were considered. Each respects the adapter contract and the
downstream `Stream<UdpPacket>` / `SipMessage` interface.

### A. In-process FFI parser only (JS keeps the socket)

A new adapter under [src/sip/parsers/native-adapter.ts](../../src/sip/parsers/) calls
into a Rust/C library via N-API. JS still owns the dgram socket; only the
synchronous parse step jumps the boundary.

- **Win**: parse strictness from a battle-tested library; smallest blast radius.
- **Loss**: N-API call + result-object materialisation per packet probably
  cancels the parse-time savings. **No socket-side CPU win.**
- **Risk**: minimal — the JS path remains intact behind the adapter switch.

### B. Native UDP + native parse → JS `Stream<SipMessage>` (recommended)

A Rust addon (napi-rs) owns the UDP socket, batches `recvmmsg(2)`, runs the
parser inline, and pushes parsed messages onto a JS-side `Stream` via
`ThreadsafeFunction`. The Tier-1 byte-scan brake moves into Rust where it
runs at memory bandwidth.

- **Win**: amortises the FFI hop across batches; eliminates the per-packet
  Buffer allocation; keeps the V8 event loop free; CVE-hardened parser path.
- **Loss**: largest architectural change. Native code owns a real resource
  (socket) so lifecycle/shutdown discipline matters. Tier-1 brake metrics
  cross the FFI boundary instead of living in pure TS.
- **Risk**: medium — addressed by Phase 1 keeping JS-side socket and only
  Phase 2 moving it down once the parser path is proven.

### C. WebAssembly parser (Rust compiled to WASM)

Compile the parser to WASM, run it in-process. No native binary, no
prebuild matrix.

- **Win**: single artefact, identical on every K8s base image (musl, distroless,
  Alpine). Memory-safe by construction.
- **Loss**: WASM is typically 1.5–3× slower than native Rust on parsing
  workloads. Memory copy across the linear memory boundary is similar to N-API.
  No socket ownership possible. So you pay native-equivalent integration cost
  for a parser that is at best ~2× faster than the current TS parser.
- **Risk**: low, but the ceiling is also low. Worth keeping in mind as a
  fallback build artefact for environments where native loading is impossible.

### D. Worker-thread pool, JS sockets + native parse per worker

`SO_REUSEPORT` fans incoming datagrams across N worker threads; each worker
runs a native parser. This is essentially Architecture B replicated and
multi-core.

- **Win**: trivially horizontal across cores; useful if a single core
  saturates.
- **Loss**: each datagram still crosses the worker boundary (postMessage or
  shared `ArrayBuffer`), and SIP is order-sensitive on a per-dialog basis —
  fan-out either needs a hashing affinity layer or coordinated state. Adds
  complexity that the cluster mode (existing `IpcTransport`) mostly
  already addresses at the process level.
- **Risk**: high coupling with existing cluster work. **Not recommended now**;
  revisit only if Architecture B saturates a single core and process-level
  cluster mode is undesirable.

---

## Library choice (for the native side of B)

Three candidates rated against goals:

| Library | Lang | Strictness | Maturity | Bindings work needed |
|---|---|---|---|---|
| **rvoip-sip-core** | Rust | dual strict/lenient flag | alpha (2025) | napi-rs from scratch |
| Sofia-SIP (via Rust FFI wrap) | C | lenient by default | 15+ yrs production | bind the parser module only |
| Write a thin Rust parser mirroring the current TS strictness | Rust | matches ADR-0007 exactly | new code | napi-rs from scratch |

**Recommendation: rvoip-sip-core wrapped in napi-rs**, with our existing CVE
corpus as the strictness contract.

Reasoning:
- The CVE corpus + parser-compliance suite already encodes our policy. Any
  candidate must pass it; rvoip-sip-core's strict mode is the closest match
  on paper.
- Sofia-SIP is mature but lenient. Inheriting its strictness posture means
  weakening what we just hardened, or layering our own validation on top —
  at which point we are no longer leveraging Sofia's compliance, only its code.
- Writing our own Rust parser is feasible (the grammar is well-defined and
  our TS implementation is the spec) but is the largest engineering bet.
  Park it as the fallback if rvoip-sip-core fails compliance.
- napi-rs is the cleanest Node binding story today: prebuild matrix via
  GitHub Actions (`@napi-rs/cli`), `ThreadsafeFunction` for socket-to-Stream
  bridging, supports glibc + musl out of the box. Avoids node-gyp.

---

## Recommended path — phased

Two phases, each individually shippable and revertible via the adapter switch.

### Phase 1 — Native parser behind the existing adapter (Architecture A as a stepping stone)

Goal: validate the library + bindings + build pipeline without touching the
socket layer.

1. New package directory `native/sip-parser/` (workspace) containing a
   napi-rs crate that wraps `rvoip-sip-core` and exposes one function:
   `parse(buf: Buffer): { kind: "ok", value: NativeParsedMessage } | { kind: "err", reason: string }`.
   The return shape is **flat plain-old data** mirroring `SipMessage` so the
   JS adapter can rehydrate without further parsing. Lazy structured headers
   (PAI, Diversion, History-Info, Refer-To, RAck — see
   [src/sip/types.ts:100-113](../../src/sip/types.ts#L100-L113)) stay raw strings; the
   existing TS lazy parsers in
   [src/sip/parsers/custom/lazy-parsers.ts](../../src/sip/parsers/custom/lazy-parsers.ts)
   are reused on first access.
2. New adapter [src/sip/parsers/native-adapter.ts](../../src/sip/parsers/) implementing
   `SipParserImpl` from [src/sip/parsers/interface.ts](../../src/sip/parsers/interface.ts).
   Wires the napi-rs result into `finalizeRequest` / `finalizeResponse`
   from [src/sip/parsers/extract-fields.ts](../../src/sip/parsers/extract-fields.ts)
   so the produced `SipMessage` is byte-for-byte indistinguishable from
   the custom parser's output.
3. Config knob `sipParserImpl: "custom" | "jssip" | "sip-parser" | "native"`.
   Default stays `custom`. The native variant is opt-in.
4. Build pipeline: `@napi-rs/cli` produces prebuilds for
   `x86_64-unknown-linux-gnu`, `x86_64-unknown-linux-musl`,
   `aarch64-unknown-linux-gnu` (cover the K8s base images we ship).
   Published as a workspace npm package; consumed via `optionalDependencies`
   so install never breaks on unsupported triples.
5. Validation gates (all must pass before Phase 2 starts):
   - **Compliance**: every fixture in
     [tests/sip/parser-compliance.test.ts](../../tests/sip/parser-compliance.test.ts)
     passes, including the CVE-regression corpus.
   - **Bench**: re-run [bench/sip-parser-bench.ts](../../bench/sip-parser-bench.ts)
     with `--parser=native`. Record the per-msg cost. If it is **higher**
     than 9.5 µs (likely, due to the FFI hop), the data confirms Phase 2 is
     where the win lives.
   - **Fake-stack test suite**: `npm run test:fake` green with
     `sipParserImpl=native`.

### Phase 2 — Native socket + parser, threadsafe `Stream<UdpPacket>` (Architecture B)

Pushed the socket boundary down. Shipped as two slices so the runtime
toggle exists before the brake migration, letting endurance and robustness
A/B comparisons run on the same binary.

#### Toggle design

Activated via the `SIP_UDP_STACK` env var (default `js`). One pod per
stack lets the endurance suite drive identical load through both pipelines
and compare event-loop lag / parse latency / memory residency.

- `SIP_UDP_STACK=js` (default) — `dgram` socket + `customParser` post-parse.
  Existing pipeline; unchanged behaviour.
- `SIP_UDP_STACK=native` — Rust UDP socket (tokio) + rvoip strict parse
  inline + JS-side `extractRequestFields` strict gates + pre-parsed
  `SipMessage` on the `UdpPacket`. `TransactionLayer`'s parse hop is
  short-circuited.

Both stacks satisfy the same [`SignalingNetwork`](../../src/sip/SignalingNetwork.ts)
service contract — same `bindUdp` signature, same `UdpEndpoint` shape, same
`Stream<UdpPacket>` semantics — so every consumer above the network layer
is identical between deployments.

#### Phase 2A (shipped)

1. **Rust native UDP module** ([native/sip-parser/src/lib.rs](../../native/sip-parser/src/lib.rs)
   `open_udp`, `NativeUdpHandle`): tokio multi-thread runtime (1 worker)
   owns the socket. The recv loop calls `socket.recv_from`, runs the rvoip
   strict parser inline, wraps the result in a `RecvEmit` struct, and
   dispatches via `ThreadsafeFunction` to a JS callback. `send`/`close`/
   `metrics`/`localAddress` exposed as instance methods on the handle.
   Strict-parse failures are silently dropped with a `parse_drops` counter;
   the JS pipeline never sees them.
2. **`UdpPacket.parsed` field** ([src/sip/SignalingNetwork.ts](../../src/sip/SignalingNetwork.ts))
   — optional `SipMessage` populated by the native fabric. JS dgram
   fabrics leave it `undefined`; downstream callers fall back to
   `parser.parse(raw)`.
3. **`TransactionLayer` short-circuit** ([src/sip/TransactionLayer.ts:744-748](../../src/sip/TransactionLayer.ts#L744-L748))
   — uses `packet.parsed` when set, else delegates to the configured
   `SipParser`. Per-packet parse cost off the JS event loop entirely
   for the native stack.
4. **`NativeSignalingNetwork.layer`** ([src/sip/NativeSignalingNetwork.ts](../../src/sip/NativeSignalingNetwork.ts))
   — `SignalingNetwork`-typed `Layer.sync`. Each `bindUdp` calls
   `binding.openUdp`; the recv callback runs the JS-side `preIngress`
   hook (Phase 2A keeps it in JS — see 2B below), materialises a
   `SipMessage` via `extractRequestFields`/`extractResponseFields`, and
   offers the `UdpPacket` into a bounded Effect `Queue` (tail-drop on
   full mirrors the dgram impl). `send` delegates to the native handle;
   `close` runs in an `Effect.addFinalizer`.
5. **Toggle in [src/main.ts](../../src/main.ts)** — reads
   `process.env["SIP_UDP_STACK"]` and picks either
   `SignalingNetwork.real` or `NativeSignalingNetwork.layer`. The choice
   is bound at layer-construction time so child layers see exactly one
   `SignalingNetwork` implementation.
6. **`AppConfig.sipUdpStack`** ([src/config/AppConfig.ts](../../src/config/AppConfig.ts))
   — `Schema.Literals(["js", "native"])`, sourced from `SIP_UDP_STACK`.
   Surfaced so the value is observable in `/status` and so test/embedded
   defaults (`testAppConfigDefaults`, `defaultHybridAppConfig`,
   `defaultEmbeddedAppConfig`) can carry it.

Validation done:
- `npm run typecheck` clean (tsc + Effect language-service plugin).
- `npm run test:fake` — 1452/1461 pass; 1 pre-existing flake
  (`tests/sip-front-proxy/load-balancer/distribution.test.ts`,
  passes in isolation).
- End-to-end smoke ([scripts/native-udp-smoke.ts](../../scripts/native-udp-smoke.ts))
  — `bindUdp` on the native layer, external dgram client sends an INVITE,
  `endpoint.messages` emits a `UdpPacket` with `parsed.method === "INVITE"`
  and all eager headers (From-tag, To-URI, Via-branch) correctly typed.

#### Phase 2B (not yet shipped)

- Port the Tier-1 byte-scan brake into Rust
  ([src/sip/MessageHelpers.ts](../../src/sip/MessageHelpers.ts)
  `isInviteRequestBuffer` / `bufferHasEmergencyMarker` /
  `buildStatelessReject503Buffer` / `jitteredRetryAfter`). Currently the
  brake runs in the JS-side recv callback — functionally correct but
  wastes the native parse cost on packets that ultimately get the
  brake response. After the port: brake decisions happen pre-parse in
  Rust; native parse only runs for accepted packets; the 503 template
  send-back uses the native socket directly without bouncing through JS.
- `recvmmsg(2)` batched recv. Phase 2A uses `recv_from` per packet; the
  big amortisation win predicted by Phase 1's bench data needs the
  batched syscall + batched TSFN dispatch to materialise.
- Prebuild matrix (`x86_64-unknown-linux-gnu`, `x86_64-unknown-linux-musl`,
  `aarch64-unknown-linux-gnu`) via `@napi-rs/cli` + `optionalDependencies`,
  so K8s nodes auto-load the right `.node` and the `js` fallback kicks in
  on unsupported triples.
- Bench: extend `bench/sip-parser-bench.ts` (or new `bench/udp-loop-bench.ts`)
  with a real-socket loop variant so the per-packet wire-to-Stream
  latency is measurable, not just the in-memory parse.

#### Open follow-ups

- **`ProxyCore` parse short-circuit** ([src/sip-front-proxy/ProxyCore.ts:518](../../src/sip-front-proxy/ProxyCore.ts#L518))
  doesn't read `packet.parsed`; the proxy is currently JS-stack-only.
  Plumbing the field through is mechanical but out of scope for B2BUA
  A/B comparison.
- **Test-harness `interpreter.ts` parse sites** ([src/test-harness/framework/interpreter.ts:1208 & :1895](../../src/test-harness/framework/interpreter.ts))
  use `parser.parse(packet.raw)`. Fake-stack tests never run the native
  fabric (no real sockets), so this is fine; the harness only matters if
  someone wires a native fabric into a fake-clock scenario, which we
  don't do today.

---

## Critical files

Read-only references (must match shape, do not break contract):
- [src/sip/types.ts](../../src/sip/types.ts) — `SipMessage`, `SipRequest`, `SipResponse`, header registry.
- [src/sip/parsers/interface.ts](../../src/sip/parsers/interface.ts) — `SipParserImpl`, limits.
- [src/sip/parsers/extract-fields.ts](../../src/sip/parsers/extract-fields.ts) — `extractRequestFields`, `extractResponseFields`, `finalizeRequest`, `finalizeResponse` — **reuse these from the native adapter** so the produced `SipMessage` is byte-identical to the custom parser's.
- [src/sip/parsers/custom/lazy-parsers.ts](../../src/sip/parsers/custom/lazy-parsers.ts) — lazy structured-header parsers kept in TS.
- [src/sip/SignalingNetwork.ts](../../src/sip/SignalingNetwork.ts) — `bindUdp`, `UdpEndpoint`, `UdpPacket`. Phase-2 native variant must conform.
- [src/sip/UdpTransport.ts](../../src/sip/UdpTransport.ts) — facade is reused as-is.
- [src/sip/TransactionLayer.ts](../../src/sip/TransactionLayer.ts#L744-L748) — parse call site; Phase 2 short-circuits when packet is pre-parsed.
- [src/sip/MessageHelpers.ts](../../src/sip/MessageHelpers.ts) — Tier-1 byte-scan + 503 template; Phase 2 ports to Rust.

To add:
- `native/sip-parser/` — napi-rs workspace package (Rust crate + `package.json`).
- `src/sip/parsers/native-adapter.ts` — JS adapter implementing `SipParserImpl`.
- Phase 2: `native/sip-udp/` (may live in the same crate) + a new `SignalingNetwork` variant.

Config:
- [src/config/AppConfig.ts](../../src/config/AppConfig.ts) — add `sipParserImpl` (Phase 1) and `sipUdpTransport` (Phase 2) knobs; both default to existing pure-JS behaviour.

---

## Verification

After Phase 1:
- `npm run typecheck` — zero errors and zero warnings (tsc + Effect plugin both clean).
- `npm run test:fake` — green with `sipParserImpl=native` and `sipParserImpl=custom`.
- `npm run test` — full short-tier live suite green with native parser.
- `node bench/sip-parser-bench.ts --parser=native` — record per-msg cost vs the 9.5 µs/msg custom baseline. **Expect the native parser to be similar or slightly worse here** — the FFI hop is being measured, not the parse.

After Phase 2:
- `npm run test:ci` (fake + medium-tier live) green with native UDP enabled.
- Live throughput run against the e2e harness ([tests/fullcall/](../../tests/fullcall/))
  — measure messages/sec/core with native socket vs JS socket. **This is
  where the CPU win must show.** Acceptance: ≥3× messages/sec/core under
  the existing e2e load profile, with event-loop lag (measured via the
  existing observability surface) lower than the JS baseline.
- Kill-switch test: set `sipUdpTransport=js` in K8s rolling restart, verify
  no traffic loss and metrics surface continues to render.
- Tier-1 brake test: replay the overload-protection scenario from
  [docs/overload-protection.md](../overload-protection.md) end-to-end with
  the native brake; counters must match the JS-side counters within
  ±1% over a 60s soak.
