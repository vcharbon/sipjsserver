# How-to: write a register-proxy + k8s e2e test

A practical guide for adding a new scenario to the
**`register-fakeExt-realCore`** harness — fake in-process alice / bob /
… agents on the host, an in-process **register-proxy** as the SUT, and
the kind-deployed b2bua stack as an opaque "core" peer.

---

## TL;DR — the 30-second version

1. Copy [tests/scenarios/registrar/k8s-register-call-bye.ts](../tests/scenarios/registrar/k8s-register-call-bye.ts) to a new file. Keep its factory shape (`(opts) => scenario(...)`) if you need the proxy(core) address in `X-Api-Call`; otherwise the simpler constant shape of [k8s-register-smoke.ts](../tests/scenarios/registrar/k8s-register-smoke.ts) is fine.
2. Replace agents / steps / X-Api-Call to fit your scenario. Pick agent IPs on `5.1.1.x` (alices) / `5.1.2.x` (bobs) with port `5060`.
3. Add an `it.live(...)` block in [tests/fullcall/e2e-register-fakeExt-realCore.test.ts](../tests/fullcall/e2e-register-fakeExt-realCore.test.ts) that calls `buildRunner()(myScenario({ proxyCoreAdvertised }).toScenario())` (or `myScenario.toScenario()` if constant-shaped).
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
| [k8s-register-call-bye.ts](../tests/scenarios/registrar/k8s-register-call-bye.ts) | alice + bob REGISTER, alice INVITEs bob via X-Api-Call, ACK, BYE. | Full happy-path call with one b-leg. Factory-shaped (takes `proxyCoreAdvertised` from the runner). |
| [k8s-register-call-reroute.ts](../tests/scenarios/registrar/k8s-register-call-reroute.ts) | alice + bob1 + bob2 REGISTER. bob1 503 → on_failure failover → bob2. (Currently `.skip`ped — separate failure pending investigation.) | Template for `/call/failure` + alternate b-leg once re-enabled. |

The scenario DSL itself is documented in [docs/test-api-external.md](test-api-external.md).

---

## What the runner gives you

```ts
const runner = createHybridRunner({
  advertisedIp,              // discoverHostReachableIp() — kind bridge gateway
  outputDir: OUTPUT_DIR,
})
```

`createHybridRunner` (in [src/test-harness/hybrid-runner.ts](../src/test-harness/hybrid-runner.ts)) sets up two distinct network fabrics for one in-process register-proxy:

- **ext fabric — `SignalingNetwork.simulated`.** alice, bob, … and the proxy's ext endpoint all bind here on **synthetic addresses** with no kernel involvement. Convention (deliberately exotic so it's obvious in the trace):
  - `proxy(ext)`: `5.1.0.1:5060`
  - alices: `5.1.1.<n>:5060`
  - bobs:   `5.1.2.<n>:5060`
- **core fabric — `SignalingNetworkCore.realTracing`.** Only the proxy's core endpoint binds here, on real UDP at the kind-bridge gateway port `25081`. This is the side the in-cluster b2bua reaches us on.
- **`coreDestination` defaults to `172.20.255.250:5060`** — the in-cluster MetalLB VIP for `sip-front-proxy`. That's the address `sipp -s uac 172.20.255.250:5060 -i <bridge-gw>` already reaches; the proxy(core) forwards ext-originated INVITEs there.
- `participantLabels` so the trace shows `proxy(ext)`, `proxy(core)`, `k8s-ingress` (and the per-agent name) instead of bare IPs.
- Both fabrics record per-instance trace buffers; the runner drains and merges both by `sentMs` for a single unified report.

You don't need to know any of that to write a scenario — just keep
the **traps** below in mind.

---

## Traps (read this before writing a scenario)

### 1. X-Api-Call destination must be the proxy's CORE endpoint, sourced from the runner

