# Plan: fix in-dialog routing for long-hold calls (k8s endurance)

## Context

A 1-hour k8s endurance run (`test-results/k8s-endurance/endurance-1h-noproxy-20260508-085938/`)
showed **610/610 long-hold calls failed with BYE → 481 Call/Transaction Does Not
Exist**, while the short stream succeeded at ~99.99% (64764/65282). The failures
are deterministic, not chaos-related — only 25 of the 610 sit in chaos windows
and the rest are STEADY/PRE_WARMUP. Worker logs show the b2bua's keepalive
OPTIONS (sent every `keepaliveIntervalSec`, default 900s) never reaches the
sipp UAC; with no 200 reply, `keepaliveTimeoutRule` fires `begin-termination`,
the call moves to `terminating`, the orphan sweep reaps it (~919s sweep age,
matching the 15-min interval + grace), and the UAC's BYE at minute 20 lands on
a missing dialog. Short calls don't see this because their 30s hold ends well
before the 15-min keepalive timer.

The intended outcome of this plan: long-hold calls succeed end-to-end through
the proxy+b2bua topology, and the test harness gains coverage that would have
caught the bug under TestClock, plus regression coverage for the same bug class
on relayed mid-dialog requests (re-INVITE, INFO).

## Root cause (two-layered)

### Layer 1 — worker deployment (primary)

