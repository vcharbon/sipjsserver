# Replacement-proxy receives zero traffic — investigation + fix plan

> **Superseded by [cuddly-skipping-wigderson.md](./cuddly-skipping-wigderson.md).**
> The remediation choice in Slice 2 (Option B graceful drain + Option C
> endurance-test mitigation) was implemented and **did not fix the
> problem** — sipp's still-alive UDP flow keeps refreshing conntrack
> indefinitely. The new plan replaces it with a shared-VIP architecture
> via keepalived, see also [docs/lb-proxy-ha.md](../lb-proxy-ha.md).
> The diagnosis below remains authoritative.

## TL;DR

After a chaos event kills a `sip-front-proxy` pod, the kubelet
schedules a replacement. The replacement pod becomes `Ready=true` and
the K8s `Endpoints` resource lists it. But UDP traffic from existing
sipp clients **never reaches it** — observed twice now:

- pre-fix run: `ck74t` replacement after chaos[3] → 4 log lines, 0
  routing decisions, 17 min lifespan.
- post-fix run: `nzjs7` replacement after chaos[3] → 4 log lines, 0
  routing decisions, 16 min lifespan
  ([artifact](../../test-results/k8s-endurance/endurance-2026-05-05t19-38-38-468z/pod-logs/sip-front-proxy-6fd8f9fb99-nzjs7.log)).

The surviving original proxy (`2jtxr` in the post-fix run) absorbed
all the traffic that *should* have been split 50/50 with the
replacement. End-to-end the run still mostly succeeded because one
proxy was enough at 20 CAPS — but at higher load, this would be a
real outage. And in the chaos[3] window itself we saw 611 calls fail
in `stabilized_after`, attributable to traffic UDP-conntrack-pinned
to the just-killed `sp58q` pod IP that kept being forwarded to a
non-existent destination.

## Strong suspicion — kube-proxy + UDP conntrack pinning

When sipp opens a UDP socket and starts sending to the
`sip-front-proxy` ClusterIP, the **first packet** triggers
`iptables`/`ipvs` rules that DNAT the destination to one of the
backend pod IPs and create a conntrack entry. **Every subsequent
packet on the same 5-tuple uses that conntrack entry directly** —
iptables is not re-evaluated.

Default UDP conntrack timeouts on Linux:
- `nf_conntrack_udp_timeout` = 30 s (no reply seen yet)
- `nf_conntrack_udp_timeout_stream` = 180 s (after a reply was seen,
  i.e. the proxy actually forwarded back)

Sipp sends a packet every ~50 ms. Each outbound packet refreshes the
conntrack entry. **The entry never times out as long as sipp keeps
sending** — even after the original DNAT target's pod is dead.

What `kube-proxy` does on endpoint removal:
- Updates `iptables` chains so *new* connections see the updated
  endpoint set.
- Does NOT (by default in many kube-proxy modes/versions) flush
  existing conntrack entries pointing at the removed endpoint.

Net effect: existing UDP flows pinned to the dying pod stay pinned
until the SOURCE stops sending or the kernel evicts the conntrack
entry under memory pressure. In our endurance test, sipp keeps
sending forever, so the conntrack entry stays — and packets keep
being DNAT'd to a now-deleted pod IP. Whether they end up dropped
silently or rerouted to the surviving proxy depends on
`net.ipv4.ip_forward`, neighboring node routes, etc. — but they
definitely do not reach the *replacement* proxy.

For a fresh sipp 5-tuple (e.g. a sipp restart), kube-proxy's iptables
rules WOULD include the replacement, and traffic WOULD distribute
50/50. Confirms the problem is conntrack pinning, not endpoint
mismatch.

## Why this matters for production

In production deployments the typical UDP-LB-with-real-failover
patterns are:

1. **External UDP LB with stickiness off** (`MetalLB`,
   `cloud LB`) — but most cloud LBs have the same conntrack issue at
   their level.
2. **Client-side multi-target with retransmit** — RFC 3263 NAPTR/SRV
   resolution + RFC 5626 outbound. If the client supports failover,
   conntrack staleness is invisible because the client opens a fresh
   socket on retry.
