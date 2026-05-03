/**
 * Recorder — captures DSL calls into a Step[] AST.
 *
 * When a scenario function runs, the recorder proxies all agent method
 * calls (send, expect, invite, ack, bye, cancel) into Step nodes.
 * No SIP messages are sent during recording.
 */

import type { SipMessage } from "../../sip/types.js"
import type {
  AgentConfig,
  AllowedExtraPattern,
  ExpectRef,
  HeaderOverrides,
  K8sKillPhase,
  K8sKillTiming,
  K8sPartitionDirection,
  K8sRoutingDecisionKind,
  K8sStep,
  K8sStepAction,
  MessageContext,
  SendStep,
  ExpectStep,
  Step,
  StepRef,
} from "./types.js"
import type { ValidationCheckName, ValidationOverrides } from "./validation.js"
import { makeStepRef } from "./types.js"
import { defined } from "./utils.js"

// ---------------------------------------------------------------------------
// Option types (shared across interfaces)
// ---------------------------------------------------------------------------

export interface SendOpts {
  readonly uri?: string
  readonly delay?: number
  readonly overrides?: HeaderOverrides
  readonly build?: (ctx: MessageContext) => HeaderOverrides
  readonly body?: Uint8Array
  readonly skipValidation?: ValidationCheckName[]
}

export interface ExpectOpts {
  readonly timeout?: number
  readonly predicate?: (msg: SipMessage, ctx: MessageContext) => boolean
  readonly allowReemission?: boolean
  readonly skipValidation?: ValidationCheckName[]
  readonly validation?: ValidationOverrides
}

export interface ReplyOpts {
  readonly reason?: string
  readonly delay?: number
  readonly overrides?: HeaderOverrides
  readonly build?: (ctx: MessageContext) => HeaderOverrides
  readonly body?: Uint8Array
  readonly skipValidation?: ValidationCheckName[]
}

// ---------------------------------------------------------------------------
// Dialog & Transaction types
// ---------------------------------------------------------------------------

/** UAC INVITE transaction (caller side). */
export interface UacInviteTransaction {
  /** Expect a provisional or final response to this INVITE. */
  expect(statusCode: number, opts?: ExpectOpts): ExpectRef
  /** Send CANCEL for this INVITE, returns the CANCEL's own UAC transaction. */
  cancel(opts?: SendOpts): UacTransaction
}

/** UAS INVITE transaction (callee side — reply to received INVITE). */
export interface UasInviteTransaction {
  /** Send a provisional or final response to the received INVITE. */
  reply(statusCode: number, opts?: ReplyOpts): StepRef
  /**
   * Expect a CANCEL for this INVITE (RFC 3261 §9). The CANCEL travels in a
   * separate client transaction but is tied to this INVITE server transaction
   * (same branch). Returns a UAS transaction so the callee can reply 200 OK.
   */
  expectCancel(opts?: ExpectOpts): UasTransaction
  /**
   * Expect the auto-ACK that the INVITE client (here the B2BUA) sends after
   * a non-2xx final response on this INVITE's transaction (RFC 3261 §17.1.1.3).
   * No reply is expected — the ACK completes the INVITE server transaction.
   */
  expectAck(opts?: ExpectOpts): ExpectRef
}

/** Generic UAC transaction (for BYE, PRACK, re-INVITE, CANCEL, etc.). */
export interface UacTransaction {
  /** Expect a response to this request. */
  expect(statusCode: number, opts?: ExpectOpts): ExpectRef
}

/** Generic UAS transaction (received in-dialog request). */
export interface UasTransaction {
  /** Send a response to the received request. */
  reply(statusCode: number, opts?: ReplyOpts): StepRef
}

/** Dialog handle for in-dialog operations. */
export interface DialogRef {
  /** Send ACK (for 2xx of INVITE). */
  ack(opts?: SendOpts): StepRef
  /** Send BYE, returns the BYE's UAC transaction. */
  bye(opts?: SendOpts): UacTransaction
  /** Send an arbitrary in-dialog request (re-INVITE, PRACK, INFO, etc.). */
  send(method: string, opts?: SendOpts): UacTransaction
  /** Expect an in-dialog request from the remote side. */
  expect(method: string, opts?: ExpectOpts): UasTransaction
}

/** Result of sending an initial INVITE. */
export interface InviteResult {
  readonly dialog: DialogRef
  readonly transaction: UacInviteTransaction
}

