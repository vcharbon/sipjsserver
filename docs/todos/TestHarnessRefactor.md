# Test Harness Refactor — Record/Verify + ServiceCase + External DUT

> **Post-approval note:** this plan should be copied into `docs/todos/` as a
> tracking doc once approved (plan mode prevents writing there now).

## Context

The SIP B2BUA test harness (`tests/support`, `tests/scenarios`, `tests/fullcall`)
is mature: per-message RFC validation, rich trace/report generation, agents
parameterized by name, and simulated+live+peer-to-peer runners. Three
limitations block broader use:

1. **Not reusable across B2BUAs.** The simulated runner and scenarios target
   sipjsserver's own layers. No clean path to point the harness at a different
   B2BUA over UDP.
2. **No data-driven service-behavior tests.** Routing/header/payload
   transformation logic (toll-free rewrites, PAI stamping, diversion, X-header
   manipulation) can't be exercised as a matrix — SIP-flow shape and
   business-data content are tangled together in each scenario.
3. **Inline validation aborts flow.** `.expect(180)` both *waits* and
   *validates*; a tag/CSeq violation stops the call mid-flight, so we never see
   downstream behavior when the DUT misbehaves early.

The refactor splits the harness into three concerns — drive the call, record
everything, verify statically — and introduces `ServiceCase` as the
data-driven layer orthogonal to flow shape. See the "Decisions" section for the
resolved design.

## Decisions (from grill)

| # | Decision |
|---|----------|
| Q1 | DUT access = **external UDP only** (+ in-process simulated for self-tests) |
| Q2 | Scenario = **driving actions only**; all validation moves to post-hoc rules |
| Q3 | **Three rule packages** (RFC / call-shape / INVITE-rejection) with unified `Rule` interface; scenario-level filter for RFC rules |
| Q4 | ServiceCase entry has **multiple alices** (inbound callers) and **multiple legs** (bob1, bob2…); content vs check fields are distinct |
| Q5 | Check vocabulary = **literal string OR regex** |
| Q6 | NP↔scenario binding = **compatibility-checked matrix, fail-loud when incompatible** |
| Q7 | Entry name = **`ServiceCase`** |
| Q8 | **Keep both transports** (simulated TestClock + UDP real clock); migrate every scenario to drive-only |
| Q9 | Wait match = **status class + transaction** (no content matching for flow progression) |
| Q10 | Scenario = **`(ServiceCase) => ScenarioScript`**; receives accept inline check bundles (`bob1.receiveInitialInvite({ checks })`) |
| Q11 | Rule escape hatches = **`disableRules: [...]`** (global) + **`expectViolations: [...]`** (per-receive, inverted assertion) |
| Q12 | Packaging = **design for extractability, keep files in-repo**; no src/ imports from harness |
| Q13 | Rule findings = **binary pass/fail** per rule |
| Q14 | DUT lifecycle = **pre-provisioned, harness calls `reset()`** between tests |
| Q15 | Phasing = **vertical slice per scenario**; order: basic → one REFER → call-limiter → remaining |
| Q16 | Multi-call = **per-call recording**, per-call rule pass + **cross-call aggregator** rule family |
| Q17 | Recording = **serializable to a hand-editable format (YAML)**; reference recordings are first-class fixtures for rule tests |

## Target architecture

```
┌──────────────────────────────────────────────────────────────┐
│ ScenarioScript  (ServiceCase) => { drive actions + labels }  │
└──────────────┬───────────────────────────────────────────────┘
               │ executed by
               ▼
        ┌─────────────┐        ┌─────────────────┐
        │   Runner    │───────▶│ DutTransport    │
        │ (drive only)│        │  simulated│udp  │
        └─────┬───────┘        └─────────────────┘
              │ writes
              ▼
        ┌──────────────┐
        │ Recording[]  │  one per call; messages + labels +
        │  (per call)  │  wait-timeouts + timestamps
        └─────┬────────┘
              │ consumed by
              ▼
        ┌──────────────────────────────────────────────────┐
        │ RuleEngine                                       │
        │  ├─ rfc/*          (per msg / txn / dialog)      │
        │  ├─ call-shape/*   (expected/unexpected msgs)    │
        │  ├─ service-case/* (label-driven field checks)   │
        │  └─ cross-call/*   (aggregator for call-limiter) │
        └──────────────────────────────────────────────────┘
```

## Critical files (to be modified / added)

