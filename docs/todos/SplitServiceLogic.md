# Plan: Pluggable Call-Decision Layer (per-vendor adapter)

## Context

Today, `CallControlClient` ([src/http/CallControlClient.ts](src/http/CallControlClient.ts)) calls a backend HTTP server at three lifecycle points (`/call/new`, `/call/failure`, `/call/refer`) using a **fixed schema** ([src/http/CallControlSchemas.ts](src/http/CallControlSchemas.ts)). Integration with competing vendor APIs is blocked because:
1. The schema is fused to one specific backend contract.
2. Much of the post-decision work (b-leg shaping, limiter attachment, policy flag setting, header merging) lives inline in [src/b2bua/InitialInviteHandler.ts](src/b2bua/InitialInviteHandler.ts) rather than behind a clean interface.

**Goal:** define a canonical `CallDecisionEngine` service + Schema inside the B2BUA. Vendor HTTP APIs sit behind **per-vendor adapter Layers** chosen once at startup (no per-call swapping). Adapters translate canonical ↔ vendor JSON. Core SIP code never sees vendor-specific fields.

This also moves work currently embedded in `InitialInviteHandler` into the canonical response — the adapter dictates b-leg shape (URI, headers, body, feature activations) and rejection shape. Rule framework consumes the canonical decision and translates to internal actions.

**Scope:** v1 = Slices A + B. Slice C (second adapter as contract proof) parked for v2.

## Locked Decisions

### D1. Architecture
Canonical `CallDecisionEngine` interface + per-vendor adapter Layers, wired at startup. Not per-call.