/** Result of receiving an initial INVITE. */
export interface ReceiveInviteResult {
  readonly dialog: DialogRef
  readonly transaction: UasInviteTransaction
}

// ---------------------------------------------------------------------------
// Agent proxy (returned by s.agent())
// ---------------------------------------------------------------------------

/** Options accepted by `agent.register(...)`. */
export interface RegisterOpts {
  /**
   * Request-URI for the REGISTER. RFC 3261 §10.2 says the registrar's
   * address (no userpart, e.g. `sip:registrar.example`). Defaults to
   * `sip:<registrar-host>` resolved at execute time from the agent's
   * configured remote (the SUT target).
   */
  readonly uri?: string
  /**
   * `Expires` header value in seconds. When omitted no `Expires` header
   * is added — the registrar applies its default (3600s in slice 2's
   * registrar). Pass `0` for the single-Contact de-registration shape
   * the slice 2 registrar accepts.
   */
  readonly expires?: number
  readonly delay?: number
  readonly overrides?: HeaderOverrides
  readonly build?: (ctx: MessageContext) => HeaderOverrides
  readonly skipValidation?: ValidationCheckName[]
}

export interface AgentProxy {
  readonly name: string

  // --- High-level dialog/transaction API ---

  /** Send an initial INVITE. Returns both a dialog handle and a UAC INVITE transaction. */
  invite(
    uri: string,
    opts?: {
      headers?: Record<string, string>
      body?: Uint8Array
      build?: (ctx: MessageContext) => HeaderOverrides
      skipValidation?: ValidationCheckName[]
    }
  ): InviteResult

  /** Expect an initial INVITE. Returns both a dialog handle and a UAS INVITE transaction. */
  receiveInitialInvite(opts?: ExpectOpts): ReceiveInviteResult

  /**
   * Send a REGISTER (RFC 3261 §10). Returns a UAC transaction so the
   * test can `.expect(200)` (or any other status) and chain assertions.
   *
   * The framework defaults the To header to the agent's own AOR
   * (`<${agentConfig.uri}>`) — the conventional shape for self-
   * registration, where the AOR being registered is the agent itself.
   * Override `opts.overrides.to` to register a different AOR.
   */
  register(opts?: RegisterOpts): UacTransaction

  /** Access the current dialog (for composed sequences via andThen). */
  readonly dialog: DialogRef

  /** Pre-register a message type as allowed without requiring a prior match.
   *  Messages matching this pattern are silently ignored during expect steps and drain. */
  allowExtra(methodOrStatusCode: string | number): void
}

// ---------------------------------------------------------------------------
// Internal step-emitter signatures (used by dialog / transaction wrappers)
// ---------------------------------------------------------------------------

interface InternalSendOpts {
  readonly inResponseTo?: StepRef
  readonly uri?: string
  readonly reason?: string
  readonly delay?: number
  readonly overrides?: HeaderOverrides
  readonly build?: (ctx: MessageContext) => HeaderOverrides
  readonly body?: Uint8Array
  readonly skipValidation?: ValidationCheckName[]
}

type InternalSend = (methodOrStatusCode: string | number, opts?: InternalSendOpts) => StepRef
type InternalExpect = (methodOrStatusCode: string | number, opts?: ExpectOpts) => ExpectRef

// ---------------------------------------------------------------------------
// Scenario context (the `s` parameter in scenario builders)
// ---------------------------------------------------------------------------

/**
 * Cluster control / assertion surface — slice 3b of the k8s reliability
 * rework. Methods record `K8sStep` entries the interpreter dispatches
 * against a `SimulatedK8sCluster` provided by the `k8sFailover` SUT
 * layer. On non-k8s SUTs the interpreter records each step as `skip`
 * with a clear note (so a scenario authored against the failover
 * harness fails loudly only when actively run on a non-k8s SUT).
 */
