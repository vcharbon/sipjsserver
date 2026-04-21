# Post-SIP-generator-refactor cleanup

Tracking follow-ups surfaced while finishing slices D.1 / D.2 of `SIP-STACK-MESSAGE-GENERATOR-REFACTOR.md` and rewriting `docs/b2bua-sip-headers.md`. Items are listed in priority order; priority reflects the time already wasted (by me, this session) or latent bug risk left behind.

---

## P0 — live architecture doc was fully stale and nothing flagged it

`docs/b2bua-sip-headers.md` is listed in `CLAUDE.md`'s progressive reading guide as the authoritative header-handling reference. At the start of this session it was ~100% describing the pre-refactor world: `__PLACEHOLDER__`, `stampHeaders()`, the two-phase `processResult` branch-capture dance, `MessageFactory.build*`, `buildBLegInvite`, and a "Known issue #1 (From/To URI separation)" that the new `generateInDialogRequest` design already fixes.

None of the six completed slices (B.1–B.4, C.1–C.6, D.1) had "update `docs/b2bua-sip-headers.md`" in their exit criteria. The tracking doc `docs/todos/SIP-STACK-MESSAGE-GENERATOR-REFACTOR.md` is meticulous about *source* cleanup (exit criterion literally was `grep __PLACEHOLDER__ src/ | wc -l == 0`) but silent about live architecture docs.

**Time waste in this session:** the user had to prompt me to check, then I had to re-derive the entire new architecture from `generators.ts` / `stack-identity.ts` / `ActionExecutor.ts` to rewrite the doc. Anybody reading `b2bua-sip-headers.md` between the completion of slice C.4 and today got actively misled.

### Fix
1. Add a generic "architecture docs to review" sub-task to every multi-slice tracking template under `docs/todos/`. List the reading-guide docs from `CLAUDE.md` and force each slice to either tick "N/A" or update.
2. Grep `src/` for doc-comment references to symbols that no longer exist. The three I hit in this session (`TransactionLayer.ts:115`, `MessageHelpers.ts:2`, `tests/fullcall/framework/message-builder.ts:10`) survived the symbol rename because no compiler or linter enforces them. A cheap mitigation: a CI step that runs `grep -rn MessageFactory src/ tests/` and fails if anything outside `docs/` is found — same pattern for `__PLACEHOLDER__`, `stampHeaders`, `buildBLegInvite`, etc.

---

## P0 — `MessageHelpers.ts` still mixes three concerns

Already flagged in `docs/TODO.md:16`, but the D.2 rename made it concrete without acting on it. The file is currently ~408 lines and holds:

- header accessors (`getHeader`, `getHeaders`, `setHeader`, `removeHeader`)
- structured-header parsers (Via params, Contact URI params, CSeq, etc.)
- ID generators (`newCallId`, `newTag`, `newBranch`)
- byte-level classifiers (`isInviteRequestBuffer`, `bufferHasEmergencyMarker`, `bufferHasToTag`, `buildStatelessReject503Buffer`, `jitteredRetryAfter`, `isEmergencyRequest`)

These four clusters have no shared state and no shared consumers. The byte-level classifiers are the odd one out — they are the only consumers `UdpTransport` and `Dispatcher` care about (stateless pre-parse), and they're useless to the generators / rule framework.

### Why it hurt me this session
When looking for `newBranch` I had to open a module whose top-of-file comment now says "SIP header accessors, structured-header parsers, identifier generators, and byte-level dispatcher helpers" — a 30-word grab bag instead of a single-sentence purpose. Same problem the old `MessageFactory` name had: a module named after a vague cross-cutting concern attracts more unrelated helpers.

### Fix (the split already proposed in `docs/TODO.md`)
1. `src/sip/headers.ts` — accessors + structured-header parsers (the `getHeader`/`setHeader`/`parseViaParams`/`parseUriParams` cluster).
2. `src/sip/identifiers.ts` — `newCallId`, `newTag`, `newBranch` (pure RNG wrappers; two imports survive: `stack-identity.ts` for branch, `B2buaCore`/initial-INVITE-handler for Call-ID/tag).
3. `src/sip/byte-classifiers.ts` — `isInvite*Buffer`, `bufferHas*`, `buildStatelessReject503Buffer`, `jitteredRetryAfter`. Consumers: `UdpTransport`, `Dispatcher`. Nothing else should import this.

Delete `MessageHelpers.ts`. Land as one slice.

---

## P1 — `generateInDialogRequest` returns `{ request, dialog }` but nothing enforces the dialog thread-back

Every other generator in `src/sip/generators.ts` returns just `SipRequest` / `SipResponse`. `generateInDialogRequest` is the exception: it also returns an updated `StackDialog` with `localCSeq` bumped. Callers *must* persist the returned dialog — if they drop it on the floor, the next in-dialog request reuses the same CSeq and the peer rejects it as out-of-sequence.

