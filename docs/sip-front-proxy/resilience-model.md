# SIP Front Proxy — Resilience Model (D-RES)

**Status:** Phase 1 Reference. Updated through PR4 (DrainingState +
HealthProbe + transparency suite). Owner: SIP Front Proxy spec.

This document captures the **observable behaviour** the proxy guarantees
when workers are healthy, draining, or dead — broken down per SIP
message type — together with the timing assumptions and the failure
modes the proxy explicitly does **not** mitigate.

It complements (and supersedes the in-flight notes inside)
[`docs/todos/SIP-Front-Proxy.md`](../todos/SIP-Front-Proxy.md). When the
plan and this doc disagree, this doc wins.

---

## 1. Per-message-type behaviour matrix

Columns describe the resolved-worker state observed from the proxy's
local view. "Pre-grace" / "post-grace" refer to whether the in-dialog
grace window (`drainGraceMs`, default 5 s) has elapsed since the worker
first transitioned to `draining`. The proxy reads this from
`WorkerEntry.drainingSince` stamped at health-flip time.

| Message              | `alive`                                    | `draining` (pre-grace)                      | `draining` (post-grace)                                       | `dead`                                                       |
|----------------------|--------------------------------------------|---------------------------------------------|---------------------------------------------------------------|--------------------------------------------------------------|
| **Initial INVITE**   | Rendezvous-pick a live worker (HRW); insert Record-Route stickiness cookie. | Excluded from `selectForNewDialog` candidate set. | Excluded.                                                     | Excluded.                                                    |
| **Re-INVITE / UPDATE / INFO / REFER / NOTIFY** | Decode cookie → forward to original worker. | Decode cookie → forward to original worker. | Cookie decode returns `unknown` → fall back to `selectForNewDialog`; new worker hydrates from Redis (best-effort). On hydration miss the new worker replies 481 Call/Transaction Does Not Exist (RFC 3261 §12.2.2). | Cookie decode returns `unknown` → fall back via `selectForNewDialog`. Same hydration-miss → 481 fate. |
| **BYE**              | Decode cookie → forward to original worker. | Forward to original worker.                 | Same as above (post-grace fallback + Redis hydration).        | Same as above.                                                |
| **CANCEL**           | Always forward to original worker (LRU + ACK/CANCEL exemption in `decodeStickiness`). RFC 3261 §9.1: CANCEL must hit the same UAS server transaction. | Forward to original worker.                 | **Forward to original worker — exempt from grace window.** Only that worker holds the INVITE server transaction. | Forward to original worker (best-effort; will likely time out). UAC's CANCEL Timer F provides the ceiling. |
| **ACK on 2xx**       | Decode cookie → forward to original worker. | Forward to original worker.                 | **Forward to original worker — exempt from grace window.** Only the worker that issued the 2xx can match the ACK to its INVITE transaction (RFC 3261 §13.2.2.4). | Forward to original worker (best-effort).                    |
| **ACK on non-2xx**   | Absorbed by the worker's `TransactionLayer` (RFC 3261 §17.1.1.3) or by an upstream proxy with `Record-Route`. Front proxy never sees these in steady state — they're hop-by-hop. | n/a | n/a | n/a |
| **OPTIONS** (out-of-dialog) | Worker replies `200 OK` (RFC 3261 §11). | Worker replies `503 Service Unavailable` + `Retry-After: 0` (RFC 3261 §21.5.4 + §20.33). | Worker still replies `503` (state unchanged after grace until termination). | Worker is unresponsive; HealthProbe sees timeout. |
| **OPTIONS** (in-dialog) | Decode cookie → forward to original worker (transparent relay). | Forward to original worker. | Post-grace fallback. | Post-grace fallback. |
| **100 Trying**       | Hop-by-hop; absorbed by the receiving stack (RFC 3261 §8.1.3.4 / §17.2.3). Never traverses the proxy's response path because it carries no Via the proxy added. | n/a | n/a | n/a |
| **1xx provisional (>100)** | Forwarded back along the Via stack (RFC 3261 §16.7.3): proxy pops its own top Via, forwards to next Via's `received`/`rport`/`sent-by`. | same | same | same — once the response is in flight, the proxy's role is purely Via-pop; worker health is moot. |
| **2xx final**        | Forward via Via stripping. Stickiness cookie was inserted on the request path; the response path doesn't consult worker health. | same | same | same |
| **non-2xx final** (3xx-6xx) | Forward via Via stripping. | same | same | same |

