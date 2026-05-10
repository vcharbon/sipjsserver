# Tombstone-as-body-slot — proper fix (architectural, not band-aid)

> **Implementation note (final).** Two iterations.
>
> First iteration kept the mirror echo on the assumption that NS5
> (sidecar-wipe-recovery) needed it. Re-checking the actual trace
> (`test-results/fake-clock/sipproxyHA/ha-keepalive-timeout.html`)
> made the user's argument concrete: every b2b-2→b2b-1 echo frame
> at gen=0 carried data b2b-1 already owned. The cost is not just
> wire noise — it is a real correctness bug. If originator A writes
> UPDATE(X) then DELETE(X), peer B applies UPDATE first and echoes
> it back; A's puller may pull the echo *after* A's own DELETE
> drained the body, and the create-if-not-exist branch silently
> resurrects the deleted call. The echo path was therefore removed
> entirely. NS5 and replication-gap-mini both relied on this broken
> pattern for "quiet-call recovery on respawn"; both are now marked
> `.skip` pending a follow-up **peer-scan-bootstrap** slice — on
> respawn, scan `bak:{me}:*` on each peer and replay locally into
> `pri:{me}:*`, instead of cold-pulling stale gen=0 mirrors.
>
> A second subtle bug surfaced during the second iteration: replacing
> `channelWriteUpdate` with sequential `bodySet` calls in `EchoApply`
> broke body↔indexes atomicity, opening a window where the SIP hot
> path observed a body without indexes and 481'd. Fixed by adding
> two new local-only atomic primitives — `applyReplicaUpdate` and
> `applyReplicaDelete` — to `KvBackend`. Both run in a single
> exclusive section (memory) / single Lua eval (Redis) so the SIP
> path always observes body+indexes together.
>
> Final shipped scope:
> - Layer A: body-slot hard-DEL on tombstone (no JSON in body slots
>   ever); `isReplicationTombstone` deleted from `CallState`.
> - Echo killed: `EchoApply` writes only locally via the new atomic
>   primitives, never touches the outgoing channel.
> - Stale-response observability counter
>   `b2bua_stale_response_dropped_total{method, status}` on the
>   SipRouter's unroutable-response and missing-call-on-checkout
>   branches.
> - Follow-up landed:
>   [docs/plan/echo-removal-grill-me-smooth-parasol.md](echo-removal-grill-me-smooth-parasol.md)
>   shipped the peer-scan-bootstrap path for quiet-call recovery —
>   new `/bootstrap` streaming endpoint, `runPeerScanBootstrap`
>   orchestrator wired into worker boot + fake stacks, and re-activated
>   NS5 + replication-gap-mini. `docs/replication/call-cache-backup.md`
>   §8.6 + §11.2 are the canonical reference for the new boot phase.

## Context

Endurance run `post-fix-validation-5-20260510-1617` produced a SchemaError storm
(4–13/min) in the SipRouter consumer fiber. The runtime symptom: late OPTIONS
keepalive 200 OKs arriving for calls the worker had already deleted hit the
tombstoned body slot in the replication cache, the JSON `{tombstone:true,
callGen:N}` payload failed `JsonCallSchema.decode`, and the `Effect.orDie`
escaping the rule layer killed the consumer fiber. Run 6 shipped a band-aid
(`src/call/CallState.ts:isReplicationTombstone` short-circuits before the
schema decode) that stops the crash but leaves the underlying design intact.

The user's review of the band-aid surfaced the deeper problem and rejected the
current shape:

1. **A live cache slot should never hold a "deletion marker" payload.** The
   body slot at `${partition}:${owner}:call:${callRef}` should either contain
   a real Call body or nothing. Encoding `{tombstone:true, callGen:N}` there
   forces every reader on the hot path to be tombstone-aware (band-aid in
   `loadCall`, missing band-aid in `loadOwnedCalls`).
2. **A peer must NEVER echo replication frames back to the originator.** Today
   `EchoApply` mirrors both delete frames AND update frames to its outgoing
   channel (`entryGen=0`). Lex-order on `(entryGen, counter)` makes warm
   pullers skip these — so they are wire noise — but they remain a real
   surface for re-apply on cold recovery and a constant source of confusion
   when reading replication state.
3. **Late responses must not be answered with 481.** RFC 3261 §17.1.1.2 says
   stale responses MUST be silently dropped. Today's "tombstone → undefined →
   `withCall` body sees `call === undefined` → SipRouter generates 481" path
   is wrong for the actual traffic that hits this code (an OPTIONS 200 OK is
   a response, not a request).

