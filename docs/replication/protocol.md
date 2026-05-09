# Replication wire protocol — `/replog`

## Status

INTENDED — describes the post-Story-7d wire shape. The current code emits a leaner schema (no `body_ttl_remaining_sec`); this document is the target. See [architecture.md](architecture.md) for context and [`docs/plan/grill-me-on-the-spicy-lark.md`](../plan/grill-me-on-the-spicy-lark.md) Story 7d for sequencing.

**Indexes are NOT carried on the wire.** The receiver derives them from the body via [callIndexKeysFromUnknown](../../src/call/CallModel.ts#L768) — see [architecture.md §"Indexes — derived from body, never on the wire"](architecture.md#indexes--derived-from-body-never-on-the-wire). Earlier drafts of this document proposed a wire `indexes` field; it is not needed.

---

## Endpoint

```
GET /replog?caller={peerId}&gen={uint}&counter={uint}&chunk_size={uint}
```

| Param | Required | Description |
|---|---|---|
| `caller` | yes | The puller's peer id. Server uses this to locate the channel binding `propagate:{self}->{caller}`. |
| `gen` | optional, default `0` | Puller's last-applied entry gen (per source). `0` ⇒ cold pull. |
| `counter` | optional, default `0` | Puller's last-applied entry counter (per source). `0` ⇒ cold pull. |
| `chunk_size` | optional, default `1000` | Max entries pulled from storage per inner-loop iteration. Recommended `500–1000`. The response is unbounded in length because the connection is long-lived; this is just the per-batch read hint. |

Response: `Content-Type: application/x-ndjson`. One JSON object per line. Streamed indefinitely until the puller closes or transport fails.

---

## Server-side emission loop

Pseudocode:

```
while connection_open:
  batch = kv.channelPullBatch({
    channel:    "propagate:{self}->{caller}",
    since:      { gen: req.gen, counter: req.counter },
    limit:      req.chunk_size,
  })

  for entry in batch.entries:
    # entry has: { entryGen, score, member, body, body_ttl_remaining_sec }
    parts = parseMember(entry.member)   # { op, partition, callRef }
    body  = parseJson(entry.body)        # null if entry.body === null

    emit DataFrame {
      gen:                       entry.entryGen,
      counter:                   entry.score,
      op:                        parts.op,            # "create" | "update" | "delete"
      partition:                 parts.partition,     # "pri" | "bak"
      callRef:                   parts.callRef,
      body:                      body,                # parsed JSON or null
      body_ttl_remaining_sec:    entry.body_ttl_remaining_sec,
      latency_ms:                nowMs - body.written_at_ms (if body has it, else 0),
    }
    advance internal cursor

  if len(batch.entries) == req.chunk_size:
    continue immediately   # might be more pending in storage

  emit NoopFrame {
    gen:        serverIncarnationGen,
    counter:    batch.head.counter,
    latency_ms: 0,
  }
  sleep noop_interval_ms (default 100)
```

The 100 ms wait is the only place the server "blocks." `noop` is emitted exactly once per empty-poll cycle — both as a heartbeat (so the puller knows the connection is live) and as the **caught-up-to-head** signal (it tells the puller "I returned fewer than `chunk_size`, so you have everything up to my current `counter`").

### Lex ordering across buckets (load-bearing)

`channelPullBatch` walks per-`(channel, entryGen)` buckets in **ascending lex order of `entryGen`**. Within each bucket, members are returned in counter-ascending order. Across buckets, the boundary is a strict transition.

Example. Suppose the channel `propagate:{B}->{A}` has:

- Bucket gen=0 (mirrors): `{ "U:bak:A:call:X" → 7, "U:bak:A:call:Y" → 12, "U:bak:A:call:Z" → 15 }`
- Bucket gen=42 (B's incarnation): `{ "D:bak:A:call:Q" → 1, "U:pri:B:call:R" → 3 }`

Pull with `since = { gen: 0, counter: 0 }`, `limit: 100`:
- Walk gen=0 bucket: emit X (counter 7), Y (12), Z (15).
- Walk gen=42 bucket: emit Q (1), R (3).
- Emit Noop at `{ gen: 42 [server's gen], counter: 15 [head] }`.

Pull with `since = { gen: 42, counter: 1 }`:
- Skip gen=0 bucket entirely (`0 < 42`).
- Walk gen=42 bucket from counter > 1: emit R (3).
- Emit Noop.

Pull with `since = { gen: 0, counter: 12 }`:
- Walk gen=0 bucket from counter > 12: emit Z (15).
- Walk gen=42 bucket: emit Q (1), R (3).
- Emit Noop.

The cycle-break (INV6) follows directly: a warm puller with `since.gen = 42` never receives mirror entries (gen=0), but a cold puller with `since.gen = 0` receives both kinds.

---

## Frame types

### DataFrame

A single state mutation. Carries everything the puller needs to recreate the call's body and the SIP-derived index entries.

```json
{
  "type": "data",
  "gen": 0,
  "counter": 12,
  "op": "update",
  "partition": "bak",
  "callRef": "abc123",
  "body": {
    "callGen": 5,
    "written_at_ms": 1715200000123,
    "_topology": { "wPri": "worker-A", "wBak": "worker-B" },
    "aLeg": { "callId": "...", "fromTag": "...", "...": "..." },
    "bLegs": [ { "callId": "...", "fromTag": "...", "dialogs": [ ... ] } ],
    "callbackContext": "..."
  },
  "body_ttl_remaining_sec": 540,
  "latency_ms": 12
}
```

| Field | Type | Meaning |
|---|---|---|
| `type` | `"data"` | Frame discriminator. |
| `gen` | uint | Entry's stored `entryGen`. `0` for mirrors; writer's incarnation gen for originating writes. **Lex-ordered with `counter` for the puller's apply gate.** |
| `counter` | uint | Entry's per-bucket counter. Strictly increasing within a bucket. |
| `op` | `"create"` \| `"update"` \| `"delete"` | Apply type. `create` and `update` are wire-equivalent for the puller (apply if `(gen, counter) > watermark` AND content gate passes); the distinction is for log/observability. `delete` ⇒ tombstone the local body + remove the cached indexes for this `(peer, callRef)`. |
| `partition` | `"pri"` \| `"bak"` | The partition the writer wrote to. The puller flips: `partition === "pri"` ⇒ apply to local `bak:{source}:`; `partition === "bak"` ⇒ apply to local `pri:{self}:`. |
| `callRef` | string | The call this frame is about. |
| `body` | object \| `null` | Decoded body JSON. `null` if the body has been TTL-expired or DEL'd between write and pull (treated as implicit DEL by the puller). The body MUST contain a `callGen: number` field for the per-call content gate (see [architecture.md §"Why callGen is still needed"](architecture.md#why-callgen-is-still-needed-a-narrower-role)) and the `aLeg`/`bLegs`/`callbackContext` fields from which the receiver derives `idx:*` keys via [callIndexKeysFromUnknown](../../src/call/CallModel.ts#L768). |
| `body_ttl_remaining_sec` | uint | Time-remaining (NOT TTL-at-write) for the body, computed at server emission time. Receiver passes this to its `bodySet` so the local copy expires at the same wall-clock as the source's. The same value is used as the TTL for each `idx:*` entry the receiver re-creates from the body. |
| `latency_ms` | uint | `now - body.written_at_ms` at frame-emit time (server-side). Lets the puller measure end-to-end replication lag without clock-sync. `0` if `body.written_at_ms` is absent. |

**No `indexes` field on the wire.** The receiver derives index keys from the body via `callIndexKeysFromUnknown(body)` and creates `idx:*` entries locally as part of the same atomic `channelWriteUpdate` call. See [architecture.md §Indexes](architecture.md#indexes--derived-from-body-never-on-the-wire) for the full rationale and the DELETE-path index cache mechanism.

### NoopFrame

Heartbeat + caught-up signal. Does NOT carry an entry; emits the channel's current head as a witness.

```json
{
  "type": "noop",
  "gen": 42,
  "counter": 15,
  "latency_ms": 0
}
```

| Field | Type | Meaning |
|---|---|---|
| `type` | `"noop"` | Frame discriminator. |
| `gen` | uint | Server's current incarnation gen. NOT associated with any specific entry. |
| `counter` | uint | The channel's current head counter (highest counter across all buckets at snapshot time). |
| `latency_ms` | `0` | Always zero for noop. |

The first `noop` received on a connection flips the per-peer fiber's `everCaughtUp = true` flag (sticky for this incarnation). Subsequent noops update the puller's watermark to `(noop.gen, noop.counter)` if greater (advances the lower bound for the next pull request).

---

## Apply rule (puller side)

For every received frame F:

```
incoming = (F.gen, F.counter)

if compareGenCounter(incoming, watermark) > 0:
  if F._tag == "Data":
    targetPartition = F.partition === "pri" ? "bak" : "pri"
    targetOwner     = targetPartition === "bak" ? F.source : self
    targetBodyKey   = `${targetPartition}:${targetOwner}:call:${F.callRef}`

    local           = kv.bodyGet(targetBodyKey)
    localCallGen    = local === null ? -Infinity : parseCallGen(local)

    if F.body.callGen > localCallGen:
      derivedIndexes = callIndexKeysFromUnknown(F.body).map((key) => ({
        key,
        value: F.callRef,
        ttlSec: F.body_ttl_remaining_sec,
      }))

      kv.channelWriteUpdate({
        entryGen:    0,
        channel:     `propagate:{self}->{F.source}`,
        counterKey:  `seq:{self}->{F.source}:gen:0`,
        member:      `${F.op === "delete" ? "D" : "U"}:${targetBodyKey}`,
        bodyKey:     targetBodyKey,
        bodyValue:   serializeBody(F.body),
        bodyTtlSec:  F.body_ttl_remaining_sec,
        indexes:     derivedIndexes,
      })

      # Cache the derived list for the eventual DELETE frame's index removal.
      indexCache.set({ peer: F.source, callRef: F.callRef }, derivedIndexes)
    # else skip — local content is fresher

  watermark = incoming

if F._tag == "Noop":
  fiber.everCaughtUp = true   # sticky
  if compareGenCounter(incoming, watermark) > 0:
    watermark = incoming
```

### Notes

- **`compareGenCounter`** is lex on `(gen, counter)`: gen is high-order, counter low-order. New-gen tuples sort above old-gen tuples regardless of where the new counter resets — gen rollover is naturally handled.
- **The watermark advances on every received frame whose tuple is greater**, irrespective of whether the apply landed (callGen gate is content-only, doesn't affect watermark). This prevents re-receiving skipped entries on reconnect.
- **`null` body on a `data` frame**: treat as implicit DEL. The body either TTL'd or was deleted concurrently; the call should be removed locally.
- **`null` local body on apply** (cold recovery): `localCallGen = -Infinity`, the gate succeeds for any `incoming.callGen ≥ 0`. **Create-if-not-exist is preserved.**
- **Tombstones**: `op === "delete"`. `bodyValue` is a tombstone marker (`{ "tombstone": true, "callGen": <bumped> }`). The receiver's `channelWriteUpdate` writes this tombstone with the configured tombstone TTL (defaults to 180 s); after that window, the local body expires naturally. The mirror entry in the receiver's gen=0 bucket also points at this tombstone.
- **DELETE-path index removal**: tombstones carry no `aLeg`/`bLegs`, so `callIndexKeysFromUnknown(F.body)` returns `[]`. To delete the `idx:*` entries that were created on the prior PUT/UPDATE, the puller consumes its in-memory `indexCache.get({ peer: F.source, callRef: F.callRef })` (populated on the prior PUT apply). The cached list is passed as `indexesToRemove` to a tombstone-shaped `channelWriteUpdate` (or to a separate tombstone primitive — see [architecture.md](architecture.md)). Cache miss falls back to "remove body only, leave `idx:*` to TTL out" — accepted by spec.

---

## Codec round-trip examples

### A primary write + its mirror echo, lex-sorted on B's outgoing channel

A originates a write on call X with `callGen=5`. PRS computes `indexes = callIndexKeys(call)` from the typed Call, then calls `kv.channelWriteUpdate({ entryGen: A.gen=42, channel: "propagate:A->B", member: "U:pri:A:call:X", body: <body callGen=5>, body_ttl_remaining_sec: 1200, indexes: <derived list> })`.

Server-side emit when B's puller pulls (warm watermark `(42, 9)`):

```ndjson
{"type":"data","gen":42,"counter":10,"op":"update","partition":"pri","callRef":"X","body":{"callGen":5,"written_at_ms":1715200000000,"aLeg":{"callId":"...","fromTag":"..."},"bLegs":[...],"...":"..."},"body_ttl_remaining_sec":1200,"latency_ms":3}
{"type":"noop","gen":42,"counter":10,"latency_ms":0}
```

B's puller applies: derives the same index list via `callIndexKeysFromUnknown(frame.body)`, calls `kv.channelWriteUpdate({ entryGen: 0, channel: "propagate:B->A", member: "U:bak:A:call:X", bodyKey: "bak:A:call:X", bodyValue: <body bytes>, bodyTtlSec: 1200, indexes: <derived list> })`. Atomically: body lands at `bak:A:call:X`, each `idx:{key} → X` is created, mirror entry lands in B's gen=0 bucket. B's watermark advances to `(42, 10)`. B's puller also caches the derived index list at `indexCache[{peer: "A", callRef: "X"}]` for the eventual delete.

A's puller now pulls `propagate:B->A` with watermark `(B.gen=17, lastCtr)`. The mirror entry just added is in B's gen=0 bucket. Lex compare: `(0, *) < (17, *)`. Server returns nothing new from gen=0 bucket. Cycle dies.

### Cold recovery sees the mirror

A wipes; A's process restarts with `genA' = 43`. A's puller starts at `(0, 0)` against B's `propagate:B->A`. Server walks B's buckets:

```ndjson
{"type":"data","gen":0,"counter":7,"op":"update","partition":"bak","callRef":"X","body":{"callGen":5,"written_at_ms":1715200000000,"aLeg":{"callId":"...","fromTag":"..."},"bLegs":[...],"...":"..."},"body_ttl_remaining_sec":640,"latency_ms":560000}
... [more gen=0 mirrors] ...
{"type":"data","gen":17,"counter":3,"op":"delete","partition":"bak","callRef":"Q","body":{"tombstone":true,"callGen":42},"body_ttl_remaining_sec":120,"latency_ms":1234}
... [more gen=17 originating entries from B] ...
{"type":"noop","gen":17,"counter":3,"latency_ms":0}
```

A's puller applies each. The frame for X has `partition="bak"` → A flips to `pri:A:call:X` (recovery target). `local = null`, `localCallGen = -Infinity`, gate passes. A derives `idx:*` keys via `callIndexKeysFromUnknown(frame.body)` and writes its `pri:A:call:X` body + each `idx:*` entry via the same atomic `channelWriteUpdate({ entryGen: 0, ... })`. `WorkerReadiness.markReady(true)` flips after the noop. **Index recovery is a side-effect of body recovery — no separate step.**

Note: `body_ttl_remaining_sec` reflects the time-remaining at server emission. A's local body and its `idx:*` entries will expire at the same wall-clock as B's mirror — the source's intended expiry is honored.

---

## Error handling

The puller treats every `Stream.fail` and every clean `Stream` end as "connection lost — backoff and reconnect." There is no retry within the stream; the supervisor's reconnect loop owns it.

Server side: if a Lua script fails (e.g. malformed args), the connection is closed with an error and the puller reconnects after backoff. There is no error-frame; the puller learns of failure via transport.

Parse errors on the puller side (malformed NDJSON, unknown frame type) raise `ProtocolError`. The supervisor logs WARN and reconnects.

---

## Compatibility

This protocol is the **target** post-Story-7d. The currently-shipped wire shape lacks `body_ttl_remaining_sec`. A puller running pre-7d code reading a post-7d server (or vice-versa) is **not supported** — Story 7d is a sharp cutover (per D10). No version negotiation, no field optionality.
