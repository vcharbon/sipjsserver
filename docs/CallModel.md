# Call Model

A SIP call comprises multiple legs, each with its own internal state. At any given time there is always at least one dialog per active leg.

> **Termination paths and responsibility split**: see
> [docs/leg-termination-model.md](leg-termination-model.md) for the contract
> between TransactionLayer / Rule / Framework / orphan sweep, the
> `byeDisposition` state machine, and the framework invariant that prevents
> calls getting stuck in `terminating`.
>
> **REFER and the always-200-OK rule**: see
> [docs/external-usage/refer-and-sipfrag.md](external-usage/refer-and-sipfrag.md)
> for the consumer-facing contract — REFER is always answered with 200
> OK at the SIP layer, and transfer-failure semantics travel via
> NOTIFY sipfrag, not as 4xx-on-REFER.

The internal representation must model:
- **Standard call**: one Alice leg + one Bob leg
- **Call forward**: one Alice leg, a first busy Bob1 leg attempt, then a Bob2 connected leg
- **MRF integration**: Alice, pre-call announcement leg, then call to Bob
- **REFER/transfer**: B2BUA sends call to Charlie via re-INVITE, NOTIFY to Alice, disconnect Bob — including legs the B2BUA did not originate

A leg can have multiple early SIP dialogs during establishment (forking). Once a leg is confirmed, exactly one dialog survives and all subsequent messages are relayed with correct CSeq and tag mapping.

## Call Control API

[API schemas](../src/http/CallControlSchemas.ts) are used by the external SIP Application Server. The B2BUA core is stateless for routing — all routing decisions come from the HTTP API.

| Endpoint | When called |
|----------|------------|
| `POST /call/new` | On initial INVITE |
| `POST /call/failure` | When a b-leg attempt fails (rejection, timeout, limiter) with callback context |
| `POST /call/refer` | On REFER request (future) |

## Data Model (Effect Schema)

Three-level hierarchy: **Call → Leg → Dialog**.

### Call

Top-level container for the entire call.

```typescript
Call {
  callRef: string               // deterministic: derived from aLegCallId + aLegFromTag
  aLeg: Leg
  bLegs: Leg[]                  // ordered by attempt ("b-1", "b-2", ...)
  activePeer: { legA: string; legB: string } | null  // 1<->1 peering or unpeered
  tagMap: TagMapping[]           // maps B2BUA-generated a-facing tags to b-leg real tags
  callbackContext?: unknown      // opaque context from /call/new response
  limiterEntries: CallLimiterState[]
  timers: TimerEntry[]           // serializable timer intents (not runtime fibers)
  cdrEvents: CdrEvent[]
  state: "active" | "terminating" | "terminated"
  createdAt: number              // epoch ms
  ext?: Record<string, unknown>  // per-service opaque ext slices, keyed by service id
}
```

- **`callRef`** is embedded in the Contact header on relayed 200 OK so mid-dialog messages are self-routing even after crash recovery.
- **`ext`** holds per-callflow-service state, keyed by service id, **opaque to core** (carried through the codec, never interpreted). Each [[callflow service]] owns the Encoded (JSON-safe) shape of its slice; the rule framework decodes `ext[id]` via the service's schema before matching and re-encodes the returned slice on write. Presence of a key activates the owning service. See [ADR-0016](adr/0016-callflow-services-typed-ext.md).
- **`activePeer`** is the source of truth for "who is Alice currently talking to". Structurally enforces 1<->1 or unpeered (null) — N<->N is not representable. Set by `merge` action, cleared by `split`.
- **`tagMap`** maps B2BUA-generated tags (shown to Alice) to real b-leg remote tags. Used for dialog resolution during early dialog (forking), before `activePeer` is set.
- **`state`** lifecycle: `active` → `terminating` (BYE/CANCEL sent to live legs) → `terminated` (all legs resolved). Framework auto-promotes from `terminating` to `terminated` when `isFullyResolved()` is true.

### Leg

Represents one SIP leg direction. Each b-leg attempt gets its own Leg.

