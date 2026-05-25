# Test API — authoring multi-agent SIP scenarios

This guide is for **external users** of the test framework who want to
script a fake SIP user agent (alice, bob, …), place calls through the
real SBC running in a `kind` cluster, and inspect the resulting call
flow as an HTML report.

If you only need to add a new in-process fake-clock scenario, you also
want [tests/fullcall/README.md](../tests/fullcall/README.md). The doc
you're reading now focuses on the **hybrid `register-fakeExt-realCore`
harness**: real UDP from the host, real SBC inside kind.

---

## What you can build

A scenario is a sequence of SIP exchanges between fake agents. The DSL
covers:

- **REGISTER** — `agent.register({ expires? })` → returns a transaction you can `.expect(200)`.
- **INVITE / 100 / 180 / 200 / ACK** — `agent.invite(uri, opts)` and `agent.receiveInitialInvite()`.
- **In-dialog requests** — `dialog.send("INFO" | "OPTIONS" | "REFER" | …)` / `dialog.expect("BYE" | …)`.
- **BYE** — `dialog.bye().expect(200)`.
- **Multi-agent topologies** — call `s.agent(...)` as many times as needed; pin each one to a fixed UDP port so kind pods can route back to it.
- **Routing decisions** — drive the worker's `/call/new` path with an `X-Api-Call` SIP header (see below).
- **Failover** — encode `on_failure` in `X-Api-Call`; bob1 returns 503, the worker reroutes to bob2.

---

## Quickstart

The canonical hybrid example is
[tests/scenarios/registrar/k8s-register-call-bye.ts](../tests/scenarios/registrar/k8s-register-call-bye.ts).
Three agents, three steps:

```ts
import { scenario } from "../../fullcall/framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../../fullcall/helpers/sdp.js"

export const myCall = scenario("my-call", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@kindlab", port: 25060 })
  const bob   = s.agent("bob",   { uri: "sip:bob@kindlab",   port: 25061 })

  alice.register({ expires: 3600 }).expect(200)
  bob.register({ expires: 3600 }).expect(200)

  const { dialog: aliceD, transaction: invTxn } = alice.invite("sip:bob@kindlab", {
    body: sdpOffer(),
    build: (ctx) => ({
      headers: {
        "X-Api-Call": JSON.stringify({
          action: "route",
          destination: { host: ctx.agent("bob").ip, port: ctx.agent("bob").port },
          new_ruri: `sip:bob@${ctx.agent("bob").ip}:${ctx.agent("bob").port}`,
        }),
      },
    }),
  })

  invTxn.expect(100)
  const { dialog: bobD, transaction: bobTxn } = bob.receiveInitialInvite()
  bobTxn.reply(180)
  invTxn.expect(180)
  bobTxn.reply(200, { body: sdpAnswer() })
  invTxn.expect(200)
  aliceD.ack()
  bobD.expect("ACK")

  const byeTxn = aliceD.bye()
  bobD.expect("BYE").reply(200)
  byeTxn.expect(200)
})
  .tier("short")
  .skipFinalSweep()
```

Wire it into a test file (gated on `E2E_KIND=1`):

```ts
// tests/fullcall/e2e-register-fakeExt-realCore.test.ts
import { it, describe } from "@effect/vitest"
import { beforeAll, afterAll } from "vitest"
import { Effect } from "effect"
import { myCall } from "../scenarios/registrar/my-call.js"
import {
  createHybridRunner,
  discoverHostReachableIp,
  flushHybridIndexReport,
} from "../support/hybridRunner.js"

const OUTPUT_DIR = "test-results/real-clock/registrarFrontProxy-kind"

describe.skipIf(process.env.E2E_KIND !== "1")("E2E hybrid", () => {
  let advertisedIp = ""
  beforeAll(async () => {
    advertisedIp = await Effect.runPromise(discoverHostReachableIp)
  })
  afterAll(() => flushHybridIndexReport(OUTPUT_DIR))

  it.live("my-call", () =>
    createHybridRunner({ advertisedIp, outputDir: OUTPUT_DIR })(myCall.toScenario()),
    { timeout: 60_000 })
})
```

Then run:

