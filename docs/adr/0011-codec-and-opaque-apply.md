# ADR 0011 — codec abstraction + opaque-body replication apply

## Status

Accepted. Supersedes ADR 0009 (msgpackr-call-codec) and ADR 0010
(codec-runtime-switch).

## Context

The May 2026 endurance profile showed an asymmetry that the codec
migration to msgpackr (ADR 0009) was supposed to close:

- Encode visible at ~27 % of non-GC CPU on `CallState.flushToRedis`.
- Decode visible at ~0.14 % — but the true decode cost was hidden
  inside the 30 % GC bucket. Bucket-D (replication-RX) decoded both
  the incoming frame body and the local stored body on every applied
  frame, solely to read `_topology.gen` and derive the `idx:*` key set.
  Both decoded objects were discarded immediately after the gate ran.

ADR 0010 also pinned the codec choice to a startup-time flag
(`B2BUA_CODEC=MSGPACK | MSGPACK_RECORDS`). That was load-bearing for
the bench-vs-prod migration but produced two co-existing surfaces:

- A first-byte JSON-vs-msgpack dispatch in every decoder for the
  rolling-upgrade window.
- A 9-byte `[0x01][8-byte BE writtenAtMs][body]` binary stamp prefix
  on every body solely so the puller could derive a `latency_ms`
  observability field without decoding the body.

Both surfaces are dead weight once the dual-write window closes.

## Decision

**Codec is a Layer-injected record of pure functions** (`CallBodyCodec`,
`src/call/codec/`). Encode/decode are synchronous, non-Effectful. The
boot-time selector (`selectCallBodyCodecLayer`) reads `B2BUA_CODEC` once
and provides the matching implementation:

```
src/call/codec/
  CallBodyCodec.ts   # Tag + CODEC_MODE
  msgpack.ts         # MsgpackLayer / MsgpackRecordsLayer
  contracts.ts       # propertyTest / paranoidInputs / parity / scopedAudit
  index.ts           # selectCallBodyCodecLayer
```

Four contract wrappers — `propertyTest`, `paranoidInputs`, `parity`,
`scopedAudit` — compose left-to-right and return the same Tag. They
exist so adding a future codec (PROTOBUF / JSON) plugs into the same
property tests without modifying consumers. A property-based test suite
(`tests/codec/round-trip-property.test.ts`) exercises P1/P5/P7/P13/P14
against every registered codec Layer.

**Bodies in Redis are bare codec output, byte-for-byte.** The 9-byte
stamp prefix is deleted. `writtenAtMs` is removed from the body and the
wire — the originator no longer stamps wall-clock time. The puller's
`latency_ms` metric is permanently `0`; if the emit-pipeline lag metric
is reinstated, the puller can derive it from received-time deltas
across consecutive frames.

**The peer's apply path is opaque.** Per-call content metadata is lifted
out of the body into:

- A 4-byte BE `${bodyKey}:gen` sidecar key, written atomically with the
  body in the same Lua / mutex section. The peer's apply gate reads
  this 4-byte key — never the body — to decide whether the incoming
  callGen is strictly greater than the local callGen.
- Two new wire fields (`callGen`, `indexes`) stamped by the originator
  into every `DataFrame`. Indexes ride on both UPDATE and DELETE frames
  so the peer never needs an `(source, callRef) → indexes` cache.

EchoApply no longer decodes the body on any path. The body bytes flow
opaquely end-to-end — originator's `codec.encode(call)` → peer's Redis
`SET` — with one body decode per call on the SIP load path (cold start,
takeover) and zero on the replication apply path in steady state.

**Codec swaps are fresh-cluster events.** Drain + `FLUSHDB` + redeploy.
There is no in-place codec upgrade contract — every body in Redis was
written by the codec the cluster currently runs.

## Consequences

- Bucket-D (replication-RX) in steady state has no body-decode cost.
- The originator's `flushToRedis` no longer allocates a 9-byte stamp
  header + concat per flush.
- `B2BUA_PARANOID_DECODE=1` → `B2BUA_PARANOID=1`; it now also runs
  `Schema.is(CallSchema)` on encode input, since the wire envelope's
  callGen depends on encode-side `_topology.gen` correctness.
- One additional Redis key per call (the `:gen` sidecar), 4 bytes,
  same TTL as the body. Negligible memory overhead.
- The `latency_ms` field on the wire stays for shape stability but is
  always `0` until a deltas-based reconstruction is wired up.
- Adding a codec = one new file (e.g. `src/call/codec/protobuf.ts`)
  + one switch arm in `selectCallBodyCodecLayer`. Consumers stay
  untouched.

## Trade-offs

- **Cluster-wide drain on codec change.** Acceptable; codec changes
  are rare deliberate events, and the system is not in production.
- **4-byte sidecar key doubles the Redis key count per call.** The
  value is tiny and shares the body's TTL.
- **`latency_ms` observability surrendered.** The puller-side
  reconstruction is feasible (deltas across frames) but not implemented
  in this slice. The decision is "remove now, reinstate if profiles
  need it" rather than carry an entire 9-byte-per-body stamp forever.

## Reference material preserved

The original bench numbers (v3-no-repl-reparse, v4-cas-outofband,
v5-protobuf-static, v6-msgpackr) live in `tests/bench/call-codec/`,
so the historical reasoning is preserved where it remains
load-bearing.
