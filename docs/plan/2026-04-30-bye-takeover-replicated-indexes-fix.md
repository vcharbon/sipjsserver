# Plan: fix BYE takeover for calls held only as `bak:`

## TL;DR

The drain test (`tests/k8s/proxy-drain.test.ts`) failed with 10/20 calls
surviving instead of ≥18/20. Investigation peeled three independent
bugs off the same symptom; two are already fixed, the third is
load-bearing for the entire takeover contract and still open.

What's still broken: a backup worker holding a call as
`sipas:bak:P:call:{callRef}` cannot serve an in-dialog request for that
call because the matching `sipas:idx:leg:{callId}|{tag}` entry is not
replicated alongside the call body. The worker's `resolveFromSipKey`
returns `undefined`, the SipRouter treats the request as fresh, and the
B2BUA replies 481.

The user's broader ask — "the backup must propagate back to the ex-
primary if it returns" — is already in the design
(`docs/replication/call-cache-backup.md` §10.3 + §11.2: bidirectional
propagate via `propagate:P` from R to P, ReadyGate drains on P boot).
We must verify it survives the bug fix and is exercised end-to-end.

## Findings, in the order they were peeled off

### 1. Proxy advertised `127.0.0.1` (FIXED)

`tests/k8s/values/sip-front-proxy.yaml` had `bind.advertisedHost:
"127.0.0.1"` to support the host-driven hybrid harness. From inside
the kind cluster, `127.0.0.1` is sipp's own pod loopback. Sipp's
`[routes]` macro silently dropped the unreachable URI; ACK/BYE went
out without any Route header; the proxy hit `select_new`. Changed to
`sip-front-proxy` (Service DNS, UDP/5060, kube-proxy LBs to either
proxy pod). Hybrid harness now needs its own values override —
follow-up tracked in the values file comment.

### 2. Sipp scenarios missing `rrs="true"` (FIXED)

`<recv response="200" rtd="true">` did not capture Record-Route into
the dialog route set. Sipp's `[routes]` requires `rrs="true"` on the
`<recv>` to reflect Record-Route into Route headers. Added
`rrs="true"` to the dialog-establishing `<recv response="200">` in
`uac-basic.xml`, `uac-hold.xml`, `uac-hold-failover.xml`,
`uac-pingpong.xml`.

After (1) and (2) are fixed, the proxy's in-dialog routing path is
exercised end-to-end:

- ACK on every call decides as `decode_forward` (cookie verified, primary alive).
- BYE on a drained-primary call decides as `decode_forward_backup` (primary dead/draining-post-grace, backup resolved and routed).
- Backup peer ID resolves correctly: `w_bak=b2bua-worker-1` → 10.244.4.4 (surviving worker-1), not the freshly-respawned `b2bua-worker-0`.
- `sipas:bak:b2bua-worker-0:call:b2bua-worker-0|<callRef>` keys exist on worker-1's sidecar.

The proxy and the write side of replication are working.

### 3. Indexes are not replicated (OPEN — root cause of remaining 481s)

Reproducer dump from worker-1 (the backup peer) right after a drain
test failure, for the failing call `inv3-hold-molknd8m-1@det`:

```
$ kubectl -n sip-test exec b2bua-worker-1 -c redis -- \
    redis-cli --scan --pattern "sipas:*inv3-hold-molknd8m-1@det*"
sipas:bak:b2bua-worker-0:call:b2bua-worker-0|inv3-hold-molknd8m-1@det|11SIPpTag001
```

One key. The call body is there. No `sipas:idx:leg:inv3-hold-molknd8m-1@det|11SIPpTag001` pointing at the callRef.

For comparison, calls whose primary IS worker-1 do have their a-leg
indexes locally:

```
sipas:idx:leg:inv3-hold-molknd8m-6@det|11SIPpTag006   (call-6 primary=worker-1)
sipas:pri:b2bua-worker-1:call:b2bua-worker-1|inv3-hold-molknd8m-6@det|11SIPpTag006
```

