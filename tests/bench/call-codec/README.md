# `call-codec` benchmark

CPU + bytes-on-wire comparison of encoder/decoder strategies for the
B2BUA call-cache replication pipeline. Upgraded May 2026 to be the
regression gate for codec changes after a 25 % msgpackr pack/unpack CPU
regression slipped past the original ADR-0009 acceptance criteria.

## Running

```bash
npx tsx tests/bench/call-codec/driver.ts                # all variants, 20_000 iter
npx tsx tests/bench/call-codec/driver.ts 100000         # tighter numbers, all variants
npx tsx tests/bench/call-codec/driver.ts 20000 v1-schema v6-msgpackr   # subset
npx tsx tests/bench/call-codec/driver.ts --gate v6-msgpackr            # CI gate
```

Each variant runs in its own subprocess (`spawn` + `--expose-gc`) so V8
JIT state and GC behaviour don't bleed across variants.

## Pipeline modelled

Mirrors `src/call/CallState.ts:flushToRedis` and
`src/replication/{ReplicationProtocol,EchoApply}.ts`:

```
Call (in-mem) + Date.now()
  → stampWrittenAt(call)                 // CallState.ts:584 spread allocation
  → A. encodeCall(stamped)               // msgpack/protobuf/JSON pack
       body written to primary Redis
  → B. wireEncode(env, body)             // ReplicationProtocol.ts:160 envelope pack
       frame streamed to replication peer
  → C. wireDecode(frameLine)             // PullerFiber / decodeFrame
       envelope parsed, body extracted
  → D. decodeCall(body)                  // CallState.ts load path
       Call rehydrated in memory
```

Two aggregate stages:

- **`fullFlush` = A + B** — **headline number.** The production hot
  loop. Every state-mutating SIP message fires both packs back-to-back;
  the May 2026 endurance regression was exactly this number going up.
- **`FULL` = A + B + C + D** — full producer + replication-receiver
  round-trip. Useful for capacity planning the receiver side.

## Production-fidelity choices

The bench was rebuilt to reproduce the production hot loop's *absolute*
allocation profile, not just relative codec costs:

- **Production spread.** Every variant's `encodeCall` wraps the input in
  `{ ...call, __writtenAtMs: Date.now() }` (see [codec.ts](./codec.ts)
  `stampWrittenAt`). This is the prod allocation tax we missed first
  time around. When the production-side fix lands (writtenAtMs moves
  into the envelope), drop the spread on the same PR — budgets are
  invalidated otherwise.
- **Fixture mix.** Instead of a single `representativeCall`, the bench
  builds a deterministic pool of `2048` fixtures sampled from five
  shape kinds with weights matching a healthy worker's call-state
  histogram:

  | Kind | Weight | Shape |
  |---|---:|---|
  | `EARLY` | 15 % | pre-200, no bLegs, no confirmed dialogs, 1 cdrEvent |
  | `CONFIRMED_STEADY` | 55 % | 1+1 legs, 1 confirmed dialog each, ~20 headers, cachedSdp on b-leg |
  | `REINVITE_STORM` | 15 % | 5–10 pending requests/dialog, cachedSdp both legs, 18 cdrEvents |
  | `TERMINATING` | 10 % | state="terminating", larger tagMap, no aLegInvite body |
  | `ABUSE_MALFORMED` | 5 % | 35 extra headers, 20 pending requests/dialog, 60 cdrEvents |

  Weights are starter values (see [fixtureMix.ts](./fixtureMix.ts)).
  Recalibrate from a fresh `/debug/memory` histogram scrape before
  tightening budgets — document the source in this README on update.
- **Per-shape (body, frame) pre-build.** Stages B/C/D measure decode/
  encode in isolation by pulling cached body/frame triples per fixture
  index so the per-iteration cost is purely codec, not setup.

## Variants

