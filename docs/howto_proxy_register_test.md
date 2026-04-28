# How-to: write a register-proxy + k8s e2e test

A practical guide for adding a new scenario to the
**`register-fakeExt-realCore`** harness — fake in-process alice / bob /
… agents on the host, an in-process **register-proxy** as the SUT, and
the kind-deployed b2bua stack as an opaque "core" peer.

---

## TL;DR — the 30-second version

1. Copy [tests/scenarios/registrar/k8s-register-call-bye.ts](../tests/scenarios/registrar/k8s-register-call-bye.ts) to a new file.
2. Replace agents / steps / X-Api-Call to fit your scenario.
3. Add an `it.live(...)` block in [tests/fullcall/e2e-register-fakeExt-realCore.test.ts](../tests/fullcall/e2e-register-fakeExt-realCore.test.ts) that calls `buildRunner()(myScenario.toScenario())`.
4. Run:
   ```bash
   npm run test:k8s:up          # idempotent
   npm run test:k8s:images      # only after src/ changes
   tsx tests/k8s/scripts/install-stack.ts   # only on first install
   E2E_KIND=1 npx vitest run -c vitest.config.live.ts \
     tests/fullcall/e2e-register-fakeExt-realCore.test.ts
   ```
5. Open `test-results/real-clock/registrarFrontProxy-kind/index.html`.

---

## Reference scenarios

| Scenario | What it does | Use as template for |
|---|---|---|
| [k8s-register-smoke.ts](../tests/scenarios/registrar/k8s-register-smoke.ts) | REGISTER → 200 OK only. | Network-plumbing smoke / first scenario in a new feature. |
| [k8s-register-call-bye.ts](../tests/scenarios/registrar/k8s-register-call-bye.ts) | alice + bob REGISTER, alice INVITEs bob via X-Api-Call, ACK, BYE. | Full happy-path call with one b-leg. |
| [k8s-register-call-reroute.ts](../tests/scenarios/registrar/k8s-register-call-reroute.ts) | alice + bob1 + bob2 REGISTER. bob1 503 → on_failure failover → bob2. | Anything that needs `/call/failure` + alternate b-leg. |

The scenario DSL itself is documented in [docs/test-api-external.md](test-api-external.md).

---

## What the runner gives you

```ts
const runner = createHybridRunner({
  advertisedIp,              // discoverHostReachableIp() — kind bridge gateway
  outputDir: OUTPUT_DIR,
})
```

`createHybridRunner` (in [tests/support/hybridRunner.ts](../tests/support/hybridRunner.ts)) sets up:

- An **in-process register-proxy** running `ProxyCore` in dual-endpoint registrar mode on real UDP. Default ports: ext = 25080, core = 25081, both bound on `0.0.0.0`, advertised on the kind bridge gateway IP.
- A real-UDP transport for alice / bob / … sharing the same `SignalingNetwork.real` instance as the proxy, so its `drainTrace()` captures every packet on both ext and core for the report.
- Default `coreDestination = 127.0.0.1:5060` (the kind hostPort that maps to the in-cluster proxy NodePort).
- `participantLabels` so the trace shows `proxy(ext)`, `proxy(core)`, `k8s-ingress` instead of bare IPs.

You don't need to know any of that to write a scenario — just keep
the **traps** below in mind.

---

## Traps (read this before writing a scenario)

### 1. X-Api-Call destination must be the proxy's CORE endpoint, not bob

The k8s b2bua-worker calls `/call/new`, gets the destination, sends the
b-leg INVITE there. For the register-proxy to do the registrar lookup
of `bob`, the b-leg must come back through `proxy(core)`:

```ts
// CORRECT
"X-Api-Call": JSON.stringify({
  action: "route",
  destination: { host: ctx.agent("alice").ip, port: 25081 },
  // (omit new_ruri — the proxy will look up "bob" by RURI userpart)
})
```

```ts
// WRONG — bypasses the registrar; b-leg goes straight to bob without
// touching the proxy's core endpoint, so the trace loses half the flow
"X-Api-Call": JSON.stringify({
  action: "route",
  destination: { host: ctx.agent("bob").ip, port: ctx.agent("bob").port },
})
```

`ctx.agent("alice").ip` returns the kind bridge gateway because every
agent is advertised on it — same value you'd get from
`discoverHostReachableIp`.

### 2. Each agent needs a fixed `port`

Kind pods send replies back to the host using the address advertised in
Contact / Via. If you let the OS pick a port (`port` omitted), the pod
can't pre-register a destination. Always pin:

```ts
const alice = s.agent("alice", { uri: "sip:alice@kindlab", port: 25060 })
const bob   = s.agent("bob",   { uri: "sip:bob@kindlab",   port: 25061 })
```

Pick ports outside the proxy range (25080 / 25081 are taken).

### 3. Distinct AORs for multi-bob scenarios

The registrar keys on the **userpart** of the AOR. Two bobs registering
under `sip:bob@kindlab` overwrite each other. Use distinct usernames:

```ts
const bob1 = s.agent("bob1", { uri: "sip:bob1@kindlab", port: 25063 })
const bob2 = s.agent("bob2", { uri: "sip:bob2@kindlab", port: 25064 })
```

