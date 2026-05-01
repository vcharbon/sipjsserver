#!/usr/bin/env bash
# Memory leak detection harness for the SIP B2BUA.
#
# Two modes:
#   single  (default) — Run the B2BUA as a local process; verify no leak
#                        in the worker processes themselves. Best for
#                        quick "did I just regress" checks.
#   k8s              — Bring up the kind cluster + helm stack and route
#                        load through the in-cluster sip-front-proxy
#                        (load balancer) → b2bua-worker → sipp-uas. Full
#                        view including the LB. Delegates to
#                        memleak-test-k8s.sh.
#
# Flow (single mode):
#   1. Flush Redis
#   2. Build & launch B2BUA with memory caps + --expose-gc
#   3. Run a short warmup SIPp load → capture baseline memory
#   4. Run a longer stress SIPp load → capture stress memory
#   5. Stop B2BUA → verify Redis residual keys
#   6. Compare baseline vs stress → print report
#
# Usage:
#   ./memleak-test.sh [--heap-dump]                     # single (default)
#   ./memleak-test.sh --mode k8s [--heap-dump] [--keep] # full LB + workers
#
# Configuration via env vars (see defaults below).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="/tmp/memleak-results/$(date +%Y%m%d-%H%M%S)"

# ── Mode dispatch (must run before flag parsing so we can hand off
#    unrecognised flags to the k8s sub-script untouched) ────────────
MODE="single"
PASSTHROUGH=()
while [ $# -gt 0 ]; do
  case "$1" in
    --mode)
      MODE="${2:-}"; shift 2
      ;;
    --mode=*)
      MODE="${1#--mode=}"; shift
      ;;
    *)
      PASSTHROUGH+=("$1"); shift
      ;;
  esac
done
set -- "${PASSTHROUGH[@]}"

if [ "$MODE" = "k8s" ]; then
  exec "$SCRIPT_DIR/memleak-test-k8s.sh" "$@"
elif [ "$MODE" != "single" ]; then
  echo "ERROR: unknown --mode '$MODE'. Expected 'single' or 'k8s'."
  exit 1
fi

# ── Configuration ────────────────────────────────────────────────────
UAS_HOST="${UAS_HOST:-127.0.0.1}"
UAS_PORT="${UAS_PORT:-5666}"
UAC_HOST="${UAC_HOST:-127.0.0.1}"
UAC_PORT="${UAC_PORT:-5555}"
B2BUA_HOST="${B2BUA_HOST:-127.0.0.1}"
B2BUA_PORT="${B2BUA_PORT:-5060}"
REQUEST_USER="${REQUEST_USER:-uas}"
STATUS_URL="http://${B2BUA_HOST}:3002"

WARMUP_CALLS="${WARMUP_CALLS:-1000}"
STRESS_CALLS="${STRESS_CALLS:-50000}"
RATE="${RATE:-200}"
CLUSTER_WORKERS="${CLUSTER_WORKERS:-2}"
WORKER_MAX_HEAP_MB="${WORKER_MAX_HEAP_MB:-600}"
DRAIN_TIMEOUT=60  # seconds — hard cap on drain wait

SIPP_TIMEOUT_BUFFER="${SIPP_TIMEOUT_BUFFER:-60}"  # extra seconds beyond expected duration
HEAP_DUMP=0

# ── Parse CLI flags ──────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --heap-dump) HEAP_DUMP=1 ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Verify prerequisites ────────────────────────────────────────────
for cmd in sipp redis-cli curl python3 jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd not found. Please install it."
    exit 1
  fi
done

# ── Cleanup handler ─────────────────────────────────────────────────
B2BUA_PID=""
UAS_PID=""
COLLECTOR_PID=""
PROFILE_PID=""