```typescript
Leg {
  legId: string                 // "a", "b-1", "b-2", ...
  callId: string                // SIP Call-ID for this leg
  fromTag: string
  source: { address: string, port: number }
  state: "trying" | "early" | "confirmed" | "terminated"
  disposition: "pending" | "bridged" | "cancelling" | "rejected"
  byeDisposition?: "bye_sent" | "bye_received" | "bye_timeout" | "cancelled"
  dialogs: Dialog[]             // multiple during early state (forking)
  noAnswerTimeoutSec?: number   // per-leg, from /call/new response
  ext?: Record<string, unknown> // per-service opaque ext slices, keyed by service id
}
```

- **`ext`** is the per-leg analogue of `Call.ext` — opaque per-service state keyed by service id (e.g. a service stamps `leg.ext[id] = { role: "media" }` via `set-leg-ext`). Decoded/typed at the rule layer; carried opaquely by core. See [ADR-0016](adr/0016-callflow-services-typed-ext.md).

**Leg state machine:**
```
trying ──→ early ──→ confirmed ──→ terminated
  │          │                        ▲
  │          ├────────────────────────┘  (cancel/rejection)
  └──────────┴────────────────────────┘  (immediate failure)
```

**Disposition** tracks B2BUA intent, independent of SIP dialog state:
- **`pending`**: INVITE sent, waiting for outcome (fork targets live here)
- **`bridged`**: 200 OK received, actively connected to Alice
- **`cancelling`**: B2BUA wants this leg gone (reroute, losing fork, transfer complete). Handles CANCEL/200 race: if 200 OK arrives while cancelling, ACK then BYE.
- **`rejected`**: Leg received a final non-2xx response.

**byeDisposition** tracks how a leg was resolved during the terminating phase. Used by `isFullyResolved()` to determine when all legs are done:
- **`bye_sent`**: BYE sent and confirmed (200 OK received)
- **`bye_received`**: Remote sent BYE
- **`bye_timeout`**: Safety timer expired before BYE confirmation
- **`cancelled`**: CANCEL sent/received during early dialog

**Generated To-tag on b-legs** encodes the legId so incoming b-leg responses/requests identify which leg they belong to without an index lookup.

### Dialog

Within a leg, tracks a single SIP dialog (identified by remote To-tag).

```typescript
Dialog {
  toTag: string
  contact: string               // remote Contact URI
  localCSeq: number             // next CSeq we send on this leg
  remoteCSeq: number            // last CSeq received on this leg
  lastInviteCSeq?: number       // CSeq of most recent INVITE (for ACK-for-2xx)
  inboundPendingRequests: PendingRequest[]  // snapshots for transparent-relay response correlation
  routeSet: string[]            // Record-Route set
  ackBranch?: string            // Via branch of first ACK for the 2xx (re-ACK reuse)
}
```

**CSeq rewriting**: the B2BUA owns the CSeq space on each leg. When relaying a request, CSeq is replaced with the next value from the outbound leg's `localCSeq`. The `inboundPendingRequests` list correlates responses back to the original sender's CSeq and headers — one entry per in-flight transparently-relayed request (re-INVITE, OPTIONS, INFO, UPDATE, MESSAGE, PRACK). Required for correct response rebuilding (original Vias/From/To/Call-ID/CSeq per RFC 3261 §8.1.3.3) and for REFER scenarios where legs are not originated by the B2BUA.

### TimerEntry (serializable)

```typescript
TimerEntry {
  id: string
  type: "no_answer" | "global_duration" | "limiter_refresh"
       | "keepalive" | "keepalive_timeout" | "terminating_timeout"
  fireAt: number                // epoch ms — absolute deadline
  legId?: string                // undefined = call-level timer
}
```

- **`keepalive_timeout`**: Fires if an in-dialog OPTIONS keepalive gets no response. Triggers call termination.
- **`terminating_timeout`**: 64-second safety timer scheduled when `begin-termination` fires. Forces all unresolved legs to `byeDisposition: "bye_timeout"` if BYE confirmations never arrive.

Runtime `Effect.Fiber` handles are kept in a separate in-memory-only structure keyed by timer ID — never serialized. On crash recovery, `TimerEntry` records are read from Redis, remaining delay is recomputed, and new fibers are spawned.

