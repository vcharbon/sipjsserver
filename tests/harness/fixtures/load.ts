import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseRecording } from "../recording-codec.js"
import type { CallRecording } from "../recording.js"

const FIXTURE_DIR = "tests/harness/fixtures/recordings"

export function loadRecording(name: string): CallRecording {
  const path = join(FIXTURE_DIR, `${name}.yaml`)
  return parseRecording(readFileSync(path, "utf8"))
}