`tests/k8s/values/b2bua-worker.yaml` and `deploy/helm/b2bua-worker/values.yaml`
both leave `extraEnv: []`. Neither sets `B2B_OUTBOUND_PROXY`, so
`AppConfig.b2bOutboundProxy` is undefined ([src/config/AppConfig.ts:158](../../src/config/AppConfig.ts#L158)).

Consequence:
- `helpers.ts` does not preload `Route: <sip:proxy:5060;lr;outbound>` on the
  b-leg INVITE ([src/b2bua/helpers.ts:322-331](../../src/b2bua/helpers.ts#L322-L331)).
- The b-leg INVITE goes worker-direct to UAS sipp (no proxy hop).
- UAS sipp's 200 OK carries no Record-Route.
- `confirm-dialog` extracts an empty routeSet ([ActionExecutor.ts:1054-1055](../../src/b2bua/rules/framework/ActionExecutor.ts#L1054-L1055)).
- 15 min later, b-leg keepalive OPTIONS goes worker-direct to sipp's pod IP
  via `applyRouteSet` ([ActionExecutor.ts:1296](../../src/b2bua/rules/framework/ActionExecutor.ts#L1296)),
  bypassing the proxy entirely.

The fake-stack tests do not reproduce this because
`tests/support/proxyB2bFakeStack.ts:96` and `tests/support/k8sFakeStack.ts:146`
both hardcode `b2bOutboundProxy`.

### Layer 2 — proxy classification (latent bug, still surfaces after Layer 1 fix)

When in-dialog OPTIONS *does* reach the proxy via the a-leg routeSet (which is
populated correctly because the front-proxy Record-Routes inbound INVITEs),
the proxy must classify it as "worker-outbound" so it forwards to the R-URI
(sipp). [ProxyCore.ts:600-654](../../src/sip-front-proxy/ProxyCore.ts#L600-L654)
uses two triggers:

1. `;outbound` URI param on the top-Route header — only on the *initial*
   preloaded Route. In-dialog requests don't carry it.
2. **Source IP:port matches a registered worker** (`registry.lookupByAddress`)
   — the only signal for in-dialog requests.

If trigger #2 misses (registry stale, post-restart window, port mismatch), the
proxy decodes the stickiness cookie in the inserted Record-Route and routes
the worker's own OPTIONS *back to the source worker* — the loopback we observe
as `Unroutable OPTIONS sip:sipp@10.244.5.5:5060 from 10.244.3.2:5060`
(465 occurrences, the proxy's IP as source). The worker can't match the call
because the sipIndex fallback only keys by `callId|fromTag` from the external
party's perspective, while a b2bua-originated request carries the b2bua's own
fromTag — see [SipRouter.ts:599](../../src/sip/SipRouter.ts#L599) and
[CallState.ts:223-231](../../src/call/CallState.ts#L223-L231) (b-leg already
has both keys; a-leg is single-keyed).

### Same bug class on mid-dialog relays

`relayReinviteRule`, `relayInfoRule`, `relayUpdateRule`, `relayMessageRule`
([src/b2bua/rules/defaults/](../../src/b2bua/rules/defaults/)) emit
`send-request-to-leg` to forward UAC-initiated mid-dialog requests through
the same egress path. Any UAC-initiated re-INVITE/INFO would hit the same
b-leg routing problem. The current `uac-endurance-short.xml` exercises no
mid-dialog activity, so this entire class of bug is invisible to the
short-cadence stream.

## Implementation pillars

### A. Deployment fix

**A.1** — `tests/k8s/values/b2bua-worker.yaml`
Append to the existing `extraEnv:` list (after `CALL_CONTROL_URL`):

```yaml
  # B-leg outbound proxy. With this set, the worker preloads
  # `Route: <sip:sip-front-proxy:5060;lr;outbound>` on the b-leg
  # INVITE. The proxy then Record-Routes the b-leg, the response
  # carries Record-Route, confirm-dialog populates the b-leg
  # routeSet, and subsequent in-dialog requests (keepalive OPTIONS,
  # relay re-INVITE, INFO, BYE) flow back through the proxy.
  # Without this, the b-leg routeSet stays empty and the 15-min
  # keepalive tears down every long-hold call.
  - name: B2B_OUTBOUND_PROXY
    value: "sip-front-proxy:5060"
```

**A.2** — `deploy/helm/b2bua-worker/values.yaml`
Replace the bare `extraEnv: []` line with a documented, commented-out sample.
Default stays empty (preserves backward compat for standalone-worker installs);
the comment block makes the wiring requirement explicit.

```yaml
# B-leg outbound proxy. REQUIRED when this chart is deployed alongside
# the sip-front-proxy chart in the same namespace — without it,
# in-dialog requests originated by the B2BUA (keepalive OPTIONS, relay
# re-INVITE, relay INFO, relay UPDATE, BYE) bypass the proxy and after
# 15 min (default keepaliveIntervalSec) every long-hold call is torn
# down by the worker's own keepaliveTimeoutRule. Format "host:port".
extraEnv: []
# Example for the typical co-deployed topology:
# extraEnv:
#   - name: B2B_OUTBOUND_PROXY
#     value: "sip-front-proxy:5060"
```

**A.3** — `deploy/helm/b2bua-worker/README.md`
Add a one-paragraph note under Configuration referencing
`B2B_OUTBOUND_PROXY` and the failure mode it prevents.

### B. Sipp scenario extension

**B.1** — `tests/k8s/charts/sipp/scenarios/uac-endurance-short.xml`
Insert a UAC-initiated re-INVITE between ACK and BYE. Re-INVITE exercises the
relay-reinvite egress path (same code as keepalive OPTIONS) plus SDP
renegotiation, mirroring the existing `uac-pingpong.xml` shape. Total active
phase stays ~30s by splitting the existing 30000ms pause into 10000ms +
re-INVITE round-trip + 20000ms.

Bumps:
- New `<send>` for `CSeq: 2 INVITE` with `[routes]` and SDP.
- `<recv response="100" optional="true"/>` and `<recv response="200"/>`.
- ACK with `CSeq: 2 ACK`.
- The trailing BYE bumps from `CSeq: 2 BYE` to `CSeq: 3 BYE`.

INFO is intentionally not added in this slice — re-INVITE covers the routing
path; if a future regression specifically wants INFO coverage, it's an
additive change.

### C. New fake-clock regression scenario

**C.1** — extend `tests/support/proxyB2bFakeStack.ts` (and the matching
`sipproxyHA` fake stack) with an opt-in `simulateMissingOutboundProxy?:
boolean` flag. When set, the layer does NOT inject `b2bOutboundProxy` into the
worker config — reproducing the production deployment shape that caused the
k8s bug. Plumb the flag through `createSimulatedRunner` /
`createSimulatedTransport` symmetrically across `proxy+b2b`, `sipproxyHA`, and
`k8sFailover` SUTs. Keep `b2bonly` unchanged (it never sets the outbound
proxy).

**C.2** — new file `tests/scenarios/keepalive-via-proxy.ts`. Two scenarios:

- `keepaliveViaProxy` — happy path. Default `b2bOutboundProxy` set. Build
  alice/bob agents, advance TestClock past `KEEPALIVE_INTERVAL_MS` twice, and
  assert that both Bob's and Alice's incoming OPTIONS each carry **≥2 Via
  headers** (the proxy adds a second Via above the worker's). Asserts no
  `Unroutable` warning on the worker (use the test logger sink). Asserts the
  call is still in established state at end. `runOn(["proxy+b2b",
  "sipproxyHA"])`.

- `keepaliveMissingOutboundProxyRegressionGuard` — same scenario, but built
  with `simulateMissingOutboundProxy: true` plus a Bob agent that does not
  Record-Route. Today's expected behavior: keepalive OPTIONS sent worker-direct
  to Bob (b-leg routeSet empty). Assertion: the test FAILS if the OPTIONS
  carries ≥2 Via (i.e., went through the proxy). This documents the current
  fragility in code so any future change that "fixes" in-dialog wire-rewrite
  via `b2bOutboundProxy` flips this scenario red and forces a re-evaluation.
  Marked clearly as a *bug-presence* test, not a regression on a fix.

**C.3** — wire both scenarios into `tests/fullcall/e2e-fake-clock.test.ts`
inside the SUT-matrix loop, gated by their `appliesTo(sut)` predicates.

### D. Defensive sipIndex toTag fallback

**D.1** — `src/call/CallState.ts:223`
The b-leg block (lines 224-232) already indexes by both `callId|fromTag` and
`callId|<each dialog.remoteTag>`. Mirror the same pattern for a-leg by adding
a loop over `call.aLeg.dialogs` and indexing each `dialog.sip.localTag`
(non-empty). Mirror the cleanup block in `remove()` around lines 391-401. This
makes a worker self-resolve a request looped back through a misbehaving proxy
instead of returning 481.

Add a structured warning if `MutableHashMap.set` would overwrite a different
`callRef` for the same key — surfaces any cross-call collision instead of
silently overwriting.

### E. Proxy classification — diagnose + fix

**E.1 — diagnose**: instrument `ProxyCore.ts:600-654` to log, at WARN level,
every packet that:

- Carries a top-Route URI matching the proxy's advertised address (so it's
  the proxy's own Record-Route returning), AND
- Has `strippedRouteParams` set (stickiness cookie present), AND
- Whose source-IP lookup misses (`isWorkerOutbound` stays false after the
  source-based override at lines 645-654).

That's the exact precondition for the loopback. Log includes
`{ method, callId, srcIp, srcPort, decodedWorker, registrySize }`. Run the
endurance harness against the helm fix (Pillar A) and confirm whether the
warning fires. If it does, the registry lookup logic is the next thing to
fix; if it doesn't, the loopback path is somewhere else and the diagnosis
needs to widen.

**E.2 — robust fix**: have the proxy add an unambiguous direction marker to
its own Record-Route URI so subsequent in-dialog requests carry it, and the
proxy can classify worker-outbound deterministically without relying on the
source-IP heuristic. Concrete: extend `buildRecordRouteValue`
([ProxyCore.ts:1300](../../src/sip-front-proxy/ProxyCore.ts#L1300)) to
optionally emit two URIs in a single Record-Route header (RFC 3261 §16.6.4
permits multiple), or encode a `dir` param into the stickiness cookie that
the proxy reads at decode time. The worker's routeSet then contains both
directions and the proxy can pick by direction without needing the source IP.

The exact mechanism is a code-level decision once E.1 has confirmed the
failure mode. The plan reserves this slot; the precise design lands when E.1
data is in.

## Verification

### Local

```bash
npm run typecheck                                           # zero errors, zero warnings
npx vitest run --config vitest.config.fake.ts \
  tests/fullcall/e2e-fake-clock.test.ts                     # new keepalive-via-proxy passes
```

Watch for:
- `keepalive-via-proxy` (Scenario 1) passes on `proxy+b2b` and `sipproxyHA`,
  skips on `b2bonly`.
- `keepaliveMissingOutboundProxyRegressionGuard` passes today (documents the
  current bug-presence behavior).
- All existing keepalive scenarios still pass.

### k8s smoke + endurance

```bash
npm run test:k8s -- tests/k8s/proxy-routing.test.ts         # additive helm change
npm run test:k8s -- tests/k8s/smoke.test.ts
npm run test:k8s:endurance -- --caps 20 --duration 1h --proxy-chaos-disabled
```

Expected post-fix endurance outcomes:
- Long stream: 0/610 → ≥99.9% success.
- "Unroutable OPTIONS" warning count: 465 → 0 (steady state) or low (during
  pod restart windows; E.1 will tell us whether the residual is the proxy
  registry-staleness path).
- Worker `keepaliveTimeoutRule` invocations: 610 → 0.
- Short stream: still ~99.99%, with each call now exercising the
  `relay-reinvite` path.

## Sequencing & risk

1. **A.1 (test helm)** — zero risk, immediately unblocks the endurance rerun.
2. **C.1 + C.2 + C.3 (fake-clock regression scenarios)** — additive. The
   `MissingOutboundProxyRegressionGuard` scenario is the durable fence for
   this class of bug.
3. **D.1 (sipIndex toTag fallback)** — independent resilience improvement,
   shippable anytime.
4. **B.1 (sipp scenario)** — doubles short-call SIP traffic. Re-run baseline
   endurance once after merge to confirm no throughput regression.
5. **E.1 (proxy diagnostic)** — additive log; ship and run a short endurance
   to collect data.
6. **E.2 (proxy fix)** — gated on E.1 data.
7. **A.2 + A.3 (production helm)** — gated on operations sign-off and the
   README pass.

### Risk callouts

- **A.2** keeps the production default empty so existing standalone-worker
  installs don't break. Operators who follow the comment block opt in.
- **B.1** doubles short-call message volume (4 → 8 messages per call). The
  call-control mock backend handles re-INVITE the same as INVITE, so no
  backend change. Re-baseline throughput after merge.
- **D.1** adds a second sipIndex key for a-leg dialogs. Audit for
  cross-call key collisions before merging — guarded by the structured
  warning on overwrite.
- **E.2** changes Record-Route shape. Backward-compat sweep: check that
  external SIP elements (third-party UAs, gateways) that might be in the
  call path tolerate multi-URI Record-Route or extra params per RFC 3261.

## Critical files to modify

- [tests/k8s/values/b2bua-worker.yaml](../../tests/k8s/values/b2bua-worker.yaml)
- [deploy/helm/b2bua-worker/values.yaml](../../deploy/helm/b2bua-worker/values.yaml)
- [deploy/helm/b2bua-worker/README.md](../../deploy/helm/b2bua-worker/README.md)
- [tests/k8s/charts/sipp/scenarios/uac-endurance-short.xml](../../tests/k8s/charts/sipp/scenarios/uac-endurance-short.xml)
- [tests/scenarios/keepalive-via-proxy.ts](../../tests/scenarios/keepalive-via-proxy.ts) *(new)*
- [tests/support/proxyB2bFakeStack.ts](../../tests/support/proxyB2bFakeStack.ts)
- [tests/support/sipproxyHAFakeStack.ts](../../tests/support/sipproxyHAFakeStack.ts) *(if separate)*
- [tests/fullcall/e2e-fake-clock.test.ts](../../tests/fullcall/e2e-fake-clock.test.ts)
- [src/call/CallState.ts](../../src/call/CallState.ts) *(D.1)*
- [src/sip-front-proxy/ProxyCore.ts](../../src/sip-front-proxy/ProxyCore.ts) *(E.1 + E.2)*

## Existing utilities to reuse (do not reinvent)

- `applyRouteSet` ([ActionExecutor.ts:137-160](../../src/b2bua/rules/framework/ActionExecutor.ts#L137-L160))
- `confirm-dialog` Record-Route extraction ([ActionExecutor.ts:1054-1055](../../src/b2bua/rules/framework/ActionExecutor.ts#L1054-L1055))
- `buildRecordRouteValue` and stickiness encode/decode ([ProxyCore.ts:1296-1310+](../../src/sip-front-proxy/ProxyCore.ts#L1296))
- `keepaliveHappy` scenario shape and `s.pause(KEEPALIVE_INTERVAL_MS)` pacing ([tests/scenarios/keepalive-happy.ts](../../tests/scenarios/keepalive-happy.ts))
- `uac-pingpong.xml` re-INVITE block as the template for B.1
