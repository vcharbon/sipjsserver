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
  /**
   * Wall-clock timestamp the proxy logged for this decision, parsed
   * from the bracketed `[HH:MM:SS.fff]` prefix on the log line. The
   * date component is taken from `referenceDate` passed to
   * `parseRoutingDecisions` (defaults to `new Date()`); the parser
   * cannot infer the date from the log line itself. `undefined` when
   * the bracket is missing or unparseable.
   *
   * Used by `callLifecycle.classifyCalls` to bucket calls relative to
   * `T_kill`. Existing tests that don't need timing leave this field
   * unread — adding it is purely additive.
   */
  readonly tDecided?: Date
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
  /^(?:\[pod\/([^/\]]+)(?:\/[^\]]+)?\]\s*)?\[([^\]]+)\]\s+\w+\s+\(#\d+\):\s+routed\s+(\S+)\s+(\S+)\s+→\s+(\d{1,3}(?:\.\d{1,3}){3}):(\d+)\s+\(decision=([^,]+),\s+result=([^)]+)\)/

const TIME_RE = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/

const parseTimestamp = (raw: string, ref: Date): Date | undefined => {
  const m = TIME_RE.exec(raw.trim())
  if (!m) return undefined
  const hh = parseInt(m[1] ?? "", 10)
  const mm = parseInt(m[2] ?? "", 10)
  const ss = parseInt(m[3] ?? "", 10)
  const fracRaw = m[4] ?? ""
  // Pad/truncate to milliseconds.
  const ms =
    fracRaw === ""
      ? 0
      : parseInt((fracRaw + "000").slice(0, 3), 10)
  if (![hh, mm, ss, ms].every(Number.isFinite)) return undefined
  return new Date(
    Date.UTC(
      ref.getUTCFullYear(),
      ref.getUTCMonth(),
      ref.getUTCDate(),
      hh,
      mm,
      ss,
      ms,
    ),
  )
}

export const parseRoutingDecisions = (
  logs: string,
  opts: { referenceDate?: Date } = {},
): ReadonlyArray<RoutingDecision> => {
  const ref = opts.referenceDate ?? new Date()
  const out: Array<RoutingDecision> = []
  for (const line of logs.split("\n")) {
    const m = ROUTED_RE.exec(line)
    if (!m) continue
    const tDecided = m[2] ? parseTimestamp(m[2], ref) : undefined
    out.push({
      ...(m[1] ? { proxyPod: m[1] } : {}),
      method: m[3] ?? "",
      callId: m[4] ?? "",
      workerIp: m[5] ?? "",
      workerPort: parseInt(m[6] ?? "0", 10),
      decision: m[7] ?? "",
      result: m[8] ?? "",
      ...(tDecided !== undefined ? { tDecided } : {}),
    })
  }
  return out
}

export interface RoutingDecisionsOpts {
  /** Time window relative to now (e.g. "60s", "5m"). */
  readonly since?: string
  /**
   * Reference date used to expand the bracketed `[HH:MM:SS.fff]`
   * timestamp on each log line into a full `Date`. Defaults to "now"
   * inside `parseRoutingDecisions`. Failover tests that need accurate
   * `tDecided` should pass the test-start `Date` here.
   */
  readonly referenceDate?: Date
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
      opts.since !== undefined ? { since: opts.since } : {},
    )
    return parseRoutingDecisions(
      logs,
      opts.referenceDate !== undefined ? { referenceDate: opts.referenceDate } : {},
    )
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

export interface WaitForInvitesOpts {
  /** Test-run unique cidPrefix; only INVITEs whose Call-ID starts with this are counted. */
  readonly cidPrefix: string
  /** Minimum number of matching INVITEs that must be visible before the wait succeeds. */
  readonly minCount: number
  /** `since` window passed to fetchRoutingDecisions; relative duration. */
  readonly since: string
  /** Wall-clock deadline (ms). Returns early on first satisfaction; fails after deadline. */
  readonly deadlineMs: number
  /** Poll cadence in seconds. Default 2s. */
  readonly pollSec?: number
}

export interface WaitForInvitesResult {
  readonly decisions: ReadonlyArray<RoutingDecision>
  readonly invites: ReadonlyArray<RoutingDecision>
  readonly satisfied: boolean
}

/**
 * Poll the proxy routing log until at least `minCount` INVITEs whose
 * Call-ID starts with `cidPrefix` are visible, OR `deadlineMs` is hit.
 *
 * Used by failover harnesses to wait for sipp Job pods to actually
 * start sending INVITEs. A static `Effect.sleep(rampSec)` is unreliable
 * after a prior test killed pods because the new sipp Job's first
 * INVITE may not land for several seconds (pod scheduling, image
 * cache, Service endpoints reconciling, kube-proxy conntrack
 * settling).
 */
export const waitForInvites = (
  namespace: string,
  opts: WaitForInvitesOpts,
): Effect.Effect<WaitForInvitesResult> =>
  Effect.gen(function* () {
    const pollSec = opts.pollSec ?? 2
    const sinceOpts = opts.since !== undefined ? { since: opts.since } : {}
    while (Date.now() < opts.deadlineMs) {
      const decisions = yield* fetchRoutingDecisions(namespace, sinceOpts)
      const invites = decisions.filter(
        (d) => d.callId.startsWith(opts.cidPrefix) && d.method === "INVITE",
      )
      if (invites.length >= opts.minCount) {
        return { decisions, invites, satisfied: true }
      }
      yield* Effect.sleep(`${pollSec} seconds`)
    }
    // Final read after the deadline so the caller has the freshest
    // (still-empty) snapshot for the diagnostic.
    const decisions = yield* fetchRoutingDecisions(namespace, sinceOpts)
    const invites = decisions.filter(
      (d) => d.callId.startsWith(opts.cidPrefix) && d.method === "INVITE",
    )
    return { decisions, invites, satisfied: false }
  }).pipe(Effect.catchTag("ExecError", () => Effect.die("waitForInvites kubectl failed")))
