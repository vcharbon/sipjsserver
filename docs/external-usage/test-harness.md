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
  // Host-routable IP the proxy advertises on its `core` (real-UDP)
  // endpoint. Your SUT must be able to reach this IP for in-bound SIP
  // to come back.
  advertisedIp: "10.0.1.10",
  // Host UDP port the proxy binds for return SIP from your SUT.
  corePort: 35081,
  outputDir: OUTPUT_DIR,
})

const aliceCallsBob = scenario("alice calls bob through my SBC", (s) => {
  // Agents bind on the in-process simulated fabric, NOT real UDP. Pick
  // distinct synthetic addresses (the routing table keys on `(ip,port)`);
  // do not use `port: 0` — the simulated fabric doesn't ephemeral-assign.
  const alice = s.agent("alice", {
    uri: "sip:alice@example.test",
    ip: "5.1.1.1",
    port: 5060,
  })
  const bob = s.agent("bob", {
    uri: "sip:bob@example.test",
    ip: "5.1.2.1",
    port: 5060,
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
- `test-results/my-sbc/<scenario>.html` — interactive sequence diagram + step table
- `test-results/my-sbc/<scenario>.global.txt` — global timeline, all endpoints
- `test-results/my-sbc/<network>/<scenario>.<agent>.txt` — per-agent text view, grouped by fabric (`ext/`, `core/`)
- `test-results/my-sbc/index.html` — index of every scenario in the directory (after `flushHybridIndexReport`)

## DSL reference

| Method | What it does |
|---|---|
| `s.agent(name, { uri, ip, port })` | Declare an agent. `ip` + `port` is the bind on the simulated fabric (routing table key). Use distinct `(ip,port)` pairs across agents. |
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
| `advertisedIp` | `"127.0.0.1"` — proxy `core` bind/advertised host. Only works if your SUT is also on localhost. |
| `corePort` | `25081` — proxy `core` UDP port on the host (real socket). |
| `outputDir` | `"test-results/registrar-test-proxy"` |

You **must** provide `coreDestination`. There is no sensible default —
it's your SUT.

> The proxy's **ext** endpoint (where alice/bob send REGISTER/INVITE)
> is not on real UDP — it's an in-memory address (`5.1.0.1:5060`) on a
> simulated fabric, shared with the agent transport. It cannot collide
> with another process on the host and is not configurable.

## Two fabrics, one report

The hybrid runner runs the agents and the proxy's **ext** ingress on a
purely in-memory `SignalingNetwork.simulated` fabric (routing table
keyed by `(ip, port)` — no kernel sockets), and only the proxy's
**core** egress on real UDP toward your SUT:

```
ext fabric (simulated, in-memory) ──┐
                                    ├─► in-process registrar front-proxy
agent ↔ proxy(ext)   5.1.x.x:5060   │      (one process, two fabrics)
                                    └─► proxy(core) ──real UDP──► YOUR SUT
                                              advertisedIp:corePort
```

Both fabrics ship their packets through a shared `EventSequencer`. The
runner drains both trace buffers and merges them by `sentMs` (with
`seq` as tiebreak) so the resulting `ScenarioResult.trace` is one
ordered timeline — exactly what the renderer needs to lay out the SVG
sequence diagram without scrambling concurrent events.

The agent transport binds on the simulated fabric via
`createLiveTransport({ useExternalNetwork: true })` and shares the
proxy's `SignalingNetwork` instance, so a single trace buffer captures
every ext-side hop.

## Advanced wiring

Four additional escape hatches are exported for consumers who need
finer control:

- `createHybridRunner(...)` — same shape as
  `createRegistrarTestProxyRunner` but with `kindHost` / `kindPort`
  fields (the original kind-cluster flavor). Use when your SUT is
  reachable via a docker/kind hostPort mapping.
- `registrarFrontProxyHybridStackLayer({...})` — the underlying Layer
  for the in-process proxy. Compose it directly to add `MetricsServer`,
  a custom `HmacKeyProvider`, etc. **Does not** bundle the networks —
  the surrounding scope must provide both `SignalingNetwork` (for ext)
  and `SignalingNetworkCore` (for core).
- `createLiveTransport({...})` — the raw UDP / simulated transport
  used by the agents. Drop the proxy entirely and point agents straight
  at any SIP endpoint.
- `executeScenario(scenario, transport, target)` — the interpreter. Wrap
  your own transport and feed scenarios through it if neither runner
  fits.

See the source for type signatures.

## Troubleshooting

**`bind: address already in use`** — another process is on `corePort`.
Pass a different `corePort`.

**`BindError: already_bound` from the simulated fabric** — two agents
declared the same `(ip, port)`, or you used `port: 0`. The simulated
fabric does not ephemeral-assign — every agent needs a distinct,
explicit `(ip, port)`.

**Timeout waiting for response** — your SUT isn't reachable from
`advertisedIp`. Use a real routable IP, not `127.0.0.1`, when the SUT
runs on a different host.

**SUT receives REGISTER instead of routing INVITEs** — REGISTERs
terminate at the in-process proxy by design (it's a registrar). Only
non-registrar requests are forwarded to `coreDestination`.

## What the recorder captures

Every scenario produces a `ScenarioResult` — the canonical post-run
artifact, equally consumable from `Effect.runPromise(runner(scenario))`
chains, custom CI uploaders, or hand-rolled assertions. The runner
hands one back to its caller and also feeds it to the report writers
before flushing.

The recorder is a single in-process service. Each fabric (simulated
ext, real core) pushes its observations through one shared
`EventSequencer`, so every entry on `ScenarioResult.trace` carries a
monotonic `seq` next to its `timestamp` — `(timestamp, seq)` is the
deterministic sort key the renderers and your tooling should use.

```ts
import type { ScenarioResult, Lane, TraceEntry } from "@vcharbon/sipjs/test-harness"

const result: ScenarioResult = /* returned by your runner */

result.scenarioName        // string
result.transportKind       // "fake" | "live" | "hybrid"
result.passed              // number — how many steps passed
result.failed              // number — non-zero => scenario failed
result.skipped             // number
result.lanes               // ReadonlyArray<Lane> — see below
result.trace               // ReadonlyArray<TraceEntry>
result.anomalies           // ReadonlyArray<RecordedAnomaly> — soft data issues
result.replicationTrace?   // ReadonlyArray<ReplicationTraceEntry> — only for SUTs with the replog hook
result.stepResults         // ReadonlyArray<StepResult> — per-step pass/fail with errors
```

### Lanes — `(ip, port)`-keyed identity

`result.lanes` is the canonical list of every wire endpoint the recorder
observed. Identity is `(ip, port)`; names are decorations.

```ts
interface Lane {
  readonly ip: string
  readonly port: number
  readonly names: ReadonlyArray<string>      // may be empty (anonymous probe / foreign packet)
  readonly network: "ext" | "core"
  readonly killedAt: ReadonlyArray<number>   // virtual-ms timestamps of kill events on this lane
}
```

The renderers order lanes by `network` group (`ext` left, `core` right)
then by first appearance in the trace.

### Trace entries

Every SIP packet the harness saw, in `(timestamp, seq)` order:

```ts
interface TraceEntry {
  readonly timestamp: number                       // primary display clock (ms)
  readonly seq: number                             // monotonic tiebreaker
  readonly sentMs: number                          // sender clock
  readonly receivedMs: number                      // receiver clock
  readonly fromAddr: { ip: string; port: number }  // wire-level source
  readonly toAddr:   { ip: string; port: number }  // wire-level destination
  readonly direction: "send" | "receive"
  readonly status: TraceStatus
  readonly message: SipMessage                     // structured SIP message
  readonly stepIndex: number                       // which scenario step emitted this
  readonly network: "ext" | "core"
  readonly durationMs?: number
}
```

To resolve a display name for a wire address, look up the lane:

```ts
import { laneKey } from "@vcharbon/sipjs/test-harness"

const nameByAddr = new Map<string, string>()
for (const lane of result.lanes) {
  nameByAddr.set(laneKey(lane.ip, lane.port), lane.names[0] ?? "")
}
const fromName = nameByAddr.get(laneKey(entry.fromAddr.ip, entry.fromAddr.port)) ?? ""
```

### Anomalies

`result.anomalies` carries soft data-quality warnings the recorder
spotted. They are NOT step failures — your scenario can still pass with
anomalies present. Filter by `kind` (TypeScript narrows the union):

```ts
const nameConflicts = result.anomalies.filter((a) => a.kind === "nameConflict")
const undeliverables = result.anomalies.filter((a) => a.kind === "undeliverable")
```

Kinds you'll see in the registrar-proxy harness:
- `nameConflict` — one `(ip,port)` got two different names. Inspect the
  HTML "data anomalies" panel; usually a test-setup mistake.
- `undeliverable` — a packet sent into the simulated fabric had no
  bound endpoint at the destination. Severity `deferred-fail`
  short-circuits the scenario at scope close.
- `signalingAudit` — a fabric-level invariant tripped (queue leak,
  malformed wire address, …).

## Generating HTML and text reports

The runner you obtain from `createRegistrarTestProxyRunner` /
`createHybridRunner` already calls these writers internally — you only
touch them directly when you build a custom runner or want to
re-emit a report from a stored `ScenarioResult`.

### Per-scenario writers

```ts
import {
  writeScenarioReport,
  writeTextReports,
  writeIndexReport,
  formatReport,
} from "@vcharbon/sipjs/test-harness"

// 1. Text reports — write FIRST so the HTML can link to the .txt files.
//    Returns the list of filenames it created (relative to outputDir).
const textFilenames = writeTextReports(result, "test-results/my-sbc")
//   → ["my-scenario.global.txt",
//      "ext/my-scenario.alice.txt",
//      "ext/my-scenario.bob.txt"]
// Per-agent files live in a `<network>/` subdirectory so dual-fabric
// scenarios surface the boundary at the filesystem level. Anonymous
// lanes (no registered name) fall back to `<ip>-<port>.txt`.

// 2. HTML report — interactive SVG sequence diagram + step-by-step
//    pass/fail table + click-to-inspect message panels. Pass the
//    `textFilenames` list so the page can link to the matching txt views.
writeScenarioReport(result, "test-results/my-sbc", textFilenames)
//   → "test-results/my-sbc/my-scenario.html"

// 3. Stdout summary — short PASS/FAIL/SKIP per step plus assertions,
//    timing, and unexpected messages. The runner prints this via
//    `console.log` after every scenario; you can call it directly if
//    you stream `ScenarioResult` somewhere else.
console.log(formatReport(result))
```

`writeTextReports` and `writeScenarioReport` both `mkdir -p` their
`outputDir`. Each scenario produces:

| File | Contents |
|---|---|
| `<scenario>.html` | Interactive sequence diagram, step table, click-to-inspect message details, data-anomalies panel. |
| `<scenario>.global.txt` | Plain-text trace, all endpoints, in `(timestamp, seq)` order. The format the [sip-callflow-review](../.claude/skills/sip-callflow-review.md) skill consumes. |
| `<network>/<scenario>.<agent>.txt` | Per-agent endpoint view. `<network>` is the agent's fabric tag (`ext` or `core`); `<agent>` is `lane.names[0]` falling back to `<ip>-<port>` when the lane is anonymous. |

### Index report

`writeIndexReport(results, outputDir)` aggregates many
`ScenarioResult`s into a single `index.html` (PASS/FAIL badges +
network chips + per-scenario links + rule-coverage panel).

`flushHybridIndexReport(outputDir)` is the convenience hook: the
runner appends every result it produces into an in-memory list keyed
by `outputDir`; calling `flushHybridIndexReport(outputDir)` writes the
index for that directory's accumulated results. Use it in an `afterAll`:

```ts
describe("my SBC", () => {
  afterAll(() => flushHybridIndexReport(OUTPUT_DIR))
  it.live("routes alice → bob", () => runner(aliceCallsBob.toScenario()))
  it.live("rejects bob → alice", () => runner(bobCallsAlice.toScenario()))
})
```

If you call `writeScenarioReport` yourself (custom runner), call
`writeIndexReport` directly with the array of results — the in-memory
list is private to the bundled hybrid runner.

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
