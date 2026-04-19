# SIP E2E Test Framework

End-to-end test framework for the SIP B2BUA. Scenarios are written once as a TypeScript DSL and executed against multiple backends.

## Architecture

```
                          Scenario DSL (TypeScript)
                                  |
                          Record phase: builds Step[] AST
                                  |
               +------------------+------------------+
               |                  |                  |
         Simulated            Live UDP          SIPp export
      (mock transport,     (real dgram,         (future)
       in-process B2BUA,    real B2BUA,
       TestClock)            wall clock)
```

### Compiler/interpreter model

The scenario function does not execute SIP. It runs in **record mode**, producing an AST (an ordered list of `Step` nodes). A pluggable backend then interprets the AST:

1. **Record** -- the DSL function appends `send`, `expect`, `pause` steps to a list
2. **Prepare** -- the interpreter scans all `expect` steps and pre-registers listeners (so receives are ready before sends)
3. **Execute** -- steps are walked in order; sends build and transmit SIP messages, expects poll the transport with a timeout
4. **Report** -- results are aggregated per step (pass / fail / skip) with timing. The simulated-backend run also emits a **rule coverage** section in `test-results/fake-clock/index.html`; see [../../docs/rule-coverage-and-killing.md](../../docs/rule-coverage-and-killing.md) for coverage + opt-in rule-kill (mutation) workflow.

> **Agent ordering**: Because expects are pre-registered in the Prepare phase,
> the relative ordering of a `send` on one agent and an `expect` on another
> agent is not strict — the expect listener is active before any step executes.
> Write steps in causal order for readability (send before matching expect),
> but be aware the framework does not enforce this.

### File layout

```
tests/fullcall/
  framework/
    types.ts              Step AST, StepRef, MessageContext, AgentConfig, TestTransport
    dsl.ts                scenario(), sequence(), or(), andThen(), rename()
    recorder.ts           Record-phase proxy that builds Step[] from DSL calls
    interpreter.ts        Two-phase execution engine (shared by all backends)
    message-builder.ts    Default SIP headers, 3-layer override chain, placeholder resolution
    simulated-backend.ts  Mock UdpTransport + in-process B2BUA + Redis
    live-backend.ts       Real dgram sockets, dynamic port allocation
    report.ts             Step-by-step test report formatter
  scenarios/
    basic-call.ts         INVITE -> 200 -> ACK -> BYE -> 200
    call-reject.ts        INVITE -> 403 Forbidden
    cancel.ts             INVITE -> 180 -> CANCEL -> 200+487
    prack.ts              INVITE -> 183(100rel) -> PRACK -> 200 -> ACK
    bye-directions.ts     Composed: callSetup.andThen(callerBye | calleeBye)
  helpers/
    sdp.ts                Default SDP offer/answer bodies
    harness.ts            B2BUA lifecycle helpers
  e2e.test.ts             vitest entry point
```

## Running tests

### Prerequisites