cleanup() {
  echo ""
  echo "==> Cleaning up..."
  [ -n "$COLLECTOR_PID" ] && kill "$COLLECTOR_PID" 2>/dev/null || true
  [ -n "$PROFILE_PID" ] && kill "$PROFILE_PID" 2>/dev/null || true
  [ -n "$UAS_PID" ] && kill "$UAS_PID" 2>/dev/null || true
  if [ -n "$B2BUA_PID" ]; then
    kill "$B2BUA_PID" 2>/dev/null || true
    # Wait up to 10s for graceful exit, then SIGKILL
    for i in $(seq 1 10); do
      if ! kill -0 "$B2BUA_PID" 2>/dev/null; then break; fi
      sleep 1
    done
    kill -9 "$B2BUA_PID" 2>/dev/null || true
  fi
  # Kill any straggling sipp processes we started
  pkill -f "sipp.*${UAC_PORT}" 2>/dev/null || true
  pkill -f "sipp.*${UAS_PORT}" 2>/dev/null || true
}
trap cleanup EXIT

# ── Helper: wait for calls to drain (with hard cap) ─────────────────
wait_drain() {
  local label="$1"
  local deadline=$((SECONDS + DRAIN_TIMEOUT))
  echo "    Waiting for calls to drain (max ${DRAIN_TIMEOUT}s)..."
  while [ $SECONDS -lt $deadline ]; do
    local concurrent
    concurrent=$(curl -sf "$STATUS_URL/status" 2>/dev/null | jq -r '.concurrent // 0' 2>/dev/null || echo "?")
    if [ "$concurrent" = "0" ]; then
      echo "    All calls drained for $label."
      return 0
    fi
    echo "    $label: concurrent=$concurrent — waiting..."
    sleep 2
  done
  echo "    WARNING: drain timeout reached for $label (${DRAIN_TIMEOUT}s). Proceeding anyway."
  return 0
}

# ══════════════════════════════════════════════════════════════════════
echo "================================================================"
echo "  MEMORY LEAK DETECTION HARNESS"
echo "================================================================"
echo "  Warmup  : ${WARMUP_CALLS} calls @ ${RATE} cps"
echo "  Stress  : ${STRESS_CALLS} calls @ ${RATE} cps"
echo "  Workers : ${CLUSTER_WORKERS}"
echo "  Heap cap: ${WORKER_MAX_HEAP_MB} MB"
echo "  Results : ${RESULTS_DIR}"
echo "================================================================"
echo ""

mkdir -p "$RESULTS_DIR"

# Clean stale heap snapshots and CPU profiles from previous runs
rm -rf /tmp/heapdumps /tmp/cpuprofiles
mkdir -p /tmp/heapdumps /tmp/cpuprofiles

# ── Step 1: Flush Redis ──────────────────────────────────────────────
echo "==> Step 1: Flushing Redis..."
redis-cli FLUSHDB > /dev/null
echo "    Redis flushed."

# ── Step 2: Build project ───────────────────────────────────────────
echo "==> Step 2: Building project..."
cd "$PROJECT_DIR"
npm run build --silent 2>&1 | tail -3
echo "    Build complete."

# ── Step 3: Start B2BUA ─────────────────────────────────────────────
echo "==> Step 3: Starting B2BUA (workers=${CLUSTER_WORKERS}, heap=${WORKER_MAX_HEAP_MB}MB)..."
NODE_OPTIONS="--max-old-space-size=${WORKER_MAX_HEAP_MB} --expose-gc" \
  B2BUA_EXPOSE_GC=1 \
  CLUSTER_WORKERS="$CLUSTER_WORKERS" \
  EFFECT_LOG_LEVEL=Warn \
  node --env-file=.env dist/main.js &
B2BUA_PID=$!
echo "    B2BUA PID: $B2BUA_PID"

# ── Step 4: Wait for server ready ───────────────────────────────────
echo "==> Step 4: Waiting for B2BUA to be ready..."
for i in $(seq 1 30); do
  if curl -sf "$STATUS_URL/status" > /dev/null 2>&1; then
    echo "    B2BUA ready."
    break
  fi
  if [ "$i" -eq 30 ]; then
    echo "    ERROR: B2BUA did not become ready in 30s."
    exit 1
  fi
  sleep 1
done

