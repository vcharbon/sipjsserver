// @ts-check
/**
 * ESLint flat config — minimal, scoped to enforcing the SIP-front-proxy
 * dependency boundary.
 *
 * The proxy package (`src/sip-front-proxy/**`) is allowed to import only:
 *   - the `effect` runtime
 *   - `src/sip/**` (parser, generators, SignalingNetwork, message helpers)
 *   - other files inside `src/sip-front-proxy/**`
 *
 * Everything else under `src/` (b2bua, call, decision, redis, cdr, cluster,
 * http, observability) is banned by `no-restricted-imports`. See
 * `docs/todos/SIP-Front-Proxy.md` constraint #1 ("Dependency isolation").
 *
 * The rest of the codebase is intentionally not linted yet — broader rules
 * land in a future PR.
 */

import tseslint from "typescript-eslint"

// PR6 decision (option b in the PR6 spec): we kept the original ban on
// `src/observability/**` and added a thin observability wrapper inside
// `src/sip-front-proxy/observability/` that uses Effect's first-party
// `Metric` module directly — no cross-package import needed. The lint
// patterns below are anchored to absolute `src/...` paths so they don't
// false-match the proxy's own `src/sip-front-proxy/observability/**`
// submodule when imported relatively.
//
// Sibling `../<dir>/...` style imports from inside `src/sip-front-proxy/`
// can only ever resolve back to `src/sip-front-proxy/<dir>` (one level
// up from a file under `health/`, `strategies/`, etc.) — they cannot
// reach a forbidden package, so we don't need a separate `../<dir>`
// pattern. Imports that try to leave the package use `../../<dir>/...`
// or absolute `src/<dir>/...` — both shapes hit the patterns below
// because they include the literal `src/<dir>/` segment.
const FORBIDDEN_FROM_PROXY = [
  "**/src/b2bua/**",
  "**/src/call/**",
  "**/src/decision/**",
  "**/src/redis/**",
  "**/src/cdr/**",
  "**/src/cluster/**",
  "**/src/http/**",
  "**/src/observability/**",
  // `..`-relative escapes: each banned module also lives under its own
  // top-level path inside `src/`, so `../../<dir>` from anywhere in the
  // proxy resolves to a forbidden one. The proxy's own subdirectories
  // (`observability/`, `registry/`, `security/`, `strategies/`,
  // `health/`) are imported as `../<dir>` (one segment up), which the
  // double-segment pattern doesn't match.
  "**/../../b2bua/**",
  "**/../../call/**",
  "**/../../decision/**",
  "**/../../redis/**",
  "**/../../cdr/**",
  "**/../../cluster/**",
  "**/../../http/**",
  "**/../../observability/**",
]

export default tseslint.config(
  {
    // Lint scope: we only run rules on the proxy package and the bin entry.
    // Test fixtures and the rest of the repo are excluded so day-to-day
    // `npm run lint` stays fast and focused on the boundary we care about.
    ignores: [
      "node_modules/**",
      "dist/**",
      "dist-tests/**",
      "tests/sip-front-proxy/lint-negative/**",
      // The lint-negative fixture intentionally violates the rule; the
      // negative-path test invokes ESLint on it programmatically.
    ],
  },
  {
    files: ["src/sip-front-proxy/**/*.ts"],
    languageOptions: {
      // typescript-eslint's parser handles `import type { Foo }`, `as const`,
      // generic-parameter syntax in arrow functions, and other TS-only
      // forms that the default ESLint parser would choke on. We only want
      // it active on the files we lint — the rest of the repo isn't in
      // scope yet.
      parser: tseslint.parser,
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: FORBIDDEN_FROM_PROXY.map((pattern) => ({
            group: [pattern],
            message:
              "src/sip-front-proxy/** may only import from `effect` and `src/sip/**`. " +
              "See docs/todos/SIP-Front-Proxy.md constraint #1.",
          })),
        },
      ],
    },
  },
)