The k8s b2bua-worker calls `/call/new`, gets the destination, and sends
the b-leg INVITE there. For the register-proxy to do the registrar
lookup of `bob`, the b-leg must come back through `proxy(core)` on the
**real** fabric (the kind-bridge gateway IP). The address is dynamic
(depends on the host's docker network), so scenarios that need it must
be **factory functions** that accept it from the runner:

```ts
// k8s-register-call-bye.ts shape
export interface MyScenarioOpts {
  readonly proxyCoreAdvertised: { readonly host: string; readonly port: number }
}

export const myScenario = (opts: MyScenarioOpts) =>
  scenario("my-scenario", (s) => {
    const alice = s.agent("alice", { uri: "sip:alice@kindlab", ip: "5.1.1.1", port: 5060 })
    // …
    alice.invite("sip:bob@kindlab", {
      build: () => ({
        headers: {
          "X-Api-Call": JSON.stringify({
            action: "route",
            destination: opts.proxyCoreAdvertised,
            // (omit new_ruri — the proxy will look up "bob" by RURI userpart)
          }),
        },
      }),
    })
  })
```

Then in the test file:

```ts
import { hybridProxyCoreDestination } from "../../src/test-harness/hybrid-runner.js"

it.live("my scenario", () =>
  buildRunner()(
    myScenario({
      proxyCoreAdvertised: hybridProxyCoreDestination(advertisedIp, 25081),
    }).toScenario(),
  ),
)
```

```ts
// WRONG (and used to work by coincidence in the all-real-UDP days):
destination: { host: ctx.agent("alice").ip, port: 25081 }
// `ctx.agent("alice").ip` is now `5.1.1.1` (synthetic ext fabric),
// not reachable from the cluster. The b-leg INVITE never arrives.
```

```ts
// WRONG — bypasses the registrar; b-leg would go straight to bob and
// the trace loses the registrar-lookup hop the test exists to validate.
destination: { host: ctx.agent("bob").ip, port: ctx.agent("bob").port }
```

### 2. Pick agent IPs on the ext fabric; port `5060` is fine everywhere

The ext fabric is `SignalingNetwork.simulated` — pure in-memory routing
keyed on `(ip, port)`, no kernel sockets. That has two consequences:

1. **Pick IPs that scream "fake"**: `5.1.1.x` for alices, `5.1.2.x` for
   bobs. The proxy's ext endpoint lives at `5.1.0.1:5060`. Reusing
   real-looking RFC1918 addresses (10.x, 192.168.x) makes it harder
   for a reader to tell at a glance which lane of the trace is
   in-process vs on real UDP.
2. **Reuse port `5060`** — the simulated fabric routes by `(ip, port)`
   so all agents and the proxy can share the canonical SIP port. The
   trace reads naturally; no contrived `:25060` / `:25061` suffixes.

```ts
const alice = s.agent("alice", { uri: "sip:alice@kindlab", ip: "5.1.1.1", port: 5060 })
const bob   = s.agent("bob",   { uri: "sip:bob@kindlab",   ip: "5.1.2.1", port: 5060 })
```

### 3. Distinct AORs for multi-bob scenarios

The registrar keys on the **userpart** of the AOR. Two bobs registering
under `sip:bob@kindlab` overwrite each other. Use distinct usernames
and bump the host octet:

```ts
const bob1 = s.agent("bob1", { uri: "sip:bob1@kindlab", ip: "5.1.2.1", port: 5060 })
const bob2 = s.agent("bob2", { uri: "sip:bob2@kindlab", ip: "5.1.2.2", port: 5060 })
```

The `new_ruri` you put in `on_failure` then determines which AOR the
proxy looks up:

```ts
on_failure: {
  action: "failover",
  destination: opts.proxyCoreAdvertised,
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

The trace shows the two fabrics side-by-side, with addresses that make
the boundary obvious — `5.1.x.x` on the simulated ext side, real bridge
IPs on the core side:

```
T+0.000s  alice (5.1.1.1:5060)            → proxy(ext) (5.1.0.1:5060)         REGISTER
T+0.001s  proxy(ext) (5.1.0.1:5060)       → alice (5.1.1.1:5060)              200 OK
T+0.054s  alice (5.1.1.1:5060)            → proxy(ext) (5.1.0.1:5060)         INVITE sip:bob@kindlab
T+0.056s  proxy(core) (172.20.0.1:25081)  → k8s-ingress (172.20.255.250:5060) INVITE  ← fabric crossing
T+0.066s  k8s-ingress (172.20.255.250:5060) → proxy(core) (172.20.0.1:25081)  100 Trying
T+0.081s  k8s-ingress (172.20.255.250:5060) → proxy(core) (172.20.0.1:25081)  INVITE sip:bob@…   ← b-leg from worker
T+0.082s  proxy(ext) (5.1.0.1:5060)       → bob (5.1.2.1:5060)                INVITE              ← fabric crossing
```

The internal cluster LB → worker hop is intentionally invisible — the
in-cluster proxy + workers are treated as a single opaque core peer.

---

## When something is wrong

| Symptom | Where to look first |
|---|---|
| REGISTER 200 timeout | Is `npm run test:k8s:up` cluster running? `kubectl get pods -n sip-test` should show `proxy + worker + redis + call-control` Running. |
| INVITE 100 OK but 180 / 200 timeout | The cluster can't reach `proxy(core)` on the bridge gateway. Confirm `discoverHostReachableIp` returned a real local interface (`ip -4 addr show \| grep <ip>`) and that `corePort` (25081 default) isn't already in use on the host. |
| b-leg `bob <- INVITE` arrives but `bob <- ACK / BYE` times out | The b-leg request crossed the fabric boundary but didn't make it back to bob. Confirm the in-cluster proxy image was rebuilt + rolled (trap #5) — the fabric crossing relies on the proxy's RFC §16.12.1 loose-route handling. |
| 483 Too Many Hops on alice | Routing loop — usually X-Api-Call destination wrong (see trap #1) or missing `advertisedIp`. |
| `Unexpected message received by bobN: INVITE` (multiple) | The b-leg INVITE retransmits because some hop is dropping responses on the way back. Compare the `proxy(core)` send/recv lanes in the trace to spot the missing reply. |

For deeper diagnosis, run the
[`sip-callflow-review`](../.claude/skills/sip-callflow-review/) skill on
the generated `*.global.txt`.
