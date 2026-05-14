# Type-safety + helper rationalisation for SIP scenario tests

## Context

Scenario predicates today are untyped: every `.expect(200, { predicate })` or `.expect("INVITE", { predicate })` receives the wide `(msg: SipMessage) => boolean`. As a result, 24+ predicates across `tests/scenarios/*.ts` start with boilerplate guards like `if (msg.type !== "response" || msg.status !== 200) return false` that re-prove what the matcher just matched. On top of that, 13+ scenario files redefine the same set of helpers (`headerValue`, `findHeader`, `getHeader`, `hasBody`, `bytesEqual`, `viaCount`, `decodeBody`, `headerHasToken`, `extractToTag`) — none of which are needed once the predicate is properly narrowed and a small set of body/header conveniences are added to `SipMessage` itself.

Goal: predicate bodies that read like the framework's own code — `msg.bodyEquals(bobSdp)`, `msg.getHeader("p-early-media").length === 0`, `msg.getHeader("to").tag === FORK_T2` — with the impossible cases removed at the type level.

The framework already exposes the narrow runtime types we need: `SipResponseTagged`, `InDialogRequest`, `MethodRequest<M>`, `InDialogMethodRequest<M>` (see [src/sip/types.ts](../../src/sip/types.ts) lines 167-220). This refactor wires them through the public DSL.

## Design

### 1. Typed predicate signatures in `ExpectOpts`

Public DSL API narrows `predicate` per call site. Internal AST storage stays wide — the interpreter calls the predicate after matching status/method, so the runtime narrowing IS true at call time. Erase the predicate type exactly once at the recorder boundary.

`ExpectOpts` becomes generic:

```ts
export interface ExpectOpts<M extends SipMessage = SipMessage> {
  readonly timeout?: number
  readonly predicate?: (msg: M, ctx: MessageContext) => boolean
  readonly allowReemission?: boolean
  readonly skipValidation?: ValidationCheckName[]
  readonly validation?: ValidationOverrides
}
```

Then each handle's `expect` overload picks the right `M`:

| Method | Predicate `M` |
|---|---|
| `UacInviteTransaction.expect<S extends number>(s: S, ...)` | `SipResponseTagged & { status: S }` |
| `UacTransaction.expect<S extends number>(s: S, ...)` | `SipResponseTagged & { status: S }` |
| `DialogRef.expect<M extends string>(method: M, ...)` | `InDialogMethodRequest<M>` |
| `UasInviteTransaction.expectAck` | `InDialogMethodRequest<"ACK">` |
| `UasInviteTransaction.expectCancel` | `MethodRequest<"CANCEL">` *(no To-tag guarantee — CANCEL runs in its own client txn pre-final response)* |
| `AgentProxy.receiveInitialInvite` | `MethodRequest<"INVITE">` *(initial INVITE has no To-tag)* |

