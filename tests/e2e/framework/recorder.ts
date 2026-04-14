/**
 * Recorder — captures DSL calls into a Step[] AST.
 *
 * When a scenario function runs, the recorder proxies all agent method
 * calls (send, expect, invite, ack, bye, cancel) into Step nodes.
 * No SIP messages are sent during recording.
 */

import type { SipMessage } from "../../../src/sip/types.js"
import type {
  AgentConfig,
  AllowedExtraPattern,
  ExpectRef,
  HeaderOverrides,
  MessageContext,
  SendStep,
  ExpectStep,
  Step,
  StepRef,
} from "./types.js"
import type { ValidationCheckName, ValidationOverrides } from "./validation.js"
import { makeStepRef, resetStepRefIds } from "./types.js"
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

export interface ScenarioContext {
  agent(name: string, config: AgentConfig): AgentProxy
  pause(durationMs: number): void
  contactOf(agentName: string): string
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
      get dialog() { return makeDialogRef() },
      allowExtra,
    }
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
  }

  builder(ctx)

  return { agents, steps, hasBuildCallbacks, allowedExtras }
}
