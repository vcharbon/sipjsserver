import { fileURLToPath } from "node:url"

/**
 * Resolve `@vcharbon/sipjs/<subpath>` to the local `src/<subpath>/index.ts`
 * source so vitest configs can run consumer-api smoke tests without
 * waiting for a build step. The published package's `exports` map
 * mirrors this mapping (pointing at `dist/<subpath>/index.js`).
 */
const subpathSource = (subpath: string) =>
  fileURLToPath(new URL(`./src/${subpath}/index.ts`, import.meta.url))

export const sipjsSubpathAliases = {
  "@vcharbon/sipjs/test-harness": subpathSource("test-harness"),
  "@vcharbon/sipjs/b2bua": subpathSource("b2bua"),
  "@vcharbon/sipjs/rules-sdk": subpathSource("rules-sdk"),
  "@vcharbon/sipjs/sip-front-proxy": subpathSource("sip-front-proxy"),
  "@vcharbon/sipjs/sip": subpathSource("sip"),
  "@vcharbon/sipjs/observability": subpathSource("observability"),
} as const