### Why this is latent-bug territory
There are ~10 call sites of `generateInDialogRequest` in `ActionExecutor.ts` alone. Grep reveals at least one pattern where the returned dialog has to be spliced back into the call via `call.legs.map(...).dialogs.map(...)` gymnastics. The compiler won't catch a caller that does `const { request } = generateInDialogRequest(...)` and discards `dialog`. No unit test verifies the invariant across call sites.

### Fix options
1. **Type-level guard** — wrap the return in a branded type like `StackDialogDelta` that only `persistDialog(state, delta)` accepts. Callers that discard the dialog get a "unused variable" lint error.
2. **Fold persistence into the generator** — pass the mutable `state` (or a `persistDialog` callback) in, and have the generator update state before returning the request. Rejects the pure-function property but matches where the responsibility actually lives in this codebase.
3. **Custom ESLint rule** — detect `generateInDialogRequest(...)` calls where the `dialog` member of the result is unused within the enclosing block. Cheapest to ship, enforces the invariant mechanically.

Recommend (1) if we want type-level correctness; (3) if we just want to stop the foot-gun.

---

## P1 — pending INVITE transaction handle is stored in three places

`InviteClientTransactionHandle` — the object that carries `originalInvite` + `branch` + `destination` for later CANCEL / ACK-for-2xx — lives in one of three slots depending on context:

```
leg.pendingInviteTxn              // initial INVITE on a b-leg
dialog.ext.pendingInviteTxn       // re-INVITE on any dialog
dialog.ext.ackBranch              // cached branch from first ACK (retransmit parity)
```

Every caller that needs to send a CANCEL or ACK-for-2xx has to do:

```ts
const handle = dialog.ext.pendingInviteTxn ?? leg.pendingInviteTxn
```

There are at least four such lookups in `ActionExecutor.ts` (lines 109, 207, 549, 1071). One of them is wrapped in a comment explaining the fallback rule — none of them delegate to a helper.

### Why this hurt in this session
When rewriting the "Branch capture lifecycle" subsection of `b2bua-sip-headers.md`, I had to open `ActionExecutor.ts` in four places to figure out the canonical lookup order. The fact that the comment was inconsistent between call sites (some said "initial vs re-INVITE", some said "leg for initial, dialog for re-INVITE") made me double-check which ones were stale from earlier slices.

### Fix
Add a single helper in `src/call/CallModel.ts`:

```ts
export function pendingInviteTxn(
  call: Call,
  legId: string,
  dialogId?: string,
): InviteClientTransactionHandle | undefined {
  const leg = call.legs.find(l => l.legId === legId)
  if (leg === undefined) return undefined
  if (dialogId !== undefined) {
    const dialog = leg.dialogs.find(d => d.dialogId === dialogId)
    if (dialog?.ext.pendingInviteTxn) return dialog.ext.pendingInviteTxn
  }
  return leg.pendingInviteTxn
}
```

Replace the four call sites. `ackBranch` stays where it is — it's a different concept (retransmit parity), and conflating it would just move the confusion.

---

## P1 — leftover scaffold tests weren't torn down at slice exit

During C.1–C.6 the team wisely added a "byte-equivalence to legacy builders" describe block in `tests/sip/generators.test.ts` that produced byte-identical output between `generate*` and the dead `build*` functions. That's a textbook shim-migration safety net.

The problem: the block outlived its purpose. After C.6 the `build*` functions had no production callers, but the byte-equivalence tests *kept calling them* — which is exactly why the `build*` deletion in D.1 cascaded into 16 failing tests in two files (`message-factory-notify.test.ts`, `message-factory-originated-invite.test.ts`) plus one obsolete describe block (lines 515–651 of `generators.test.ts`, plus its `stampPlaceholders` helper).

### Why this hurt
About 20 minutes of this session went into diagnosing which tests broke because they were "test harnesses for the old system, not invariants of the new system." Deleting 140 lines of obsolete test code shouldn't be a detective job.

### Fix
1. When adding migration shims or byte-equivalence tests during a multi-slice refactor, tag them with a sentinel comment: `// SHIM: remove in slice D.x`. Grep for those sentinels as part of the final-slice exit criterion.
2. For this specific codebase, add the check to `docs/todos/` template: every slice that introduces a shim *must* list the slice that removes it.

---

## P2 — `_generate*` underscore convention is documentation, not enforcement

`_generateAckForNon2xx` uses a leading underscore to signal "stack-internal; called only by TransactionLayer's auto-ACK machinery." That's documented in a doc comment. It's not enforced by anything.

TypeScript has no `internal` visibility; the convention is pure reviewer vigilance. Anyone can import `_generateAckForNon2xx` from anywhere in `src/` or `tests/`, misuse the contract (e.g. pass a 2xx as `finalResponse`), and the compiler is happy.

### Fix options
1. **ESLint `no-restricted-imports`** — disallow importing `_`-prefixed exports from outside a whitelisted import path (e.g. only `src/sip/TransactionLayer.ts` can import `_generateAckForNon2xx`).
2. **Move to a separate file** — `src/sip/generators-internal.ts` with a single allowed importer expressed in an `// @internal-only` header that a lint rule grep's for.