export interface ClusterContext {
  /** Tear down a worker through the multi-phase pipeline. */
  kill(workerId: string, timing?: K8sKillTiming): void
  /**
   * Bring a worker back. Stub for slice 3b — interpreter records skip.
   *
   * `preserveStorage: true` models §11.1 of
   * `docs/replication/call-cache-backup.md` (process restart with
   * sidecar persisting). Default models §11.2 (full pod replace,
   * sidecar wiped).
   */
  respawn(workerId: string, opts?: { preserveStorage?: boolean }): void
  /** Flip the worker's outbound network gate off (registry untouched). */
  disconnect(workerId: string): void
  /** Restore the worker's outbound network gate. */
  reconnect(workerId: string): void
  /** Asymmetric or bidirectional partition between two workers. */
  partition(opts: {
    from: string
    to: string
    direction: K8sPartitionDirection
  }): void
  /** Heal any prior partition between the two workers. */
  heal(a: string, b: string): void
  /** Assert the call's `bak:{primary}:` partition entry exists on `workerId`. */
  expectReplicatedTo(
    workerId: string,
    opts: { primary: string; callRef?: string }
  ): void
  /** Assert (or refute) the call's presence in the named partition. */
  expectCallStateOn(
    workerId: string,
    opts: {
      partition: "pri" | "bak"
      owner: string
      callRef?: string
      present?: boolean
    }
  ): void
  /** Assert a recorded kill phase fired (optionally within a virtual-time window). */
  expectKillPhase(
    workerId: string,
    phase: K8sKillPhase,
    opts?: { minAtMs?: number; maxAtMs?: number }
  ): void
  /**
   * Assert that since the previous baseline (auto-snapshotted at
   * scenario start, refreshed after each `expectRoutedTo` call) the
   * proxy recorded at least `minCount` (default 1) routing decisions
   * of the given `decision` kind. Currently only verifies the global
   * counter delta — the per-worker filter is best-effort: when the
   * decision is `decode_forward_backup`, any matching delta proves
   * that the proxy promoted to backup, which is the failover signal
   * the matrix tests assert on.
   */
  expectRoutedTo(
    workerId: string,
    opts: { decision: K8sRoutingDecisionKind; minCount?: number }
  ): void
}

export interface ScenarioContext {
  agent(name: string, config: AgentConfig): AgentProxy
  pause(durationMs: number): void
  contactOf(agentName: string): string
  /** Slice 3b: cluster lifecycle + assertion surface. */
  readonly cluster: ClusterContext
}

// ---------------------------------------------------------------------------
// Recording session
// ---------------------------------------------------------------------------

export interface RecordingResult {
  readonly agents: Record<string, AgentConfig>
  readonly steps: readonly Step[]
  readonly hasBuildCallbacks: boolean
  readonly allowedExtras: readonly AllowedExtraPattern[]
}


