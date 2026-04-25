# SIP Front Proxy — HMAC Key Rotation Runbook

**Status:** Phase 1 (PR6). Owner: SIP Front Proxy.

The proxy uses an HMAC-SHA256 signed cookie stamped onto Record-Route
URIs to bind in-dialog requests back to the worker that handled the
original INVITE (D14 in the implementation plan, RFC 4868 §2.6 for the
truncation). This document drives an in-place key rotation **without
dropping in-flight dialogs** — NFR-8 in the spec asks for a 1 h overlap
window where both keys are accepted by `verify`.

For background on the HMAC mechanics see
[`resilience-model.md`](./resilience-model.md) §2 (timing) and
`src/sip-front-proxy/security/HmacKeyProvider.ts` (implementation).

---

## 1. When to rotate

- **Scheduled:** every 90 days per security policy.
- **Forced:** any indication the key is compromised (audit log
  exposure, accidental Secret leak, departing operator with cluster
  access). Treat all current cookies as untrusted from the moment of
  detection — finish §3 below within minutes, not hours.

---

## 2. Two-path mode (operator-driven, default in prod)

The Helm chart mounts the Secret as two files:
`/etc/sip-proxy/hmac/current` and `/etc/sip-proxy/hmac/previous`. The
proxy watches both via `node:fs.watch` (200 ms debounce) and reloads
on change. `verify` accepts either key by `kid`; `sign` always uses
the `current` key.

### Day 0 — generate the new key

1. Generate 32 bytes of CSPRNG material:

   ```bash
   head -c 32 /dev/urandom | base64
   ```

2. Patch the Kubernetes Secret to put the **new** key into
   `previous` (NOT `current` yet) — this gives every proxy pod a
   chance to pick it up via fs-watch before it becomes the signing
   key:

   ```bash
   kubectl -n sip-prod-v2 patch secret sip-proxy-hmac --type=json -p="[
     {\"op\":\"add\",\"path\":\"/data/previous\",\"value\":\"<base64 of new key>\"}
   ]"
   ```

3. Watch the proxy logs for the reload notice:

   ```
   kubernetesSecret: reloaded previous key (kid=<new-kid>)
   ```

   Every replica must log this within ~1 s of the patch (the K8s
   atomic-rename of the `..data/` symlink fires inotify on the
   leaf path the watcher is bound to).

4. **Verification.** Hand-build a test cookie with the new kid and
   send a synthetic in-dialog request through a debug pod. The proxy
   should accept it with no `sip_routing_hmac_failure_total` increment.

### Day 0 + ε (typically same hour) — promote new → current

5. Re-patch the Secret so the new key occupies `current` and the OLD
   key takes over the `previous` slot:

   ```bash
   kubectl -n sip-prod-v2 patch secret sip-proxy-hmac --type=json -p="[
     {\"op\":\"replace\",\"path\":\"/data/current\",\"value\":\"<base64 of new key>\"},
     {\"op\":\"replace\",\"path\":\"/data/previous\",\"value\":\"<base64 of old key>\"}
   ]"
   ```

6. Verify reload from logs:

   ```
   kubernetesSecret: reloaded current key (kid=<new-kid>)
   kubernetesSecret: reloaded previous key (kid=<old-kid>)
   ```

7. **Both keys are now accepted by `verify`.** New cookies are signed
   with the new key. In-flight cookies signed with the old key still
   verify. This is the NFR-8 overlap window.

### Day 1 — drop the old key

8. After **at least 1 hour** (NFR-8 minimum), confirm no traffic is
   still hitting the old kid. The metric to watch is the `kid` label
   on `sip_routing_hmac_failure_total` — if a `mismatch` count rises
   tagged with the old kid, hold here until it stops.

