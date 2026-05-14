# 2026-05-14 — Unintentional self-DoS via unresolvable b-leg target

> One toxic test scenario + one pre-existing URL-encoding bug + one
> sequential UDP ingress consumer = the entire kind cluster's
> `sip-front-proxy` stopped responding to **any** new INVITE for as
> long as the worker kept retransmitting. With the encoding bug, that
> was indefinite. Even after fixing it, the cluster needs a full
> RFC 3261 Timer B cycle (~32 s) per stuck call to recover.

## TL;DR

- **Trigger**: `E2E_KIND=1 npx vitest run tests/fullcall/e2e-register-fakeExt-realCore.test.ts` — the registrar scenario routes b-leg INVITEs to `sip:bob@kindlab`. `kindlab` is **not resolvable** from inside the kind cluster (no CoreDNS rewrite, no hostAlias).
- **Hot loop**: every retransmit of the stuck b-leg INVITE makes the proxy call `dgram.send(..., "kindlab")` → libuv `getaddrinfo("kindlab")` → blocks ~5 s for `EAI_AGAIN` → 503 synthesized.
- **Chokepoint**: the proxy's external UDP ingress stream is consumed *sequentially* by `Stream.runForEach`. While one packet is awaiting DNS, **every other inbound packet** (including bare `sipp -s uac` INVITEs from operators) is queued, not processed.
- **Amplifier (pre-existing bug)**: `extractViaCustomParams` returned the raw, URL-encoded `cr=` Via param. Production callRefs (`worker-N|UUID@host|tag`) always contain `|` and `@` ⇒ always encoded ⇒ `TransactionLayer.txnMap` stored the encoded form ⇒ `cancelTxnsForCall(decodedCallRef)` never matched ⇒ call eviction silently failed to stop the retransmit fiber ⇒ what should have been a 32 s self-clearing wedge became unbounded.
- **Fix shipped**: decode `cr`/`lg` in [src/sip/TransactionLayer.ts:125-141](../../src/sip/TransactionLayer.ts#L125-L141) + regression test T5 in [tests/sip/transaction-layer-cancel-on-evict.test.ts](../../tests/sip/transaction-layer-cancel-on-evict.test.ts). Removes the amplifier; the 32 s self-clear is restored.
- **Still open**: the 32 s window is itself a DoS exposure. Mitigation plan below.

## Symptom timeline (the observable surface)

```
14:43  reset.sh creates fresh kind cluster
14:45  sipp -s uac 172.20.255.250:5060 → 100 / 180 / 200 / 200  ✓
15:13  E2E_KIND=1 vitest run e2e-register-fakeExt-realCore  (2 pass / 1 fail, 32 s)
15:14  sipp -s uac …  →  TIMEOUT, sipp exit=1, NO 100 Trying
       repeat ×5      →  TIMEOUT every time
       …
       (pre-fix: never recovers)
       (post-fix: recovers ~32 s after the last stuck call's INVITE was sent)
```

What was happening behind the symptom: tcpdump confirmed SIPp's INVITE packets reached the VIP-owning node's `eth0`. The proxy's UDP socket had `Recv-Q=0` (kernel had delivered the packets to the JS layer). But the proxy never logged the call-id. The bytes were being read off the socket and into the Effect stream — and then sitting in the stream's pending buffer behind tens of seconds of `getaddrinfo("kindlab")` waits.

## The exact path (sequence)

```
  sipp (host)            kind sip-front-proxy            libuv DNS pool          b2bua-worker
  172.20.0.1             (Node, UDP socket                (4 OS threads,         (b-leg-5 retransmit
                          bound to VIP:5060)                getaddrinfo)          fiber, RFC 3261 §17.1)
       │                            │                            │                          │
       │                            │   ← INVITE b-leg retransmit (CSeq 5) ────────────────│
       │                            │                            │                          │
       │       Stream.runForEach pulls ONE packet at a time.
       │       processPacket(retransmit) runs:
       │         1. parse SIP
       │         2. decision=worker_outbound, target.host="kindlab"
       │         3. sendOn(extEndpoint, buf, target)
       │              dgram.send(buf, 5060, "kindlab")  ──────►  │
       │                                                         │
       │                                                  uv_getaddrinfo("kindlab")
       │                                                  thread-1 BLOCKED ≈ 5 s
       │                                                  → EAI_AGAIN
       │  INVITE  ─────────────────►│                            │                          │
       │  (sipp -s uac, dst VIP)    │ ●●● queued in Stream.runForEach (sequential)
       │                            │     because processPacket is awaiting DNS
       │                            │
       │  INVITE retransmit #1 (T1) │  still queued
       │  ──────────────────────►   │
       │                            │
       │  INVITE retransmit #2      │  still queued
       │  (2·T1) ───────────────►   │
       │                            │     ← DNS returns EAI_AGAIN (≈ +5 s)
       │                            │   4. result=false  →  generateResponse(503)
       │                            │   5. replyToSource(503) ─────────────────────────►   │
       │                            │   6. NEXT packet dequeued: ANOTHER b-leg retransmit
       │                            │   7. dgram.send → kindlab → 5 s wait again …
       │                            │
       │  sipp -timeout fires       │  by the time the queue drains far enough
       │  → exit code 1             │  to reach sipp's INVITE, sipp has given up
       │                            │
       │                            ●  one stuck call's retransmit fiber alone
       │                               keeps the proxy stream occupied for the
       │                               full 32 s of Timer B (RFC 3261 §17.1.1.2)
```

## Why the system was vulnerable — three layers compounded

| # | Layer | Defect | Where | Impact |
|---|-------|--------|-------|--------|
| 1 | Routing | call-control returns `kindlab` as target; cluster has no rewrite for it. | `tests/scenarios/registrar/k8s-register-call-bye.ts` and friends; call-control mock | Any outbound packet to this destination must DNS-resolve. |
| 2 | DNS resolver | `dgram.send(host)` ⇒ Node's `dns.lookup` ⇒ libuv `getaddrinfo` with a ~5 s OS-level timeout for `EAI_AGAIN`. | upstream Node behaviour | Single unresolvable hostname = ~5 s libuv thread blocked per send. |
| 3 | Stream consumer | `Stream.runForEach(extEndpoint.messages, processPacket)` is strictly sequential. | [src/sip-front-proxy/ProxyCore.ts:496-498](../../src/sip-front-proxy/ProxyCore.ts#L496-L498) | One slow packet blocks every subsequent packet on the same endpoint, including sipp's. |
| 4 | Encoding (amplifier) | `extractViaCustomParams` returned raw URL-encoded `cr=` value; `buildCallVia` encodes; `TransactionLayer.cancelTxnsForCall` did `txn.callRef === callRef` (encoded vs decoded). | [src/sip/TransactionLayer.ts:125-131](../../src/sip/TransactionLayer.ts#L125-L131) pre-fix, [src/b2bua/stack-identity.ts:32](../../src/b2bua/stack-identity.ts#L32) | Call eviction never cancelled its own retransmit fibers ⇒ 32 s wedge became unbounded. |

Layers 1+2+3 together make a 32 s self-DoS window per stuck call. Layer 4 turned that window into an indefinite wedge.

## Why each defect existed

- **(1)** The test was written assuming the cluster could resolve `kindlab` (it never could; the assumption was implicit). No CI gate verifies that scenario URIs resolve from inside pods.
- **(2)** Default Node + libuv behaviour. The 5 s `EAI_AGAIN` retry comes from glibc's `nsswitch` + DNS resolver defaults; we never tuned it.
- **(3)** The sequential `runForEach` was the simplest correct shape when ProxyCore was written. Concurrency was deferred ("optimize later if needed"). It hadn't bitten until a per-send blocking operation appeared in the hot path.
- **(4)** Every unit test uses callRefs without special chars (e.g. `cr=call-ref-1`) — the encoding bug was silent for the lifetime of the codebase. Production callRefs (`worker-N|UUID@host|tag`) always contain `|` and `@`.

## What was actually fixed in this incident

| Patch | Location | Purpose |
|---|---|---|
| Decode `cr`/`lg` from Via params | [src/sip/TransactionLayer.ts:125-141](../../src/sip/TransactionLayer.ts#L125-L141) | Make `cancelTxnsForCall` actually match; make timer events resolvable in SipRouter's `withCall`. |
| Regression test T5 with `encodeURIComponent`'d Via | [tests/sip/transaction-layer-cancel-on-evict.test.ts](../../tests/sip/transaction-layer-cancel-on-evict.test.ts) | Lock the decode behaviour; a future revert would break the test. |
| `sendOn → Effect<boolean>` + 503 synthesis on send failure (LB mode) | [src/sip-front-proxy/ProxyCore.ts:337-350, 946-976](../../src/sip-front-proxy/ProxyCore.ts#L337) | The previous "always log `result=forwarded`" hid the issue; the worker also kept retransmitting because it never got a definitive response. Both fixed by surfacing the failure as a real 503. |
| Same mirror in registrar mode | [src/sip-front-proxy/ProxyCore.ts:1407-1480](../../src/sip-front-proxy/ProxyCore.ts#L1407) | Symmetry. |
| `TransactionLayer.cancelTxnsForCall` API + wiring into 4 CallState eviction paths | [TransactionLayer.ts:423-438](../../src/sip/TransactionLayer.ts#L423-L438), [CallState.ts:177-181, :404, :580, :705, :823](../../src/call/CallState.ts#L177) | Kill retransmit fibers when their owning call dies. Was the *intended* fix; only works now that (4) is fixed. |
| `zombieTimeoutTotal` diagnostic + ERROR-level log | [SipRouter.ts:289-295, :742-750](../../src/sip/SipRouter.ts#L289) | Loud signal if any eviction path is missed in future. |

## Still open after this incident

1. **The 32 s recovery window**. Even with the encoding bug fixed, a single stuck call's RFC 3261 Timer B cycle (~32 s) is enough to wedge the proxy's ingress for that entire window because of layers 1+2+3 above. This **is** still an availability bug. The defence plan is below.
2. **`noopFallback` doesn't terminate on unhandled finals**. [src/b2bua/B2buaCore.ts:71-95](../../src/b2bua/B2buaCore.ts#L71-L95) logs `[rule-fallback] Unhandled sip:503 state=active` and returns no effects. The call stays active until orphan sweep (60 s) or the rule chain handles it elsewhere — meanwhile its b-leg keeps retransmitting. A tail rule that promotes unhandled 4xx-6xx finals on a non-confirmed b-leg to `terminateCallEffects` would close this.
3. **The `k8sRegisterCallReroute` scenario itself fails**. Failure mode is "expected response shape doesn't match"; not investigated in this incident but it is what's exposing (2). Separate task.

## Defence plan (ranked, with cost)

### Tier 0 — admission-time validation (cheap, eliminates the class)

- **0a.** Reject non-IP-literal targets at the worker's `applyRoute` boundary. If call-control returns `host` that doesn't match `^\d+\.\d+\.\d+\.\d+$` or a bracketed IPv6 literal, fail the call with `503 Bad Gateway` *before* the b-leg is spawned. The DNS hot path becomes unreachable.
- **0b.** If hostnames are unavoidable, pre-resolve **once** at call setup with `Effect.timeout(500ms)` around `dns.resolve4`, cache success for 60 s + failure for 10 s. The hot path always sees an IP.

### Tier 1 — bound the blast radius per send (small change, big effect)

- **1a.** Replace `Stream.runForEach(messages, processPacket)` with `Stream.mapEffect(processPacket, { concurrency: 32 }) ; runDrain`. One slow packet no longer blocks the next on the same endpoint. Verify cancelLru / Record-Route stamping doesn't rely on serialization (it shouldn't — RFC 3261 §16 doesn't require it).
- **1b.** Wrap each `sendOn` call in `Effect.timeout(Duration.millis(500))`. On timeout, route through the same `SendError` path that we already 503-synthesize on. No single send can hog its processing slot for more than 500 ms.

### Tier 2 — per-destination circuit breaker (defence in depth)

- **2.** A `SendCircuitBreaker` keyed by `${host}:${port}` with `CLOSED → (3 failures in 5 s) → OPEN (30 s) → HALF_OPEN`. While OPEN, `sendOn` returns `Effect.succeed(false)` without touching the socket or DNS. Even if (0a) is bypassed and (1b)'s timeout is too generous, a cascading destination is contained.

### Tier 3 — observability (cheap, catches future regressions)

- **3a.** Export `b2bua_send_errors_total{reason=EAI_AGAIN|EAI_NONAME|EHOSTUNREACH|TIMEOUT}` from the proxy. Alert at >5/s.
- **3b.** Export the proxy's ingress queue lag (`b2bua_proxy_ingress_lag_p95_ms`). A sequential-consumer wedge spikes this from <1 ms to >100 ms within one packet.
- **3c.** Wire `b2bua_zombie_timeout_total` and `b2bua_txn_cancelled_on_call_evict_total` into the `/metrics` exporter (currently in the metrics struct but not serialized) and assert the former is 0 at the end of every k8s test.

### Recommended minimum set

- **Today**: Tier 0a + Tier 1b. Combined ≈ 40 lines, no architectural shift. Eliminates the class.
- **This week**: Tier 1a so a single slow target can never block the proxy's ingress again, even if Tier 0 misses a vector.
- **Defence in depth**: Tier 2 + Tier 3, alongside the `noopFallback`-on-final-failure fix from #2 above.

## Lessons

- **A blocking call in a sequential stream consumer is a latent DoS.** Once it appeared on the hot path, the chokepoint exposed itself within one test run. Always treat per-packet handler latency as a SLO, not as a "good enough until proven otherwise."
- **Encoding asymmetries hide in test suites that use ASCII-only fixtures.** The transaction-layer encoding bug existed since `buildCallVia` started encoding callRefs; it never tripped a unit test because every fixture uses `cr=simple-ref`. Fix the *fixtures* to match production shape (callRefs with `|` and `@`) and the next such bug fails on commit.
- **A "fix" that depends on equality of two strings derived from different transforms is one transform-change away from being a silent no-op.** The `cancelTxnsForCall` fix landed and passed every test — the test was using the same un-encoded shape both sides. The reproducer that catches the production bug is the one that uses `encodeURIComponent` on one side. Always cross-shape your invariants in tests.
- **"Result=forwarded" was a load-bearing lie.** The misleading log line masked a stream of EAI_AGAIN-followed-by-pretend-success for hours of debugging in the original investigation. When you write a result label, it has to mean what it says or it becomes an active liability.

## Cross-references

- Plan that drove the cancelTxnsForCall + 503 synthesis work: [.claude/plans/2026-05-14-three-bug-fixes.md](../../.claude/plans/2026-05-14-three-bug-fixes.md)
- Reset / nominal-state script written during the same investigation: [tests/k8s/scripts/reset.sh](../../tests/k8s/scripts/reset.sh)
- The DoS surface is independent of the [overload-protection](../overload-protection.md) tier 1–3 mechanism — overload protection guards admission rate, not per-packet handler latency. Both are needed.
- RFC anchors: §17.1.1 INVITE client state + Timer B (64×T1); §17.1.1.3 hop-by-hop ACK on non-2xx; §16.6.10 stateful-proxy `503 Service Unavailable` for unreachable downstream.