export function record(
  builder: (s: ScenarioContext) => void
): RecordingResult {
  // Don't reset step ref IDs — composed sequences need unique IDs across all fragments
  const agents: Record<string, AgentConfig> = {}
  const steps: Step[] = []
  const allowedExtras: AllowedExtraPattern[] = []
  let hasBuildCallbacks = false

  function makeAgentProxy(agentName: string): AgentProxy {
    // --- Core step emitters (low-level) ---

    const send: InternalSend = (methodOrStatusCode, opts) => {
      const ref = makeStepRef()
      const isResponse = typeof methodOrStatusCode === "number"

      if (opts?.build) hasBuildCallbacks = true

      const step = defined({
        type: "send" as const,
        agent: agentName,
        ref,
        method: isResponse ? undefined : methodOrStatusCode,
        statusCode: isResponse ? methodOrStatusCode : undefined,
        reason: opts?.reason,
        uri: opts?.uri,
        inResponseTo: opts?.inResponseTo,
        delay: opts?.delay,
        overrides: opts?.overrides
          ? (opts.body && opts.overrides.body === undefined
              ? { ...opts.overrides, body: opts.body }
              : opts.overrides)
          : (opts?.body ? { body: opts.body } : undefined),
        build: opts?.build,
        skipValidation: opts?.skipValidation,
      }) as SendStep
      steps.push(step)
      return ref
    }

    const expect: InternalExpect = (methodOrStatusCode, opts) => {
      const ref = makeStepRef()
      const isResponse = typeof methodOrStatusCode === "number"

      const step = defined({
        type: "expect" as const,
        agent: agentName,
        match: defined({
          method: isResponse ? undefined : methodOrStatusCode,
          statusCode: isResponse ? methodOrStatusCode : undefined,
          predicate: opts?.predicate,
        }),
        timeout: opts?.timeout,
        allowReemission: opts?.allowReemission,
        skipValidation: opts?.skipValidation,
        validation: opts?.validation,
        ref,
      }) as ExpectStep
      steps.push(step)

      const expectRef: ExpectRef = {
        ...ref,
        reply(statusCode, replyOpts) {
          const sendOpts: Record<string, unknown> = { inResponseTo: ref }
          if (replyOpts?.reason !== undefined) sendOpts.reason = replyOpts.reason
          if (replyOpts?.delay !== undefined) sendOpts.delay = replyOpts.delay
          if (replyOpts?.build !== undefined) sendOpts.build = replyOpts.build
          if (replyOpts?.overrides !== undefined) sendOpts.overrides = replyOpts.overrides
          if (replyOpts?.body !== undefined) sendOpts.body = replyOpts.body
          if ((replyOpts as ReplyOpts | undefined)?.skipValidation !== undefined) {
            sendOpts.skipValidation = (replyOpts as ReplyOpts).skipValidation
          }
          return send(statusCode, sendOpts as InternalSendOpts)
        },
      }
      return expectRef
    }

    const allowExtra: AgentProxy["allowExtra"] = (methodOrStatusCode) => {
      const isResponse = typeof methodOrStatusCode === "number"
      allowedExtras.push({
        agent: agentName,
        method: isResponse ? undefined : methodOrStatusCode,
        statusCode: isResponse ? methodOrStatusCode : undefined,
      })
    }

    // --- Factory helpers for dialog/transaction wrappers ---

    function sendMethodToOpts(_method: string, opts?: SendOpts): InternalSendOpts {
      if (!opts) return {}
      const sendOpts: Record<string, unknown> = {}
      if (opts.uri !== undefined) sendOpts.uri = opts.uri
      if (opts.delay !== undefined) sendOpts.delay = opts.delay
      if (opts.build !== undefined) sendOpts.build = opts.build
      if (opts.overrides !== undefined) sendOpts.overrides = opts.overrides
      if (opts.body !== undefined) sendOpts.body = opts.body
      if (opts.skipValidation !== undefined) sendOpts.skipValidation = opts.skipValidation
      return sendOpts as InternalSendOpts
    }

    function makeUacTransaction(): UacTransaction {
      return {
        expect: (statusCode, opts) => expect(statusCode, opts),
      }
    }

    function makeUacInviteTransaction(): UacInviteTransaction {
      return {
        expect: (statusCode, opts) => expect(statusCode, opts),
        cancel: (opts) => {
          send("CANCEL", sendMethodToOpts("CANCEL", opts))
          return makeUacTransaction()
        },
      }
    }

    function makeDialogRef(): DialogRef {
      return {
        ack: (opts) => send("ACK", sendMethodToOpts("ACK", opts)),
        bye: (opts) => {
          send("BYE", sendMethodToOpts("BYE", opts))
          return makeUacTransaction()
        },
        send: (method, opts) => {
          if (opts?.build) hasBuildCallbacks = true
          send(method, sendMethodToOpts(method, opts))
          return makeUacTransaction()
        },
        expect: (method, opts) => {
          const expRef = expect(method, opts)
          return {
            reply: (statusCode, replyOpts) => expRef.reply(statusCode, replyOpts),
          }
        },
      }
    }

    // --- High-level API ---

    const invite: AgentProxy["invite"] = (uri, opts) => {
      if (opts?.build) hasBuildCallbacks = true
      const sendOpts: Record<string, unknown> = { uri }
      if (opts?.headers) sendOpts.overrides = { headers: opts.headers }
      if (opts?.body) sendOpts.body = opts.body
      if (opts?.build) sendOpts.build = opts.build
      if (opts?.skipValidation) sendOpts.skipValidation = opts.skipValidation
      send("INVITE", sendOpts as InternalSendOpts)
      return {
        dialog: makeDialogRef(),
        transaction: makeUacInviteTransaction(),
      }
    }

    const register: AgentProxy["register"] = (opts) => {
      if (opts?.build) hasBuildCallbacks = true
      // Default To to the agent's own AOR — this is a self-registration
      // and RFC 3261 §10.1 keys the registration off the To-URI userpart.
      // Default From also matches; that mirrors how a real UA registers
      // itself ("the AOR I'm advertising IS me").
      const aor = agents[agentName]?.uri ?? `sip:${agentName}@unknown`
      const baseOverrides: HeaderOverrides = opts?.overrides ?? {}
      const overrides: HeaderOverrides = {
        to: baseOverrides.to ?? `<${aor}>`,
        from: baseOverrides.from ?? `<${aor}>`,
        ...(baseOverrides.cseq !== undefined ? { cseq: baseOverrides.cseq } : {}),
        ...(baseOverrides.contact !== undefined ? { contact: baseOverrides.contact } : {}),
        ...(opts?.expires !== undefined
          ? { headers: { ...(baseOverrides.headers ?? {}), Expires: String(opts.expires) } }
          : baseOverrides.headers !== undefined ? { headers: baseOverrides.headers } : {}),
        ...(baseOverrides.extraHeaders !== undefined ? { extraHeaders: baseOverrides.extraHeaders } : {}),
        ...(baseOverrides.body !== undefined ? { body: baseOverrides.body } : {}),
      }
      const sendOpts: Record<string, unknown> = { overrides }
      if (opts?.uri !== undefined) sendOpts.uri = opts.uri
      if (opts?.delay !== undefined) sendOpts.delay = opts.delay
      if (opts?.build !== undefined) sendOpts.build = opts.build
      if (opts?.skipValidation !== undefined) sendOpts.skipValidation = opts.skipValidation
      send("REGISTER", sendOpts as InternalSendOpts)
      return makeUacTransaction()
    }

    const receiveInitialInvite: AgentProxy["receiveInitialInvite"] = (opts) => {
      const expRef = expect("INVITE", opts)
      return {
        dialog: makeDialogRef(),
        transaction: {
          reply: (statusCode, replyOpts) => expRef.reply(statusCode, replyOpts),
          expectCancel: (cancelOpts) => {
            const cancelExp = expect("CANCEL", cancelOpts)
            return {
              reply: (statusCode, replyOpts) => cancelExp.reply(statusCode, replyOpts),
            }
          },
          expectAck: (ackOpts) => expect("ACK", ackOpts),
        },
      }
    }

    return {
      name: agentName,
      invite,
      receiveInitialInvite,
      register,
      get dialog() { return makeDialogRef() },
      allowExtra,
    }
  }

  const recordK8s = (action: K8sStepAction): void => {
    const ref = makeStepRef()
    const step: K8sStep = { type: "k8s", action, ref }
    steps.push(step)
  }

  const cluster: ClusterContext = {
    kill(workerId, timing) {
      recordK8s(
        timing !== undefined
          ? { kind: "kill", workerId, timing }
          : { kind: "kill", workerId }
      )
    },
    respawn(workerId, opts) {
      recordK8s(
        opts?.preserveStorage === true
          ? { kind: "respawn", workerId, preserveStorage: true }
          : { kind: "respawn", workerId }
      )
    },
    disconnect(workerId) {
      recordK8s({ kind: "disconnect", workerId })
    },
    reconnect(workerId) {
      recordK8s({ kind: "reconnect", workerId })
    },
    partition({ from, to, direction }) {
      recordK8s({ kind: "partition", from, to, direction })
    },
    heal(a, b) {
      recordK8s({ kind: "heal", a, b })
    },
    expectReplicatedTo(workerId, { primary, callRef }) {
      recordK8s(
        callRef !== undefined
          ? { kind: "expectReplicatedTo", workerId, primary, callRef }
          : { kind: "expectReplicatedTo", workerId, primary }
      )
    },
    expectCallStateOn(workerId, opts) {
      const action: K8sStepAction = {
        kind: "expectCallStateOn",
        workerId,
        partition: opts.partition,
        owner: opts.owner,
        ...(opts.callRef !== undefined ? { callRef: opts.callRef } : {}),
        ...(opts.present !== undefined ? { present: opts.present } : {}),
      }
      recordK8s(action)
    },
    expectKillPhase(workerId, phase, opts) {
      const action: K8sStepAction = {
        kind: "expectKillPhase",
        workerId,
        phase,
        ...(opts?.minAtMs !== undefined ? { minAtMs: opts.minAtMs } : {}),
        ...(opts?.maxAtMs !== undefined ? { maxAtMs: opts.maxAtMs } : {}),
      }
      recordK8s(action)
    },
    expectRoutedTo(workerId, opts) {
      const action: K8sStepAction = {
        kind: "expectRoutedTo",
        workerId,
        decision: opts.decision,
        ...(opts.minCount !== undefined ? { minCount: opts.minCount } : {}),
      }
      recordK8s(action)
    },
  }

  const ctx: ScenarioContext = {
    agent(name, config) {
      agents[name] = config
      return makeAgentProxy(name)
    },
    pause(durationMs) {
      steps.push({ type: "pause", duration: durationMs })
    },
    contactOf(agentName) {
      return `{{agent:${agentName}:contact}}`
    },
    cluster,
  }

  builder(ctx)

  return { agents, steps, hasBuildCallbacks, allowedExtras }
}