9. Drop `previous` from the Secret:

   ```bash
   kubectl -n sip-prod-v2 patch secret sip-proxy-hmac --type=json -p="[
     {\"op\":\"remove\",\"path\":\"/data/previous\"}
   ]"
   ```

   The proxy's fs-watch handler logs:

   ```
   kubernetesSecret: failed to reload previous key from /etc/sip-proxy/hmac/previous: ...
   ```

   This is **expected** — the file is gone. The proxy retains the
   in-memory `previous` from before the removal, so verification
   continues to accept it. To fully drop the previous key from
   memory, restart the proxy fleet:

   ```bash
   kubectl -n sip-prod-v2 rollout restart deploy/sip-front-proxy
   ```

   Roll restart is safe — proxies are stateless.

---

## 3. Single-path (compromised key — emergency mode)

When a key compromise is detected and you cannot wait for the 1 h
overlap, use the auto-rotation path. The proxy's
`kubernetesSecretLayer({ keyPath })` (no `previousKeyPath`) treats
**any change** to the watched file as "this is the new current key,
the previous current slides into the `previous` slot automatically".

1. Patch the Secret in place to a new key:

   ```bash
   kubectl -n sip-prod-v2 patch secret sip-proxy-hmac --type=json -p="[
     {\"op\":\"replace\",\"path\":\"/data/current\",\"value\":\"<base64 of new key>\"}
   ]"
   ```

2. Every proxy pod auto-slides the old key into `previous` and starts
   signing with the new key. The 1 h overlap is honoured by the
   in-memory state — the previous key is NEVER persisted to disk
   under this mode.

3. **For full eviction of the old key from memory** (compromise
   severity), follow up with a rolling restart after ~1 h:

   ```bash
   kubectl -n sip-prod-v2 rollout restart deploy/sip-front-proxy
   ```

---

## 4. Failure modes

### 4.1 Rotation while a 1xx is mid-flight

**Scenario:** the proxy received a 1xx response that's about to flow
back to the UAC. The Record-Route in the original INVITE was signed
with the OLD key. After the 1xx is delivered the UAC sends an
in-dialog re-INVITE with that OLD-key Route header.

**Outcome:** the proxy's `verify` accepts both keys during the
overlap window, so the re-INVITE is forwarded transparently. The
strategy code re-stamps any new Record-Route the response set up
with the NEW key, so subsequent cookies are signed correctly.
**No dialog drop.**

If the rotation crossed the overlap window (i.e. Day 1 has passed
and the old key is gone), the verify fails and the proxy emits a
403. The UAC will retry — typically harmless, occasionally a dialog
drop. To minimise blast radius, never collapse the overlap window
below the documented 1 h, even under compromise (move to §3 instead).

### 4.2 fs-watch missed an update

**Symptom:** Secret patched but the proxy logs show no reload.

**Causes & fixes:**

- The Helm chart's `subPath` mount bypasses the `..data/` symlink
  used by Kubelet for atomic updates. Drop `subPath` from the volume
  mount and re-deploy.
- The container's filesystem ran out of inotify watches. Increase
  `fs.inotify.max_user_watches` on the node, or rotate by rolling
  the Deployment instead of patching in place.
- Kubelet is too old to support symlink renames. Verify Kubelet ≥
  1.18.

### 4.3 Previous key file disappears

**Symptom:** `kubernetesSecret: failed to reload previous key`.

**Outcome:** the proxy retains the in-memory previous key (it never
crashes). Verification continues against the in-memory copy until
the next pod restart.

This is the expected behaviour for §2 step 9 (Day 1 cleanup). If it
happens unexpectedly, treat it as "the previous key is gone" — start
a 1 h timer, then roll-restart to evict in-memory copies.

---

## 5. Sign-off

After §2 step 9 completes (or §3 step 3 + restart in emergency mode):

- [ ] Confirm `sip_routing_hmac_failure_total` rate is at baseline.
- [ ] Update the secret-rotation log (in the SRE wiki) with the new
  kid prefix, rotation date, and operator name.
- [ ] Schedule the next rotation +90 days unless the schedule policy
  changes.
