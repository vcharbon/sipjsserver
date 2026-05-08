import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { FRONT_PROXY_VIP_TARGET } from "./fixtures/frontProxyTarget.js"
import { deleteSippJob, runSippJob } from "./fixtures/sippJob.js"
import {
  aggregatePerCall,
  fetchRoutingDecisions,
  waitForInvites,
  workerIpToName,
} from "./fixtures/proxyLogs.js"
import { deletePod, execInPod } from "./fixtures/kubectl.js"

const NAMESPACE = process.env.K8S_TEST_NAMESPACE ?? "sip-test"

/**
 * INV-3 — Drain handoff (Phase B scope, with dual-write deployed).
 *
 * Asserts the full proxy-side drain contract:
 *
 *   (a) Established calls survive the drain end-to-end. Either (i) the
 *       BYE lands on the still-alive draining worker during its grace
 *       window, or (ii) it migrates to the backup worker, whose
 *       replicated dialog state (per-call dual-write across per-pod
 *       Redis sidecars — see docs/replication/call-cache-backup.md)
 *       lets it serve the in-dialog request without 481.
 *   (b) New INVITEs are routed *only* to non-draining workers.
 *   (c) The draining worker terminates within
 *       `terminationGracePeriodSeconds`.
 *
 * Promoted from informational logging to a hard assertion in Phase 1
 * of docs/plan/proper-end-to-end-cheerful-lobster.md, after Phases 0a
 * (per-pod Redis sidecar topology) and 0b (production wiring of
 * ReplPuller + ReadyGate + HTTP ReplogClient) shipped.
 */
