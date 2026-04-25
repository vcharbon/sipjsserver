/**
 * Slice 7 — matrix expansion + fail-loud compatibility check.
 *
 * Three things to prove:
 *   1. The same scenario script runs against two different ServiceCases
 *      (basic-call + basic-call-variant), each one passing every rule.
 *      This is the orthogonality demonstration — the scenario describes
 *      flow, the ServiceCase describes content.
 *   2. buildMatrix(...) accepts compatible (scenario, ServiceCase) pairs.
 *   3. buildMatrix(...) throws synchronously when a ServiceCase exposes
 *      the wrong agent shape (extra leg / missing alice / renamed leg).
 *      Failures surface at matrix-build time so a misconfigured suite
 *      never reaches the runner.
 */

import { describe, it, expect } from "vitest"
import { describe as describeEffect, it as itEffect } from "@effect/vitest"
import { Effect } from "effect"
import { basicCall } from "../scenarios2/basic-call.js"
import { buildMatrix, type ScenarioRequirements } from "./matrix.js"
import { allRules } from "./rules/index.js"
import { runDriveOnly, assertEnginePassed } from "./runner.js"
import { loadServiceCase } from "./service-case/load.js"
import type { ServiceCase } from "./service-case/types.js"

const basicCallReqs: ScenarioRequirements = {
  aliceNames: ["alice"],
  legNames: ["bob1"],
}

describe("matrix builder — compatibility checks", () => {
  it("accepts compatible scenario × ServiceCase pairs", () => {
    const cells = buildMatrix([
      {
        scenarioId: "basic-call",
        script: basicCall,
        requirements: basicCallReqs,
        serviceCaseIds: ["basic-call", "basic-call-variant"],
      },
    ])
    expect(cells.length).toBe(2)
    expect(cells.map((c) => c.serviceCase.id).sort()).toEqual([
      "basic-call",
      "basic-call-variant",
    ])
  })

  it("throws when ServiceCase has an extra leg", () => {
    const fakeLoader = (id: string): ServiceCase => ({
      id,
      alices: [{ name: "alice", content: { fromUri: "x", toUri: "y", requestUri: "z" } }],
      legs: [{ name: "bob1" }, { name: "bob2" }],
    })
    expect(() =>
      buildMatrix(
        [
          {
            scenarioId: "basic-call",
            script: basicCall,
            requirements: basicCallReqs,
            serviceCaseIds: ["bogus"],
          },
        ],
        fakeLoader
      )
    ).toThrow(/leg mismatch/)
  })

  it("throws when ServiceCase has a renamed alice", () => {
    const fakeLoader = (id: string): ServiceCase => ({
      id,
      alices: [{ name: "alicia", content: { fromUri: "x", toUri: "y", requestUri: "z" } }],
      legs: [{ name: "bob1" }],
    })
    expect(() =>
      buildMatrix(
        [
          {
            scenarioId: "basic-call",
            script: basicCall,
            requirements: basicCallReqs,
            serviceCaseIds: ["renamed"],
          },
        ],
        fakeLoader
      )
    ).toThrow(/alice mismatch/)
  })
})

describeEffect("matrix expansion — basic-call × {default, variant}", () => {
  for (const scId of ["basic-call", "basic-call-variant"]) {
    itEffect.effect(
      `passes every rule against ServiceCase "${scId}"`,
      () =>
        Effect.gen(function* () {
          const sc = loadServiceCase(scId)
          const result = yield* runDriveOnly({
            scenarioId: "basic-call",
            serviceCase: sc,
            script: basicCall,
            rules: allRules,
          })
          assertEnginePassed(result)
        }),
      { timeout: 30_000 }
    )
  }
})
