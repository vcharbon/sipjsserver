# Replication state machines

## Status

INTENDED — describes the worker + per-peer-fiber FSMs at the post-Story-7d shape. The current implementation matches this for the worker FSM and the per-peer-fiber FSM; Story 7d does not change either. See [architecture.md](architecture.md) for the broader design context and [protocol.md](protocol.md) for the wire-level interactions.

This document captures three things:
- **Worker-level FSM** — the lifecycle of a pod from boot to termination, driven by `ReadinessController`.
- **Per-peer-fiber FSM** — the lifecycle of one `PullerFiber` against one source peer, driven by transport events.
- **PeerView** — the data record the supervisor maintains per peer (not a state machine; the inputs the controller reads).

---

## Worker-level FSM

```
Booting ──► Bootstrapping ──► Ready ──► Draining ──► Terminated
   │             │               ▲
   │             └────T_max──────┘
   │                  (WARN log)
   └── (no peers ever) ──► Bootstrapping (waits indefinitely for first peer)
```

| State | Predicate | Side effects | `WorkerReadiness.currentReady` |
|---|---|---|---|
| **Booting** | Process started; supervisor not yet started; `t < T_min` (default 3 s). | None. | `false` |
| **Bootstrapping** | At least one peer fiber active and not all peers have flipped `everCaughtUp`, AND `t < T_max` (default 60 s). The supervisor continues forking per-peer fibers as `PeerEnumerator` emits. | Continue forking per-peer fibers as `PeerEnumerator` emits add events. | `false` |
| **Ready** | All known peers have `everCaughtUp == true` OR `t > T_max` (latter ⇒ WARN log naming non-caught peers). | `WorkerReadiness.markReady(true)`. | `true` |
| **Draining** | SIGTERM received. | `markReady(false)`; finish in-flight batches; stop forking new fibers. Existing per-peer fibers complete their current frame then exit. | `false` |
| **Terminated** | Process exit. | n/a. | n/a |

### Key properties

