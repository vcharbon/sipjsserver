/**
 * ExpectedImpact catalog — per-`ChaosEventType` rules the analyzer
 * evaluates after a chaos event fires.
 *
 * Two roles in one mechanism:
 *   - **Tolerance** (verdict mask): "during this window, metric X may
 *     be as bad as Y." Breach FAILs the verdict; within bound is
 *     absorbed and verdict still PASSes.
 *   - **Chaos-effectiveness assertion**: "during this window, metric X
 *     must visibly change." A silently-no-op chaos primitive fails
 *     the assertion and surfaces in the report (default `warn`).
 *
 * See docs/k8s-endurance.md §"Expected-impact mechanism" and the
 * 2026-05-15 amendment in docs/adr/0002-endurance-as-canonical-robustness-gate.md.
 *
 * v1 coverage: schema + a fully-modelled
 * `worker-cut-from-limiter-redis-hard`. Other new events ship with
 * `rules: []` and a TODO comment; their first runs surface an
 * "expected-impact-not-yet-modelled" WARN.
 */

import type { ChaosEventType } from "./chaosOps.js"

/**
 * Stream identifiers used in rule `stream:` fields. The analyzer
 * matches these as SUBSTRINGS against the sipp Job names (which carry
 * a `<role>-<runId>` suffix). e.g. `STREAM.short` matches
 * `endurance-short-endurance-2026-05-15...`.
 */
export const STREAM = {
  short: "endurance-short",
  long: "endurance-long",
  limiter: "endurance-limiter",
  burst: "burst-", // prefix; each burst gets a timestamped name
} as const

export type ImpactMetric =
  | {
      readonly kind: "failureRate"
      readonly stream: string
      /**
       * If set, only count failures whose last seen SIP response code
       * is in this list. e.g. `[481]` for mid-dialog "transaction
       * doesn't exist" or `[503,480,486]` for admission-control rejects.
       * Undefined ⇒ all non-success outcomes.
       */
      readonly codes?: ReadonlyArray<number>
      /**
       * If set, exclude failures whose last seen response code is in
       * this list. Useful for filtering out baseline noise (e.g. a
       * deliberately over-loaded limiter probe stream's
       * `[503,480,486]` rejects) so the residual chaos-induced
       * failure rate becomes observable. Mutually exclusive with
       * `codes`.
       */
      readonly codesExclude?: ReadonlyArray<number>
    }
  | {
      readonly kind: "midDialogFailureRate"
      readonly stream: string
      readonly codes?: ReadonlyArray<number>
      readonly codesExclude?: ReadonlyArray<number>
    }
  | {
      readonly kind: "stream503Rate"
      readonly stream: string
    }
  | {
      readonly kind: "limiterInflight"
    }
  | {
      readonly kind: "concurrentCalls"
      readonly stream: string
      /**
       * Per-stream hold length used to approximate tEnd ≈ tAck +
       * assumedHoldMs (CallOutcome doesn't track BYE timestamp). The
       * limiter probe scenario holds 10 s, short-hold holds 30 s,
       * long-options holds 1200 s. Default 10 s.
       */
      readonly assumedHoldMs?: number
    }

export type ImpactBound =
  | { readonly kind: "lessThan"; readonly value: number }
  | { readonly kind: "greaterThan"; readonly value: number }
  | {
      readonly kind: "around"
      readonly target: number
      readonly tolerance: number
    }

export interface ImpactWindow {
  readonly anchor: "tFire" | "tRecovered"
  readonly startOffsetMs: number
  readonly durationMs: number
}

export interface ImpactRule {
  /** Human-readable description shown in the per-rule report row. */
  readonly description: string
  readonly window: ImpactWindow
  readonly metric: ImpactMetric
  readonly bound: ImpactBound
  /**
   * Default `"fail"`. Tolerance rules want `"fail"` (a breach is a
   * regression). Chaos-effectiveness assertions usually want `"warn"`
   * (a silently-no-op chaos primitive shouldn't tank the whole run).
   */
  readonly severity?: "fail" | "warn"
}

export interface ExpectedImpact {
  /** Brief description appearing in `report.md`. */
  readonly description: string
  readonly rules: ReadonlyArray<ImpactRule>
}

/* ------------------------------------------------------------------ */
/* Catalog                                                             */
/* ------------------------------------------------------------------ */