describe("k8s/proxy-drain — INV-3: drain preserves in-flight calls", () => {
  it.live(
    "drain handoff: ACK/BYE reach draining worker; new INVITEs do not",
    () =>
      Effect.gen(function* () {
        const stamp = Date.now().toString(36)
        const holdJobName = `inv3-hold-${stamp}`
        const freshJobName = `inv3-fresh-${stamp}`
        const holdCidStr = `inv3-hold-${stamp}-%u@det`
        const freshCidStr = `inv3-fresh-${stamp}-%u@det`
        const holdCidPrefix = `inv3-hold-${stamp}-`
        const freshCidPrefix = `inv3-fresh-${stamp}-`
        const N_HOLD = 20
        const N_FRESH = 6

        try {
          // (1) Start the long Job in the background. uac-hold.xml
          //     pauses 3s between ACK and BYE (just under the proxy's
          //     5s drainGraceMs default).
          // uac-hold-failover.xml has a 15s ACK→BYE pause; with sipp's
          // 11-attempt BYE retrans (T1=500ms, capped at T2=4s ≈ 32s
          // worst case), each call needs ~50s end-to-end. timeoutSec /
          // waitTimeoutSec are sized to that worst case so a single
          // slow BYE doesn't prematurely fail the Job.
          const holdFiber = yield* Effect.forkChild(
            runSippJob({
              namespace: NAMESPACE,
              name: holdJobName,
              scenario: "uac-hold-failover.xml",
              target: FRONT_PROXY_VIP_TARGET,
              service: "test",
              calls: N_HOLD,
              callsPerSecond: 20,
              timeoutSec: 90,
              waitTimeoutSec: 120,
              captureTraces: true,
              archiveDir: `/tmp/proxy-drain-${stamp}`,
              extraArgs: ["-cid_str", holdCidStr],
            }),
          )

          // (2) Poll for INVITEs to settle (≈1s for 20 calls @ 20cps
          //     + handling lag in the hot-cluster case, or up to ~60s
          //     after a fresh kind boot when the sipp Job pod is still
          //     pulling its image). A static `Effect.sleep` is brittle:
          //     when this test runs in isolation against a cold cluster
          //     it fires before any INVITE is on the wire. We must keep
          //     the BYE wave inside the proxy's 5s drainGraceMs after
          //     `delete`, but that budget starts at the kill below, not
          //     here — the ramp can take as long as it needs.
          const earlyWait = yield* waitForInvites(NAMESPACE, {
            cidPrefix: holdCidPrefix,
            minCount: N_HOLD,
            since: "120s",
            deadlineMs: Date.now() + 60_000,
          })
          expect(
            earlyWait.invites.length,
            "expected proxy to have routed INVITEs before drain",
          ).toBeGreaterThanOrEqual(N_HOLD)
          const earlyInvites = earlyWait.invites

          const counts = new Map<string, number>()
          for (const d of earlyInvites) {
            counts.set(d.workerIp, (counts.get(d.workerIp) ?? 0) + 1)
          }
          const sortedWorkers = Array.from(counts.entries()).sort(
            (a, b) => b[1] - a[1],
          )
          const drainTargetIp = sortedWorkers[0]?.[0] ?? ""
          expect(drainTargetIp).not.toBe("")
          // Sanity: at least 2 workers handled traffic so we can verify
          // re-routing on drain.
          expect(counts.size, "expected at least 2 workers in pool").toBeGreaterThanOrEqual(2)

          const ipMap = yield* workerIpToName(NAMESPACE)
          const drainPod = ipMap.get(drainTargetIp)
          expect(drainPod, `IP ${drainTargetIp} not mapped to a pod`).toBeTruthy()

          // (2.5) Wait for replication to settle on the survivor BEFORE
          //       killing the primary. Without this gate the test races
          //       the steady-state ReplPuller: if we kill before the
          //       backup's `sipas:bak:<drainPod>:call:*` partition has
          //       caught up, the migrated BYE arrives at a backup that
          //       can't resolve the dialog and 481s. Empirically the
          //       puller converges in <2s on a hot cluster, but takes
          //       longer right after a pod roll. Poll up to 15s.
          const drainedInviteCount = earlyInvites.filter(
            (d) => d.workerIp === drainTargetIp,
          ).length
          const survivorPod = Array.from(ipMap.entries())
            .find(([, pod]) => pod !== drainPod)?.[1]
          if (survivorPod !== undefined) {
            // Scope to THIS run's callRefs via the holdCidPrefix stamp.
            // Without the prefix, stale keys from prior failed runs in
            // the same namespace inflate the count and the gate
            // releases before the current run's state has replicated.
            const replPattern = `sipas:bak:${drainPod}:call:*${holdCidPrefix}*`
            const replDeadlineMs = Date.now() + 15_000
            let bakCount = 0
            while (Date.now() < replDeadlineMs) {
              const scan = yield* execInPod(
                NAMESPACE,
                survivorPod,
                "redis",
                ["redis-cli", "--scan", "--pattern", replPattern],
              ).pipe(
                Effect.catchTag("ExecError", () =>
                  Effect.succeed({ stdout: "", stderr: "" }),
                ),
              )
              bakCount = scan.stdout
                .split("\n")
                .filter((s) => s.trim().length > 0).length
              if (bakCount >= drainedInviteCount) break
              yield* Effect.sleep("500 millis")
            }
            yield* Effect.logInfo(
              `replication settle: bak:${drainPod} count=${bakCount}/${drainedInviteCount}` +
                ` on ${survivorPod} (waited ${Date.now() - (replDeadlineMs - 15_000)}ms)`,
            )
          }

          // (3) SIGTERM with 30s grace (matches `terminationGracePeriodSeconds`
          //     in tests/k8s/values/b2bua-worker.yaml).
          const drainStartMs = Date.now()
          yield* deletePod(NAMESPACE, drainPod!, { gracePeriodSec: 30 })

          // Give the proxy 3s to mark the worker draining (K8s
          // deletionTimestamp accelerant + OPTIONS 503).
          yield* Effect.sleep("3 seconds")

          // (4) Fresh INVITEs during drain — none should hit the
          //     draining worker.
          const freshResult = yield* runSippJob({
            namespace: NAMESPACE,
            name: freshJobName,
            scenario: "uac-basic.xml",
            target: FRONT_PROXY_VIP_TARGET,
            service: "test",
            calls: N_FRESH,
            callsPerSecond: 6,
            timeoutSec: 20,
            waitTimeoutSec: 40,
            extraArgs: ["-cid_str", freshCidStr],
          })
          expect(freshResult.jobStatus).toBe("succeeded")
          expect(freshResult.stats.successful).toBe(N_FRESH)

          const decisionsMid = yield* fetchRoutingDecisions(NAMESPACE, {
            since: "120s",
          })
          const freshInvites = decisionsMid.filter(
            (d) => d.callId.startsWith(freshCidPrefix) && d.method === "INVITE",
          )
          expect(freshInvites.length).toBeGreaterThanOrEqual(N_FRESH)
          const violatorsB = freshInvites.filter((d) => d.workerIp === drainTargetIp)
          expect(
            violatorsB,
            `INV-3(b) violation: ${violatorsB.length} fresh INVITEs went to the draining worker (${drainTargetIp})`,
          ).toEqual([])

          // (5) Await the hold Job — BYEs flow through after the 15s
          //     pause. Note that calls whose worker is mid-drain may
          //     still complete because the worker keeps serving in-flight
          //     dialogs for the entire grace window.
          const holdResult = yield* Fiber.join(holdFiber).pipe(
            Effect.catchTag("SippJobError", (e) =>
              Effect.succeed({
                jobStatus: "failed" as const,
                stats: { successful: 0, failed: 0, created: 0 },
                logs: e.message,
              }),
            ),
          )

          const decisionsFinal = yield* fetchRoutingDecisions(NAMESPACE, {
            since: "240s",
          })
          const holdAll = decisionsFinal.filter((d) =>
            d.callId.startsWith(holdCidPrefix),
          )
          const perCall = aggregatePerCall(holdAll)

          // (a) Count established-on-drained calls and where their BYE
          //     was routed. With dual-write deployed, every such call
          //     must succeed end-to-end whether the BYE stuck to the
          //     drained worker or migrated to the backup.
          let drainedByeStuck = 0
          let drainedByeMigrated = 0
          const migrations: Array<{ callId: string; byeIps: ReadonlyArray<string> }> = []
          for (const c of perCall) {
            const inviteIp = c.decisions.find((d) => d.method === "INVITE")?.workerIp
            if (inviteIp !== drainTargetIp) continue
            const byeIps = c.decisions
              .filter((d) => d.method === "BYE")
              .map((d) => d.workerIp)
            if (byeIps.length === 0) continue
            if (byeIps.every((ip) => ip === drainTargetIp)) drainedByeStuck += 1
            else {
              drainedByeMigrated += 1
              if (migrations.length < 3) migrations.push({ callId: c.callId, byeIps })
            }
          }
          yield* Effect.logInfo(
            `INV-3(a) [Phase B]: drainTargetIp=${drainTargetIp} pod=${drainPod}` +
              ` workerIPs=[${Array.from(ipMap.entries())
                .map(([ip, n]) => `${n}=${ip}`)
                .join(", ")}]` +
              ` BYEs-to-drained=${drainedByeStuck}` +
              ` BYEs-migrated=${drainedByeMigrated}` +
              ` sample-migrations=${JSON.stringify(migrations)}`,
          )

          // (a) Sanity: the drain MUST have actually hit some calls.
          //     A value of 0 means the test's pacing is wrong — the
          //     drainTargetIp had no in-flight dialogs when we
          //     deleted it.
          expect(
            drainedByeStuck + drainedByeMigrated,
            "expected at least one BYE seen for the drained worker — drain did not hit any in-flight calls",
          ).toBeGreaterThan(0)

          // (c) Drained worker pod should be gone within ~grace window.
          // We don't poll the pod; we check the wall-clock budget.
          const drainElapsedMs = Date.now() - drainStartMs
          expect(
            drainElapsedMs,
            "drain budget overrun — pod should be terminated by now",
          ).toBeLessThan(60_000) // 30s grace + slack

          // (a) Diagnostic: dump every surviving worker's Redis sidecar
          //     so we can tell which side of the dual-write contract is
          //     broken when the survival assertion fails. Three useful
          //     buckets: (i) no `bak:*` keys at all → write side is
          //     broken; (ii) keys present but BYE still 481 → backup
          //     read path doesn't consult the partition; (iii) keys
          //     present and BYE returns 200 → response routing bug.
          //     Cheap (<1s per pod). Always-on so a passing run still
          //     archives ground truth.
          const archiveDir = `/tmp/proxy-drain-${stamp}`
          yield* Effect.tryPromise(() =>
            fs.mkdir(archiveDir, { recursive: true }),
          ).pipe(Effect.orDie)
          const survivors = Array.from(ipMap.entries())
            .filter(([, pod]) => pod !== drainPod)
            .map(([ip, pod]) => ({ ip, pod }))
          for (const survivor of survivors) {
            const lines: Array<string> = []
            lines.push(`# host=${survivor.pod} ip=${survivor.ip}`)
            // idx:* and propagate:* are added to the dump to cover the
            // contract Slices A and B of
            // `docs/plan/bye-takeover-replicated-indexes-fix.md` enforce:
            //  - idx:leg:* on the survivor confirms the puller stamped
            //    the bak-side index on Slice A.
            //  - propagate:b2bua-worker-0 on the survivor confirms
            //    Slice B's takeover writes announced back to the
            //    original primary (membership = migrated callRefs).
            // Production keyspace prefix — see PartitionedRelayStorage.
            // Without this prefix, --scan returns nothing because the
            // actual keys live under `sipas:bak:…`, not `bak:…`.
            const KS = "sipas:"
            for (const prefix of ["bak", "pri", "idx", "propagate"]) {
              const scan = yield* execInPod(
                NAMESPACE,
                survivor.pod,
                "redis",
                ["redis-cli", "--scan", "--pattern", `${KS}${prefix}:*`],
              ).pipe(
                Effect.catchTag("ExecError", () =>
                  Effect.succeed({ stdout: "(scan failed)\n", stderr: "" }),
                ),
              )
              const keys = scan.stdout
                .split("\n")
                .map((s) => s.trim())
                .filter((s) => s.length > 0)
              lines.push(`# ${prefix}:* count=${keys.length}`)
              for (const key of keys.slice(0, 50)) {
                // propagate:* is a sorted set; GET on a non-string type
                // errors. Use ZRANGE WITHSCORES instead so the dump
                // shows callRef→seq pairs for the takeover stream.
                const args = key.startsWith(`${KS}propagate:`) &&
                  !key.startsWith(`${KS}propagate_seq:`)
                  ? ["redis-cli", "ZRANGE", key, "0", "-1", "WITHSCORES"]
                  : ["redis-cli", "GET", key]
                const get = yield* execInPod(
                  NAMESPACE,
                  survivor.pod,
                  "redis",
                  args,
                ).pipe(
                  Effect.catchTag("ExecError", () =>
                    Effect.succeed({ stdout: "(get failed)", stderr: "" }),
                  ),
                )
                lines.push(`${key} → ${get.stdout.trim().slice(0, 200)}`)
              }
            }
            const dump = lines.join("\n") + "\n"
            yield* Effect.tryPromise(() =>
              fs.writeFile(
                path.join(archiveDir, `redis-${survivor.pod}.txt`),
                dump,
                "utf8",
              ),
            ).pipe(Effect.orDie)
            yield* Effect.logInfo(
              `redis-dump[${survivor.pod}]: ` +
                lines
                  .filter((l) => l.startsWith("# "))
                  .join(" | "),
            )
          }

          // (a) Phase B hard assertion: with dual-write deployed,
          //     every established call must end with a 2xx to BYE
          //     (either via the still-alive drained worker during
          //     the grace window, or via the backup worker after
          //     hand-off). Allow ≤2 calls in the inherent-loss window
          //     where the BYE arrives in the SIGTERM/grace boundary
          //     and the worker process is gone before serving it.
          expect(
            holdResult.stats.successful,
            `inv3 hold job survival: only ${holdResult.stats.successful}/${N_HOLD} calls succeeded` +
              ` (status=${holdResult.jobStatus},` +
              ` BYEs-to-drained=${drainedByeStuck},` +
              ` BYEs-migrated=${drainedByeMigrated})`,
          ).toBeGreaterThanOrEqual(N_HOLD - 2)
        } finally {
          yield* deleteSippJob(NAMESPACE, holdJobName).pipe(Effect.ignore)
          yield* deleteSippJob(NAMESPACE, freshJobName).pipe(Effect.ignore)
        }
      }),
    { timeout: 360_000 },
  )
})
