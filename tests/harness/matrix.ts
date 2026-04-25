/**
 * Matrix builder — pairs scenarios with one or more ServiceCases and
 * fails loudly when a pairing is structurally incompatible (per Q6).
 *
 * A scenario declares its agent shape in `ScenarioRequirements`
 * (alice/leg names). The builder verifies that each declared
 * ServiceCase exposes exactly those names — an extra leg or a missing
 * alice is treated as a programmer error and throws synchronously
 * before any test runs.
 *
 * The output is a flat list of `MatrixCell`s suitable for
 * `it.effect.each(matrix)(...)` patterns.
 */

import type { ScenarioScript } from "./runner.js"
import { loadServiceCase } from "./service-case/load.js"
import type { ServiceCase } from "./service-case/types.js"

/**
 * Structural shape a scenario expects from its ServiceCase. Either form
 * is allowed:
 *   - Exact name lists: enforces both count and identity.
 *   - Counts only: enforces arity but not labels (use sparingly).
 */
export interface ScenarioRequirements {
  /** Alice agents the scenario references by name. */
  readonly aliceNames: ReadonlyArray<string>
  /** Outbound legs the scenario references by name. */
  readonly legNames: ReadonlyArray<string>
}

export interface ScenarioMatrixEntry {
  readonly scenarioId: string
  readonly script: ScenarioScript
  readonly requirements: ScenarioRequirements
  /** ServiceCase ids to run this scenario against (one per cell). */
  readonly serviceCaseIds: ReadonlyArray<string>
}

export interface MatrixCell {
  readonly scenarioId: string
  readonly script: ScenarioScript
  readonly serviceCase: ServiceCase
}

/** Throws on incompatibility (intentional fail-loud per Q6). */
export function buildMatrix(
  entries: ReadonlyArray<ScenarioMatrixEntry>,
  loader: (id: string) => ServiceCase = loadServiceCase
): ReadonlyArray<MatrixCell> {
  const cells: MatrixCell[] = []
  for (const entry of entries) {
    for (const scId of entry.serviceCaseIds) {
      const sc = loader(scId)
      assertCompatible(entry.scenarioId, entry.requirements, sc)
      cells.push({ scenarioId: entry.scenarioId, script: entry.script, serviceCase: sc })
    }
  }
  return cells
}

function assertCompatible(
  scenarioId: string,
  req: ScenarioRequirements,
  sc: ServiceCase
): void {
  const aliceNames = sc.alices.map((a) => a.name)
  const legNames = sc.legs.map((l) => l.name)
  const errs: string[] = []

  const reqAlice = [...req.aliceNames].sort()
  const gotAlice = [...aliceNames].sort()
  if (reqAlice.join("|") !== gotAlice.join("|")) {
    errs.push(
      `alice mismatch — scenario expects [${req.aliceNames.join(", ")}] ` +
        `but ServiceCase declares [${aliceNames.join(", ")}]`
    )
  }
  const reqLeg = [...req.legNames].sort()
  const gotLeg = [...legNames].sort()
  if (reqLeg.join("|") !== gotLeg.join("|")) {
    errs.push(
      `leg mismatch — scenario expects [${req.legNames.join(", ")}] ` +
        `but ServiceCase declares [${legNames.join(", ")}]`
    )
  }
  if (errs.length > 0) {
    throw new Error(
      `Matrix incompatibility for scenario "${scenarioId}" × ServiceCase "${sc.id}":\n  - ${errs.join("\n  - ")}`
    )
  }
}
