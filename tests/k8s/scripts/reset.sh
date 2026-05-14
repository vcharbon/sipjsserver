#!/usr/bin/env bash
#
# Destroy and re-initialize the kind cluster to nominal state, regardless
# of its initial state (missing, half-installed, crashed, stuck, etc.).
#
# Composes the existing npm scripts so cluster topology / image set /
# helm-release shape stay defined in one place:
#
#   npm run test:k8s:down      → tsx tests/k8s/scripts/down.ts
#   npm run test:k8s:up        → tsx tests/k8s/scripts/up.ts
#   npm run test:k8s:images    → tsx tests/k8s/scripts/images.ts
#   npx tsx tests/k8s/scripts/install-stack.ts <namespace>
#
# Run from anywhere — the script resolves its own repo root.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

NAMESPACE="${1:-sip-test}"
VIP="${VIP:-172.20.255.250}"
VIP_PORT="${VIP_PORT:-5060}"

step() {
  printf '\n\033[1;36m==> [%s] %s\033[0m\n' "$(date +%H:%M:%S)" "$*"
}

cd "${REPO_ROOT}"

step "1/4 destroy any existing kind cluster (idempotent)"
npm run test:k8s:down

step "2/4 create kind cluster from tests/k8s/cluster.yaml"
npm run test:k8s:up

step "3/4 build sipjsserver:dev + sipp:dev, side-load redis / keepalived"
npm run test:k8s:images

step "4/4 helm-install redis, sipp, b2bua-worker, sip-front-proxy into ${NAMESPACE}"
npx tsx tests/k8s/scripts/install-stack.ts "${NAMESPACE}"

step "wait for all pods Ready"
kubectl wait --for=condition=Ready pod \
  -n "${NAMESPACE}" \
  -l 'app.kubernetes.io/name in (b2bua-worker,sip-front-proxy,redis,sipp-uas,call-control)' \
  --timeout=120s

step "final pod state"
kubectl get pods -n "${NAMESPACE}" -o wide

# Optional smoke check — local sipp must be on PATH. We're only verifying
# that the VIP answers with 100 Trying; the full call flow is exercised
# by the k8s test suite. Skip silently when sipp isn't installed.
if command -v sipp >/dev/null 2>&1; then
  step "smoke test: sipp -s uac ${VIP}:${VIP_PORT} (expect 100 Trying)"
  TMP_MSG="$(mktemp -t sipp-reset-XXXXXX.log)"
  trap 'rm -f "${TMP_MSG}"' EXIT
  if timeout 8 sipp -s uac "${VIP}:${VIP_PORT}" -m 1 -r 1 -timeout 5s \
       -trace_msg -message_file "${TMP_MSG}" -nostdin >/dev/null 2>&1; then
    if grep -q "SIP/2.0 100 Trying" "${TMP_MSG}"; then
      printf '\033[1;32m   ✓ got 100 Trying\033[0m\n'
    else
      printf '\033[1;31m   ✗ no 100 Trying observed — see %s\033[0m\n' "${TMP_MSG}"
      trap - EXIT
      exit 1
    fi
  else
    printf '\033[1;31m   ✗ sipp exited non-zero — see %s\033[0m\n' "${TMP_MSG}"
    trap - EXIT
    exit 1
  fi
else
  step "sipp not on PATH — skipping smoke check"
fi

step "cluster reset complete"