### Notes on the matrix

- **Stickiness lookup is always the cookie**, not the registry —
  `LoadBalancerStrategy.decodeStickiness` re-derives the worker from the
  HMAC-signed `;w=…;sig=…` URI param every time. Even after a worker
  has been reaped from the registry the cookie still names it; we then
  fall back via `selectForNewDialog` (`unknown` decode result).
- **ACK/CANCEL exemption** is implemented in
  `LoadBalancerStrategy.decodeStickiness` by branching on `msg.method`
  before consulting `health` / `drainingSince`. See the comment block in
  [`src/sip-front-proxy/strategies/LoadBalancer.ts`](../../src/sip-front-proxy/strategies/LoadBalancer.ts).
- **CANCEL** has a second routing path: `CancelBranchLru`. This is
  keyed on `(Call-ID, CSeq number)` (PR3b) and serves as a fallback
  when the cookie's worker can't be resolved. The LRU never consults
  health.
- **481 on hydration miss** is the worker's default-deny fallback for
  unknown-callRef in-dialog requests (`SipRouter.withCall`). The proxy
  doesn't synthesize 481 itself; the new worker that picked up the
  fallback emits it.

---

## 2. Timing assumptions

| Parameter                                  | Value                | Source                                        | Why                                                                                           |
|--------------------------------------------|----------------------|-----------------------------------------------|-----------------------------------------------------------------------------------------------|
| K8s `terminationGracePeriodSeconds`        | ≥ 200 s (180 + 20 safety) | Helm chart (PR5)                          | RFC 3261 Timer C: max INVITE establishment is 180 s. CANCELs to in-flight INVITEs must reach the original worker for the entire window. |
| Proxy `drainGraceMs`                       | 5 000 ms (default)   | `LoadBalancerConfig.drainGracePolicyMs`      | Bound for in-dialog re-INVITE / UPDATE / INFO / REFER fallback. ACK/CANCEL exempt.            |
| `HealthProbe.optionsKeepalive` interval    | 1 000 ms             | `OptionsKeepaliveOpts.intervalMs`             | Cheap enough at `O(N) workers` — N≤32 in normal deployments.                                 |
| `HealthProbe.optionsKeepalive` timeout     | 1 500 ms             | `OptionsKeepaliveOpts.timeoutMs`              | Wide enough to absorb 99p UDP RTT inside a K8s cluster (typ. <50 ms) plus worker scheduling. |
| `HealthProbe.optionsKeepalive` threshold   | 2 misses             | `OptionsKeepaliveOpts.threshold`              | 2 × 1 s = **2 s worst-case detection lag** for hard-crash without K8s signal.                |
| HMAC key overlap window                    | 1 h (NFR-8)          | `HmacKeyProvider.staticOpts`                  | Lets the proxy fleet roll a new key without rejecting in-flight cookies signed by the previous one. |
| Stateless 503 `Retry-After`                | 5 s base + jitter    | `AppConfig.retryAfterBaseSec` / `…JitterSec`  | Used by Tier-3 overflow rejects (separate from drain).                                       |

The plan's "AC-6 P99 routing latency < 2 ms at 5 K msg/s" target is met
in synthetic tests; this doc treats it as an SLO rather than a
resilience parameter.

---

## 3. Failure modes NOT mitigated (Phase 1)

These are intentional gaps — Phase 1 documents them so operators can
plan around them without expecting silent recovery.

1. **UDP loss on the proxy ↔ worker hop.** Stateless proxy: no
   retransmits. Lost INVITE / 200 / ACK on this hop is invisible to
   the proxy. Recovery is the UAC's Timer A / Timer F (RFC 3261 §17.1.1
   / §17.1.2.2) and the worker's INVITE server-transaction
   retransmissions — both reach all the way back to the UAC.
2. **K8s watch outage.** `WorkerRegistry.kubernetesStatefulSet` (PR5)
   degrades to "stale snapshot": no new pods are added, no pod-IP
   rotations are observed, no deletion-timestamp accelerant. The
   `HealthProbe.optionsKeepalive` continues to demote silent workers,
   so the snapshot self-heals to the operative subset on a
   threshold-cycle delay (~2 s).