Evidence collected during planning:

- **The message that hits the tombstone is the OPTIONS keepalive 200 OK** —
  Run-5 logs show `Unhandled error processing event [sip:200]` immediately
  before each SchemaError. BYE 200 OKs are absorbed earlier by
  `absorbBye200Rule` (`alwaysActive`); OPTIONS 200 OKs reach `loadCall`
  unconditionally.
- **The tombstone-write timing is already at end-of-life.** `InvariantEnforcer`
  orders effects `cancel-timers → limiter-decrement → write-cdr → remove-call`,
  and `remove-call` is what calls `storage.deleteCall`. The CDR is durably
  written before the tombstone exists. So your "tombstone fires immediately on
  OPTIONS timeout" worry is not the actual bug; OPTIONS timeout sets state to
  `terminating`, BYEs the legs, waits for BYE 200s or the safety net, then
  enters `terminated → remove-call → tombstone`.
- **The body-tombstone is dispensable.** The puller's `channelPullBatch`
  returns `body: null` when the body has TTL'd or been DEL'd, and `EchoApply`
  already treats `frame.body === null || frame.op === "delete"` identically.
  The body-tombstone JSON serves only one optimization: passing the exact
  `callGen` to the peer's apply path. The `localCallGen + 1` fallback is safe
  and adequate (especially after we suppress echo, since there is then no
  cross-peer tombstone race for callGen to mediate).
- **No prior echo-suppression fix exists.** The user remembered "previously
  removed some badly echoed message" — `git log` for echo/mirror/loop/propagate
  finds only the original Story 7d propagate-set commit (5d6eee9) and an
  unrelated pingpong K8s scenario (8388723). The mirror writes have been
  there since the design landed; nothing has been suppressed before.

**Intended outcome.** After this change:
- Body slots are either a live Call JSON or absent. `isReplicationTombstone`
  becomes dead code and is removed.
- Replication frames flow strictly originator → peer; the peer applies and
  does not echo. The channel direction is one-way per (self, peer) pair.
- Late responses to deleted calls are dropped silently with a metric, not
  481'd. Late requests still 481 (RFC §12.2.2 dialog-not-found).

## Recommended approach

Two coordinated layers of change. Both must land together; partial rollouts
break invariants.

### Layer A — Replace tombstone-body-slot with hard-DEL

