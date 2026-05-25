/**
 * Central declarations of test-specific RFC-rule exemptions.
 *
 * Each entry suppresses a *named rule* for a *named test path*. When the
 * harness builds `stackLayer` for a test whose vitest `testPath`
 * suffix-matches an entry, the entry's rule findings (optionally narrowed
 * to a specific `peerBindKey`) are recorded as advisory rather than
 * deferred-fail. The justification is mandatory and surfaces in the
 * exception ledger.
 *
 * Invariants enforced at layer build (see stackLayer.ts):
 *
 *   - `peerBindKey` may not name a DUT bind. The DUT is always audited;
 *     if the DUT is the violator, it's a real B2BUA bug that needs a
 *     precursor plan, not an exemption.
 *   - `justification` must be a non-empty human-readable string.
 *
 * Per the RFC verification plan, this file starts empty. Phase-2 PRs
 * append entries as fixture-wide allowances are encountered.
 *
 * See: docs/plan/extending-sip-rfc-test-temporal-jellyfish.md (Phase 0 §3)
 *      docs/RFC_Verification.md (when authored)
 */

export interface RfcException {
  /**
   * Vitest `testPath` (or a stable suffix thereof) of the test file
   * this exemption applies to. Matched via `endsWith` against the
   * `expect.getState().testPath` reported at layer build.
   */
  readonly testPath: string
  /**
   * The exact `PeerAuditRule.name` / `CrossMessageAuditRule.name` to
   * suppress. Stamping a non-existing name fails at lookup (no
   * suppression occurs).
   *
   * Use `"*"` to suppress every rule for this test — reserved for
   * tests that deliberately send malformed SIP (negative cases for
   * the DUT's reject paths). Wildcard entries still require a
   * `justification`.
   */
  readonly ruleName: string
  /**
   * Optional bindKey (`"ip:port"`) to narrow the suppression to one
   * peer. Omit ⇒ suppress this rule's findings for every non-DUT peer
   * in this test.
   */
  readonly peerBindKey?: string
  /**
   * Mandatory human-readable reason. Surfaces in the exception ledger.
   */
  readonly justification: string
}

export const RFC_EXCEPTIONS: ReadonlyArray<RfcException> = []