3. **Multi-pod CANCEL LRU split.** Each proxy pod holds its own
   `CancelBranchLru`. A CANCEL that hashes to a different proxy pod
   than the one that admitted the INVITE will not find an LRU entry
   and will fall back via the cookie path. This works in practice
   when (a) the upstream LB uses src-IP affinity (kube-proxy
   `externalTrafficPolicy: Local` + consistent-hash VIP), or (b) the
   stickiness cookie is intact (the `unknown` cookie path can't kick
   in for an in-dialog CANCEL because CANCEL is out-of-dialog —
   §9.1 reuses the original branch only). When both fail the CANCEL
   is dropped; the UAC's Timer C then expires and the INVITE
   eventually 408s back.
4. **Stickiness cookie tampering.** Detected as
   `DecodeResult.reject(403)` and replied to the UA. Not a recoverable
   failure mode — the message is dropped and the UA sees a 403.
5. **Worker crashes mid-INVITE.** The worker's INVITE server
   transaction is gone. CANCEL still routes to the dead worker per
   matrix; UAC times out. The new worker (post-grace) can't recover
   the INVITE because its branch is gone.
6. **Redis hydration miss on fallback.** Documented in matrix as `481`.
   Phase 2 may add cross-worker call-state replication to lift this.
7. **Probe-side UDP packet loss.** A single missed reply increments
   the consecutive-miss counter; one stray miss does NOT demote a
   worker (threshold ≥ 2). The threshold buys headroom against the
   typical-case loss rate.
8. **Path header (RFC 3327).** Out of scope for Phase 1. SIP REGISTER
   flows that need Path will not pass through this proxy until it's
   added.

---

## 4. Recovery flow (post-grace fallback)

Sequence when a draining worker's grace window has elapsed and an
in-dialog re-INVITE arrives:

```
Alice ──(re-INVITE w/ Route → proxy)──▶ Proxy
                                          │
                                          ├─ decodeStickiness
                                          │   cookie names worker A
                                          │   A.health = draining
                                          │   now − A.drainingSince > drainGraceMs
                                          │   → DecodeResult.unknown
                                          │
                                          ├─ selectForNewDialog (rendezvous)
                                          │   alive workers: [B]
                                          │   → B
                                          │
                                          └─(re-INVITE w/ Route → proxy)──▶ Worker B
                                                                              │
                                                                              ├─ resolveFromRequest
                                                                              │   no callRef in URI → callId+fromTag fallback
                                                                              │   B's CallStateCache miss
                                                                              │   → CallState.hydrateFromRedis
                                                                              │
                                                                              ├─ on hydration HIT:
                                                                              │   re-INVITE handled normally
                                                                              │   200 OK back to Alice
                                                                              │
                                                                              └─ on hydration MISS:
                                                                                  reject 481 Call/Transaction Does Not Exist
                                                                                  (RFC 3261 §12.2.2)
                                                                                  Alice's UA decides recovery (BYE + new INVITE)
```

Notes:

- The re-INVITE bytes the proxy forwards to B are byte-identical to
  what B's transaction layer would receive in a steady-state initial
  INVITE — the cookie + Record-Route are still on the request, B
  treats it as in-dialog (To-tag present).
- Hydration is best-effort: the worker that originally owned the call
  must have flushed state before its drain. Workers flush on
  `confirm-dialog`, `relay-bye`, and on every state-mutating action's
  `flush-redis` side effect — so the steady-state hydration hit-rate
  is high.
- Worker A keeps serving the call up until its OS-level `SIGKILL`
  (after `terminationGracePeriodSeconds`). For ACK / CANCEL the proxy
  always reaches A regardless of hydration status — the matrix
  exemption is the recovery mechanism for those.

---

## 5. Verification

The behaviours above are exercised by:

- [`tests/sip-front-proxy/transparency/draining.test.ts`](../../tests/sip-front-proxy/transparency/draining.test.ts)
  — pre/post-grace fallback + ACK exemption.
- [`tests/sip-front-proxy/transparency/health-probe.test.ts`](../../tests/sip-front-proxy/transparency/health-probe.test.ts)
  — `200/503/timeout` → `alive/draining/dead` translation.
- [`tests/b2bua/draining-options.test.ts`](../../tests/b2bua/draining-options.test.ts)
  — worker-side OPTIONS handler (200 vs 503 + Retry-After: 0).
- [`tests/sip-front-proxy/transparency/{happy-call,cancel-during-ringing,reinvite}.test.ts`](../../tests/sip-front-proxy/transparency/)
  — topology-parameterized transparency: behaviour identical with /
  without the proxy.

Each test runs under `vitest.config.fake.ts` (TestClock + simulated
UDP). PR5 will add `kind`-based integration tests against a real
cluster.