Retransmit timers are ephemeral (local scope only, never serialized). If a node crashes mid-retransmit, the remote side treats it as a new transaction.

### CallLimiterState

```typescript
CallLimiterState {
  limiterId: string
  limit: number
  originWindow: number          // rounded timestamp when this call's count was INCRed
}
```

The `originWindow` is stored so the correct Redis key is decremented on call termination or migrated on refresh.

### CdrEvent

```typescript
CdrEvent {
  type: "invite_received" | "invite_sent" | "provisional" | "answer"
       | "bye" | "cancel" | "timeout" | "reject"
  timestamp: number
  legId: string
  statusCode?: number
  reason?: string
}
```

On call termination, the full `cdrEvents` array is written as a single JSON line to the CDR file.

## Sequential Processing

Messages on the same call must never be processed in parallel. A local `Effect.Semaphore(1)` per callRef ensures sequential processing.

**Sequence:**
1. Acquire semaphore for callRef
2. Process message, update in-memory call state
3. Release semaphore (next message can start immediately against updated in-memory state)
4. Async flush to Redis
5. Remove from in-memory map only after Redis write confirms

No distributed lock is needed — the load balancer guarantees call affinity. Multi-node processing only occurs on crash, which is handled by Redis state recovery.

## Redis Persistence

### Library

ioredis wrapped in an Effect `Layer.scoped` service (connect on acquire, disconnect on release).

### Key Structure

```
{prefix}:call:{callRef}              → JSON serialized Call
{prefix}:leg:{callId}|{tag}          → callRef (SIP-facing index)
{prefix}:ctx:{callbackContext}       → callRef (HTTP callback index)
{prefix}:limiter:{id}:{window}       → count (with TTL)
```

### Flush Lifecycle

| Event | Action |
|-------|--------|
| After `/call/new` HTTP response | Flush initial call state (guarantees tracking during establishment) |
| After 200 OK relayed | Flush updated state (confirmed, dialog finalized) |
| In-dialog activity | Checkout from Redis → process → flush on idle (configurable, default 2s) |
| Call termination | Clean up all Redis keys, write CDR |

The in-memory map entry is kept until Redis flush confirms success. If flush fails, the call remains in memory and flush is retried.

### Deserialization

Full `Schema.decodeUnknown` validation on every Redis read. Cost is negligible vs. Redis RTT, and corrupted state could cause wrong SIP messages on the wire.

## Call Limiters

Windowed counters in Redis with Lua scripts for atomicity.

### Key Design

```
{prefix}:limiter:{limiterId}:{windowTimestamp} → current count
```

Window timestamp is rounded to configurable intervals (default 5 minutes: 0, 300, 600, ...). Keys have a TTL so they auto-expire if the refresh script stops running (crash recovery).

### Verification

To check a limiter: SUM the counts across the last N active windows (configurable, default 3). Total check window = `LIMITER_WINDOW_SECONDS * LIMITER_ACTIVE_WINDOWS` (default 15 minutes).

### Lua Scripts

**check_and_increment**: atomically sum last N windows, reject if >= limit, otherwise INCR current window key with TTL. Returns current total or -1 if rejected.

**refresh (keepalive migration)**: for long-lived calls, migrate count from the origin window to the current window. Atomic: INCR current THEN DECR origin (briefly overcounts rather than undercounts — safe for a limiter). Called by the periodic limiter_refresh timer.

**decrement**: on call termination, DECR the window where this call's count lives (using `originWindow` from `CallLimiterState`).

### Configuration (environment variables)

| Variable | Default | Description |
|----------|---------|-------------|
| `LIMITER_WINDOW_SECONDS` | `300` | Window size in seconds |
| `LIMITER_ACTIVE_WINDOWS` | `3` | Number of windows to sum for verification |
| `LIMITER_TTL_SECONDS` | `1200` | Redis key TTL (should be > window * (active + 1)) |

## SIP Message Encoding

SIP payloads may contain binary non-UTF-8 characters. The B2BUA handles this by splitting at the header/body boundary:

