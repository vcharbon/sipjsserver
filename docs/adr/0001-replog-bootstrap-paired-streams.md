# 0001 — Replog + Bootstrap as paired replication-channel streams

**Status:** accepted (2026-05-15)

## Context

Each worker holds another worker's calls in its **backup partition** (`bak:`) so it can serve them if the original primary dies. Keeping the two sides in sync requires three guarantees: cold-start catch-up for a fresh worker, low-latency live deltas, and idempotent re-apply after a network blip. We needed one mechanism that delivers all three.

## Decision

A **replication channel** between two workers is materialised as **two paired HTTP NDJSON streams**, both speaking the same `PullFrame` wire vocabulary and both driven by the same `Stream.paginate` primitive ([src/replication/ChannelStream.ts](../../src/replication/ChannelStream.ts)):

- **Bootstrap stream** (`GET /bootstrap?caller`) — finite, one-shot scan of the local `bak:{caller}:*` partition, terminated by a single `Noop` carrying the channel head watermark.
- **Replog stream** (`GET /replog?caller&gen&counter&chunk_size`) — long-lived, resumable from any watermark; emits ordered `Data` frames as state mutates, with `Noop` heartbeats on idle.

A puller drains the bootstrap once at startup, then opens the replog seeded from the bootstrap's terminal Noop watermark. Both streams share one paginate state machine, one frame encoder, and one wire-format codec, so a regression in either is caught by [tests/replication/server-emission-loop.test.ts](../../tests/replication/server-emission-loop.test.ts) and [tests/replication/peer-scan-bootstrap.test.ts](../../tests/replication/peer-scan-bootstrap.test.ts).

## Considered options

- **Redis pubsub.** No resume on reconnect, fan-out cost grows quadratically with the worker count. Rejected.
- **Native Redis replication (replica-of).** Couples deployment topology (one sidecar per pod) to backup topology (which workers back up which); also flushes everything in the replica's keyspace on a master fail, which would destroy the receiver's primary partition. Rejected.
- **Shared cache with no channel.** No ordering primitive, so the puller can't tell "I already applied this" from "this is newer than what I have". Rejected.

## Consequences

- Puller correctness reduces to **"apply iff the frame's `(gen, counter)` exceeds the local watermark"** — no per-call reconciliation logic. Cross-incarnation cycle-break falls out of lex-ordering on `(entryGen, counter)` (Story 7d).
- Both streams ride on `Stream.paginate`, so the per-tick finalizer leak that caused the May 2026 OOM (commit `a67af4ee`) cannot recur structurally — there is no per-tick `Stream.concat`, just one Suspend node.
- Bootstrap's `Stream.runCollect` of the whole partition bounds memory by partition size. Realistic today; if very large partitions ever appear, the path forward is to expose the Redis SCAN cursor in `PartitionedRelayStorage.scanCalls` and paginate it directly.
- The terminal Noop watermark on `/bootstrap` is load-bearing: it's how the puller bridges from snapshot mode to delta mode without rescanning. Removing it would force a rescan or a race window — neither is acceptable.