### D2. Interface shape
Three methods: `newCall`, `callFailure`, `callRefer`. Each with typed request/response Schema. 1:1 mapping with existing lifecycle points ([InitialInviteHandler.ts:76](src/b2bua/InitialInviteHandler.ts#L76), [FailureRules.ts:55/132](src/b2bua/rules/defaults/FailureRules.ts), [TransferRules.ts:267](src/b2bua/rules/defaults/TransferRules.ts#L267)).

### D3. Header model — structured slots + free delta; 4-tier partition

| Tier | Headers | Delivery |
|------|---------|----------|
| **FORBIDDEN** (accepted call) | `Call-ID`, `Content-Length`, `Via`, `CSeq`, `Max-Forwards`, `Record-Route`, `Route`, `Contact` | Stack-only. Adapter cannot set. |
| **FORBIDDEN with 3xx exception** | `Contact` | Allowed only on 3xx reject responses (`contact: BareSipUri[]`). |
| **PARTIAL** | `From`, `To` | Structured slots: `fromUri: BareSipUri`, `fromDisplayName?: string`, `toUri: BareSipUri`, `toDisplayName?: string`. Tag stack-owned; `BareSipUri` brand makes tags syntactically unrepresentable. |
| **CAPABILITY** | `Require`, `Supported`, `Allow` | FREE delta map — stack merges mandatory tokens on top (e.g., re-asserts `100rel` in `Supported` if it will emit PRACK). |
| **FREE** | `P-Asserted-Identity`, `P-Preferred-Identity`, `Privacy`, `User-Agent`, `Subject`, `Organization`, `Priority`, `Reason`, `Warning`, `Retry-After`, `Diversion`, `History-Info`, `Geolocation`, `X-*` | `HeaderUpdates: Map<HeaderName, HeaderUpdate>` — reuses [src/b2bua/rules/framework/actions/types.ts](src/b2bua/rules/framework/actions/types.ts) ADT. |

**Enforcement (belt + suspenders):**
1. Compile-time: `HeaderUpdates` key type = `Exclude<HeaderName, ForbiddenHeaderName | PartialHeaderName>`.
2. Runtime: `custom(string)` escape hatch validates case-insensitively against FORBIDDEN and PARTIAL lists. Violation → `CallDecisionError(kind: "semantic-violation")`, logged at ERROR + metric `adapter_error_permanent` + call terminated with 500. **No silent dropping.**

**Outbound Route header:** not a header — structured slot `routeSet?: BareSipUri[]` sibling to `destination`; reuses [applyRouteSet()](src/b2bua/rules/framework/ActionExecutor.ts).

**Privacy:** handled via FREE header + `fromUri`/`fromDisplayName` structured slots (adapter decides anonymization). Not a feature activation.

### D4. Body model

```ts
type BodyIntent =
  | { kind: "inherit" }                           // passthrough incoming body + Content-Type
  | { kind: "drop" }                              // no body
  | { kind: "sdp", sdp: Uint8Array }              // replace; Content-Type locked to application/sdp
  | { kind: "multipart", subtype: "mixed" | "alternative", parts: Part[] }
  | { kind: "raw", bytes: Uint8Array, contentType: string }  // escape hatch, metrics-tracked

type Part = {
  contentType: string                              // e.g. "application/pidf+xml", "application/indata"
  contentId?: string                               // for cid: references from Geolocation / other headers
  contentDisposition?: string
  body: PartBody
}

type PartBody =
  | { kind: "bytes", value: Uint8Array }           // binary-safe
  | { kind: "incoming-sdp" }                       // splice in original INVITE SDP verbatim
  | { kind: "incoming-body" }                      // splice in entire incoming body verbatim
```

- Stack assembles multipart (boundary, `Content-Type: multipart/mixed; boundary=...`, Content-Length). Adapter cannot produce malformed multipart.
- `Content-Type` never appears in header delta map.
- **cid-reference validator:** Before wire-serialization, stack scans headers for `cid:<id>` URIs; every such id must match a part's `contentId`. Mismatch → `CallDecisionError`. Protects Geolocation ↔ PIDF-LO linkage.
- v1 multipart subtypes: `mixed | alternative` only.
- Request-side to adapter: both raw bytes and parsed parts.

### D5. Feature activation

```ts
type RouteResponse = {
  // ... destination, uris, headers, body ...
  platform: {
    maxDurationSec: number                        // MANDATORY — adapter must supply; platform-capped (fallback ≤ 12h)
    keepalive: { intervalSec: number, maxMissed: number }   // MANDATORY — non-optional
  }
  features?: {
    refer?: { maxChainDepth?: number }            // undefined = REFER disabled for this call
    relayFirst18xTo180?: { strategy: "drop-sdp" | "keep-sdp" }
    noAnswerTimeoutSec?: number
    callLimiters?: Array<{ id: string, limit: number }>
  }
}
```

- Closed TypeScript union. Vendor adapters cannot invent new features.
- Absence = explicitly disabled (not "default").
- `/call/failure` and `/call/refer` may **override** feature set for the new leg; no merge.
- Each feature ships with: canonical field + param schema + `PolicyModule` gated on presence + test.

### D6. v1 feature set

Mandatory (on every Route/RejectA/ReferAllow):
- **`platform.maxDurationSec`** — every call gets a cap; adapter supplies, platform enforces ceiling.
- **`platform.keepalive`** — non-optional.

Optional:
- `features.refer` (make explicit; today implicitly always-on)
- `features.relayFirst18xTo180` (exists)
- `features.noAnswerTimeoutSec` (exists)
- `features.callLimiters` (exists)

### D7. Reject response shape

```ts
type RejectResponse =
  | {                                              // 3xx redirect
      statusCode: 300 | 301 | 302 | 305 | 380
      reasonPhrase?: string
      contact: BareSipUri[]                        // MANDATORY for 3xx, flat list (no q=/expires= in v1)
      headers?: HeaderUpdates                      // FREE tier (incl. Retry-After, Warning)
      body?: BodyIntent                            // e.g., 380 with alt-service SDP
    }
  | {                                              // reject
      statusCode: 400..699 (non-3xx)
      reasonPhrase?: string
      contact?: never                              // compile error if adapter tries
      headers?: HeaderUpdates
      body?: BodyIntent                            // e.g., 488 with codec list
    }
```

- Status-class narrowing: `contact` only typeable on 3xx. Zero chance of 4xx-with-Contact leaks.
- Retry-After / Warning are FREE headers (not structured slots).
- No From/To/Contact slots — From/To echoed from request; To-tag is stack's UAS tag.

### D8. Lifecycle method response shapes

```ts
type NewCallResponse = Route | Reject

type CallFailureResponse = Route | Terminate | RejectA
type Terminate = { kind: "terminate" }                               // propagate b-leg failure to a-leg verbatim
type RejectA = {
  kind: "reject-a",
  statusCode: 300..699,
  reasonPhrase?: string,
  headers?: HeaderUpdates,
  body?: BodyIntent,
  contact?: BareSipUri[]                                             // only on 3xx (typed narrowing)
}

type CallReferResponse = ReferAllow | ReferReject
type ReferAllow = Route & { referToOverride?: BareSipUri }           // reuse Route; optional Refer-To override
type ReferReject = { statusCode: number, reasonPhrase?: string }     // narrow → sipfrag NOTIFY body
```

- `Route` reused across `newCall` and `callFailure`. Features override on failover; no merge.
- `RejectA` lets adapter rewrite the a-leg rejection when triggered by b-leg failure (e.g., 503 → 486).
- `ReferAllow` reuses `Route`. Stack still auto-builds held-SDP for initial C-leg INVITE ([SdpUtils.ts:129-144](src/sip/SdpUtils.ts#L129-L144)); adapter's body/headers apply to subsequent C-leg re-INVITE.
- `ReferReject` is narrow: REFER reject becomes sipfrag; headers/body/contact would be silently ignored.

### D9. Opaque adapter-owned payloads

```ts
{
  callbackContext?: string   // adapter-private state, threaded into next lifecycle call request body
  billingContext?: string    // adapter-chosen attribution blob, emitted once into terminal CDR event
}
```

- Both typed `string`, byte-safe (adapter base64s binary). Canonical type is `string` to avoid Redis + JSON friction.
- `callbackContext`: unchanged semantics; stored on `Call.callbackContext`; re-indexed in Redis under `ctx:` ([CallState.ts:134](src/call/CallState.ts#L134)).
- `billingContext`: new; stored on `Call.billingContext`; **emitted once at call termination** in the final CDR record. Latest-wins across lifecycle overrides.
- Stack has zero opinions about either payload's shape.

### D10. Request-side canonical payload

```ts
type NewCallRequest = {
  callId: string
  ruri: SipUri
  from: { uri: SipUri, displayName?: string, tag: string }
  to:   { uri: SipUri, displayName?: string }
  via: ViaHeader[]
  contact?: ContactHeader[]
  headers: ReadonlyMap<HeaderName, string[]>                        // all non-stack-owned headers
  body?: { contentType: string, raw: Uint8Array, parts?: ParsedPart[] }
  transport: "udp" | "tcp" | "tls" | "ws" | "wss"
  sourceAddress: string
  sourcePort: number
  receivedAt: Date
}

type CallFailureRequest = {
  callId: string
  callbackContext?: string
  failure:
    | { kind: "external", statusCode: number, reasonPhrase: string, headers: Map<HeaderName, string[]>, body?: { contentType, raw, parts? } }
    | { kind: "no-answer-timeout" }
    | { kind: "call-limiter", limiterId: string }
  failedAttempt: {
    destination: { host: string, port: number, transport: string }
    attemptNumber: number                                           // 1-based
    features: FeatureActivations                                    // features active on failed leg
  }
}

type CallReferRequest = {
  callId: string                                                    // A-leg Call-ID
  dialogId: string                                                  // B-leg dialog id
  callbackContext?: string
  referTo: SipUri
  referredBy?: SipUri
  headers: ReadonlyMap<HeaderName, string[]>
  priorFeatures: FeatureActivations                                 // features active when REFER arrived
}
```

- Structured URIs / Via / Contact — adapters don't re-parse SIP (reuse [src/sip/](src/sip/) parsers).
- Prior features included on failure/refer — adapter can reason about what was active on the failed/referring leg.
- `replacesPresent` omitted for v1 — REFER-with-Replaces is rejected pre-adapter today ([TransferRules.ts:113-135](src/b2bua/rules/defaults/TransferRules.ts#L113-L135)); add when attended transfer ships.

### D11. Adapter error semantics

| Failure mode | `newCall` | `callFailure` | `callRefer` | Tier |
|---|---|---|---|---|
| Timeout | 503 to A-leg | Terminate; propagate verbatim | REFER 500 (sipfrag) | Transient — WARN |
| Network error / connection refused | 503 | Terminate | REFER 500 | Transient — WARN |
| HTTP 5xx | 503 | Terminate | REFER 500 | Transient — WARN |
| HTTP 4xx | 500 | Terminate | REFER 500 | Bug — ERROR |
| Schema decode failure | 500 | Terminate | REFER 500 | Bug — ERROR |
| Canonical semantic violation | 500 | Terminate | REFER 500 | Bug — ERROR |
| Effect defect | 500 | Terminate | REFER 500 | Bug — ERROR |

- **No stack-level retries.** Adapter owns retry/circuit-breaker logic internally.
- **Differentiated observability.** Transient → WARN + `adapter_error_transient{method, adapter, kind}`. Bug → ERROR + `adapter_error_permanent{method, adapter, kind}` + OpenTelemetry span marked error.
- **Reuse existing overload protection** — each adapter Layer wraps its HTTP/RPC call with the latency observer ([CallControlClient.ts:65-78](src/http/CallControlClient.ts#L65-L78)); existing overload module ([docs/overload-protection.md](docs/overload-protection.md)) handles load shedding. No new circuit breaker in v1.

**`CallDecisionError` as tagged ADT:**
```ts
class CallDecisionError extends Schema.TaggedError("CallDecisionError")({
  kind: Schema.Literal("timeout", "network", "http-5xx", "http-4xx", "schema-violation", "semantic-violation", "defect"),
  adapterName: Schema.String,
  method: Schema.Literal("newCall", "callFailure", "callRefer"),
  detail: Schema.String,
  cause: Schema.Unknown,
})
```

**Semantic validation pipeline** (stack-side, runs after adapter returns):
1. `Schema.decode` — type violations.
2. `validateForbiddenHeaders` — `HeaderUpdates` map vs FORBIDDEN/PARTIAL lists.
3. `validateCidCrossReferences` — every `cid:<id>` in headers matches a part's `contentId`.
4. `validateFeatureActivations` — mandatory `platform.maxDurationSec` + `platform.keepalive` present; `maxDurationSec` ≤ platform ceiling.

All failures → `CallDecisionError(kind: "semantic-violation")`. One validator, all adapters safe.

**Per-method timeouts** configurable per adapter:
```ts
type AdapterConfig = {
  timeouts: { newCall: Duration, callFailure: Duration, callRefer: Duration }
  // + vendor-specific fields
}
```

### D12. File layout

```
src/decision/
  ├── CallDecisionEngine.ts         # Effect service + service tag
  ├── schemas/
  │   ├── common.ts                 # BareSipUri, SipUri, HeaderUpdates, BodyIntent, FeatureActivations
  │   ├── requests.ts               # NewCallRequest, CallFailureRequest, CallReferRequest
  │   ├── responses.ts              # Route, Reject, Terminate, RejectA, ReferAllow, ReferReject
  │   └── errors.ts                 # CallDecisionError (tagged ADT)
  ├── validators/                   # post-adapter canonical validation
  │   ├── forbiddenHeaders.ts
  │   ├── cidCrossRef.ts
  │   ├── features.ts
  │   └── pipeline.ts               # composes all validators
  ├── apply/                        # canonical response → internal rule actions / handler results
  │   ├── applyRoute.ts
  │   ├── applyReject.ts
  │   ├── applyTerminate.ts
  │   ├── applyRejectA.ts
  │   ├── applyReferAllow.ts
  │   └── applyReferReject.ts
  └── adapters/
      └── http-reference/           # existing CallControlClient refactored into this adapter
          ├── HttpReferenceAdapter.ts
          ├── schemas.ts            # vendor JSON (today's shape, 1:1 with canonical in v1)
          └── MockServer.ts         # relocated MockCallControlServer
```

## Implementation Slices

### Slice A — Canonical extraction (no behavior change)

**Changes:**
- Create `src/decision/` subtree with Schemas, Service, and the HTTP Reference Adapter.
- Refactor [src/http/CallControlClient.ts](src/http/CallControlClient.ts) → `src/decision/adapters/http-reference/HttpReferenceAdapter.ts`. Delete the old file.
- Split [src/http/CallControlSchemas.ts](src/http/CallControlSchemas.ts) into canonical (`src/decision/schemas/`) and vendor-reference (`src/decision/adapters/http-reference/schemas.ts`). Delete old file.
- Relocate [src/http/MockCallControlServer.ts](src/http/MockCallControlServer.ts) → `src/decision/adapters/http-reference/MockServer.ts`.
- Rewire call sites to use `CallDecisionEngine` service:
  - [src/b2bua/InitialInviteHandler.ts:76-82](src/b2bua/InitialInviteHandler.ts#L76) → `decisionEngine.newCall(...)`
  - [src/b2bua/rules/defaults/FailureRules.ts:54-69](src/b2bua/rules/defaults/FailureRules.ts) → `decisionEngine.callFailure(...)`
  - [src/b2bua/rules/defaults/FailureRules.ts:131-142](src/b2bua/rules/defaults/FailureRules.ts) → `decisionEngine.callFailure(...)`
  - [src/b2bua/rules/defaults/TransferRules.ts:223-280](src/b2bua/rules/defaults/TransferRules.ts) → `decisionEngine.callRefer(...)`
- Update [tests/fullcall/framework/MockCallControlLayer.ts](tests/fullcall/framework/MockCallControlLayer.ts) to implement the canonical interface.
- **v1 canonical schema = current schema, 1:1.** HTTP Reference Adapter is essentially a field-rename of today's `CallControlClient`. No behavior divergence.

**Verification:**
- `npm run typecheck` — zero errors, zero warnings.
- `npm run test:fake` — full fake-stack suite green.
- `npm run test` — fake + live-short tier green.
- Git diff review: every call site migrated; no references to `CallControlClient` symbol remain.

### Slice B — Shaping migration + rich canonical

**Changes:**

1. **Header partition enforcement.**
   - Define FORBIDDEN + PARTIAL lists in `src/decision/validators/forbiddenHeaders.ts`.
   - Add compile-time `HeaderUpdates` key exclusion.
   - Add runtime `custom(string)` validator.
   - Negative tests (both `ts-expect-error` for compile-time, and runtime assertion).

2. **Structured `BodyIntent`.**
   - Replace today's loose `update_body: string | null` with typed union in canonical schema.
   - `src/decision/apply/applyRoute.ts` assembles multipart with boundary generation, Content-Length calc, cid validation.
   - Golden tests: inherit, drop, sdp, multipart (incl. PIDF-LO + Content-ID + Geolocation cross-ref).

3. **`FeatureActivations` structured map.**
   - Replace `Call.policies` → `Call.features: FeatureActivations` in [src/call/CallModel.ts](src/call/CallModel.ts).
   - Migrate [src/b2bua/rules/custom/relayFirst18xTo180.ts](src/b2bua/rules/custom/relayFirst18xTo180.ts) — guard reads `ctx.call.features?.relayFirst18xTo180 !== undefined`.
   - New `PolicyModule`s (or handler logic) for: `refer`, `keepalive`, `maxDuration`.
   - Mandatory validation: `platform.maxDurationSec` + `platform.keepalive` must be present on every `Route`/`RejectA`/`ReferAllow`.

4. **Billing context.**
   - Add `Call.billingContext: string | null` to [CallModel.ts](src/call/CallModel.ts).
   - Emit once at call termination in final CDR event ([src/cdr/CdrWriter.ts](src/cdr/CdrWriter.ts)).

5. **Move post-HTTP shaping out of `InitialInviteHandler`.**
   - [src/b2bua/InitialInviteHandler.ts:125-219](src/b2bua/InitialInviteHandler.ts#L125-L219): limiter attachment, policy flag merging, b-leg shaping all move into `src/decision/apply/applyRoute.ts` (returns rule actions + state updates).
   - Handler shrinks to: parse INVITE → build canonical request → call engine → validate → apply → assemble `HandlerResult`.

6. **Error semantics.**
   - Implement `CallDecisionError` tagged ADT.
   - Wrap each adapter call with the validation pipeline.
   - Add dual metric counters (transient/permanent), WARN vs ERROR logging.
   - Per-method timeouts from `AdapterConfig`.

7. **Adapter-side — HTTP Reference Adapter extensions.**
   - Map canonical `BodyIntent` ↔ vendor JSON (today's `update_body` becomes a narrow encoding of the union).
   - Map canonical `FeatureActivations` ↔ vendor flat flags.
   - Map canonical headers partition ↔ vendor `update_headers`.
   - No vendor schema change (backwards-compatible) — translation lives entirely in the adapter.

**Verification:**
- Per-feature contract test: "adapter returns feature X → PolicyModule fires → expected SIP observed."
- Per-tier header validator tests (compile + runtime negative cases).
- Multipart golden tests (PIDF-LO with Content-ID + Geolocation `cid:` consistency).
- Billing context: set on Route → appears in terminal CDR record; override on callFailure → latest wins.
- Adapter error: inject each `CallDecisionError.kind` → assert correct SIP outcome + correct metric tier + correct log level.
- `npm run test:ci` — fake + live-medium tier green.
- Live-long tier green (max duration, no-answer timeouts, keepalive).

## Critical Files

**Modified:**
- [src/b2bua/InitialInviteHandler.ts](src/b2bua/InitialInviteHandler.ts) — dispatcher only; shaping moves out.
- [src/b2bua/helpers.ts](src/b2bua/helpers.ts) — header merge logic moves into `applyRoute`.
- [src/b2bua/rules/defaults/FailureRules.ts](src/b2bua/rules/defaults/FailureRules.ts), [TransferRules.ts](src/b2bua/rules/defaults/TransferRules.ts) — rule bodies call `CallDecisionEngine`.
- [src/b2bua/rules/custom/relayFirst18xTo180.ts](src/b2bua/rules/custom/relayFirst18xTo180.ts) — guard reads `features.relayFirst18xTo180`.
- [src/call/CallModel.ts](src/call/CallModel.ts) — `policies` → `features`; add `billingContext`.
- [src/cdr/CdrWriter.ts](src/cdr/CdrWriter.ts) — emit `billingContext` at terminal event.
- [tests/fullcall/framework/MockCallControlLayer.ts](tests/fullcall/framework/MockCallControlLayer.ts) — canonical interface.

**Removed post-migration:**
- [src/http/CallControlClient.ts](src/http/CallControlClient.ts) → becomes `HttpReferenceAdapter`.
- [src/http/CallControlSchemas.ts](src/http/CallControlSchemas.ts) → split.
- [src/http/MockCallControlServer.ts](src/http/MockCallControlServer.ts) → relocated.

**New (under `src/decision/`):**
- Service definition, all canonical schemas, validators, apply functions, HTTP Reference Adapter.

## v2 Backlog (out of scope)

- **Slice C**: second adapter proving contract vendor-agnosticism.
- `replacesPresent` on `CallReferRequest` when attended transfer ships.
- `features.sessionTimers` (RFC 4028) when needed.
- `features.rfc3325Trust` / trust-domain semantics.
- Mid-call feature toggling (would require streaming adapter interface — D2 option (c)).
- Retry-After / Warning structured slots if FREE-delta proves too ambiguous in practice.
- `q=` / `expires=` params on 3xx Contact list.
- `multipart/related` subtype for rich content references.
- Adapter-level circuit breaker (if overload module proves insufficient).
- `CallDecisionError.kind = "http-4xx"` escalation path (adapter contract violations might deserve a call-global kill-switch).

## Verification End-to-End

Slice A gate:
```
npm run typecheck                # zero errors, zero warnings
npm run test:fake                # all fake-stack scenarios pass
npm run test                     # fake + live-short tier
```

Slice B gate:
```
npm run typecheck                # zero errors, zero warnings
npm run test:ci                  # fake + live-medium tier
npm run test:nightly             # fake + all live tiers, incl. long (maxDuration, keepalive, no-answer)
```

Manual smoke (both slices):
- Start dev server against mock backend: `npm run dev`
- Send sipp INVITE scenario against server; observe canonical request in mock server logs; assert feature activations fire as expected.
- For Slice B: exercise PIDF-LO multipart scenario (Geolocation + Content-ID) via a purpose-built sipp scenario; assert b-leg INVITE contains proper multipart with consistent cid.