- **Headers**: parsed as ASCII strings (SIP headers are always ASCII)
- **Body**: kept as raw `Uint8Array`, opaque to the B2BUA, passed through without interpretation
- **Content-Length**: derived from `body.byteLength`
- **UDP transport**: receives and sends raw `Buffer`

## SIP Method Handling

### INVITE (initial)

1. Create Call + a-leg + first b-leg
2. Call `POST /call/new` for routing decision
3. Flush initial state to Redis
4. Apply routing response (destination, headers, limiters)
5. Check-and-increment call limiters (reject if exceeded)
6. Send b-leg INVITE with new Call-ID (reuse original + leg prefix, e.g., `1-{originalCallId}`)
7. Start no-answer timer
8. On non-200/non-487 response, timeout, or limiter rejection: call `POST /call/failure`
9. On failover response: create new b-leg, repeat from step 5

### 18x Provisional

- Relay to a-leg with CSeq rewriting and tag mapping
- Track new early dialog (To-tag) if from a new fork endpoint
- On first 18x: record timestamp in CDR for PDD calculation

### 200 OK

- Confirm the winning dialog, set leg disposition to `bridged`
- Set all other pending b-legs to `cancelling` (send CANCEL or ACK+BYE)
- Embed `callRef` in Contact header on relayed 200 OK
- Relay to a-leg with CSeq rewrite
- Flush to Redis

### ACK

Relay end-to-end with CSeq rewriting. Required for delayed offer support (SDP in ACK).

### CANCEL

- If b-leg in `trying`/`early`: send CANCEL, wait for 487
- If b-leg already `confirmed` (race condition): ACK the 200 OK, then send BYE
- Decrement call limiters
- Record in CDR

### BYE

- Send 200 OK to BYE sender, mark source leg `byeDisposition: "bye_received"`
- `begin-termination`: send BYE/CANCEL to all other live legs, transition to `call.state = "terminating"`, schedule 64s safety timer
- As BYE confirmations (200 OK) arrive: `resolve-bye-response` rule marks each leg resolved
- When `isFullyResolved()` is true (all legs resolved): framework auto-promotes to `"terminated"`
- InvariantEnforcer at terminated: decrement call limiters, cancel all timers, write CDR, clean up Redis keys

### PRACK

Relay with proper CSeq and tag mapping for 100rel support.

### In-call Keepalive OPTIONS

- Send OPTIONS every `KEEPALIVE_INTERVAL_SEC` (default 900s / 15 minutes)
- If no response within timeout: `keepalive-timeout` rule triggers `begin-termination`
- If 481 received: `handle-481` rule triggers `begin-termination`

### Limiter Refresh

- Separate `limiter_refresh` timer, independent of keepalive
- Framework-level concern (not a rule): intercepted by `FrameworkLimiterRefresh.ts` before the rule chain
- Migrates limiter counts from origin windows to the current window via Redis Lua scripts
- Redis errors are logged but do not fail the call (retry next tick)

## Configuration

All configuration via environment variables with sensible defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `SIP_LOCAL_IP` | `127.0.0.1` | B2BUA listen address |
| `SIP_LOCAL_PORT` | `5060` | B2BUA SIP port |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection string |
| `REDIS_KEY_PREFIX` | `sipas` | Redis key namespace |
| `LIMITER_WINDOW_SECONDS` | `300` | Limiter time window |
| `LIMITER_ACTIVE_WINDOWS` | `3` | Windows to sum |
| `LIMITER_TTL_SECONDS` | `1200` | Limiter key TTL |
| `NO_ANSWER_TIMEOUT_SEC` | `30` | Default no-answer timeout |
| `KEEPALIVE_INTERVAL_SEC` | `900` | OPTIONS keepalive interval |
| `CALL_MAX_DURATION_SEC` | `7200` | Maximum call duration |
| `CDR_FILE_PATH` | `./cdr.jsonl` | CDR output file path |
| `HTTP_STATUS_PORT` | `3002` | Status HTTP port |
| `CALL_CONTROL_URL` | `http://localhost:3002` | App server base URL |
| `REDIS_FLUSH_IDLE_MS` | `2000` | Idle timeout before flushing to Redis |
