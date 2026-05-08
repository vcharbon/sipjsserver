# Replication redesign — call cache backup (B0 design doc)

## Status

PROPOSAL — Track B B0 deliverable for plan [`docs/plan/pure-enchanting-forest.md`](../plan/pure-enchanting-forest.md). Awaiting sign-off (B0.5) before any implementation work in B1 starts.

The current design at [`docs/replication/call-cache-backup.md`](./call-cache-backup.md) remains the production reference until Track B B2 cuts over.

---

## Why this redesign

The 1 h endurance run [`endurance-1h-vip-chaos-20260508`](../../test-results/k8s-endurance/endurance-1h-vip-chaos-20260508/) hit a cliff at 17:25:39 that correlates with the `propagate:{peer}` cardinality reaching ~20 K on **both** workers. The current implementation grows that ZSET monotonically — `ZADD` only, no `ZREM`-on-deliver, only a sliding 1 h TTL on the whole set that is refreshed by every write under load. Under continuous traffic the set never expires and primary's sidecar memory grows without bound. This violates the architectural property the system needs to make HA worth the complexity:

> A backup that is unreachable for arbitrary duration must impose **zero growing cost** on its primary.

That property cannot be patched into the existing shape — `propagate:{peer}` with no compensating trim is the shape, not a bug in it. Hence: clean-sheet redesign, starting from goals.

---

## Goals (G)

- **G1 — Self-describing storage.** Per-worker storage holds (a) calls the worker is primary for, (b) calls the worker is backup-of-record for, (c) per-call monotonic generation tracking local edits in either role.
- **G2 — Two-direction boot recovery.** On restart, a worker pulls from every peer:
  1. data the peer holds — *whether or not the peer changed it* — on calls where this worker is the primary, so a quick reboot leaves the worker able to process subsequent in-dialog messages as if no event had happened;
  2. data the peer is primary on, where this worker should act as backup.

  Both halves are pull-based, with watermark tracking and idempotent apply.
- **G3 — Sub-second steady state.** Under healthy peers, propagation latency from primary write to backup apply is ≤ 1 s P99.
- **G4 — SCAN-based catch-up.** A puller that has fallen behind beyond the in-memory steady-state window can resync via SCAN of the source partition. Correctness over speed.
- **G5 — No data loss while backup absent.** When a backup is temporarily unreachable but the primary is up, the primary's authoritative state is never compromised by backup absence.
- **G6 — Observable.** Every replication path exposes lag, queue-depth-or-equivalent, and last-applied-gen as Prometheus metrics.
- **G7 — Bounded steady-state network.** Per-peer outbound traffic is `O(write rate of changed calls)`, not `O(buffer size)`. Long-poll responses and SCAN page sizes are bounded.

---

## Non-goals (NG)

- **NG1.** Distributed consensus, strong cross-pod consistency, cross-DC replication.
- **NG2.** Recovery of state lost when both primary AND backup go down within the same call-TTL window. Inherits the existing accepted small-loss class.
- **NG3.** Strict ordering across calls. Per-call ordering is sufficient; cross-call interleaving is implementation-defined.
- **NG4.** Distributed transactions across primary + backup. Each side's local writes are atomic via the existing AtomicWriter Lua boundary; cross-pod writes are eventually consistent.

---

## Hard invariants (INV)

- **INV1 (HARD).** A backup unreachable for arbitrary duration imposes **zero growing cost** on its primary — no unbounded buffers, no growing scan time, no memory pressure on the primary's sidecar.
- **INV2.** Single-owner: a backup never promotes; the primary at INVITE time owns its calls' authoritative state for life. The cookie's `w_pri` is the primary for the call's whole lifetime. (See memory `project_call_partition_invariant`.)
- **INV3.** Idempotent apply: re-delivering an entry whose `gen ≤ local-gen` is a no-op.
- **INV4.** Boot recovery completes within **30 s P99** wall-clock from pod start to `WorkerReadiness.markReady(true)`, including SCAN-based bootstrap of `bak:{self}:` from every alive peer.
- **INV5.** A successful long-poll connection close — natural max-open or client disconnect — never loses entries that the primary has durably written. The puller's watermark advances strictly monotonically as entries are applied.

