# Call Cache Backup Mechanism

**Status:** Slice 0 spec for the data-replication-layer refactor
([plan](../plan/data-replication-layer-refactor-starry-cocke.md)).
This document is the *contract* for slices 1–6. When the implementation
disagrees with what is written here, this doc wins; if reality forces a
deviation, the doc is updated in the same slice.

**Audience:** anyone touching `src/cache/`, `src/call/CallState.ts`,
`src/replication/`, or worker-lifecycle code; oncall operators reading
the metrics.

**Companion docs:**
- [resilience-model.md](../sip-front-proxy/resilience-model.md) — the front-proxy side of the same picture (worker selection, cookie, OPTIONS, drain).
- [TODO_doubleWrite.md](../todos/TODO_doubleWrite.md) — historical decision log (D-numbers cited below) for the dual-write design this refactor replaces.
- [CallModel.md](../CallModel.md) — Call/Leg/Dialog data model that is being persisted.

---

## 0. Single-owner invariant (load-bearing — read first)

Every other section depends on this rule. Repeated bugs in the data layer have come from forgetting it; the failure mode is invariably "two workers think they own the same call."

> **A call's primary owner is fixed at INVITE time and never changes for the call's lifetime.**

The proxy stamps the cookie at INVITE time as `v=2|w_pri=<id>|w_bak=<id>|c=<callId>` and HMAC-signs it ([LoadBalancer.ts:108-133](../../src/sip-front-proxy/strategies/LoadBalancer.ts#L108-L133)). On every in-dialog SIP message the proxy decodes the cookie to find the route, but **does not** modify `w_pri` or `w_bak` — modifying either would break the MAC. Promotion to the backup destination (`decode_forward_backup`, [LoadBalancer.ts:440-487](../../src/sip-front-proxy/strategies/LoadBalancer.ts#L440-L487)) changes where the message is sent, **not** the cookie. The two ordinals therefore travel with the call from INVITE through BYE regardless of which worker physically processes any individual message.

Five corollaries that every component must respect:

1. **Backup serves traffic and bumps gen/state — the partition reference never moves.** When the proxy `decode_forward_backup`s a request to worker B because primary A is unreachable, B **must** answer the request, advance the call's state machine, increment `callGen`, and write the new state into `bak:{A}:call:{ref}` on its own sidecar. *Refusing to serve is a bug, not the invariant.* Updates flow back to A via reverse-propagate (corollary 3). The shorthand "**backup never promotes**" means only that the partition reference (`pri:{A}:`) and the cookie ordinals stay with A for the call's whole life — B never moves the call into `pri:{B}:` and the proxy never re-stamps `w_pri`. Logs and metrics distinguish the role for observability; **the serve/no-serve decision must not branch on the role**. If you find code or a comment that reads "if (role === 'backup') reject / 481 / skip", that is the invariant being violated, not enforced. (D16 in [TODO_doubleWrite.md](../todos/TODO_doubleWrite.md). Repeat offender — see `docs/plan/bye-takeover-replicated-indexes-fix.md` §3 for the latest instance.)

2. **`pri:{P}:call:{ref}` is written only by P, ever.** No other worker writes into another worker's primary partition. Even when B is serving traffic for a call whose `w_pri=A` and A is dead, B writes the updated state into B's own `bak:{A}:call:{ref}` partition — never into B's `pri:{B}:`.

3. **Backup-served updates flow back to the primary via reverse-propagate.** B's write to `bak:{A}:call:{ref}` enqueues a propagate entry on B's `propagate:{A}` (same atomic Lua write as a primary-side put). When A reboots, A's ReadyGate drains B's `propagate:{A}` and ingests the entry; A reconstructs `pri:{A}:call:{ref}` from the latest state B wrote during the outage.

4. **Cookie ordinals are the source of truth for partition routing.** When SipRouter receives an in-dialog request, the routing layer extracts `w_pri` and `w_bak` from the cookie. The cache layer reads from `pri:{self}:` if `w_pri==self`, otherwise from `bak:{w_pri}:`. Writes go to the same partition the read came from. No internal bookkeeping is needed — the SIP message itself carries the routing every time. For non-SIP events (timer, timeout, internal-event) the persisted Call object carries `wPri`/`wBak` so the same routing can be reconstructed.

5. **There is never a moment of dual ownership.** Because primary-rights never move, two workers cannot simultaneously think they own the same call. On primary's restart the primary's `pri:{P}:` is the merge of (its own pre-crash state, if any) and (the reverse-propagate stream from peers); since reverse-propagate writes happened strictly *after* the crash, the `(epoch, seq)` pair on those writes is strictly newer than anything pre-crash. No conflict resolution beyond gen comparison is needed.

The colloquial term "takeover" appears in older sections of this doc and in code comments. Read it as **"the backup served the request from `bak:{w_pri}:` and wrote the updated state back to the same partition"** — never as "the backup became primary," and never as "the backup refuses to serve." Two opposite mis-readings are equally wrong:

- **(a) Backup is promoted to primary** — false; `pri:{A}:` and the cookie ordinals stay with A.
- **(b) Backup refuses to serve while primary is down** — also false; the backup serves *as backup*, bumping gen/state in `bak:{A}:` and propagating back. Refusing to serve breaks the in-flight call and the propagate-back contract.

If you find a comment, doc paragraph, log message, or code branch that implies either (a) or (b), treat it as a bug to fix in the same PR that touches the surrounding code.

---

## 1. What problem this layer solves

A B2BUA worker pod can die at any time (K8s eviction, node drain, OOM, crash). When it does, the calls that worker was handling must be **recoverable** by another worker so that:

- In-dialog SIP requests (re-INVITE, UPDATE, INFO, BYE, REFER) that the front proxy reroutes to a surviving worker land on a worker that *has the call's state* and can answer correctly. RFC 3261 §12.2.2 says the fall-back is `481 Call/Transaction Does Not Exist`; we want 481 to be the rare exception, not the common path.
- The recovering worker, when it restarts, can pick up calls it owned before the crash without losing dialogs the cluster successfully kept alive while it was down.

The mechanism described here is **not** a general-purpose distributed database. It is purpose-built around three SIP timer constraints:

| Constraint                                     | Source                                       | Consequence for this design                                              |
|------------------------------------------------|----------------------------------------------|--------------------------------------------------------------------------|
| Replication latency must be sub-second         | RFC 3261 Timer T1 (500 ms), T2 (4 s)          | No synchronous cross-pod ack on the SIP hot path. Long-poll, not 2PC.    |
| Calls live up to 180 s in INVITE state         | RFC 3261 Timer C                             | K8s `terminationGracePeriodSeconds` ≥ 200 s; in-flight calls drain.      |
| Dialog can live for hours (UPDATE refreshes)   | RFC 3261 §13                                 | TTL on cache entries must exceed inactivity window; refresh is a write.  |

Redis async replication was rejected (memory note `project_ha_backup_design.md`) because its consistency profile cannot be bounded against these timers. The model below is a per-call **dual-write across two Redis sidecars** (one per worker) coordinated by the workers themselves.

### 1.1 Why per-pod sidecar (not a shared Redis) for call context

The call context cache is **deliberately** per-pod sidecar, not a shared cluster Redis. The decision is load-bearing:

- The SIP hot path issues a Redis write on every state-mutating message (every INVITE state machine transition, every reINVITE, every BYE). With Timer T1 = 500 ms, the per-write budget is on the order of one digit of milliseconds. A sub-millisecond hop to `localhost:6379` (sidecar) gives that headroom; a shared Redis Service even *in-cluster* costs at least one extra pod-to-pod hop, often through CNI overlay encapsulation, and competes with every other worker's writes for the shared instance's CPU.
- Latency is observable elsewhere in this doc: §7.4 and §259 / §401 / §499 cite "sub-millisecond local socket" and "< 10 ms in-cluster steady state replication." Those numbers depend on the writer never having to traverse the cluster network on the SIP critical path.
- The dual-write + reverse-propagate machinery exists *because* of this choice: it is what gives us cross-pod recoverability without putting a cross-pod hop on the hot path.

The **call limiter** (`CallLimiter` / `LimiterRedisClient`) makes the *opposite* choice and lives on a single cluster-shared Redis. It can, because:

- Limiter writes are off the SIP retransmission path. `checkAndIncrement` runs once at INVITE routing time; `decrement` runs once at terminate. A 5–10 ms cross-pod hop adds nothing perceptible to call setup.
- The limiter *requires* global counters. Per-pod counters would silently allow `N × limit` concurrent calls fleet-wide. That was a real bug fixed by introducing the separate `LimiterRedisClient` service tag and binding it to `LIMITER_REDIS_URL` (defaults to `REDIS_URL` with a startup warning when both share an endpoint — acceptable for single-Redis dev, broken for sidecar HA).

The two services therefore deploy with two distinct Redis topologies:

| Concern         | Redis              | Endpoint                           | Why this side                            |
|-----------------|--------------------|------------------------------------|------------------------------------------|
| Call context    | Per-pod sidecar    | `redis://localhost:6379`           | Sub-ms writes on the SIP hot path        |
| Call limiter    | Cluster-shared     | `redis://<shared-svc>:6379`        | Global counter, latency-tolerant         |

Code map: [src/redis/RedisClient.ts](../../src/redis/RedisClient.ts), [src/redis/LimiterRedisClient.ts](../../src/redis/LimiterRedisClient.ts), [src/call/CallLimiter.ts](../../src/call/CallLimiter.ts), kind harness chart [tests/k8s/charts/redis/](../../tests/k8s/charts/redis/).

---

## 2. Glossary

| Term                | Meaning                                                                                          |
|---------------------|--------------------------------------------------------------------------------------------------|
| **Worker (N, P, Q)**| A B2BUA pod. Each has its own Redis sidecar pod.                                                 |
| **Sidecar**         | A Redis instance colocated with one worker, in-memory only (no AOF, no RDB).                     |
| **Call's primary** | The worker the front proxy stamped as `w_pri` in the stickiness cookie at INVITE time. Per-call. |
| **Call's backup**  | The worker stamped as `w_bak` in the cookie. Per-call; may differ from one call to the next.     |
| **`callRef`**       | Deterministic call identifier derived from a-leg `Call-ID + From-tag`. The atomic unit of state. |
| **`epoch`**         | Monotonic counter incremented on each worker process boot. Identifies a worker incarnation.      |
| **`seq`**           | Monotonic counter per `(self, peer)` direction; incremented inside the atomic Lua write.         |
| **Propagate stream**| A Redis sorted set on a worker's sidecar listing callRefs whose state needs the named peer to pull. |
| **Ready gate**      | Boot-time handshake that drains relevant propagate streams from peers before flipping `ready=true`. |

---

## 3. End-to-end picture

```
   ┌────────── Worker N (pod) ──────────┐         ┌────────── Worker B (pod) ──────────┐
   │                                    │         │                                    │
   │  Effect runtime (CallState, …)     │         │  Effect runtime (CallState, …)     │
   │            │                       │         │            │                       │
   │            │ writes via            │         │            │                       │
   │            ▼ AtomicWriter          │         │            │                       │
   │     ┌──────────────┐               │         │            │                       │
   │     │  Redis side- │               │         │     ┌──────────────┐               │
   │     │  car (in-mem)│               │         │     │  Redis side- │               │
   │     │              │               │         │     │  car (in-mem)│               │
   │     │ pri:N:call:* │               │         │     │ pri:B:call:* │               │
   │     │ bak:?:call:* │               │         │     │ bak:N:call:* │◀── populated  │
   │     │ idx:*        │               │         │     │ idx:*        │   by ReplPuller│
   │     │ propagate:B  │ ─── ZADD ─┐   │         │     │ propagate:N  │               │
   │     │ epoch:N      │           │   │         │     │ epoch:B      │               │
   │     └──────────────┘           │   │         │     └──────────────┘               │
   │            ▲                   │   │         │            ▲                       │
   │            │                   │   │         │            │                       │
   │     ReplLog HTTP (long-poll)◀──┘   │         │     ReplPuller (long-poll client)──┼──── HTTP ────┐
   │     GET /replog?caller=B&since=Y   │         │                                    │              │
   │                                    │         │                                    │              │
   └────────────────────────────────────┘         └────────────────────────────────────┘              │
                                                                                                      │
                                                          (B's puller GETs from N's ReplLog)──────────┘
```

Symmetric in the other direction: B has its own `propagate:N` stream that N's puller consumes from B.

---

## 4. Storage layout

Every worker N's sidecar holds the following key families. **Only N writes to N's sidecar.** Other workers read from it via the HTTP `/replog` endpoint that N's process serves; they never touch N's Redis directly.

| Key pattern                  | Type        | Lifetime                         | Purpose                                                                           |
|------------------------------|-------------|----------------------------------|-----------------------------------------------------------------------------------|
| `pri:N:call:{callRef}`       | string (JSON)| call-ttl while live; **`DELETE_RETENTION_SEC` (≈300 s) as tombstone after delete** | Authoritative copy for calls N is the cookie's primary on. **Source of truth.** |
| `bak:P:call:{callRef}`       | string (JSON)| call-ttl while live; tombstone retention on delete | N's backup-role copy of calls primary P owns. Read and written by N when N serves a request as backup (§10); never moved to N's `pri:`. |
| `idx:{indexKey}`             | string (callRef)| call-ttl; **DEL'd at delete-time** (NO tombstone — indexes are recoverable from the tombstone JSON if needed) | Index → callRef. Index keys come from `callIndexKeys()` in CallModel.ts. |
| `propagate:{peer}`           | sorted set  | sliding TTL on whole set         | "Hey peer, these callRefs of mine changed; come pull them." Member=callRef, score=seq. |
| `propagate_seq:{peer}`       | counter (INT)| sliding TTL                      | INCR'd inside the Lua script; produces the score for `propagate:{peer}`.         |
| `epoch:N`                    | string (INT) | persists for sidecar lifetime    | Worker process boot counter. Read from Lua, sent to consumers, drives full-resync. |
| `replpos:{peer}`             | hash         | persists for sidecar lifetime    | N's puller bookkeeping: `{epoch, lastSeq}` it last consumed from peer.           |

### 4.1 Why `idx:` is flat, not partitioned

Index keys come from `callIndexKeys(call)` ([src/call/CallModel.ts:715](../../src/call/CallModel.ts#L715)) — leg-tag pairs, b-leg call-IDs, dialog remote tags, optional callback context. Each *uniquely identifies* a single call by SIP-protocol construction (Call-ID + tag is dialog-unique per RFC 3261 §12). So a flat namespace is safe: there is never a scenario where the same `idx:` value should map to two different callRefs.

Index lookups happen on inbound SIP requests where the worker has only a Call-ID/tag and needs the callRef. Keeping the namespace flat lets the worker do a single `GET idx:leg:{callId}|{fromTag}` regardless of whether the call is one we own (`pri:`) or one we hold as backup (`bak:`).

### 4.2 The propagate sorted set

**Backup is optional.** The load balancer assigns `w_bak` per call at INVITE time
based on its own policy; for a call that the LB did not assign a backup to,
`_topology.bak` is undefined and the call is **single-copy** (only `pri:N:call:{ref}`
exists; nothing is replicated). Single-copy calls accept "if N dies the call dies"
as the loss class — the LB chose this on purpose (e.g. low-priority calls,
short-lived OPTIONS, capacity bias). Replication state machinery below applies
*only* when a peer is assigned.

`propagate:{peer}` uses `ZADD` with `score=seq, member=callRef`. ZADD on an existing member **updates the score in place**, not appending — this gives us automatic compaction. 50 writes to the same callRef result in *one* member with the latest seq. Memory grows with active calls, not with write rate.

The whole set has a sliding TTL bumped on every write (`EXPIRE propagate:{peer} long_ttl`). When the worker has had no calls in either direction with `peer` for the configured idle window, the whole set drops. This bounds the index of "peers I have any business with" without explicit cleanup.

### 4.3 How deletes propagate (short-TTL tombstone)

Deletes **are** announced in the propagate stream — same atomic Lua call as a put or refresh. The mechanism is a **short-lived tombstone** on the call key, not a hard `DEL`:

- At delete time, the Lua script overwrites `pri:N:call:{callRef}` with a tombstone JSON value (`{"_deleted": true, "indexes": [...the call's index keys at delete time]}`) and sets a short TTL `DELETE_RETENTION_SEC` (default ≈ 300 s).
- The same Lua `DEL`s every `idx:{key}` for that call (indexes don't need a tombstone — they are recoverable from the tombstone JSON's `indexes` field if a backup needs to clean its own index pointers).
- The same Lua does the standard `ZADD propagate:{peer}` so the backup's puller sees the change.
- After `DELETE_RETENTION_SEC`, the tombstone auto-expires; the periodic sweep removes the now-orphaned propagate entry.

**Why a finite tombstone retention works:**

If the backup pulls within `DELETE_RETENTION_SEC` (typical case — long-poll lag is sub-second), it dereferences the callRef, sees `_deleted: true`, removes its own `bak:P:call:{callRef}` plus the indexes listed in the tombstone JSON. Convergence within seconds.

If the backup is down for longer than `DELETE_RETENTION_SEC` and misses the tombstone, the assumption is that **the backup has restarted with an empty Redis sidecar by the time it returns**. In that case the backup's epoch will mismatch on its first pull, the `replpos` is reset to `(0, 0)`, and the puller does a full resync against the primary's *current* state — which no longer mentions the deleted call. The deleted call is simply absent from the resync set; nothing to do.

The `DELETE_RETENTION_SEC` is not chosen to cover hours-long downtime — it is the cooldown after which we assume "if the backup hasn't picked this up by now, it's gone and will full-resync on its way back." 5 minutes is a comfortable margin: well over the long-poll heartbeat cadence (10 s) and reconnect ceiling (25 s), small enough that orphaned tombstones don't accumulate.

**TTL alignment is still the safety net** for the case where the propagate-side delete genuinely doesn't reach the backup (network partition over the retention window, then backup recovers from disk after the partition heals): the backup's `bak:P:call:{callRef}` stops being refreshed when the primary stops writing, and expires within one call-TTL. No ghost survives long.

---

## 5. Atomic write path

Every state-changing operation on a call goes through one Lua script: `atomic_call_write.lua`. The script is the only place we touch `pri:`/`bak:` + `idx:` + `propagate:*` together. Sequential `SETEX` loops in `PartitionedRelayStorage.putCall` are removed by Slice 1.

### 5.0 Two script variants for the optional-backup case

Each mode (put / refresh / delete) has **two variants**:

- **`*_no_peer`** — call body + indexes only, no propagate side effects. Used when
  the call has no LB-assigned backup (`_topology.bak === undefined`). This is
  Slice 1's script unchanged.
- **`*_with_peer`** — call body + indexes + `INCR propagate_seq:{peer}` +
  `ZADD propagate:{peer} seq callRef` + `EXPIRE propagate:{peer} long_ttl`. Used
  when the call has a backup assignment.

The AtomicWriter API takes `peer?: string`. When absent, the no-peer script
runs; when present, the with-peer script runs. The seq/epoch return value is
also peer-conditional: undefined when there is no peer (no replication
sequence to advance).

### 5.1 Inputs

```
KEYS[1]   = call key             e.g. "pri:N:call:abc" or "bak:P:call:abc"
KEYS[2..K] = idx keys             e.g. "idx:leg:CID|tag", "idx:leg:CID2", ...
KEYS[K+1] = propagate set         e.g. "propagate:B"
KEYS[K+2] = propagate seq counter e.g. "propagate_seq:B"
KEYS[K+3] = epoch                 e.g. "epoch:N"

ARGV[1]   = mode                  "put" | "refresh" | "delete"
ARGV[2]   = ttl_seconds
ARGV[3]   = json (state)          (only for "put")
ARGV[4]   = callRef               (the value indexes point to)
ARGV[5]   = propagate_set_ttl     (sliding ttl on the whole set)
```

### 5.2 Output

```
[seq, epoch]    -- the seq used and the epoch witnessed; caller persists into Call._repl
```

### 5.3 Mode `put` (create or update)

```lua
local seq   = redis.call("INCR", KEYS[K+2])             -- propagate_seq:{peer}
local epoch = redis.call("GET",  KEYS[K+3])             -- epoch:N

redis.call("SETEX", KEYS[1], ARGV[2], ARGV[3])          -- call body
for i = 2, K do
  redis.call("SETEX", KEYS[i], ARGV[2], ARGV[4])        -- each idx → callRef
end
redis.call("ZADD",   KEYS[K+1], seq, ARGV[4])           -- ZADD propagate:{peer} seq callRef
redis.call("EXPIRE", KEYS[K+1], ARGV[5])                -- sliding TTL on whole set

return { seq, epoch }
```

### 5.4 Mode `refresh` (TTL bump on every key, no body rewrite)

Same shape but uses `EXPIRE` instead of `SETEX` and writes only the bumped `seq` (refresh is also a propagate event so the backup keeps its TTL parity).

### 5.5 Mode `delete`

```lua
local seq   = redis.call("INCR", KEYS[K+2])
local epoch = redis.call("GET",  KEYS[K+3])

-- Tombstone: short-TTL marker rather than DEL, so the puller can dereference
-- the propagate entry within DELETE_RETENTION_SEC and see the delete event.
redis.call("SETEX", KEYS[1], ARGV[6], ARGV[3])          -- tombstone JSON, ARGV[6]=DELETE_RETENTION_SEC
for i = 2, K do redis.call("DEL", KEYS[i]) end          -- indexes hard-deleted
redis.call("ZADD",   KEYS[K+1], seq, ARGV[4])
redis.call("EXPIRE", KEYS[K+1], ARGV[5])

return { seq, epoch }
```

`ARGV[3]` for delete mode is the tombstone payload — a small JSON `{"_deleted": true, "indexes": [...]}` carrying the index keys the call had at delete-time so the puller can clean its own `idx:` pointers without re-deriving them. `ARGV[6]` is the tombstone retention (default ~300 s; configurable as `DELETE_RETENTION_SEC`).

After `DELETE_RETENTION_SEC` the tombstone expires naturally; the periodic propagate-set sweep then removes the orphaned member (call key returns nil and seq is below the lowest active consumer ack low-water — see §6).

A backup whose downtime exceeds `DELETE_RETENTION_SEC` does **not** rely on this path: it has either re-fetched its `replpos` from a wiped sidecar (epoch mismatch ⇒ full resync from scratch) or is otherwise expected to reconcile via TTL alignment. See §4.3 for the rationale.

### 5.6 What atomicity guarantees

A single Lua script in Redis runs to completion before any other command on that Redis instance — this is unconditional Redis semantics. Therefore:

- **No reader on N's sidecar ever sees half-state.** Either the call body and all indexes and the propagate ZADD are visible, or none are.
- **The propagate ZADD cannot be lost while the local write succeeds.** This was the F4/F11 hole in the old fire-and-forget model; closed.
- **Sequence is monotonic per peer-direction** because `INCR` is a single atomic step within the same script.

The script runs in a single round-trip (`EVALSHA` after first invocation). Latency is bounded by the local socket to the sidecar — sub-millisecond on the typical K8s pod-local hop.

### 5.7 In-memory layer parity

`PartitionedRelayStorage.memoryLayer` is used by every fake-stack test. It must offer the same atomicity contract or tests would observe behaviours real Redis cannot produce. The memory layer wraps the equivalent operation in an `Effect.Mutex` per partition, executing the call/idx/propagate updates as one critical section. Tests assert no observer ever sees half-state.

---

## 6. Propagate stream lifecycle

A worked example, walking the whole life of one callRef's propagate entry.

```
T=0     Worker N receives initial INVITE for callRef X. Cookie says w_pri=N, w_bak=B.
        AtomicWriter("put", peer=B, ...) runs:
          INCR propagate_seq:B            -> seq = 17
          SETEX pri:N:call:X ttl=600 ...
          SETEX idx:leg:CID|tag ttl=600 ...
          ZADD  propagate:B 17 X
          EXPIRE propagate:B 3600
        Local view of propagate:B: { (X, 17) }

T=12    B's ReplPuller's long-poll connection (already open since B's boot) picks up
        the new entry. Server emits {seq:17, callRef:X, state:<json>}. B applies:
          AtomicWriter("put", peer=N, role="bak", owner=N, ...) on B's own sidecar.
          (B's seq counter for propagate:N moves; B's apply path replaces
           bak:N:call:X with the new state.)

T=42    Worker N receives a re-INVITE for X. AtomicWriter("put", peer=B, ...) again:
          INCR propagate_seq:B            -> seq = 23
          SETEX pri:N:call:X ttl=600 ...   (refreshed body + ttl)
          ZADD  propagate:B 23 X           (member X already exists; score 17 → 23)
        Local view of propagate:B: still { (X, 23) }. Compaction in action.

T=45    B picks it up (same long-poll), B's bak:N:call:X is overwritten with new state.

T=300   The call is updated 50 more times by re-INVITE/refresh-timer. Each time,
        propagate:B's member X is the same; only its score advances.
        Memory cost on N's sidecar: 1 sorted-set member, regardless of update count.

T=600   BYE arrives, AtomicWriter("delete", peer=B, ...):
          INCR propagate_seq:B            -> seq = 998
          SETEX pri:N:call:X DELETE_RETENTION_SEC=300 '{"_deleted":true,"indexes":[...]}'
          DEL idx:...
          ZADD propagate:B 998 X           (announces deletion)
          EXPIRE propagate:B long_ttl
        Local view: { (X, 998) }; pri:N:call:X is now a tombstone with 300 s TTL.

T=601   B picks up seq 998, dereferences -> GET pri:N:call:X returns the tombstone
        JSON. B's puller sees `_deleted:true`, runs AtomicWriter("delete", peer=N, ...)
        on its own sidecar to remove bak:N:call:X plus the indexes listed in the
        tombstone payload.

T=900   Tombstone expires (T=600 + 300 s). pri:N:call:X is now genuinely nil.
        Periodic sweep: walks propagate:B, finds (X, 998), GETs pri:N:call:X → nil,
        confirms 998 is below the lowest delivered_seq across active consumers,
        ZREMs the member.
```

ASCII state machine for one entry in `propagate:{peer}`:

```
                       ZADD on put / refresh
                       (score update, no new member)
                                │
                                ▼
   ┌────────────────────────────────────────────────────┐
   │  alive: member X with latest score;                │
   │  pri:…:call:X holds live JSON                      │
   └────────────────────────────────────────────────────┘
                │                                │
       BYE / delete                       sliding-set TTL elapses
       (Lua SETEX tombstone +              (no peer activity for hours)
        ZADD propagate)                            │
                ▼                                │
   ┌────────────────────────────────────────────┐│
   │  tombstoned: member X exists, call:X     ││
   │  is JSON `{_deleted:true,…}` with         ││
   │  DELETE_RETENTION_SEC TTL (~300 s)        ││
   └────────────────────────────────────────────┘│
                │                                │
       backup pulls within retention             │
        ▶ applies delete locally                 │
                │                                │
       OR retention elapses, tombstone TTLs out  │
                │                                │
                ▼                                │
   ┌────────────────────────────────────────────┐│
   │  orphaned: member X exists, call:X nil    ││
   └────────────────────────────────────────────┘│
                │                                │
      periodic sweep                             │
      (call:X is nil + seq                       │
       below low-water of consumer ack)          │
                │                                │
                ▼                                ▼
                ┌──────────── removed ────────────┐
                │  member dropped; if last member, │
                │  whole sorted set may TTL out    │
                └──────────────────────────────────┘
```

---

## 7. Pull protocol (long-poll)

### 7.1 Endpoint

`GET /replog?caller={callerOrdinal}&epoch={callerEpoch}&since={lastSeq}` on the primary's HTTP port (served by `ReplLog` in the same Node process as the SIP worker).

### 7.2 Server response framing

The response is an HTTP/1.1 chunked stream of newline-delimited JSON objects.

```
HTTP/1.1 200 OK
Content-Type: application/x-ndjson
Cache-Control: no-store

{"type":"hello","epoch":42,"head_at_open":12345}\n
{"type":"entry","seq":12346,"callRef":"abc","state":<json>|null}\n
{"type":"entry","seq":12347,"callRef":"def","state":<json>|null}\n
... (drain of pre-existing backlog above 'since') ...
{"type":"caught_up","at_seq":12345}\n
... (long-poll: server holds connection open) ...
{"type":"heartbeat","seq":12347}\n   <── every ~10 s when idle
{"type":"entry","seq":12348,"callRef":"ghi","state":<json>}\n
... (continues until 25 s max-age timeout, then server closes) ...
```

Client behaviour:

- `hello` arrives first. Client compares `epoch` to its stored `(peer, epoch, lastSeq)`. Mismatch → reset `lastSeq=0`, immediately re-open with `since=0`.
- `entry` updates `state` for `callRef`. `state=null` ⇒ delete locally. Client's stored `lastSeq` advances to `seq` after each successfully-applied entry.
- `caught_up` ⇒ client has reached the head as of connection-open. **For the ready-gate, this is the gating signal.**
- `heartbeat` ⇒ keep-alive, no state change.
- Connection close (max-age timeout, network error, or server going down) ⇒ client reconnects with `since=lastSeq`.

### 7.3 Re-entrancy

The protocol is idempotent: re-applying an entry whose `seq ≤ lastSeq` is a safe no-op (state matches, indexes match, TTL re-bumps). The client never has to track partial-application state. A pull that fails mid-entry just reconnects and re-reads the entry.

### 7.4 Steady-state latency

Server-side, a write on the primary fires an in-process Effect `Hub` notification that the open `/replog` handler is subscribed to. New entries land on subscriber connections within milliseconds. Lag in steady state is dominated by network RTT, typically ≤ 5 ms in-cluster.

---

## 8. Ready gate (boot handshake)

The `ReadyGate` service is what sits between worker process boot and `WorkerReadiness.markReady(true)`. K8s readinessProbe doesn't return 200 until ready=true, so the worker doesn't enter the Service ⇒ no SIP traffic lands.

### 8.1 Sequence on boot

```
1. EpochCounter:    INCR epoch:N                     -- bump to fresh value
2. PeerEnumerator:  resolve DNS SRV for headless StatefulSet
                    → list of K8s-Ready peers [P1, P2, P3, ...]
3. Read replpos:Pi for each Pi from local sidecar.
   Each entry is { epoch_we_saw_last, lastSeq } or absent (treat as {0, 0}).
4. For each Pi in parallel:
       open GET http://{Pi}/replog?caller=N&epoch={replpos.epoch}&since={replpos.lastSeq}
       read 'hello' → if epoch differs from stored, reset lastSeq=0, re-open with since=0
       capture HEAD_AT_OPEN_Pi from hello frame
       drain entries on this connection, applying each via AtomicWriter("put", ..., role="bak", owner=Pi)
       (also pulls our own primary calls back in if Pi was holding bak:N: copies for us)
       when we observe seq ≥ HEAD_AT_OPEN_Pi → mark Pi as 'synced'
       leave connection open for steady-state freshness
5. When all Pi are 'synced'  OR  30 s wall-clock has elapsed:
       set unreconciled = [Pi for Pi if not synced]
       persist replpos:Pi for each Pi (epoch + lastSeq we reached)
       WorkerReadiness.markReady(true)
6. Connections opened in step 4 keep streaming; no separate steady-state init.
```

### 8.2 What "synced with Pi" means precisely

At the moment N's GET response arrived, Pi's `propagate:N` head was at seq `HEAD_AT_OPEN_Pi`. N is "synced with Pi" the moment N's `lastSeq[Pi] ≥ HEAD_AT_OPEN_Pi`. New entries Pi writes after the GET opened are *also* streamed on the same long-poll, but they do not gate readiness — they are steady-state freshness. This makes the gate a finite, decidable target.

### 8.3 30-second ceiling

The hard ceiling exists because a partial cluster outage must not block the entire fleet from coming back. Without it, a single dead pod that DNS hadn't yet evicted could keep every other rebooting pod stuck.

A peer in the `unreconciled[]` list at gate completion has consequences:
- The metric `sipjsserver_ready_gate_unreconciled_count` is non-zero (operator alert).
- For every callRef where `_topology.bak == unreconciled-peer`, if a SIP request lands and the call is not in `pri:N:`, the worker emits `481 Call/Transaction Does Not Exist` (RFC 3261 §12.2.2) — same loss class as the existing `D14` reclaim-timeout-481 contract from the previous design.
- The puller loop continues to retry the unreconciled peer in the background; if it later comes back, the pull resumes naturally.

### 8.4 Brand-new pod (cold start)

If `epoch:N` doesn't exist (first sidecar boot ever), it is initialised to 1 by the Lua script the first time it runs. `replpos:Pi` is absent for every Pi (this is N's first pull from any peer). The gate runs the same way; with no historical data on N's side, every peer's drain is just whatever currently lives in their `propagate:N` set (typically nothing, since Pi has never had a relationship with N).

### 8.5 Bidirectional gate

The gate does not require N to push anything outbound. It is purely "drain peers' propagate:N streams." The reason: peers that were serving requests for N's primary calls during N's downtime wrote into their own `bak:N:` partitions and announced those writes on their own `propagate:N` (reverse-propagate, see §0 and §10.3). When N drains those, it picks up the back-edits. There is no asymmetry between "calls I owned" and "calls I held as backup" — both flow over the same propagate streams.

### 8.6 Peer-scan-bootstrap (post echo-removal)

The boot sequence in §8.1 assumed quiet-call recovery worked by cold-pulling `propagate:Pi->N` from `since=(0,0)` and replaying the gen=0 mirror entries that Pi's puller had previously echoed. Echo was removed in the slice tracked at [docs/plan/lets-plan-a-proper-crystalline-emerson.md](../plan/lets-plan-a-proper-crystalline-emerson.md) — it was both wire noise (warm pullers skip gen=0 by lex order) and a correctness bug (the update/delete crossing scenario could resurrect deleted calls). With echo gone, the channel no longer carries any history for calls Pi merely held as backup; only calls Pi originated for N during N's outage show up on the reverse channel.

The replacement is **peer-scan-bootstrap** (see [docs/plan/echo-removal-grill-me-smooth-parasol.md](../plan/echo-removal-grill-me-smooth-parasol.md)): on worker boot, before the puller fibers start, N scans each peer's `bak:N:call:*` partition directly via a streaming `GET /bootstrap?caller=N` endpoint and replays each entry into local `pri:N:call:*`. The bootstrap is a one-shot phase that runs once per worker incarnation against the K8s-Ready peer set at boot time; peers that appear later are picked up by the steady-state puller, not re-bootstrapped.

Updated boot sequence (replaces §8.1 for the steps marked NEW):

```
1. EpochCounter:    INCR epoch:N
2. PeerEnumerator:  resolve DNS SRV → [P1, P2, …] (frozen snapshot)
3. NEW: For each Pi in parallel, with an overall 30 s budget:
       GET http://{Pi}/bootstrap?caller=N
       Server reads `propagate:{Pi}->{N}.head` BEFORE its scan, then
       streams one Data frame per entry in its `bak:N:call:*` partition,
       then one terminal Noop carrying the recorded head.
       N replays each Data into local `pri:N:call:*` via the same
       atomic `applyReplicaUpdate` primitive the steady-state puller
       uses, then plants Noop.{gen,counter} as the per-peer puller's
       starting watermark.
       Per-peer transport-class failures retry once after a short
       backoff, then surface as outcome="error"; total wall time is
       capped by the 30 s overall budget.
4. Start the supervisor: per-peer puller fibers fork from their seeded
   watermarks (NOT from `(0,0)`), pulling deltas Pi has emitted since
   the bootstrap snapshot was taken.
5. ReadinessController flips WorkerReadiness once T_min has elapsed
   and every alive peer reports `everCaughtUp` (or T_max ceiling fires).
```

Key properties:

- **Bootstrap is one-way.** It is a pure read against each peer's bak partition; it does NOT write to N's outgoing propagate channel. The "no echo writes" invariant survives — verified by the lock-in test at [tests/replication/peer-scan-bootstrap.test.ts](../../tests/replication/peer-scan-bootstrap.test.ts).
- **Bootstrap is idempotent.** Re-running against unchanged peer state is a no-op: `applyReplicaUpdate` overwrites byte-identical content; no channel writes occur.
- **Head consistency.** Bootstrap captures the peer's channel head BEFORE scanning. Any write Pi emits during the scan window lands at a counter strictly greater than the recorded head; the puller picks it up post-bootstrap. Idempotent apply makes any double-cover (entry present in both scan and post-bootstrap delta) harmless.
- **Failure isolation.** Per-peer scan errors do not fail the boot effect; the bootstrap orchestrator emits per-peer `BootstrapResult` records and logs each outcome. Operators read `b2bua_replication_bootstrap_completed_total{peer,outcome=ok|timeout|error}` to spot peers that failed bootstrap.
- **Boot snapshot freeze.** The peer set used for bootstrap is the K8s-Ready snapshot at boot. Peers that flip alive AFTER the snapshot are not retroactively bootstrapped from; the puller's normal delta pull handles them. This matches the operator expectation that "boot finishes deterministically" — late-arriving peers can't extend the readiness window.

Observability counters (exposed via `/metrics` on the worker's status port):

```
b2bua_replication_bootstrap_started_total
b2bua_replication_bootstrap_completed_total{peer, outcome}
b2bua_replication_bootstrap_entries_imported_total{peer}
b2bua_replication_bootstrap_duration_ms{peer}
```

Configuration: `REPLICATION_BOOTSTRAP_TIMEOUT_MS` (default 30000) controls the overall budget.

---

## 9. Primary-side signaling walk-through

This section walks every SIP message type for a call where the local worker N is the call's primary (the cookie's `w_pri` matches N).

### 9.1 Initial INVITE

```
Inbound INVITE arrives at N.
  ↓
Front proxy has stamped Record-Route: ;w_pri=N;w_bak=B;v=2;…;sig=…
SipRouter.withCall reads parseStickinessCookie → { pri:N, bak:B }.
  ↓
Worker creates Call object (CallModel.ts): callRef = digest(aLeg.callId + aLeg.fromTag).
Sets call._topology = { pri:N, bak:B, gen:0 } (topology stays in JSON for backward compat
through Slices 1–4; gen will be replaced by _repl.{epoch,seq} in Slice 6).
  ↓
Rules execute, decision returned, b-leg constructed.
  ↓
CallState.flushToRedis kicks in:
  AtomicWriter.write({
    role:    "pri",
    owner:   N,
    callRef,
    json:    JSON.stringify(call),
    indexes: callIndexKeys(call),  // leg:CID|tag, leg:bCID|btag, etc.
    peer:    B,                    // _topology.bak
    ttlSec:  config.callTtlSec,
  })
  ↓
Lua script atomically:
  - SETEX pri:N:call:{callRef} ttl json
  - SETEX idx:leg:{aCID}|{atag} ttl callRef
  - SETEX idx:leg:{bCID}|{btag} ttl callRef
  - INCR  propagate_seq:B → seq
  - ZADD  propagate:B seq callRef
  - EXPIRE propagate:B long_ttl
returns (seq, epoch). Call._repl.{writerEpoch,writerSeq} updated for next reconcile.
  ↓
B's open long-poll picks up the entry. B's ReplPuller does its own AtomicWriter on B's
sidecar, role="bak", owner=N, writing bak:N:call:{callRef} + idx + own propagate:N entry.
```

Steady-state replication latency: typically < 10 ms in-cluster.

### 9.2 In-dialog request (re-INVITE / UPDATE / INFO / REFER / NOTIFY)

The proxy decodes the cookie, sees `w_pri=N`, forwards to N. Worker hydrates the call from `pri:N:call:{callRef}` (or via `idx:` lookup if only the leg headers are known). After rule processing:

```
Mutated Call → AtomicWriter.write(...) — exactly the same path as 9.1.
seq advances on propagate:B; B's puller receives the new state.
```

### 9.3 Refresh-timer fire

Calls that are confirmed but otherwise idle still need TTL to be bumped on both sides, otherwise the backup's `bak:N:call:{callRef}` would expire while the call is still live. The refresh timer is already scheduled by `CallLimiter` / framework code; the change is that its handler now calls `AtomicWriter.write(mode="refresh", ...)` which:

- Bumps TTL on `pri:N:call:{callRef}` and every index.
- INCRs propagate_seq:B and ZADDs `propagate:B` (compacted; same member).
- EXPIRES `propagate:B` (sliding).

The puller on B receives the bumped seq, applies a refresh on `bak:N:call:{callRef}`. TTL parity is maintained.

### 9.4 BYE

```
BYE arrives → rules drive Call.state = "terminating" → eventually "terminated".
The terminal flush calls AtomicWriter.write(mode="delete", peer=B, ...):
  - SETEX pri:N:call:{callRef} DELETE_RETENTION_SEC '{"_deleted":true,"indexes":[…]}'
  - DEL every idx:{key}
  - INCR propagate_seq:B → seq
  - ZADD propagate:B seq callRef
  - EXPIRE propagate:B long_ttl
B's puller receives the entry, GETs callRef on N's storage view → tombstone JSON,
applies a corresponding delete on bak:N:call:{callRef} + indexes (using the
indexes list embedded in the tombstone).
```

If B is unreachable when the BYE happens but reconnects within `DELETE_RETENTION_SEC` (~5 min), B picks up the tombstone on its first pull and converges normally. If B's downtime exceeds the retention, the tombstone has expired by the time B returns — but in that case B has restarted with a fresh sidecar (assumption: no Redis persistence means a multi-minute outage almost always means a sidecar restart), epoch mismatches, and the puller does a full resync against N's *current* state which simply doesn't include the deleted call. Either way the backup converges; nothing relies on the tombstone being available indefinitely.

### 9.5 ACK on 2xx / CANCEL

These are exempt from the drain-grace window (per resilience-model.md §1) — they always go to the original worker. From the cache POV they are normal in-dialog writes (ACK transitions the leg to confirmed; CANCEL terminates an in-flight INVITE). Same `AtomicWriter.write` path as 9.2.

---

## 10. Backup-side signaling walk-through

This is the path executed when SIP traffic for a call lands on a worker that is *not* the call's primary. This happens when:

- The original primary is dead/draining-post-grace and the proxy fell back via `selectForNewDialog`.
- The cookie was lost or rejected and the proxy rerouted to a fresh worker.

In either case the receiving worker R consults its sidecar:

### 10.1 Hydration

```
SipRouter.withCall first does an idx: lookup using the inbound dialog identifiers
(typically idx:leg:{Call-ID}|{tag}). Returns a callRef.
  ↓
GET pri:R:call:{callRef}  → null (R is not primary).
GET bak:?:call:{callRef}   ← needs to find the right partition; R scans
                            its own sidecar's bak:*:call:{callRef} keys (cheap
                            because the keyspace partition is named).
  ↓
If found: R has a backup copy.  Decode → Call object with _topology.{pri:P, bak:R}.
If not found: 481 Call/Transaction Does Not Exist (RFC 3261 §12.2.2) — hydration miss.
```

### 10.2 Whether to serve

R has to decide whether to *serve the request as backup* (read the call from `bak:P:`, run rule processing, write the updated state back to `bak:P:`) or refuse with `481`.

The rule is straightforward:
- If R's view of the cluster says P (the call's original primary, per `_topology.pri`) is **not K8s-Ready** (not in DNS enumeration), R serves the request from `bak:P:`.
- If P is K8s-Ready, R refuses (`481`). The proxy should not have routed here; the assumption is transient (cookie lost / DNS races) and the UAC retry will land on P.

This decision is encapsulated in the `RouterPolicy` layer and is unchanged from the previous design — the cache mechanism doesn't influence it.

**§0 reminder:** R does not become the new primary. P remains the call's primary by cookie; R is processing on P's behalf while P is unreachable.

### 10.3 Backup-served write

When R serves the request from `bak:P:`, rule processing runs as normal; the resulting Call must be flushed back. R's flush uses the same AtomicWriter, but with crucial role/peer differences:

```
AtomicWriter.write({
  role:    "bak",     // R writes into bak:P:call:{callRef}, NOT pri:R:
  owner:   P,         // The original primary, per _topology.pri
  callRef,
  json:    JSON.stringify(updatedCall),
  indexes: callIndexKeys(updatedCall),
  peer:    P,         // R announces to P (so P recovers on its restart)
  ttlSec:  config.callTtlSec,
})
```

Two invariants this preserves:

- **D16 (load-bearing — see §0)**: The primary partition `pri:P:call:{callRef}` is NEVER written by anyone but P. R writes to `bak:P:call:{callRef}` even when R is the worker physically processing the SIP request. The cookie's `w_pri` permanently names "where this call's primary copy lives" if it's anywhere; there is no race for primary rights.
- **Reverse-propagate**: R announces the write into its own `propagate:P` set. When P comes back, P's ReadyGate drains `propagate:P` from R, picks up the entries written while P was down, and merges them into P's own `pri:P:call:{callRef}` via gen comparison (`_repl.writerEpoch / writerSeq`).

### 10.4 What if R never takes over?

Pure-backup R (whose `bak:P:call:*` is just sitting there, no SIP request has hit) does *no* SIP-driven writes. The puller is the only thing keeping `bak:P:call:{callRef}` fresh — every `put`/`refresh`/`delete` from P flows through `propagate:P` → R's puller → R's AtomicWriter on R's own `bak:P:` partition. The backup copy lives or expires entirely under TTL alignment.

---

## 11. Recovery walk-throughs

### 11.1 Worker process restart, sidecar persists

This is the common case (the worker container crashes and K8s restarts the same pod; the colocated Redis sidecar pod stays up).

```
Before crash:  N has pri:N:call:* populated; epoch:N=42; replpos:Pi entries from puller.
N crashes (process death). Sidecar untouched.
  ↓
K8s restarts the worker container. Process boot:
  EpochCounter: INCR epoch:N → 43.
  ReadyGate runs (§8.1).
  PeerEnumerator finds Pi peers.
  For each Pi:
    GET /replog?caller=N&epoch=<replpos.epoch>&since=<replpos.lastSeq>
    Pi's hello: epoch=Pi's_epoch, head_at_open=...
    Drain entries above replpos.lastSeq (which captures what we missed during downtime).
  All peers synced or 30 s elapsed → ready=true.
  ↓
Steady state resumes. SIP traffic flows.
```

Key points:
- N's own `pri:N:call:*` data is preserved in the sidecar across the worker process crash. N does not need to re-hydrate its own primary calls from peers; they were already on disk, still valid TTL-wise.
- N **does** need to drain peers because while N was down, peers' backup-served writes (if any) accumulated in their `propagate:N` streams. Those entries contain the *latest* state for calls N owned where another worker served the request on N's behalf.
- Conflict resolution: if both N's local `pri:N:call:X` (pre-crash) and a backup-served entry from peer R exist, the one with higher `(epoch, seq)` wins. Since R's write happened *after* N's crash, R's epoch/seq pair is strictly newer than N's pre-crash pair. (No ownership conflict — see §0; R never claimed primary.)

### 11.2 Worker pod restart with Redis sidecar wiped

Less common but expected (full pod replace, sidecar pod also recreated, `emptyDir` volume cleared). Post echo-removal, this scenario relies on peer-scan-bootstrap (§8.6) — `propagate:Pi->N` no longer carries gen=0 mirrors for calls Pi merely held, so a cold-pull from `since=(0,0)` would miss the quiet ones.

```
Before: N had pri:N:call:*, epoch:N=42.
Pod replaced. Sidecar fresh, no keys.
  ↓
Process boot:
  EpochCounter: epoch:N missing → set to 1. NEW epoch.
  Peer-scan-bootstrap (§8.6):
    PeerEnumerator finds Pi peers — frozen at boot snapshot.
    For each Pi in parallel (30 s overall budget):
      GET /bootstrap?caller=N
      Server records `propagate:Pi->N.head` AT scan start, then
      streams every entry from `bak:N:call:*`, then terminal Noop.
      N applies each Data into local `pri:N:call:*` via
      applyReplicaUpdate; plants the Noop head as Pi's puller
      watermark.
  Steady-state pullers fork at the seeded heads.
  ReadinessController flips ready=true once T_min elapsed +
    every alive Pi reports everCaughtUp.
  ↓
N's pri:N:call:* is repopulated from peers' bak: copies.
```

Two failure modes worth calling out explicitly:

1. **Quiet calls owned by a peer that fails bootstrap** stay missing until that peer's puller catches up to a write Pi emits FOR those calls — for genuinely quiet calls (no further activity), this means they remain absent in N's `pri:N:` and a BYE arriving on one of them returns 481 until Pi recovers. This is the same loss class as the previous design's "unreconciled peer at ready-gate completion."
2. **Bootstrap timeout** (peer unresponsive past the 30 s budget) — the worker proceeds to ready=true with the partial state imported so far. Operators monitor `b2bua_replication_bootstrap_completed_total{outcome=timeout}` to size the budget against the largest expected `bak:N:` partition.

The crucial property is unchanged: even with a wiped sidecar, the *active* calls survive because peers held them. The mechanism that retrieves them is now the explicit `/bootstrap` scan rather than the deprecated reverse-channel cold-pull.

### 11.3 Long downtime (hours)

```
Before: N has 1000 active calls. Goes down (rolling upgrade, infra event, etc.).
N is down for 2 hours.
During downtime:
  - N is gone, so peers cannot pull from N. N's own pri:N:call:* and propagate:*
    sets continue to TTL-decay if the sidecar survives, or are absent entirely
    if the sidecar was wiped on pod restart.
  - 800 of N's calls receive BYE during the 2 hours. The other workers
    that served those BYEs as backup write tombstones into their own
    bak:N:call:* (which they hold on N's behalf, see §0). Those tombstones
    TTL out well before N returns — only ~300 s of retention each.
    Peer-side propagate:N entries for those 800 calls were live for the
    tombstone window then GC'd by sweep. 2 hours later, none of these
    calls leave any artifact anywhere.
  - 200 calls are served as backup by peer R. R writes the latest state to
    bak:N:call:* on R's side and ZADDs propagate:N on R's side so N can
    recover the state on its eventual restart. Those entries are alive
    throughout the downtime because R's writes keep refreshing them.
  ↓
N comes back. Sidecar may or may not be wiped; same path either way.
ReadyGate runs. Drains propagate:N from each Pi.
  Most propagate:N entries from when N was up have TTL'd out (sliding TTL on
  the whole sorted set; if Pi had no calls in either direction with N for hours,
  Pi's propagate:N may be gone entirely).
  Active entries: the 200 calls R served as backup. Those are propagated back to N.
  ↓
After ready: N has 200 calls in pri:N:call:* (rebuilt from the entries R wrote
into propagate:N while N was down — see §0 reverse-propagate). The 800 BYE'd
calls are gone everywhere — exactly as desired.
  ↓
Steady state: N continues primary duty for the 200 surviving calls (which it
always owned, per cookie), with R holding them as backup again per the same
cookie.
```

The design's cardinal property — *the propagate stream is bounded by active calls, not by event history* — is what makes 2-hour downtimes tolerable. There is no replay log to grow during the outage.

### 11.4 Bidirectional restart (both sides of a buddy pair)

The worst-case scenario for any per-pair HA: both N and B (some buddy pair) go down at the same time, neither can hold backup for the other.

```
Before: N has calls X, Y, Z with bak=B. B has the bak: copies.
Both N and B go down at ~T=0. Neither's sidecar holds anything for the
peer (they're both rebooting).
  ↓
N comes back at T=10. ReadyGate runs:
  PeerEnumerator: B is not in DNS yet (still rebooting). Pi list excludes B.
  For all other Pi: drain their propagate:N. Likely empty since N had no
  business with them for these calls.
  After 30 s ceiling (or sooner if all Pi drained): ready=true.
  unreconciled[] possibly contains B if B isn't back yet.
  ↓
N starts answering SIP. For calls X, Y, Z if a request hits N:
  GET pri:N:call:X → empty (N's sidecar fresh; X's data was at B).
  GET bak:?:call:X → empty.
  → 481 Call/Transaction Does Not Exist.
  ↓
B comes back at T=40. ReadyGate runs on B's side; drains propagate:B from Pi.
B picks up nothing for X, Y, Z either.
  ↓
Calls X, Y, Z are LOST. Loss class F4/F11 from the prior design — accepted
because the alternative (block ready until B is back, which could be forever)
is worse for cluster availability.
```

This is the single accepted loss class in the new design, identical to the prior design's accepted loss. Rate is bounded by the probability of two specific pods going down within a recovery window; in production this corresponds to AZ-level events.

---

## 12. Loss class enumeration

| ID  | Scenario                                                 | Loss bound                                                                              | Mitigation                          |
|-----|----------------------------------------------------------|-----------------------------------------------------------------------------------------|-------------------------------------|
| L1  | Primary process crash mid-INVITE before flush            | The current INVITE state. UAC's Timer A retransmits; if the recovered/replacement worker has nothing, 481. | Fast restart + replication latency. |
| L2  | Primary process crash before AtomicWriter("delete") is called | Backup never sees the tombstone announcement. Backup's `bak:` copy refreshes stop, expires within one call-TTL. (Crash *during* the Lua call cannot leave a half-state — Redis script atomicity.) | TTL alignment fall-back.            |
| L3  | Both primary and backup down for a single call's TTL window | Call lost. F4/F11 accepted.                                                            | None. AZ-level concern.             |
| L4  | Long-poll TCP drop, immediate reconnect                  | None — re-entrant resume from `lastSeq`.                                                | Built-in.                           |
| L5  | Long-poll TCP drop, reconnect delayed by N seconds       | Backup sees state up to N seconds stale.                                                | Heartbeat + reconnect monitoring.   |
| L6  | Backup's sidecar wiped while primary up                  | Backup re-fetches from primary on next pull (epoch advance triggers full resync).        | Built-in.                           |
| L7  | Primary's sidecar wiped while primary up                 | Epoch advances; backups detect and re-replicate primary's state from THEIR backup copy. ReadyGate handles it. | Built-in.                           |
| L8  | Network partition between primary and backup             | Both sides advance independently. On heal, propagate streams converge. Conflict resolution by `(epoch, seq)`. | Gen-based reconciliation.           |
| L9  | Two peers concurrently serving a request as backup       | Should not happen — `_topology.bak` is per-call and unique, and the proxy only routes to one backup. If it does (cookie tampering, bug), `(epoch, seq)` resolves. Neither becomes primary; both write to `bak:{w_pri}:`. | Unique cookie + asserted in tests.  |
| L10 | Lua script runtime error                                 | Write fails; CallState.flushToRedis surfaces the error; rule processing fails the request. | Tests + metric `repl_lua_eval_total{outcome=err}`. |
| L11 | Periodic GC removes a propagate entry mid-pull           | The pull might miss a member that was just deleted. Acceptable: that means the call is gone; the puller would have applied a delete anyway. | GC only removes when call:{ref} is null AND below all consumer ack low-water. |

---

## 13. RFC and source cross-references

| Reference                                                                | Used for                                                                  |
|--------------------------------------------------------------------------|---------------------------------------------------------------------------|
| RFC 3261 §12 (Dialog)                                                    | Call-ID + tag uniqueness justification for flat `idx:` namespace          |
| RFC 3261 §12.2.2 (481 Call/Transaction Does Not Exist)                   | Hydration miss + ready-gate-ceiling fallback semantics                    |
| RFC 3261 §13 (INVITE behaviour, Timer C)                                 | TTL choice; K8s `terminationGracePeriodSeconds` ≥ 200 s                   |
| RFC 3261 §17 (Transaction layer)                                         | ACK/CANCEL must hit original worker — backup-side hydration considerations |
| [`docs/sip-front-proxy/resilience-model.md`](../sip-front-proxy/resilience-model.md) | Per-message-type behaviour in front of this layer                         |
| [`docs/CallModel.md`](../CallModel.md)                                   | Call/Leg/Dialog structure being persisted                                 |
| [`docs/todos/TODO_doubleWrite.md`](../todos/TODO_doubleWrite.md)         | Historical D7/D9/D14/D16 decisions; this doc supersedes the model         |
| [`src/call/CallModel.ts:715`](../../src/call/CallModel.ts#L715)          | `callIndexKeys()` — index keys this layer SETEXes                         |
| [`src/cache/StickinessCookie.ts`](../../src/cache/StickinessCookie.ts)    | Cookie → `_topology.{pri,bak}` derivation                                  |

---

## 14. What changes from the previous (D-prefixed) design

| Previous (Slices 1–6 of `TODO_doubleWrite.md`)               | This refactor (Slices 0–6 of `data-replication-layer-refactor`) |
|--------------------------------------------------------------|--------------------------------------------------------------|
| Dual-write fan-out via `Effect.forkChild` HTTP push           | Pull-based long-poll consumed by backup                      |
| `_topology.gen` bumped per flush, lives in JSON               | Replaced by `_repl.{writerEpoch, writerSeq}` produced by Lua |
| Sequential `SETEX` loop in `putCall`, accepted F10            | Single Lua, atomic across call+idx+propagate                 |
| `ReclaimRunner` scans every peer's `bak:N:` partition         | `ReadyGate` drains `propagate:N` from each peer              |
| `PeerCacheClient` + `PeerRelay` HTTP push API                 | Deleted; replaced by `ReplLog` server + `ReplPuller` client  |
| Push-side fanout in `CallState.fanOutPut/fanOutDelete`        | Deleted; CallState writes only locally via AtomicWriter      |
| No Prometheus metrics on per-peer drift                       | Required in Slice 3 (`repl_delay_seq{peer}` etc.)            |

---

## 15. Status tracking

| Slice | Description                                                    | Status      | PR / Notes                       |
|-------|----------------------------------------------------------------|-------------|----------------------------------|
| 0     | This document                                                  | DRAFT v1    | Awaiting review before Slice 1.  |
| 1     | AtomicWriter + Lua (call+idx; no propagate)                    | not started |                                  |
| 2     | PropagateStream + extend Lua + EpochCounter                    | not started |                                  |
| 3     | `/replog` long-poll service + ReplLog + Prometheus `/metrics`  | not started |                                  |
| 4     | ReplPuller client + steady-state replication                   | not started |                                  |
| 5     | ReadyGate replaces ReclaimRunner                               | not started |                                  |
| 6     | Delete legacy push-side; tidy CallState                        | not started |                                  |

This table is the source of truth for slice status. Each slice's PR updates the row and any sections this document needs to reflect implementation reality.

---

## 16. Restriction: backup does not fire timers

The §0 single-owner invariant has a corollary that is invisible at write time but matters every time the primary worker pod restarts:

- **Backup never fires SIP timers.** OPTIONS keepalive, `keepalive_timeout`, `limiter_refresh`, `no-answer`, REFER timers — all of these are scheduled by `TimerService` on the call's primary worker, and only there. `bak:{primary}:call:{ref}` carries the serialized `TimerEntry[]` for crash recovery, but the backup worker does not respawn fibers from it. Doing so would mean two workers concurrently driving the same call's timer-side state machine, breaking single-owner.
- **Recovery is primary-side only.** When the primary returns, its boot path runs `SipRouter.rehydrateOwnedCalls` (see [src/sip/SipRouter.ts](../../src/sip/SipRouter.ts)), which `loadOwnedCalls` walks the local `pri:{self}:` partition (already merged with the peer's reverse-propagate stream by `ReadyGate`) and `restoreFromEntries` respawns timer fibers for every persisted `TimerEntry`. Timers whose `fireAt` is in the past fire immediately on respawn (warning logged). For SIP messages received during the outage there is no synthetic re-issue — what the backup served via `decode_forward_backup` is what the cluster did, and that's what gets merged back.
- **Operational consequence: primary restart must complete within `callContextTtlSec`.** Default `callContextTtlSec = keepaliveIntervalSec * 2`. Past that, the `bak:{primary}:` copy TTL-expires on the backup's sidecar and the call is unrecoverable. The K8s `terminationGracePeriodSeconds ≥ 200s` budget (see §1) keeps in-INVITE calls; for established calls, the practical bound is `2 × keepaliveIntervalSec` (15 minutes default).
- **During the outage window, remote endpoints receive no keepalive pings.** If a remote user agent terminates the dialog locally on keepalive failure, the call may be torn down on that endpoint before the primary returns. There is no way to mask this from the remote side without breaking single-owner.
- **Future work: REGISTER and similar long-lived flows where tick cadence is shorter than typical restart time will need backup-side timer firing.** That breaks §0 in its current shape and is tracked separately — the design will need an explicit takeover model with epoch-fenced ownership transfer rather than the current "primary always recovers itself" path.