| Variant | Strategy | Notes |
|---|---|---|
| **v1-schema** | `Schema.encodeEffect(JsonCallSchema)` + `Schema.decodeUnknownEffect` | Pre-msgpackr-migration baseline. Validates every field on encode + decode. |
| **v2-raw-json** | `JSON.stringify(call, bufferReplacer)` + base64 for `Uint8Array` | Skip Schema validation; same on-wire bytes as v1. |
| **v3-no-repl-reparse** | v2 + wire format `<env-json>\x1f<body>\n` | Replication never re-parses the body. |
| **v4-cas-outofband** | v3 + extract `aLegInvite.body`, `headers`, `dialog.ext.cachedSdp` into a content-addressed store; only the slim body is encoded per-flush. | Targets re-INVITE storm cost. |
| **v5-protobuf** | protobufjs reflective. Bytes stay binary; exotic unions JSON-string. | No `Schema` validation. |
| **v5b-protobuf-static** | `pbjs --target static-module` generated code. | Same wire as v5; no reflective JIT. |
| **v6-msgpackr** | msgpackr (binary, schemaless). | **Current production codec.** Module-level Encoder, `useRecords:false` (see [src/call/CallCodec.ts](../../../src/call/CallCodec.ts) for the rolling-upgrade landmine). |

## Budgets and CI gate

[budgets.ts](./budgets.ts) holds per-stage absolute thresholds for the
champion variant (currently `v6-msgpackr`). `driver.ts --gate <variant>`
runs the bench and exits non-zero on any breach, printing the offending
stage + how far it exceeded the budget.

**Calibration method.** Numbers are observed p95 on a quiesced WSL2
host (Node 22), with ~1.5–2× headroom so the gate fires on real
regressions, not jitter. Tighten by running 5× on target hardware and
updating with the new median; document `uname -a` of the runner on the
PR that tightens.

When you add a new stage, add a budget entry in the same PR. Missing
budget for an existing stage is silently skipped (the gate doesn't
fail on absence), but a stage with no budget is a stage without a
safety net.

## What this benchmark still does NOT cover

The May 2026 upgrade closed gaps 1–4 of the original handoff. The
remaining items, planned but not yet implemented:

- **Concurrent encode under contention.** Single-fiber-per-process
  measurement understates GC/allocator pressure observed under
  production's N concurrent fibers. Plan: add `concurrentFullFlush.N{n}`
  stages parameterised by `N = 1, 4, 16, 64` parallel `Effect.gen` fibers.
- **Dispatcher throughput simulation.** Production's actual failure mode
  is per-call event queue saturation (61 k dropped INVITEs at 400/400
  queue depth). Plan: a fixed-wall-clock dispatcher loop that maps
  directly to the prod failure mode. This is the single number that
  would have caught the regression *before* k8s endurance.
- **Validation cost.** Production may want a "paranoid" mode flag that
  re-enables Schema validation under functional-test runs.
- **Redis IO.** Stage A's measured time is in-process serialization
  only — TCP / Lua scripts not modelled.
- **Delta encoding.** A future `v7-msgpackr-records-delta` would compute
  a JSON-Patch-like diff between successive flushes; pairs with
  production Fix #3 dedup.

See `/tmp/handoff-Pmj1v4.md` (when present) for the original gap
analysis and the next-variants table.

## Interpreting the output

The driver prints these tables, in order:

1. **Fixture mix** — once at the top so reviewers see what
   distribution the numbers reflect.
2. **Bytes per encoded form** — mean and max body / wire frame bytes
   across the mix. Max captures the abuse-malformed outlier.
3. **HEADLINE — fullFlush** — production hot loop cost. Sort by this.
4. **Per-stage mean / p99** — drill-down. `A+B = fullFlush`,
   `A+B+C+D = FULL`.
5. **Throughput + RSS Δ** — full round-trip ops/sec at steady state.
   RSS delta hints at allocator pressure (the v5 reflective protobuf
   path is notably allocation-heavy).
6. **GC pressure on FULL round-trip** — count, total ms, % of wall.
7. **Speedup vs v1-schema** — relative rank on fullFlush. Sanity check.

When `--gate <variant>` is set, an additional **Gate verdict** section
is printed; non-zero exit on breach.

## When to re-run

- Whenever the `Call` schema gains a hot-path field.
- Whenever production-side Fix #2 (move `__writtenAtMs` to envelope)
  lands — the spread in `stampWrittenAt` must be dropped on the same
  PR or budgets are invalid.
- Before adopting any non-V6 strategy: re-run with `100_000` iterations
  on the target hardware to capture reliable p99s.
- When considering delta encoding: add the variant and compare against
  v6 fullFlush + GC %.