# ── Step 5: Start UAS ───────────────────────────────────────────────
echo "==> Step 5: Starting UAS..."
# UAS runs as a background job (no -bg daemon) so we can kill it later
sipp \
  -sf "$SCRIPT_DIR/uas.xml" \
  -i "$UAS_HOST" \
  -p "$UAS_PORT" \
  -trace_err \
  -error_file "$RESULTS_DIR/uas-errors.log" \
  > /dev/null 2>&1 &
UAS_PID=$!
sleep 1
echo "    UAS started (PID: $UAS_PID)."

# ── Step 6: Run warmup SIPp ─────────────────────────────────────────
WARMUP_TIMEOUT=$(( SIPP_TIMEOUT_BUFFER + WARMUP_CALLS / RATE ))
echo "==> Step 6: Running warmup (${WARMUP_CALLS} calls @ ${RATE} cps, timeout ${WARMUP_TIMEOUT}s)..."
# Run in foreground — blocks until all calls complete
sipp "$B2BUA_HOST:$B2BUA_PORT" \
  -sf "$SCRIPT_DIR/uac.xml" \
  -s "$REQUEST_USER" \
  -i "$UAC_HOST" \
  -p "$UAC_PORT" \
  -m "$WARMUP_CALLS" \
  -r "$RATE" -rp 1000 \
  -timeout "$WARMUP_TIMEOUT" \
  -trace_stat \
  -stf "$RESULTS_DIR/warmup-stats.csv" \
  -trace_err \
  -error_file "$RESULTS_DIR/warmup-errors.log" \
  > /dev/null 2>&1 || true
echo "    Warmup SIPp finished."

# ── Step 7: Wait for drain ──────────────────────────────────────────
echo "==> Step 7: Draining warmup calls..."
wait_drain "warmup"

# ── Step 8: Capture baseline ────────────────────────────────────────
echo "==> Step 8: Waiting 60s for transactions to fully expire before baseline..."
sleep 60
echo "    Capturing baseline memory..."
curl -sf -X POST "$STATUS_URL/debug/gc" > /dev/null 2>&1 || true
sleep 2
curl -sf "$STATUS_URL/debug/memory" > "$RESULTS_DIR/baseline-memory.json" 2>/dev/null
echo "    Baseline saved to baseline-memory.json"

# Baseline heap snapshot (before stress)
if [ "$HEAP_DUMP" -eq 1 ]; then
  echo "    Triggering baseline heap snapshot..."
  curl -sf -X POST "$STATUS_URL/debug/heap-snapshot" > /dev/null 2>&1 || true
  sleep 5  # give workers time to write large snapshot files
  echo "    Baseline heap snapshots written."
  # Rename baseline snapshots so they don't get overwritten by stress snapshots
  for f in /tmp/heapdumps/heap-*.heapsnapshot; do
    [ -f "$f" ] && mv "$f" "${f%.heapsnapshot}.baseline.heapsnapshot"
  done
fi

# ── Step 9: Run stress SIPp ─────────────────────────────────────────
STRESS_TIMEOUT=$(( SIPP_TIMEOUT_BUFFER + STRESS_CALLS / RATE ))
echo "==> Step 9: Running stress test (${STRESS_CALLS} calls @ ${RATE} cps, timeout ${STRESS_TIMEOUT}s)..."
echo "    Estimated duration: ~$((STRESS_CALLS / RATE))s"

# Start background memory collector (echo adds newline between JSON records)
(
  while true; do
    curl -sf "$STATUS_URL/debug/memory" 2>/dev/null >> "$RESULTS_DIR/memory-timeseries.jsonl" && \
      echo >> "$RESULTS_DIR/memory-timeseries.jsonl" || true
    sleep 2
  done
) &
COLLECTOR_PID=$!

# Background: trigger CPU profile after load stabilizes (~30% into stress run)
STABILIZE_WAIT=$(( STRESS_CALLS / RATE * 30 / 100 ))
CPU_PROFILE_DURATION=10
(
  sleep "$STABILIZE_WAIT"
  echo "    Triggering ${CPU_PROFILE_DURATION}s CPU profile mid-stress..."
  curl -sf -X POST "$STATUS_URL/debug/cpu-profile" > /dev/null 2>&1 || true
) &
PROFILE_PID=$!

