# Replication Stream Cleanup — replog & bootstrap on a shared paginate primitive

## Context

The May 2026 heap-leak diagnosis (commit `a67af4ee`) fixed an OOM in the long-lived `/replog` NDJSON stream by replacing a recursive `Stream.concat` chain with `Stream.paginate` in [src/replication/ReplLogServer.ts:223-278](src/replication/ReplLogServer.ts#L223-L278). The fix works (30 min + 2 h endurance flat at ~45 MB), but three pieces of stream code in this area are still rough:

1. **`buildPullStream`** uses `Stream.paginate` but threads an awkward `TickState { since, sleepFirst: boolean }` that mixes two concerns (cursor advance + idle-backpressure deferral).
2. **`buildBootstrapStream`** in the same file uses a different shape (`Stream.unwrap` + `Stream.concat` with inline byte encoding) — inconsistent with `buildPullStream` even though both produce the same NDJSON wire frames.
3. **`streamNdjsonLines`** in [src/replication/NdjsonStream.ts:20-49](src/replication/NdjsonStream.ts#L20-L49) hand-rolls a TextDecoder + `\n`-splitter with mutable buffer state nested inside double `Stream.unwrap`, when Effect v4 ships `Stream.decodeText` + `Stream.splitLines` that do exactly this.

This area is a critical-architecture decision (it carries every cross-worker call-state delta and seeds every restarting worker) but has no formalised vocabulary or ADR. We use this cleanup to both (a) make the code consistent and obviously-correct, and (b) lock in terminology and rationale so the next reader doesn't have to re-derive intent.

## Decisions (settled with user)

1. **Glossary** — create `CONTEXT.md` at repo root with:
   - **Replication channel** = abstract bidirectional state-sync mechanism between two workers.
   - **Replog stream** = long-lived NDJSON delta endpoint at `GET /replog`. Infinite.
   - **Bootstrap stream** = one-shot snapshot NDJSON endpoint at `GET /bootstrap`. Finite, terminated by one `Noop`.
   - **Watermark** = the `(gen, counter)` cursor pair, lex-compared.
   - **Tick** = one iteration of a paginate body.
   - **PullFrame** = `Data` (mutation) | `Noop` (heartbeat).
2. **Tick state for replog**: discriminated union `{ _tag: "Pulling" | "Idle", cursor: Watermark }`. Replaces `sleepFirst`.
3. **Shared paginate primitive**: extract `buildChannelStream<S>(initial, step)` so both replog and bootstrap go through the same builder. Encoding to bytes (`PullFrame → string → Uint8Array`) moves to a shared downstream pipeline.
4. **NDJSON parser**: rewrite using built-in `Stream.decodeText` + `Stream.splitLines` + `Stream.mapEffect`.
5. **Test infrastructure**: new medium-tier test under `tests/fullcall/` using real Redis + real HTTP server + 100 K injected entries. Asserts: replog phase drains all entries, bootstrap phase drains all entries + terminal Noop, post-GC heap delta < 50 MB, throughput ≥ 50 k frames/s.
6. **ADR**: yes — write `docs/adr/0001-replog-bootstrap-paired-streams.md` documenting why the channel is materialised as two paired streams + one paginate primitive.

## Implementation

### Step 1 — new module: `src/replication/ChannelStream.ts`

Hosts the shared primitive, tick-state types, and encoder tail. Nothing else changes yet.

```ts
// Watermark already-de-facto exists; promote to named type.
export type Watermark = { readonly gen: number; readonly counter: number }

export type ReplogTickState =
  | { readonly _tag: "Pulling"; readonly cursor: Watermark }
  | { readonly _tag: "Idle";    readonly cursor: Watermark }

export type BootstrapTickState =
  | { readonly _tag: "FetchingHead" }
  | { readonly _tag: "Scanning";         readonly head: Watermark }
  | { readonly _tag: "EmitTerminalNoop"; readonly head: Watermark }

export const buildChannelStream = <S, E, R>(
  initial: S,
  step: (s: S) => Effect.Effect<
    readonly [ReadonlyArray<PullFrame>, Option.Option<S>], E, R
  >
): Stream.Stream<PullFrame, E, R> =>
  Stream.paginate(initial, step)         // verify the v4 name: paginate, not paginateEffect

export const encodeFramesToBytes = <E, R>(
  frames: Stream.Stream<PullFrame, E, R>
): Stream.Stream<Uint8Array, E, R> =>
  frames.pipe(Stream.map(encodeFrame), Stream.encodeText)
```

Citation: `Stream.paginate` at [repos/effect/packages/effect/src/Stream.ts:1618](repos/effect/packages/effect/src/Stream.ts#L1618); `Stream.encodeText` at [Stream.ts:8769](repos/effect/packages/effect/src/Stream.ts#L8769).

### Step 2 — migrate `buildPullStream` in `ReplLogServer.ts`

Replace [lines 223-278](src/replication/ReplLogServer.ts#L223-L278). New body:

- `initial: ReplogTickState = { _tag: "Pulling", cursor: args.initialSince }`
- `step(s)`:
  - **Pulling**: `pullBatch(s.cursor, chunkSize)` → map entries to `DataFrame` (preserve the null-filter at line 240-242). Compute `partial = batch.entries.length < chunkSize`. If `partial`, append `NoopFrame { gen: batch.head.gen, counter: batch.head.counter }` (preserve head-tuple semantics at lines 254-259). Advance cursor to the last entry's `(entryGen, score)` if any. Return `[frames, Some(partial ? Idle : Pulling)]`.
  - **Idle**: `Effect.sleep(noopIntervalMs)` → `[[], Some(Pulling with same cursor)]`. The noop has already been flushed at the prior `Pulling` tick — sleep cannot run before it, preserving the existing flush-before-block invariant.

Then `.pipe(encodeFramesToBytes)`. No more module-local `textEncoder`.

### Step 3 — migrate `buildBootstrapStream`

Replace [lines 290-319](src/replication/ReplLogServer.ts#L290-L319). New body with `BootstrapTickState`:

- **FetchingHead** → `channel.pullBatch({gen:0,counter:0}, 0)`, return `[[], Some({_tag:"Scanning", head})]`. Preserves the snapshot-before-scan invariant ([ReplLogServer.ts:297-303](src/replication/ReplLogServer.ts#L297-L303)).
- **Scanning** → `storage.scanCalls("bak", caller).pipe(Stream.orDie, Stream.map(toBootstrapDataFrame), Stream.runCollect)` → `[frames, Some({_tag:"EmitTerminalNoop", head})]`.
- **EmitTerminalNoop** → `[[noopAt(head)], None]` — terminates.

`toBootstrapDataFrame` replaces the inline `encodeBootstrapEntry` ([lines 321-334](src/replication/ReplLogServer.ts#L321-L334)) and returns a typed `DataFrame` with sentinel `gen:0, counter:0` (preserve [lines 284-289](src/replication/ReplLogServer.ts#L284-L289)). Encoding to bytes is the shared downstream stage.

**Memory note**: `Stream.runCollect` of the whole partition is acceptable for bootstrap (the HTTP response already buffers a full snapshot). 100 K small JSON values ≈ 30-50 MB transient, freed once paginate hands the chunk off. If this becomes a concern, the follow-up is to expose Redis SCAN cursor in `PartitionedRelayStorage.scanCalls` so bootstrap can step the SCAN cursor inside `paginate` (analogous to the existing `scanByPrefix` paginate at [PartitionedRelayStorageKvBacked.ts:609-627](src/cache/PartitionedRelayStorageKvBacked.ts#L609-L627)).

### Step 4 — rewrite `NdjsonStream.ts`

Replace [lines 20-49](src/replication/NdjsonStream.ts#L20-L49) entirely:

```ts
export const streamNdjsonLines = <E>(
  bytes: Stream.Stream<Uint8Array, E>
): Stream.Stream<PullFrame, E | ProtocolError> =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.mapEffect(decodeFrameEffect)
  )
```

`decodeFrameEffect` stays. Tighten its return type to `Effect<PullFrame, ProtocolError>` — the `null`-on-whitespace path is already filtered upstream. `Stream.decodeText` lazily allocates the TextDecoder inside `suspend` ([Stream.ts:8740-8744](repos/effect/packages/effect/src/Stream.ts#L8740-L8744)) so per-stream-execution state is preserved without our own `Stream.unwrap`. `Stream.splitLines` handles `\n`, `\r`, `\r\n` across chunks ([Stream.ts:8794](repos/effect/packages/effect/src/Stream.ts#L8794)).

Error channel `E | ProtocolError` is unchanged → consumers ([PullerHttpTransport.ts:79-118](src/replication/PullerHttpTransport.ts#L79-L118), [PullerHttpTransport.ts:156-200](src/replication/PullerHttpTransport.ts#L156-L200), `PullerFiber`) recompile without edits.

### Step 5 — new medium-tier test

Path: `tests/fullcall/replication-stream-medium.test.ts`. Add to `vitest.config.live.ts` test.include. Top guard: `TEST_TIER ∈ {"medium","long"}` else `it.skip` (pattern in [tests/fullcall/e2e-real-clock.test.ts](tests/fullcall/e2e-real-clock.test.ts)).

Setup (one `beforeAll`):
- Real Redis sidecar via `RedisClient.layer` (`tests/support/liveStack.ts:60` pattern).
- `PartitionedRelayStorage.redisLayer`.
- `ReplLogServer.layer({ self: "A", gen: 1 })`.
- HTTP server with `addReplLogRoutes` ([ReplLogServer.ts:355](src/replication/ReplLogServer.ts#L355)) on `127.0.0.1:0`.
- Inject 100 K synthetic entries by calling `ChannelIndex.write({...})` directly (no SIP).

**Phase A — replog**: `GET /replog?caller=B&gen=0&counter=0&chunk_size=1000` via `FetchHttpClient` + production `makePullerOpenStream` + `streamNdjsonLines`. Drain with `Stream.runFoldEffect` until watermark catches up. Assert: 100 000 Data frames, no duplicate `callRef`, monotonic `(gen, counter)`.

**Phase B — bootstrap**: open `GET /bootstrap?caller=B` via production `makeBootstrapStream`. Drain to terminal Noop. Assert: 100 000 Data + 1 Noop; every `callRef` from Phase A present.

**Heap & throughput assertions** (around each phase):
- `if (!global.gc) it.skip("requires --expose-gc")`.
- `global.gc()` → snapshot `heapUsed` → drain → `global.gc()` → assert delta < 50 MB.
- Wall-clock seconds → assert `frames / seconds ≥ 50_000`.

Add a `test:medium` script in `package.json` invoking vitest with `node --expose-gc` so the GC hook is available.

### Step 6 — terminology & ADR

- **Create `CONTEXT.md`** at repo root with the Replication glossary entries listed under Decisions §1.
- **Create `docs/adr/0001-replog-bootstrap-paired-streams.md`**. Body sketch:
  - **Context**: two workers must keep mirrored partitions; need cold-start catch-up, live deltas, idempotent re-apply after disconnect.
  - **Decision**: a replication channel between A and B is materialised as a paired bootstrap + replog NDJSON stream, both driven by `buildChannelStream` (`src/replication/ChannelStream.ts`).
  - **Alternatives rejected**: Redis pubsub (no resume), Redis replication (couples deploy topology to backup topology), shared cache without watermark primitive (no ordering).
  - **Consequences**: puller correctness reduced to "apply iff frame watermark > local"; both endpoints share one paginate primitive so regressions are caught by `tests/replication/server-emission-loop.test.ts`.
  - **Open questions**: bootstrap's `Stream.runCollect` memory footprint at very large partitions — follow-up to expose SCAN cursor if needed.

## Critical files

| File | Change |
|------|--------|
| [src/replication/ChannelStream.ts](src/replication/ChannelStream.ts) | **NEW** — `buildChannelStream`, `encodeFramesToBytes`, `Watermark`, tick-state unions |
| [src/replication/ReplLogServer.ts](src/replication/ReplLogServer.ts) | Migrate `buildPullStream` + `buildBootstrapStream`; remove `textEncoder`, inline `encodeBootstrapEntry` |
| [src/replication/NdjsonStream.ts](src/replication/NdjsonStream.ts) | Replace body with 4-combinator pipeline; tighten `decodeFrameEffect` return type |
| [tests/fullcall/replication-stream-medium.test.ts](tests/fullcall/replication-stream-medium.test.ts) | **NEW** — 100 K real-Redis, real-HTTP end-to-end + heap + perf |
| [vitest.config.live.ts](vitest.config.live.ts) | Add new test path to `test.include` |
| [package.json](package.json) | Add `test:medium` script with `node --expose-gc` |
| [CONTEXT.md](CONTEXT.md) | **NEW** — replication glossary |
| [docs/adr/0001-replog-bootstrap-paired-streams.md](docs/adr/0001-replog-bootstrap-paired-streams.md) | **NEW** — ADR |

## Migration order (typecheck-green at each step)

1. Add `ChannelStream.ts`. No callers yet. → `npm run typecheck`.
2. Migrate `buildPullStream`. Export name + signature unchanged. → typecheck + `tests/replication/server-emission-loop.test.ts` + endurance smoke.
3. Migrate `buildBootstrapStream`. → typecheck + `tests/replication/peer-scan-bootstrap.test.ts`.
4. Rewrite `NdjsonStream.ts`. Consumers recompile. → typecheck + `tests/replication/puller-http-transport-integration.test.ts`.
5. Add medium-tier test. → `TEST_TIER=medium npm run test:medium`.
6. Write `CONTEXT.md` + ADR.

## Verification

- `npm run typecheck` — zero errors, zero warnings (both tsc and Effect plugin).
- `npm run test` — fake stack + short live, all green.
- `npm run test:ci` — fake stack + medium live, including the new replication-stream test.
- Manual smoke: `npm run dev`; `curl http://localhost:PORT/replog?caller=peer&gen=0&counter=0` emits NDJSON; `curl http://localhost:PORT/bootstrap?caller=peer` emits NDJSON ending in a `Noop` frame.

## Follow-up opportunities (out of scope here)

The exploration surfaced naming inconsistencies that this plan deliberately does **not** fix, to keep the change focused. Each is worth its own follow-up:

1. **`pri` / `primary` / `owner`** and **`bak` / `backup` / `peer`** drift across [PartitionedRelayStorage.ts:10](src/cache/PartitionedRelayStorage.ts#L10), [CallState.ts:257-267](src/call/CallState.ts#L257-L267), [PartitionRef.ts:14-15](src/cache/PartitionRef.ts#L14-L15), [ReplicationProtocol.ts:220](src/replication/ReplicationProtocol.ts#L220). Recommendation: `pri`/`bak` for wire/key tokens, `primary`/`backup` for prose.
2. **`gen` / `epoch` / `seq` / `counter`** — four overlapping versioning concepts. Glossary should pin each ([EpochCounter.ts](src/replication/EpochCounter.ts), [CallModel.ts:568](src/call/CallModel.ts#L568)).
3. **"Takeover" vs "serve as backup"** — historically confusing in [docs/replication/call-cache-backup.md:40](docs/replication/call-cache-backup.md#L40); the partition-invariant memory says ownership ref never moves. Recommend retiring "takeover" in favour of "backup serves the request".
4. **Bootstrap memory footprint** — if very large partitions become realistic, expose Redis SCAN cursor on `scanCalls` and replace `Stream.runCollect` in `BootstrapTickState.Scanning` with a true paginate over SCAN cursors.
5. **Worker / Pod / WorkerOrdinal** — code uses `WorkerOrdinal`, prose uses "worker", K8s context uses "pod"; pin in CONTEXT.md.
