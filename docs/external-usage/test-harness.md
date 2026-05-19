# `@vcharbon/sipjs/test-harness`

Test your SIP system (PBX / SBC / b2bua) by driving simulated
`alice.register()` / `bob.register()` agents through an in-process
registrar front-proxy that forwards INVITEs to your system on its
**core** side.

```
fake alice / bob (in-process) ──▶ in-process front-proxy ──▶ YOUR REAL SIP SYSTEM
                                  (registrar mode)            (real IP:port)
```

You write the scenario; the harness drives the SIP exchange and reports
pass / fail with a per-message HTML sequence diagram and a text
timeline.

## Install

```bash
npm install --save-dev @vcharbon/sipjs effect @effect/platform-node @effect/vitest vitest
```

## Quick-start

```ts
// my-sbc.test.ts
import { describe, it } from "@effect/vitest"
import { afterAll } from "vitest"
import {
  scenario,
  createRegistrarTestProxyRunner,
  flushHybridIndexReport,
} from "@vcharbon/sipjs/test-harness"

const OUTPUT_DIR = "test-results/my-sbc"

const runner = createRegistrarTestProxyRunner({
  // Your SUT — IP:port of the SIP element you're testing.
  coreDestination: { host: "10.0.1.5", port: 5060 },
  // What alice / bob / proxy advertise in Contact / Via / From URIs.
  // Must be reachable from your SUT for in-bound SIP to come back.
  advertisedIp: "10.0.1.10",
  // Where the proxy listens for alice/bob.
  extPort: 35080,
  // Where the proxy listens for return SIP from your SUT.
  corePort: 35081,
  outputDir: OUTPUT_DIR,
})

const aliceCallsBob = scenario("alice calls bob through my SBC", (s) => {
  const alice = s.agent("alice", {
    uri: "sip:alice@example.test",
    ip: "10.0.1.10",
    port: 0, // 0 = OS-assigned
  })
  const bob = s.agent("bob", {
    uri: "sip:bob@example.test",
    ip: "10.0.1.10",
    port: 0,
  })

  // Both agents register through the in-process proxy. The proxy stores
  // the binding locally; INVITEs to alice's URI route back to her real
  // bind address.
  alice.register()
  bob.register()

  // Alice INVITEs Bob. The proxy looks up Bob's binding (and forwards
  // the INVITE downstream to your SUT in core mode if the URI is not
  // registered). `invite(uri, opts?)` takes the target URI as a string.
  const { dialog, transaction } = alice.invite("sip:bob@example.test")
  transaction.expect(180)  // your SBC must ring Bob
  transaction.expect(200)  // Bob picks up
  dialog.ack()             // 2xx ACK is the agent's responsibility
  dialog.bye()             // Alice hangs up
})

describe("my SBC", () => {
  afterAll(() => flushHybridIndexReport(OUTPUT_DIR))

  it.live("routes alice → bob", () => runner(aliceCallsBob.toScenario()))
})
```

Run with `vitest`. Each scenario writes:
- `test-results/my-sbc/<scenario>.html` — interactive sequence diagram
- `test-results/my-sbc/<scenario>.txt` — global timeline
- `test-results/my-sbc/<scenario>.<agent>.txt` — per-agent view
- `test-results/my-sbc/index.html` — index of all scenarios (after `flushHybridIndexReport`)

## DSL reference

| Method | What it does |
|---|---|
| `s.agent(name, { uri, ip, port })` | Declare an agent. `ip` is the local bind; `port: 0` = OS-assigned. |
| `agent.register()` | Send REGISTER to the proxy and expect 200 OK. |
| `agent.invite(uri, opts?)` | Send INVITE to a URI. Returns `{ dialog, transaction }`. |
| `transaction.expect(statusCode, opts?)` | Wait for a response. `opts.predicate(msg)` for fine-grained matching. |
| `dialog.ack()` / `dialog.bye()` / `dialog.send(method, opts?)` | Send 2xx-ACK / BYE / arbitrary in-dialog request. |
| `dialog.expect(method, opts?)` | Expect an in-dialog request from the remote side. Returns a `UasTransaction` for `reply(...)`. |
| `s.pause(ms)` | Insert a synchronous delay (hybrid mode = real wall clock). |
| `scenario.runOn([...sut])` | Restrict to specific topologies. For external use the only relevant SUT is the registrar proxy — you can omit this. |
| `scenario.describe("...")` | Free-text description rendered at the top of every report. |
| `scenario.tier("short" \| "medium" \| "long")` | Hint for CI tier gating. |

## Sensible defaults

`createRegistrarTestProxyRunner({...})` defaults:

| Option | Default |
|---|---|
| `advertisedIp` | `"127.0.0.1"` (only works if your SUT is also on localhost) |
| `extPort` | `25080` |
| `corePort` | `25081` |
| `outputDir` | `"test-results/registrar-test-proxy"` |

You **must** provide `coreDestination`. There is no sensible default —
it's your SUT.

## Advanced wiring

Three additional escape hatches are exported for consumers who need
finer control:

