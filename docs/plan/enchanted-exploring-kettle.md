# Plan — Finish the `~/complaints.md` items to unblock the `~/prbt` dogfood

## Context

The `~/prbt` integrator dogfood builds basic PRBT (personalised ringback) as a
policy module against the ADR-0015 extensibility model. It proves the rule logic
but **cannot** author/activate/e2e-test a service as a *package consumer* (it
deep-imports core via a `repos/sipjsserver` symlink), and the runtime lacks the
leg-type correctness PRBT's parked MRF media leg needs. The callflow-service
*model* is already done on this branch (typed `ext`, `defineService`,
`isApplicable`, layered first-match-wins selection — commits `71060306`+`5fb7256d`).
This plan implements the **remaining** items from `~/complaints.md`, organised by
the handoff's two subsections. Both are required: A gives the integrator a surface;
B gives the runtime leg-type correctness.

Confirmed decisions (asked up front):
- **Leg taxonomy = ADR-0014 full**: `kind: "a" | "destination" | "media" | "transfer-target"` + explicit `adopted` boolean. The unadopted gate keys on `adopted`.
- **SDK enforcement = strong/typed**: a `PublicRuleAction` subset; the SDK's `defineRule`/`defineService` constrain emitted actions to it so internal actions (`send-raw`, PRACK/transfer/tag-mapping internals) are a **compile error** for integrators.
- **Sequence = all of A, then all of B**, typecheck + `test:fake` throughout.

---

## Subsection A — integrator surface (author / activate / test)

### A.1 — `@vcharbon/sipjs/rules-sdk` curated subpath (precursor) — `rule-sdk-not-exported`

The exact surface PRBT needs (from `~/prbt/src/prbt/PrbtPolicy.ts` + `registry.ts`
deep-imports): `defineRule`, `definePolicyModule`, `defineService` + `service.activate`,
`Match`, `RuleContext`, `RuleAction`, `H`, `removeH`/`replaceH`, `HeaderName`/`HeaderUpdate`,
`getHeader`, `newTag`, `createRuleRegistry`, `defaultRules`, `relayFirst18xTo180`,
`promote18xPemTo200`, `referTransfer`, `buildHandlers`, `AnyRuleDefinition`.

1. **New public-action subset** — `src/b2bua/rules/framework/actions/public.ts`:
   `export type PublicRuleAction = Extract<RuleAction, { type: "relay-to-peer" | "relay-to-leg" | "respond" | "ack-leg" | "send-request-to-leg" | "send-provisional-to-leg" | "create-leg" | "destroy-leg" | "cancel-leg" | "merge" | "split" | "schedule-timer" | "cancel-timer" | "cancel-all-timers" | "terminate-call" | "begin-termination" | "terminate-leg" | "update-leg-state" | "confirm-dialog" | "add-cdr-event" | "deactivate-rule" | "set-call-ext" | "set-leg-ext" }>`.
   Hidden (internal): `send-raw`, `send-prack-to-leg`, `cache-sdp-on-leg-dialog`,
   `set-policy-update-body`, `add-tag-mapping`, `stamp-dialog-to-tag`, `send-reinvite`,
   `send-notify`, `refer-async-http`. Using `Extract` keeps it structurally in sync.
2. **New subpath module** — `src/rules-sdk/index.ts` (new top-level dir → builds to
   `dist/rules-sdk/index.js`, mirroring `src/test-harness/`). It exports:
   - **Typed wrappers** `defineRule` / `defineService` whose handler action arrays are
     `ReadonlyArray<PublicRuleAction>` and whose `ctx` is a **narrowed** `PublicRuleContext`
     (= `Omit<RuleContext<…>, "callControl" | "limiter">`, per ADR-0015). Runtime is identical
     — each wrapper forwards to the core function with a single internal cast; the narrowed
     public types are the only thing integrators can name, so an internal action literal fails
     to typecheck. Mirror types: `PublicRuleHandleResult`, `PublicService`, `PublicServiceHandleResult`.
   - **Re-exports** (unchanged runtime): `definePolicyModule`, `createRuleRegistry`,
     `defaultRules`, `relayFirst18xTo180`, `promote18xPemTo200`, `referTransfer`,
     `buildHandlers`, action factories (`H`, `removeH`, `replaceH`, `custom`, `headerName`,
     `toBareUri`, `toNameAddr`, `tagsOf`), `getHeader`, `newTag`, and types `Match`/its
     variants, `MessageTransform`, `LegDestination`, `LegKind`, `AnyRuleDefinition`,
     `PublicRuleAction` (exported **as** `RuleAction`), `PublicRuleContext` (as `RuleContext`),
     `PolicyModule`, `Service`.
3. **Wire packaging**: add `"./rules-sdk"` to `package.json` `exports`; add the
   `@vcharbon/sipjs/rules-sdk` path to `tsconfig.consumer-api.json`.
4. **Contract test** — `tests/consumer-api/rules-sdk-surface.ts`: author a trivial rule +
   service importing **only** `@vcharbon/sipjs/rules-sdk`; include a `// @ts-expect-error`
   line emitting `{ type: "send-raw", … }` to prove internals are rejected. This file is
   compiled by `tsconfig.consumer-api.json` (already in `typecheck`).

