# Plan: addressing 8 upstream complaints from external sipstack consumer

## Context

A downstream consumer (sipstack) integrating `@vcharbon/sipjs` reported 8 issues with the public surface and one observable behavioral bug. The user wants to be grilled on each, because while most complaints are valid, the consumer's *suggested fixes* may not be the right ones.

This plan is being built incrementally through a Q&A grilling session. Each issue will get its own section once a decision is reached.

## Pre-grill code-state findings (verified, May 2026)

### Issue 1+2 — WorkerReadiness export & embedded layer composition
- `src/cache/WorkerReadiness.ts` exposes `WorkerReadiness.Default` (production, initialReady=false) and `WorkerReadiness.test(initialReady=false)` (test).
- `src/b2bua/index.ts` does NOT re-export `WorkerReadiness` (DrainingState IS re-exported, line 90).
- `src/b2bua/embedded.ts:161` provides `DrainingState.test` but does NOT provide WorkerReadiness, so the requirement leaks into R.
- `B2buaCoreLayer` composes `SipRouter`, which depends on `WorkerReadiness` — confirming the leak.
- Note: embedded provides `DrainingState.test` (test-flavored layer) — pattern is already mixed.

### Issue 3 — test-harness build exclude
- `tsconfig.json:21` excludes `src/test-harness/**/*`.
- `package.json` exports `./test-harness` → `./dist/test-harness/index.{d.ts,js}` (which the exclude prevents emitting). Genuinely broken.

### Issue 4 — return type leakage
- No explicit `B2buaLayer` alias; return type inferred. WorkerReadiness, CallState, TimerService, Parser, TransactionLayer all appear in inferred Out.

### Issue 5 — response types as Schema.Struct
- `src/decision/schemas/responses.ts` uses `Schema.Struct(...)` with `typeof X.Type` extraction.
- Re-exported via `export type` only in `src/b2bua/index.ts:71-79` (no Schema runtime values).

### Issue 6 — From URI override not persisted (REAL BUG)
- `src/b2bua/helpers.ts:158-163` extracts `localUri` from the **original** A-leg From.
- `update_headers["From"]` is applied to the outbound INVITE at lines 237–261 BUT `leg.localUri` is already stamped before that (line 309 references the pre-override `localUri`).
- `src/sip/generators.ts:309` (BYE) and `:392` (ACK for 2xx) read `dialog.localUri`, so they revert to original From.
- Validator at `src/test-harness/framework/validation.ts:453-473` checks remote (received) From, not B2BUA-emitted From.
- Genuine RFC 3261 §12.2.1.1 violation when a route decision overrides From.

### Issue 7 — Layer.suspend
- `src/sip-front-proxy/ProxyCore.ts:157` still uses `Layer.suspend(...)` in this repo. Either the consumer is on a different Effect version, or local repo is ahead.

### Issue 9 — No way to set headers (incl. `Reason`) on reject (added mid-grill)
- `NewCallRejectResponse` schema (`src/decision/schemas/responses.ts:44-48`) carries only `reject_code` + `reject_reason`.
- `reject_reason` is wired into the **status-line reason phrase**, not the RFC 3326 `Reason:` header.
- `InitialInviteHandler.ts:102-121` calls `generateResponse(req, code, reason, { toTag, contact })` — never passes `extraHeaders`.
- BUT: `generateResponse` (`src/sip/generators.ts:468-517`) already accepts `extraHeaders: ReadonlyArray<SipHeader>`, plus `body`/`contentType`. Plumbing exists; the schema and applicator don't expose it.
- Same gap in `CallReferRejectResponse` (`responses.ts:109-113`).
- Forbidden-headers validator only runs on response shapes that carry `update_headers` (route, failover, refer-allow), so reject has no path to *check* anything either.
- Existing reject test (`tests/scenarios/call-reject.ts`) asserts only status+reason phrase. No coverage for custom headers on rejections.

### Issue 8 — `$(ip.AS)`/`$(port.AS)` variables
- No `VariableReplacer` module exists in sipjsserver. The "VariableReplacer" referenced is the *consumer's* code.
- Contact synthesis happens in `src/b2bua/stack-identity.ts` via `buildCallContact()`; Contact in `update_headers` is forbidden (`src/decision/validators/forbiddenHeaders.ts`).
- Variables like `$(ip.AS)` do not appear anywhere in sipjsserver code or docs.

