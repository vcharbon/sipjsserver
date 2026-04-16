# Surprises & Time-Wasters — SIP Anomaly Fix Session (2026-04-15)

> This file captures every friction point, wrong assumption, and wasted effort from
> the 9-anomaly fix session. Each entry includes the root cause, how much time it
> wasted, and a concrete improvement proposal with priority.

---


---

## T10 · Effect.sync + try/catch lint hint is misleading in pure-sync demux context (LOW — noise)

**What happened.**  
The IDE flagged `effect(tryCatchInEffectGen)` on the try/catch in the mock transport's
`send`. The hint says "use Effect.try or Effect.tryPromise". But the try/catch here
wraps a third-party parser that can throw — and we **want** to rethrow as a defect
(not a typed Effect failure) because demux parse failures are programmer errors, not
runtime conditions.

The hint is not wrong in principle but requires careful reading to dismiss in this
context.

**Fix.**  
This is a limitation of the Effect Language Service lint rule — it can't know intent.
The mitigation is to move the parse call into `Effect.try` explicitly, which also
makes the intent visible:
```typescript
Effect.try({
  try: () => customParser.parse(msg),
  catch: (err) => new Error(`Demux parse error: ${String(err)}`)
})
```
This is both lint-clean and documents the error as a typed failure.

**Priority: LOW** — the code works, but the pattern is suboptimal.

---

## Summary Table

| ID | Title | Priority | Status |
|----|-------|----------|--------|
| T1 | `sdpAnswer` positional API trap | **HIGH** | Open |
| T2 | `ReceivedPacket` type duplicated across 3 files | **HIGH** | Open |
| T3 | `Effect.sync` blocks Clock access in mock send | **MEDIUM** | Open |
| T4 | Drain-phase timestamp architecture invisible | **HIGH** | Partially fixed (arrivalMs added; missing comments) |
| T5 | Plan said "503" but test used "486" | LOW | Closed (informational) |
| T6 | `crossingReinvite` flagged as issue but test was green | **MEDIUM** | Closed (informational) |
| T7 | `TestTransport.receive` anonymous return type | **MEDIUM** | Open (blocked by T2) |
| T8 | `unexpectedMessages` collection lacks arrival timestamp | **MEDIUM** | Open |
| T9 | `settle()` docstring missing "does not affect TestClock" note | LOW | Open |
| T10 | Effect.sync + try/catch lint hint misleading | LOW | Open |

---

## Recommended next-action order

1. **T1** — convert `sdpAnswer` to options-bag. Catches misuse at compile time. 30-min change.
2. **T2 + T7** — export `ReceivedPacket` from `types.ts`, update all references. 20-min change.
3. **T8** — add `arrivalMs` to `unexpectedMessages`. 15-min change; completes the timestamp fix started this session.
4. **T3** — refactor mock `send` to `Effect.try`. 10-min change; lint-clean.
5. **T4 comments + T9** — add the missing docstrings. 15-min; pure documentation.
6. **T6** — add a legend to the anomaly aggregate explaining PASS vs ANOMALIES distinction. 10-min.