3. **TCP transport** — TCP RST kills the conntrack on the killed
   pod's exit, the client reconnects, kube-proxy DNATs to a live
   endpoint. SIP-over-TCP is supported (RFC 3261 §18) — out of scope
   here, but a real production answer.
4. **conntrack eviction on endpoint change** — kube-proxy's
   `--cleanup-stale-udp-conntracks` (varies by version) issues
   `conntrack -D` for entries pointing at removed endpoints.

In our project, **sipp is a synthetic client; real UACs are different
shapes**. So the production impact depends on what those UACs do on
proxy failover. The test artifact is a faithful reproducer of "client
that does not retry on server change" — a common UA category, so the
problem is not purely test-side.

## Slice plan

### Slice 1 — confirm the cause (no code change)

Reproducer (~5 min wall time):

```bash
npm run test:k8s:endurance -- --caps 20 --duration 5m \
  --seed 1 \
  --chaos-min-interval 60s --chaos-max-interval 90s \
  --no-analyze
```

Then in another shell:

```bash
# at chaos[0] approximate trigger time, confirm pinning
kubectl -n sip-test exec -it sip-e2e-worker -- conntrack -L -p udp \
  | grep ':5060'
```

Expected: a long-lived UDP conntrack entry from sipp's load-tier IP
to the *killed* proxy pod IP, even after the new pod's IP shows up
in `kubectl get endpoints sip-front-proxy`.

If confirmed, no further investigation needed for slice-1. If not,
the cause is something else and slice 2 is rewritten.

### Slice 2 — choose mitigation strategy

Three candidate strategies, pick exactly one for this fix:

#### Option A — kube-proxy conntrack cleanup (operations-only)

Configure kube-proxy with the conntrack-cleanup flag for the kind
cluster:

```yaml
# in tests/k8s/cluster.yaml under the kubeProxy/iptables config
kubeProxy:
  iptables:
    syncPeriod: 30s
    minSyncPeriod: 10s
```

And add a kind kubelet/kube-proxy patch that enables
`--cleanup-stale-udp-conntracks` (or equivalent for the kube-proxy
version kind ships).

Pros: zero application code change.
Cons: kube-proxy version-specific; kind versioning is a moving
target; doesn't help any deployment that doesn't run kube-proxy
(IPVS, eBPF dataplanes).

#### Option B — graceful drain on SIGTERM (application change)

`sip-front-proxy` already has a SIGTERM handler that flips
`DrainingState`. Extend it to:

1. On SIGTERM, set `Pod.Ready=false` (via readiness probe flip) so
   k8s endpoint controller removes this pod from the Service.
2. Continue forwarding **existing in-flight transactions** for a
   `terminationGracePeriodSeconds` window (e.g. 30 s) so any
   conntrack-pinned client still has a working backend until its own
   timer-based retransmit cycles bring it to a fresh socket.
3. After grace, exit.

This does not actively flush conntrack but it gives the kernel /
client time to do so naturally. Testable in fake-clock under
`tests/sip-front-proxy/draining/proxy-graceful-drain.test.ts`.

Pros: portable across dataplanes; benefits real production.
Cons: doesn't help if the client never timeouts (sipp keeps sending
forever). Real UA traffic patterns vary.

#### Option C — endurance-test-side mitigation only

Out of scope for the platform; document the limitation in
[docs/k8s-endurance.md](../k8s-endurance.md) and exclude
`proxy-pod-graceful` and `proxy-pod-kill9` events from the chaos mix
when the goal is to assert post-recovery steady-state. Or recycle
sipp clients automatically after a proxy chaos event.

Pros: smallest change; doesn't pretend to fix a platform issue.
Cons: leaves the production failure mode un-addressed.

### Recommended: B + C in parallel

- **Application** gets graceful drain (Option B) — that's the right
  long-term shape and helps real UAs.
