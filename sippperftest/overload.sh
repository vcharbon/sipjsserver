#!/usr/bin/env bash
# SIPp overload test for the SIP B2BUA.
# Launches UAS + UAC in tmux. Start the B2BUA separately first.
#
# Scenarios:
#   uas-overload.xml — accepts INVITE, re-INVITE, BYE
#   uac-overload.xml — sends INVITE (with X-Api-Call routing header),
#                      accepts either 503 (overload) or full happy path
#                      with an in-dialog re-INVITE.
#
# Usage: ./overload.sh [rate] [concurrency]
#   rate        — new calls per second    (default: 100)
#   concurrency — max in-flight calls     (default: 200)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SESSION="sipp-overload"
LOG_DIR="/tmp/sipp-overload"
mkdir -p "${LOG_DIR}"

# ── Positional args ────────────────────────────────────────────────────────────
SIPP_RATE="${1:-100}"
CONCURRENCY="${2:-200}"

# ── Fixed endpoints ────────────────────────────────────────────────────────────
UAS_HOST="127.0.0.1"
UAS_PORT="5666"
UAC_HOST="127.0.0.1"
UAC_PORT="5555"
B2BUA_HOST="127.0.0.1"
B2BUA_PORT="5060"
REQUEST_USER="uas"

# ── Verify sipp is available ───────────────────────────────────────────────────
if ! command -v sipp &>/dev/null; then
  echo "ERROR: sipp not found. Install with:"
  echo "  sudo apt install sipp          # Debian/Ubuntu"
  echo "  brew install sipp              # macOS"
  exit 1
fi

echo "==> SIPp overload test"
echo "    UAS   : ${UAS_HOST}:${UAS_PORT}"
echo "    UAC   : ${UAC_HOST}:${UAC_PORT} → B2BUA ${B2BUA_HOST}:${B2BUA_PORT}"
echo "    URI   : sip:${REQUEST_USER}@${B2BUA_HOST}:${B2BUA_PORT}"
echo "    Rate  : ${SIPP_RATE} cps  concurrency=${CONCURRENCY}  (no -m cap)"
echo "    Logs  : ${LOG_DIR}"
echo ""

# ── Kill any previous session ──────────────────────────────────────────────────
tmux kill-session -t "$SESSION" 2>/dev/null || true

# ── UAS command ────────────────────────────────────────────────────────────────
UAS_CMD="sipp \
  -sf ${SCRIPT_DIR}/uas-overload.xml \
  -i ${UAS_HOST} \
  -p ${UAS_PORT} \
  -trace_err -trace_screen \
  -error_file ${LOG_DIR}/uas-errors.log \
  -screen_file ${LOG_DIR}/uas-screen.log"

# ── UAC command ────────────────────────────────────────────────────────────────
# No -m (total calls) — runs until interrupted. -rp 1000 = rate window 1s. ACK [next_url] SIP/2.0
UAC_CMD="sipp ${B2BUA_HOST}:${B2BUA_PORT} \
  -sf ${SCRIPT_DIR}/uac-overload.xml \
  -s ${REQUEST_USER} \
  -i ${UAC_HOST} \
  -p ${UAC_PORT} \
  -r ${SIPP_RATE} -rp 1000 \
  -trace_stat -trace_err -trace_screen \
  -error_file ${LOG_DIR}/uac-errors.log \
  -screen_file ${LOG_DIR}/uac-screen.log \
  -stf ${LOG_DIR}/uac-stats.csv"

# ── Create tmux session ────────────────────────────────────────────────────────
tmux new-session -d -s "$SESSION" -x 220 -y 50

# Left pane (0): UAS
tmux send-keys -t "$SESSION:0.0" \
  "echo '--- UAS ---' && cd '${SCRIPT_DIR}' && ${UAS_CMD}" Enter

# Give UAS a moment to bind before the UAC fires
sleep 0.5

# Right pane (1): UAC
tmux split-window -t "$SESSION:0.0" -h
tmux send-keys -t "$SESSION:0.1" \
  "echo '--- UAC ---' && cd '${SCRIPT_DIR}' && sleep 1 && ${UAC_CMD}; echo '--- done (exit \$?) ---'" Enter

tmux select-layout -t "$SESSION:0" even-horizontal

echo "Attaching to tmux session '${SESSION}' (Ctrl-b d to detach) ..."
tmux attach-session -t "$SESSION"