- **No `Degraded`. No `CatchingUp` post-Ready.** Once Ready, replication issues are observability-only: a per-peer fiber going to `ErroredFailed` after Ready does NOT un-ready the worker. Per-peer state is surfaced via metrics and logs (see [architecture.md §Observability](architecture.md#observability)) but never back-propagates to worker state.
- **Single-shot Ready.** The worker transitions `Bootstrapping → Ready` exactly once per process lifetime. The reverse transition exists only for SIGTERM (`Ready → Draining`).
- **`T_min` floor (3 s)** prevents flapping-Ready when the pod boots into a cluster with no peers visible yet (PeerEnumerator hasn't fired its first snapshot).
- **`T_max` ceiling (60 s)** prevents indefinite-Bootstrapping when one peer is permanently stuck. WARN-flag to operators; worker becomes Ready and continues pulling forever.
- **Tick interval: 100 ms.** `ReadinessController` re-evaluates the predicates every 100 ms.

### Transition triggers

| Edge | Trigger |
|---|---|
| `Booting → Bootstrapping` | First peer-set update from PeerEnumerator (any peer present), AND `t ≥ T_min`. |
| `Bootstrapping → Ready` (happy path) | Every peer in the alive set has `view.everCaughtUp === true`. |
| `Bootstrapping → Ready` (T_max ceiling) | `t ≥ T_max`. WARN log lists non-caught peers. |
| `Ready → Draining` | SIGTERM signal received. |
| `Draining → Terminated` | All in-flight applies completed; supervisor shutdown returned. |

---

## Per-peer-fiber FSM (PullerFiber)

One fiber per (this worker, source peer) edge. The fiber owns the long-lived `/replog` connection, applies frames, and updates the shared `PeerView` ref the supervisor reads.

```
                    ┌──────────────────────────────────────┐
                    │                                      │
   (none) ─► Discovered ─► Connecting ─► Streaming ◄──► ErroredRetry ──► ErroredFailed
                              │             │               ▲              │
                              └─error──────►┘               │              │
                                            │               │              │
                                            └──any error────┘              │
                                                          (T_failed)───────┘

   At any state: PeerEnumerator removes peer ─► Disappeared (fiber interrupted, watermark preserved forever)
   At any state: PeerEnumerator re-adds peer ─► Discovered (new fiber forked, reuses preserved watermark)
```

| State | Meaning | Watermark behavior | Contributes to readiness? |
|---|---|---|---|
| **Discovered** | Peer just appeared; fiber forked but no connection yet. | Watermark = saved (or `(0,0)` if never seen). | Blocks readiness (not yet `everCaughtUp`). |
| **Connecting** | Opening HTTP connection to peer's `/replog`. | Unchanged. | Blocks readiness. |
| **Streaming** | Long-lived connection open; receiving data + noop frames. | Updated on every received frame whose `(gen, counter)` is greater. | `everCaughtUp` flips `true` on first `noop` received → unblocks readiness. |
| **ErroredRetry** | Connection or parse error; backing off (exponential, capped). | Unchanged. | Post-Ready: observability-only. Pre-Ready: still blocks until either `T_max` ceiling fires or fiber recovers. |
| **ErroredFailed** | `T_failed_threshold = 30 s` of continuous error. | Unchanged. | Same as `ErroredRetry`. Loop keeps retrying — the threshold is a label for observability, not a kill. |
| **Disappeared** | Removed from PeerEnumerator. Fiber interrupted. | Preserved forever (no linger timer; rationale below). | Not in alive set; doesn't block readiness. |

### Key properties

- **`everCaughtUp` is sticky for the fiber's lifetime within this worker incarnation.** Lost only on worker-level restart (which resets all state). Reappear-from-Disappeared starts a fresh fiber that initially has `everCaughtUp = false` again — but if `Ready` was already achieved at the worker level, this no longer affects readiness.
- **Watermark preserved forever across `Disappeared`.** No linger timeout. Rationale: if the peer truly rebooted, its new gen will exceed our preserved watermark's gen by tuple comparison, and on first reconnect the source's emitted frames will sort above our watermark — we apply everything naturally. There is no scenario where stale watermark hurts us, because gen monotonicity guarantees forward progress.
- **Backoff**: `initialBackoffMs * 2^attempt`, capped at `maxBackoffMs`. Defaults: 250 ms initial, 30 s cap. The attempt counter resets on every successful entry into `Streaming` (a working connection that produces frames recovers the budget).
- **Stream end is treated as transport error**: a clean `Stream` end (server closed cleanly) is recorded with `lastError.kind = "transport"` and the fiber transitions to `ErroredRetry`. Long-lived connections should never end unless the peer closed.

### Transition triggers

| Edge | Trigger |
|---|---|
| `(none) → Discovered` | Supervisor forks fiber on PeerEnumerator add event. |
| `Discovered → Connecting` | Fiber starts its main loop. |
| `Connecting → Streaming` | `openStream` returned a Stream (HTTP connection opened). |
| `Streaming → ErroredRetry` | Transport error from `Stream.fail`, OR clean stream end, OR parse error in NDJSON decode. |
| `ErroredRetry → Streaming` | After backoff sleep, `openStream` succeeds and emits at least one frame. |
| `ErroredRetry → ErroredFailed` | Continuous error duration exceeds `failedThresholdMs` (default 30 s). |
| `ErroredFailed → Streaming` | Backoff continues; if `openStream` succeeds and emits at least one frame, transitions back to `Streaming`. The `ErroredFailed` label sticks until then. |
| `* → Disappeared` | PeerEnumerator remove event. Supervisor calls `Fiber.interrupt`. |
| `Disappeared → Discovered` | PeerEnumerator add event for this peer. Supervisor forks a new fiber against the preserved watermark. |

---

## PeerView (data record, not an FSM)

The supervisor maintains one `PeerView` per known peer. The view is what `ReadinessController` and observability hooks read.

```ts
type PeerView = {
  readonly peerId: string
  readonly fiberState: FiberState
    // "Discovered" | "Connecting" | "Streaming" | "ErroredRetry" | "ErroredFailed" | "Disappeared"
  readonly watermark: { readonly gen: number; readonly counter: number }
    // Preserved across Disappeared/reappear cycles for the worker incarnation.
  readonly everCaughtUp: boolean
    // Sticky-true once first noop received this incarnation; preserved across reappear.
  readonly lastFrameAt: number
    // Clock.currentTimeMillis at last received frame.
  readonly lastError: PeerViewError | null
    // { kind: "transport" | "parse"; at: number; message: string }
  readonly bytesReceivedTotal: number
    // Eagerly updated on every chunk, even before frames parse — observability of the byte stream itself.
  readonly entriesAppliedTotal: number
    // Counter of Data frames whose apply landed (callGen gate passed).
  readonly noopsReceivedTotal: number
}
```

### Mutation sources

Four event kinds drive `PeerView` mutations; nothing else writes to the view:

1. **PeerEnumerator add/remove** — supervisor sets `fiberState ∈ {Discovered, Disappeared}`.
2. **Connection lifecycle in PullerFiber** — fiber sets `fiberState ∈ {Connecting, Streaming, ErroredRetry, ErroredFailed}`.
3. **Frame application** — fiber updates `watermark`, `everCaughtUp`, `lastFrameAt`, counters, clears `lastError` on success.
4. **`ReadinessController` tick (100 ms)** — reads only; does not mutate.

The `PeerView` is held in a `MutableRef<PeerView>` shared between the per-peer fiber and the supervisor; mutations use `MutableRef.set(ref, { ...current, ...patch })`. No locking — single-fiber writers per ref.

---

## Boot sequence (numbered, end-to-end)

```
1.  Process boot → Effect runtime starts; AppConfig + MetricsRegistry + Logger initialized.
2.  KvBackend init → Redis sidecar PING (or in-memory MutableHashMap allocated). Fail-fast on error.
3.  EpochCounter resolves gen → from K8s downward API restartCount or boot-millis fallback.
4.  HTTP server starts → /replog endpoint live; peers can pull from us immediately. We can serve before being Ready.
5.  ReplicationSupervisor starts → subscribes to PeerEnumerator. Worker state := Booting.
6.  First peer-set update fires → for each peer in snapshot, supervisor forks PullerFiber. Worker state := Bootstrapping.
7.  Each PullerFiber:
    a. State := Connecting. Watermark := preserved-from-prior (or (0,0) on cold boot).
    b. Open GET /replog?caller={self}&gen={watermark.gen}&counter={watermark.counter}&chunk_size=1000.
    c. State := Streaming.
    d. For each frame: apply per the apply rule (architecture.md §"Watermark and apply").
       On first noop: flip everCaughtUp = true (sticky).
    e. On transport / parse error: state := ErroredRetry. Backoff. Reconnect with current watermark.
       After T_failed_threshold of continuous failure: state := ErroredFailed (observability-only).
8.  ReadinessController ticks every 100 ms:
    - If t < T_min (3 s): stay Booting.
    - Else if all alive peers have everCaughtUp: worker := Ready.
    - Else if t > T_max (60 s): worker := Ready with WARN log.
    - Otherwise stay Bootstrapping.
9.  Worker → Ready: WorkerReadiness.markReady(true). K8s /ready flips. SIP traffic begins.
10. Steady state: PullerFibers stream forever. Supervisor reacts to peer-set churn:
    - Add peer → fork fiber, watermark resumes preserved value or (0,0) for new peer.
    - Remove peer → interrupt fiber. View.fiberState := Disappeared. Watermark preserved.
11. SIGTERM: worker := Draining. markReady(false). PullerFibers complete current frame, exit. Process exits cleanly.
```

The boot sequence is a single mechanism — the same `/replog` long-poll that serves steady-state propagation also serves recovery. Step 7's `chunk_size=1000` first batch on a cold boot returns whatever the peer mirrors for us (gen=0 entries) AND any G7-reverse originating entries the peer wrote — both arrive in lex order, both flow through the same apply rule.

---

## Worked example — peer disappear / reappear with watermark preservation

Initial state: A and B in steady state. A's view of B has `watermark = (B.gen=42, counter=120)`, `everCaughtUp = true`, `fiberState = Streaming`.

1. K8s pod B terminates. PeerEnumerator removes B from the snapshot.
2. Supervisor sees the remove event → calls `Fiber.interrupt(B.fiber)`. Sets `B.view.fiberState = Disappeared`. Watermark stays at `(42, 120)`.
3. K8s starts a new B pod. PeerEnumerator emits add event for B (same peerId, possibly different IP).
4. Supervisor forks a new PullerFiber against B with the preserved watermark `(42, 120)`. View.fiberState := Discovered.
5. New fiber opens `GET /replog?gen=42&counter=120` against new B. New B's gen is `B.gen' = 43` (restartCount bumped).
6. Server responds: lex compare `(43, anyCounter) > (42, 120)` ⇒ everything in B's gen=43 buckets streams to A. **No bootstrap mode, no special-case** — gen rollover is implicit in tuple ordering.
7. A applies frames; watermark advances to `(43, *)`. After first noop, `everCaughtUp` is already true (sticky from earlier incarnation), so the worker stays Ready. No re-bootstrapping.

---

## Boot timing budget (INV4)

Target: 30 s P99 from pod start to `WorkerReadiness.markReady(true)`.

```
Step                                Budget
1. Process boot                       <  1 s
2. KvBackend init                     <  1 s  (Redis PING)
3. EpochCounter resolve               <  0.1 s (env var lookup)
4. HTTP server starts                 <  1 s
5. ReplicationSupervisor starts       <  0.5 s
6. First peer-set update fires        <  2 s  (PeerEnumerator subscribes to k8s endpoint slice)
7. Per-peer cold-pull catch-up        < 20 s  (drains peer mirrors at chunk_size=1000)
8. ReadinessController flips Ready    <  0.1 s (100 ms tick)
                                      ────────
Total budget                          < 25.7 s, headroom < 4 s
```

The 20 s allocation for step 7 is the dominant slice; sized for ≈ 30 K calls × ≈ 1 KB body × 1 peer over a healthy local network. Multi-peer parallelism (each puller is its own fiber) keeps wall-clock bounded by the slowest peer.

If a peer is unreachable at boot, it is not in the PeerEnumerator snapshot; that peer is ignored at boot. When it eventually returns, the rediscovery loop (step 10 of the boot sequence) forks a fresh fiber against it — but the worker is already Ready by then, so this is observability-only.

---

## State-machine code references

| FSM | Code |
|---|---|
| Worker-level FSM | [src/replication/ReadinessController.ts](../../src/replication/ReadinessController.ts) — predicate evaluation; tick loop. [src/cache/WorkerReadiness.ts](../../src/cache/WorkerReadiness.ts) — `currentReady` flag. |
| Per-peer-fiber FSM | [src/replication/PullerFiber.ts](../../src/replication/PullerFiber.ts) — `runPullerFiber`, internal `consumeStream`, `applyOne`. |
| PeerView mutations | [src/replication/PullerFiber.ts](../../src/replication/PullerFiber.ts) — `patchView`. |
| PeerEnumerator add/remove → fiber lifecycle | [src/replication/ReplicationSupervisor.ts](../../src/replication/ReplicationSupervisor.ts) — `makeReplicationSupervisor`. |

The same FSMs are exercised under fake-clock by the harness in [tests/replication-ns/twoWorkerHarness.ts](../../tests/replication-ns/twoWorkerHarness.ts) and via `it.live` real-clock by NS5/NS7/NS8/NS11/NS14.