```bash
npm run test:k8s:up                           # idempotent
npm run test:k8s:images                       # only after src/ or bin/ changes
tsx tests/k8s/scripts/install-stack.ts        # only on first install
E2E_KIND=1 TEST_MODE=live npx vitest run \
  tests/fullcall/e2e-register-fakeExt-realCore.test.ts
```

Open `test-results/real-clock/registrarFrontProxy-kind/index.html` in a browser.

---

## Agent abstraction

Every agent is created with `s.agent(name, config)`:

| field          | meaning |
|----------------|---------|
| `uri`          | The agent's AOR (e.g. `sip:alice@kindlab`). |
| `port`         | Fixed UDP bind port — **required** in hybrid mode so the SBC pod can address replies back to the host. |
| `ip`           | Bind IP. Hybrid runner forces `0.0.0.0` transport-wide; per-agent override is only useful for the simulated backend. |
| `advertisedIp` | Per-agent override of what gets stamped in Contact / Via / From. Hybrid runner injects the kind bridge gateway IP transport-wide; you only need this for unusual topologies. |
| `network`      | `"ext"` (default) or `"core"` — purely a label that paints the lane on the HTML report. The kind cluster is one fabric; leave it default. |

The agent proxy returned exposes:

- `agent.register(opts?)` → `UacTransaction` (chain `.expect(200)`).
- `agent.invite(uri, { body, headers, build })` → `{ dialog, transaction }`.
- `agent.receiveInitialInvite(opts?)` → `{ dialog, transaction }`.
- `agent.allowExtra(method | statusCode)` — pre-mark a message you don't want flagged as unexpected (e.g. an auto-ACK after a 503).

A dialog handle (`dialog`) exposes:

- `dialog.ack()`, `dialog.bye()` — common shortcuts.
- `dialog.send(method, opts?)` → `UacTransaction` — re-INVITE, INFO, REFER, etc.
- `dialog.expect(method, opts?)` → `UasTransaction` (then `.reply(status)`).

A transaction handle (`transaction`):

- `.expect(status)` (UAC) — wait for that response.
- `.reply(status, opts)` (UAS) — answer with that status.
- `.cancel()` (UAC INVITE only) — send CANCEL.

---

## Multi-agent topologies

Wire as many agents as you like in the same scenario. Each one needs a
distinct fixed `port`. Examples:

```ts
const alice = s.agent("alice", { uri: "sip:alice@kindlab", port: 25060 })
const bob1  = s.agent("bob1",  { uri: "sip:bob1@kindlab",  port: 25063 })
const bob2  = s.agent("bob2",  { uri: "sip:bob2@kindlab",  port: 25064 })
```

The `bob1`/`bob2` reroute scenario at
[tests/scenarios/registrar/k8s-register-call-reroute.ts](../tests/scenarios/registrar/k8s-register-call-reroute.ts) is the canonical 3-agent example.

To compute a destination from another agent's runtime address inside an
INVITE `build()`, use `ctx.agent(name)`:

```ts
build: (ctx) => ({
  headers: {
    "X-Api-Call": JSON.stringify({
      action: "route",
      destination: { host: ctx.agent("bob").ip, port: ctx.agent("bob").port },
    }),
  },
}),
```

This way the scenario stays portable: the hybrid runner stamps each
agent's Contact / Via with the kind bridge gateway IP at run time, and
the `X-Api-Call` instruction picks that up automatically.

---

## X-Api-Call header

The kind-deployed mock call-control service
([tests/k8s/charts/sipp/templates/call-control.yaml](../tests/k8s/charts/sipp/templates/call-control.yaml))
parses an `X-Api-Call` SIP header from the inbound INVITE and decides
the b-leg accordingly. Source-of-truth for the JSON shape is
[src/decision/adapters/http-reference/MockServer.ts](../src/decision/adapters/http-reference/MockServer.ts).

### `/call/new` (initial INVITE)

```jsonc
// route to a destination
{
  "action": "route",
  "destination": { "host": "172.20.0.1", "port": 25061, "transport": "udp" },
  "new_ruri": "sip:bob@172.20.0.1:25061",   // optional override
  "update_headers": { "P-Custom": "value" }, // optional
  "call_limiter": [...],                     // optional
  "on_failure": { ... }                      // optional — see below
}

// reject up-front
{ "action": "reject", "reject_code": 403, "reject_reason": "Forbidden" }
```