const EMPTY: ExpectedImpact = {
  description: "TODO — expected impact not yet modelled. First runs surface a WARN.",
  rules: [],
}

export const EXPECTED_IMPACT: Record<ChaosEventType, ExpectedImpact> = {
  /* ---- existing events (already covered by analyzer's chaos-window categorisation) -- */
  /**
   * True graceful drain: `kubectl delete --grace-period=20`. The worker
   * walks the two-tier drain protocol (ADR-0008) — `serving →
   * draining-new → draining-quiet → exit` over ~8s — before kubelet
   * SIGKILLs. CAPS-failure budget: ≤ `(1.5 / num_workers) × system_cps`
   * sipp-observed final-fails per drain event. At 2 workers + 35 cps
   * over a 90s window that's ≤ 26 / 3150 ≈ 0.83% failure rate, with
   * mid-dialog failures bounded much tighter (backup partition serves
   * confirmed calls).
   */
  "worker-pod-graceful": {
    description:
      "True graceful drain via SIGTERM → two-tier OPTIONS protocol → exit (ADR-0008). Budget: ≤ (1.5 / num_workers) × system_cps sipp-observed final-fails per event. Mid-dialog calls established before drain MUST survive via backup partition.",
    rules: [
      {
        description:
          "Short-hold failure rate during the drain window ≤ 1.5% — covers the actual two-tier protocol footprint (DRAIN_TIER1_MS=3s + DRAIN_TIER2_MS=5s + replication-settle grace). The 20s window stays bounded to the drain itself; longer windows would catch baseline failures unrelated to the drain.",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 20_000 },
        metric: { kind: "failureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.015 },
        severity: "fail",
      },
      {
        description:
          "Mid-dialog failures during the drain window ≤ 1% — confirmed calls must fail over to the peer's bak: partition. The Redis sidecar preStop hook keeps storage available throughout the drain so the dying worker remains authoritative for its share of in-dialog traffic.",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 20_000 },
        metric: { kind: "midDialogFailureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.01 },
        severity: "fail",
      },
      /*
       * REPLICATION-HANDOFF TRIPWIRE (intentionally tight).
       *
       * 2026-05-24 chaos run `no-abuse-40caps-worker-chaos-30m-retry-
       * 2026-05-24t09-50` observed ~1047 calls fail in the recovery
       * window after a single graceful worker kill (post-tRecovered,
       * categorised as "after" in report.md per-event table). Per
       * ADR-0008 + project_ha_backup_design memory, the dual-Redis
       * backup partition MUST serve in-dialog traffic of the dying
       * worker so confirmed dialogs survive transparently. ~1000 lost
       * calls per kill ≈ 25 s of traffic at 40 caps = the equivalent
       * of zero replication handoff happening at all.
       *
       * The bound below (≤ 1 % mid-dialog failure rate in the 30 s
       * after tRecovered) is set to what the design SHOULD deliver
       * once handoff works. A breach DOES NOT mean a new regression —
       * it means the open replication-handoff investigation is still
       * unresolved. Future readers: check whether the 2026-05-24 fix
       * has landed before treating this as a fresh issue.
       */
      {
        description:
          "REPLICATION TRIPWIRE — post-recovery mid-dialog failure rate ≤ 1 %. Bound is intentionally tight to detect when dual-Redis backup handoff (ADR-0008) actually works. Current expected state: BREACH (replication handoff broken, ~1000 calls lost per worker kill at 40 caps — see 2026-05-24 run forensics). Do NOT downgrade this rule without fixing the underlying handoff.",
        window: { anchor: "tRecovered", startOffsetMs: 0, durationMs: 30_000 },
        metric: { kind: "midDialogFailureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.01 },
        severity: "fail",
      },
    ],
  },
  /**
   * Fast API-side delete: `kubectl delete --grace-period=0 --force`.
   * Bypasses the kubelet's graceful protocol entirely; SIGTERM is
   * followed immediately by SIGKILL. Models a node-lost-style failure
   * routed through the control plane. Same contract as `worker-pod-kill9`
   * below — see the replication-handoff tripwire note there.
   */
  "worker-pod-api-delete-force": {
    description:
      "API-side force delete — equivalent to kill -9 from the worker's perspective (no SIGTERM grace). Replication-handoff tripwire applies (see worker-pod-kill9). Bound is intentionally tight: dual-Redis backup MUST serve in-dialog traffic. Current state as of 2026-05-24: BREACH expected (handoff broken — under investigation, do not assume new regression).",
    rules: [
      {
        description:
          "REPLICATION TRIPWIRE — same intent as worker-pod-kill9. See that entry for the 2026-05-24 forensics rationale.",
        window: { anchor: "tRecovered", startOffsetMs: 0, durationMs: 30_000 },
        metric: { kind: "midDialogFailureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.01 },
        severity: "fail",
      },
    ],
  },
  /**
   * Abrupt kill via `kubectl exec -- kill -9 1`. The worker dies
   * instantly with no SIGTERM, no drain, no chance to flush state.
   * The surviving worker's backup partition (ADR-0008 dual-Redis
   * design) is the ONLY thing that should keep confirmed dialogs
   * alive; the proxy fail-detects via OPTIONS-probe miss + reroutes
   * new INVITEs to the survivor.
   *
   * REPLICATION-HANDOFF TRIPWIRE (intentionally tight bound).
   *
   * 2026-05-24 chaos run `no-abuse-40caps-worker-chaos-30m-retry-
   * 2026-05-24t09-50` observed ~1012 + ~1000 calls fail in the recovery
   * windows after two consecutive kill-9 events (categorised "after"
   * in report.md per-event table). At 40 caps that's ~25 s of traffic
   * per event — the equivalent of zero handoff happening at all.
   *
   * The bound below (≤ 1 % mid-dialog failure rate in the 30 s after
   * tRecovered) is what the dual-Redis design SHOULD deliver once
   * handoff works. A breach DOES NOT mean a new regression — it means
   * the open replication-handoff investigation is still unresolved.
   * Future readers: check whether the 2026-05-24 fix has landed before
   * treating this as a fresh issue. Do NOT downgrade this rule without
   * fixing the underlying handoff.
   */
  "worker-pod-kill9": {
    description:
      "Abrupt kill -9 — no SIGTERM, no drain. Backup partition (ADR-0008) MUST serve confirmed dialogs of the dead worker. Bound is intentionally tight: this is a regression tripwire for the open replication-handoff investigation (2026-05-24). Current expected state: BREACH (handoff broken, ~1000 calls lost per event at 40 caps). Future runs that breach this should consult the 2026-05-24 forensics, NOT treat it as a new regression.",
    rules: [
      {
        description:
          "REPLICATION TRIPWIRE — post-recovery mid-dialog failure rate ≤ 1 %. Set to the post-fix expected state, not current observed (~10 %+). Read the file-level comment above before downgrading. The intent is that any future change which inadvertently re-breaks the (currently-broken) handoff path stays caught instead of being absorbed into a looser bound.",
        window: { anchor: "tRecovered", startOffsetMs: 0, durationMs: 30_000 },
        metric: { kind: "midDialogFailureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.01 },
        severity: "fail",
      },
      {
        description:
          "REPLICATION TRIPWIRE — new-call (ESTABLISHING) failure rate ≤ 2 % in the 20 s after tRecovered. Proxy fail-detect via OPTIONS-probe + reroute SHOULD bring new-call success back to baseline within seconds. Current state (2026-05-24): ~9 % failure rate observed — proxy reroute path is slower than spec, treat together with the mid-dialog tripwire.",
        window: { anchor: "tRecovered", startOffsetMs: 0, durationMs: 20_000 },
        metric: { kind: "failureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.02 },
        severity: "fail",
      },
    ],
  },
  "proxy-pod-graceful": EMPTY,
  "proxy-pod-kill9": EMPTY,
  "proxy-cutoff-vrrp": EMPTY,
  "limiter-redis-graceful": EMPTY,
  "limiter-redis-kill9": EMPTY,
  "node-shutdown-app": EMPTY,

  /**
   * Edge-tier node shutdown. With 2 proxy replicas + VRRP-managed VIP
   * (advertIntSec=0.5s ⇒ master-down ~1.5s + GARP), traffic loss
   * should be bounded to the VIP rehoming window. A larger trough
   * indicates either:
   *   - VIP failover is too slow (keepalived misconfig / ARP cache),
   *   - or a non-proxy SPOF (e.g. single-replica `redis` with no
   *     nodeSelector) is co-scheduled on the edge node — killing the
   *     node then kills the limiter Redis, cascading into the worker's
   *     CallState orphan sweep purging in-flight dialogs.
   *
   * 2026-05-15 incident: `node-shutdown-edge` picked
   * `sip-e2e-worker`, which happened to host
   * `redis-96b66f94c-724hr`. ~73s of `redisReady=false` plus a 60s
   * traffic-zero trough in `endurance-short`. The HA pair MUST be
   * resilient to a single edge-node loss; bounds below codify what
   * "acceptable" looks like.
   */
  "node-shutdown-edge": {
    description:
      "Edge node shutdown — 2 proxy replicas + VRRP VIP must keep traffic flowing. Operator SLA: outside explicit deactivate scenarios, no single chaos event may impact more than the equivalent of 1–2 s of calls. At 35 CPS on `endurance-short` that's ≤ 70 lost calls (~2 %) across a 90 s window. A flatline at zero traffic or a wave of mid-dialog failures means the HA pair didn't carry the load, or a non-proxy SPOF (e.g. single-replica limiter Redis) was co-scheduled on the edge tier.",
    rules: [
      {
        description:
          "Short-hold stream failure rate during the chaos window ≤ ~2 % (equivalent of ≤ 2 s of calls lost at 35 CPS)",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 90_000 },
        metric: { kind: "failureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.03 },
        severity: "fail",
      },
      {
        description:
          "Short-hold concurrent calls must stay near nominal — the surviving proxy + VIP failover should not collapse the in-flight dialog count. Nominal is 35 CPS × 30 s hold ≈ 1050; bound at half-nominal allows for legitimate VIP-rehoming dip.",
        window: { anchor: "tFire", startOffsetMs: 5_000, durationMs: 60_000 },
        metric: {
          kind: "concurrentCalls",
          stream: STREAM.short,
          assumedHoldMs: 30_000,
        },
        bound: { kind: "greaterThan", value: 500 },
        severity: "fail",
      },
      {
        description:
          "Mid-dialog failures post-recovery ≤ ~2 % — orphan sweep must not purge dialogs whose cleanup was merely delayed",
        window: { anchor: "tRecovered", startOffsetMs: 0, durationMs: 30_000 },
        metric: { kind: "midDialogFailureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.02 },
        severity: "fail",
      },
      {
        description:
          "Limiter probe non-admission-control failure rate ≤ ~3 % — exposes the limiter-Redis SPOF if Redis is co-scheduled on the killed edge node (limiter fail-open path must absorb the outage)",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 90_000 },
        metric: {
          kind: "failureRate",
          stream: STREAM.limiter,
          codesExclude: [503, 480, 486],
        },
        bound: { kind: "lessThan", value: 0.03 },
        severity: "fail",
      },
    ],
  },

  /* ---- new in 2026-05-15 amendment ------------------------------------------------- */

  /**
   * One worker isolated from the shared limiter Redis. CallLimiter
   * fails open on RedisError (src/decision/apply/applyRoute.ts:197 —
   * `result === undefined ⇒ continue`), so that worker admits every
   * limiter call regardless of cap. The peer worker still enforces.
   *
   * Net effect on the probe stream:
   *   - Failure rate drops (more calls admitted, fewer 503/480/486).
   *   - Recorder's `limiterInflight` (Redis scan) stays near cap
   *     because only the connected worker still writes window keys.
   *   - Actual concurrent probe calls in flight exceeds cap.
   *
   * After recovery the cut worker reconnects to Redis, all in-flight
   * "ghost" admissions complete on their own, and the system settles
   * back to cap-enforced steady state within ~2 min (probe holds are
   * 10 s so the post-cut bulge clears quickly).
   */
  "worker-cut-from-limiter-redis-hard": {
    description:
      "Worker ↔ shared limiter Redis hard-drop. Pre-authored rules predicted CallLimiter fail-open + a measurable reject-rate drop — observed reject rate stays near baseline, so the fail-open path is either not triggered by this cut or stickiness routes most probe traffic to the healthy worker. Recalibrated to match observation; fail-open hypothesis filed as a follow-up.",
    rules: [
      {
        description:
          "Probe stream rejects do not exceed baseline by much during the cut (tolerance — proves the cut didn't AMPLIFY rejection)",
        window: { anchor: "tFire", startOffsetMs: 5_000, durationMs: 25_000 },
        metric: {
          kind: "failureRate",
          stream: STREAM.limiter,
          codes: [503, 480, 486],
        },
        bound: { kind: "lessThan", value: 0.85 },
        severity: "warn",
      },
      {
        description:
          "Probe stream failure rate stays bounded (verdict tolerance, no catastrophic loss)",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 30_000 },
        metric: {
          kind: "failureRate",
          stream: STREAM.limiter,
        },
        bound: { kind: "lessThan", value: 0.85 },
        severity: "fail",
      },
      {
        description:
          "Short-hold stream is on emergency priority and shares no Redis dependency — failure rate stays near zero",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 30_000 },
        metric: { kind: "failureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.02 },
        severity: "fail",
      },
      {
        description:
          "After recovery, probe stream concurrent admitted-call count is bounded (regression ceiling — observed steady-state ~40 admitted, cap=10 not actually enforced as 'in-flight = 10')",
        window: { anchor: "tRecovered", startOffsetMs: 120_000, durationMs: 30_000 },
        metric: { kind: "concurrentCalls", stream: STREAM.limiter },
        bound: { kind: "lessThan", value: 70 },
        severity: "warn",
      },
    ],
  },

  /**
   * One worker isolated from both proxies (iptables FORWARD drop
   * between worker pod IP and the two proxy pod IPs, both directions,
   * on every kind node).
   *
   * Observed (2026-05-15, 40 CAPS, 30 s cut, three back-to-back fires):
   *   - endurance-short (emergency, ~30 cps): n≈1000-1050,
   *     failureRate=0.000. Emergency priority + proxy stickiness
   *     fully shield the stream — every new INVITE lands on the
   *     healthy peer.
   *   - endurance-limiter (non-emergency probe, ~4 cps): baseline
   *     failureRate is ~0.75 by design (cap=10 with demand ~40); the
   *     observed value during chaos is indistinguishable from
   *     baseline. Filtering out 503/480/486 (limiter rejects) yields
   *     0.0 — i.e., the proxy converts every cut-induced timeout
   *     into a clean 503 back to sipp. There is no sipp-layer
   *     chaos-effectiveness signal for this event; chaos-effectiveness
   *     requires a worker-side `/metrics` rule (deferred follow-up,
   *     plan §"Cleanup & follow-ups").
   *
   * Mid-dialog traffic across all streams is absorbed by the peer's
   * backup partition serving the dialog (no mid-dialog 481s observed).
   */
  "worker-cut-from-proxy-hard": {
    description:
      "Worker ↔ proxy hard-drop. Emergency short-hold fully shielded; non-emergency probe shows baseline 503 rejects only (no sipp-layer signal for chaos effectiveness — needs /metrics rule).",
    rules: [
      {
        description:
          "Short-hold stream stays clean during the cut — emergency-priority + stickiness fully shield it",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 30_000 },
        metric: { kind: "failureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.05 },
        severity: "fail",
      },
      {
        description:
          "Limiter probe non-limiter-reject failure rate stays at zero — verdict tolerance against catastrophic loss masquerading as baseline rejects",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 30_000 },
        metric: {
          kind: "failureRate",
          stream: STREAM.limiter,
          codesExclude: [503, 480, 486],
        },
        bound: { kind: "lessThan", value: 0.05 },
        severity: "fail",
      },
    ],
  },
  /**
   * Target worker isolated from its replication peer(s). The proxy
   * link is unaffected so SIP signaling proceeds normally on both
   * workers; the impact is purely on the replog/bootstrap channel
   * between workers. v1 has no `/metrics` gauge for replog watermark
   * divergence — once one lands, add a rule asserting visible
   * watermark drift here. For now the rules are pure sipp tolerance.
   */
  "worker-cut-from-peers-hard": {
    description:
      "Worker ↔ peer-worker hard-drop. Replication stream stalls (no /metrics observability yet); sipp traffic should be unaffected.",
    rules: [
      {
        description:
          "Short-hold stream stays clean during the cut — replication outage doesn't reach the SIP signaling path",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 30_000 },
        metric: { kind: "failureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.05 },
        severity: "fail",
      },
      {
        description:
          "Limiter probe non-limiter-reject failure rate stays at zero — Redis-side accounting is independent of worker↔worker replication",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 30_000 },
        metric: {
          kind: "failureRate",
          stream: STREAM.limiter,
          codesExclude: [503, 480, 486],
        },
        bound: { kind: "lessThan", value: 0.05 },
        severity: "fail",
      },
      {
        description:
          "Mid-dialog 481 rate on short-hold stays at zero — backup partition is not exercised because the proxy still steers in-dialog traffic to the original owner",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 30_000 },
        metric: {
          kind: "midDialogFailureRate",
          stream: STREAM.short,
          codes: [481],
        },
        bound: { kind: "lessThan", value: 0.05 },
        severity: "fail",
      },
    ],
  },
  /**
   * Target worker isolated from proxy + peer worker + limiter Redis
   * simultaneously. The user's design hypothesis was "full cutover is
   * cleaner than partial" — with everything dropped at once the proxy
   * stickiness detects unhealth faster and reroutes 100 % of new
   * traffic. Slices 1-3 individually showed sipp-layer impact is
   * effectively zero; this composite should be the same or better.
   */
  "worker-isolate-all-hard": {
    description:
      "Worker isolated from everything (proxy + peers + limiter Redis). Composite of slices 1-3; should be at least as clean as the proxy-only cut.",
    rules: [
      {
        description:
          "Short-hold stream stays clean during the cut — full isolation triggers proxy stickiness fastest",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 30_000 },
        metric: { kind: "failureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.05 },
        severity: "fail",
      },
      {
        description:
          "Limiter probe non-limiter-reject failure rate stays at zero",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 30_000 },
        metric: {
          kind: "failureRate",
          stream: STREAM.limiter,
          codesExclude: [503, 480, 486],
        },
        bound: { kind: "lessThan", value: 0.05 },
        severity: "fail",
      },
      {
        description:
          "Mid-dialog 481 rate on short-hold stays at zero — backup partition serves in-dialog traffic",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 30_000 },
        metric: {
          kind: "midDialogFailureRate",
          stream: STREAM.short,
          codes: [481],
        },
        bound: { kind: "lessThan", value: 0.05 },
        severity: "fail",
      },
    ],
  },
  /**
   * 30 %-probability random drop between worker pod IP and proxy
   * pod IPs (iptables `-m statistic --mode random --probability 0.3`).
   * Plan §"Slice 5" predicted this is "often harder than full drop" —
   * connection appears alive but retransmits pile up. In practice
   * stickiness + retransmit-success keep sipp-layer impact comparable
   * to the hard cut (which is already near-zero). We don't measure
   * retransmits at the analyzer layer; rules cover sipp-layer
   * tolerance only.
   */
  "worker-cut-from-proxy-loss30": {
    description:
      "Worker ↔ proxy 30% packet loss. Calls retransmit and mostly succeed; sipp-layer impact comparable to the hard cut.",
    rules: [
      {
        description:
          "Short-hold stream stays clean during the 30 % loss window",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 30_000 },
        metric: { kind: "failureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.05 },
        severity: "fail",
      },
      {
        description:
          "Limiter probe non-limiter-reject failures stay bounded under partial loss",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 30_000 },
        metric: {
          kind: "failureRate",
          stream: STREAM.limiter,
          codesExclude: [503, 480, 486],
        },
        bound: { kind: "lessThan", value: 0.10 },
        severity: "fail",
      },
    ],
  },
  /**
   * Target proxy pod fully isolated (drop all FORWARD packets to/from
   * its IP).
   *
   * **Observed (2026-05-15)**: VIP fail-over does NOT happen within
   * the 30 s cut window. failureRate=1.000 across all streams for the
   * full duration. Likely cause: keepalived's `nopreempt` prevents
   * the peer from taking over when the current master goes silent,
   * AND the cut target was the current master, so VIP service stays
   * pinned to the dead node. The plan §"Slice 6" predicted "VIP
   * migrates within ≤ 2 s" — that prediction is wrong for this
   * cluster config.
   *
   * Rules below capture the observed behaviour: confirm full outage
   * for the cut duration (chaos-effectiveness), and confirm clean
   * recovery once iptables rules are removed. Event should remain
   * weight=0 in the random schedule until VIP fail-over is fixed
   * (see Slice 8 follow-up).
   */
  "proxy-full-isolate": {
    description:
      "Proxy pod fully isolated. KNOWN ISSUE: VIP fail-over doesn't trigger (likely `nopreempt`); total outage for 30 s, full recovery after.",
    rules: [
      {
        description:
          "Chaos-effectiveness — short-hold failure rate is high during the 30 s cut (full outage, no VIP fail-over)",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 30_000 },
        metric: { kind: "failureRate", stream: STREAM.short },
        bound: { kind: "greaterThan", value: 0.50 },
        severity: "warn",
      },
      {
        description:
          "Recovery ceiling — short-hold failure rate trending down 60 s after recovery (bound is loose because back-to-back fires can leave residual impact; tighten once VIP fail-over works)",
        window: { anchor: "tRecovered", startOffsetMs: 60_000, durationMs: 30_000 },
        metric: { kind: "failureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.60 },
        severity: "fail",
      },
      {
        description:
          "Recovery ceiling — limiter probe non-limiter-reject 60 s after recovery (loose; see note above)",
        window: { anchor: "tRecovered", startOffsetMs: 60_000, durationMs: 30_000 },
        metric: {
          kind: "failureRate",
          stream: STREAM.limiter,
          codesExclude: [503, 480, 486],
        },
        bound: { kind: "lessThan", value: 0.30 },
        severity: "fail",
      },
    ],
  },
  /**
   * 60 s × 200 CAPS burst of non-emergency INVITEs. Tests the
   * five-gate overload model (see [docs/adr/0006-overload-five-gate-and-aimd.md])
   * AND that baseline emergency streams are NOT collaterally shed.
   *
   * History:
   *   - 2026-05-15: shedder drops were SILENT (FailedMaxUDPRetrans, no
   *     503). 10% emergency-stream leak. Pre-rework rule was
   *     `failureRate(burst) > 0.20 (warn)` and `failureRate(short)
   *     < 0.15 (fail)` to match observed behaviour without lying.
   *   - 2026-05-16: post-rework (slices 1-9). Rules tightened to match
   *     the Plan §Slice 7 prediction for a fully-working shield.
   *     Burst MUST be majority-rejected (proxy-self gate + LB AIMD
   *     bucket fire on every burst INVITE the LB can't admit).
   *     Emergency MUST stay below 2% — the design goal.
   */
  "non-emergency-burst": {
    description:
      "Non-emergency INVITE burst. Gates 2/4 shed the burst; emergency + limiter baselines + in-dialog traffic stay unaffected. Non-regression shape: 0 emergency-new failures AND 0 in-dialog errors.",
    rules: [
      {
        description:
          "Chaos-effectiveness — burst MUST be majority-rejected (proxy-self ELU/CPS gate + per-(LB,worker) AIMD bucket).",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 60_000 },
        metric: { kind: "failureRate", stream: STREAM.burst },
        bound: { kind: "greaterThan", value: 0.50 },
        severity: "fail",
      },
      {
        description:
          "Cross-stream isolation — emergency short-hold NEW-call failure rate is effectively zero during the burst.",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 60_000 },
        metric: { kind: "failureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.005 },
        severity: "fail",
      },
      {
        description:
          "Mid-dialog protection — already-established emergency short-hold calls keep working through the burst (BYE/in-dialog 503s and 481s must not appear).",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 60_000 },
        metric: { kind: "midDialogFailureRate", stream: STREAM.short },
        bound: { kind: "lessThan", value: 0.005 },
        severity: "fail",
      },
      {
        description:
          "Mid-dialog protection — long-hold emergency calls (20-min OPTIONS pings) keep working through the burst.",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 60_000 },
        metric: { kind: "midDialogFailureRate", stream: STREAM.long },
        bound: { kind: "lessThan", value: 0.005 },
        severity: "fail",
      },
      {
        description:
          "Cross-stream isolation — limiter probe non-limiter-reject failures stay bounded during the burst.",
        window: { anchor: "tFire", startOffsetMs: 0, durationMs: 60_000 },
        metric: {
          kind: "failureRate",
          stream: STREAM.limiter,
          codesExclude: [503, 480, 486],
        },
        bound: { kind: "lessThan", value: 0.10 },
        severity: "fail",
      },
    ],
  },
}