### A.2 — finish `feature-activation-closed`

Mechanism already lands in core (`applyRoute` writes `routing.serviceExt` → `Call.ext`;
service active by ext-presence). It becomes *reachable* the moment A.1 exports
`defineService`/`service.activate`. Deliverable here: (a) confirm the path end-to-end with
a fake-stack test that activates a SDK-authored service via the decision response's
`serviceExt` and observes its rule fire; (b) add an optional
`policyModules?: ReadonlyArray<PolicyModule>` convenience field to `B2buaEmbeddedOptions`
documented as "compose your registry via `createRuleRegistry`/`buildHandlers` and pass to
`router.start`" (the embedded layer wires deps, not handlers — keep the seam honest).

### A.3 — `test-harness-no-registry-seam`

Thread an optional `policyModules?: ReadonlyArray<PolicyModule>` through
`createSimulatedRunner` → `createSimulatedTransport` (`tests/fullcall/framework/simulated-backend.ts:162`)
→ `buildTestHandlers` (`:81`, b2bonly path `:385`). `buildTestHandlers(policyModules?)`:
when provided, build `createRuleRegistry(defaultRules, [relayFirst18xTo180,
promote18xPemTo200, referTransfer, ...policyModules])`; else keep the production
`ruleRegistry`. Then apply the existing kill/wrap transforms. **Watch-out (verified):**
`transformRegistry`/`disableRule` spread `...rule`, so `layer` is preserved for consumer
modules — re-confirm with an assertion in the new harness test.

### A.4 — `tests-not-strict-typechecked`

Add `tsconfig.tests.json` (extends `tsconfig.json`; `include: ["tests/**", "src/**"]`;
keep strict flags). Append `&& tsc --noEmit -p tsconfig.tests.json` to the `typecheck`
script. Fix the surfaced errors (the ~7 cited anchors plus whatever current run reports —
line numbers have shifted; drive off the live `tsc` output). Likely
`exactOptionalPropertyTypes` spreads and missing-undefined guards.

### A.5 — `stale-dist` + `effect-should-be-peer-dependency`

- Move `effect` + `@effect/*` from `dependencies` to **`peerDependencies`** (keep them in
  `devDependencies` for local dev/CI so the repo still builds). Add a one-line README note
  on `resolve.dedupe`.
- Add `"prepublishOnly": "npm run build"` so a publish can't ship stale `dist/`.

---

## Subsection B — leg-type correctness (ADR-0014, move Proposed → implemented)

### B.1 — `leg-kind-missing`: `Leg.kind` + `adopted`

1. **Schema** (`src/call/CallModel.ts`): add
   `export const LegKind = Schema.Literals(["a","destination","media","transfer-target"])`;
   on `Leg` add `kind: Schema.optional(LegKind)` and `adopted: Schema.optional(Schema.Boolean)`
   (optional → backward-compatible with in-flight bodies). Add helpers:
   `legKind(leg) = leg.kind ?? (leg.legId === "a" ? "a" : "destination")` and
   `isAdopted(leg) = leg.adopted ?? (legKind(leg) === "media" || legKind(leg) === "transfer-target" ? false : true)`.
2. **Codec** (ADR-0011 base codec — both impls):
   - `src/call/codec/call.proto`: add `optional string kind = 15; optional bool adopted = 16;`
     to `message Leg`; regenerate `call.proto.gen.cjs` via the documented pinned command
     (`npx -p protobufjs-cli@1.1.3 pbjs --target static-module --keep-case --wrap commonjs
     --out src/call/codec/call.proto.gen.cjs src/call/codec/call.proto`).
   - `src/call/codec/protobuf.ts`: `encodeLeg`/`decodeLeg` carry `kind`/`adopted`
     (omit-when-undefined, same pattern as `byeDisposition`).
   - `src/call/codec/msgpack.ts`: append `"kind","adopted"` to the Leg field-order array
     (`:38`) — append at the end to preserve records-mode positional compatibility.
3. **Construction sites** stamp kind/adopted:
   - a-leg (`src/b2bua/InitialInviteHandler.ts:118/149`) → `kind: "a", adopted: true`.
   - b-leg (`src/b2bua/helpers.ts` `createBLegFromRoute` ~`:387`) → `kind: "destination", adopted: true`.
   - `create-leg` action: add optional `kind?: LegKind` + `adopted?: boolean` to the
     `create-leg` variant in `RuleDefinition.ts` (and to `PublicRuleAction`); `executeCreateLeg`
     (`ActionExecutor.ts:1550`) defaults to `kind: "destination", adopted: true`, lets a rule
     pass `kind: "media", adopted: false`. This is how PRBT parks the MRF leg.
4. **legExt runtime consumer**: add a fake test exercising `set-leg-ext` + a rule reading
   `leg.ext` (the capability is intact but untested in-tree post-REFER-migration).

### B.2 — `unadopted-leg-gate-missing` (the single core enabler)

