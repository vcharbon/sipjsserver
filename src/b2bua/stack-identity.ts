/**
 * B2BUA stack-identity helpers — build the ViaSpec / ContactSpec values the
 * pure stack generators consume.
 *
 * The B2BUA embeds call identity in outbound Via (`cr`/`lg`/`em`) and Contact
 * (`callRef`/`leg`/`emerg`) params so that inbound responses can be resolved
 * back to the owning call without consulting any external map. Encoding is
 * URL-component style so values that contain `;`, `=`, `@`, or whitespace
 * round-trip safely.
 */

import type { ContactSpec, ViaSpec } from "../sip/generators.js"
import { newBranch } from "../sip/MessageHelpers.js"
import type { AppConfigData } from "../config/AppConfig.js"
import type { Call } from "../call/CallModel.js"

export interface StackIdentityOpts {
  readonly localIp: string
  readonly localPort: number
  readonly callRef: string
  readonly leg: string
  readonly isEmergency: boolean
  readonly branch: string
}

const encode = encodeURIComponent

/** Build a ViaSpec with cr/lg/em + RFC 3581 `rport` custom params. */
export function buildCallVia(opts: StackIdentityOpts): ViaSpec {
  const customParams: Record<string, string> = {
    cr: encode(opts.callRef),
    lg: encode(opts.leg),
    // RFC 3581 §3: include `rport` (no value) so the next hop populates
    // `received=` / `rport=` on response Vias and we can route responses
    // through any NAT or non-symmetric routing without relying on
    // sent-by being externally reachable. Without this, a B2BUA behind
    // a Service / pod IP cannot receive responses through a stateful
    // proxy that is not in the same routing domain as the worker pod.
    rport: "",
  }
  if (opts.isEmergency) customParams.em = "1"
  return {
    localIp: opts.localIp,
    localPort: opts.localPort,
    transport: "UDP",
    branch: opts.branch,
    customParams,
  }
}

/** Build a ContactSpec with callRef/leg/emerg URI params. */
export function buildCallContact(opts: Omit<StackIdentityOpts, "branch">): ContactSpec {
  const uriParams: Record<string, string> = {
    callRef: encode(opts.callRef),
    leg: encode(opts.leg),
  }
  if (opts.isEmergency) uriParams.emerg = "1"
  return {
    user: "b2bua",
    host: opts.localIp,
    port: opts.localPort,
    uriParams,
  }
}

/** Convenience: both Via and Contact for a single outbound hop. */
export function buildCallViaAndContact(opts: StackIdentityOpts): {
  readonly via: ViaSpec
  readonly contact: ContactSpec
} {
  return {
    via: buildCallVia(opts),
    contact: buildCallContact(opts),
  }
}

/**
 * Build ViaSpec + ContactSpec for an outbound hop on the given leg.
 *
 * Mints a fresh branch (or uses `forceBranch` to replay a prior branch — e.g.
 * cached `dialog.ext.ackBranch` for 2xx retransmit). Reads emergency flag and
 * local IP/port from `call` and `config`.
 */
export function legStackIdentity(
  call: Call,
  legId: string,
  config: AppConfigData,
  forceBranch?: string,
): { readonly via: ViaSpec; readonly contact: ContactSpec; readonly branch: string } {
  const branch = forceBranch ?? newBranch()
  const isEmergency = call.emergency === true
  const via = buildCallVia({
    localIp: config.sipLocalIp,
    localPort: config.sipLocalPort,
    callRef: call.callRef,
    leg: legId,
    isEmergency,
    branch,
  })
  const contact = buildCallContact({
    localIp: config.sipLocalIp,
    localPort: config.sipLocalPort,
    callRef: call.callRef,
    leg: legId,
    isEmergency,
  })
  return { via, contact, branch }
}