### `/call/failure` (b-leg primary failed)

The mock honors `callback_context` echoed back from the prior
`/call/new` response. Set it via `on_failure` on the initial route:

```jsonc
{
  "action": "route",
  "destination": { "host": "<bob1>", "port": 25063 },
  "on_failure": {
    "action": "failover",
    "destination": { "host": "<bob2>", "port": 25064 },
    "new_ruri": "sip:bob2@<bob2>:25064",
    "on_next_failure": { "action": "terminate" }   // optional
  }
}
```

When the worker calls `/call/failure` after bob1's 503, the mock returns
the failover instruction, the worker re-routes to bob2, and the call
proceeds.

---

## Reports

Every scenario produces (under `test-results/real-clock/registrarFrontProxy-kind/`):

| file                               | what it contains |
|------------------------------------|------------------|
| `index.html`                       | Master index of every scenario in the run. |
| `<scenario>.html`                  | SVG sequence diagram + step-by-step pass/fail table + clickable per-message links to text views. |
| `<scenario>.global.txt`            | Plain text trace, all endpoints, in arrival order. Best fed to the [sip-callflow-review](../.claude/skills/sip-callflow-review.md) skill. |
| `ext/<scenario>.<agent>.txt`       | Per-agent endpoint view of the trace. |

The HTML report uses real wall-clock timestamps (`T+0.000s`,
`T+0.064s`, …) since the hybrid runner uses real `Effect.sleep`. Compare
that to the fake-clock suite, where everything in a scenario lands at
`T+0` because `TestClock` only advances on explicit `s.pause(ms)` calls.

---

## Customising routing

To add a new `X-Api-Call` action shape (e.g. `forward-with-replaces`,
`limit`, …), update the canonical pure builders in
[src/decision/adapters/http-reference/MockServer.ts](../src/decision/adapters/http-reference/MockServer.ts).
The kind-deployed mock at
[tests/k8s/charts/sipp/templates/call-control.yaml](../tests/k8s/charts/sipp/templates/call-control.yaml)
mirrors that semantics inline; keep the two in sync.

To exercise a scenario without going through kind, adapt the same
scenario file to run via `createSimulatedRunner({ sut: "registrarFrontProxy" })`
(see [tests/fullcall/e2e-fake-clock.test.ts](../tests/fullcall/e2e-fake-clock.test.ts)
and [tests/scenarios/registrar/register-happy-path.ts](../tests/scenarios/registrar/register-happy-path.ts)).
You'll get the same DSL surface, but in-process and on `TestClock`.

---

## Troubleshooting

| symptom | cause / fix |
|---------|-------------|
| `REGISTER` times out on `200 OK` | Proxy isn't in registrar mode. Confirm `tests/k8s/values/sip-front-proxy.yaml` has `extraEnv: PROXY_REGISTER_MODE=in-memory` and `helm upgrade` was applied. |
| `INVITE` reaches bob but his `180`/`200` time out | Pod cannot reach host. Verify `discoverHostReachableIp()` returned a valid IPv4 (`docker network inspect kind`). On Linux native this is the docker bridge gateway (e.g. `172.20.0.1`). The framework now respects the actual UDP source for response routing — if it's still failing, check that bob bound on `0.0.0.0` (the hybrid runner does this; the simulated backend doesn't). |
| `/call/new` returns 200 but the worker dials sipp-uas | The mock fell back to its legacy default route because no `X-Api-Call` header reached it. Confirm the header travels alice → proxy → worker → HTTP request body's `sip_headers["X-Api-Call"]` (chain begins at [src/b2bua/InitialInviteHandler.ts:74](../src/b2bua/InitialInviteHandler.ts#L74)). |
| Cluster up but Service unreachable on `127.0.0.1:5060` | The proxy Service must be `type: NodePort` with `nodePort: 30060` (matching `tests/k8s/cluster.yaml`'s `extraPortMappings`). See `tests/k8s/values/sip-front-proxy.yaml`. |
| New scenario passes locally but the report shows `Status: FAIL` for unexpected messages after BYE | Some scenarios leak transaction state in the SBC; mark the scenario `.skipFinalSweep()` if you've already validated the happy path. The two existing hybrid scenarios use this. |