Existing — modified:
- [tests/support/harness.ts](tests/support/harness.ts) — runner split: drive vs. verify; per-call recording
- [tests/scenarios/dsl.ts](tests/scenarios/dsl.ts) — `(sc: ServiceCase) => ...` parameterization; `.expect()` becomes wait-only; add `checks`, `expectViolations`
- [tests/support/fakeStack.ts](tests/support/fakeStack.ts) — expose a `DutTransport` interface; keep simulated impl
- [tests/support/liveStack.ts](tests/support/liveStack.ts) — same, UDP impl; add `DutHandle`/`reset()` contract
- [tests/scenarios/basic-call.ts](tests/scenarios/basic-call.ts), [cancel.ts](tests/scenarios/cancel.ts), [refer.ts](tests/scenarios/refer.ts) etc. — one at a time per Q15
- [tests/fullcall/e2e-fake-clock.test.ts](tests/fullcall/e2e-fake-clock.test.ts), [e2e-real-clock.test.ts](tests/fullcall/e2e-real-clock.test.ts) — consume runner via matrix

New:
- `tests/harness/recording.ts` — `CallRecording` type (messages, labels, timeouts, derived transactions/dialogs)
- `tests/harness/recording-codec.ts` — serialize/deserialize `CallRecording` to/from YAML. Format: top-level metadata (scenario id, ServiceCase id, start time) + a list of `messages` where each has `direction` (sent|received), `from`/`to` endpoint, `label` (when set), `sentMs`/`receivedMs`, and a `raw` block scalar holding the verbatim SIP text. Timeout/break markers encoded as typed entries in the same list. Round-trip property: `serialize(parse(x)) === x` modulo whitespace.
- `tests/harness/fixtures/recordings/` — hand-editable reference recordings used by rule tests (see Verification)
- `tests/harness/rules/` — three subpackages + `RuleEngine`
  - `rules/rfc/` — migrated from existing validators in [tests/support/validation.ts](tests/support/validation.ts) (reuse, don't rewrite the RFC logic)
  - `rules/call-shape/`
  - `rules/service-case/` — label→check matching
  - `rules/cross-call/`
- `tests/harness/service-case/types.ts` — `ServiceCase`, `Check = {eq}|{regex}`, `ServiceCaseLeg`
- `tests/harness/service-case/schema.ts` — Effect Schema (runtime validation of JSON files)
- `tests/harness/dut/` — `DutTransport` interface, `simulatedDut`, `udpDut(DutHandle)`
- `tests/service-cases/*.json` — one per scenario initially (1:1, per Q15)
- `tests/harness/matrix.ts` — `(scenarios × serviceCases) → TestMatrix`; fail-loud on incompatibility

## Reuse — don't rewrite

The existing codebase has the RFC logic already; the refactor moves it, not rebuilds it.

- Per-message validation (tags, CSeq, Via, branches, dialog URI, RecordRoute,
  CANCEL/PRACK correlation, offer/answer tracker) lives in
  [tests/support/validation.ts](tests/support/validation.ts) and the
  `OfferAnswerTracker` in the message-builder. Wrap these as rules under
  `rules/rfc/` rather than reimplementing.
- The trace infrastructure (`TraceEntry[]`) already captures `sentMs` /
  `receivedMs` and message payloads — it is the prototype of `CallRecording`.
  Extend it with: (a) driver-emitted labels (`{ label: 'bob1.inboundInvite' }`),
  (b) wait-timeout markers, (c) per-call split when multi-call runs.
- `verifyCleanState()` (simulated-backend.ts) becomes a post-hoc rule under
  `rules/call-shape/` instead of an inline assertion.
- HTML/text report generators already exist; adapt them to render rule findings
  grouped by family.

## Phasing (vertical slices)

### Slice 0 — Infrastructure skeleton
- Define `CallRecording`, `DutTransport`, `Rule`, `RuleEngine`, `ServiceCase`.
- Implement `recording-codec.ts` (YAML serialize/deserialize) with a
  round-trip unit test. Freeze the on-disk format early — rule-test fixtures
  will depend on it.
- Wire a stub runner that drives one call, produces a `CallRecording`, runs an
  empty rule set, renders a report.
- No scenario migrated yet. Success: skeleton compiles, fake runner outputs a
  trivially-empty recording for a 1-message call, and that recording
  round-trips through YAML.

### Slice 1 — `basic-call` end-to-end
- Port [tests/scenarios/basic-call.ts](tests/scenarios/basic-call.ts) to
  `(sc: ServiceCase) => ...`. `.expect()` downgraded to wait-only.
- Create `tests/service-cases/basic-call.json` — minimum fields: one alice, one
  bob, From/To/RURI eq checks.
- Move RFC validators into `rules/rfc/` (reuse logic from
  [tests/support/validation.ts](tests/support/validation.ts)).
- Implement `rules/call-shape/no-unexpected` and `all-expected-received`.
- Implement `rules/service-case/field-checks` (reads labels from recording).
- Self-tests: a suite that intentionally injects broken messages (wrong tag,
  wrong CSeq, wrong From) and asserts the corresponding rule fires. This is
  the critical regression gate.
- Slice success: `basic-call` passes under simulated transport; injected
  violations fail with clear rule names.

### Slice 2 — `refer` scenario
- Second migration proves the DSL handles non-trivial flows (REFER dialog,
  NOTIFY, Replaces).
- Any new rules surface as additions to the rule packs.

### Slice 3 — Call-limiter multi-call
- Add multi-call support to the runner (one `Recording` per call, keyed by
  Call-ID).
- Implement `rules/cross-call/` family with rate/rejection aggregators.
- Port call-limiter scenarios.

### Slice 4 — Remaining scenarios
- Migrate the rest. Each migration = port scenario + add ServiceCase + confirm
  rules pass.

### Slice 5 — UDP DUT transport
- Implement `udpDut(handle: DutHandle)` against sipjsserver first (real-clock
  tests become smoke tests of the UDP transport).
- Add `DutHandle` + `reset()` contract; document how a third-party B2BUA
  integration should satisfy it.
- Run the full scenario × ServiceCase matrix against sipjsserver over UDP
  (short tier only — matches today's `e2e-real-clock` discipline).

### Slice 6 — Rule filter + expected-violation escape hatches
- Implement `disableRules` and `expectViolations`.
- Add one corner-case scenario (intentional Alice misbehavior) to prove the
  escape hatch works end-to-end.

### Slice 7 — Matrix expansion
- Add a second ServiceCase per scenario (variant numbering plan) for the
  scenarios where it makes sense. Proves orthogonality.
- Fail-loud compatibility check: a ServiceCase that declares `legs: [bob1,
  bob2]` but is assigned to a single-leg scenario errors at matrix-build time.

## Verification strategy

- **Regression of existing behavior:** every scenario currently passing must
  still pass after its slice migrates. `npm run test:fake` and `npm run
  test:ci` remain the gates.
- **Rule correctness self-tests (Slice 1 onward):** for each rule, a fixture
  recording that SHOULD trip it, plus a clean one that should not. Fixtures
  are hand-edited YAML files under
  `tests/harness/fixtures/recordings/`, loaded via the recording codec. The
  tests live in `tests/harness/rules/*/rule.test.ts` and simply
  `loadRecording(path) → runRule → assert findings`. This is why the recording
  must be serializable: rule authors craft edge-case SIP messages directly in
  YAML rather than having to synthesize a full live run to trigger the rule.
  Without these, the record/verify split is unsafe — we'd lose inline
  validation without proof the post-hoc equivalent works.
- **Codec round-trip test:** every recorded run in Slice 1 is serialized and
  re-parsed; the reparsed object must deep-equal the original. This guarantees
  the hand-editable format losslessly represents what the runner captured.
- **ServiceCase compatibility:** a test that builds the matrix with a
  deliberately-incompatible pair and asserts the matrix builder throws.
- **Multi-transport parity:** one scenario runs under both simulated and UDP
  transports against sipjsserver; both must produce identical rule findings
  (modulo timestamps).
- **`npm run typecheck`** must stay at zero errors / zero warnings after every
  slice (per CLAUDE.md). Run after each vertical slice.

## Risks & open questions

- **UDP timeout tuning.** Wait deadlines must be configurable per-transport
  (TestClock: effectively instant; UDP: tier-based, matching `short`/`medium`/
  `long`). Will be decided per-scenario when migrating.
- **DUT readiness.** Pre-provisioned DUT assumption (Q14) shifts CI complexity
  to an external orchestration concern. Not addressed here; document the
  contract clearly and defer tooling.
- **Scenario fan-out under multi-call.** Effect Fibers are the natural tool;
  Slice 3 will validate the ergonomics before the call-limiter port.
- **Per-leg checks via regex** (Q5) are simple enough for v1 but may need
  templated expressions later (e.g., "expectedFrom equals inbound.from with
  carrier prefix"). Defer until a concrete case appears.