# Run in foreground — blocks until all calls complete
sipp "$B2BUA_HOST:$B2BUA_PORT" \
  -sf "$SCRIPT_DIR/uac.xml" \
  -s "$REQUEST_USER" \
  -i "$UAC_HOST" \
  -p "$UAC_PORT" \
  -m "$STRESS_CALLS" \
  -r "$RATE" -rp 1000 \
  -timeout "$STRESS_TIMEOUT" \
  -trace_stat \
  -stf "$RESULTS_DIR/stress-stats.csv" \
  -trace_err \
  -error_file "$RESULTS_DIR/stress-errors.log" \
  > /dev/null 2>&1 || true
echo "    Stress SIPp finished."

# ── Step 10: Wait for drain ─────────────────────────────────────────
echo "==> Step 10: Draining stress calls..."
wait_drain "stress"

# Stop memory collector and profile trigger
kill "$COLLECTOR_PID" 2>/dev/null || true
COLLECTOR_PID=""
wait "$PROFILE_PID" 2>/dev/null || true

# Copy CPU profiles to results dir (written to /tmp/cpuprofiles/ by the server)
if ls /tmp/cpuprofiles/*.cpuprofile 1>/dev/null 2>&1; then
  cp /tmp/cpuprofiles/*.cpuprofile "$RESULTS_DIR/" 2>/dev/null || true
  echo "    CPU profiles copied to results dir."
fi

# ── Step 11: Capture stress snapshot ────────────────────────────────
echo "==> Step 11: Waiting 60s for transactions to fully expire before stress snapshot..."
sleep 60
echo "    Capturing stress memory..."
curl -sf -X POST "$STATUS_URL/debug/gc" > /dev/null 2>&1 || true
sleep 2
curl -sf "$STATUS_URL/debug/memory" > "$RESULTS_DIR/stress-memory.json" 2>/dev/null
echo "    Stress snapshot saved to stress-memory.json"

# ── Step 12: Optional heap dump + analysis ─────────────────────────
if [ "$HEAP_DUMP" -eq 1 ]; then
  echo "==> Step 12: Triggering stress heap snapshot..."
  curl -sf -X POST "$STATUS_URL/debug/heap-snapshot" > /dev/null 2>&1 || true
  sleep 5  # give workers time to write large snapshot files
  echo "    Stress heap snapshots written."

  # Copy all snapshots to results dir for archival
  cp /tmp/heapdumps/heap-*.heapsnapshot "$RESULTS_DIR/" 2>/dev/null || true

  # Run diff analysis for each worker that has both baseline and stress
  echo ""
  echo "==> Heap snapshot analysis..."
  for baseline_file in "$RESULTS_DIR"/heap-worker-*.baseline.heapsnapshot; do
    [ -f "$baseline_file" ] || continue
    # Derive the stress filename: heap-worker-0-<ts>.baseline.heapsnapshot → heap-worker-0-<ts2>.heapsnapshot
    worker_id=$(echo "$baseline_file" | grep -oP 'worker-\d+')
    stress_file=$(ls "$RESULTS_DIR"/heap-${worker_id}-*.heapsnapshot 2>/dev/null | grep -v baseline | head -1)
    if [ -n "$stress_file" ] && [ -f "$stress_file" ]; then
      echo "    Comparing $worker_id: baseline vs stress"
      node "$SCRIPT_DIR/analyze-heap.mjs" "$baseline_file" "$stress_file" 2>/dev/null || true
      echo ""
    fi
  done

  # Also analyze master if available
  master_baseline=$(ls "$RESULTS_DIR"/heap-master-*.baseline.heapsnapshot 2>/dev/null | head -1)
  master_stress=$(ls "$RESULTS_DIR"/heap-master-*.heapsnapshot 2>/dev/null | grep -v baseline | head -1)
  if [ -n "$master_baseline" ] && [ -n "$master_stress" ] && [ -f "$master_baseline" ] && [ -f "$master_stress" ]; then
    echo "    Comparing master: baseline vs stress"
    node "$SCRIPT_DIR/analyze-heap.mjs" "$master_baseline" "$master_stress" 2>/dev/null || true
    echo ""
  fi
fi

# ── Step 13: Stop B2BUA ─────────────────────────────────────────────
echo "==> Step 13: Stopping B2BUA..."
kill "$B2BUA_PID" 2>/dev/null || true
for i in $(seq 1 10); do
  if ! kill -0 "$B2BUA_PID" 2>/dev/null; then break; fi
  sleep 1
done
kill -9 "$B2BUA_PID" 2>/dev/null || true
B2BUA_PID=""
echo "    B2BUA stopped."

# ── Step 14: Redis residual key verification ────────────────────────
echo "==> Step 14: Checking Redis for residual keys..."
REDIS_PREFIX="${REDIS_KEY_PREFIX:-sipas}"
CALL_KEYS=$(redis-cli --scan --pattern "${REDIS_PREFIX}:call:*" 2>/dev/null | wc -l)
LEG_KEYS=$(redis-cli --scan --pattern "${REDIS_PREFIX}:leg:*" 2>/dev/null | wc -l)
CTX_KEYS=$(redis-cli --scan --pattern "${REDIS_PREFIX}:ctx:*" 2>/dev/null | wc -l)
LIMITER_KEYS=$(redis-cli --scan --pattern "${REDIS_PREFIX}:limiter:*" 2>/dev/null | wc -l)

{
  echo "  ${REDIS_PREFIX}:call:*     = $CALL_KEYS"
  echo "  ${REDIS_PREFIX}:leg:*      = $LEG_KEYS"
  echo "  ${REDIS_PREFIX}:ctx:*      = $CTX_KEYS"
  echo "  ${REDIS_PREFIX}:limiter:*  = $LIMITER_KEYS"
} | tee "$RESULTS_DIR/redis-residual.txt"

REDIS_TOTAL=$((CALL_KEYS + LEG_KEYS + CTX_KEYS + LIMITER_KEYS))
if [ "$REDIS_TOTAL" -gt 0 ]; then
  echo "    *** REDIS LEAK: $REDIS_TOTAL residual keys found after shutdown"
else
  echo "    Redis clean — all keys removed."
fi

# ── Step 15: Compare and report ─────────────────────────────────────
echo ""
echo "==> Step 15: Generating comparison report..."
echo ""

python3 - "$RESULTS_DIR" "$WARMUP_CALLS" "$STRESS_CALLS" "$RATE" <<'PYEOF'
import json, sys, os

results_dir = sys.argv[1]
warmup_calls = int(sys.argv[2])
stress_calls = int(sys.argv[3])
rate = int(sys.argv[4])

def load_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception as e:
        print(f"WARNING: Could not load {path}: {e}")
        return None

baseline = load_json(os.path.join(results_dir, "baseline-memory.json"))
stress = load_json(os.path.join(results_dir, "stress-memory.json"))

if not baseline or not stress:
    print("ERROR: Missing memory snapshot files. Cannot generate report.")
    sys.exit(1)

def mb(b):
    return b / 1048576

print("=" * 70)
print("  MEMORY LEAK DETECTION REPORT")
print("=" * 70)
print(f"  Warmup : {warmup_calls} calls @ {rate} cps")
print(f"  Stress : {stress_calls} calls @ {rate} cps")
print()

# ── Master process memory ────────────────────────────────────────
print("  MASTER PROCESS MEMORY (MB)")
print("  " + "-" * 66)
b_mem = baseline.get("process", {}).get("memory", {})
s_mem = stress.get("process", {}).get("memory", {})
for k in ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"]:
    b = mb(b_mem.get(k, 0))
    s = mb(s_mem.get(k, 0))
    d = s - b
    pct = (d / b * 100) if b > 0 else 0
    flag = " *** LEAK?" if d > 10 and pct > 20 else ""
    print(f"    {k:20s}  baseline={b:8.1f}  stress={s:8.1f}  delta={d:+8.1f}  ({pct:+.1f}%){flag}")

# ── Per-worker memory ────────────────────────────────────────────
b_workers = [w for w in baseline.get("workers", []) if w.get("status") == "ok"]
s_workers = [w for w in stress.get("workers", []) if w.get("status") == "ok"]

for i in range(max(len(b_workers), len(s_workers))):
    bw = b_workers[i] if i < len(b_workers) else {}
    sw = s_workers[i] if i < len(s_workers) else {}
    bm = bw.get("memory", {})
    sm = sw.get("memory", {})

    print()
    print(f"  WORKER {bw.get('worker', sw.get('worker', i))} MEMORY (MB)")
    print("  " + "-" * 66)
    for k in ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"]:
        b = mb(bm.get(k, 0))
        s = mb(sm.get(k, 0))
        d = s - b
        pct = (d / b * 100) if b > 0 else 0
        flag = " *** LEAK?" if d > 10 and pct > 20 else ""
        print(f"    {k:20s}  baseline={b:8.1f}  stress={s:8.1f}  delta={d:+8.1f}  ({pct:+.1f}%){flag}")

    bs = bw.get("mapSizes", {})
    ss = sw.get("mapSizes", {})
    print()
    print(f"  WORKER {bw.get('worker', sw.get('worker', i))} MAP SIZES (entries)")
    print("  " + "-" * 66)
    for k in ["txnMap", "callsMap", "sipIndex", "semaphores", "fibersMap"]:
        b = bs.get(k, 0)
        s = ss.get(k, 0)
        d = s - b
        flag = " *** LEAK?" if d > 10 else ""
        print(f"    {k:20s}  baseline={b:8d}  stress={s:8d}  delta={d:+8d}{flag}")

# ── Redis residual ───────────────────────────────────────────────
print()
redis_file = os.path.join(results_dir, "redis-residual.txt")
if os.path.exists(redis_file):
    print("  REDIS RESIDUAL KEYS")
    print("  " + "-" * 66)
    with open(redis_file) as f:
        for line in f:
            print("   ", line.rstrip())

# ── Verdict ──────────────────────────────────────────────────────
print()
leak_flags = []

# Check worker maps
for i, sw in enumerate(s_workers):
    bw = b_workers[i] if i < len(b_workers) else {}
    bs = bw.get("mapSizes", {})
    ss = sw.get("mapSizes", {})
    for k in ["callsMap", "sipIndex", "semaphores", "fibersMap"]:
        delta = ss.get(k, 0) - bs.get(k, 0)
        if delta > 10:
            leak_flags.append(f"worker {sw.get('worker', i)}/{k} +{delta}")

# Check heap growth
for i, sw in enumerate(s_workers):
    bw = b_workers[i] if i < len(b_workers) else {}
    bm = bw.get("memory", {})
    sm = sw.get("memory", {})
    delta = sm.get("heapUsed", 0) - bm.get("heapUsed", 0)
    if delta > 50 * 1048576:
        leak_flags.append(f"worker {sw.get('worker', i)}/heapUsed +{mb(delta):.0f}MB")

if leak_flags:
    print("  VERDICT: *** LIKELY MEMORY LEAK DETECTED ***")
    for f in leak_flags:
        print(f"    - {f}")
else:
    print("  VERDICT: No obvious leak detected.")

print()
print("=" * 70)
print(f"  Full results in: {results_dir}")
print("=" * 70)
PYEOF

# ── Step 16: Performance analysis with charts ──────────────────────
if [ -f "$SCRIPT_DIR/analyze-perf.py" ]; then
  echo ""
  echo "==> Step 16: Performance analysis..."
  python3 "$SCRIPT_DIR/analyze-perf.py" "$RESULTS_DIR" || true
fi

# ── Stop UAS ────────────────────────────────────────────────────────
kill "$UAS_PID" 2>/dev/null || true
UAS_PID=""

echo ""
echo "Done."
