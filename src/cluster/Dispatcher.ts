/**
 * Dispatcher — main process cluster coordinator.
 *
 * Owns the UDP socket, extracts Call-ID from raw packets, hashes to
 * determine the target worker, and forwards via IPC. Receives serialized
 * outbound buffers from workers and sends them out the UDP socket.
 *
 * Also manages worker lifecycle: spawn, respawn on crash, graceful shutdown.
 *
 * Overload protection (Tier 2 — class-based bounded per-worker queues):
 *   Each packet is classified into one of three classes by a byte-scan
 *   (no SIP parse): `emergency`, `inDialog`, `normalNewCall`. The dispatcher
 *   keeps three bounded queues per worker and drains them in strict priority
 *   order on every enqueue. Drop policies:
 *     - emergency full → drop oldest (page on first drop)
 *     - inDialog full  → drop oldest, mark worker overloaded, start kill timer
 *     - normalNewCall full → drop newest + send dispatcher-side stateless 503
 *
 *   When inDialog has been full for `workerInDialogFullKillAfterMs`, the
 *   worker is SIGTERM'd; cluster respawns it.
 */

import { fork, type ChildProcess } from "node:child_process"
import * as dgram from "node:dgram"
import { fileURLToPath } from "node:url"
import { Effect, Layer, Queue, Cause, ServiceMap, Stream } from "effect"
import { extractCallIdFromBuffer, workerIndexForCallId } from "./HashUtils.js"
import type {
  MainToWorkerMessage,
  WorkerToMainMessage,
} from "./IpcProtocol.js"
import { AppConfig } from "../config/AppConfig.js"
import { MetricsRegistry, type DispatcherMetrics } from "../observability/MetricsRegistry.js"
import {
  buildStatelessReject503Buffer,
  bufferHasEmergencyMarker,
  bufferHasToTag,
  isInviteRequestBuffer,
  jitteredRetryAfter,
} from "../sip/MessageFactory.js"

// ---------------------------------------------------------------------------
// Worker entry point path (resolved at import time)
// ---------------------------------------------------------------------------

const WORKER_ENTRY = fileURLToPath(new URL("./WorkerEntry.js", import.meta.url))

// ---------------------------------------------------------------------------
// Packet classification
// ---------------------------------------------------------------------------

type PacketClass = "emergency" | "inDialog" | "normalNewCall"

function classifyPacket(raw: Buffer): PacketClass {
  if (bufferHasEmergencyMarker(raw)) return "emergency"
  if (isInviteRequestBuffer(raw)) {
    return bufferHasToTag(raw) ? "inDialog" : "normalNewCall"
  }
  return "inDialog"
}

interface QueuedPacket {
  readonly raw: Buffer
  readonly address: string
  readonly port: number
}

