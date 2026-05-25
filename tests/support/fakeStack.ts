/**
 * fakeStack — TRANSITIONAL thin re-export over `stackLayer({ mode: "fake" })`.
 *
 * The actual composition lives in `tests/support/stackLayer.ts`. This file
 * preserves the legacy `fakeStackLayer(...)` symbol so the broad set of
 * tests that still import from `../support/fakeStack.js` keep working
 * unchanged while the rest of the catalog catches up.
 *
 * New tests should import from `tests/support/testLayers.ts`
 * (`testLayers.stacks.fake({ ... })`) or directly from `stackLayer.ts`.
 */

import { stackLayer, type FakeModeOpts } from "./stackLayer.js"

export {
  DEFAULT_TRANSIT_DELAY_MS,
  NoOpCdrLayer,
  NoOpTracingLayer,
  Recorder,
  type StackPerfMode as FakeStackPerfMode,
} from "./stackLayer.js"

export function fakeStackLayer(opts: Omit<FakeModeOpts, "mode">) {
  return stackLayer({ mode: "fake", ...opts })
}
