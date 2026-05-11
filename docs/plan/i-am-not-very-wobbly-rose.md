# Unify SIP message header access behind `getHeader()`

## Context

The current `SipMessage` interface leaks two implementation details to its callers:

1. **Eager vs lazy parsing.** Mandatory fields (`From`, `To`, `Call-ID`, `CSeq`, top `Via`, `Contact`, Request-URI) are exposed via `msg.parsed.*`. Optional structured headers (`P-Asserted-Identity`, `Diversion`, `History-Info`, `Geolocation*`, `Remote-Party-ID`, `RAck`, `Refer-To`) are exposed via `msg.lazy.*()` and return `Result<T, SipParseError>`. The caller is forced to know which family a header belongs to.
2. **Request/response asymmetry.** The same header (e.g. `From`) is accessed identically on a request and a response, yet the type system surfaces two separate views (`SipRequest.parsed` / `SipResponse.parsed`) that diverge over time.

This refactor introduces a single `getHeader<K>(name)` accessor on `SipMessage`, backed by a runtime header registry and a per-key TypeScript registry (`SipHeaderTypes`), so that:

- Eager/lazy parsing becomes an internal optimization invisible to the caller.
- Requests and responses share one unified header-access API.
- Third parties can extend the registry — both the TS types (via `declare module`) and the runtime parser (via `SipHeaderRegistry.register`) — and get full type safety on their custom headers.

The end state is `.parsed`/`.lazy` removed from `SipMessage`, every internal and external call site using `getHeader()`, and the third-party extension contract documented and tested.

## Design summary

### Public API

```ts
// src/sip/types.ts

export type NonEmptyReadonlyArray<T> = readonly [T, ...T[]]

export interface SipHeaderTypes {
  // mandatory single-valued — guaranteed present, returned as plain T
  'from': ParsedNameAddrField
  'to': ParsedNameAddrField
  'call-id': string
  'cseq': ParsedCSeqField

  // mandatory multi-valued — non-empty array (top via = [0])
  'via': NonEmptyReadonlyArray<ParsedViaField>

  // optional single-valued
  'contact': ParsedContactField | undefined
  'geolocation-routing': Result.Result<boolean | undefined, SipParseError>
  'rack': Result.Result<ParsedRack | undefined, SipParseError>
  'refer-to': Result.Result<ParsedReferTo | undefined, SipParseError>

  // optional multi-valued (lazy, Result-typed — preserves today's error contract)
  'p-asserted-identity': Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>
  'p-preferred-identity': Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>
  'diversion': Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>
  'history-info': Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>
  'remote-party-id': Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>
  'geolocation': Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>
  'geolocation-error': Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>
}

export interface SipMessageBase {
  readonly type: 'request' | 'response'
  readonly version: string
  readonly headers: ReadonlyArray<SipHeader>
  readonly body: Uint8Array
  readonly raw: Buffer

  // Typed access by registered key.
  getHeader<K extends keyof SipHeaderTypes>(name: K): SipHeaderTypes[K]
  // Raw fallback for unknown header names.
  getHeader(name: string): ReadonlyArray<string>
}

export interface SipRequest extends SipMessageBase {
  readonly type: 'request'
  readonly method: string
  readonly requestUri: ParsedRequestUriField   // moved up from .parsed
}

export interface SipResponse extends SipMessageBase {
  readonly type: 'response'
  readonly status: number
  readonly reason: string
}
```

### Narrowing on refined message types

```ts
// src/sip/types.ts — overloads preserve .parsed.from.tag: string narrowing
export interface InDialogRequest extends SipRequest {
  getHeader(name: 'from'): TaggedNameAddrField
  getHeader(name: 'to'): TaggedNameAddrField
  getHeader<K extends keyof SipHeaderTypes>(name: K): SipHeaderTypes[K]
  getHeader(name: string): ReadonlyArray<string>
}

export interface SipResponseTagged extends SipResponse {
  getHeader(name: 'to'): TaggedNameAddrField
  getHeader<K extends keyof SipHeaderTypes>(name: K): SipHeaderTypes[K]
  getHeader(name: string): ReadonlyArray<string>
}
```

`MethodRequest<M>` is unchanged — it narrows the top-level `method` property, not a header.

### Runtime header registry

```ts
// src/sip/header-registry.ts (new file)

export interface HeaderDescriptor<T> {
  readonly name: string                   // canonical lowercase long form
  readonly aliases?: ReadonlyArray<string>  // e.g. 'f' for 'from'
  readonly eager: boolean                 // parsed at message-parse time vs on first access
  readonly parse: (rawValues: ReadonlyArray<string>) => T
}

export class SipHeaderRegistry {
  register<T>(desc: HeaderDescriptor<T>): void
  get(name: string): HeaderDescriptor<unknown> | undefined
  resolveAlias(name: string): string  // returns canonical name (lowercase, alias-expanded)
  eagerDescriptors(): ReadonlyArray<HeaderDescriptor<unknown>>
}

// Built-in registrations live in src/sip/header-registry-defaults.ts and are
// installed via registerStandardHeaders(registry) at process start.
```