- `createHybridRunner(...)` — same shape as
  `createRegistrarTestProxyRunner` but with `kindHost` / `kindPort`
  fields (the original kind-cluster flavor). Use when your SUT is
  reachable via a docker/kind hostPort mapping.
- `registrarFrontProxyHybridStackLayer({...})` — the underlying Layer
  for the in-process proxy. Compose it directly if you want to add
  `MetricsServer`, custom `HmacKeyProvider`, etc.
- `createLiveTransport({...})` — the raw UDP transport used by the
  agents. Drop the proxy entirely and point agents straight at any
  SIP endpoint.

See the source for type signatures.

## Troubleshooting

**`bind: address already in use`** — another process is on `extPort` or
`corePort`. Pass different ports.

**Timeout waiting for response** — your SUT isn't reachable from
`advertisedIp`. Use a real routable IP, not `127.0.0.1`, when the SUT
runs on a different host.

**SUT receives REGISTER instead of routing INVITEs** — REGISTERs
terminate at the in-process proxy by design (it's a registrar). Only
non-registrar requests are forwarded to `coreDestination`.

## Migrating off `participants`

`ScenarioResult.participants` and the `TraceEntry.from` / `TraceEntry.to`
**name strings** are deprecated. Lane identity moved to `(ip, port)`:
the `lanes` array and the `fromAddr` / `toAddr` fields are now the
canonical source. Names live in `lane.names` as a decoration — multiple
names on one socket are surfaced as a `nameConflict` anomaly rather than
silently overwriting each other.

Both fields still ship on `ScenarioResult` / `TraceEntry` so existing
code keeps compiling. They will be removed in a future release.

### Why

The renderer used to look up a column by name string. A transport that
fabricated a name (or two agents that briefly shared one) could shift
arrows onto the wrong lane without any error. Keying on `(ip, port)`
makes that class of bug structurally impossible.

### Find your call sites

```bash
# Direct reads of the deprecated field
grep -rn '\.participants\b'           src tests

# Imports / type references
grep -rn 'Participant\b'              src tests

# Reads of the deprecated name strings on TraceEntry
grep -rn 'entry\.from\b\|entry\.to\b' src tests
grep -rn '\.from === \|\.to === '     src tests   # filter assertions
```

False positives to ignore in the last command: SIP header fields
(`msg.getHeader("from")`, `from.tag`, `to.tag`) and `direction` reads
(`entry.direction === "send"`) — those are unrelated.

### Rewrites

**Listing networks the scenario touched** — replace
`result.participants.map(p => p.network)` with
`result.lanes.map(l => l.network)`.

**Getting a display name for an endpoint** — replace
`entry.from` / `entry.to` with a lane lookup keyed on the wire address:

```ts
import { laneKey } from "@vcharbon/sipjs/test-harness"

const nameByAddr = new Map<string, string>()
for (const lane of result.lanes) {
  nameByAddr.set(laneKey(lane.ip, lane.port), lane.names[0] ?? "")
}

const fromName = nameByAddr.get(laneKey(entry.fromAddr.ip, entry.fromAddr.port)) ?? ""
const fromLabel = fromName.length > 0
  ? `${fromName} (${entry.fromAddr.ip}:${entry.fromAddr.port})`
  : `${entry.fromAddr.ip}:${entry.fromAddr.port}`
```

**Filtering the trace to one agent** — replace
`trace.filter(e => e.from === name || e.to === name)` with an
address-keyed filter:

```ts
const key = laneKey(agentLane.ip, agentLane.port)
const filtered = result.trace.filter(
  (e) =>
    laneKey(e.fromAddr.ip, e.fromAddr.port) === key ||
    laneKey(e.toAddr.ip, e.toAddr.port) === key,
)
```

**Iterating "test agents"** — replace iteration over
`result.participants` (filtered by agent-vs-SUT heuristic) with
iteration over `result.lanes`, applying the same heuristic on
addresses:

```ts
const agentAddrs = new Set<string>()
for (const e of result.trace) {
  const addr = e.direction === "send" ? e.fromAddr : e.toAddr
  agentAddrs.add(laneKey(addr.ip, addr.port))
}

for (const lane of result.lanes) {
  if (!agentAddrs.has(laneKey(lane.ip, lane.port))) continue
  // ...your per-agent rendering...
}
```

### Edge cases worth knowing

- **A lane with no name** (`lane.names` is empty) is legitimate — it
  represents a wire endpoint the recorder observed but never received a
  `registerLane` call for (anonymous probes, foreign packets). Render
  `ip:port` directly; do not assume `lane.names[0]` exists.
- **A lane with multiple names** is surfaced as a `nameConflict` entry
  in `result.anomalies`. If your code previously crashed on collision,
  inspect the anomalies panel before failing the scenario.
- **The `name` vs `slug` distinction** in filenames: the legacy reporter
  produced `${scenario}.${participant.name}.txt`; the lane-based reporter
  falls back to `${scenario}.${ip}-${port}.txt` when the lane has no
  registered name. If your downstream tooling parses these filenames,
  account for the address-form fallback.
