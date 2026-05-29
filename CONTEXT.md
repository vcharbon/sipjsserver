# sipjsserver

A SIP B2BUA worker fleet with cross-worker call-state replication. This document is a glossary, not a spec — it pins the language we use so the code and docs stay in sync.

## Language

### Topology

**Worker**:
A B2BUA process. The unit of fault containment; the entity that holds a `WorkerOrdinal` and an `EpochCounter`.
_Avoid_: pod (K8s-specific synonym), node, instance.

**WorkerOrdinal**:
The stable, ordinal-shaped identifier a worker is known by across the fleet (`worker-A`, `worker-B`, etc.). Stable across restarts; new ordinal = new identity.

**Epoch** (a.k.a. **gen**):
A worker's incarnation counter. Bumped on every process start. Stamped on every originating write so receivers can lex-compare across incarnations. The wire field is named `gen` for historical reasons — both names refer to the same thing.

### Storage partitions

A **partition** is one of two roles a worker plays for a given call. Two roles, two namespaces, side by side on the same Redis sidecar:

**Primary partition** (key prefix `pri:`):
The partition this worker owns calls in. Source of truth for calls this worker is the LB-assigned primary for.
_Avoid_: owner (overloaded), source.

**Backup partition** (key prefix `bak:`):
The partition this worker holds another worker's calls in. Stored "in trust" so this worker can serve them if the original primary dies.
_Avoid_: mirror (overloaded with the entryGen=0 sentinel below), shadow.

> The code uses `pri` / `bak` as wire-and-key tokens; prose should say "primary" / "backup". A worker that "serves a backup-held call" is not promoting — the ownership ref never moves; see `project_call_partition_invariant`.

### Replication channel

A **replication channel** is the abstract bidirectional state-sync mechanism between two workers. It is materialised by two paired HTTP NDJSON streams sharing the same wire vocabulary.

**Replog stream**:
The long-lived delta endpoint `GET /replog?caller&gen&counter&chunk_size`. Infinite. Emits ordered frames as state mutates; the puller resumes from a watermark on reconnect. Implemented by `buildPullStream` in [src/replication/ReplLogServer.ts](src/replication/ReplLogServer.ts).
_Avoid_: pull stream, delta stream, push stream.

**Bootstrap stream**:
The one-shot snapshot endpoint `GET /bootstrap?caller`. Finite — terminates with one `Noop` frame carrying the channel head watermark. Used by a starting/recovering worker to seed its local cache before reading deltas. Implemented by `buildBootstrapStream` in the same file.
_Avoid_: restart stream, snapshot stream, cold-pull stream.

Both streams are driven by the same `buildChannelStream` paginate primitive in [src/replication/ChannelStream.ts](src/replication/ChannelStream.ts), and both pass through the shared `encodeFramesToBytes` encoder tail.

### Frame vocabulary

**PullFrame**:
The wire-level union of `DataFrame | NoopFrame`. The puller's apply rule is mechanical: apply iff the frame's `(gen, counter)` watermark exceeds the local watermark.

**DataFrame**:
One state mutation. Carries `op` (`create | update | delete`), `partition` (`pri | bak`), `callRef`, `body`, and a per-entry `(gen, counter)`.

**NoopFrame**:
A heartbeat + caught-up marker. Carries a `(gen, counter)` at the channel head. The puller flips `everCaughtUp = true` on the first Noop received in a fiber incarnation.

**Watermark**:
The `(gen, counter)` cursor pair, lex-compared. The puller's resume key; the server's pagination cursor; the unit of progress on the channel.

**Tick**:
One iteration of the `buildChannelStream` paginate body. Replog ticks alternate between `Pulling` and `Idle` phases; bootstrap ticks walk `FetchingHead → Scanning → EmitTerminalNoop`.

### Versioning

**entryGen** (Story 7d):
The bucket an entry was written into within a replication channel. Two values matter:
- `0` — a "mirror" entry written by a puller's apply path. Sentinel.
- the writer's own **epoch** — an originating write.

Lex-ordering on `(entryGen, counter)` is the cycle-break that prevents echo storms across two workers replicating to each other.

**counter** (a.k.a. `seq`):
A per-`(channel, entryGen)` monotonic sequence number. Bumped on every write into that bucket. Combined with `entryGen` into the **watermark** pair.

## Relationships