---

## Decisions (filled in as grilling progresses)

### Issue 9 — Headers on reject (settled, except 3xx scope)

**Decision:** Add `update_headers: SipHeaderUpdates` (optional) to `NewCallRejectResponse` only. Do NOT add `body`/`content_type` (yet). Do NOT widen `CallReferRejectResponse` — REFER is always 200-OK'd at the SIP layer; transfer-failure semantics travel via NOTIFY sipfrag, not 4xx-on-REFER. Different layer, different fix.

**Core design decision (REFER) — must be documented in the codebase, not just this plan:**
sipjsserver always answers REFER with 200 OK (or relays transparently when the B2BUA is in a relay role). The decision engine cannot reject a REFER request at the SIP message level. If the call-control HTTP service wants to refuse the transfer, it instructs the B2BUA to emit a NOTIFY with a `message/sipfrag` body carrying the failure status line (RFC 3515 §2.4.5 / RFC 3420). Rationale: REFER establishes an implicit subscription; the operation outcome travels on that subscription, not as a 4xx on the REFER itself. Many UACs misinterpret 4xx-on-REFER as "transferor unwilling" rather than "transferee unreachable", which conflates two different failure modes. Routing this exclusively through NOTIFY sipfrag preserves the distinction and matches the RFC.

This decision is the reason `CallReferRejectResponse` is *not* a 4xx-emitter and is not widened in this plan. The doc home is pending Q3.2-bis (see open questions).

**Semantic:** On reject there is no called-side response to merge with. `update_headers` on reject means "include these headers on the rejection response we emit" (purely additive). The shared `SipHeaderUpdates` shape (`Record<string, string | null>`) still allows `null`-valued entries; on reject those are no-ops (nothing to delete).

**Forbidden-headers on reject (final):**
- `Via`, `To`, `From`, `Call-ID`, `CSeq` — forbidden (RFC-mandated copies from the request, same as route; consistency with route was explicitly called out).
- `Contact` — **allowed unconditionally** on reject. No reject_code gating, no 3xx-family matching. The B2BUA does not police whether Contact is RFC-meaningful for the chosen status code; that's the consumer's responsibility. The only hard floor is that 302 (and other redirects) must work fully when the consumer supplies Contact.
- All other headers (`Reason`, `Retry-After`, `Warning`, `P-Asserted-Identity`, `X-…`, etc.) — allowed.

**Generic-header pass-through:**
- `Reason:` (RFC 3326), `Retry-After:`, `Warning:`, `P-Asserted-Identity:`, custom `X-…` — all flow through `update_headers` without typed sugar.

**Wiring:**
- `src/decision/schemas/responses.ts` — extend `NewCallRejectResponse` schema with `update_headers`.
- `src/b2bua/InitialInviteHandler.ts:102-121` — pass an `extraHeaders: SipHeader[]` array (built from `update_headers`) into `generateResponse(...)`.
- `src/decision/validators/forbiddenHeaders.ts` — extend the validator to run on the reject path; encode the Contact-allowed-for-3xx rule there.

**Verification (fake-clock tests):**
- `tests/decision/reject-with-reason-header.test.ts` — emitted 4xx carries consumer-supplied `Reason: SIP ;cause=403;text="…"`.
- `tests/decision/reject-302-with-contact.test.ts` — 302 redirect carries the consumer-supplied Contact, end-to-end (UAC follows redirect against the right URI).
- `tests/decision/reject-contact-on-4xx-passes-through.test.ts` — Contact on a 403 is emitted as-is (no validator rejection — confirms the "no family gating" decision).
- `tests/decision/reject-forbidden-via-rejected.test.ts` — `update_headers["Via"]` IS rejected by validation.
- `tests/decision/reject-forbidden-from-rejected.test.ts` — `update_headers["From"]` IS rejected (consistency with route).

**Documentation deliverable:**
- Add `docs/external-usage/refer-and-sipfrag.md` capturing the always-200-OK + NOTIFY-sipfrag rule and the rationale. (External-facing design decision; per the broader plan rule, all consumer-facing docs live under `docs/external-usage/`.)
- Cross-link from `docs/CallModel.md` to the external-usage page.

