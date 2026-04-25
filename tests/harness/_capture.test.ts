/**
 * One-shot capture: writes the basic-call recording(s) to YAML
 * fixture files. Skipped by default; flip the env flag when refreshing
 * fixtures (`HARNESS_CAPTURE=1 vitest run -c vitest.config.fake.ts
 * tests/harness/_capture.test.ts`).
 */

import { describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { basicCall } from "../scenarios2/basic-call.js"
import { allRules } from "./rules/index.js"
import { runDriveOnly } from "./runner.js"
import { serializeRecording } from "./recording-codec.js"
import { loadServiceCase } from "./service-case/load.js"

const RUN = process.env["HARNESS_CAPTURE"] === "1"
const OUT_DIR = "tests/harness/fixtures/recordings"

describe.skipIf(!RUN)("harness — capture basic-call fixture", () => {
  it.effect(
    "writes basic-call-clean*.yaml",
    () =>
      Effect.gen(function* () {
        const sc = loadServiceCase("basic-call")
        const result = yield* runDriveOnly({
          scenarioId: "basic-call",
          serviceCase: sc,
          script: basicCall,
          rules: allRules,
        })
        let i = 0
        for (const rec of result.recordings) {
          const yaml = serializeRecording(rec)
          const tag = result.recordings.length === 1 ? "" : `-${i}`
          const path = join(OUT_DIR, `basic-call-clean${tag}.yaml`)
          writeFileSync(path, yaml, "utf8")
          console.log(`wrote ${path} (${yaml.length} bytes, ${rec.entries.length} entries)`)
          i++
        }
      }),
    { timeout: 30_000 }
  )
})
