Plan 1 — SIP Front Proxy (UDP-only, Phase 1)

1. Purpose and Scope

Build a stateless SIP front proxy that distributes calls to a pool of B2BUA workers, with deterministic routing, dialog stickiness, and graceful handling of worker failures. Phase 1 is UDP-only; TLS, TCP, and WSS support are explicitly deferred to Phase 2+.
Out of scope for Phase 1:

TLS/TCP/WSS transports
SIP Outbound (RFC 5626) — not needed without persistent connections
Path header (RFC 3327) — Phase 2 with TLS
Registrar functionality (proxy is purely transit)
Media handling (RTP flows direct UA-to-UA or via separate media relay, out of scope)
Authentication (handled by workers or downstream)

2. Functional Requirements
2.1 Routing

FR-1 Route initial INVITE to a worker via consistent hashing on Call-ID.
FR-2 Insert a single Record-Route header on every initial dialog-creating request (INVITE, SUBSCRIBE, REFER out-of-dialog), containing:

Loose routing parameter (;lr)
Worker assignment cookie (;w=<worker_id>)
Cookie version (;v=1)
HMAC signature (;sig=<truncated_hmac>) over (call_id || worker_id || version)


FR-3 Route in-dialog requests (ACK on 2xx, BYE, re-INVITE, UPDATE, INFO, REFER, NOTIFY) by reading the top Route header:

Verify HMAC; reject with 403 on mismatch
Extract w= parameter, forward to that worker
Strip the top Route from the message before forwarding (loose routing per RFC 3261 §16.4)


FR-4 On worker assignment failure (worker dead per health check), fall back to consistent hash ring excluding dead workers, and forward; the new worker hydrates dialog state from Redis if needed.
FR-5 Handle ACK on non-2xx responses via standard transaction layer (hop-by-hop, follows INVITE path).

2.2 CANCEL Handling

FR-6 Maintain a local LRU cache of (branch parameter → worker_id) for in-flight INVITE transactions, TTL 64 × T1 (default 32s).
FR-7 On CANCEL, look up branch in LRU; if found, forward to same worker; if not found, drop with 481 Call/Transaction Does Not Exist.

2.3 Cluster Behavior

FR-8 Multiple proxy instances run active/active. Each instance must produce identical routing decisions for the same input message (pure function of message + shared config).
FR-9 Worker membership (alive/dead) is sourced from a shared registry (etcd, Consul, or Kubernetes API watch). Update propagation target: <5s across all proxies.
FR-10 HMAC signing key is shared across all proxy instances, distributed via Kubernetes Secret.

- the clustering behavior must be absrtacted in a effect layer (must cluster the 'worker to worker id' mapping)

2.4 Health and Liveness

FR-11 Active health checks toward each worker via SIP OPTIONS keepalive every 2s. Three consecutive failures (configurable) mark worker as dead.
FR-12 Expose Prometheus metrics endpoint on a separate HTTP port (not on SIP port).
FR-13 Expose readiness and liveness endpoints for Kubernetes probes.

- strategy to maintain worker list as an independant layer

2.5 Resharding

FR-14 When a worker is added or removed, the consistent hash ring updates atomically. Existing dialogs continue to be routed via their Record-Route cookie (no impact). Only new dialogs are affected by ring change.
FR-15 Use a hash ring algorithm with bounded redistribution: rendezvous hashing or a Ketama-style ring (~150 vnodes per worker).


3. Non-Functional Requirements
3.1 Performance

NFR-1 P99 latency for routing decision and forward: <2 ms per message under steady load.
NFR-2 Throughput per instance: ≥10,000 SIP messages/second on 4 vCPU.
NFR-3 Memory footprint per instance: <512 MB at 100k concurrent dialogs.
NFR-4 Cold start time: <3s from process start to ready.

3.2 Reliability

NFR-5 No single point of failure. Minimum 2 proxy instances behind a VIP (keepalived) or DNS SRV with multiple records.
NFR-6 Loss of one proxy instance must not drop in-flight calls (other instances handle equivalent routing via stateless function).
NFR-7 Loss of one worker drops only that worker's dialogs; recovery via Redis hydration on reassigned worker is best-effort.

3.3 Security

NFR-8 HMAC truncated to 12 characters (96 bits), SHA-256 base. Rotation supported with overlap window (accept old + new key for 1 hour).
NFR-9 Reject malformed SIP messages early (parse-time validation), no propagation to workers.
NFR-10 Source IP allowlist optional (configurable), enforced at proxy level.
NFR-11 Maximum message size 10 KB; reject larger with 513 Message Too Large.

3.4 Observability

NFR-12 Structured logging (JSON), with correlation by Call-ID.
NFR-13 Per-message tracing (OpenTelemetry) with sampling configurable (default 1%).
NFR-14 Metrics exposed:

sip_messages_total{method,direction,response_code}
sip_routing_duration_seconds (histogram)
sip_routing_decision_total{source="cookie|hash|fallback"}
sip_routing_hmac_failure_total
sip_worker_health{worker_id,state}
sip_cancel_lookup_total{result="hit|miss"}
sip_active_dialogs_estimate (best-effort gauge)



4. Technical Constraints

