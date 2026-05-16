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
Cluster-shared counter (Redis-backed) that rate-limits concurrent calls per limiter id, summed over the last N windows. Read on every initial INVITE; `INCR` on admission, `DECR` on termination. Cap-hit returns `Rejected` (a normal outcome, not an error).

**Fail-open admission**:
A call admitted *without* the limiter `INCR` landing on Redis. Happens when the limiter Redis is unreachable or times out (`RedisError` / `LimiterTimeout`). The call is allowed through to keep traffic flowing, but the `limiterEntries[i].incrementSucceeded` field is set to `false` so the matching `DECR` is skipped on termination — otherwise the cluster counter drifts negative. See [ADR-0004](docs/adr/0004-strong-incr-decr-invariant-for-call-limiter.md).

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

## Flagged ambiguities

- **"mirror"** was overloaded: it was used both as a description of the act of dual-writing across two sidecars AND as the name for the `entryGen=0` sentinel bucket. Resolved: keep "mirror" for the wire-level `entryGen=0` sentinel only; use "replication channel" / "dual-write" for the higher-level concept.
- **"takeover"** was used in some docs to mean both "the partition ref changed owners" (incorrect — it never does) and "the backup served a request" (correct). Resolved: retire "takeover"; say "backup serves the request" or "backup-served write".
- **"pull stream" / "delta stream"** were both used for `/replog`. Resolved: **replog stream**.
- **"cold pull" / "snapshot" / "restart stream"** were all used for `/bootstrap`. Resolved: **bootstrap stream**.
- **"gen" vs "epoch"** — same concept, two names. Resolved: keep both; `gen` is the wire field name, "epoch" is the prose name (and the type name `EpochCounter`).
