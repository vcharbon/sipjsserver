import { Effect } from "effect"
import { listPods, podLogs } from "./kubectl.js"

export interface RoutingDecision {
  readonly callId: string
  readonly method: string
  readonly workerIp: string
  readonly workerPort: number
  readonly decision: string
  readonly result: string
  /** Pod name of the proxy that made the decision (when readable). */
  readonly proxyPod?: string
}

/**
 * Parse the proxy's `routed METHOD callId → ip:port (decision=…, result=…)`
 * line emitted by `ProxyCore` for every routed SIP request.
 *
 * Example line:
 *   `[06:14:24.371] INFO (#17): routed BYE 5-1@10.244.3.5 → 10.244.1.5:5060 (decision=select_new, result=forwarded)`
 *
 * With `--prefix`, the line is prefixed by `[pod/<name>/<container>] `.
 */
const ROUTED_RE =
  /^(?:\[pod\/([^/\]]+)(?:\/[^\]]+)?\]\s*)?\[[^\]]+\]\s+\w+\s+\(#\d+\):\s+routed\s+(\S+)\s+(\S+)\s+→\s+(\d{1,3}(?:\.\d{1,3}){3}):(\d+)\s+\(decision=([^,]+),\s+result=([^)]+)\)/

export const parseRoutingDecisions = (logs: string): ReadonlyArray<RoutingDecision> => {
  const out: Array<RoutingDecision> = []
  for (const line of logs.split("\n")) {
    const m = ROUTED_RE.exec(line)
    if (!m) continue
    out.push({
      proxyPod: m[1] || undefined,
      method: m[2] ?? "",
      callId: m[3] ?? "",
      workerIp: m[4] ?? "",
      workerPort: parseInt(m[5] ?? "0", 10),
      decision: m[6] ?? "",
      result: m[7] ?? "",
    })
  }
  return out
}

export interface RoutingDecisionsOpts {
  /** Time window relative to now (e.g. "60s", "5m"). */
  readonly since?: string
}

/**
 * Fetch + parse routing decisions from all proxy pods in `namespace`.
 */
export const fetchRoutingDecisions = (
  namespace: string,
  opts: RoutingDecisionsOpts = {},
) =>
  Effect.gen(function* () {
    const logs = yield* podLogs(
      namespace,
      { labelSelector: "app.kubernetes.io/name=sip-front-proxy" },
      { since: opts.since },
    )
    return parseRoutingDecisions(logs)
  })

/**
 * Aggregate decisions per Call-ID. Key invariant: for sticky in-dialog
 * routing (INV-1), `workerIps.size` MUST equal 1 for every call.
 */
export interface PerCallRouting {
  readonly callId: string
  readonly workerIps: ReadonlySet<string>
  readonly methods: ReadonlyArray<string>
  readonly decisions: ReadonlyArray<RoutingDecision>
}

export const aggregatePerCall = (
  decisions: ReadonlyArray<RoutingDecision>,
): ReadonlyArray<PerCallRouting> => {
  const by = new Map<string, Array<RoutingDecision>>()
  for (const d of decisions) {
    const arr = by.get(d.callId)
    if (arr) arr.push(d)
    else by.set(d.callId, [d])
  }
  return Array.from(by, ([callId, ds]) => ({
    callId,
    workerIps: new Set(ds.map((d) => d.workerIp)),
    methods: ds.map((d) => d.method),
    decisions: ds,
  }))
}

/**
 * Map worker pod IP → pod name. Useful for translating routing decisions
 * (which carry IPs) into human-readable pod identifiers.
 */
export const workerIpToName = (namespace: string) =>
  Effect.gen(function* () {
    const pods = yield* listPods(namespace, "app.kubernetes.io/name=b2bua-worker")
    return new Map(pods.map((p) => [p.ip, p.name]))
  })
