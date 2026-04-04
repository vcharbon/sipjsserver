# TODO: Detect Port Collisions in Simulated Transport

## Problem

In `tests/e2e/framework/simulated-backend.ts`, the `addrToAgent` map (`Map<string, string>`) maps `ip:port` to a single agent name. When two agents share the same port (e.g. bob1 and bob3 both on port 5666), the last registration silently overwrites the first. The earlier agent stops receiving any messages with no error or warning.

This caused a hard-to-diagnose parallel test failure: bob1 timed out on all expects while bob3 worked fine, because `127.0.0.1:5666` pointed only to bob3.

## Resolution

### What was implemented

1. **Fail-fast on port collision**: `setup()` now throws immediately when two agents register the same `ip:port`, with a clear error message naming both agents.

2. **Call-ID demuxing**: Replaced the `addrToAgent` map with `callIdToAgent: Map<string, string>`. Routing is now by SIP Call-ID:
   - **A-side (agent → B2BUA)**: When an agent sends a packet, the transport parses it and maps `callId → agentName`.
   - **B-side (B2BUA → agent)**: When the B2BUA sends outbound, the transport looks up the Call-ID. If unknown, it checks for an `X-Test-Agent` header (set via `update_headers` in the routing response). Falls back to address-based routing if only one agent is at that address.
   - **Error on ambiguity**: If no mapping exists and multiple agents share an address, throws with a clear error.

3. **Header transparency in MessageFactory**: The B2BUA now copies all non-structural headers transparently from inbound to outbound messages. Structural headers (Via, Contact, From, To, Call-ID, CSeq, Max-Forwards, Content-Length, Record-Route, Route) are managed by the B2BUA; everything else passes through. This allows `X-Test-Agent` (and any other custom header) to flow end-to-end.

4. **Mock server update_headers passthrough**: The `/call/failure` handler now forwards `update_headers` from the failover instruction, enabling `X-Test-Agent` to be set on failover legs.

### Known limitation: shared ip:port blocked

Agents sharing the same `ip:port` causes a B2BUA fiber scheduling issue where the Effect runtime fails to wake the packet-processing fiber when `Queue.offerUnsafe` is called. The root cause is not fully diagnosed (it may be related to TransactionLayer client/server transactions sharing the same remote address). For now, the fail-fast check prevents this from being hit silently.

### Future: Multi-agent demuxing (Option B)

To support multiple agents on the same `ip:port` (e.g. testing "multiple calls to the same destination"), the fiber scheduling issue must be resolved first. The demux infrastructure (Call-ID mapping, X-Test-Agent header, address fallback) is already in place — only the shared-port fiber starvation blocks it.