### Issue 6 — From/To URI override not preserved on in-dialog B-leg requests (RFC 3261 §12.2.1.1)

**Scope:** the bug applies symmetrically to From AND To on the B-leg INVITE. Today both `leg.localUri` (from A-leg From) and `leg.remoteUri` (from A-leg To) are stamped *before* `update_headers` is applied; subsequent ACK/BYE silently revert to the original values.

**Decision summary:**

| Sub-decision | Choice |
|--------------|--------|
| 6.1 — what may consumer override on From / To | URI + display name + all header params **except tag** |
| 6.2 — persistence | Single source of truth: overwrite `leg.localUri` and `leg.remoteUri` from the post-override outbound INVITE |
| 6.3 — A-leg | Untouched. Regression test only. |
| 6.4 — PAI / Privacy / Remote-Party-ID | No auto-coordination. Consumer wires whatever they need via the generic `update_headers`. |
| 6.5 — validator | Check both From and To consistency on outbound B2BUA-emitted in-dialog requests, not just remote-received ones. |

**Tag ownership:**
- **From-tag:** B2BUA owns it (it is the dialog's local tag, RFC 3261 §12.1.1). Consumer-supplied tags in `update_headers["From"]` are stripped with a warning log; the B2BUA's generated tag is used.
- **To-tag (initial INVITE):** none exists yet — the To header on an initial request has no tag (RFC 3261 §8.1.1.2). Consumer-supplied tags in `update_headers["To"]` on the route response are stripped with a warning log.
- **To-tag (in-dialog ACK/BYE):** carried from the 200 OK's To-tag → `leg.remoteTag`. Override does NOT touch this tag — only the URI/display/non-tag params.

**Wiring:**
- `src/b2bua/helpers.ts` — restructure `createBLegFromRoute`:
  1. Build the B-leg INVITE.
  2. Apply policy + route `update_headers` (existing path).
  3. **NEW:** read the resulting From and To headers from the constructed message; extract URI + display name.
  4. **NEW:** stamp `leg.localUri` from the post-override From URI and `leg.remoteUri` from the post-override To URI.
  5. Continue as today.
- `src/sip/generators.ts:309, 392` — no change. They already read `dialog.localUri` / `dialog.remoteUri`; with (4) stamped correctly, ACK and BYE will carry the overridden URIs naturally.
- Add tag-stripping logic in the update_headers application: when `update_headers["From"]` contains a `tag=` param, log a warning and drop just that param. Same for `update_headers["To"]`.
- `src/test-harness/framework/validation.ts` — extend `validateDialogUri` (or add a new validator) so that for every outbound B2BUA-emitted in-dialog request:
  - From URI must equal the dialog's `localUri`
  - To URI must equal the dialog's `remoteUri`
  Run this against both A-leg and B-leg outbound traffic.

**Verification (fake-clock tests, all in `tests/sip-front-proxy/from-to-override/`):**
- `b-leg-ack-uses-overridden-from.test.ts` — INVITE with `update_headers["From"]`; assert ACK From URI = overridden URI.
- `b-leg-bye-uses-overridden-from.test.ts` — same, then BYE.
- `b-leg-ack-uses-overridden-to.test.ts` — INVITE with `update_headers["To"]`; assert ACK To URI = overridden URI (To-tag from 200 OK preserved).
- `b-leg-bye-uses-overridden-to.test.ts` — same, then BYE.
- `b-leg-both-overridden.test.ts` — both From and To overridden; assert all in-dialog requests carry both correctly.
- `b-leg-from-tag-stable.test.ts` — From tag identical on B-leg INVITE/ACK/BYE; consumer-supplied From-tag in override is stripped.
- `b-leg-to-tag-from-200-preserved.test.ts` — To-tag on B-leg ACK/BYE matches the To-tag from the 200 OK; consumer-supplied To-tag in override on initial route is stripped.
- `b-leg-no-override-preserves-aleg-from-and-to.test.ts` — no override → regression-free.
- `a-leg-from-and-to-untouched-by-b-leg-override.test.ts` — A-leg traffic unaffected by B-leg overrides.
- `harness-validator-flags-outbound-from-mismatch.test.ts` — direct validator-unit test that an outbound request with mismatched From URI is flagged.

### Issue 3 — test-harness build exclude

**Decision:** test-harness is a public API surface (matches package.json export + `docs/test-api-external.md`). Remove the tsconfig exclude.

**Wiring:**
- `tsconfig.json` — remove the `"src/test-harness/**/*"` entry from `exclude`. Add `"ES2023.Array"` (or `"ES2023"`) to `lib`.
- `src/test-harness/message-builder.ts` — delete the unused `StepRef` import, delete the unused `agentName` param.
- `src/test-harness/recorder.ts` — delete the unused `resetStepRefIds` import.
- `src/test-harness/svg-sequence-diagram.ts` — delete the unused `PAUSE_GAP` const.
- `src/test-harness/validation.ts` — keep `Array.findLast` (now valid under ES2023 lib).

**Verification:**
- `npm run typecheck` clean.
- `tests/external-surface/test-harness-import.test.ts` — imports `executeScenario`, `scenario`, `createRegistrarTestProxyRunner` from `@vcharbon/sipjs/test-harness` against the built `dist/` and asserts the bindings resolve.
- `npm pack` smoke check that `dist/test-harness/` is in the tarball.

### Issue 5 — response types ergonomics

**Decision:** Reject the consumer's "export interface alongside Schema" suggestion. Reject the preemptive `Simplify<>`/`Pretty<>` wrappers. Take the cheapest action that addresses the most likely root cause (consumer didn't realize the type was directly importable):

