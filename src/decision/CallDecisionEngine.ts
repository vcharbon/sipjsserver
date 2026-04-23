/**
 * CallDecisionEngine — canonical per-call decision service.
 *
 * Three lifecycle methods, each with a typed canonical request/response:
 *   - newCall     : inbound INVITE → route / reject
 *   - callFailure : b-leg failure  → failover / terminate
 *   - callRefer   : REFER authz    → allow / reject
 *
 * Vendor HTTP APIs sit behind adapter Layers (see
 * `./adapters/http-reference/HttpReferenceAdapter`). Core SIP code never
 * sees vendor-specific fields — only the canonical shapes.
 *
 * v1 scope: canonical shapes are 1:1 with today's HTTP contract (the
 * reference adapter is a field-rename). Slice B replaces the wire shape
 * with the richer structured model described in SplitServiceLogic.md.
 */

import { Effect, ServiceMap } from "effect"
import { CallDecisionError } from "./schemas/errors.js"
import type {
  CallFailureRequest,
  CallReferRequest,
  NewCallRequest,
} from "./schemas/requests.js"
import type {
  CallFailureResponse,
  CallReferResponse,
  NewCallResponse,
} from "./schemas/responses.js"

export class CallDecisionEngine extends ServiceMap.Service<
  CallDecisionEngine,
  {
    readonly newCall: (req: NewCallRequest) => Effect.Effect<NewCallResponse, CallDecisionError>
    readonly callFailure: (req: CallFailureRequest) => Effect.Effect<CallFailureResponse, CallDecisionError>
    readonly callRefer: (req: CallReferRequest) => Effect.Effect<CallReferResponse, CallDecisionError>
  }
>()("@sipjsserver/CallDecisionEngine") {}
