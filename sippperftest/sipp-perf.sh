#!/usr/bin/env bash
# SIPp-based end-to-end perf test for the SIP B2BUA.
# Launches UAS and UAC side-by-side in a tmux session.
# Start the B2BUA separately before running this script.
#
# Layout:
#   ┌────────────────────┬────────────────────┐
#   │  UAS :UAS_PORT     │  UAC :UAC_PORT     │
#   │  (accepts calls)   │  (sends INVITEs)   │
#   └────────────────────┴────────────────────┘
#
# Usage: ./sipp-perf.sh [num_calls] [concurrency] [rate]
#   num_calls   — total INVITEs to send     (default: .env NUM_CALLS   or 500)
#   concurrency — max in-flight calls       (default: .env CONCURRENCY or 20)
#   rate        — new calls per second      (default: .env SIPP_RATE   or 10)
source .env
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="sipperf-sipp"

# ── Load .env ──────────────────────────────────────────────────────────────────
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

# ── CLI overrides ──────────────────────────────────────────────────────────────
[ -n "${1:-}" ] && NUM_CALLS="$1"
[ -n "${2:-}" ] && CONCURRENCY="$2"
[ -n "${3:-}" ] && SIPP_RATE="$3"

# ── Resolve config with defaults ───────────────────────────────────────────────
UAS_HOST="${UAS_HOST:-127.0.0.1}"
UAS_PORT="${UAS_PORT:-5666}"
UAC_HOST="${UAC_HOST:-127.0.0.1}"
UAC_PORT="${UAC_PORT:-5555}"
B2BUA_HOST="${B2BUA_HOST:-127.0.0.1}"
B2BUA_PORT="${B2BUA_PORT:-5060}"
NUM_CALLS="${NUM_CALLS:-1}"
CONCURRENCY="${CONCURRENCY:-200000000}"
SIPP_RATE="${SIPP_RATE:-1}"
REQUEST_USER="${REQUEST_USER:-uas}"

# ── Verify sipp is available ───────────────────────────────────────────────────
if ! command -v sipp &>/dev/null; then
  echo "ERROR: sipp not found. Install with:"
  echo "  sudo apt install sipp          # Debian/Ubuntu"
  echo "  brew install sipp              # macOS"
  exit 1
fi

echo "==> SIPp perf test"
echo "    UAS  : ${UAS_HOST}:${UAS_PORT}  (accepts calls from B2BUA)"
echo "    UAC  : ${UAC_HOST}:${UAC_PORT}  → B2BUA ${B2BUA_HOST}:${B2BUA_PORT}"
echo "    URI  : sip:${REQUEST_USER}@${B2BUA_HOST}:${B2BUA_PORT}"
echo "    Calls: ${NUM_CALLS}  concurrency=${CONCURRENCY}  rate=${SIPP_RATE} cps"
echo ""

# ── Kill any previous session ──────────────────────────────────────────────────
tmux kill-session -t "$SESSION" 2>/dev/null || true

# ── UAS command ────────────────────────────────────────────────────────────────
# Built-in 'uas' scenario: waits for INVITE, replies 180 Ringing + 200 OK,
# waits for ACK, then sends BYE and expects 200 OK -sf ${SCRIPT_DIR}/uas.xml or --sn uas
UAS_CMD="sipp \
  -sf ${SCRIPT_DIR}/uas.xml \
  -i ${UAS_HOST} \
  -p ${UAS_PORT} \
  -trace_err \
  -error_file /tmp/sipp_uas_errors.log"

# ── UAC command ────────────────────────────────────────────────────────────────
# Built-in 'uac' scenario: sends INVITE to B2BUA, waits for 200 OK,
# sends ACK, waits briefly, sends BYE, expects 200 OK.
# -s sets the Request-URI user part (sip:<REQUEST_USER>@<remote>). 
#  -sf ${SCRIPT_DIR}/uac.xml \
UAC_CMD="sipp ${B2BUA_HOST}:${B2BUA_PORT} \
  -sf ${SCRIPT_DIR}/uac.xml  \
  -s ${REQUEST_USER} \
  -i ${UAC_HOST} \
  -p ${UAC_PORT} \
  -r ${SIPP_RATE} \
  -trace_stat \
  -trace_err \
  -error_file /tmp/sipp_uac_errors.log \
  -stf /tmp/sipp_uac_stats.csv"

# ── Create tmux session ────────────────────────────────────────────────────────
tmux new-session -d -s "$SESSION" -x 220 -y 50

# Left pane (0): UAS — start first so it is ready before the UAC fires
tmux send-keys -t "$SESSION:0.0" \
  "echo '--- UAS ---' && cd '${SCRIPT_DIR}' && ${UAS_CMD} " Enter

# Give UAS a moment to bind before the UAC connects
sleep 0.5

# Right pane (1): UAC
tmux split-window -t "$SESSION:0.0" -h
tmux send-keys -t "$SESSION:0.1" \
  "echo '--- UAC ---' && cd '${SCRIPT_DIR}' && sleep 1 && ${UAC_CMD}; echo '--- done (exit $?) ---'" Enter

tmux select-layout -t "$SESSION:0" even-horizontal

echo "Attaching to tmux session '${SESSION}' (Ctrl-b d to detach) ..."
tmux attach-session -t "$SESSION"