So index keys are written for the worker's own primary partition but
are NOT being replicated alongside `bak:` entries. Per the design
(`docs/replication/call-cache-backup.md` §4.1), `idx:` keys are
intentionally flat (un-partitioned) precisely so that
`GET idx:leg:{callId}|{tag}` returns the callRef regardless of
whether the call sits in `pri:` or `bak:`. That property only holds
if the puller (or the AtomicWriter on the backup's own writes) lays
down the same `idx:` keys it would lay down on the primary.

`resolveFromSipKey` ([src/call/CallState.ts:348](../../src/call/CallState.ts#L348))
falls all the way through:

1. In-memory `sipIndex` lookup — empty (call never landed on this worker before).
2. `storage.getIndex(legKey(callId, tag))` — Redis miss.
3. `storage.getIndex(legCallIdKey(callId))` — Redis miss.
4. Returns `undefined`.

Without a callRef the SipRouter routes the BYE through the
"initial-INVITE" handlers, which 481 immediately because there is no
matching INVITE.

## What still needs to be fixed

### Slice A — replicate indexes alongside the call body

The atomic-write Lua script writes `pri:N:call:{ref}`, `idx:*` (flat),
`propagate:peer`, in one shot ([src/replication/AtomicWriter.ts](../../src/replication/AtomicWriter.ts)).
The propagate entry signals the peer to pull. The peer's puller
([src/replication/ReplPuller.ts](../../src/replication/ReplPuller.ts))
fetches the changed callRef, decodes the JSON body, and writes it to
`bak:N:call:{ref}` via its own AtomicWriter.

The miss is that the puller's local write does not reconstruct the
flat `idx:*` keys from the JSON body. Two ways to fix it; pick one:

- **Option A1 — recompute on receive** (recommended). The pulled JSON
  is a `Call`. `callIndexKeys(decoded)` on the receiving worker
  produces the same set of index keys the primary stamped. Have the
  puller's local AtomicWriter call pass `indexes: callIndexKeys(decoded)`
  on the `bak:` write. The Lua script already accepts an indexes list
  for the put mode (per §5.3); we just need the caller to provide it
  for the bak-side write. Index keys are deterministic from the call
  body, so primary and backup will always agree.
- **Option A2 — wire-format indexes** in the propagate response. The
  primary already knows `callIndexKeys(call)` at write time and could
  serialize them next to the JSON body. Slightly cheaper on the
  receiver but adds a new field to the `/replog` framing. Skip unless
  recompute turns out to mis-derive on edge cases (unlikely; index
  keys come from CallModel fields that are part of the JSON anyway).

**Acceptance for Slice A:**

- `kubectl exec ... -c redis -- redis-cli KEYS "sipas:idx:leg:<call-id>*"` on the backup peer returns the same set as on the primary, for every replicated call.
- The drain test, run alone, achieves ≥18/20 hold-call survival on
  uac-hold-failover.xml. (Hold the existing assertion at 18.)
- A new fake-stack unit test seeds a `bak:` body via the AtomicWriter
  on worker B, looks up `idx:leg:<id>|<tag>` and gets back the
  callRef, then runs a BYE handler and asserts 200 OK.

**Risk:** index DELETE propagation. §4.3 already covers this — the
delete-mode Lua puts the previous index keys into the tombstone JSON
under `indexes`, and the backup's puller is expected to use that to
clean up its own index pointers. If we add index writes on the bak
side, we must also wire the bak-side delete to consume the
tombstone's `indexes` field and DEL them. Verify the puller already
does this; if not, add to this slice.

### Slice B — takeover write back-propagation

Per §10.3, when the backup R serves an in-dialog request for a call
whose primary P is not K8s-Ready, R writes the new state to its own
`bak:P:call:{ref}` (NOT to `pri:R:`) and announces the write into R's
`propagate:P` stream so P recovers the takeover state on its return.

After Slice A unblocks the lookup, R's BYE handler will run and emit
a write. Two checks:

1. R's write goes through the `(role: "bak", owner: P, peer: P)`
   AtomicWriter call. Confirm the worker's flush path detects "I am
   not the call's primary, I am writing as backup" and uses the right
   parameters. The plumbing is in `partitionOf` ([src/call/CallState.ts:119](../../src/call/CallState.ts#L119))
   already (`role = parsed.primary === selfOrdinal ? "pri" : "bak"`).
   What's not yet verified: does the propagate-peer parameter flip
   from R's normal primary-side `peer=R's bak-buddy` to the takeover-
   case `peer=P (the original primary)`?

   Inspect the codepath from `CallState.flushToRedis` to
   `storage.putCall`'s `peer` argument. If `peer` is hardcoded to
   "this worker's bak-buddy", takeover writes will land in
   `propagate:<bak-buddy-of-R>`, not in `propagate:P`. P will never
   pick them up.

2. The `_repl.writerEpoch / writerSeq` fields on the takeover write
   must be R's epoch/seq, not P's, so the merge-on-return uses the
   newer pair (§11.1 conflict resolution).

**Acceptance for Slice B:**

- A unit test forks two workers in the fake stack, kills primary P
  mid-call, lets backup R serve the BYE, then inspects R's
  `propagate:P` stream and finds the BYE-result entry.
- Drain-test instrumentation: in the test's `finally`, dump
  `propagate:b2bua-worker-0` from the SURVIVOR's sidecar and assert
  membership matches the migrated callRefs.

### Slice C — primary-return rehydration

Per §11.2 and §10.3 final paragraph, when P (b2bua-worker-0 in our
test) comes back as a fresh pod with empty Redis, its ReadyGate must
drain `propagate:P` from every peer Pi and merge takeover writes into
its own `pri:P:call:{ref}` partition. After ReadyGate is open, P's
`pri:` partition matches what was on R as `bak:` plus any takeover
edits R made.

The drain test as currently written does not exercise the primary-
return case. After the drain we need:

- Worker-0 to come back up (StatefulSet replaces it; happens in ~5s
  in our test today).
- Some calls still in-flight (BYE not yet sent, or a re-INVITE
  pending). Today's `uac-hold-failover.xml` doesn't have a request
  AFTER the BYE, so once BYE succeeds, the call ends and there is
  nothing for the primary to recover.
- A subsequent in-dialog request that the proxy will route to P
  again (because P is K8s-Ready and the cookie's `w_pri` resolves to
  P).

To exercise this we need a scenario like
`uac-pingpong.xml`-but-with-failover:
INVITE → ACK → re-INVITE during drain (lands on R via decode_forward_backup) → re-INVITE after primary returns (lands on P via decode_forward) → BYE.
The third in-dialog request is the one that proves P picked up the
takeover state from R.

**Acceptance for Slice C:**

- New live test `tests/k8s/proxy-failover-worker-return.test.ts` that
  does: INVITE-ACK → kill worker-0 → re-INVITE (asserts BYE-takeover
  via decode_forward_backup) → wait for worker-0 ready → BYE (asserts
  decode_forward back to worker-0, served 200 OK via rehydrated state).
- Diagnostic: dump `pri:b2bua-worker-0:call:*` on worker-0 after
  ReadyGate is open; assert the in-flight callRefs are present.

### Slice D — proxy edge case: trust-the-cookie-not-the-name

Even with Slices A–C green, there's a residual race. In our drain
test, the new `b2bua-worker-0` pod came up in ~5s, well before BYEs
were flowing (~10s into the call). For most of the BYE wave, the proxy
saw worker-0 as alive again and could pick `decode_forward` to the
new pod. New pod hasn't drained `propagate:b2bua-worker-0` yet, so
its `pri:` is still empty → 481 even with Slices A–B in place.

The ReadyGate (§8.3) caps boot drain at 30s; until ready=true, the
worker is supposed to NOT serve traffic. The K8s readiness probe
gates this. Verify:

1. The pod's K8s readiness probe is wired to return false until
   ReadyGate completes. If it returns true on container start, the
   proxy will see the pod as alive and send traffic before drain
   finishes.
2. The proxy's worker-registry ([src/sip-front-proxy/registry/WorkerRegistry.ts](../../src/sip-front-proxy/registry/WorkerRegistry.ts))
   transitions a returned pod through `unknown` → `alive` only after
   it is K8s-Ready. The OPTIONS keepalive thresholds (3 × 2s) should
   keep the proxy on `unknown` until the pod actually responds.

If both are correct, Slice D is "verify, don't fix". If the readiness
probe returns true too early, fix it to gate on ReadyGate.

**Acceptance for Slice D:**

- Drain-then-pingpong scenario (Slice C's test extended with a faster
  return cycle) shows zero `decode_forward` to the returned-but-not-
  ready pod; everything resolves to either the original primary
  (during grace) or the backup (after grace) until ReadyGate opens.

## Test-side cleanup (low priority)

- Revert `proxy-drain.test.ts` to use `uac-hold.xml` (3s pause) once
  the read path works at 10s. The 3s pause is the production-relevant
  case: a normal call hangup in the SIGTERM/grace window. We switched
  to 10s only to disambiguate replication-lag from logic-bug; that
  question is now answered (logic).
- Keep the redis-dump diagnostic in `finally`; it's cheap and turned
  this whole investigation into evidence.
- Hybrid harness (`tests/support/registrarFrontProxyHybridStack.ts`
  callers) must re-install the proxy with `--set
  bind.advertisedHost=127.0.0.1` or its own values file. Track
  separately; not on the critical path for failover work.

## Suggested execution order

1. **Slice A first.** Without indexes the read path is dead and
   nothing else can be tested end-to-end. Smallest fix, biggest
   unblock.
2. **Slice B verification immediately after.** Once Slice A passes
   the drain test, inspect `propagate:b2bua-worker-0` on the survivor
   to confirm takeover writes are flowing back. If they're not, this
   slice grows; if they are, it's a one-liner test.
3. **Slice D readiness check** before Slice C, because Slice C's
   test depends on the readiness probe gating routing during the
   primary-return window.
4. **Slice C** last — needs a new sipp scenario and a new test file,
   but builds on A–B–D being correct.

## What this plan deliberately does NOT touch

- The `select_new` LB hashing logic. It's correct as a fallback when
  a cookie is absent or invalid; we now know cookies are reaching
  the proxy reliably, so this code path runs only on legitimate
  fresh INVITEs.
- The proxy's response forwarding. Already verified RFC-compliant
  (only strips topmost Via).
- The B2BUA's A-leg UAS Record-Route reflection. Already verified to
  copy `aLegInvite.headers`'s Record-Route onto dialog-creating 2xx.
- Hybrid harness regression risk. Use a separate values file when
  the hybrid suite needs `127.0.0.1` again; do not revert the
  in-cluster default.