- A **worker** owns one **primary partition** and may hold zero or more **backup partitions** (one per peer it's a backup for).
- Two **workers** that mirror each other share one **replication channel** in each direction (A→B and B→A are distinct channels).
- A **replication channel** is served as two HTTP streams: a long-lived **replog stream** and a one-shot **bootstrap stream**.
- A starting puller drains a **bootstrap stream** once, then opens a **replog stream** seeded from the bootstrap's terminal Noop watermark.

## Example dialogue

> **Reader:** "When B starts up, why does it call `/bootstrap?caller=B` on A and then `/replog?caller=B`? Aren't those two different things?"
>
> **Author:** "Same **replication channel** A→B. The **bootstrap stream** seeds B from a point-in-time scan of A's `bak:B:*` partition. The terminal Noop carries A's channel-head **watermark**. B then opens the **replog stream** at that watermark — same channel, just switched from snapshot mode to delta mode. Bootstrap and replog are two faces of one channel."
>
> **Reader:** "And if A dies while B is alive?"
>
> **Author:** "B keeps the bodies A had in its `bak:` partition for B's calls — B is the **backup** for those. Incoming traffic for those calls lands on B because the stickiness cookie names B as backup; B serves them directly out of its backup partition. The primary ref never moves — B is *not* promoted to primary."

### Admission

**Call limiter**:
Cluster-shared sliding-window counter (Redis-backed) that rate-limits concurrent calls per limiter id, summed over the last `LIMITER_ACTIVE_WINDOWS` windows of `LIMITER_WINDOW_SECONDS` each (default 3 × 300 s = 15 min lookback). Read on every initial INVITE; `INCR` on admission, `DECR` on termination. Cap-hit returns `Rejected` (a normal outcome, not an error).

The limiter is **not a hard cap**. It is an eventually-cap-honoring counter. See **Cap-honoring target** vs **Limiter inflight (diagnostic)** below.

**Cap-honoring target**:
The actual operational contract: the externally observable concurrent-call count on a limited limiter id — measured as sipp's `CurrentCall` (`concurrentCalls(endurance-limiter)` in analyzer terms) — converges to ≤ cap after any chaos episode ends. **Typical** reconcile is `~2 × (KEEPALIVE_INTERVAL_SEC + KEEPALIVE_TIMEOUT_SEC)` ≈ 10 min (peer keepalive detects the dead worker and DECRs its phantoms). **Worst case** is `LIMITER_ACTIVE_WINDOWS × LIMITER_WINDOW_SECONDS` ≈ 15 min (phantoms age out of the sliding window with no actor required). Once chaos is over and all in-flight calls drain, the count returns to 0. See [ADR-0004](docs/adr/0004-strong-incr-decr-invariant-for-call-limiter.md).
_Avoid_: "inflight ≤ cap at all times", "hard cap" — both wrong descriptions of the contract.

**Limiter inflight (diagnostic)**:
The Redis-counted view of "INCRs landed minus DECRs landed" across the active windows, as exposed by `LIMITER_INFLIGHT_PROBE` and the analyzer's `limiterProbe` block. A *lagged proxy* for the true count, not the target. May transiently exceed cap during/just after chaos (phantom INCRs from dead workers age out only as their window rotates). `verdict.limiterProbe.exceededCap=true` is a diagnostic signal, **not** a verdict-level pass/fail. The structural INCR↔DECR symmetry of [ADR-0004](docs/adr/0004-strong-incr-decr-invariant-for-call-limiter.md) guarantees this view eventually settles at the cap (or zero, once calls drain).

**Fail-open admission**:
A call admitted *without* the limiter `INCR` landing on Redis. Happens when the limiter Redis is unreachable or times out (`RedisError` / `LimiterTimeout`). The call is allowed through to keep traffic flowing, but the `limiterEntries[i].incrementSucceeded` field is set to `false` so the matching `DECR` is skipped on termination — otherwise the cluster counter drifts negative. See [ADR-0004](docs/adr/0004-strong-incr-decr-invariant-for-call-limiter.md).

**Overload signal**:
The compact load-state payload a worker publishes on every OPTIONS reply (and any 503 reply it emits to an INVITE), carried as the SIP header `X-Overload: v=1; elu=…; gc=…; adm=…`:
- `elu` — smoothed Event Loop Utilization (Node `perf_hooks.performance.eventLoopUtilization`, EWMA α≈0.2). Includes GC pauses (V8 counts major GC as "active").
- `gc` — smoothed fraction of wall time spent in GC pauses over the reporting window (EWMA α≈0.2). Disambiguates GC-induced ELU inflation from real load.
- `adm` — monotonic counter of non-emergency new-dialog INVITEs admitted by this worker since process start. Diffed by each LB to derive worker's total treated rate without inter-LB coordination.
_Avoid_: "CPU", "load level" (overloaded prose).

**Effective ELU**:
The LB-derived `max(0, elu - gc)`. Used for the `soft_to_hard` / `hard_to_critical` band boundaries — the part of ELU that represents real JS work, not GC pressure. The `above_critical` filter still uses raw `elu` because an unresponsive worker is unresponsive regardless of cause.

**ELU band**:
The worker classification bucket the LB derives from `elu_ewma` on each OPTIONS tick:
- `below_soft` (ELU ≤ `OVERLOAD_ELU_SOFT`) — AIMD increase enabled
- `soft_to_hard` — hold (deadband)
- `hard_to_critical` — AIMD multiplicative decrease
- `above_critical` (ELU > `OVERLOAD_ELU_CRITICAL`) — worker filtered out of the new-dialog candidate set entirely (same exclusion path as `not-ready`)

**Non-emergency rate cap**:
The per-(LB, worker) AIMD-tuned admission rate (calls/sec) one LB will route to one worker for **out-of-dialog, non-emergency INVITEs only**. Each LB independently maintains its own cap. Bucket empty → immediate stateless 503 + `Retry-After`, no forwarding. In-dialog requests, emergency INVITEs, REGISTER, OPTIONS, and responses bypass the cap by SIP construction.
_Avoid_: "shedding rate", "throttle".

**Share-scaling**:
The AIMD step adjustment factor `own_admitted_rate / worker_treated_total_rate`. Used for observability only (the `sip_proxy_worker_share` metric and alerts) — AIMD steps themselves are NOT share-scaled, since every LB sees the same OPTIONS payload and applies identical decisions in parallel.

**Proxy-self gate**:
The front-proxy's own overload gate, applied **only to external new-dialog non-emergency INVITEs**. Two-stage: `proxy_elu > PROXY_ELU_CRITICAL` → stateless 503 `reason=proxy_overload_elu`; else a CPS token bucket on the same traffic class — `proxy_overload_cps` on empty. In-dialog requests, emergency INVITEs, and worker-originated (internal) traffic all bypass. Unlike worker caps, no AIMD — the proxy's ELU is its own; no coordination needed.

**Internal marking**:
The `;wk=1` custom Via parameter a worker stamps on every outbound Via it generates as UAC (B-leg INVITEs, outbound OPTIONS, etc.). The proxy reads it at ingest to classify a request as internal-origin and skip the proxy-self gate. Internal classification additionally cross-checks `registry.lookupByAddress(srcAddr)`: a mismatch in either direction logs a warning but defaults to the safer side.

### Gate order

The five gates an external new-dialog non-emergency INVITE traverses in order, top to bottom:
1. **UDP queue depth threshold** (Tier-1 brake on the UDP recv queue, byte-scan).
2. **Proxy-self gate** (proxy ELU + proxy CPS bucket).
3. **Candidate filter** — worker's `health === "alive"` and ELU band ≠ `above_critical`.
4. **Per-(LB, worker) AIMD bucket** — non-emergency rate cap consume.
5. **Worker-side panic backstop** — worker's own CPS hard cap + panic-ELU threshold.

Emergency INVITEs skip gates 2, 3, 4, 5. In-dialog traffic skips gates 2, 3, 4. Internal (worker-originated) traffic skips gate 2.

### SIP UDP stack

The B2BUA ships two interchangeable implementations of the UDP transport
layer — same `SignalingNetwork` service contract, same `UdpEndpoint` shape,
same `Stream<UdpPacket>` semantics — selected per-process by env var.
Both produce a `SipMessage` for downstream code; they differ in **where**
the wire-level parse runs.

**JS stack**:
The legacy default. A Node `dgram` socket receives datagrams on the libuv
main thread; the `preIngress` hook (Tier-1 brake) runs synchronously
in-handler; accepted packets land in an Effect `Queue` with `parsed`
unset; `TransactionLayer` then calls `SipParser.parse(raw)` (default
`customParser` — a hand-written zero-regex TS state machine). Implemented
in [src/sip/SignalingNetwork.ts](src/sip/SignalingNetwork.ts) as
`SignalingNetwork.real`.

**Native stack**:
A Rust napi-rs addon owns the UDP socket. A tokio runtime runs the recv
loop; `rvoip-sip-core` parses each datagram in strict mode inline; the
result is dispatched to a JS callback via a `ThreadsafeFunction`. The JS
callback runs the same ADR-0007 strict gates (`extractRequestFields` /
`extractResponseFields`), materialises a `SipMessage`, and offers it
into the Effect `Queue` with `UdpPacket.parsed` pre-set. `TransactionLayer`'s
parse hop short-circuits when `parsed` is present. Native module in
[native/sip-parser/](native/sip-parser/), Effect façade in
[src/sip/NativeSignalingNetwork.ts](src/sip/NativeSignalingNetwork.ts).
_Avoid_: "Rust parser" (overloaded — Phase 1 had a Rust adapter that
kept the JS socket; the Phase 2 native stack owns the socket too).

**Stack toggle**:
The startup-time switch picking which stack a worker boots with. Resolved
by `resolveSipUdpStack()` ([src/config/AppConfig.ts](src/config/AppConfig.ts)):
explicit `SIP_UDP_STACK=js|native` wins, else
`SIP_UDP_STACK_BY_ORDINAL=js,native` maps the worker's StatefulSet
ordinal (`POD_NAME` → `b2bua-worker-N`) to a list index, else default
`js`. Surfaced as `AppConfig.sipUdpStack`. The K8s endurance run uses
the per-ordinal form so `b2bua-worker-0` and `-1` run different stacks
side-by-side under the same load — see
[docs/k8s-endurance.md](docs/k8s-endurance.md) § "SIP UDP stack A/B".
_Avoid_: "stack flag" (it's not a feature flag — there is no on/off,
just a choice between two production implementations).

**Pre-parsed packet**:
The Phase-2-only state where `UdpPacket.parsed` is set on emit, so
`TransactionLayer` and any cooperating consumer skip
`SipParser.parse(raw)`. The native stack always sets `parsed`; the JS
stack never does (downstream parser path remains the source of truth
for the JS pipeline). Defined in
[src/sip/SignalingNetwork.ts](src/sip/SignalingNetwork.ts) `UdpPacket`
type.

**Tier-1 brake placement**:
Gate 1 in the [Gate order](#gate-order) — UDP queue depth threshold —
runs in `UdpTransport.preIngress` for both stacks today. The JS stack
applies it pre-parse in the dgram handler; the native stack applies it
post-parse in the JS-side TSFN callback (Phase 2A scope). Phase 2B
will port the brake into Rust so the native stack applies it pre-parse
identically to the JS stack. Brake metrics (`dropsTier1Brake`,
`tier1RejectSent`) surface the same Prometheus labels regardless of
stack.

### Abuse classes

Four disjoint axes of bad input the B2BUA must survive. Each is defended by a different mechanism; tests live in different homes.

**Malformed packet**:
Bytes that fail SIP grammar — truncated, wrong CRLF, oversized header, missing mandatory header, header-injection garbage. Rejected at the parser; the rest of the application never sees them. Defended by `parser.parse()` in [src/sip-front-proxy/ProxyCore.ts](src/sip-front-proxy/ProxyCore.ts), tracked by `b2bua_parse_dropped_total`. Test home: [tests/sip/parser-compliance.test.ts](tests/sip/parser-compliance.test.ts). The strict-grammar surface — Via magic cookie, transport allowlist, sent-protocol structure, strict host (incl. IPv4 octet bounds + no leading zeros), strict SIP-URI ABNF on Request-URI/From/To/Contact, paranoid numeric headers, CSeq method presence, on-demand SDP body validator — is enumerated in [ADR-0007](docs/adr/0007-strict-sip-parser-as-security-boundary.md).

**Abusive-volume call**:
A call where the wire is well-formed and the dialog state machine is respected, but the in-dialog message rate or count is far above normal — re-INVITE flood, 18x flood. Defended by the proposed per-call message cap (`MAX_MESSAGES_PER_CALL`, not yet implemented). Test home: **abuse stream** (see below).
_Avoid_: "burst" (already taken by rate-level abuse at gate 4).

**Out-of-sequence call**:
A call where the wire is well-formed but messages violate dialog ordering — ACK before 200, PRACK without 180, CSeq jumping backward, in-dialog request with missing/wrong To-tag, duplicate dialog-establishing method. Defended by rule-engine state-machine drops and recovered by [[terminating-timeout]] + [[orphan-sweep]] + limiter `DECR`-on-terminate. Test home: **abuse stream**.

**Nefarious / injection**:
A call where the wire is well-formed and semantics are valid, but a payload field weaponizes the B2BUA against itself or its environment — DNS amplification via externally-supplied hostnames, internal-name probing via Route/Path, storage bloat via large stored headers, log injection. Defended by per-field allowlists + no resolution of externally-supplied hostnames. Test home: separate risk-discovery plan + per-surface ADRs.
_Avoid_: "attack" (these can be unintentional — see the past self-DDoS via DNS lookups of bad entries).

**Abuse stream**:
The continuous parallel traffic class injected during endurance soaks alongside [[short-hold-stream]] / [[long-options-stream]] / [[limiter-probe-stream]], composed of **abusive-volume** + **out-of-sequence** archetypes. Real-call KPIs must match the no-abuse baseline; abuse-call outcomes are excluded from KPI accounting via Call-ID prefix segregation. See [docs/plan/design-in-detail-a-reflective-spark.md](docs/plan/design-in-detail-a-reflective-spark.md).

### Event dispatch

**Event dispatch**:
The pipeline from UDP packet ingest through to handler execution for one SIP call event. Three single-fiber tiers feed into a tier of per-call worker fibers: `TransactionLayer` ingest → `SipRouter` router fiber → `PerCallDispatcher` worker fiber (one per active callRef). The first two preserve UDP-arrival order; the third runs the handler. See [ADR-0005](docs/adr/0005-per-call-fifo-via-router-and-workers.md).

**Per-call FIFO**:
The invariant that all events for the same `callRef` are processed in strict UDP-arrival order and never overlap. Enforced structurally by the dispatch pipeline above — not by reviewer discipline at the call sites. The composition is: UDP-arrival → `eventQueue` (single-fiber producer) → `perCallQueue[R]` (single-fiber router) → worker fiber (one per `R`, serial loop). A slow handler on call X stalls only call X.

**Per-call queue**:
The `Queue.bounded` allocated per `callRef`, owned by the worker fiber. Bounded by `PER_CALL_QUEUE_DEPTH` (default 64). Total queue count bounded by `PER_CALL_QUEUE_CAP` (default 200 000). Cap-exceeded drops increment `b2bua_dispatch_worker_cap_drops_total`.

**POISON**:
The sentinel item enqueued by `CallState.remove` / `forcePurgeOne` to signal the worker fiber to drain residual events and exit. The worker removes its own `perCallQueues` entry on exit. POISON travels the same queue as events to preserve ordering — "every event offered before terminate runs before terminate".

**Eager pre-population** (Alt B in the plan):
Boot-time creation of one queue + worker per call returned by `loadOwnedCalls`. Trades ~100 MB at startup for (1) the cleanup path being exercised on every call (never a rare path) and (2) no fork surge during failover cutover when ~50 K backup-held calls suddenly receive traffic.

### Termination safety

**Terminating timeout**:
The per-call safety net armed atomically when a call enters `state: "terminating"`. Defined as `TERMINATING_TIMEOUT_MS` in [src/call/timer-helpers.ts](src/call/timer-helpers.ts). When it fires, `forcePurge(callRef, "safety_timer")` runs. The constant must satisfy `TERMINATING_TIMEOUT_MS > keepaliveIntervalSec*1000 + 60_000` — enforced by `validateTerminatingTimeoutConsistency` at AppConfig load.

**Terminating-timeout refresh**:
The act of rewriting the safety timer's `fireAt` on every `CallState.update` while the call is in `terminating`. Treats peer messages and own activity as equivalent "this call is alive" signals. Net effect: the safety timer (and the orphan sweep that respects it) only fires when the call has truly been silent for `TERMINATING_TIMEOUT_MS` from any source — not when a routine peer-activity gap (e.g. an OPTIONS keepalive interval) elapses.

**Orphan sweep**:
The 60s-tick daemon in `CallState` that purges calls the rule-engine cleanup path missed. Post-Stage-4 of [the limiter cascade plan](docs/plan/to-review-and-properly-swift-moler.md), it respects the terminating-timeout `fireAt` — a `terminating` call is only swept when `now >= fireAt`. `terminated` corner cases are still swept immediately.

### Drain

**Two-tier drain**:
The worker-side SIGTERM-driven sequence walking `serving → draining-new → draining-quiet → exit`. Designed to give the proxy two distinct synchronization points (one for new-INVITE exclusion, one for in-dialog cutover) before the worker exits, so that the LB has fully moved on by the time the process terminates. See [ADR-0008](docs/adr/0008-two-tier-graceful-drain.md).

**draining-new**:
First phase of the two-tier drain. OPTIONS replies remain `200 OK` but carry `X-Overload: elu=1.0; reason=draining; ...`, which puts the worker in the proxy's `above_critical` ELU band and excludes it from `selectForNewDialog`. In-dialog routing is **unchanged** so the worker keeps serving live calls and keeps replog flowing to the peer's `bak:` partition.
_Avoid_: "soft drain", "tier-1 drain" (use the explicit name).

**draining-quiet**:
Second phase. The worker stops replying to OPTIONS entirely. The proxy's `HealthProbe` flips the worker to `dead` after `unhealthyAfterMisses` consecutive timeouts; in-dialog requests then fall back via `selectForNewDialog` to the peer worker, which serves them from its `bak:` partition.
_Avoid_: "hard drain", "tier-2 drain".

**Drain budget**:
The cluster-shared SLO that bounds the sipp-observable failure impact of one graceful drain event: `final_fail_count ≤ (1.5 / num_workers) × system_cps`. Encoded as the `worker-pod-graceful` rule set in [tests/k8s/endurance/expectedImpact.ts](tests/k8s/endurance/expectedImpact.ts). The residual is funded by transaction-layer state not being replicated (UAC retransmission absorbs ~1 s of latency between primary and backup).

### RFC verification

**UAC** (User Agent Client):
The role that originates a SIP request and consumes the response.

**UAS** (User Agent Server):
The role that receives a SIP request and produces the response.

**A-leg**:
The half of a B2BUA-mediated call facing the originator. The B2BUA terminates the A-leg as **UAS**.

**B-leg**:
The half facing the destination. The B2BUA originates the B-leg as **UAC**.
_Avoid_: "inbound leg" / "outbound leg" — overloaded with transport direction.

**B2BUA-as-UAS** / **B2BUA-as-UAC**:
Role-specific shorthand naming which leg of the B2BUA an RFC obligation lands on. A single MUST may apply to one, the other, or both. A B2BUA bind covers `{uac, uas}` in the audit framework's `UaRole` set for this reason.

**MUST-ID**:
The stable identifier (`RFC<num>-MUST-<NNN>`, e.g. `RFC3261-MUST-003`) for one entry in the per-RFC inventory tables under `docs/rfc/`. Referenced by rule comments and the Rule Manifest so a code change can be traced back to the obligation it asserts.

**RFC exception ledger**:
The end-of-`test:fake` rendering of every suppression that fired during the run. Sourced from `tests/harness/rules/rfc/exceptions.ts` (the central declaration file) and the per-rule `severityOverride` field. Each entry carries a mandatory `justification` string. The ledger surfaces what the test suite is *not* enforcing today, alongside what it is.

### Leg model

**Leg kind**:
An explicit role tag carried on every non-A leg, replacing the positional `legId` convention (`b-1`, `b-2`) and the transfer-specific side-band as the answer to "what is this leg." Values: `destination` (a B-leg toward the called party — the only kind in the failover/selection set), `media` (a [[media leg]]), `transfer-target` (the C-leg of a REFER). The A-leg is not tagged; it is structurally distinguished as the call-identity anchor (`callRef = {ordinal}|{aLegCallId}|{aLegFromTag}`).

**Media leg**:
A leg the B2BUA originates as **UAC** to a media server (MRF) to broker SDP and exchange control bodies (e.g. MSCML over INFO). `kind: "media"`. Never the [[active peer]]; never in the destination-selection/failover set; reaped by normal call cleanup like any leg. On the wire the media server is "just another SIP peer"; "media leg" names its *role* so prose doesn't collide with A-leg/B-leg or the singular peer counterparty.
_Avoid_: "MRF leg" when the role is meant — reserve "MRF" for the server itself ("MRF leg" is an acceptable spoken synonym only).

**Adopted leg / Unadopted leg**:
*Ownership* of a leg's in-dialog signaling — **not** the same as being connected/peered. An *adopted* leg is one the framework's generic relay/keepalive rules are responsible for; an *unadopted* leg is driven solely by the owning extension rule (via explicit `relay-to-leg` / `send-request-to-leg`), and generic relay must **not** reach it (the relay-to-peer fallback toward `"a"` would mis-route it). Adoption tracks `kind` + lifecycle, not [[active peer]] membership:
- A `destination` B-leg is adopted **from creation** — generic relay carries its early 18x/200 to A *before* any merge, so adopted ≠ peered.
- A `media` leg is **never** adopted (the extension brokers its SDP, then tears it down).
- A `transfer-target` C-leg **flips** unadopted→adopted at realignment.
- The A-leg is always adopted.
Modelled as an explicit per-leg flag defaulted from `kind`, flipped to `true` by the owning rule when it relinquishes a leg. Being an [[active peer]] is the steady-state of two *already-adopted* legs bridged together — a consequence, not the definition. Generalizes the transfer-only `transferPhase: "c-realign"` gate into a use-case-agnostic predicate.

**Active peer**:
The single 1↔1 bridge between two legs at any instant (`activePeer = {legA, legB}` or null). Re-pointable via `merge`/`split` across the dynamic leg collection, but **never a set** — the B2BUA bridges one pair at a time; media mixing/conferencing is the media server's job. The singleton is load-bearing for tag mapping, BYE pairing, and the replication apply gate.
_Avoid_: "list of peers" to mean simultaneous multi-bridging — it means the dynamic leg *collection*, bridged pairwise.

### Extensibility

**Integrator**:
A party that builds new call-handling behaviour on top of the B2BUA without forking it — by authoring an [[extension]] against the public [[rule SDK]] and deploying their own **worker** binary (their worker is one of ours with their extension compiled in; there is no separate runtime entity). The B2BUA's job is to stay stable underneath them; the integrator owns their callflow logic and supplies their own data, but **the B2BUA owns and replicates all per-call state** (HA constraint).
_Avoid_: "external user" (collides with the SIP caller / URI user-part), "third party", "tenant" (the integrator runs their own deployment, not a slice of ours), "peer" (a SIP neighbour / the [[active peer]]).

**Extension**:
The integrator's deliverable: one or more **policy modules** (`definePolicyModule`) plus the `/call/new` descriptor schema they consume, compiled into a worker. Defines one callflow (PRBT, pre-call announcement, MRF-during-transfer, …) entirely through the public primitive set — with **no change to the B2BUA's HTTP API or core** per callflow.

**Rule SDK**:
The curated, independently-versioned public surface an [[extension]] builds against: `defineRule`, a narrowed `RuleContext`, and the **public subset** of the action union (leg create/destroy, send-request-to-leg with an opaque body, respond, relay/transform, timers, ruleState, terminate). The internal action set (`send-raw`, transfer / early-promote / PRACK plumbing, …) is not exported. The boundary *is* the stability contract; "easier to open than to close" — start narrow, widen as the dogfood demands.

## Flagged ambiguities

- **"mirror"** was overloaded: it was used both as a description of the act of dual-writing across two sidecars AND as the name for the `entryGen=0` sentinel bucket. Resolved: keep "mirror" for the wire-level `entryGen=0` sentinel only; use "replication channel" / "dual-write" for the higher-level concept.
- **"takeover"** was used in some docs to mean both "the partition ref changed owners" (incorrect — it never does) and "the backup served a request" (correct). Resolved: retire "takeover"; say "backup serves the request" or "backup-served write".
- **"pull stream" / "delta stream"** were both used for `/replog`. Resolved: **replog stream**.
- **"cold pull" / "snapshot" / "restart stream"** were all used for `/bootstrap`. Resolved: **bootstrap stream**.
- **"gen" vs "epoch"** — same concept, two names. Resolved: keep both; `gen` is the wire field name, "epoch" is the prose name (and the type name `EpochCounter`).
- **chaos event `worker-pod-graceful`** — historically implemented as `kubectl delete pod --grace-period=0 --force`, which is the *opposite* of a graceful shutdown (force-delete skips the kubelet's grace protocol entirely). Resolved (2026-05-18): renamed the legacy event to `worker-pod-api-delete-force`; the new `worker-pod-graceful` invokes `kubectl delete pod --grace-period=20` so SIGTERM actually drives the two-tier drain protocol.