- **Endurance test** documents the limitation and excludes proxy
  chaos OR recycles sipp after proxy chaos (Option C) — so the
  endurance verdict is not gated on a behaviour the platform
  legitimately cannot guarantee for non-retrying UDP clients.

## RFC considerations (Option B specifically)

- **RFC 3261 §18.4** (Reliability of UDP transport): UAS/UAC are
  responsible for retransmissions. A drain-mode proxy that continues
  to serve in-flight transactions is consistent with §18.4.
- **RFC 3261 §10.2.1.1** (REGISTER): if the proxy is also the
  Registrar, it MUST NOT accept new REGISTERs while drained. Confirm
  the existing draining path already short-circuits REGISTER. (See
  [src/sip-front-proxy/Registrar.ts](../../src/sip-front-proxy/Registrar.ts)
  if relevant.)
- **RFC 3261 §10.2** (proxy 503 with Retry-After): standard graceful
  drain is to reply 503 + `Retry-After: 0` for new dialogs. Worker
  side already does this for `DrainingState` per
  [HealthProbe.ts:9-16](../../src/sip-front-proxy/health/HealthProbe.ts#L9);
  the proxy side should do the same.
- **No header rewriting** required.

## Acceptance criteria

- [ ] Slice 1 forensic confirms (or refutes) UDP-conntrack pinning
      with a `conntrack -L` capture in the artifact dir.
- [ ] If Option B chosen: new fake-clock test
      `tests/sip-front-proxy/draining/proxy-graceful-drain.test.ts`
      asserts:
      1. SIGTERM flips readiness to false within < 100 ms.
      2. New INVITEs receive 503 + Retry-After: 0 during drain
         window.
      3. In-flight transactions complete normally.
      4. Process exits within `gracePeriodMs` of SIGTERM.
- [ ] If Option C chosen: doc note in
      [docs/k8s-endurance.md](../k8s-endurance.md) under "Chaos
      schedule" explaining the limitation.
- [ ] `npm run typecheck` clean.
- [ ] `npm run test:fake` clean.
- [ ] 1 h endurance re-run with seed `1777960808113` shows
      `nzjs7`-equivalent pod **does** receive routing decisions
      (even if minority share due to UDP conntrack — strict 50/50
      not required, but > 0 / min for ≥ 2 minutes).

## Out of scope (logged separately)

- Switching default SIP transport to TCP. Big migration.
- IPVS or Cilium dataplane evaluation. Architectural review, not a
  bug fix.
- Multi-region SIP front proxy. Different problem.

## References

- Pre-fix `ck74t` empty log:
  [test-results/k8s-endurance/endurance-2026-05-05t06-00-08-113z/pod-logs/sip-front-proxy-6fd8f9fb99-ck74t.log](../../test-results/k8s-endurance/endurance-2026-05-05t06-00-08-113z/pod-logs/sip-front-proxy-6fd8f9fb99-ck74t.log).
- Post-fix `nzjs7` empty log:
  [test-results/k8s-endurance/endurance-2026-05-05t19-38-38-468z/pod-logs/sip-front-proxy-6fd8f9fb99-nzjs7.log](../../test-results/k8s-endurance/endurance-2026-05-05t19-38-38-468z/pod-logs/sip-front-proxy-6fd8f9fb99-nzjs7.log).
- Service definition:
  [deploy/helm/sip-front-proxy/templates/service.yaml](../../deploy/helm/sip-front-proxy/templates/service.yaml)
  + [tests/k8s/values/sip-front-proxy.yaml](../../tests/k8s/values/sip-front-proxy.yaml)
  (no `sessionAffinity`, no `externalTrafficPolicy` override —
  default 5-tuple-hash routing).
- Cluster topology:
  [tests/k8s/cluster.yaml](../../tests/k8s/cluster.yaml).
- Existing draining path:
  [src/sip-front-proxy/health/HealthProbe.ts](../../src/sip-front-proxy/health/HealthProbe.ts)
  (worker-side; proxy-side TBD by Slice 2).
- Endurance harness operator guide:
  [docs/k8s-endurance.md](../k8s-endurance.md).
