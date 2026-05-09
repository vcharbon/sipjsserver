# Plan: fix the in-dialog 481 on backup worker (pure-platypus)

## Context

Endurance run `endurance-2026-05-09t16-15-02-748z` failed with a clear
mid-dialog 481 storm during chaos:

- 128 forensic files end with `Last response: 481` — all in the `STEADY`
  category with `Outcome: mid-dialog-error`.
- Worker-1 logged **378 `Unroutable BYE … — rejecting`** WARN entries in
  this single 5-minute soak; worker-0 logged 22 (the smaller count is
  worker-0 being killed/respawned, not by design).
- Reproducer trace (call `endurance-…-1699@det`):
  1. `16:22:06.813` proxy: `INVITE … → 10.244.1.2:5060 (decision=select_new)` lands on `b2bua-worker-0`. Cookie stamped `w_pri=b2bua-worker-0,w_bak=b2bua-worker-1`.
  2. `16:22:06.820` proxy: `ACK … decode_forward` to worker-0.
  3. `16:22:36.380` chaos: `node-shutdown-app` evicts the node hosting worker-0.
  4. `16:22:36.821` and 5 retransmits to `16:22:44.328` proxy: still `decode_forward` to worker-0 (registry hasn't flipped yet).
  5. `16:22:48.331` proxy: `decode_forward_backup → 10.244.6.3:5060` (worker-1).
  6. `16:22:48.338` worker-1: **`Unroutable BYE … [no callRef in URI, fallback: callId=… fromTag=11SIPpTag001699] — rejecting`** → 481.

This is the exact symptom described in
[bye-takeover-replicated-indexes-fix.md §3](bye-takeover-replicated-indexes-fix.md):
the proxy correctly chose `decode_forward_backup`; the BYE has no `callRef`
in the request URI; the worker fell through `resolveFromSipKey`'s
in-memory + storage lookups and replied 481.

Important caveat that I got wrong on the first pass:
[`src/replication/EchoApply.ts:246`](../../src/replication/EchoApply.ts#L246)
*does* derive `derivedIndexes = callIndexKeysFromUnknown(frame.body)` and
*does* pass them to `outgoingChannel.write({ indexes: … })`. The code path
looks correct on paper. Yet on the wire the index is missing — so
something between "code intends to write the index" and "Redis has
`idx:leg:{callId}|{tag}` on worker-1's sidecar at BYE time" is broken.
The first slice is a targeted investigation, not a code change.

## Why doesn't the existing fake-clock test catch this? — SMOKING GUN

**The production HTTP transport for the replication puller is stubbed
out.** [main.ts:340-342](../../src/main.ts#L340-L342):

```typescript
openStream: (_args): Stream.Stream<Uint8Array, PullerTransportError> => {
  // Production wiring lands in Slice 8 alongside the
  // FetchHttpClient-backed transport. For now the
  // openStream is a dead stream — the worker still serves
  // /replog and writes propagate locally; pull-side
  // recovery is wired through the live-test path.
  return Stream.fail(
    new PullerTransportError({ reason: "Slice 8: HTTP transport not yet wired" })
  )
}
```

In the failing endurance run, worker-1's pod log confirms this:

```
[16:17:25.906] INFO (#29): replication: forked PullerFiber for peer b2bua-worker-0
[16:25:05.969] INFO (#29): replication: forked PullerFiber for peer b2bua-worker-0
```

…and **nothing else** — no `caught up`, no error, no apply. The fiber
was forked, immediately got `Stream.fail`, and either silently retried
forever or has internal swallow-on-error. Either way, **no frames are
ever applied on the production backup.** worker-1's local KvBackend
contains zero `bak:b2bua-worker-0:call:*` and zero `idx:leg:*` entries
sourced from worker-0. Every BYE that fails over to worker-1 hits an
empty store and 481s.

The fake-clock matrix tests don't catch this because the fake stack
wires a **working in-memory `openStream`** at
[`tests/support/k8sFakeStack.ts:381`](../../tests/support/k8sFakeStack.ts#L381)
that reads frames straight out of the peer's `kv` channel. So the
puller side is fully exercised under TestClock; only the production
HTTP wire is dead.

This invalidates the original plan's hypothesis tree (callIndexKeys
empty, key-format mismatch, TTL race). The actual bug is **architectural,
not algorithmic**: an unfinished slice ("Slice 8 — HTTP-backed
PullerTransport") was left as a stub. The correct fix is to land that
slice and add a test that prevents anyone from re-stubbing it.

### Revised goal hierarchy

1. **Wire the HTTP transport in `main.ts`** (the production-only fix).
   Mirror the existing `PeerCacheClient` HTTP plumbing
   ([`src/cache/PeerCacheClient.ts:128-174`](../../src/cache/PeerCacheClient.ts#L128-L174))
   which already uses `HttpClientRequest` + `FetchHttpClient.layer`
   — production has the dependency available.
2. **Add a guard test** that fails if `openStream` is `Stream.fail`.
   A grep-style test against `src/main.ts` is the cheapest. A more
   robust contract test stands up the supervisor with a real
   `PullerFiberConfig` and asserts at least one `noop` frame is
   delivered within N seconds against an in-process `/replog` server.
3. **Keep Slice 2's `expectIndexOnBackup` helper** as a guard against
   future regressions in the fake-stack puller path (it is not a
   production-fix tool but it is a low-cost forever-on assertion that
   prevents the matrix tests from regressing into "body but no index"
   silently).
4. **Limiter coverage (Slices 3 & 4)** is still valid — the
   bak-side BYE/re-INVITE/limiter accounting needs assertions even
   after the transport is wired, because today the matrix tests pass
   without ever asserting limiter=0 post-teardown.

## Goal

Two outcomes, in order:

1. Find the actual reason the backup's `idx:leg:` entry is missing at
   BYE time and fix it. The fix is whatever Slice 1 reveals — premature
   guesses (TTL, keying mismatch, race) all map to different patches.
2. Lock the fix in with a fake-clock regression test that fails today
   on `main` and passes after the fix. The user explicitly asked for
   coverage of: backup BYE, backup re-INVITE, and switchback (re-INVITE
   on backup → primary returns → BYE on returned-primary), all with
   limiter accounting verified to land at zero.

## Slice 1 — root-cause the missing index on the backup

Do this before designing the test. The test only has value if it
reproduces the actual bug; the actual bug is currently a hypothesis.

Inspect, in this order, by running an existing failover matrix test
(e.g. `tests/sip-front-proxy/failover/matrix/bye-alice-single.test.ts`)
under `vitest --run` with extra logging:

1. **Did the puller frame for this call ever reach the backup?**
   Add a `Logger.debug` at [`src/replication/EchoApply.ts:175`](../../src/replication/EchoApply.ts#L175)
   that prints `frame.callRef`, `frame.partition`, `frame.body !== null`,
   and the `derivedIndexes` length. Run the matrix BYE-alice-single
   test and confirm we see ≥1 PUT frame with `derivedIndexes.length > 0`
   for the call before the kill.

2. **Did `callIndexKeysFromUnknown` return a non-empty list?**
   The function lives at
   [`src/call/CallModel.ts:768-816`](../../src/call/CallModel.ts#L768)
   per the prior exploration. If it returns `[]` for the puller's
   `frame.body` (e.g. the body shape on the wire is wrapped in another
   object, or the field names mismatch a freshly-confirmed call), the
   write still succeeds — but writes zero index keys. **High-suspect
   hypothesis** because the code never asserts non-empty and there is
   no test today that round-trips: write call body via primary →
   replicate → look up backup `storage.getIndex(legKey(callId, tag))`
   and assert it returns the callRef.

3. **Did `outgoingChannel.write` actually SETEX the `idx:` keys?**
   Check the channel implementation
   [`src/replication/ChannelIndex.ts`](../../src/replication/ChannelIndex.ts)
   or the KV backend `channelWriteUpdate` Lua script (referenced from
   `EchoApply.ts:18-21`). If the indexes parameter takes a different
   key prefix than what `resolveFromSipKey` looks up, the write goes
   to a dead key. `idxKey(...)` from EchoApply line 232/262 must match
   the lookup-side key formatter
   ([`src/call/CallState.ts` `legKey` / `legCallIdKey`](../../src/call/CallState.ts)).

4. **TTL race.** `bodyTtlSec` is sourced from
   `frame.body_ttl_remaining_sec` (EchoApply line 251). For a long
   call (~30s here) that ttl could be near-zero on arrival; if the
   index TTL expires before the BYE retransmits succeed (~12s after
   the kill in this trace), the lookup misses for a real, non-bug
   reason. Probably not the root cause given other 481s in the run,
   but rule it out.

5. **CallGen gate eats the frame.** Lines 196-204: if the local body
   exists with a callGen ≥ incoming, the frame is skipped and the
   index is never written. For a fresh-on-backup call this should
   never trigger (`localBodyRaw === null` → `localCallGen = -Infinity`),
   but verify.

Whichever branch fires, fix it with the minimum code change. Likely
candidates are (a) a key-format mismatch between writer and reader, or
(b) `callIndexKeysFromUnknown` returning `[]` for a call shape that
the typed `callIndexKeys` would treat normally.

**Acceptance for Slice 1:**

- A new diagnostic log entry shows the indexes are written on the
  backup at PUT time.
- Manual: `redis-cli KEYS "sipas:idx:leg:<call-id>*"` on the backup
  pod returns the same set as on the primary, for the same call.
- The matrix test
  `tests/sip-front-proxy/failover/matrix/bye-alice-single.test.ts`
  remains green (it was green before; this slice should not regress).

## Slice 2 — fake-clock regression test that reproduces the 481

A minimal, deterministic test that fails today and passes after Slice 1.

**File**: `tests/sip-front-proxy/failover/backup-resolves-bye-via-replicated-index.test.ts`

Shape (mirror
[`limiter-decrement-via-backup-bye.test.ts`](../../tests/sip-front-proxy/failover/limiter-decrement-via-backup-bye.test.ts)
exactly — same SUT, same skipFinalSweep, same harness imports):

1. Establish call on W1 with `CALLID_TO_W1` and `X-Api-Call` route to
   bob (no limiter needed for this test — that's Slice 4).
2. `s.pause(1_000)` — replication settle.
3. **New assertion** on W2 BEFORE the kill:
   `s.cluster.expectIndexOnBackup(W2, { primary: W1, callId, fromTag })`
   — read W2's local KvBackend for `idx:leg:{callId}|{fromTag}` and
   assert it returns the callRef. **This single assertion is the
   regression test for the bug.** If indexes are not landing on W2,
   this fails before any kill happens.
4. `s.cluster.kill(W1)`; `s.pause(50)`.
5. Alice BYE → expect 200 (which today returns 481).
6. `s.cluster.expectRoutedTo(W2, { decision: "decode_forward_backup" })`.
7. Drain bob 200 (`s.pause(200)`).

The new helper
`s.cluster.expectIndexOnBackup(workerId, { primary, callId, fromTag })`
goes in
[`src/test-harness/internal/SimulatedK8sCluster.ts`](../../src/test-harness/internal/SimulatedK8sCluster.ts)
alongside `expectCallStateOn` / `expectReplicatedTo`. It calls
`workerHandle.kvBackend.getIndex(legKey(callId, fromTag))` directly.

**Acceptance for Slice 2:**

- Test fails on `main` with: `expected idx:leg:{callId}|{fromTag} → callRef, got null`.
- After Slice 1 fix, test passes.
- BYE returns 200, not 481.

## Slice 3 — extend matrix coverage (re-INVITE on backup)

Add `call_limiter` to the matrix builder at
[`tests/sip-front-proxy/failover/_matrix.ts:103-109`](../../tests/sip-front-proxy/failover/_matrix.ts#L103)
so existing files like `reinvite-alice-single.test.ts` and
`reinvite-alice-double.test.ts` automatically gain limiter accounting:

- Inject `call_limiter: [{ id: matrixName(c), limit: 1 }]` into the
  `X-Api-Call` JSON.
- Add two checkpoints:
  - After the in-dialog method (re-INVITE etc.) but before the BYE
    teardown: `expectLimiterCount(matrixName(c), 1)` — re-INVITE
    must NOT decrement.
  - After the teardown BYE drains:
    `expectLimiterCount(matrixName(c), 0)`.

The `expectLimiterCount` helper plumbing is the small wiring described
in the prior design pass — the cluster's `LimiterMemoryStore` already
exists (k8sFakeStack already builds one); we just need to thread it
through `WorkerLifecycle` into `SimulatedK8sClusterApi`. Sweep the
TTL'd windows using `Clock.currentTimeMillis` (matching
[`CallLimiter.ts:243-249`](../../src/call/CallLimiter.ts#L243)) before
summing.

**Acceptance for Slice 3:**

- All 20 matrix files now assert limiter=1 mid-call and limiter=0
  post-teardown. None regress.
- The double-switch re-INVITE files
  ([`reinvite-alice-double.test.ts`](../../tests/sip-front-proxy/failover/matrix/reinvite-alice-double.test.ts),
  `reinvite-bob-double.test.ts`) cover the user's "re-INVITE on backup
  + switchback + BYE on returned-primary + limiter=0" requirement
  out of the box, because `_matrix.ts:229-250` already runs:
  `kill W1 → method on W2 → respawn W1 → kill W2 → BYE alice` (BYE
  ends up on W2 after kill-W2, but with the matrix builder's settle
  pause the routing assertion stays consistent).
- **One change to `_matrix.ts`:** the post-respawn pause is `5_000`
  today (line 233). Per
  [`reinvite-big-case.test.ts:146`](../../tests/sip-front-proxy/failover/reinvite-big-case.test.ts#L146)
  precedent the LB fresh-pod-guard needs **25_000**. Bump to 25_000
  so the post-respawn BYE actually routes via `decode_forward` to W1
  instead of falling back to W2. (If the user wants the BYE to stay
  on W2 for the matrix, leave 5s and document; either way is fine
  but the routing assertion has to match the pause.)

## Slice 4 — switchback regression test (explicit, separate from matrix)

Standalone file because the matrix builder's double-switch ends with
`kill(W2)` and the user wants BYE-on-returned-primary specifically.

**File**: `tests/sip-front-proxy/failover/limiter-decrement-via-switchback-bye.test.ts`

1. INVITE → ACK on W1 (limit=1).
2. `s.pause(1_000)`. Assert index on W2 (Slice 2 helper).
3. `expectLimiterCount(id, 1)`.
4. `s.cluster.kill(W1)`; `s.pause(50)`.
5. Alice delayed-offer re-INVITE → W2 (`decode_forward_backup`).
6. `expectLimiterCount(id, 1)` — re-INVITE must not change counter.
7. `s.cluster.respawn(W1)`. `s.pause(25_000)` — covers LB fresh-pod
   guard + OPTIONS keepalive + ReadyGate reverse-drain.
8. Alice BYE → expect routing decision `decode_forward` to W1 (the
   returned primary), 200 OK end-to-end.
9. Drain (`s.pause(200)`).
10. `expectLimiterCount(id, 0)`.
11. `expectCallStateOn(W1, { partition: "pri", owner: W1, present: false })`.
12. `expectCallStateOn(W2, { partition: "bak", owner: W1, present: false })`.
13. `expectCdrCount(name, 1)`.

This test exercises three things that the matrix double-switch does
not: routing back to the returned primary (vs. staying on W2), the
limiter window's `originWindow` surviving the bak→pri switchback
([`b2bua/helpers.ts:105`](../../src/b2bua/helpers.ts#L105) reads
`e.originWindow` on terminate; with stored origin the decrement will
hit the same shared-Redis key set by the original INVITE), and the
backup tombstone clean-up via reverse-propagate.

## Critical files

- [src/replication/EchoApply.ts](../../src/replication/EchoApply.ts) — Slice 1 investigation, possibly Slice 1 patch.
- [src/replication/ChannelIndex.ts](../../src/replication/ChannelIndex.ts) — verify `idxKey` formatter matches reader.
- [src/call/CallModel.ts:768](../../src/call/CallModel.ts#L768) (`callIndexKeysFromUnknown`) — high-suspect for empty-list bug.
- [src/call/CallState.ts:464](../../src/call/CallState.ts#L464) (`resolveFromSipKey`) — reader side; key format must match.
- [src/call/CallLimiter.ts:243](../../src/call/CallLimiter.ts#L243) — read pattern for `expectLimiterCount` helper.
- [src/test-harness/internal/SimulatedK8sCluster.ts](../../src/test-harness/internal/SimulatedK8sCluster.ts) — host of new `expectIndexOnBackup` and `expectLimiterCount` helpers.
- [tests/support/k8sFakeStack.ts](../../tests/support/k8sFakeStack.ts) — wire LimiterMemoryStore + KvBackend handle through `WorkerLifecycle`.
- [tests/sip-front-proxy/failover/_matrix.ts](../../tests/sip-front-proxy/failover/_matrix.ts) — Slice 3 limiter wiring; pause adjustment line 233.
- [tests/sip-front-proxy/failover/limiter-decrement-via-backup-bye.test.ts](../../tests/sip-front-proxy/failover/limiter-decrement-via-backup-bye.test.ts) — template for new test files.

## Verification plan

1. **Slice 1**: `npm run typecheck`; run `bye-alice-single` matrix test in isolation with the diagnostic log; confirm the indexes branch is exercised. Apply minimum fix.
2. **Slice 2**: `npx vitest run --config vitest.config.fake.ts tests/sip-front-proxy/failover/backup-resolves-bye-via-replicated-index.test.ts` — confirm RED on `main` (pre-Slice-1), GREEN after.
3. **Slice 3**: `npx vitest run --config vitest.config.fake.ts tests/sip-front-proxy/failover/matrix` — full 20-file run, all green with limiter assertions.
4. **Slice 4**: `npx vitest run --config vitest.config.fake.ts tests/sip-front-proxy/failover/limiter-decrement-via-switchback-bye.test.ts` — green; manually inspect that step 8's routing assertion records `decode_forward` to W1.
5. **Endurance gate**: re-run a 5-minute smoke endurance comparable to `endurance-2026-05-09t16-15-02-748z` and confirm `STEADY mid-dialog-error` count drops to ≤ 5 (allowing for unrelated noise) and `Unroutable BYE` count on backup workers drops by >95%.

## What this plan deliberately defers

- Per-call limiter inspection at every intermediate step — the helper
  exposes the count by id; we use it at the obvious checkpoints rather
  than asserting after every transaction.
- A typed `callIndexKeys` vs. `callIndexKeysFromUnknown` unification.
  If Slice 1 finds the unknown variant is the culprit, fix locally and
  open a follow-up plan to unify. Don't bundle.
- Tests for non-INVITE/non-BYE in-dialog methods (INFO, UPDATE,
  MESSAGE) under switchback. The matrix already covers them under
  single + double switch; adding a switchback-with-INFO file is low
  ROI relative to the BYE/re-INVITE coverage above.
