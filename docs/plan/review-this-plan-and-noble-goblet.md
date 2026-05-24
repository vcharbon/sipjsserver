# Plan: Effect Layer wrappers + per-peer SIP RFC monitor

**Track:** multi-session vertical slices. Each slice is one focused session, lands type-clean, ships independently.
**Plan file role:** index + slice catalog. Each slice gets its own plan file when it's executed.

---

## Context

`src/call/codec/contracts.ts` is the worked example of the four-wrapper pattern from `.claude/skills/effect-layer-test`: `propertyTest` / `paranoidInputs` / `parity` / `scopedAudit`, each wraps a Tag's implementation Layer without changing the Tag or service shape. Failure shapes: sync `Error` subclasses with `_tag` for sync APIs, `Data.TaggedError` for the scope-close finalizer in `scopedAudit`.

Three other layers in this codebase carry invariants that today escape test enforcement:

- **SignalingNetwork** ([src/sip/SignalingNetwork.ts:280](src/sip/SignalingNetwork.ts#L280)) — per-peer counter sanity, undelivered drain, and most importantly SIP-protocol completeness per peer (every INVITE answered, every transaction terminated, no orphan Via branches). The substrate is already there: `UdpEndpointCounters`, `NetworkTraceEntry`, per-`bindUdp` finalizer at [src/sip/SignalingNetwork.ts:587-592](src/sip/SignalingNetwork.ts#L587-L592). No contract layer reads it.
- **PartitionedRelayStorage** ([src/cache/PartitionedRelayStorage.ts](src/cache/PartitionedRelayStorage.ts)) — Tag/impl already split. Storage state spans calls; in-memory vs redis behaviours should match.
- **CallLimiter** ([src/call/CallLimiter.ts](src/call/CallLimiter.ts)) — counter-back-to-0 invariant (ADR-0004), redis vs memory parity. Currently 3 inline impls in one 402-line file.

**One new wrapper concept beyond the four canonical ones:**

`peerMonitor` — same Tag, but runs **per-peer post-analysis on each `bindUdp` scope close** using an extensible rule pack. The codec did not need this because codec contracts are per-call; SignalingNetwork has a peer dimension. Structurally close to `scopedAudit` (scope-close, `Data.TaggedError` failure) but organized per-peer instead of per-service.

**Recording is mutualised on the existing `Recorder` Effect Service** ([src/test-harness/framework/report-recorder/Recorder.ts](src/test-harness/framework/report-recorder/Recorder.ts)) — its own comments call it "the single source of truth for what crossed the test fabric." It already has the right primitives for per-peer attribution and multi-layer capture:

- `registerLane({ip, port, name, network})` — lanes ARE peers, addressed by `(ip, port)` with a `NetworkTag` discriminator.
- `recordSip({fromAddr, toAddr, direction, message, ...})` — full `SipMessage`, requires parsing at write time.
- `recordRepl({frame, ...})` — replication frames (used by PartitionedRelayStorage observation).
- `markLaneKilled` — peer-lifecycle events.
- `snapshot()` — drains to the `RecordedScenario` shape consumed by the HTML call-flow renderer AND by RFC rule packs.
- Multi-transport: `Recorder.fake | live | hybrid`; shared `RecorderSequencer` so all writers stamp from the same monotonic counter.

The Recorder's transport-wiring slices (fake/live SIP capture and the rendering pipeline) are tracked in a sibling plan referenced by [Recorder.ts:5](src/test-harness/framework/report-recorder/Recorder.ts#L5). **Our wrappers consume / depend on Recorder; we do not duplicate it and we do not introduce a parallel buffer in `peerMonitor`.** Where the Recorder's SIP capture is not yet wired into a transport this initiative needs (e.g. simulated SignalingNetwork), the prerequisite is called out per slice — either gated on the sibling plan or implemented inline as a precursor.

The intended outcome: every fake-stack test silently enforces (a) network-layer sanity per peer and (b) SIP RFC completeness per peer, surfacing violations the test author didn't think to assert — **and** the same recorded data drives the existing HTML call-flow report, with no second source of truth.

---

## Architectural decisions

### D1. `peerMonitor` is a distinct wrapper, same Tag, no private buffer

- Returns `Layer<SignalingNetwork, never, R>` where `R ⊇ Recorder | Scope` — Rule 1 preserved, consumers oblivious to wrapping but Recorder must be in the layer stack.
- Wraps `bindUdp`: each call (a) calls `Recorder.registerLane({ip, port, name?, network})`, (b) hooks `send`/`receive` to call `Recorder.recordSip(...)`, (c) registers `Scope.addFinalizer` that filters `Recorder.snapshot()` to this peer's lane and runs the rule pack.
- **No per-wrapper buffer.** All capture goes through Recorder so HTML call-flow rendering, RFC rule checks, and any future consumer see the same bytes.
- Failure shape: `Data.TaggedError("PeerMonitorViolation")` surfaced on the surrounding scope's Exit.cause (same model as codec `AuditViolation`).
- Extensible: takes `{ rules: ReadonlyArray<PeerMonitorRule> }`. Built-in rules adapt the existing 17 RFC validators.

### D2. Reuse the existing RFC rule pack — do NOT invent new validators

[tests/harness/rules/rfc/index.ts](tests/harness/rules/rfc/index.ts) already has 17 `rfcRules` wrapping `ValidationCheckName` functions from [src/test-harness/framework/validation.ts](src/test-harness/framework/validation.ts) (cseq, via, callId, contentLength, branchPrefix, tagConsistency, …). The peerMonitor wrapper feeds the *existing* validators a per-peer slice of `Recorder.snapshot().sipTrace`. Zero net-new SIP logic.

### D3. `Recorder` is the unification axis across all observing wrappers

| Wrapper / consumer | Recorder method used | What it observes |
|---|---|---|
| `SignalingNetwork.peerMonitor` | `registerLane`, `recordSip`, `markLaneKilled` | Per-peer SIP packets (filtered at finalizer) |
| `PartitionedRelayStorage.scopedAudit` (Slice 5) | `recordRepl` | Replication frames (already a first-class Recorder primitive) |
| HTML call-flow renderer (existing) | `snapshot()` | Reads same `RecordedScenario` |
| `CallLimiter.scopedAudit` (Slice 6) | — | No wire events; inspects impl-internal counters at scope close. No Recorder dependency. |

Wrappers that produce wire events ALWAYS go through Recorder; wrappers that inspect service-internal state (CallLimiter counters) don't need Recorder and do not introduce one.

### D4. Parsing happens once, at the Recorder write site

`Recorder.recordSip` takes a parsed `SipMessage` (see [report-recorder/types.ts:62](src/test-harness/framework/report-recorder/types.ts#L62)). The `peerMonitor` wrapper's `send`/`receive` taps parse via `SipParser.lenientLayer` once, then both the rule pack AND the HTML renderer use the same parsed object. No double-parse, no two parsers diverging.

### D5. Skip `parity` for real-vs-simulated SignalingNetwork

Real network is nondeterministic by design. Skill Rule 4: parity assumes determinism. Two simulated *configurations* (e.g. zero-delay vs default transit delay) could pair in the future; real-vs-simulated cannot.

### D6. Skip `propertyTest` for SignalingNetwork unless a defect motivates it

Per-call `send`/`bindUdp` invariants overlap with `paranoidInputs` (input shape) and `peerMonitor` (cross-message). Adding propertyTest now is duplication. Revisit if a concrete bug demands it.

### D7. Scope: only the three user-selected layers

SignalingNetwork, PartitionedRelayStorage, CallLimiter. Explicitly **out of scope**: CallStateCache, TimerService. Defer until a concrete need surfaces.

### D8. Finalizer order — peerMonitor INNER, scopedAudit OUTER

Effect finalizers run LIFO. peerMonitor finalizers (per-peer) must finish before scopedAudit's cross-cutting checks read aggregate state. Wrapper composition therefore:

```ts
SignalingNetwork.scopedAudit(
  SignalingNetwork.peerMonitor(
    SignalingNetwork.paranoidInputs(
      SignalingNetwork.simulated({ ... })
    ),
    { rules: rfcRulesForPeerMonitor }
  )
) // Recorder layer provided alongside in the stack
```

### D9. Coordinate with the in-progress Recorder transport-wiring plan

[Recorder.ts:5](src/test-harness/framework/report-recorder/Recorder.ts#L5) flags Slice 2 (fake SIP transport wiring) and Slice 3 (live SIP transport wiring) as pending in a sibling plan. Slice 2 in **this** plan does the SignalingNetwork-side wiring required by peerMonitor — to be reconciled with that sibling plan at execution time (either we wait on it, contribute the SignalingNetwork piece to it, or land them as one combined slice). Decision deferred to the Slice 2 session, not to be made here.

---

## Pushback log (decisions challenged on the user's behalf)

- "Monitor" preserved as distinct from `scopedAudit` only because the user made the distinction explicitly (rule-pack injection + per-peer attribution). Structurally close enough that documentation must spell out the relationship.
- Rule pack must be extensible — no hardcoded RFC checks in the wrapper itself.
- `parity` for SignalingNetwork (real vs simulated) **rejected**: violates determinism precondition.
- `propertyTest` for SignalingNetwork **deferred**: marginal value.
- CallStateCache + TimerService **excluded**: user did not select them; resist scope creep.
- Each slice produces a stand-alone, type-clean PR-sized unit. No "big bang" migration.
- **Rejected: a bespoke per-peer ring buffer inside `peerMonitor`.** The existing `Recorder` Effect Service already addresses per-peer lanes, multi-transport capture, shared sequencing, and is the substrate for the HTML call-flow renderer. Building a second buffer would create two sources of truth and let the visualised report and the rule-pack report disagree about what crossed the wire.
- **Rejected: parsing SIP twice.** Single parse at the Recorder write site (D4) — both rules and renderer see the same object.

---

## Design exploration: deeper mutualisation candidates

**Status:** open design — not committed. The slice catalog below is **tentative** until these are resolved.

After a deeper sweep, the mutualisation opportunity is much larger than per-peer SIP capture. Three classes of finding:

### Class A — Bespoke buffers that duplicate Recorder primitives today (clear folds)

| # | Candidate | Current home | Recorder primitive that supersedes |
|---|-----------|--------------|------------------------------------|
| A1 | `NetworkTrace.trace[]` (simulated SignalingNetwork) | [src/sip/SignalingNetwork.ts:151-169](src/sip/SignalingNetwork.ts#L151-L169), drained via `drainTrace()` | `Recorder.recordSip` — same data, different lifetime today. Slice 2 of this plan resolves. |
| A2 | `NetworkTrace.undeliverable[]` | same file, `drainUndeliverable()` | New `Recorder.anomalies` variant `{kind: "undeliverable", ...}` |
| A3 | `tests/support/ReplicationTraceRecorder.ts` | dedicated test helper | `Recorder.recordRepl` — already shares EventSequencer; literally a parallel buffer. Pure consolidation win. |
| A4 | Per-call `CallRecording` (`tests/harness/recording.ts`) | post-hoc extractor from `ScenarioResult.trace` | Derive `CallRecording[]` from `RecordedScenario.sipTrace` by filtering on Call-ID. Legacy types kept temporarily, generated. |

### Class B — Currently invisible-in-tests violation/decision channels (enrich Recorder)

These produce signals that are visible in production logs/OTel but **not in the test artifact today** — the HTML call-flow can't show them. Folding them into Recorder makes them visible AND machine-checkable.

| # | Channel | Source | Today | Proposed Recorder surface |
|---|---------|--------|-------|----------------------------|
| B1 | `ByeDispositionViolation` | `RuleExecutor.finalizeTermination` | WARN log + counter | new `anomalies[]` variant |
| B2 | Codec `PropertyViolation` / `ParityViolation` / `AuditViolation` | `src/call/codec/contracts.ts` | throws / logs | new `anomalies[]` variant — wrapper still throws (test fails) AND records (renderer shows) |
| B3 | Rule decision outcomes (matched rule, action emitted) | `RuleExecutor` → OTel `rule_handled` span events | invisible in tests (OTel not wired in test harness) | new `RecordedRuleOutcome[]` channel — every match, per call, with action summary |
| B4 | Routing decisions | `InitialInviteHandler` → `route_decision` span events | same — invisible in tests | subsumed by B3 |
| B5 | Validation check failures | `src/test-harness/framework/validation.ts` | step-level error strings | per-message anomaly entries pinned to the offending `sipTrace` entry |

### Class C — Driver/test-runner concepts the Recorder doesn't yet model

Concepts present in the legacy `CallRecording` shape or in the runner's `ScenarioResult` that have no Recorder home:

| # | Concept | Current home | Proposed |
|---|---------|--------------|----------|
| C1 | `RecordedTimeout` (deadline fired without expected message) | legacy `CallRecording.entries` | new `Recorder.recordTimeout` + entry type |
| C2 | `RecordedMarker` (phase annotations, free-form driver notes) | legacy `CallRecording.entries` | new `Recorder.recordMarker` + entry type |
| C3 | Driver `label` linking expected step → observed message | DSL `ref` + `labelOfStep` callback | optional `label?: string` on `RecordedSipEntry` (already present in legacy `RecordedMessage`) |
| C4 | Replication lag observations | `expectLagSeqZero` step inspects + discards | new `Recorder.recordReplicationLag` or anomaly on lag > threshold |
| C5 | Timer fire/cancel events | not captured anywhere | new channel — only worth it if a concrete bug demands it (defer) |

### Class D — Clear KEEP-SEPARATE (different lifetime / different consumer)

Documented here so we don't relitigate later:

- `UdpEndpointCounters` (live backpressure state, not history)
- `MetricsRegistry` gauges/counters (aggregate, live-sampled, for `/metrics` endpoint — different consumer)
- Structured logs via `ProxyLogger` (operator-facing severity messages, not test artifact)
- `CallModel` / `Leg` / `Dialog` (live operational state, not trace)
- `TimerService.fibersMap` (active-fiber registry, not history)
- OpenTelemetry to Tempo (production observability — test wiring would be a separate design)
- `WorkerRegistry` worker health states (HA control plane, orthogonal to wire capture)

### Cross-cutting design contract (RATIFIED, iterates over time)

**All test-mode wrappers report violations DUALLY, with a 3-tier severity decided BY CONTEXT:**

| Severity | When wrapper fails the test | Recorder behaviour |
|----------|------------------------------|--------------------|
| `fatal` | **Immediately** (throw / `Effect.fail`) | Records anomaly THEN fails |
| `deferred-fail` | Test continues; **marked failed at scope close** | Records anomaly; scope-close finalizer fails if any deferred-fail anomaly present |
| `advisory` | **Never** fails on its own | Records anomaly only; post-run rule pack decides |

**Severity is NOT a constant on the rule.** Each rule receives a `RunContext` and returns a severity per finding. Same rule, three enforcement modes by environment:

```ts
type RunContext =
  | { kind: "real-run" }                                  // production runtime
  | { kind: "test-with-recorder", recorder: RecorderApi } // integration test, full visibility
  | { kind: "unit-test-of-layer", layer: string }         // narrow unit test, strict by default

interface PeerMonitorRule {
  readonly id: string
  readonly check: (entry: RecordedSipEntry, peer: Lane) => string | null  // null = ok
  readonly severity: (ctx: RunContext, reason: string) => Severity
}

// Example: RFC CSeq monotonicity
{
  id: "rfc.cseq",
  check: (entry, peer) => verifyCseqMonotonic(entry, peer),
  severity: (ctx, _) => {
    switch (ctx.kind) {
      case "unit-test-of-layer":  return "fatal"          // strict enforcement of layer
      case "test-with-recorder":  return "deferred-fail"  // collect full picture, then fail
      case "real-run":            return "advisory"       // log, never break prod
    }
  },
}
```

**Mechanics:**
- `RunContext` is an Effect Service (`Tag`), provided once at the test/run scope. Wrappers read it via `yield* RunContext`. Defaulted to `{ kind: "real-run" }` in production wiring.
- The wrapper iterates the rule pack, calls each rule's `check` then `severity(ctx, reason)`, and emits `Recorder.recordAnomaly({kind, severity, ...})`. Effect failure follows the severity matrix above.
- Codec wrappers retrofitted to the same contract (their throw-only behaviour becomes the `fatal` branch of `severity(ctx)`).

Why context-driven instead of per-rule constant:
- The same RFC check is "I want hard failure" in a unit test of the parser, "let me see the full call before judging" in an integration test, and "don't 503 production" in a real run.
- One rule, three lives. Without context, we'd have three copies of every rule with different `severity:` constants, or a parallel severity-policy table that drifts.

Codec wrappers retrofitted in their own slice. All future wrappers inherit it.

### D10. ONE Recorder per scenario, shared across every network layer

When a test stack has multiple network layers (e.g. hybrid registrar front-proxy: simulated ext + real core), they ALL write to the same Recorder instance. The existing `NetworkTag` discriminator on lanes is the only way to attribute traffic to a network; the shared `EventSequencer` is the only way to keep cross-network event order deterministic.

Concretely:
- `Recorder` is provided ONCE at the test scope.
- Each `SignalingNetwork.peerMonitor` wrapper is parameterised with the `NetworkTag` of the network it wraps (`ext` / `core` / production tag). It tags every `recordSip` and `registerLane` call with that tag.
- The HTML renderer already groups lanes by `NetworkTag`. No renderer change needed.
- `Recorder.fake` / `live` / `hybrid` selectors stay — the `transportKind` is metadata for the report header; lane-level network tagging is independent.

Anti-pattern this rules out: a wrapper that spawns its own private `Recorder.fake` because "I just need to capture my own traffic." That fragments ordering and produces two HTML reports.

### D11. Class B3 (rule decision outcomes) — OUT OF SCOPE

Rule decisions flow into OTel span events in production and are not surfaced in tests. The right path is a `TestTracer` layer that captures span events when OTel is enabled in the test harness — separate initiative, not bundled here.

### Resolved decisions

- **Dual-report:** ratified with 3-tier severity (fatal / deferred-fail / advisory). See cross-cutting contract above.
- **Severity is CONTEXT-DRIVEN, not constant per rule.** Each rule receives a `RunContext` Service and returns severity per finding. Same rule behaves differently in real-run vs test-with-recorder vs unit-test-of-layer.
- **Rule-outcome channel (B3):** deferred indefinitely — TestTracer is the right tool.
- **Anomaly vocab cadence:** per-slice incremental. Slice 1 ADR fixes the discriminated-union SHAPE only (`{kind, atMs, ref?, severity, ...}`); each slice adds its own `kind` variants without re-deciding shape.
- **Single Recorder per scenario** (D10): never spawn a private Recorder inside a wrapper.
- **Driver events:** SipHarness façade (Alt B). Recorder gains a single generic `recordSpecial` primitive; façade owns event-family payload schemas.
- **Default behaviour for SignalingNetwork wrappers:** opt-in per test for Slices 4–7. After stabilisation (canary test + full fake-stack suite green), a dedicated cleanup slice flips the default to ON in `fakeStackLayer`. Two states maintained temporarily; never permanently.

### Still open — none currently

(All design items previously listed under "needs detailed preview" have been resolved. The driver-events alternative section below is kept for traceability.)

### Resolved: driver-events alternatives (kept for traceability)

#### Driver event types (C1 / C2 / C3) — three alternatives

The user floated a `SipHarness` recorder whose only role is to put driver-side events (timeouts, markers, expected-vs-observed labels) into the shared Recorder. Three concrete shapes to compare:

**Alt A — Direct Recorder API expansion**

```ts
// src/test-harness/framework/report-recorder/Recorder.ts
interface RecorderApi {
  // ... existing 5 methods ...
  recordTimeout: (entry: Omit<RecordedTimeoutEntry, "seq">) => Effect.Effect<void>
  recordMarker:  (entry: Omit<RecordedMarkerEntry,  "seq">) => Effect.Effect<void>
}

// Driver call site (tests/harness/runner.ts or interpreter.ts):
yield* recorder.recordTimeout({
  atMs: virtual.now,
  agent: "bob1",
  waitingFor: "180 ringing",
  label: "bob1.ring",
})
```

- **Pros:** lowest indirection; one service to know about; matches existing `recordSip` / `recordRepl` pattern.
- **Cons:** Recorder's API surface grows every time a new event family appears; semantic validation (e.g. "timeout only valid inside an active expect") lives at call sites or in scattered helpers.

**Alt B — `SipHarness` semantic façade (user's suggestion)**

```ts
// New service: src/test-harness/framework/SipHarness.ts
export class SipHarness extends ServiceMap.Service<SipHarness, SipHarnessApi>()(
  "@sipjsserver/test-harness/SipHarness"
) {
  static readonly layer: Layer.Layer<SipHarness, never, Recorder> =
    Layer.effect(SipHarness, Effect.gen(function* () {
      const recorder = yield* Recorder
      return {
        timeout: (args) => recorder.recordSpecial({
          kind: "harness/timeout", ...args,
        }),
        marker:  (args) => recorder.recordSpecial({
          kind: "harness/marker", ...args,
        }),
        linkObservedToExpect: (args) => /* attach label to last sipTrace entry */,
      }
    }))
}

// Driver call site:
yield* SipHarness.timeout({ agent: "bob1", waitingFor: "180 ringing", label: "bob1.ring" })
```

- **Pros:** Recorder stays focused on cross-cutting primitives (lanes / sipTrace / replTrace / anomalies); each domain gets its own thin façade (`SipHarness`, future `ReplicationHarness`, `WorkerHarness`); semantic invariants can live in the façade.
- **Cons:** one more service in the layer stack; the Recorder still needs a generic "special event" channel OR per-façade channels (and so the surface grows somewhere); doubles the indirection for trivial use.

**Alt C — Label only, keep legacy `CallRecording` for timeout / marker**

```ts
// Only change: add optional label to existing entry
interface RecordedSipEntry {
  // ... existing ...
  readonly label?: string  // NEW: links expect step → observed message
}

// Timeouts and markers stay in tests/harness/recording.ts (CallRecording.entries)
// Legacy and new recording coexist; rules that need timeouts/markers consume legacy.
```

- **Pros:** smallest patch; labels are the most painful gap (today no machine link between expect and observed message); doesn't force the legacy decision now.
- **Cons:** does not actually mutualise — `CallRecording` and `RecordedScenario` keep being two parallel systems; rule packs split between "Recorder rules" and "CallRecording rules"; eventually we still have to choose A or B.

**RESOLVED: Alt B (SipHarness façade).** Events land in a generic Recorder channel keyed by `{kind: "harness/${type}", ...}`. The "harness façade" becomes a reusable pattern — future domains (replication, workers) get their own thin façade over the shared Recorder.

#### Recorder API extension required for SipHarness

The façade needs a single new generic primitive on Recorder (not per-event-family methods, to preserve D10's "primitive surface stays small"):

```ts
interface RecorderApi {
  // ... existing 5 methods ...
  recordSpecial: (entry: Omit<RecordedSpecialEntry, "seq">) => Effect.Effect<void>
}

interface RecordedSpecialEntry {
  readonly kind: string             // e.g. "harness/timeout", "harness/marker"
  readonly atMs: number
  readonly seq: number
  readonly payload: unknown         // shape owned by the façade that wrote it
  readonly ref?: { ip: string, port: number } | { callRef: string }  // optional pin
}
```

The façade owns the payload schema; the Recorder is intentionally generic about `kind` and `payload` so adding a new façade does not touch Recorder.

---

## Slice catalog (TENTATIVE — pending design exploration above)

Each slice is one session. Each slice produces a separate detail plan when picked up (`docs/plan/effect-layer-wrappers/<slice>.md`). The table below is the **tentative** progress map; expect to grow once the questions above are resolved.

| # | Status | Slice | Touches | Adds | Recorder dep |
|---|--------|-------|---------|------|--------------|
| 1 | TODO | Foundation: ADR + sibling-plan reconciliation | `docs/adr/`, `docs/plan/effect-layer-wrappers/` | ADR (wrapper pattern + peerMonitor + Recorder mutualisation rule + dual-report 3-tier severity + **context-driven severity** + **RunContext Service Tag** + anomaly-shape skeleton + harness-façade pattern); per-slice plan files; sibling-plan reconciliation memo; **no code** | n/a |
| 2 | TODO | Recorder API extension: `recordSpecial` + anomaly shape skeleton | `src/test-harness/framework/report-recorder/Recorder.ts` + `types.ts` | `recordSpecial` generic primitive; ratify `RecordedAnomaly` discriminated-union skeleton `{kind, atMs, ref?, severity, ...}`; renderer updates to accept unknown `kind`s gracefully | n/a (extends Recorder itself) |
| 3 | TODO | `SipHarness` façade service | `src/test-harness/framework/SipHarness.ts` (new); driver/runner call sites in `tests/harness/runner.ts` + interpreter | Thin Service over Recorder for `timeout`, `marker`, `linkObservedToExpect`; replaces equivalent legacy `CallRecording` entries | writes |
| 4 | TODO | SignalingNetwork Tag/impl split + Recorder write-path for simulated transport | `src/sip/SignalingNetwork.ts` → split impls + `SignalingNetwork.contracts.ts` stub; wire `recordSip` / `registerLane` from simulated `bindUdp`/`send`/`deliver`; reconcile with sibling Recorder transport-wiring plan | Simulated transport writes to Recorder; remove `drainTrace()` parallel buffer (Class A1) | **adds write-path** |
| 5 | TODO | SignalingNetwork `scopedAudit` | `SignalingNetwork.contracts.ts` | Counter balance, queue drained, undelivered drained per scope close. Adds anomaly variants `{kind: "undeliverable"}` (Class A2) and `{kind: "queueLeak"}`. Reads Recorder snapshot for cross-peer deliverability check. | reads + anomaly write |
| 6 | TODO | SignalingNetwork `peerMonitor` + 4 starter rules | `SignalingNetwork.contracts.ts`; adapter from `rfcRules` to per-peer slice of `RecordedScenario.sipTrace`; two fake-stack tests | `peerMonitor` wrapper; rules: cseq, tags, branchPrefix, contentLength; per-peer scope-close finalizer obeys 3-tier severity | reads + anomaly write |
| 7 | TODO | `peerMonitor` full rule pack + `paranoidInputs` | wire all 17 `rfcRules` adapted; add `paranoidInputs`; opt-in mechanism (env or per-test flag); document "how to add a new monitor rule" + how to assign severity | full RFC coverage per peer | reads + anomaly write |
| 8 | TODO | Codec wrapper retrofit (dual-report) | `src/call/codec/contracts.ts` | Existing codec wrappers also call `Recorder.recordAnomaly` before throwing; anomaly kinds `codecPropertyViolation` / `codecParanoid` / `codecParity` / `codecAudit` | anomaly write |
| 9 | TODO | `ReplicationTraceRecorder` consolidation (Class A3) | delete `tests/support/ReplicationTraceRecorder.ts`; rewire callers to use `Recorder.recordRepl` directly | removes one parallel buffer | writes |
| 10 | TODO | `PartitionedRelayStorage` wrappers | `src/cache/PartitionedRelayStorage.contracts.ts`; impl already split | `scopedAudit` (no orphan keys, refcount sanity, drained replication frames) + `parity` (memory vs redis) | writes + reads |
| 11 | TODO | `CallLimiter` Tag/impl split + `scopedAudit` | `src/call/CallLimiter.ts` → split 3 impls into separate files; add `contracts.ts` | `scopedAudit`: counter-back-to-0 (ADR-0004) on scope close | none |
| 12 | TODO | `CallLimiter` `parity` (redis vs memory) | extend `CallLimiter.contracts.ts`; short-scenario test | `parity` for short scenarios only | none |
| 13 | TODO | Legacy `CallRecording` deprecation (Class A4) — optional | rewire `recording-extractor.ts` to derive `CallRecording[]` from `RecordedScenario.sipTrace` + `SipHarness` events; delete legacy types once consumers migrate | removes the parallel recording system | reads |
| 14 | TODO | Default-on flip for SignalingNetwork wrappers in `fakeStackLayer` | `tests/support/fakeStackLayer.ts`; sweep remaining tests that opt-out | wrappers default ON; canary tests preserved as regression gate | reads + anomaly write |

Status legend: TODO / IN_PROGRESS / DONE / BLOCKED. Update inline as slices land.

**Slices 1–3 are mandatory prerequisites.** They establish the contract and the substrate (anomaly shape, SipHarness, Recorder primitives). Slices 4+ depend on them but are otherwise independent and can be reordered. Slice 13 is the optional cleanup — only worth it if Slices 3 + 5–8 have already moved consumers off legacy `CallRecording`.

---

## Critical files (read these in any slice)

- [src/call/codec/contracts.ts](src/call/codec/contracts.ts) — **template**. Copy the `Layer.effect(Tag, ...build inner + wrap)` pattern. Copy failure-shape conventions.
- [src/test-harness/framework/report-recorder/Recorder.ts](src/test-harness/framework/report-recorder/Recorder.ts) — **mutualisation point**. All wrappers that capture wire events go through this Service.
- [src/test-harness/framework/report-recorder/types.ts](src/test-harness/framework/report-recorder/types.ts) — `RecordedSipEntry`, `RecordedReplEntry`, `RecordedScenario` shapes — what wrappers write and what rule packs read.
- [src/sip/SignalingNetwork.ts:280-657](src/sip/SignalingNetwork.ts#L280-L657) — Tag, real/realTracing/simulated impls (to split in Slice 2).
- [src/sip/SignalingNetwork.ts:587-592](src/sip/SignalingNetwork.ts#L587-L592) — per-bindUdp finalizer; this is where `peerMonitor` hooks `Recorder.registerLane` + finalizer that runs rules.
- [tests/harness/rules/rfc/index.ts](tests/harness/rules/rfc/index.ts) — 17 RFC validators + the per-agent recording-replay pattern; adapter source for `peerMonitor` rule pack.
- [tests/harness/recording.ts](tests/harness/recording.ts) — legacy `CallRecording` shape (per-call); reference only — Recorder's `RecordedScenario` is the forward path.
- [src/test-harness/framework/validation.ts](src/test-harness/framework/validation.ts) — underlying `ValidationCheckName` functions.
- [src/cache/PartitionedRelayStorage.ts](src/cache/PartitionedRelayStorage.ts) + `PartitionedRelayStorageKvBacked.ts` — already split, second-easiest slice.
- [src/call/CallLimiter.ts](src/call/CallLimiter.ts) — Tag + 3 inline impls (to split in Slice 7).
- [tests/support/fakeStack.ts:83-92](tests/support/fakeStack.ts#L83-L92) — where the wrapped SignalingNetwork plugs in; Recorder layer also added here.
- [docs/adr/0004-strong-incr-decr-invariant-for-call-limiter.md](docs/adr/0004-strong-incr-decr-invariant-for-call-limiter.md) — the invariant Slice 7 enforces.
- `.claude/skills/effect-layer-test/SKILL.md` — pattern reference (5 hard rules, failure-shape matrix).

---

## Verification (initiative-wide)

Each slice has its own verification (recorded in that slice's plan). Initiative-wide:

- `npm run typecheck` — zero `tsc` errors, zero Effect-plugin warnings.
- `npm run test:fake` — full fake-stack suite green after every slice.
- **Canary test (lands in Slice 3, kept across all slices):** a deliberately broken fake-stack scenario where a peer sends INVITE and never receives a final response — must fail with `PeerMonitorViolation`, NOT silently pass. This is the regression gate that proves wrappers are actually active.
- After Slice 7: a sample existing fake-stack test runs with all wrappers stacked (scopedAudit ∘ peerMonitor ∘ paranoidInputs) without timing regression > 25%. If regression > 25%, re-evaluate opt-in default for Slice 4.