- Add a JSDoc `@example` block on each of `NewCallRouteResponse`, `NewCallRejectResponse`, `CallFailureFailoverResponse`, `CallFailureTerminateResponse`, `NewCallResponse` (and equivalents on the REFER side) showing the canonical import + literal-construction pattern.
- If the consumer comes back with a concrete TS compile error (not "ugly tooltips"), trace it to the offending Schema combinator (`Schema.optional` exact-vs-widened, `NullOr` vs `UndefinedOr`, etc.) and fix at that layer. Do NOT introduce parallel interfaces; do NOT introduce Simplify wrappers as a blanket solution.

**Files touched:** `src/decision/schemas/responses.ts` (JSDoc only).

**Verification:** none beyond `npm run typecheck` clean. Optionally a `tests/types/response-types-importable.test-d.ts` consumer-shape sanity check that constructs each response as a plain object literal.

### Issue 4 — return-type leakage / `B2buaLayer` alias

**Decision:** Per-tag exposure follows the table; ship a public `B2buaLayer` alias for ergonomics.

| Tag | Exposure |
|-----|----------|
| `WorkerReadiness` | runtime re-export (also covers Q1) |
| `DrainingState` | runtime re-export (already there) |
| `CallState` | type-only re-export (`export type`) |
| `TimerService` | type-only re-export |
| `SipParser` | type-only re-export |
| `TransactionLayer` | type-only re-export |

**Wiring:**
- `src/b2bua/index.ts` — add `export { WorkerReadiness } from "../cache/WorkerReadiness.js"`. Add `export type { CallState } from "../call/CallState.js"`, `export type { TimerService } from "...TimerService.js"`, `export type { SipParser } from "...Parser.js"`, `export type { TransactionLayer } from "...TransactionLayer.js"` (verify exact import paths).
- `src/b2bua/embedded.ts` — declare an explicit return type:
  ```ts
  export type B2buaLayer = Layer.Layer<
    SipRouter | TransactionLayer | CallState | TimerService | SipParser
      | WorkerReadiness | DrainingState | /* …rest of B2buaCoreLayer Out… */,
    never,
    /* deps R: probably never if all internal deps are satisfied */
  >
  export const b2buaEmbeddedLayer = (opts: B2buaEmbeddedOptions): B2buaLayer => …
  ```
- Re-export `B2buaLayer` from `src/b2bua/index.ts`.