The host application calls `registerStandardHeaders(registry)` at startup; third-party plugins call their own `register(...)` for custom headers and use `declare module` to extend `SipHeaderTypes`. Type and runtime stay in sync **by host responsibility** — a registered TS key without a runtime parser falls through to the raw-string fallback (no soundness violation, just a missed registration that tests will catch).

### `getHeader()` implementation sketch

```ts
// On the message implementation:
// - Eager headers are precomputed slots (one allocation per message at parse time).
// - Lazy headers use a per-message memoization map keyed by canonical header name.
getHeader(name: string): unknown {
  const canonical = registry.resolveAlias(name.toLowerCase())
  const desc = registry.get(canonical)
  if (desc === undefined) {
    return this.rawHeaderValues(canonical)  // ReadonlyArray<string>
  }
  if (desc.eager) {
    return this.eagerSlots[canonical]
  }
  const cached = this.lazyCache.get(canonical)
  if (cached !== undefined) return cached
  const parsed = desc.parse(this.rawHeaderValues(canonical))
  this.lazyCache.set(canonical, parsed)
  return parsed
}
```

This preserves today's behavior bit-for-bit: eager headers are precomputed in the parser, lazy headers are computed-once and memoized.

## Phasing

### PR 1 — Infrastructure (small, design-validating)

Goal: introduce `getHeader()`, the registry, and the top-level `requestUri`, while leaving every existing call site untouched.

Files added:
- `src/sip/header-registry.ts` — `SipHeaderRegistry` class, `HeaderDescriptor<T>` type.
- `src/sip/header-registry-defaults.ts` — `registerStandardHeaders(registry)` that registers all built-in keys with their existing parsers (eagerly delegating to the same functions used in `extractCommonFields` / `extractResponseFields` and `LazyHeaders`).
- `tests/sip/header-registry-parity.test.ts` — for a fixture battery of messages, asserts that `msg.getHeader('from')` equals `msg.parsed.from`, `msg.getHeader('via')` equals `msg.parsed.vias`, `msg.getHeader('p-asserted-identity')` equals `msg.lazy.pAssertedIdentity()`, etc. This is the safety net for PR 2.

Files modified:
- `src/sip/types.ts` — add `SipHeaderTypes`, `NonEmptyReadonlyArray<T>`, `getHeader` method on `SipMessageBase`, add overloads on `InDialogRequest` and `SipResponseTagged`. Move `requestUri` from `RequestParsedFields` to top-level `SipRequest`. Keep `.parsed`/`.lazy` exactly as today; flag them with `@deprecated — use getHeader()` JSDoc.
- `src/sip/parsers/*.ts` — populate the new top-level `requestUri` field, implement `getHeader()` on the request/response objects (or wrap them), wire eager-slot precomputation through the registry.
- Wherever a `SipMessage` is constructed (parser output, test harness builders): also populate the precomputed slots and lazy cache plumbing.

PR 1 makes **zero call-site changes**. Existing typecheck and tests must all pass. The parity test is the design-validation gate.

### PR 2 — Full migration + cleanup (mechanical, larger)

Goal: every internal and external call site uses `getHeader()`; `.parsed`/`.lazy` removed.

Migrations (hand-walked, ~230 sites):

- `msg.parsed.from` → `msg.getHeader('from')`
- `msg.parsed.to` → `msg.getHeader('to')`
- `msg.parsed.callId` → `msg.getHeader('call-id')`
- `msg.parsed.cseq` → `msg.getHeader('cseq')`
- `msg.parsed.via` → `msg.getHeader('via')[0]`  (NonEmptyReadonlyArray guarantees `[0]` is `ParsedViaField`)
- `msg.parsed.vias` → `msg.getHeader('via')`
- `msg.parsed.contact` → `msg.getHeader('contact')`
- `msg.parsed.requestUri` → `msg.requestUri` (top-level)
- `msg.lazy.pAssertedIdentity()` → `msg.getHeader('p-asserted-identity')`
- ... (every lazy-header call, same pattern; return type unchanged — still `Result<...>`)

