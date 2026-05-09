# Replication architecture (intended)

## Status

INTENDED design — captures Track B's redesign at the post-Story-7d shape. Implementation is mid-flight: storage primitive (`KvBackend`), wire protocol (`/replog`), supervisor (`ReplicationSupervisor`), and per-peer fiber (`PullerFiber`) have landed; the **cycle-break, wire-TTL, and wire-indexes changes from Story 7d are pending implementation**. This document is the source-of-truth for what those changes should look like.

The previous design captured in `redesign-call-cache-backup.md` is **stale** (it described a Redis-Streams-based shape that was abandoned during the original grill); that file will be replaced by a redirect to this one when Story 7d ships.

The day-to-day grill record lives at [`docs/plan/grill-me-on-the-spicy-lark.md`](../plan/grill-me-on-the-spicy-lark.md). This file distils the as-built architecture into one place for engineers consulting the replication subsystem; the plan file remains the authority on grill-decisions and rationale for choices.

Companion docs in this directory:
- [`protocol.md`](protocol.md) — wire-format reference for the `/replog` endpoint.
- [`state-machine.md`](state-machine.md) — worker-level + per-peer-fiber state machines.

---

## Purpose

The B2BUA pairs each call to a primary worker (the one that processes its in-dialog SIP traffic) and a backup worker (which mirrors the call's state so it can serve in-dialog traffic if the proxy briefly routes around the primary). The replication subsystem is what keeps the backup's view in sync with the primary, recovers a worker's local state after a sidecar wipe or process restart, and bounds the cost of a backup being unreachable for arbitrary durations.

Single-owner is a hard invariant: a backup never *promotes* to primary. The proxy's Record-Route HMAC cookie ([src/sip-front-proxy/strategies/LoadBalancer.ts:108-155](../../src/sip-front-proxy/strategies/LoadBalancer.ts#L108-L155)) pins (primary, backup) for the lifetime of every call; both proxy instances share the signing key so a master/standby failover preserves the routing decision.

---

## Goals (G), non-goals (NG), hard invariants (INV)

Goals:
- **G1 — Self-describing storage.** Each worker holds (a) calls it is primary for, (b) calls it is backup-of-record for, (c) per-call generation tracking local edits in either role.
- **G2 — Two-direction recovery via the same endpoint.** A worker's `/replog` pull at `(0, 0)` rebuilds *both* primary partitions (from peers' mirrors) and backup partitions (from peers' originating writes).
- **G3 — Sub-second steady-state lag** under healthy peers (≤ 1 s P99 from primary write to backup apply).
- **G4 — Bounded primary cost when backup unreachable** (no growing buffer; index naturally bounded by `~30K active calls + 3 min tombstone window`).
- **G5 — Single mechanism.** Steady state, recovery from sidecar wipe, recovery from process restart, and recovery via the G7-reverse path all share one HTTP long-poll. No `/bootstrap` RPC, no SCAN side-channel.
- **G6 — Reverse-direction propagation as steady-state concern (G7).** When the primary is briefly unreachable and the proxy routes a BYE to the backup, the backup's state changes propagate back to the primary without waiting for the primary's full restart.
- **G7 — Observable.** Every replication path exposes lag, queue depth, last-applied tuple as Prometheus metrics.

Non-goals:
- **NG1.** Distributed consensus, strong cross-pod consistency, cross-DC replication.
- **NG2.** Recovery of state lost when both primary AND backup go down within the same call-TTL window. Inherits the existing accepted small-loss class.
- **NG3.** Strict ordering across calls. Per-call ordering is sufficient.
- **NG4.** Distributed transactions across primary + backup.

Hard invariants:
- **INV1.** A backup unreachable for arbitrary duration imposes **zero growing cost** on its primary.
- **INV2.** Single-owner: a backup never promotes; the cookie's `wPri` is the primary for the call's whole lifetime.
- **INV3.** Idempotent apply: re-delivering an entry whose `(entry.gen, entry.counter)` is `≤` the puller's watermark is a no-op. Cross-direction stale writes are caught by the per-call `callGen` content gate.
- **INV4.** Boot recovery completes within **30 s P99** wall-clock from pod start to `WorkerReadiness.markReady(true)`.
- **INV5.** A successful long-poll close (server max-open or client disconnect) never loses entries the primary has durably written. The puller's watermark advances strictly monotonically as entries are applied.
- **INV6 — CYCLE-BREAK INVARIANT.** A puller's apply path writes channel entries with `entryGen = 0` (the mirror sentinel). PRS originating writes use `entryGen = self.incarnationGen`. Lex compare on `(entry.gen, entry.counter)` therefore excludes mirror entries from warm pullers (`(0, *) < (≥1, *)`) and includes them for cold pullers (`(0, *) > (0, 0)`). The replication cycle dies at the wire layer with no content inspection. **This is the load-bearing invariant of the design.** See §"Cycle-break and recovery" below.

---

## Storage layout

Per worker `N`:

```
pri:{N}:call:{ref}                Body for calls where N is primary.
                                  JSON-encoded; carries `callGen`, `written_at_ms`,
                                  `_topology = { wPri, wBak }`, the full Call shape
                                  from which the SIP-derived index keys are
                                  deterministically derivable (see "Indexes" below).

bak:{P}:call:{ref}                Body for calls where N backs up primary P.
                                  Same JSON shape as pri.

idx:{indexKey} → callRef          SIP-derived index entries (Call-ID, dialog tag, …).
                                  Flat namespace; the value carries the callRef
                                  whose first segment encodes the primary ordinal,
                                  so the partition (pri vs bak) is derivable.
                                  Index keys are a PURE FUNCTION of the call body
                                  (see "Indexes" below) — never carried on the wire.

propagate:{N}->{P}:gen:{entryGen} Sorted set per (channel, entryGen-bucket).
                                  Member format: "U:{bodyKey}" (update)
                                                  or "D:{bodyKey}" (tombstone).
                                  Score: per-bucket monotonic counter.
                                  entryGen is one of:
                                    0  — mirror writes (puller-driven applies)
                                    g  — N's incarnation gen for originating writes
                                  Old incarnations' buckets persist in storage if
                                  the sidecar survives a process restart, naturally
                                  walked in lex order on pull.

seq:{N}->{P}:gen:{entryGen}       Per-bucket counter, INCR-ed on every write into
                                  that bucket. Bucket counters are independent.
```

The `(N, P)` per-call peer-stability invariant (D2 of the plan, citing
[src/sip-front-proxy/strategies/LoadBalancer.ts:108-155](../../src/sip-front-proxy/strategies/LoadBalancer.ts#L108-L155)) says the (primary, backup) pair is fixed at INVITE time and signed into the Record-Route cookie. All in-dialog messages for a call land on the same primary, hence on the same `propagate:{primary}->{backup}` channel.

There is no global epoch counter and no incarnation gen stored in the sidecar Redis. `gen` is sourced from the K8s downward API's `restartCount` packed with boot-millis fallback ([`src/replication/EpochCounter.ts`](../../src/replication/EpochCounter.ts) — `fromKubernetesDownwardAPI`), so a sidecar wipe never regresses the worker's gen.

---

## Cycle-break and recovery

**This section is the most important in this document.** The replication design relies on one structural invariant — INV6 above — to make a single endpoint serve both steady-state propagation and recovery without infinite loops.

### The setup that creates the cycle

Two workers, A and B, each running a puller against the other (B primary for some calls, A primary for others; pullers are bidirectional).

In a naive design where every applied frame on B is also written to B's outgoing-channel-back-to-A, the following loop fires:

1. A originates a write to call X. A's `propagate:{A}->{B}` gets a new entry. Channel counter advances.
2. B's puller pulls, applies the body to `bak:A:call:X`, **also writes a member to `propagate:{B}->{A}`** so A can later cold-pull the mirror back. Channel counter on B's side advances.
3. A's puller pulls B's outgoing-to-A. Sees the new entry. `(genB, B_counter) > A's watermark for B` is true (counter just advanced). A applies, **also writes a member to `propagate:{A}->{B}`**. Channel counter on A's side advances again.
4. B's puller pulls A's outgoing-to-B. Sees the new entry. `(genA, A_counter) > B's watermark for A` is true. B applies, writes to its outgoing-to-A. Counter on B's side advances again.
5. **Forever.** Counters strictly increase on every hop; the wire-level `(gen, counter)` ordering can never break the loop because the loop *is* monotonic counter advancement.

This is the failure mode that band-aided early implementations and that Story 7d closes.

### How the gen=0 sentinel breaks the cycle

The same sequence with the new design:

1. A originates a write to X. PRS calls `kv.channelWriteUpdate({ entryGen: A.incarnationGen, ... })`. Entry is in A's `propagate:{A}->{B}:gen:{A.gen}` bucket.
2. B's puller pulls, applies via `kv.channelWriteUpdate({ entryGen: 0, channel: "propagate:{B}->{A}", member: "U:bak:A:call:X", bodyKey: "bak:A:call:X", bodyValue: frame.body, ... })`. Body lands at `bak:A:call:X`. Channel entry lands in B's gen=0 bucket.
3. A's puller pulls B's outgoing-to-A. A's watermark for source-B is `(B.incarnationGen, lastCounter)`. Server walks B's buckets in lex order:
   - Bucket gen=0 — server skips entries with `(0, anyCounter) ≤ A's watermark (B.incarnationGen, lastCounter)`. **All gen=0 entries are skipped because `0 < B.incarnationGen`.**
   - Bucket gen=B.incarnationGen — server returns entries with `counter > lastCounter`. Only originating writes by B (to its own `pri:B:` or to `bak:*:` for G7 reverse) live here. The mirror entry from step 2 is NOT here.
4. **No apply on A. No write to A's outgoing-to-B. Loop dies.**

The cycle-break is not a content comparison or a per-entry skip — it is the natural consequence of lex-ordering a mixed-gen channel with the right query.

### How the same mechanism powers recovery

A's sidecar wipes (or A's process restarts after a fresh K8s restart bumps `restartCount`). A's puller starts with watermark `(0, 0)` for source-B.

1. A's puller pulls B's outgoing-to-A. Watermark = `(0, 0)`. Server walks buckets:
   - Bucket gen=0 — returns ALL entries (every mirror entry B wrote during steady state).
   - Bucket gen=B.incarnationGen — returns ALL entries (originating writes by B).
2. A receives all entries. The frame's `partition` field (`"bak"` for B's mirror entries, since the body lives at `bak:A:`) routes A's apply to the **partition flip**: `partition === "bak" → write to pri:{self}:` (because for A, `bak:A:` data on B is what A *should* hold in `pri:A:` after recovery).
3. A's apply uses the same primitive: `kv.channelWriteUpdate({ entryGen: 0, channel: "propagate:{A}->{B}", bodyKey: "pri:A:call:X", bodyValue: frame.body, ... })`. Body lands at `pri:A:call:X`. Channel entry lands in A's gen=0 bucket.
4. B's puller (steady-state, watermark `(A.incarnationGen, lastA)`) pulls A's outgoing-to-B. Bucket gen=0: `(0, *) < (A.incarnationGen, lastA)` → skip. **No re-cycle.**

A is now functionally recovered. `WorkerReadiness.markReady(true)` flips after the first noop frame. The next SIP message for X looks up `pri:A:call:X`, finds the recovered body, hydrates the in-process `CallStateCache`, and processes.

### Why callGen is still needed (a narrower role)

The lex-ordering cycle-break does not address one race: cross-direction writes on the same call landing at the same channel position.

1. A re-INVITES X. `pri:A:call:X` body advances to `callGen=5`.
2. A goes briefly unreachable. Proxy routes BYE for X to B (G7 reverse).
3. B handles BYE: PRS originating write to its own `bak:A:call:X` with `callGen=6` (read-modify-write of the existing local body — B sees `callGen=4` from earlier mirror applies, increments to `5`; depending on what mirror it had locally, the value may differ from A's `5`). Channel entry in B's bucket gen=B.incarnationGen.
4. A comes back. A's earlier in-flight frames eventually land in the channel. Mirror entries in B's gen=0 bucket may carry older `callGen` values.
5. A's puller catches up. Server returns mirror entries (gen=0) lex-ordered before the G7 originating entry (gen=B). Without `callGen`, a stale mirror frame with `callGen=4` could OVERWRITE the G7-reverse termination's `callGen=6` body. With `callGen`, the puller's apply path reads `local.callGen` and skips when `incoming.callGen ≤ local.callGen`.

`callGen` is therefore a per-call *content* idempotency gate, separate from the wire-level `(gen, counter)` watermark. It is bumped only by PRS originating writes (read-modify-write); the puller does NOT bump it during apply. Mirror entries preserve the body bytes verbatim (including `callGen`).

When the local body does not exist (cold recovery), the gate succeeds: treat `null` local as `callGen = -∞` so any incoming `callGen ≥ 1` lands. **Create-if-not-exist is preserved.**

---

## Indexes — derived from body, never on the wire

The `idx:{indexKey} → callRef` entries are a **pure function** of the call body. Two helpers in [src/call/CallModel.ts](../../src/call/CallModel.ts) compute the same key set from two different inputs:

- [callIndexKeys(call: Call)](../../src/call/CallModel.ts#L737) — typed-side, used by `CallState` originating writes after the call has been schema-decoded into `Call`.
- [callIndexKeysFromUnknown(state: unknown)](../../src/call/CallModel.ts#L768) — schema-tolerant, used by the puller's apply path to derive the same key set from a JSON-decoded body without coupling the puller to the full schema decode.

The key set walks `aLeg.{callId,fromTag}`, `bLegs[].{callId,fromTag}` plus `bLegs[].callId` alone, `bLegs[].dialogs[].sip.remoteTag` (when present), and `callbackContext` (when present). Both helpers are pure and produce identical output on structurally-equivalent inputs.

### Originating side
PRS originating writes (via [CallState.flushToRedis](../../src/call/CallState.ts#L382)):
```ts
const indexes = callIndexKeys(bumped)
storage.putCall(role, primary, callRef, json, indexes, ttl, { peer, direction })
```
PRS passes `indexes` to `ChannelIndex.write`, which passes them to `KvBackend.channelWriteUpdate`. The atomic Lua/critical-section creates each `idx:{key}` SETEX alongside the body — single transaction.

### Receiver side (the gap closed in Story 7d)
The puller's `makeReplicationApply` MUST derive indexes from the received body and pass them into the local `channelWriteUpdate`:
```ts
const indexes = callIndexKeysFromUnknown(frame.body).map((key) => ({
  key,
  value: frame.callRef,
  ttlSec: frame.body_ttl_remaining_sec,
}))
yield* kv.channelWriteUpdate({
  entryGen: 0,
  // ... other fields ...
  indexes,
})
```
Today's `makeEchoApply` passes `indexes: []` — a known gap that closes in Story 7d. With the derivation step in place, every PUT/UPDATE applied frame creates the local `idx:*` entries naturally; cold recovery rebuilds the full SIP-derived index map without any wire-protocol involvement.

### Delete path
DELETE frames carry `body === null` (the source's body is a tombstone marker, or has TTL'd). The receiver cannot derive indexes at delete time. The puller maintains an in-memory cache:
```
indexCache: MutableHashMap<{peer, callRef}, ReadonlyArray<string>>
```
populated on every PUT apply (with the just-derived list); consumed on every DELETE apply. Cache miss falls back to "delete body only, let `idx:*` entries TTL out within one call-TTL window" — accepted by spec and matches the legacy `ReplPuller` behavior.

### Recovery
On cold pull (`since=(0,0)`), the puller receives all the source's mirrors plus originating entries. Each PUT apply derives indexes from the body and re-creates them locally. There is no "index bootstrap" step — index recovery is a side-effect of body recovery via the same apply rule. The recovering worker has a complete `idx:*` map by the time `everCaughtUp` flips.

---

## Steady-state propagation

Pull, not push. The backup polls primary's `/replog` over a long-lived NDJSON stream. Server emission loop:

```
while connection_open:
  batch = kv.channelPullBatch({
    channel: "propagate:{self}->{caller}",
    since: { gen: req.sinceGen, counter: req.sinceCounter },
    limit: chunk_size,
  })
  for entry in batch.entries:
    emit DataFrame {
      gen: entry.entryGen,
      counter: entry.counter,
      partition: parsedFrom(entry.member),
      callRef: parsedFrom(entry.member),
      body: parsedJson(entry.body),
      body_ttl_remaining_sec: <PTTL on Redis | (expiresAtMs - nowMs) / 1000 in memory>,
      indexes: <derived from body's indexes field, or carried in entry metadata>,
      latency_ms: nowMs - body.written_at_ms,
    }
  if batch.entries.length == chunk_size:
    continue immediately   # might be more pending
  else:
    emit NoopFrame { gen: serverGen, counter: head, latency_ms: 0 }
    sleep 100 ms
```

`KvBackend.channelPullBatch` walks per-`(channel, entryGen)` buckets in ascending lex order of `entryGen`, and within each bucket returns members with `score > sinceCounter` (when bucket's `entryGen === sinceGen`) or all members in counter order (when bucket's `entryGen > sinceGen`). Buckets with `entryGen < sinceGen` are skipped entirely.

The `noop` frame's `counter` reports the channel's current head (highest counter across all buckets). The puller treats first noop as the `everCaughtUp = true` signal.

---

## Watermark and apply

Per (puller, source-peer): a single `(gen, counter)` tuple held in process memory. Lost on puller restart → next pull starts at `(0, 0)` → cold recovery.

Apply rule:

```
if (frame.gen, frame.counter) > (watermark.gen, watermark.counter):
  if frame._tag == "Data":
    targetPartition = frame.partition === "pri" ? "bak" : "pri"
    targetOwner = targetPartition === "bak" ? frame.source : self
    targetBodyKey = `${targetPartition}:${targetOwner}:call:${frame.callRef}`

    local = kv.bodyGet(targetBodyKey)
    localCallGen = local === null ? -Infinity : parseCallGen(local)

    if frame.body.callGen > localCallGen:
      kv.channelWriteUpdate({
        entryGen: 0,
        channel: `propagate:{self}->{frame.source}`,
        counterKey: `seq:{self}->{frame.source}:gen:0`,
        member: `U:${targetBodyKey}` (or D for delete),
        bodyKey: targetBodyKey,
        bodyValue: frame.body,
        bodyTtlSec: frame.body_ttl_remaining_sec,
        indexes: frame.indexes.map(toIndexWrite),
      })
    # else skip — stale relative to local content

  watermark = (frame.gen, frame.counter)
if frame._tag == "Noop":
  fiber.everCaughtUp = true   # sticky for this incarnation
  watermark = max(watermark, (frame.gen, frame.counter))
```

Watermark advances on every received frame whose tuple is `>`, regardless of whether the body apply happened. This prevents re-receiving skipped entries on reconnect.

---

## Boot recovery — single mechanism

There is no separate bootstrap path. On worker boot:

1. `EpochCounter` resolves `gen` from K8s downward API `restartCount` (or boot-millis fallback).
2. `KvBackend` initializes against the sidecar Redis (or in-memory store for tests).
3. `/replog` HTTP route comes up — peers can pull from us immediately. We can serve before being Ready ourselves.
4. `ReplicationSupervisor` subscribes to `PeerEnumerator`. On every peer-set update, forks one `PullerFiber` per peer with watermark `(0, 0)`.
5. Each fiber opens `GET /replog?caller={self}&gen=0&counter=0&chunk_size=1000`. Server returns everything in lex order: gen=0 mirrors first (passive bodies the peer mirrors for us), then peer's originating buckets.
6. Each applied mirror frame creates the local primary body via the apply rule above. By the time the first `noop` lands per peer, the partition is reconstructed.
7. `ReadinessController` ticks every 100 ms. When all alive peers report `everCaughtUp = true`, OR `T_max = 60 s` elapsed, OR `T_min = 3 s` minimum has passed and there are no peers — flip `WorkerReadiness.markReady(true)`.

The same long-poll connection then continues serving steady-state forward propagation. No protocol switch, no second endpoint, no peer-side cooperation needed for boot.

---

## Failure handling matrix

| Scenario | Primary | Backup | Result |
|---|---|---|---|
| Backup peer disappears mid-stream | Continues writing to its own propagate buckets; bounded by INV4 (active calls + tombstones-in-3-min). | Pull connection drops; supervisor preserves watermark forever; on reappearance, fork a fresh fiber with the preserved watermark. | At-most-window-stale; resumes seamlessly. |
| Backup peer never returns | Same as above. | N/A. | INV1 holds. |
| Primary's sidecar wipes | Sidecar empty; gen bumped via restartCount. Pull from peers' channels at `(0, 0)`; gen=0 mirror buckets repopulate `pri:{self}:`. | N/A. | Recovers via §"Cycle-break and recovery" §"How the same mechanism powers recovery". |
| Backup's sidecar wipes | N/A. | Sidecar empty; pull from peers' originating buckets at `(0, 0)`; receives all primaries' bodies and reconstructs `bak:{primary}:`. | Same mechanism as primary recovery, just the other partition flip. |
| Both restart simultaneously | Both empty, both pull each other empty, both proceed empty. | Same. | NG2 territory: in-flight calls are lost. |
| Network partition | Local writes continue; channel buckets bounded; INV1 holds. | Pull retries with backoff. | Heals via in-window resume or, if outside window (none in steady state), via cold pull on reconnect (mirror bucket replays). |
| Brief primary unavailability + G7 reverse | Receives the BYE on the backup; handles it; PRS originating write to its own `bak:{primary}:` with `entryGen = self.incarnationGen` and bumped `callGen`. | N/A — backup IS the worker doing this. | When primary recovers, primary's puller sees the G7 entry at `(B.incarnationGen, ctr)`, applies tombstone to `pri:{primary}:`. callGen content gate ensures it wins over any older mirror. |
| Stale mirror after G7 reverse race | N/A. | Mirror entry with old `callGen` could be applied AFTER the G7 tombstone. callGen gate skips it. | No resurrect-from-stale. |

---

## Configuration surface

```
AppConfig.replication.chunkSize             number   default 1000
AppConfig.replication.noopIntervalMs        number   default 100
AppConfig.replication.tombstoneTtlSec       number   default 180
AppConfig.replication.callContextTtlSec     number   default 1200   (driven by CallState; passed via PRS putCall)
AppConfig.replication.bootMaxDurationMs     number   default 25_000
AppConfig.replication.readinessTickMs       number   default 100
AppConfig.replication.readinessMinMs        number   default 3_000
AppConfig.replication.readinessMaxMs        number   default 60_000
AppConfig.replication.failedThresholdMs     number   default 30_000
AppConfig.replication.initialBackoffMs      number   default 250
AppConfig.replication.maxBackoffMs          number   default 30_000
```

`workerOrdinalLabel` resolves the worker's `self` ordinal; `RESTART_COUNT` env var (populated by an init container reading the K8s API) supplies the `restartCount` for `EpochCounter.fromKubernetesDownwardAPI`.

---

## Module map

| File | Role |
|---|---|
| [src/storage/KvBackend.ts](../../src/storage/KvBackend.ts) | The storage primitive port. Memory + Redis impls. Per-(channel, entryGen) bucket sorted-set + per-bucket counter. |
| [src/replication/ChannelIndex.ts](../../src/replication/ChannelIndex.ts) | Naming layer over KvBackend: derives channel/counter/body keys from `(self, peer, gen)` binding. `write` takes `entryGen` as a parameter. |
| [src/replication/EpochCounter.ts](../../src/replication/EpochCounter.ts) | Sources `gen` at boot from K8s downward API, with boot-millis fallback. Immutable per process. |
| [src/replication/ReplicationProtocol.ts](../../src/replication/ReplicationProtocol.ts) | Wire types (`DataFrame`, `NoopFrame`), NDJSON codec, tuple comparator. |
| [src/replication/ReplLogServer.ts](../../src/replication/ReplLogServer.ts) | HTTP `/replog` endpoint + per-request stream builder. Lex-ordered emission across buckets. |
| [src/replication/PullerFiber.ts](../../src/replication/PullerFiber.ts) | Per-peer pull loop. Watermark management. Apply rule with callGen content gate. |
| [src/replication/ReplicationSupervisor.ts](../../src/replication/ReplicationSupervisor.ts) | Subscribes to PeerEnumerator; forks/interrupts puller fibers; preserves watermarks across disappear/reappear. |
| [src/replication/ReadinessController.ts](../../src/replication/ReadinessController.ts) | Ticks every 100 ms; flips `WorkerReadiness.markReady(true)` when criteria met. Single-shot once Ready. |
| [src/replication/EchoApply.ts](../../src/replication/EchoApply.ts) → `ReplicationApply.ts` (renamed in 7d) | Builds the puller's `applyFrame` callback per the apply rule above. |
| [src/cache/PartitionedRelayStorageKvBacked.ts](../../src/cache/PartitionedRelayStorageKvBacked.ts) | SIP-facing PRS API (`putCall`/`refreshCall`/`deleteCall`/`getCall`/`scanCalls`) over `KvBackend` + `ChannelIndex`. Stamps `written_at_ms` and (post-7d) `callGen` via read-modify-write. |
| [src/cache/WorkerReadiness.ts](../../src/cache/WorkerReadiness.ts) | `currentReady` flag consumed by the OPTIONS handler. Producer side wired by `ReadinessController`. |

---

## Observability

Per-peer-per-direction metrics published from each pod's `/metrics`:

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `repl_channel_size_per_bucket` | Gauge | `direction`, `peer`, `entryGen` | INV1 alarm + bucket cardinality visibility |
| `repl_channel_counter` | Gauge | `direction`, `peer`, `entryGen` | Current head per bucket |
| `repl_apply_total` | Counter | `partition`, `peer`, `op`, `outcome={applied,skipped_callGen,skipped_watermark}` | Throughput + content-gate hits |
| `repl_pull_lag_seconds` | Gauge | `peer` | `frame.latency_ms / 1000` rolling P99 |
| `repl_pull_errors_total` | Counter | `peer`, `kind={transport,parse}` | Per-peer error class |
| `repl_peer_state` | Gauge enum | `peer` | Per-peer fiber sub-state (see state-machine.md) |
| `repl_worker_state` | Gauge enum | — | Worker-level state |
| `repl_boot_duration_seconds` | Histogram | — | Pod start → Ready (INV4) |

Logs:
- `INFO` per worker-state and per-peer-fiber-state transition.
- `WARN` on `T_max` ceiling-hit; on `repl_apply_total{outcome=skipped_callGen}` rate >0 sustained (suggests a real cross-direction race, not just steady-state idempotency).
- `ERROR` on `ErroredFailed` per-peer fiber.

---

## Testing

Three execution modes for the same scenario source:

| Backend | Clock | Run via |
|---|---|---|
| In-memory `KvBackend` | TestClock | `npm run test` (default) |
| In-memory `KvBackend` | wall clock | `npm run test:ns-real` |
| Redis `KvBackend` | hybrid (TestClock + real-millis yields) | `KV_BACKEND=redis npm run test` |

Test taxonomy lives in `tests/replication/` (T-suite, mapped to G/INV) and `tests/replication-ns/` (NS-suite, scenario DSL). Each scenario must pass under all three backend combinations; divergence is a parity bug, automatically gated.

---

## Future-of-this-doc

When Story 7d ships:
- `redesign-call-cache-backup.md` becomes a one-line redirect to this file.
- `call-cache-backup.md` becomes a one-line redirect to this file (post-cutover).
- `CLAUDE.md` progressive reading guide row updated to point here.

Until then, this file describes the *intended* shape; the code is mid-flight.
