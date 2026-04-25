/**
 * DutTransport — pluggable transport between scenario agents and the
 * Device Under Test (DUT, the B2BUA).
 *
 * Two implementations:
 *   - simulated: in-process B2BUA + in-memory SignalingNetwork (TestClock-friendly)
 *   - udp:      external B2BUA reachable over real UDP (real clock)
 *
 * Per Q1: external UDP only (+ in-process simulated for self-tests).
 * Per Q14: DUT lifecycle = pre-provisioned, harness calls reset() between tests.
 */

import type { Effect, Layer, Scope } from "effect"

/** Address pair used to send to / bind on a UDP-style endpoint. */
export interface Endpoint {
  readonly host: string
  readonly port: number
}

/** Per-agent bind info returned by `setup`. */
export interface AgentBind extends Endpoint {
  /** SIP contact URI for this agent (e.g. sip:alice@10.0.0.1:5060). */
  readonly contact: string
  /** Logical SIP URI (the agent's identity). */
  readonly uri: string
}

/** Packet observed at an agent's endpoint. */
export interface DutPacket {
  readonly raw: Buffer
  readonly from: Endpoint
  /** Virtual or wall-clock arrival timestamp. */
  readonly arrivalMs: number
}

/** Agent-config subset needed at setup time. */
export interface DutAgentConfig {
  readonly uri: string
  /** Bind port (UDP only — simulated may pick freely). */
  readonly port?: number
  /** Bind IP (simulated supports per-agent fake IPs; UDP defaults to loopback). */
  readonly ip?: string
}

/** Optional readiness contract for external DUTs. */
export interface DutHandle {
  /**
   * Reset the DUT to a clean state between tests (drop calls, reset
   * limiters, clear caches). Implementations either call an admin
   * endpoint, restart a fresh process, or signal in-process layers.
   */
  reset(): Effect.Effect<void>
}

export interface DutTransport {
  /** Address of the DUT's SIP listening port. */
  readonly dutEndpoint: Endpoint
  /**
   * Optional layer applied around the whole scenario (in-process DUT only).
   * Used by the simulated transport so agents and B2BUA share the same
   * SignalingNetwork instance.
   */
  readonly stackLayer?: Layer.Layer<never>
  /** Bind the agents and start the DUT. Scoped: cleanup happens automatically. */
  setup(
    agents: Readonly<Record<string, DutAgentConfig>>
  ): Effect.Effect<Record<string, AgentBind>, Error, Scope.Scope>
  /** Send a buffer from `agentName` to `dst`. */
  send(agentName: string, buf: Buffer, dst: Endpoint): Effect.Effect<void, Error>
  /** Wait up to `timeoutMs` for the next inbound packet for `agentName`. */
  receive(
    agentName: string,
    timeoutMs: number
  ): Effect.Effect<DutPacket | null, Error>
  /**
   * Optional clean-state check after a scenario finishes. Returns error
   * strings (empty = clean). Only meaningful for in-process DUTs.
   */
  verifyCleanState?(): Effect.Effect<ReadonlyArray<string>>
  /** Allow forked fibers (auto-ACK, retransmits) to drain before unexpected sweep. */
  settle?(): Effect.Effect<void>
  /** Simulated propagation delay; used to derive sender/receiver timestamps. */
  readonly networkDelayMs?: number
}