interface WorkerQueues {
  emergency: QueuedPacket[]
  inDialog: QueuedPacket[]
  normalNewCall: QueuedPacket[]
  inDialogFullSinceMs: number | undefined
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class Dispatcher extends ServiceMap.Service<
  Dispatcher,
  {
    /** Start the dispatcher — binds UDP, spawns workers, blocks forever. */
    readonly start: () => Effect.Effect<never>
  }
>()("@sipjsserver/Dispatcher") {
  static readonly layer = Layer.effect(
    Dispatcher,
    Effect.gen(function* () {
      const config = yield* AppConfig
      const registry = yield* MetricsRegistry
      const totalWorkers = config.clusterWorkers
      const emergencyMax = config.workerQueueEmergencyMax
      const inDialogMax = config.workerQueueInDialogMax
      const newCallMax = config.workerQueueNewCallMax
      const killAfterMs = config.workerInDialogFullKillAfterMs
      const retryAfterBase = config.retryAfterBaseSec
      const retryAfterJitter = config.retryAfterJitterSec

      const metrics: DispatcherMetrics = {
        queueDepth: { emergency: 0, inDialog: 0, normalNewCall: 0 },
        queueDrops: { emergency: 0, inDialog: 0, normalNewCall: 0 },
        dispatcher503Sent: 0,
        workerKills: 0,
        dispatchedTotal: 0,
        droppedNoCallIdTotal: 0,
      }
      registry.dispatcher = metrics
      registry.workers = new Array(totalWorkers)

      const startScoped = Effect.fn("Dispatcher.startScoped")(function* () {
        process.title = "sipb2bua-dispatcher"
        yield* Effect.logInfo(`Cluster mode: starting ${totalWorkers} workers`)

        // ── Bind UDP socket ──────────────────────────────────────────
        const socket = yield* Effect.acquireRelease(
          Effect.callback<dgram.Socket>((resume) => {
            const sock = dgram.createSocket("udp4")
            sock.once("listening", () => resume(Effect.succeed(sock)))
            sock.once("error", (err) => resume(Effect.die(err)))
            sock.bind(config.sipLocalPort)
          }),
          (sock) =>
            Effect.callback<void>((resume) => {
              sock.close(() => resume(Effect.void))
            })
        )

        yield* Effect.logInfo(`UDP socket listening on port ${config.sipLocalPort} (dispatcher)`)

        // ── Spawn workers ────────────────────────────────────────────
        const workers: ChildProcess[] = new Array(totalWorkers)
        const queues: WorkerQueues[] = new Array(totalWorkers)
        for (let i = 0; i < totalWorkers; i++) {
          queues[i] = {
            emergency: [],
            inDialog: [],
            normalNewCall: [],
            inDialogFullSinceMs: undefined,
          }
        }
        const workerReady: Array<Promise<void>> = []

        const updateDepthMetrics = (): void => {
          let e = 0, d = 0, n = 0
          for (const q of queues) {
            e += q.emergency.length
            d += q.inDialog.length
            n += q.normalNewCall.length
          }
          metrics.queueDepth.emergency = e
          metrics.queueDepth.inDialog = d
          metrics.queueDepth.normalNewCall = n
        }

        const sendStatelessReject = (raw: Buffer, address: string, port: number): void => {
          const respBuf = buildStatelessReject503Buffer(
            raw,
            jitteredRetryAfter(retryAfterBase, retryAfterJitter)
          )
          if (respBuf === null) return
          socket.send(respBuf, 0, respBuf.length, port, address, () => {})
          metrics.dispatcher503Sent++
        }

        const drainWorker = (idx: number): void => {
          const worker = workers[idx]
          if (worker === undefined || !worker.connected) return
          const q = queues[idx]!
          // Strict priority: emergency → inDialog → normalNewCall
          for (const queueArr of [q.emergency, q.inDialog, q.normalNewCall]) {
            while (queueArr.length > 0) {
              const pkt = queueArr.shift()!
              const msg: MainToWorkerMessage = {
                type: "packet",
                raw: pkt.raw.toString("base64"),
                address: pkt.address,
                port: pkt.port,
              }
              worker.send(msg)
            }
          }
        }

        const enqueueOrDrop = (
          idx: number,
          cls: PacketClass,
          pkt: QueuedPacket
        ): void => {
          const q = queues[idx]!
          if (cls === "emergency") {
            if (q.emergency.length >= emergencyMax) {
              q.emergency.shift() // drop oldest
              metrics.queueDrops.emergency++
              if (metrics.queueDrops.emergency === 1) {
                console.error(`[dispatcher] EMERGENCY queue full on worker ${idx} — dropping oldest (page!)`)
              }
            }
            q.emergency.push(pkt)
            return
          }
          if (cls === "inDialog") {
            if (q.inDialog.length >= inDialogMax) {
              q.inDialog.shift()
              metrics.queueDrops.inDialog++
              if (q.inDialogFullSinceMs === undefined) {
                q.inDialogFullSinceMs = Date.now()
                console.error(`[dispatcher] inDialog queue full on worker ${idx} — entering shed-all-new mode`)
              }
            } else {
              // Recovered
              q.inDialogFullSinceMs = undefined
            }
            q.inDialog.push(pkt)
            return
          }
          // normalNewCall
          // If worker is in inDialog-overloaded mode, dispatcher pre-emptively 503s.
          if (q.inDialogFullSinceMs !== undefined) {
            sendStatelessReject(pkt.raw, pkt.address, pkt.port)
            metrics.queueDrops.normalNewCall++
            return
          }
          if (q.normalNewCall.length >= newCallMax) {
            metrics.queueDrops.normalNewCall++
            sendStatelessReject(pkt.raw, pkt.address, pkt.port)
            return // drop newest
          }
          q.normalNewCall.push(pkt)
        }

        const maxHeapMb = Number(process.env.WORKER_MAX_HEAP_MB ?? "600")
        const extraExecArgv = [
          `--max-old-space-size=${maxHeapMb}`,
          ...(process.env.B2BUA_EXPOSE_GC === "1" ? ["--expose-gc"] : []),
        ]
        // Prepend our flags to the parent's execArgv so tsx/ESM loaders are preserved in dev mode
        const workerExecArgv = [...extraExecArgv, ...process.execArgv]

        const spawnWorker = (index: number): ChildProcess => {
          const child = fork(WORKER_ENTRY, [], {
            execArgv: workerExecArgv,
            env: {
              ...process.env,
              WORKER_INDEX: String(index),
              TOTAL_WORKERS: String(totalWorkers)
            },
            serialization: "json",
            stdio: ["inherit", "inherit", "inherit", "ipc"]
          })

          child.on("message", (msg: WorkerToMainMessage) => {
            if (msg.type === "send") {
              const buf = Buffer.from(msg.raw, "base64")
              socket.send(buf, 0, buf.length, msg.port, msg.address)
            } else if (msg.type === "metrics") {
              registry.workers[index] = msg.data
            }
          })

          child.on("exit", (code, signal) => {
            const reason = signal ? `signal ${signal}` : `code ${code}`
            console.error(`[dispatcher] Worker ${index} exited (${reason}) — respawning`)
            // Reset class queues for the respawned worker
            queues[index] = {
              emergency: [],
              inDialog: [],
              normalNewCall: [],
              inDialogFullSinceMs: undefined,
            }
            workers[index] = spawnWorker(index)
          })

          workers[index] = child
          return child
        }

        for (let i = 0; i < totalWorkers; i++) {
          const child = spawnWorker(i)
          workerReady.push(
            new Promise<void>((resolve) => {
              const onMsg = (msg: WorkerToMainMessage) => {
                if (msg.type === "ready") {
                  child.removeListener("message", onMsg)
                  resolve()
                }
              }
              child.on("message", onMsg)
            })
          )
        }

        // Wait for all workers to signal ready
        yield* Effect.promise(() => Promise.all(workerReady))
        yield* Effect.logInfo(`All ${totalWorkers} workers ready`)

        // Expose broadcast so StatusServer can relay debug commands to workers
        registry.broadcastToWorkers = (msg) => {
          for (const w of workers) {
            if (w && w.connected) {
              try { w.send(msg) } catch { /* channel closed */ }
            }
          }
        }

        // ── Escalation ladder: kill workers stuck inDialog-full ──────
        const escalationInterval = setInterval(() => {
          const now = Date.now()
          for (let i = 0; i < totalWorkers; i++) {
            const q = queues[i]!
            if (q.inDialogFullSinceMs === undefined) continue
            if (now - q.inDialogFullSinceMs >= killAfterMs) {
              const w = workers[i]
              if (w !== undefined && w.connected) {
                console.error(`[dispatcher] Worker ${i} stuck inDialog-full for >${killAfterMs}ms — SIGTERM`)
                metrics.workerKills++
                w.kill("SIGTERM")
              }
            }
          }
          updateDepthMetrics()
        }, 1000)
        escalationInterval.unref()
        yield* Effect.addFinalizer(() => Effect.sync(() => clearInterval(escalationInterval)))

        // ── Packet dispatch loop ─────────────────────────────────────
        const packetQueue = yield* Queue.unbounded<{ raw: Buffer; address: string; port: number }, Cause.Done>()

        yield* Effect.acquireRelease(
          Effect.sync(() => {
            socket.on("message", (msg: Buffer, rinfo: dgram.RemoteInfo) => {
              Queue.offerUnsafe(packetQueue, {
                raw: msg,
                address: rinfo.address,
                port: rinfo.port
              })
            })
          }),
          () => Effect.sync(() => Queue.endUnsafe(packetQueue))
        )

        // Counters promoted into DispatcherMetrics for Prometheus export.
        // Local aliases for readability in the hot path.

        // Stream.runForEach blocks until the stream ends (which it won't — unbounded queue)
        yield* Stream.runForEach(
          Stream.fromQueue(packetQueue),
          (pkt) =>
            Effect.sync(() => {
              const callId = extractCallIdFromBuffer(pkt.raw)
              if (callId === undefined) {
                metrics.droppedNoCallIdTotal++
                if (metrics.droppedNoCallIdTotal % 100 === 1) {
                  console.error(`[dispatcher] Dropped packet — no Call-ID (total dropped: ${metrics.droppedNoCallIdTotal})`)
                }
                return
              }

              const workerIdx = workerIndexForCallId(callId, totalWorkers)
              const worker = workers[workerIdx]

              if (worker === undefined || !worker.connected) {
                // Worker not yet ready after respawn — drop (SIP retransmit will recover)
                return
              }

              const cls = classifyPacket(pkt.raw)
              enqueueOrDrop(workerIdx, cls, pkt)
              drainWorker(workerIdx)
              metrics.dispatchedTotal++

              if (metrics.dispatchedTotal % 10000 === 0) {
                updateDepthMetrics()
                console.log(`[dispatcher] Dispatched ${metrics.dispatchedTotal} packets`)
              }
            })
        )

        // Stream never ends, but TypeScript needs a return for `never`
        return yield* Effect.never
      })

      const start = Effect.fn("Dispatcher.start")(function* () {
        return yield* Effect.scoped(startScoped())
      })

      return { start }
    })
  )
}
