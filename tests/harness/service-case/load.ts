/**
 * ServiceCase JSON loader. Reads a file synchronously (Node fs) and
 * decodes it through the Effect Schema for runtime validation.
 *
 * Sync IO is fine here — tests load fixtures at test setup, never on the
 * request path.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { decodeServiceCase } from "./schema.js"
import type { ServiceCase } from "./types.js"

const SERVICE_CASES_DIR = "tests/service-cases"

export function loadServiceCase(id: string): ServiceCase {
  const path = join(SERVICE_CASES_DIR, `${id}.json`)
  const raw = readFileSync(path, "utf8")
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`ServiceCase "${id}" at ${path}: invalid JSON — ${(err as Error).message}`)
  }
  return Effect.runSync(decodeServiceCase(json))
}
