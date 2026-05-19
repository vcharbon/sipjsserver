/**
 * Graceful-shutdown validation scenario.
 *
 *   npm run test:k8s:endurance:graceful
 *
 * Purpose: validates that the two-tier drain protocol (ADR-0008) holds
 * the user-visible contract: at 40 CAPS of clean traffic (no abuse) a
 * `worker-pod-graceful` chaos event produces ≤ `(1.5 / num_workers) ×
 * system_cps` sipp-observed final-failed calls, with mid-dialog
 * failures ≈ 0 (backup partition serves confirmed calls).
 *
 * This is a thin wrapper around `run-endurance.ts` that hard-codes:
 *   - `--caps 40` (the user-specified target rate)
 *   - `--abuse-caps 0` (0 invalid CAPS — clean traffic only)
 *   - `--chaos-weights` zeroing every event type EXCEPT
 *     `worker-pod-graceful`
 *   - `--chaos-min-interval 49s` (gives the pod ≥49s between chaos
 *     events to fully tear down, replace, bootstrap, and resync
 *     replication before the next drain — the user's "wait 49 seconds
 *     before restart" requirement)
 *   - `--chaos-max-interval 60s`
 *   - `--duration 8m` (warmup 60s + ~5 drain events at 49-60s spacing
 *     + cooldown 60s)
 *   - `--warmup 60s`, `--cooldown 60s`, `--drain 60s`
 *
 * The endurance analyzer's per-event verdict (driven by
 * `expectedImpact.ts` → `worker-pod-graceful`) decides PASS/FAIL.
 */

import { spawn } from "node:child_process"
import * as path from "node:path"

const RUN_ENDURANCE = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "run-endurance.ts",
)

// Zero every event type the scheduler knows except worker-pod-graceful.
// Keys must match `ChaosEventType` in `chaosOps.ts`.
const CHAOS_WEIGHTS = [
  "worker-pod-graceful=1",
  "worker-pod-api-delete-force=0",
  "worker-pod-kill9=0",
  "proxy-pod-graceful=0",
  "proxy-pod-kill9=0",
  "proxy-cutoff-vrrp=0",
  "limiter-redis-graceful=0",
  "limiter-redis-kill9=0",
  "node-shutdown-app=0",
  "node-shutdown-edge=0",
  "worker-cut-from-proxy-hard=0",
  "worker-cut-from-peers-hard=0",
  "worker-cut-from-limiter-redis-hard=0",
  "worker-isolate-all-hard=0",
  "worker-cut-from-proxy-loss30=0",
  "proxy-full-isolate=0",
  "non-emergency-burst=0",
].join(",")

const ARGS = [
  "--duration", "8m",
  "--warmup", "60s",
  "--cooldown", "60s",
  "--drain", "60s",
  "--caps", "40",
  "--abuse-caps", "0",
  "--chaos-min-interval", "49s",
  "--chaos-max-interval", "60s",
  "--chaos-weights", CHAOS_WEIGHTS,
  // Forward any flags the operator passes on the command line.
  ...process.argv.slice(2),
]

const child = spawn("tsx", [RUN_ENDURANCE, ...ARGS], {
  stdio: "inherit",
  env: process.env,
})

child.on("exit", (code) => {
  process.exit(code ?? 1)
})