---

## Architecture

### 5.1 Storage layout

#### Decision

Per worker `N` (worker ordinal):

```
pri:{N}:call:{ref}           call body, JSON-encoded.
                             _topology = { pri, bak, gen } embedded.
                             Source of truth for calls where N is primary.

bak:{P}:call:{ref}           call body, JSON-encoded.
                             Backup-of-record for calls where P is the primary,
                             N is the backup-of-record.

idx:{indexKey} → callRef     SIP-derived index keys (Call-ID, dialog tag, etc.)
                             pointing to a callRef. Built per partition.

chg:{N}->{peer}              capped Redis Stream — change notifications N
                             produced that `peer` must apply. Bounded by
                             XADD MAXLEN ~ K on every write. Each entry is a
                             tiny payload: { dir, callRef, gen }. Bodies are
                             fetched from the source partition by the puller.

replpos:peer:{P}:dir:{D}     local watermark. Hash field on the local sidecar:
                             { lastReadId, epoch }. Survives consumer-process
                             restart but not sidecar restart (which is a full
                             rebuild trigger by design).

epoch:self                   monotonically-increasing integer (or ULID). Bumped
                             on every sidecar restart. Returned in the long-poll
                             hello frame so a puller detects writer-side restart
                             and resets to since=0.
```

CallRef stays self-describing: `{primaryOrdinal}|{aLegCallId}|{aLegFromTag}` per [src/call/CallModel.ts:694](../../src/call/CallModel.ts#L694). Any worker holding a callRef can parse the primary ordinal and pick the right partition without consulting a registry.

`_topology.gen` (Schema.Int) stays the per-call monotonic. It bumps on every CallState write (put / refresh / delete-tombstone) regardless of role, so primary and backup edits both produce a strictly increasing gen.

#### Considered alternatives

- **Separate gen index `idx-gen:{ref}=gen`.** Allows "is local newer?" comparison without decoding the body. *Rejected:* requires extra atomicity with body update; the existing Lua atomic-write boundary already covers the body; an extra key buys no observable speedup over reading the body's gen field once at apply time.
- **Per-call timestamp instead of gen.** *Rejected:* clock-skew across pods makes it unsafe for ordering decisions; the existing gen counter is monotonic by construction and was already deployed.
- **Single global `chg:{N}` stream consumed by every peer.** *Rejected:* every peer would have to filter every entry by `dir` and `dest`, growing the stream by a factor of `N-1`; per-pair streams are smaller and let MAXLEN bound each peer's exposure independently.

---

### 5.2 Steady-state propagation primitive

#### Decision

A capped Redis Stream `chg:{self}->{peer}` per (writer, peer) pair, written by the AtomicWriter Lua script atomically with each call body update.

```
XADD chg:{self}->{peer} MAXLEN ~ K  *  dir <fwd|rev>  callRef <ref>  gen <N>
```

Stream entries carry only the notification — `(dir, callRef, gen)`. Bodies are fetched from the source partition (`pri:{primary}:call:{ref}` for forward, `bak:{primary}:call:{ref}` for reverse) on apply.

Direction semantics:

- `dir=fwd` — `self` is acting as primary for `callRef`; the destination peer mirrors the body into its `bak:{self}:`.
- `dir=rev` — `self` is acting as backup for `callRef` (i.e. `roleOf(ref, self) === "bak"`); the destination peer (the original primary) merges the body back into its `pri:{primary}:` when it returns.

Trim is approximate (`MAXLEN ~ K`) — Redis evicts to roughly K entries, not exactly K. Approximate trim is O(1)-amortized at write time.

K is configured per cluster as a function of the maximum tolerable steady-state replication lag: at write rate `R` per worker, the stream covers `K / R` seconds of catch-up before falling out of window. Default `K = 60_000` covers ~5 minutes at 200 writes/sec. Per-stream memory ceiling: `K × ~64 bytes ≈ 4 MB`. Per-worker total at fan-out N: `(N-1) × 4 MB`.

#### Considered alternatives

- **Capped sorted set with manual `ZREMRANGEBYSCORE` GC.** *Rejected:* a hand-rolled trim is error-prone — must run on every Nth write, must not race with reads, must handle TTL refresh. `XADD MAXLEN ~` is native and atomic with the body write.
- **Per-peer pub/sub (zero buffer).** *Rejected:* INV1 is satisfied trivially, but every reconnect requires a full SCAN to recover; steady-state freshness is fragile. The bounded stream is INV1-compliant *and* gives a usable steady-state window.
- **Per-call latch (set a "dirty" flag on the body, peer scans for dirty flags).** *Rejected:* puller has to scan the whole partition to find dirty entries; doesn't scale; equivalent to a poor-man's stream.
- **Append-only log file written by the worker process.** *Rejected:* duplicates data the sidecar already holds; complicates crash recovery; adds a non-Redis dependency.
- **Direct push from primary to backup (HTTP/UDP).** *Rejected:* puts state on the primary about who's connected; INV1 violation if push retries are buffered.

---

### 5.3 Watermark tracking

#### Decision

The puller stores `lastReadId` and `epoch` per (peer, dir) pair on its **local** sidecar Redis:

```
HSET replpos peer:{P}:dir:{D}  '{ "lastReadId": "<stream-id>", "epoch": <N> }'
```

The puller writes the watermark **after** each entry's body apply completes (`XADD body → put-call → HSET replpos`). On restart of the consumer process, the puller reads its watermark and resumes from `lastReadId`. On sidecar restart (sidecar-wiped boot), the watermark is gone — the boot path treats this as a full SCAN trigger, not a steady-state resume.

Each long-poll request to the source peer carries `epoch` and `since=lastReadId`. The source peer's `hello` frame reports its own current epoch:

- if `client.epoch < server.epoch` → writer was restarted; client's `lastReadId` is stale → server returns `epoch_advanced=true`, client falls back to SCAN bootstrap, resets watermark to current head.
- if `client.epoch === server.epoch` and `lastReadId < server.stream.minId` → client fell out of window → server returns `out_of_window=true`, client falls back to SCAN.
- otherwise → server streams `XRANGE since=lastReadId, +inf` then long-polls for new writes.

#### Considered alternatives

- **Watermark in process memory only.** *Rejected:* lost on consumer process restart even when the sidecar is intact. Forces an unnecessary SCAN at every consumer restart.
- **Watermark in an external store (Postgres / etcd).** *Rejected:* adds a dependency; the local sidecar is already the data plane.
- **Consumer groups (`XGROUP CREATE` + `XREADGROUP`).** *Rejected:* consumer groups deliver each entry to exactly one consumer in the group; we have a 1:1 relationship between (peer, dir) and consumer. Acks add a round-trip. The plain `XRANGE/XREAD` pattern is simpler and equivalent for our access pattern.
- **Encode watermark in the call body itself.** *Rejected:* couples replication progress to call lifecycle; entries for completed calls never get acked.

---

### 5.4 Boot recovery path

#### Decision

On worker N boot, with `WorkerReadiness.markReady(false)` held:

1. **Enumerate alive peers** via the existing `PeerEnumerator` (k8s endpoint slice).
2. **For each peer P, in parallel up to 8 fibers:**
   - Pull P's `bak:{N}:call:*` partition via SCAN, pace by 50 ms yield between batches of 50 entries. For each entry:
     - parse callRef; if `parsed.primary !== N`, drop with a structured WARN (defensive — peer should never expose foreign rows in `bak:{N}:`).
     - decode body, gen-compare against local `pri:{N}:call:{ref}`. If incoming `gen > local gen`, `putCall("pri", N, ref, body, indexes, ttl)`; otherwise increment a `skippedByGen` counter.
     - this is the FORWARD-into-self bootstrap: restores N's primary partition from peers' backup mirrors. Identical in spirit to the existing ReclaimRunner.
   - Pull P's `pri:{P}:call:*` partition via SCAN, filtered by `_topology.bak === N` if the partition exposes a Lua-side prefilter, otherwise full scan with N-side filter. For each entry where N should be the backup:
     - decode body, gen-compare against local `bak:{P}:call:{ref}`. If incoming gen wins, `putCall("bak", P, ref, body, indexes, ttl)`; otherwise count as skipped.
     - this is the REVERSE-into-self bootstrap (G2 part 2): restores N's backup-of-record partition from peers' primary partitions, *changed-or-not*. The current ReclaimRunner does NOT do this — it relies on steady-state forward streaming to repopulate the backup. The new design makes it explicit so a backup that's been down for >stream-window catches up correctly via SCAN.
3. **After both halves complete (or `maxDuration=25s` fires), set the watermark for every peer to that peer's stream head**, so steady-state pullers don't replay what SCAN just ingested. Use `XINFO STREAM chg:{P}->{N}` `last-generated-id` as the new watermark seed.
4. `WorkerReadiness.markReady(true)`. Total budget: 30 s P99 (INV4); SCAN budget: 25 s; the remaining 5 s is shared between enumeration, watermark seeding, and post-gate hooks.

If a peer's SCAN fails mid-stream, that peer's bootstrap is partial — `peersFailed` counter increments and the runner continues with the remaining peers. No retry-loop on the boot path — partial recovery beats no recovery (existing accepted behavior). The peer's own steady-state stream eventually fills the gap once both sides are back.

If a peer is unreachable at boot time (e.g. it is also restarting), the enumerator's snapshot won't include it; that peer is ignored at boot. When the peer eventually returns, the rediscovery loop forks a fresh pull fiber against it, which performs an XINFO check on its first long-poll — out-of-window triggers a deferred SCAN at that point, scoped to that peer.

#### Considered alternatives

- **Serial SCAN of peers.** *Rejected:* with 30 s budget and N>3 peers each holding tens of thousands of rows, the budget is too tight.
- **Skip SCAN if local watermark is still in the peer's stream window.** *Rejected:* at sidecar-wiped boot, the watermark is gone. The current ReadyGate `drainOnly=true` long-poll path attempts this; the new design rejects it because it is insufficient to satisfy G2 part 2 (peer-primary-changed-or-not).
- **Trust steady-state stream-only catch-up (no boot SCAN at all).** *Rejected:* misses entries that fell out of MAXLEN window during the outage; misses unchanged entries that the peer never streamed.
- **Single mega-SCAN that walks all partitions on all peers in one fiber.** *Rejected:* parallelism per peer is what fits the 30 s budget.

---

### 5.5 Steady-state vs SCAN catch-up

#### Decision

The puller's steady-state loop is: open long-poll → drain `since=lastReadId` → apply each entry → advance watermark → on natural close (server-side `max_open`), reconnect.

Out-of-window detection happens **server-side** at long-poll open:

```
client GET /chg?peer=N&dir=fwd&since=<id>&epoch=<E>
  ↓
server hello { epoch=<E'>, head_id=<id'>, min_id=<id''>, out_of_window=<bool>, epoch_advanced=<bool> }
  ↓
  if epoch_advanced || out_of_window:
    client triggers per-peer-per-dir SCAN of the source partition
    after SCAN, client sets lastReadId = head_id, reconnects fresh
  else:
    server streams XRANGE since=lastReadId, +inf
    then long-polls (XREAD BLOCK) until max_open or new entry
```

Critically: SCAN here is **scoped** to the (peer, dir) that fell out of window. Other peers' steady-state pullers keep running. This avoids the all-or-nothing reset that a global epoch bump would imply.

`max_open` ceiling: 25 s (server-side `Stream.haltWhen`). Client-side `Effect.timeout` set to 35 s (10 s slack over server) — the client's timeout never fires before server's, so client-side timeouts are alarming and logged at WARN. Today's plan-of-record's 35 s force-cut becomes a dead-letter.

#### Considered alternatives

- **Always SCAN on reconnect.** *Rejected:* most reconnects are within window; SCAN is expensive.
- **Client-side window check via XINFO before opening.** *Rejected:* extra round-trip for every reconnect; server already knows the answer at hello time.
- **Per-entry sequence numbers separate from stream IDs.** *Rejected:* Redis Stream IDs are already monotonic timestamps and are cheap to compare; an extra sequence number duplicates that.
- **Treat any reconnect as out-of-window unless explicit ACK chain.** *Rejected:* equivalent to consumer groups; rejected for the reasons in §5.3.

---

### 5.6 Failure handling matrix

| Scenario | Primary behaviour | Backup behaviour | Net result |
|---|---|---|---|
| **Backup peer disappears mid-stream** | XADD continues to its local `chg:{self}->{peer}` stream; trim-on-write keeps memory bounded (INV1). | Long-poll connection drops; consumer process retries with backoff per `PullLoopSupervisor`. On reconnect, watermark is in window (if outage < window) → seamless resume; out of window → SCAN. | At-most-`window`-stale; recovers via SCAN if outage long. |
| **Backup peer never returns** | Same — stream is bounded by MAXLEN. No state about who's connected. | N/A. | INV1 holds. |
| **Backup peer pod IP rotates** | XADD continues — local stream, no peer state. | The `PullLoopSupervisor`'s rediscovery loop (existing pattern) tears down the old fiber and forks a new one against the new IP. The new fiber reads `replpos:peer:{P}:dir:fwd` watermark — same `replpos` key works because `peer` is the worker ordinal, not the IP. New fiber issues a long-poll, gets `epoch` from new pod (sidecar-wiped → epoch reset → epoch_advanced → SCAN). | Recovers via SCAN within seconds. |
| **Primary's own restart while backup unreachable** | Sidecar wipe → empty `pri:{self}:`. Boot path's "pull from peer's `bak:{self}:`" is skipped for unreachable peer (no enumerator entry). Worker becomes ready with empty `pri` — incoming in-dialog requests on those calls 481 → existing accepted small-loss class (NG2 if backup also down). | N/A. | NG2 accepts the loss. Once backup returns, primary is already serving — its empty `pri:{self}:` will be filled by **new** writes; old calls are lost (NG2). |
| **Backup's own restart while primary unreachable** | N/A. | Sidecar wipe → empty `bak:{primary}:`. Boot path's "pull from peer's `pri:{primary}:`" is skipped for unreachable peer. Worker becomes ready; if primary returns, steady-state forward stream resumes; backup catches up via in-window or SCAN as appropriate. | Equivalent to scenario 1 from primary's POV — backup eventually catches up. |
| **Both restart simultaneously** | Both have empty sidecars. Both query each other; neither has data. Both proceed empty. | Same. | NG2 territory: in-flight calls are lost. Documented limit of the design. |
| **Both restart, primary first** | Primary boots empty; SCAN against down backup yields nothing; primary proceeds empty. Calls in `bak:{primary}:` on backup are lost from primary's perspective until backup boots and reverse-streams them. | Backup boots later; SCAN against now-up primary yields whatever primary has now (empty initially). Steady-state stream resumes. Pre-restart `bak:{primary}:` content is gone. | NG2 unless callers retry. |
| **Both restart, backup first** | Symmetric to above; backup is empty and primary's `pri:{primary}:` is also empty when it returns. Same NG2 outcome. | Same. | NG2. |
| **Network partition** between primary and backup (both alive) | XADD continues; bounded buffer. | Long-poll fails repeatedly; consumer retries; INV1 holds — no partition-side state grows. | When partition heals, in-window resume or SCAN catch-up as in scenario 1. |
| **Primary's sidecar slow / saturated** | XADD latency increases but does not fail. Application backpressure is the only consequence — does not affect peer state. | Long-poll either gets short responses (server-side max_open hits before window fills) or empty heartbeats. Steady state. | Local issue; INV1 unaffected. |
| **Backup's sidecar slow / saturated** | Unaffected — primary is decoupled. | Apply latency increases. Stream window may pass while still applying old entries → out-of-window detected on next reconnect → SCAN. | Backup self-heals via SCAN; primary uninvolved. |
| **A worker briefly took over a peer's calls (acted as backup) and then itself dies before the original primary returns** | Reverse-direction stream entries written to `chg:{worker}->{peer}` are lost when worker's sidecar dies. | Original primary returns, SCAN's the dead worker's `bak:{primary}:` partition (unreachable) → finds nothing → primary proceeds with whatever `pri:{primary}:` it can rebuild from the surviving peers. | NG2 territory if no surviving peer holds the calls. |

The only memory-growing failure mode is "an active peer keeps accepting writes to its local stream" — which is the INV1 bound (`MAXLEN ~ K`).

---

### 5.7 Observability hooks

Every metric is registered on the existing `ReplMetrics` service and scraped from each pod's `/metrics` endpoint.

#### Per-peer per-direction stream metrics

```
b2bua_repl_stream_lag_ms{peer,dir}            histogram
                            now() - timestamp(lastReadId on this puller)
b2bua_repl_stream_depth_writer{peer,dir}      gauge
                            XLEN of self's outbound stream — capped by MAXLEN
b2bua_repl_stream_dropped_total{peer,dir}     counter
                            entries evicted by MAXLEN (writer-side, derived from
                            XADD return: stream.length BEFORE > stream.length AFTER + 1)
b2bua_repl_last_applied_id{peer,dir}          gauge (string-encoded ms)
                            puller's last-applied stream ID
```

#### Per-peer SCAN metrics

```
b2bua_repl_scan_total{peer,partition,outcome=success|failed|partial}    counter
b2bua_repl_scan_duration_ms{peer,partition}                              histogram
b2bua_repl_scan_entries_total{peer,partition,outcome=applied|skipped|bad} counter
```

#### Apply-side metrics

```
b2bua_repl_apply_total{peer,dir,outcome=applied|skipped_by_gen|bad}      counter
b2bua_repl_apply_duration_ms{peer,dir}                                   histogram
```

#### Boot recovery metrics

```
b2bua_repl_boot_phase_duration_ms{phase=enumerate|scan|seed_watermark}   histogram
b2bua_repl_boot_total{outcome=success|partial|timed_out}                 counter
```

#### Logs

- `INFO  repl-stream-open peer=<P> dir=<D> from_id=<id> epoch=<E>`
- `INFO  repl-stream-close peer=<P> dir=<D> frames=<N> reason=<max_open|client_close|error>`
- `WARN  repl-watermark-out-of-window peer=<P> dir=<D> client_id=<id> server_min_id=<id> → SCAN`
- `WARN  repl-epoch-advanced peer=<P> client_epoch=<E1> server_epoch=<E2> → SCAN`
- `INFO  repl-scan-start peer=<P> partition=<bak|pri>`
- `INFO  repl-scan-complete peer=<P> partition=<...> entries=<N> applied=<N> skipped=<N> duration_ms=<N>`
- `WARN  repl-scan-partial peer=<P> partition=<...> entries=<N> error=<...>`
- `INFO  repl-fiber-start name=<pull-loop|boot|scan> peer=<P>`
- `WARN  repl-fiber-exit name=<...> peer=<P> exit=<Failure|Success> cause=<...>`

The Track A.A1 `repl-fiber-start/exit` instrumentation already in [src/main.ts](../../src/main.ts) carries forward unchanged.

---

## Test taxonomy

Each invariant + goal maps to at least one fake-clock or live test. Tests are scaffolded under [tests/replication/](../../tests/replication/) (NEW).

| ID | Type | Scenario | Asserts |
|---|---|---|---|
| **INV1.1** | fake-clock, long-running | Worker A primary for 1000 calls with 200 writes/sec. Backup B is in `manual` mode and never consumes. Run 1 h fake-clock. | A's local `chg:A->B` stream length stays ≤ MAXLEN × 1.1 throughout (10 % overhead for `~`). A's sidecar memory bounded. |
| **INV1.2** | fake-clock | A primary, B backup. B is up. Stop B's puller fiber programmatically (simulates puller-only failure with sidecar still up). Run 30 min. | B's `replpos` watermark falls behind, but A's stream is still bounded. On B re-fork, B detects out-of-window → SCAN. No 481 on subsequent in-dialog traffic for surviving calls. |
| **INV3.1** | fake-clock | Replay the same stream entry twice (force a re-deliver via reconnect-with-stale-watermark). | Apply count=1 (skipped_by_gen on the second). |
| **INV4.1** | live (k8s) | Seed 50 K calls in `pri:A:` and corresponding `bak:A:` on B. Restart A. | Time from pod-start to `WorkerReadiness.markReady(true)` ≤ 30 s P99 across 10 trials. |
| **INV5.1** | fake-clock | A writes 100 entries. B's puller is mid-apply when the connection's max_open fires; reconnect immediately. | All 100 entries applied exactly once; lastReadId advances strictly monotonically. |
| **G2.1** | fake-clock | A primary, B backup. INVITE arrives, A processes 200 OK, ACK. B has the call mirrored. A goes down for 1 s (TestClock-simulated pod restart). A reboots, runs SCAN bootstrap. Mid-call BYE arrives at A. | No 481. A applies BYE successfully. |
| **G2.2** | fake-clock | A primary, B backup. B is fresh-booted with empty sidecar. A has been writing for 5 min; A's `chg:A->B` stream is at head_id `h5min`. B boots and runs SCAN of A's `pri:A:` (changed-or-not) → sets watermark to `h5min` → starts steady-state from there. | B's `bak:A:` matches A's `pri:A:` after bootstrap completes. No entries leak through SCAN→stream boundary. |
| **G3.1** | live (k8s) | 1 h soak at steady traffic (50 cps). | `b2bua_repl_stream_lag_ms` P99 ≤ 1000 ms across the run. |
| **G4.1** | fake-clock | A primary, B backup. B's puller is paused. A writes `MAXLEN + 100` entries. B's puller resumes. | First reconnect's hello frame returns `out_of_window=true`; B runs SCAN of A's `pri:A:`. After SCAN + watermark seed, steady-state resumes from current head with no further out-of-window events. |
| **G5.1** | fake-clock | A primary, B backup. B is down. A processes 5 min of traffic (continuous calls). | A's call-handling never blocks on B. Local `chg:A->B` length stays at MAXLEN. When B returns, B catches up via SCAN. |
| **G6.1** | fake-clock | Run any of the above with metric assertions in the test body. | Every metric in §5.7 is registered, has the right labels, and updates monotonically (counters) or sensibly (gauges/histograms) under each scenario. |
| **G7.1** | fake-clock | A writes 10 K entries while B is connected with consumer up; long-poll never returns more than one MAXLEN window per request. | Per-request frame count ≤ MAXLEN. |
| **NG2.1** (regression guard) | fake-clock | Both A and B sidecars wiped simultaneously while a call is in-flight. | The in-flight call gets 481 on the next in-dialog request — confirming the documented loss class — but no other failure mode (no fiber crash, no metric scrambled). |

Test files (NEW):

- `tests/replication/inv1-bounded-stream.test.ts`
- `tests/replication/inv3-idempotent-apply.test.ts`
- `tests/replication/inv5-monotonic-watermark.test.ts`
- `tests/replication/g2-boot-recovery.test.ts`
- `tests/replication/g4-out-of-window.test.ts`
- `tests/replication/g5-backup-down-no-impact.test.ts`
- `tests/replication/g6-metrics-shape.test.ts`
- `tests/k8s/replication-boot-budget.test.ts` (live, INV4.1)
- `tests/k8s/replication-steady-state-lag.test.ts` (live, G3.1)

The fake-stack [`tests/support/k8sFakeStack.ts`](../../tests/support/k8sFakeStack.ts) gains a `chg:` Stream-shaped MutableHashMap-backed memory store so tests can inject arbitrary stream states and observe writes through the read API. Pattern mirrors the existing `MemoryStore` shared between `AtomicWriter` and `PartitionedRelayStorage`.

---

## Configuration surface

```
AppConfig.replication.streamMaxLen          number   default 60_000
AppConfig.replication.scanBatch             number   default 50
AppConfig.replication.scanPacingMs          number   default 50
AppConfig.replication.scanPeerConcurrency   number   default 8
AppConfig.replication.bootMaxDurationMs     number   default 25_000   (INV4 minus 5s slack)
AppConfig.replication.longPollMaxOpenMs     number   default 25_000
AppConfig.replication.longPollClientTimeoutMs number default 35_000   (server max_open + 10s slack)
AppConfig.replication.heartbeatIntervalMs   number   default 5_000
```

All values exposed as Helm chart fields under `replication.*`.

---

## Migration / rollout

**Out of scope for this design doc.** B0 only fixes the architecture and acceptance tests. B1 (implementation) sequences the refactor as a multi-slice commit chain analogous to `data-replication slice 1..7`. B2 (cutover) deletes the legacy `propagate:` paths.

The current implementation cannot be safely co-resident with the new one (writers must agree on whether they're writing ZADD or XADD), so cutover is single-shot per cluster: the new binary replaces the old in a coordinated rolling restart. During the restart window the call-cache replication is lossy in the NG2 sense — any call held only on a not-yet-restarted-and-not-yet-restarted-pair pod is lost. Acceptable per the existing operational contract for a major version bump.

---

## Open questions

These remain for B1 implementation slicing, NOT for B0 sign-off:

- **Q1.** Where exactly is the `XADD MAXLEN ~ K` invocation rooted — inside the existing `AtomicWriter` Lua script (so it stays atomic with body write) or as a follow-on call (slightly cheaper but introduces a tiny non-atomic window)? Lean: keep it atomic in Lua.
- **Q2.** The current ReadyGate's `drainOnly=true` long-poll path is being replaced by the SCAN-based bootstrap; does the new design retain the `replog`-style /chg endpoint for *steady-state* long-poll, or does it consolidate boot + steady-state on the same endpoint with a `mode=` query param? Lean: same endpoint, `mode=stream|drain` discriminator, server picks between `XRANGE+XREAD` and `XRANGE only`.
- **Q3.** Pacing on the SCAN side: do we keep the existing `scanPacingMs=50` default or tighten it given the 30 s budget is now strict? Empirical — measure during B1.
- **Q4.** The reverse-direction stream entries are produced when a worker writes as `role==="bak"` (i.e. `roleOf(ref) === "bak"`). The single-owner invariant (INV2) says backup never promotes — when does role==="bak" ACTUALLY happen in practice? Audit during B1: this should only happen during a primary-down failover window, and the reverse stream's lifetime is short. Confirm no steady-state code path produces reverse entries unexpectedly.

---

## Sign-off checklist (B0.5)

The design is signed off when each item below is checked. Until then, B1 does not start.

- [ ] G1 — storage layout enumerated, decision recorded, alternatives documented.
- [ ] G2 — boot recovery path covers both halves (changed-or-not, both directions); SCAN budget compatible with INV4.
- [ ] G3 — steady-state design has a measurable lag target.
- [ ] G4 — SCAN-based catch-up is reachable from steady-state without manual intervention.
- [ ] G5 — primary's own state is independent of backup's reachability.
- [ ] G6 — metric taxonomy specified with labels.
- [ ] G7 — per-request bandwidth bounded.
- [ ] NG1, NG2, NG3, NG4 — non-goals explicitly recorded; no test asserts them.
- [ ] INV1 — all writer-side state uses bounded primitives.
- [ ] INV2 — design preserves single-owner; no path elects a new primary.
- [ ] INV3 — apply path is idempotent under re-delivery.
- [ ] INV4 — 30 s P99 boot budget honored by parallelism + pacing strategy.
- [ ] INV5 — watermark advances monotonically, no entry drops on natural close.
- [ ] Failure handling matrix covers every adjacency (peer up/down, sidecar up/down, both sides up/down, network partition).
- [ ] Test taxonomy maps every G/INV to a concrete test, with file paths and shape.
- [ ] Configuration surface enumerated; defaults justified.

When the user signs off, the design doc transitions to status STABLE and Track B B1 begins.
