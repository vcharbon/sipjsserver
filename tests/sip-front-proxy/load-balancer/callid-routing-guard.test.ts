/**
 * Guard test for the HA scenario's pre-computed Call-ID constants.
 *
 * `tests/scenarios/ha/two-calls-routed-to-two-workers.ts` hardcodes two
 * Call-IDs whose HRW rendezvous winners are deterministically `b2b-1`
 * and `b2b-2` respectively. The constants were obtained by a one-shot
 * brute-force search (see comment block in that file). If anyone edits
 * the worker IDs, the rendezvous score function, or the candidate set,
 * the constants may silently rot — this test re-derives the routing
 * under the actual production code and fails loudly when that happens,
 * pointing at the brute-force re-derivation site.
 */

import { describe, expect, it } from "vitest"
import {
  rendezvousSelect,
  WorkerId,
} from "../../../src/sip-front-proxy/index.js"
import {
  CALLID_TO_W1,
  CALLID_TO_W2,
} from "../../scenarios/ha/two-calls-routed-to-two-workers.js"
import {
  HA_WORKER_1,
  HA_WORKER_2,
} from "../../support/proxyB2bFakeStack.js"

describe("sip-front-proxy/load-balancer — HA Call-ID routing guard", () => {
  const candidates = [
    { id: HA_WORKER_1 as string },
    { id: HA_WORKER_2 as string },
  ]

  it("CALLID_TO_W1 routes to b2b-1 under the {b2b-1, b2b-2} candidate set", () => {
    const winner = rendezvousSelect(CALLID_TO_W1, candidates)
    expect(winner).toBeDefined()
    expect(winner!.id).toBe(WorkerId(HA_WORKER_1))
    // If this fails, re-run the brute-force loop documented at the top
    // of `tests/scenarios/ha/two-calls-routed-to-two-workers.ts` and
    // update CALLID_TO_W1.
  })

  it("CALLID_TO_W2 routes to b2b-2 under the {b2b-1, b2b-2} candidate set", () => {
    const winner = rendezvousSelect(CALLID_TO_W2, candidates)
    expect(winner).toBeDefined()
    expect(winner!.id).toBe(WorkerId(HA_WORKER_2))
    // If this fails, re-run the brute-force loop documented at the top
    // of `tests/scenarios/ha/two-calls-routed-to-two-workers.ts` and
    // update CALLID_TO_W2.
  })

  it("the two pre-computed Call-IDs route to distinct workers", () => {
    const w1 = rendezvousSelect(CALLID_TO_W1, candidates)
    const w2 = rendezvousSelect(CALLID_TO_W2, candidates)
    expect(w1?.id).not.toBe(w2?.id)
  })
})