**Verification:**
- A type-level test (`tests/types/b2bua-layer-namable.test-d.ts`, vitest's `expectTypeOf` or tsd) that does `const layer: B2buaLayer = b2buaEmbeddedLayer(opts)` and verifies no `Layer.Layer<unknown, …>` collapse.
- `npm run typecheck` is clean (no TS2742).
- A consumer fixture in `tests/external-surface/exports.test.ts` that imports `B2buaLayer`, `WorkerReadiness`, type-only `CallState`, etc. and verifies they resolve.

### Issue 7 — `Layer.suspend` apparent absence

**Diagnosis:** the consumer is wrong on the API existence. `Layer.suspend` IS present in `effect@4.0.0-beta.42` (verified via `typeof L.suspend === "function"` in the installed package). Both repos pin the same `^4.0.0-beta.42`. The consumer most likely had a stale lockfile, an `effect-smol` import slip-up, or confused a different missing API.

**That said, the call site is redundant and worth simplifying:**
- `src/sip-front-proxy/ProxyCore.ts:157` does `Layer.suspend(() => Layer.effect(...))`. `Layer.effect` is already lazy in Effect v4; the `suspend` wrapper buys nothing absent a top-level eval-order constraint, which we don't have here.
- **Action:** drop `Layer.suspend` outright. If the build stays green, it was redundant. If something breaks (cyclic top-level eval), revert to `Layer.suspend` (no API change needed) and document the constraint inline.

**Wiring:**
- `src/sip-front-proxy/ProxyCore.ts:157-174` — replace `Layer.suspend(() => Layer.effect(...))` with `Layer.effect(...)` directly.
- `package.json` — pin `effect` exactly to the version we test against (drop the `^` to lock). Currently `^4.0.0-beta.42`; pin to whatever `node_modules/effect/package.json` resolves to today.
- `README.md` — add a "Compatibility" section listing the minimum Effect version + Node version + how consumers should pin.

**Verification:**
- `npm run typecheck` + full test suite green after dropping `Layer.suspend`.
- Repro the consumer's symptom in a clean scratch dir: `npm i effect@<our-pin>` and `import { Layer } from "effect"; console.log(typeof Layer.suspend)`. Document the result in the README compatibility section so future consumers can run the same check.

### Future-work plan (separate effort) — Migrate to pnpm + declare Effect as peer dep

> **Note:** plan-mode permits one plan file. This block is written self-contained so it can be lifted to `docs/plan/pnpm-effect-peer-dep.md` after plan-mode exits. It is **not** part of the current "address the 9 complaints" plan; it's the orthogonal effort the issue-7 grilling surfaced.

**Context.** A consumer reported "`Layer.suspend` doesn't exist in `effect@4.0.0-beta.42`" while both repos pin the same range. The actual cause is almost certainly node_modules drift — npm's flat hoisting can let a transitive resolve a different Effect than the consumer's direct dep, and either side can end up importing a phantom variant (e.g. `effect-smol`). The structural fix is to make Effect a `peerDependency` (one Effect per consumer app, by construction) and adopt pnpm so peer enforcement and phantom-dep detection are loud rather than silent.

**Why bundle pnpm with the peer-dep change.** Declaring peers under npm 7+ silently auto-installs them, which still leaves the door open for two Effects in one app. pnpm refuses to do that — the failure surfaces at install time. The two changes only fully de-risk this complaint class together.

**Scope.**

1. **Move Effect-family packages to `peerDependencies`.**
   - From `dependencies` → `peerDependencies`: `effect`, `@effect/opentelemetry`, `@effect/platform-node`. Pin to a tested *range* (e.g. `^4.0.0-beta.42`), not exact.
   - Mirror them in `devDependencies` (so we still install them locally for tests/dev).
   - Audit `@effect/vitest` version drift: deps say `^4.0.0-beta.42`, devDeps say `^4.0.0-beta.43` — pick one.
   - Decide on `@opentelemetry/*` packages: peer-dep (consumer brings their own SDK) or keep as deps. Recommend **peer** for `@opentelemetry/api` (the public symbol surface — must be deduped) and keep the SDK packages as deps.
   - Decide on `ioredis`: leave as dep for now (only used by our internal cache layer; consumers don't import it).

2. **Adopt pnpm.**
   - Add `packageManager: "pnpm@<version>"` to `package.json`.
   - Generate `pnpm-lock.yaml`, delete `package-lock.json`.
   - Update `.gitignore` if needed.
   - Update CI (`.github/workflows/*` or wherever) to use `pnpm install --frozen-lockfile`.
   - Update contributor docs: install pnpm, run `pnpm i`, run `pnpm typecheck`, etc.
   - Update all `npm run …` references in `package.json` `scripts`, README, and the auto-loaded CLAUDE.md.

3. **Add `engines` block** (`node`, `pnpm`) so consumers using Volta/asdf get the right toolchain.

4. **Document the compatibility contract** in README:
   - Minimum Node version, required Effect range (peer), one-paragraph rationale for pnpm, npm-to-pnpm migration snippet for consumers.

**Risks.**

- CI churn — every workflow that hard-codes `npm` needs updating; easy to miss one.
- Consumer install friction — they have to add Effect themselves now; needs a copy-paste-able upgrade snippet.
- Workspace tooling — anything that walks flat `node_modules/` may trip on pnpm symlinks. Verify with a clean `pnpm i && pnpm build && pnpm test`.
- `@effect/language-service` plugin (currently `latest`) — verify it still works under pnpm with a peer-dep'd `effect`.
- OpenTelemetry symbol dedup — without peer-dep'ing `@opentelemetry/api`, two SDK instances can silently drop trace context. Easy to miss until production.

**Verification.**

- `pnpm i && pnpm typecheck && pnpm test` clean locally.
- A consumer-fixture project under `tests/external-consumer-fixture/` (separate package directory, peer-installs us + Effect) builds and imports cleanly.
- Same fixture deliberately mismatches Effect version → pnpm install fails loudly. Confirms the guardrail works.
- CI: end-to-end run on a fresh runner from scratch.
- README "Compatibility" snippet copy-paste-runnable in a clean Node shell.

**Out of scope.**

- Switching to `effect-smol` (different package, different decision).
- Bumping the Effect version range itself.
- Adding workspace/monorepo structure.

### Issues 1+2 — `WorkerReadiness` ownership

**Decision:** Option (c). `b2buaEmbeddedLayer` is a **test/dev convenience layer** (fake clock, fake network, etc.), so providing `.test` variants inside it is correct.

- Re-export `WorkerReadiness` (service tag + `.Default` + `.test`) from `src/b2bua/index.ts` so consumers can both *satisfy* the requirement (production via `B2buaCoreLayer`) and *override* the embedded default (e.g., to start with `ready=false` in a test that exercises the not-ready path).
- Add `Layer.provide(WorkerReadiness.test(true))` to `b2buaEmbeddedLayer`, mirroring the existing `DrainingState.test` line.
- Consumers wrapping the embedded layer with additional requirements use standard `Layer.provide`/`Layer.merge` against the re-exported tag.

**Files touched:**
- `src/b2bua/index.ts` — add `export { WorkerReadiness } from "../cache/WorkerReadiness.js"`.
- `src/b2bua/embedded.ts` — append `Layer.provide(WorkerReadiness.test(true))` to the chain at line 161.

**Verification:**
- Type-check a minimal consumer fixture that does `Effect.provide(b2buaEmbeddedLayer(opts))` — `WorkerReadiness` must NOT appear in the residual R channel.
- Add a fake-clock test under `tests/b2bua/embedded-layer-readiness.test.ts` that asserts `WorkerReadiness.currentReady` returns `true` immediately after the embedded layer is provided.

### Issue 8 — `$(ip.AS)`/`$(port.AS)` variables

**Decision:** Reject the implicit ask that sipjsserver own a templating runtime. *Do* offer consumers an authoritative read-API for the values their own templating layer needs.

**What sipjsserver does NOT do (and never will):**
- No `$(...)` variable substitution anywhere. All values reaching `CallDecisionEngine.newCall(...)` (and any other engine method) must be fully resolved literals at the contract boundary. Partially-substituted strings would corrupt SIP and we won't try to salvage them.
- No override of `Contact` via `update_headers`. Contact is owned by `buildCallContact()` in `src/b2bua/stack-identity.ts` and remains in the forbidden-headers list (`src/decision/validators/forbiddenHeaders.ts`).

**What sipjsserver WILL offer (the read-side seam):**
- A small read-only API (effect-shaped) on `StackIdentity` returning the values consumers most plausibly need to template against:
  - `advertisedHost` / `advertisedPort` — the AS-side coordinates the B2BUA stamps on outbound Contact / Via.
  - `sourceHost` / `sourcePort` — the SRC-side coordinates of the call's incoming peer (when known and a call context is provided; absent for static lookups).
- Exposed via the existing `StackIdentity` service tag, re-exported from `src/b2bua/index.ts`. Consumers read once at startup (for AS) and per-call (for SRC) to populate their own `VariableReplacer`.

**Documentation (consumer-facing — lives under `docs/external-usage/`):**
- New page `docs/external-usage/decision-engine-contract.md` covering:
  - The boundary contract: literals only, no templating.
  - Contact ownership and why `update_headers["Contact"]` is rejected.
  - The recommended pattern for consumers running their own templating: read `StackIdentity` at startup, substitute their `$(ip.AS)`/`$(port.AS)`-style placeholders client-side, hand fully-resolved literals to `CallDecisionEngine`.
- Add JSDoc `@see` cross-links from response-schema fields (`update_headers`, `update_ruri`) to the contract page.

**Wiring:**
- `src/b2bua/stack-identity.ts` — expose `advertisedHost`, `advertisedPort` (and `sourceHost`/`sourcePort` if not already) on the `StackIdentity` service API. Verify exact shape against the existing service before naming.
- `src/b2bua/index.ts` — re-export `StackIdentity` (runtime + type) so consumers can `Effect.flatMap(StackIdentity, …)`.
- `docs/external-usage/decision-engine-contract.md` — new page, ~80–120 lines.
- `docs/external-usage/README.md` — add a link entry for the new contract page.

**Verification:**
- Unit test `tests/b2bua/stack-identity-public-api.test.ts` reads `advertisedHost`/`advertisedPort` after a default config and asserts they match the configured stack-advertise values.
- Type-test `tests/external-surface/stack-identity-import.test.ts` confirms `StackIdentity` is importable from `@vcharbon/sipjs/b2bua` with both runtime and type semantics.
- Doc-link checker (or manual review) confirms `decision-engine-contract.md` is reachable from the external-usage README.

---

## Cross-cutting documentation rule (applies to all issues with consumer-facing implications)

All new external-facing documentation produced by this plan lives under `docs/external-usage/`. This includes design-decision documents that affect consumer behavior, not just usage guides. Specifically:

- **Issue 9 (REFER):** `docs/external-usage/refer-and-sipfrag.md`.
- **Issue 8 (engine contract):** `docs/external-usage/decision-engine-contract.md`.
- **Issue 7 (compatibility):** README "Compatibility" section is the canonical home; cross-link from `docs/external-usage/README.md`.
- **Issue 5 (response-type ergonomics):** JSDoc examples are inline in `src/decision/schemas/responses.ts`; if they grow past examples into prose, promote to `docs/external-usage/decision-response-shapes.md`.
- **Issue 3 (test-harness public surface):** existing `docs/external-usage/test-harness.md` covers it; verify it's accurate after the exclude is dropped.

Internal/architectural docs (`docs/CallModel.md`, `docs/AdvancedCallModel.md`, `docs/typescript-effect.md`, etc.) stay where they are; cross-link from internal docs *to* the external pages where overlap exists, not the other way around.

---

## Execution ordering (suggested PR boundaries)

These are independent enough to ship as separate PRs, ordered to keep each PR small and review-friendly:

1. **PR 1 — Issue 3 (test-harness build).** Self-contained: tsconfig + lint cleanup. Unblocks any consumer who needs the harness. ~1 day.
2. **PR 2 — Issues 1+2+4 (export hygiene + B2buaLayer alias).** All touch `src/b2bua/index.ts` and `embedded.ts`. Bundle. ~1 day.
3. **PR 3 — Issue 7 (Layer.suspend cleanup + Effect pin + README compat).** Minimal code change + README. ~½ day.
4. **PR 4 — Issue 9 (headers on reject + REFER docs).** New schema field + applicator wire-up + validator extension + new external-usage doc. ~1–2 days.
5. **PR 5 — Issue 6 (From/To override fix — the real RFC bug).** The largest single change. Helpers refactor + tag-stripping logic + harness validator extension + 9 new tests. ~2–3 days. **Must include the regression-test suite before any other work that touches `helpers.ts`.**
6. **PR 6 — Issue 8 (StackIdentity public API + decision-engine-contract doc).** New external-usage doc + small read-API surface. ~1 day.
7. **PR 7 — Issue 5 (JSDoc examples).** Tiny. Squash into PR 4 or PR 6 if convenient. ~½ day.

**Future-work effort (separate plan):** pnpm + Effect-as-peer-dep migration — see appendix above. ~1–2 days, but should be its own PR with its own grilling pass.