(1) is more standard; (2) is better if more `_`-prefixed helpers appear.

Low priority because there's only one such function today and `TransactionLayer` is its sole consumer.

---

## P2 — B2BUA outbound-hop construction touches three modules

To build the Via + Contact + fresh branch for one outbound b-leg hop, a handler imports from:

- `src/sip/generators.ts` — `ViaSpec`, `ContactSpec` types
- `src/sip/MessageHelpers.ts` — `newBranch`
- `src/b2bua/stack-identity.ts` — `legStackIdentity`

`legStackIdentity` is already the convenience wrapper, and it's the only import most handlers need — but the two lower-level modules still leak because `stack-identity.ts` re-exports neither the types nor `newBranch`. The types come back into scope because `ActionExecutor.ts` passes the spec through to the generators; `newBranch` is needed in tests that fabricate a branch without going through `legStackIdentity`.

### Fix
Either:
1. Re-export `ViaSpec` / `ContactSpec` from `src/b2bua/stack-identity.ts`. Handlers then import only the B2BUA helper module. Tests that need low-level `newBranch` still hit `src/sip/*` directly — that's fine, test code is allowed to reach through.
2. Leave as-is and accept the minor import noise. The B2BUA layer is genuinely downstream of the stack layer, so importing both isn't architecturally wrong.

Recommend (1) — the cost is a one-line re-export, and it matches how callers already think about the boundary.

---

## P2 — `call.aLegPendingVias` / `call.aLegPendingCSeq` are call-scoped but conceptually per-request

The transparent-relay path for b-leg→a-leg responses has two distinct scoping mechanisms:

- **Per-request**: `PendingRequest` entries keyed by CSeq, stored on the dialog. Used for re-INVITE, OPTIONS, INFO, UPDATE, MESSAGE, PRACK.
- **Call-scoped**: `call.aLegPendingVias` and `call.aLegPendingCSeq`, mutated by the a-leg-inbound relay path.

Reading `ActionExecutor.ts:758-769` I had to backtrack to figure out why one relay path uses `aLegPendingVias` and the other uses `pending.sourceVias`. The difference is load-bearing (the call-scoped fields are specifically for a-leg non-INVITE responses where there's only one outstanding request at a time) but it's not documented anywhere and the fields look structurally identical to `PendingRequest.source*`.

### Why the pattern mismatch matters
If two concurrent a-leg non-INVITE requests arrived (OPTIONS + INFO, say), the second one would overwrite `aLegPendingVias` before the first response lands. The code assumes this can't happen, but that assumption isn't asserted or tested.

### Fix
Move the a-leg-inbound relay to the same `PendingRequest`-keyed mechanism, then delete `aLegPendingVias` / `aLegPendingCSeq`. One relay model, one set of scoping rules, no "why are there two?" question for the next reader.

Low priority because the bug is latent and requires a specific concurrent-inbound pattern that's unlikely with UAs that wait for a final response before sending the next in-dialog request. Worth fixing the next time the relay code needs substantive changes.

---

## P2 — `tests/e2e/` → `tests/fullcall/` rename signal

The session's git status showed a recent rename of `tests/e2e/` to `tests/fullcall/` across 20+ files. The description in `CLAUDE.md` still says "fake-stack includes `tests/fullcall/e2e-fake-clock.*`" — so the individual test files still have `e2e-` prefixes inside the `fullcall/` directory. That's inconsistent and signals the naming isn't settled.

Not a time-waster in this session, but it caught my eye when resolving imports — a new reader will wonder which term is canonical (`e2e` or `fullcall`).

### Fix
Pick one. If `fullcall` won, rename `e2e-fake-clock.test.ts` → `fake-clock.test.ts` and `e2e-real-clock.test.ts` → `real-clock.test.ts`. Update the CLAUDE.md reference.

---

## Summary table

| # | Item | Priority | Reason |
|---|------|----------|--------|
| 1 | Architecture-doc review as slice-exit criterion | P0 | Live reference was stale; rewrite took ~30 min |
| 2 | Split `MessageHelpers.ts` into three focused files | P0 | Already flagged; the D.2 rename made it uglier |
| 3 | Enforce dialog thread-back for `generateInDialogRequest` | P1 | Silent CSeq-drift bug waiting to happen |
| 4 | Centralize `pendingInviteTxn` lookup helper | P1 | 4 ad-hoc call sites; inconsistent comments |
| 5 | Sentinel-comment for migration shim tests | P1 | 140 lines of dead test code outlived their slice |
| 6 | Enforce `_generate*` stack-internal convention | P2 | Convention today; enforcement when it matters |
| 7 | Re-export `ViaSpec`/`ContactSpec` from B2BUA layer | P2 | Minor import noise |
| 8 | Unify a-leg relay on `PendingRequest` scoping | P2 | Latent concurrency assumption; dual models |
| 9 | Settle `e2e-` vs `fullcall` naming | P2 | Naming inconsistency post-rename |