Internal AST field at [src/test-harness/framework/types.ts:157](../../src/test-harness/framework/types.ts#L157) **stays** as `(msg: SipMessage, ctx: MessageContext) => boolean`. The recorder casts once at the emit site in [src/test-harness/framework/recorder.ts:368-385](../../src/test-harness/framework/recorder.ts#L368-L385):

```ts
predicate: opts?.predicate as ExpectStep["match"]["predicate"]
```

No `any` in the AST type — the cast is localised to one line.

### 2. Four new methods on `SipMessage`

Added to both `SipRequest` and `SipResponse` interfaces in [src/sip/types.ts](../../src/sip/types.ts) (lines 119-155). `InDialogRequest` and `SipResponseTagged` inherit them automatically.

| Method | Semantics |
|---|---|
| `hasBody(): boolean` | `body.length > 0` |
| `bodyText(): string` | `new TextDecoder().decode(body)` |
| `bodyEquals(other: Uint8Array): boolean` | byte-for-byte equality |
| `hasHeader(name: string): boolean` | case-insensitive presence check |

Implementations attached at construction inside `finalizeRequest` / `finalizeResponse` in [src/sip/parsers/extract-fields.ts:181-227](../../src/sip/parsers/extract-fields.ts#L181-L227). `hydrateRequest`/`hydrateResponse` already route through those two factories, so all production + test paths pick up the methods in one edit.

### 3. Migration of scenario files

After steps 1-2, the following local helpers are obsolete and **deleted** from every scenario file:

| Helper | Replacement |
|---|---|
| `headerValue / findHeader / getHeader` (13 files) | `msg.getHeader(name)` directly (typed) |
| `hasBody` (4 files) | `msg.hasBody()` |
| `bytesEqual` against `msg.body` (4 files) | `msg.bodyEquals(expected)` |
| `decodeBody` (6 files) | `msg.bodyText()` |
| `viaCount` (3 files) | `msg.getHeader("via").length` |
| `extractToTag` | `msg.getHeader("to").tag` |
| `headerHasToken` | inline regex on `msg.getHeader(name)[0]` (kept lossless) |

Local helpers kept (scenario-specific, not duplicated):
- `xApiAllowC` / `xApiCall` / `xApiHttpTimeout` — JSON-instruction builders
- `haKeepaliveCallBody` / `hangup` — scenario composition
- `isProxyStickinessRR` / `sdpBodyEqualIgnoringOrigin` — single-use domain regex

Every predicate that currently begins with `if (msg.type !== ...) return false` (24+ sites) loses that line: the narrowed type makes the check impossible.

### 4. One generator-test fix

[tests/sip/generators.test.ts:75-128](../../tests/sip/generators.test.ts#L75-L128) constructs `SipRequest` object literals inline without going through `hydrateRequest`. After the interface adds 4 required methods, those literals will fail typecheck. Migrate them to `hydrateRequest` (which already exists in the same module).

## Critical files

| File | Change |
|---|---|
| [src/sip/types.ts](../../src/sip/types.ts) | Add 4 methods to `SipRequest` + `SipResponse` (cascades to narrowed subtypes) |
| [src/sip/parsers/extract-fields.ts](../../src/sip/parsers/extract-fields.ts) | Implement `hasBody`/`bodyText`/`bodyEquals`/`hasHeader` inside `finalizeRequest` and `finalizeResponse` |
| [src/test-harness/framework/recorder.ts](../../src/test-harness/framework/recorder.ts) | Make `ExpectOpts` generic; type the six `expect`-family signatures; cast at AST emit site (one location) |
| [src/test-harness/framework/types.ts](../../src/test-harness/framework/types.ts) | No change to `ExpectStep.match.predicate` (stays wide) — included only for `ExpectOpts` import audit |
| [tests/sip/generators.test.ts](../../tests/sip/generators.test.ts) | Migrate inline literals to `hydrateRequest` |
| `tests/scenarios/*.ts` (13+ files) | Delete obsolete helpers; replace `msg.type !== ...` guards with direct typed access; rewrite per the table above |

## Execution order

1. Add 4 methods to `SipRequest`/`SipResponse` interfaces and implement in both finalizers. Run `npm run typecheck` — every literal `SipRequest`/`SipResponse` construction site that bypassed the factory will fail and surface itself.
2. Fix the surfaced literal sites (expected: only `tests/sip/generators.test.ts`).
3. Make `ExpectOpts<M>` generic and update all six `expect`-family overloads in recorder. Recorder cast at emit site.
4. Migrate scenarios one folder at a time, leaning on TypeScript: every old predicate body still compiles against the wider parent type until the helpers are deleted; once helpers go, the typed accesses become mandatory. Order: `refer-*.ts` (largest helper density) → `promote-pem-to-200.ts` (already partially uses `getHeader("to").tag`) → `reinvite.ts` / `suppress-18x.ts` / `fake-prack.ts` → HA scenarios → remainder.

## Verification

```bash
npm run typecheck       # must show zero errors AND zero Effect-plugin warnings
npm run test            # fake stack + short-tier live (default loop)
npm run test:ci         # confirm no regression on medium-tier live
```

The migration is structurally verifiable: if `npm run typecheck` is clean, every predicate now receives a narrowed type. Manual review checks:

1. `grep -rn "msg.type !==" tests/scenarios/` returns nothing.
2. `grep -rn "headerValue\|findHeader\|bytesEqual\|hasBody\|decodeBody\|viaCount\|headerHasToken\|extractToTag" tests/scenarios/` returns only the local definitions removed in this PR (post-deletion: zero).
3. Spot-check the largest converted scenario: re-read [tests/scenarios/promote-pem-to-200.ts](../../tests/scenarios/promote-pem-to-200.ts) and confirm every predicate fits in ≤4 lines.
4. Behaviour: `npm run test` produces byte-identical scenario traces — this is a pure typing/cleanup refactor with no runtime semantic change.