TC-1 Implementation language: Node.js or Bun (consistent with existing worker stack).
TC-3 UDP socket: dgram module, single socket bound per instance with SO_REUSEPORT for multi-process scaling.
TC-4 No persistent storage on the proxy; all state is either local-ephemeral (LRU for branches) or derived from message content.
TC-5 Configuration via environment variables and Kubernetes ConfigMap; HMAC key via Secret.

5. Message Flow Specifications
5.1 Initial INVITE (UAC → Worker)
1. Receive INVITE on UDP port
2. Parse top Via, Call-ID, Request-URI
3. If Top Via has rport=, record source IP/port for response routing
4. Compute worker = hash_ring.get(call_id), excluding dead workers
5. Build cookie: w=<id>;v=1;sig=<hmac>
6. Prepend Record-Route: <sip:<proxy_host>:<port>;lr;<cookie>>
7. Add own Via header (top), with branch starting "z9hG4bK"
8. Forward UDP datagram to worker:port
5.2 In-Dialog Request (e.g., BYE)
1. Receive BYE on UDP port
2. Parse top Route header
3. Validate Route hostname/port matches own identity
4. Verify HMAC signature
5. Extract w=<worker_id>
6. Remove top Route from message
7. Add own Via header (top)
8. Forward to worker:port (worker may be different instance from initial; that's fine)
5.3 Response (e.g., 200 OK)
1. Receive 200 OK on UDP port from worker
2. Parse Via list; top Via should be the proxy's own
3. Pop top Via
4. Forward UDP datagram to next Via's sent-by (with rport handling)
5. No Route/Record-Route processing on responses
5.4 CANCEL
1. Receive CANCEL on UDP port
2. Extract branch from top Via
3. Lookup LRU: branch → worker_id
4. If hit: forward to worker (same as the INVITE's worker)
5. If miss: respond 481 Call/Transaction Does Not Exist
6. Configuration Schema
yamlproxy:
  bind:
    address: 0.0.0.0
    port: 5060
  identity:
    advertised_host: proxy.example.com
    advertised_port: 5060
  workers:
    discovery: kubernetes  # or static, etcd
    namespace: sip
    selector: app=b2bua-worker
    health_check:
      method: OPTIONS
      interval_seconds: 2
      failure_threshold: 3
  hash_ring:
    algorithm: rendezvous
  hmac:
    key_secret_ref: sip-proxy-hmac-key
    truncate_chars: 12
    rotation_overlap_seconds: 3600
  cancel_cache:
    max_entries: 100000
    ttl_seconds: 32
  observability:
    metrics_port: 9090
    log_level: info
    tracing_sample_rate: 0.01
7. Acceptance Criteria

AC-1 End-to-end call establishment and teardown via SIPp scenarios (UAC + UAS) succeed at 100 calls/sec sustained for 10 minutes, 0 drops.
AC-2 Killing one proxy instance during load test causes 0 dropped calls (other instance(s) absorb traffic).
AC-3 Killing one worker during load test drops only calls assigned to that worker (≤1/N of active calls); recovered calls via Redis hydration: ≥95% within 10s.
AC-4 HMAC tampering test: forged top Route with invalid sig is rejected with 403, no forwarding occurs, metric increments.
AC-5 Resharding test: adding a new worker mid-load does not affect existing dialogs; new dialogs distribute across enlarged pool within 5s.
AC-6 P99 routing latency under 2 ms at 5,000 messages/sec, measured by sip_routing_duration_seconds.
AC-7 Memory stable (no leak) over 24-hour soak test at 1,000 calls/sec.

8. Phase 2+ Deferred Items (Reference)
These are explicitly not in Phase 1 but should not be designed against:

TLS termination and persistent connection management
SIP Outbound (RFC 5626): flow-token, +sip.instance, reg-id
Path header (RFC 3327) for registrar interaction
Multiple Record-Route (RFC 5658) for transport transition
TCP transport (RFC 3261 §18.1.1 large-message fallback)
WebSocket transport (RFC 7118)
mTLS client cert authentication
NAT traversal (rport, force-rport) — minimal handling only in Phase 1

9. Risks and Mitigations
RiskImpactMitigationHash ring inconsistency across proxies during membership changeMisrouted messagesAtomic ring updates from single source (etcd/K8s watch); cookie absorbs in-flight transitionsHMAC key rotation desyncRouting failuresOverlap window with dual-key acceptanceUDP packet loss (no retransmit at proxy)Higher RTX from UAsWorkers handle SIP retransmissions; proxy is stateless transitLRU cache full under burst CANCEL loadCANCELs misroutedSize cache for 10× peak INVITE rate; metric on eviction rateProxy hostname in Record-Route resolves to wrong IPIn-dialog routing breaksUse IP literal or strict DNS; document advertised_host requirement
10. Deliverables

D-1 Proxy implementation (Node.js/Bun) with unit and integration tests
D-2 Helm chart for Kubernetes deployment
D-3 SIPp test scenarios (initial call, re-INVITE, CANCEL, BYE)
D-4 Grafana dashboard with metrics from §3.4
D-5 Runbook (rotation of HMAC key, worker pool scaling, troubleshooting)
D-6 Architecture decision record (ADR) documenting key choices