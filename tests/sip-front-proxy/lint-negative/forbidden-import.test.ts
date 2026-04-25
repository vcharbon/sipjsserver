/**
 * Negative-path lint test: confirms the `no-restricted-imports` rule
 * configured in `eslint.config.js` actually fires when a file inside
 * `src/sip-front-proxy/**` imports from a forbidden package.
 *
 * Strategy: read the fixture from disk and feed it to ESLint via
 * `lintText` with a synthetic `filePath` that matches the proxy glob.
 * That way the fixture itself is excluded from normal `npm run lint`
 * (via `ignores`) and does not need to live under `src/` to exercise
 * the rule. We assert at least one violation comes from
 * `no-restricted-imports`.
 */

import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ESLint } from "eslint"

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, "..", "..", "..")
const fixturePath = path.join(here, "forbidden-import.fixture.ts")
// Synthetic path that matches `src/sip-front-proxy/**/*.ts` so the
// boundary rule applies. The file does not need to exist on disk under
// this path — ESLint only uses the string for config matching.
const syntheticProxyPath = path.join(
  repoRoot,
  "src",
  "sip-front-proxy",
  "__synthetic__",
  "forbidden-import.ts"
)

describe("eslint boundary rule for src/sip-front-proxy/**", () => {
  it("reports no-restricted-imports on a forbidden src/b2bua/** import", async () => {
    const source = await fs.readFile(fixturePath, "utf-8")
    const eslint = new ESLint({ cwd: repoRoot })
    const results = await eslint.lintText(source, { filePath: syntheticProxyPath })

    expect(results).toHaveLength(1)
    const messages = results[0]!.messages
    const restricted = messages.filter((m) => m.ruleId === "no-restricted-imports")
    expect(restricted.length).toBeGreaterThan(0)
    // Message wording check — guards against the ban list silently
    // shrinking to nothing in a future config edit.
    const firstMessage = restricted[0]!.message
    expect(firstMessage).toMatch(/sip-front-proxy/)
  }, 30_000)
})