- **relay-to-peer implicit-"a" fallback** (`ActionExecutor.ts:553-556`): gate on the source
  leg being adopted — `if (peerLegId === undefined && ctx.sourceLeg.legId !== "a" && isAdopted(ctx.sourceLeg)) peerLegId = "a"`. An unadopted (media/transfer) leg never mis-routes to A.
- **keepalive** (`src/b2bua/rules/defaults/TimerRules.ts` `keepaliveRule`): `allPeeredLegs`
  already excludes unpeered media legs; add an explicit `isAdopted` filter so the predicate
  is shared and defensive ("one predicate, two rule families").
- **generic failure/failover** (`src/b2bua/rules/defaults/FailureRules.ts` route-failure +
  no-answer-failover): decline (return `undefined`) when the source leg is unadopted, so an
  MRF leg's 4xx/5xx is owned by the service's rules and **failover never retries onto an MRF**
  (ADR-0014 consequence). Encode as a `filter` on the rules' `match`.
- Tests: media leg present → relay-to-peer from it does not reach A; keepalive emits no
  OPTIONS to it; its failure does not trigger generic failover.

### B.3 — `no-provisional-from-unadopted-leg`: `send-provisional-to-leg` action

Add a dedicated action (chosen over documenting `relay-to-leg`'s cross-dialog semantics):
`{ type: "send-provisional-to-leg"; legId: string; status: number; body?: Uint8Array; contentType?: string; reliable: false }`.
Added to `RuleAction` **and** `PublicRuleAction`. Executor builds the provisional onto the
target leg's stored INVITE server transaction (the A-leg's original INVITE), modelled on the
existing `respond`/relay-response builders and how `relayFirst18xTo180`/PEM synthesise a 1xx
to A.

**RFC rules to honour (per CLAUDE.md planning discipline):**
- **RFC 3261 §13.2 / §17.2.1**: the provisional is a response on A's *existing* INVITE UAS
  transaction — reuse A's `aLegInvite` Via stack + INVITE CSeq; To-tag = A's B2BUA-owned
  early tag (from the a-leg dialog / `tagMap`), From/Call-ID from A's INVITE. Stamp the
  a-leg `Contact`.
- **RFC 3262**: `reliable: false` ⇒ **no** `Require: 100rel`, **no** `RSeq` — an unreliable
  1xx (not PRACK-tracked, sent once). This is what lets PRBT re-point A on B's final 200
  without a re-INVITE.
- **RFC 3264**: the SDP body (the MRF's answer, read off the media-leg 200 by the rule) is an
  informational answer to A's offer; the authoritative answer remains B's 2xx. `contentType`
  defaults to `application/sdp` when `body` is set.
- Only valid for `status` in 101–199; the executor ignores/clamps otherwise and logs.

These three B items move **ADR-0014** from *Proposed* to *implemented* — update its Status
and `docs/AdvancedCallModel.md` / `CONTEXT.md` (`media leg`, `adopted`) accordingly.

---

## Docs to update

- ADR-0014 Status → implemented (+ note the `adopted` default-derivation).
- ADR-0015/0016: drop "Proposed" where now realised; reference the `rules-sdk` entrypoint as
  the enforced boundary.
- `docs/AdvancedCallModel.md`: `send-provisional-to-leg`, `create-leg { kind, adopted }`,
  the unadopted-leg gate, the public-action subset.
- `docs/rule-extension-guide.md`: the `@vcharbon/sipjs/rules-sdk` import surface + activation
  via `service.activate` in the decision response's `serviceExt`.

## Verification

1. `npm run typecheck` — zero errors **and** zero Effect-plugin warnings (incl. the new
   `tsconfig.tests.json` + `tsconfig.consumer-api.json` gates).
2. `npm run test:fake` — must stay green (MUST ALWAYS BE RUN per CLAUDE.md). New fake tests:
   service activation via `serviceExt`; harness `policyModules` seam (+ `layer` preserved);
   leg-kind/adopted round-trips the codec; unadopted-leg gate (no relay/keepalive/failover to
   media); `send-provisional-to-leg` emits an unreliable 183 to A with the right tag/CSeq/Via.
3. Codec regen sanity: encode→decode a `Call` carrying a `media` leg and assert
   `kind`/`adopted` survive (both protobuf and msgpack/records mode).
4. Dogfood proof (optional, if `~/prbt` is switched over): repoint `~/prbt` imports to
   `@vcharbon/sipjs/rules-sdk`, run its `prbt-callflow` as a wire-level e2e via the new
   `createSimulatedRunner({ policyModules: [prbtPolicy] })` seam.
5. `/code-review high` on the final diff (per handoff).

## Risk notes

- `ActionExecutor` / `CallState` / `RuleExecutor` edits are governed by **ADR-0003** (must-run
  under interruption). The new action is a sync, non-blocking message build (outbound slot) —
  no blocking IO in any uninterruptible position; keep it that way.
- Codec change is the highest-risk mechanical step: regenerate the pinned pbjs static module
  and round-trip-test before relying on it.
- Keep the public/internal action split honest (ADR-0015 watch-out): widen `PublicRuleAction`
  only as the dogfood demands.