- Redis running on `localhost:6379` (used by the B2BUA's CallState and CallLimiter)

### Simulated backend (default)

Runs the B2BUA in-process with a mock UDP transport. No real sockets, fast execution.

```bash
# Run all E2E tests (simulated backend)
npm run test

# Run only E2E tests
npx vitest run tests/fullcall/e2e.test.ts

# Run a specific scenario
npx vitest run tests/fullcall/e2e.test.ts -t "basic call"

npx vitest run tests/fullcall/e2e-fake-clock.test.ts 
```

### Live UDP backend

Runs against a real B2BUA instance over real UDP sockets. Start the B2BUA first, then run with `E2E_LIVE=1`.

```bash
# Terminal 1: start the B2BUA
npm run dev

# Terminal 2: run live E2E tests
export E2E_LIVE=1 
npx vitest run tests/fullcall/e2e.test.ts

# Override B2BUA address
E2E_LIVE=1 E2E_B2BUA_HOST=10.0.0.5 E2E_B2BUA_PORT=5060 npx vitest run tests/fullcall/e2e.test.ts
```

## Writing scenarios

### Basic scenario

A scenario declares agents and describes the SIP message flow top-to-bottom, like a sequence diagram:

```typescript
import { scenario } from "../framework/dsl.js"
import { sdpOffer, sdpAnswer } from "../helpers/sdp.js"

export const myScenario = scenario("my-scenario", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob   = s.agent("bob",   { uri: "sip:bob@test", port: 5666 })

  // Alice sends INVITE — returns a dialog handle and a UAC INVITE transaction.
  const { dialog: aliceDialog, transaction: aliceInviteTxn } =
    alice.invite("sip:+1234@127.0.0.1:15060", { body: sdpOffer() })
  aliceInviteTxn.expect(100)

  // Bob receives INVITE — returns a dialog handle and a UAS INVITE transaction.
  const { dialog: bobDialog, transaction: bobInviteTxn } = bob.receiveInitialInvite()

  bobInviteTxn.reply(180)
  aliceInviteTxn.expect(180)

  bobInviteTxn.reply(200, { body: sdpAnswer() })
  aliceInviteTxn.expect(200)

  aliceDialog.ack()
  bobDialog.expect("ACK")
})
```

### What the framework auto-manages

For each agent, the framework generates and tracks:

| Header | Requests | Responses |
|--------|----------|-----------|
| Via | Fresh branch per request | Copied from `inResponseTo` |
| From | `<agent-uri>;tag=<generated>` | Copied from `inResponseTo` |
| To | `<target-uri>` (+ tag after dialog) | Copied + local tag added |
| Call-ID | Generated once per dialog | Copied from `inResponseTo` |
| CSeq | Auto-incremented | Copied from `inResponseTo` |
| Contact | `<sip:agent-ip:port;transport=udp>` | Same |
| Max-Forwards | 70 | -- |
| Content-Length | Computed from body | Computed from body |

### Overriding headers

Three layers of overrides, applied in order:

1. **Computed defaults** (table above)
2. **Declarative `overrides` bag** -- static field-level patches
3. **`build(ctx)` callback** -- dynamic computation from dialog state

```typescript
// Declarative: set a custom CSeq on a reply
bobInviteTxn.reply(200, { overrides: { cseq: 55 } })

// Declarative: add custom headers on the initial INVITE
const { transaction: aliceInviteTxn } = alice.invite("sip:+1234@b2bua", {
  headers: { "X-Custom": "value", "Supported": "100rel" },
})

// Dynamic: compute from context (marks scenario as non-SIPp-exportable)
aliceDialog.bye({
  build: (ctx) => ({
    to: `sip:${ctx.agent("bob").uri}@${ctx.remote.ip}:${ctx.remote.port}`,
    cseq: ctx.last.cseq + 10,
  })
})
```

### Context object (`ctx`) in `build()` callbacks

| Property | SIPp equivalent | Description |
|----------|----------------|-------------|
| `ctx.local.ip` | `[local_ip]` | Agent's IP address |
| `ctx.local.port` | `[local_port]` | Agent's port |
| `ctx.local.uri` | -- | Agent's SIP URI |
| `ctx.local.tag` | -- | Agent's From tag |
| `ctx.local.callId` | `[call_id]` | Dialog Call-ID |
| `ctx.remote.ip` | `[remote_ip]` | B2BUA IP |
| `ctx.remote.port` | `[remote_port]` | B2BUA port |
| `ctx.last.from` | `[last_From:]` | Last message's From header |
| `ctx.last.to` | `[last_To:]` | Last message's To header |
| `ctx.last.via` | `[last_Via:]` | Last message's Via headers |
| `ctx.last.cseq` | `[last_CSeq:]` | Last message's CSeq number |
| `ctx.last.callId` | `[last_Call-ID:]` | Last message's Call-ID |
| `ctx.dialog.remoteTag` | `[peer_tag_param]` | Remote party's tag |
| `ctx.call.branch()` | `[branch]` | Generate a fresh branch |
| `ctx.agent("bob")` | -- | Resolve another agent's info (rename-aware) |

### Dialog & transaction methods

Initial INVITE returns both a dialog handle and a UAC INVITE transaction:

```typescript
const { dialog, transaction } = alice.invite(uri, opts)
```

Incoming INVITE returns both a dialog handle and a UAS INVITE transaction:

```typescript
const { dialog, transaction } = bob.receiveInitialInvite(opts)
```

| Call | What it does |
|------|-------------|
| `transaction.expect(statusCode, opts)` | Expect a provisional / final response on the UAC INVITE transaction |
| `transaction.cancel(opts)` | Send CANCEL, returns its own UAC transaction |
| `transaction.reply(statusCode, opts)` | Send a provisional / final response from the UAS side |
| `transaction.expectCancel(opts)` | UAS side: expect CANCEL for this INVITE (RFC 3261 §9); returns a UAS transaction for the 200 OK reply |
| `transaction.expectAck(opts)` | UAS side: expect the auto-ACK for a non-2xx final (RFC 3261 §17.1.1.3) — completes the INVITE transaction, no reply |
| `dialog.ack(opts)` | Send ACK for 2xx |
| `dialog.bye(opts)` | Send BYE, returns its UAC transaction |
| `dialog.send(method, opts)` | Send any in-dialog request (re-INVITE, PRACK, INFO, OPTIONS…). For a stranger/out-of-dialog agent this also works: fresh Call-ID and From-tag are generated, and an override `to: "<...>;tag=bogus"` forges the dialog identifier |
| `dialog.expect(method, opts)` | Expect an in-dialog request; returns a UAS transaction for the reply |

The dialog and transaction handles are the only way to emit or receive SIP traffic for an agent. `agent.allowExtra(...)` is the one agent-level method that remains, for pre-registering tolerated stray messages (e.g., auto-ACK for non-2xx under TestClock) without requiring a matching expect.

### Expecting messages

```typescript
// Expect a response on a UAC transaction
aliceInviteTxn.expect(200)

// Expect an in-dialog request via the dialog
const bobByeTxn = bobDialog.expect("BYE")

// With custom timeout
aliceInviteTxn.expect(180, { timeout: 10_000 })

// With assertion predicate (collected, not thrown)
aliceInviteTxn.expect(183, {
  predicate: (msg) => {
    const require = msg.headers.find(h => h.name.toLowerCase() === "require")
    return require?.value === "100rel"
  }
})
```

### Timing

```typescript
// Pause between steps (real sleep in live mode)
s.pause(2000)

// Delay before sending
aliceDialog.bye({ delay: 2000 })

// Timeout on receiveInitialInvite / transaction expect (default: 5000ms)
const { transaction: bobInviteTxn } = bob.receiveInitialInvite({ timeout: 10_000 })
```

## Composing scenarios

### `sequence()` and `andThen()`

Define reusable fragments and compose them sequentially. Agent dialog state (Call-ID, tags, CSeq) carries across the boundary.

```typescript
const callSetup = sequence("setup", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob   = s.agent("bob",   { uri: "sip:bob@test", port: 5666 })
  // ... INVITE through ACK
})

const callerBye = sequence("caller-bye", (s) => {
  const alice = s.agent("alice", { uri: "sip:alice@test" })
  const bob   = s.agent("bob",   { uri: "sip:bob@test", port: 5666 })
  const aliceByeTxn = alice.dialog.bye()
  const bobByeTxn = bob.dialog.expect("BYE")
  bobByeTxn.reply(200)
  aliceByeTxn.expect(200)
})

// Compose
const fullCall = callSetup.andThen(callerBye)
```

### `rename()`

Reuse a sequence with different agent names. Returns a new immutable AST.

```typescript
const bobSetup   = callSetup                        // bob on port 5666
const carolSetup = callSetup.rename({ bob: "carol" }) // carol on her own port
```

Inside `build(ctx)`, `ctx.agent("bob")` resolves through the rename map.

### `or()` (branching)

Define alternative paths where the first matching branch wins. Every branch must start with an `expect` step.

```typescript
import { or } from "../framework/dsl.js"

const ending = or(callerBye, calleeBye)
```

## Failure model

The interpreter runs to completion, collecting all errors rather than stopping at the first failure.

| Outcome | Behavior |
|---------|----------|
| **Assertion failure** | Predicate failed but message matched. Collected, execution continues. |
| **Timeout** | Expected message never arrived. Step marked FAIL, all transitive dependents marked SKIP. |
| **Unexpected message** | Agent received a message not matching any registered expect. Marked FAIL. |
| **Skip** | Step depends (via `inResponseTo`) on a timed-out expect. Not executed. |

### Example report output

```
Scenario: cancel-during-early-dialog
  [PASS]    #1  alice -> INVITE sip:+1234@b2bua
  [PASS]    #2  alice <- 100 (8ms)
  [PASS]    #3  bob   <- INVITE (45ms)
  [PASS]    #4  bob   -> 180 Ringing
  [PASS]    #5  alice <- 180 (12ms)
  [PASS]    #6  alice -> CANCEL
  [PASS]    #7  alice <- 200 (6ms)
  [PASS]    #8  alice <- 487 (18ms)
  [FAIL]    #9  bob   <- CANCEL (5000ms) -- Timeout after 5000ms waiting for CANCEL
  [SKIP]   #10  bob   -> 200 OK (depends on #9)
  [SKIP]   #11  bob   -> 487 (depends on #9)

  Timing:
    step #2 (100 Trying): 8ms [< 5000ms OK]
  Result:      8 passed, 1 failed, 2 skipped
```

## Future work

| Feature | Status | Notes |
|---------|--------|-------|
| Simulated backend | Done | Mock transport, in-process B2BUA |
| Live UDP backend | Done | Real sockets, env-configurable target |
| CANCEL branch matching | Done | Reuses original INVITE Via branch for CANCEL |
| Callee-initiated BYE | Done | Remote Contact tracking + A-leg dialog toTag fix |
| PRACK flow | Planned | RAck/RSeq header management in message builder |
| SIPp XML export | Designed | Scenarios without `build()` are `sippCompliant: true` |
| Infrastructure steps | Designed | `crash`, `restart`, `partition` step types in AST |
| Multi-instance B2BUA | Designed | Shared Redis, recovery testing |
| `X-test-dest` routing | Planned | Dynamic routing via CallControlServer header |
| `or()` runtime branching | Planned | Reactive branch selection in interpreter |
