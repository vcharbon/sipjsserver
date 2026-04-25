/**
 * Fixture: deliberately violates the `no-restricted-imports` boundary rule
 * for `src/sip-front-proxy/**`. Consumed by `forbidden-import.test.ts`,
 * which asserts ESLint reports the violation. NOT part of normal lint
 * (the fixture path is in `eslint.config.js` `ignores`) and NOT compiled
 * by typecheck (lives under `tests/`, not `src/`).
 */

// @ts-nocheck — file is fed to ESLint as text; Node never imports it.
// Each import below should trigger a `no-restricted-imports` violation
// when ESLint evaluates this file as if it lived under
// `src/sip-front-proxy/**` (see `forbidden-import.test.ts`).

import "src/b2bua/B2buaCore"
import "src/call/CallStateCache"
import "src/redis/RedisClient"

export const FIXTURE_MARKER = "forbidden-import"
