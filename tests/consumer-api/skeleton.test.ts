/**
 * Consumer-API skeleton smoke test — imports each public subpath via its
 * package-mapped path and asserts the import resolves. Each subpath is
 * filled in by its own slice; this file proves the exports map and the
 * tsconfig `paths` plumbing work end-to-end.
 *
 * The actual surface checks live in:
 *   - test-harness.test.ts (slice 2)
 *   - sip.test.ts          (slice 3)
 *   - b2bua.test.ts        (slice 4)
 *   - sip-front-proxy.test.ts + observability.test.ts (slice 5)
 */

import { describe, expect, it } from "vitest"

import * as TestHarness from "@vcharbon/sipjs/test-harness"
import * as B2bua from "@vcharbon/sipjs/b2bua"
import * as SipFrontProxy from "@vcharbon/sipjs/sip-front-proxy"
import * as Sip from "@vcharbon/sipjs/sip"
import * as Observability from "@vcharbon/sipjs/observability"

describe("@vcharbon/sipjs subpath skeleton", () => {
  it("resolves every published subpath", () => {
    expect(TestHarness).toBeDefined()
    expect(B2bua).toBeDefined()
    expect(SipFrontProxy).toBeDefined()
    expect(Sip).toBeDefined()
    expect(Observability).toBeDefined()
  })
})