The `new_ruri` you put in `on_failure` then determines which AOR the
proxy looks up:

```ts
on_failure: {
  action: "failover",
  destination: { host: ctx.agent("alice").ip, port: 25081 },
  new_ruri: "sip:bob2@kindlab",   // proxy looks up "bob2"
}
```

### 4. `allowExtra("ACK")` on a bob that returns non-2xx final

When a UAS replies `>= 300` to an INVITE, the upstream sends ACK to
that response (RFC 3261 §17.1.1.3). The framework would otherwise flag
that ACK as an unexpected message:

```ts
const bob1 = s.agent("bob1", ...)
bob1.allowExtra("ACK")            // before the .reply(503)
const txn = bob1.receiveInitialInvite().transaction
txn.reply(503)
```

### 5. Bounce pods after `npm run test:k8s:images`

`kind load docker-image sipjsserver:dev` overwrites the node-side image
but the running pods keep the cached copy because `imagePullPolicy:
IfNotPresent`. After every src-side change that affects cluster pods:

```bash
kubectl delete pod -n sip-test -l app.kubernetes.io/name=b2bua-worker
kubectl rollout restart deployment sip-front-proxy -n sip-test
```

### 6. The `advertisedIp` is dynamic — never hard-code it

```ts
beforeAll(async () => {
  advertisedIp = await Effect.runPromise(discoverHostReachableIp)
})
```

`discoverHostReachableIp` runs `docker network inspect kind` and pulls
the bridge gateway IPv4. Hard-coding `172.20.0.1` works on most boxes
but breaks the moment kind picks a different docker network. Pass the
discovered value into both `createHybridRunner({ advertisedIp })` and
nothing else — the runner threads it through to every agent's Contact.

### 7. SDP `c=IN IP4 127.0.0.1` is fine here

The hybrid harness validates **signalling** only. Media never leaves
the test process. The default helpers in [tests/fullcall/helpers/sdp.ts](../tests/fullcall/helpers/sdp.ts) advertise loopback in `c=` lines and that's intentional —
don't try to "fix" it for this harness. (For media-level tests you'd
need a different harness.)

### 8. `.skipFinalSweep()` after non-2xx finals

Some proxy code paths leak transaction state in the SBC after a
b-leg-rejected call (e.g. bob1 503 → bob2 reroute). The framework's
final-state sweep flags that as a fail. Until that bug is fixed,
mark such scenarios:

```ts
.tier("short")
.skipFinalSweep()
```

The simple call-bye doesn't strictly need it but [k8s-register-call-reroute.ts](../tests/scenarios/registrar/k8s-register-call-reroute.ts) does.

---

## What you'll see in the report

For each scenario, `test-results/real-clock/registrarFrontProxy-kind/`
contains:

- `index.html` — master index across all scenarios in the run.
- `<scenario>.html` — SVG sequence diagram + step-by-step pass/fail
  table + clickable per-message links.
- `<scenario>.global.txt` — plain-text trace, all endpoints, sortable
  by timestamp. Best fed to the
  [`sip-callflow-review`](../.claude/skills/sip-callflow-review/) skill.
- `ext/<scenario>.<participant>.txt` and `core/<scenario>.<participant>.txt` — per-endpoint views.

The trace will show the **proxy ↔ k8s exchange** explicitly:

```
T+0.054s  proxy(core) (0.0.0.0:25081) → k8s-ingress (127.0.0.1:5060) — INVITE
T+0.060s  k8s-ingress (127.0.0.1:5060) → proxy(core) (0.0.0.0:25081) — 100 Trying
T+0.064s  172.20.0.7:5060 → proxy(core) (0.0.0.0:25081) — INVITE sip:bob@…  (← b-leg from worker)
T+0.067s  proxy(core) (0.0.0.0:25081) → 172.20.0.7:5060 — 180 Ringing       (← reply via received=/rport=)
```

The internal cluster LB → worker hop is intentionally invisible — the
in-cluster proxy + workers are treated as a single opaque core peer.

---

## When something is wrong

| Symptom | Where to look first |
|---|---|
| REGISTER 200 timeout | Is `npm run test:k8s:up` cluster running? `kubectl get pods -n sip-test` should show `proxy + worker + redis + call-control` Running. |
| INVITE 100 OK but 180 / 200 timeout | Worker can't reach the proxy(core). Did you bounce the worker after src changes (trap #5)? `rport` support requires the rebuilt image. |
| ACK times out at bob | The proxy's in-dialog forwarding probably needs the next-Route fix. Confirm sip-front-proxy advertisedHost is `127.0.0.1` (set in `tests/k8s/values/sip-front-proxy.yaml`) and the proxy was bounced. |
| 483 Too Many Hops on alice | Routing loop — usually X-Api-Call destination wrong (see trap #1) or missing `advertisedIp`. |
| `Unexpected message received by bobN: INVITE` (multiple) | The b-leg INVITE retransmits because the proxy can't deliver responses back to the worker. Check that the b2bua-worker image was rebuilt with the `rport` fix. |

For deeper diagnosis, run the
[`sip-callflow-review`](../.claude/skills/sip-callflow-review/) skill on
the generated `*.global.txt`.