Critical files (highest call-site density, walk first):
- [src/sip-front-proxy/ProxyCore.ts](src/sip-front-proxy/ProxyCore.ts)
- [src/test-harness/framework/interpreter.ts](src/test-harness/framework/interpreter.ts)
- [src/test-harness/framework/validation.ts](src/test-harness/framework/validation.ts)
- [src/sip/SipRouter.ts](src/sip/SipRouter.ts)
- [src/b2bua/rules/defaults/DialogRules.ts](src/b2bua/rules/defaults/DialogRules.ts)
- [src/b2bua/rules/defaults/TransferRules.ts](src/b2bua/rules/defaults/TransferRules.ts)
- [src/sip-front-proxy/RegisterStrategy.ts](src/sip-front-proxy/RegisterStrategy.ts)
- [src/sip-front-proxy/strategies/LoadBalancer.ts](src/sip-front-proxy/strategies/LoadBalancer.ts)
- [src/sip-front-proxy/health/HealthProbe.ts](src/sip-front-proxy/health/HealthProbe.ts)
- [src/test-harness/framework/message-builder.ts](src/test-harness/framework/message-builder.ts)
- [src/test-harness/framework/offer-answer-tracker.ts](src/test-harness/framework/offer-answer-tracker.ts)
- [src/test-harness/framework/text-report.ts](src/test-harness/framework/text-report.ts)
- All `tests/harness/rules/rfc/*.ts` and the `tests/sip-front-proxy/**` test files (~10–15 files)

Cleanup at the end of PR 2:
- Delete `RequestParsedFields.requestUri`, `ResponseParsedFields`, and the `parsed`/`lazy` properties from `SipMessage`.
- Delete the `LazyHeaders` class (its parsing functions are reused by the registry; only the class itself goes).
- Delete the `RequestParsedFields` / `ResponseParsedFields` / `ParsedFieldsCommon` interfaces unless they're independently useful elsewhere.
- Update the narrowed-type definitions (`InDialogRequest`, `SipResponseTagged`) to remove the `parsed: ... & {...}` intersection.

Re-uses (do not re-implement):
- All structured-header parsers in [src/sip/parsers/custom/structured-headers.ts](src/sip/parsers/custom/structured-headers.ts) (`parseNameAddr`, `parseRack`, `parseReferTo`, `splitTopLevelCommas`).
- The eager extraction helpers in [src/sip/parsers/custom/extract-common-fields.ts](src/sip/parsers/) — wired through the registry's `parse` function instead of called directly.
- `Result` from `effect` for lazy-header return values.

## Verification

End-to-end verification, executed after each PR:

1. `npm run typecheck` — zero errors, zero warnings (including the Effect TS language-service plugin). The narrowed-type overloads must compile clean; an `expectTypeOf` test in `tests/sip/header-registry-typing.test.ts` asserts:
   - `getHeader('from')` returns `ParsedNameAddrField` (not `| undefined`).
   - On `InDialogRequest`, `getHeader('from')` returns `TaggedNameAddrField`.
   - `getHeader('via')` returns `NonEmptyReadonlyArray<ParsedViaField>`, and `[0]` is `ParsedViaField` (not `| undefined`).
   - `getHeader('p-asserted-identity')` returns `Result.Result<ReadonlyArray<ParsedNameAddr>, SipParseError>`.
   - `getHeader('x-custom-unknown')` returns `ReadonlyArray<string>`.

2. `npm run test:fake` — full fake-stack suite passes. The new `tests/sip/header-registry-parity.test.ts` (added in PR 1) asserts behavioral equivalence between old and new APIs for the fixture battery:
   - From / To / Call-ID / CSeq / top Via / Contact match `.parsed.*`.
   - PAI / Diversion / History-Info / Remote-Party-ID / Geolocation* / RAck / Refer-To match `.lazy.*()`.
   - Malformed-header cases produce identical `Result.fail(SipParseError)` payloads.
   - Compact-form lookup: `getHeader('f')` falls through to raw strings (since 'f' is not in `SipHeaderTypes`); `getHeader('From')` and `getHeader('FROM')` both normalize to the typed entry.

3. `npm run test:ci` — medium-tier live SIP scenarios pass unchanged. Confirms that real-UDP, real-clock paths behave identically after the swap.

4. **Third-party extension smoke test** (added in PR 1): a new test in `tests/sip/header-registry-extension.test.ts` declaration-merges a custom key (e.g. `'x-test-routing': { hop: string }`), registers a parser at runtime, and asserts that `getHeader('x-test-routing')` returns the parsed type and is correctly memoized.

5. Spot-check the existing fullcall e2e suites (`tests/fullcall/e2e-fake-clock.test.ts`, `tests/fullcall/e2e-real-clock.test.ts`) — these exercise the deepest message-handling paths and are the strongest behavioral signal that the migration is invisible.

## Out of scope (deferred or explicitly not done)

- No new headers added in this refactor — the registry starts with exactly today's set.
- `msg.headers` (the raw `ReadonlyArray<SipHeader>`) stays — it's used by serialization, copying, and Via stamping. Not deprecated.
- No codemod. PR 2 is hand-walked; the parity test from PR 1 is the safety net.
- No external API documentation rewrite in this plan — that lands as a follow-up doc-only PR once the migration is merged.