| File | Change |
|---|---|
| [src/storage/KvBackend.ts:339-352](src/storage/KvBackend.ts#L339-L352) | `CHANNEL_WRITE_TOMBSTONE_LUA`: replace `SETEX bodyKey ttl tombstoneValue` with `DEL bodyKey`. Indexes are already DEL'd; D-member ZADD stays. Remove `tombstoneValue` and `tombstoneTtlSec` from the script's ARGV signature. |
| [src/storage/KvBackend.ts:741-766](src/storage/KvBackend.ts#L741-L766) | Memory backend `channelWriteTombstone`: replace `setEntry(...tombstoneValue...)` with `removeEntry(store, args.bodyKey)`. Drop `tombstoneValue`/`tombstoneTtlSec` from `ChannelWriteTombstoneArgs`. |
| [src/replication/ChannelIndex.ts:177-189](src/replication/ChannelIndex.ts#L177-L189) | `tombstone(...)`: drop `tombstoneValue` and `tombstoneTtlSec` from the call to `kv.channelWriteTombstone`. Drop `callGen` from `ChannelTombstoneArgs` (no longer needed in the body). Delete `encodeTombstone` (lines 197-203). |
| [src/replication/ChannelIndex.ts:116-117](src/replication/ChannelIndex.ts#L116-L117) | Delete `DEFAULT_TOMBSTONE_TTL_SEC` export. |
| [src/cache/PartitionedRelayStorageKvBacked.ts:507-550](src/cache/PartitionedRelayStorageKvBacked.ts#L507-L550) | `deleteCall` peer branch: stop reading the existing body to derive `tombstoneCallGen`. Just call `channel.tombstone({ entryGen, partition, callRef, indexesToRemove })`. The RMW step (lines 536-539) is gone. |
| [src/replication/EchoApply.ts:175-243](src/replication/EchoApply.ts#L175-L243) | DELETE path: replace the `outgoingChannel.tombstone(...)` mirror write with `localKv.bodyDel(targetBodyKey)` + `localKv.bodyDel(idxKey)` for each cached index. Drop `mirrorTombstoneCallGen` derivation entirely. |
| [src/replication/EchoApply.ts:245-275](src/replication/EchoApply.ts#L245-L275) | UPDATE path: replace the `outgoingChannel.write(...)` mirror with `localKv.bodySet(targetBodyKey, bodyValue, bodyTtlSec)` + index sets. The peer already had this content via the inbound frame; we just persist it locally without re-broadcasting. |
| [src/replication/EchoApply.ts:183-204](src/replication/EchoApply.ts#L183-L204) | callGen content gate: keep the gate but apply it ONLY to update frames. For delete frames, fall through unconditionally (a delete supersedes any local state). Document the rationale in a comment. |
| [src/call/CallState.ts:93-127](src/call/CallState.ts#L93-L127) | Delete `isReplicationTombstone` and the long comment block. |
| [src/call/CallState.ts:405-413](src/call/CallState.ts#L405-L413) | Delete the tombstone-detection branch in `loadCall`. The pre-existing `if (json === null) return undefined` (line 403) handles deleted calls correctly. |
| [src/call/CallState.ts:705-712](src/call/CallState.ts#L705-L712) | `loadOwnedCalls` decode path: no change needed once body-tombstones are gone (scan never returns tombstone JSON). The `Effect.orDie` stays — a true SchemaError on a non-null body is now genuinely fatal again, which is the right behavior. |

### Layer B — Suppress echo, drop late responses correctly

| File | Change |
|---|---|
| [src/replication/EchoApply.ts](src/replication/EchoApply.ts) | After Layer A removes the `outgoingChannel.{write,tombstone}` calls, the `outgoingChannel` config field becomes dead. Remove it from `ReplicationApplyConfig`. Update all callers in [src/replication/ReplicationSupervisor.ts](src/replication/ReplicationSupervisor.ts) and [src/main.ts](src/main.ts). |
| [src/sip/SipRouter.ts](src/sip/SipRouter.ts) — `withCall` undefined-call branch | Today, when `loadCall` returns undefined, the body emits the SIP-method-specific not-found response (481/487/etc). For RESPONSES, change the branch to drop silently and increment a new counter. Pseudo: `if (kind === "response") { metrics.staleResponseDropped(method, status); return Effect.void } else { /* existing 481 path */ }`. Specific line numbers will be located during implementation; the request-vs-response discriminator is already in scope at this call site. |
| [src/observability/MetricsRegistry.ts](src/observability/MetricsRegistry.ts) | Add `b2bua_stale_response_dropped_total{method, status}` counter to `SipRouterMetrics`. |
| [src/observability/MetricsRegistry.ts](src/observability/MetricsRegistry.ts) | Add `b2bua_replication_echo_suppressed_total{op}` counter — instrument every place the OLD code would have called `outgoingChannel.{write,tombstone}` so we can confirm in production that echo paths really have stopped firing (and quantify how much wire noise we removed). |

## Critical test changes

Echo-apply tests assert mirror writes happened. After Layer A+B those
assertions invert.

| File | What to change |
|---|---|
| [tests/replication/echo-apply.test.ts](tests/replication/echo-apply.test.ts) | All 5 tests: replace "mirror entry exists in outgoing channel" with "no mirror entry exists in outgoing channel". Local apply is still asserted (body present, indexes set/cleared). |
| [tests/replication/channel-index.test.ts:227-249](tests/replication/channel-index.test.ts#L227-L249) | The cold-pull-finds-mirrors test becomes "cold pull finds only originating gen entries; gen=0 bucket is empty by construction". |
| [tests/storage/kv-backend-parity.test.ts](tests/storage/kv-backend-parity.test.ts) | Drop `tombstoneValue` / `tombstoneTtlSec` from the parity coverage; add a positive parity test that `channelWriteTombstone` DELs the body slot in both backends. |
| [tests/replication-ns/ns03-delete-and-tombstone-ttl.test.ts](tests/replication-ns/ns03-delete-and-tombstone-ttl.test.ts) | Rename and rewrite — there is no body TTL anymore. The test should verify that after a delete propagates, both peers' body slots are absent and the channel D-member is observable for a configurable retention window. |
| [tests/replication-ns/ns13-tombstone-ttl.test.ts](tests/replication-ns/ns13-tombstone-ttl.test.ts) | Same — delete this scenario or reshape it to assert "body absent after delete; D-member still pullable until channel cleanup". |
| [tests/replication-ns/ns14-symmetric-tombstone-from-backup.test.ts](tests/replication-ns/ns14-symmetric-tombstone-from-backup.test.ts) | Reshape: the symmetric backup→primary delete path now hard-DELs both sides; assertion changes from "tombstone JSON in slot" to "slot absent". |

New tests to add:

1. **Late-response-after-delete** — fake-stack scenario: establish a call,
   send keepalive OPTIONS, delete the call, then deliver a 200 OK to the
   in-flight OPTIONS transaction. Assert: no 481 on the wire, no SchemaError,
   `b2bua_stale_response_dropped_total{method=OPTIONS, status=200}` increments
   by 1.
2. **Late-request-after-delete** — same setup but deliver a stray re-INVITE
   in-dialog. Assert: 481 on the wire (request path unchanged), metric
   untouched.
3. **Cold-recovery-without-mirror** — start two workers, write some calls
   from worker A, kill worker B, restart worker B with the channel still
   holding only originator-gen entries (no gen=0 mirrors). Assert: B
   re-applies all live calls correctly. This is the test the planning agent
   noted is currently *missing* — without it we don't actually have proof
   that mirrors aren't load-bearing for cold recovery. Adding this test
   first (before deleting the mirrors) is what gives us confidence the
   removal is safe.

## Things that explicitly do NOT change

- Tombstone-write **timing** in the local call lifecycle. Today's
  ordering (`cancel-timers → limiter-decrement → write-cdr → remove-call`)
  is already correct; remove-call still happens last after CDR is durably
  on disk. This plan does not touch the InvariantEnforcer or the action
  executor.
- The channel D-member as the wire signal of a deletion. The puller still
  sees `op="delete"` (or equivalently `body=null`) and applies a local DEL.
- The callGen content gate for **update** frames. Concurrent writes to the
  same call from multiple sources still need ordering, and callGen on PUT
  bodies stays.
- The 481 path for late in-dialog **requests**. RFC §12.2.2 says 481 for
  "Call/Transaction Does Not Exist" on requests; that stays.

## Verification

End-to-end checks before signoff:

1. **Type-clean build**: `npm run typecheck` reports zero errors and zero
   Effect-plugin warnings.
2. **Fake-stack regression**: `npm run test:fake` passes, including the
   3 new tests above. Echo-apply tests now assert *no* mirror writes;
   ns03/ns13/ns14 reshaped to "body absent after delete".
3. **Live regression**: `npm run test:ci` (medium tier) passes — covers the
   real-clock e2e path that the fake stack can't reach.
4. **Endurance run, single worker**: `npm run test:k8s:endurance` with the
   same args as `post-fix-validation-6` (caps=45, limiterCap=10,
   durationSec=1200, no chaos). Acceptance:
   - Zero `[CallState] SchemaError` lines in worker logs.
   - `b2bua_stale_response_dropped_total{method=OPTIONS, status=200}` rises
     monotonically through the soak (proof the path is being exercised) but
     does NOT correlate with consumer-fiber wedges.
   - `b2bua_replication_echo_suppressed_total{op=update}` and `{op=delete}`
     counts roughly match the originator-gen channel write counts (proof
     echo paths are firing where they used to and being suppressed cleanly).
   - STEADY OK ≥ 95% (vs. the 46% in run 6).
   - No `Event handler timed out` lines on BYE in pod logs after drain
     completes.
5. **Replication invariant spot-check**: from the endurance artifact, grep
   each peer's pod log for `repl: sampler-window` and confirm `queue_depth_mean`
   stays under, say, 10 throughout the soak (queue depth is what the new
   timeline.html chart now plots).

## Risks called out

- **Test churn is large.** Layer A invalidates ~5–8 replication test files.
  Most of the work is mechanical (assertion inversion), but ns03/ns13/ns14
  are scenario tests whose narrative changes. Plan ~1 day for that.
- **callGen-on-tombstone optimization is gone.** If a future feature needs
  to communicate the originating callGen of a delete (e.g. takeover
  arbitration with three or more peers), it has to come back via a
  different channel — probably as metadata on the D-member rather than as a
  body-slot tombstone. We accept this loss for now.
- **Cold-recovery test is the load-bearing safety net.** If
  `cold-recovery-without-mirror` (test #3 above) cannot be made to pass
  without the mirrors, mirrors WERE doing real work and Layer B has to
  shrink to "suppress only delete-frame echo". Sequencing: write the test
  first, prove it passes against the current mirrored design, then delete
  the mirrors, then prove it still passes.
