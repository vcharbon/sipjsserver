/**
 * liveStack — TRANSITIONAL thin re-export over `stackLayer({ mode: "live" })`.
 *
 * The actual composition lives in `tests/support/stackLayer.ts`. This file
 * preserves the legacy `liveStackLayer(...)` symbol; new live-stack
 * consumers should pull from `testLayers.stacks.live({ ... })` instead.
 *
 * Not used by the existing `createLiveRunner` path — that helper drives
 * an *external* B2BUA process over real UDP and does not instantiate a
 * service layer at all. `liveStackLayer` exists as the in-process,
 * live-clock harness for tests that want real Redis + real-UDP behaviour
 * inside the same `Effect.provide` scope as the test.
 */

import { stackLayer, type LiveModeOpts } from "./stackLayer.js"

export function liveStackLayer(opts: Omit<LiveModeOpts, "mode">) {
  return stackLayer({ mode: "live", ...opts })
}
