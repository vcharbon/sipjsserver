#!/usr/bin/env bash
# Memory + CPU leak harness — kind/k8s mode.
#
# Mirrors memleak-test.sh but routes load through the in-cluster
# sip-front-proxy → b2bua-worker stack so the report covers the LB
# + workers + their Redis sidecars.
#
# Flow:
#   1. Ensure kind cluster + images + helm stack
#   2. Discover proxy + worker pods
#   3. Run a short warmup sipp Job (in-cluster) → drain → baseline
#   4. Run a longer stress sipp Job → sample memory every 2s for every
#      proxy + worker pod → drain → stress snapshot
#   5. Optionally trigger heap snapshots on workers
#   6. Compare baseline vs stress and print report
#
# Usage:
#   ./memleak-test-k8s.sh [--heap-dump] [--skip-install] [--keep]
#
# Configuration via env vars (see defaults below).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="/tmp/memleak-results-k8s/$(date +%Y%m%d-%H%M%S)"

# ── Configuration ────────────────────────────────────────────────────
NAMESPACE="${K8S_TEST_NAMESPACE:-memleak-test}"
WARMUP_CALLS="${WARMUP_CALLS:-1000}"
STRESS_CALLS="${STRESS_CALLS:-50000}"
RATE="${RATE:-200}"
WORKER_REPLICAS="${WORKER_REPLICAS:-2}"
PROXY_REPLICAS="${PROXY_REPLICAS:-2}"
SAMPLE_INTERVAL="${SAMPLE_INTERVAL:-2}"
SCENARIO="${SCENARIO:-uac-basic.xml}"
DRAIN_TIMEOUT="${DRAIN_TIMEOUT:-90}"
SIPP_TIMEOUT_BUFFER="${SIPP_TIMEOUT_BUFFER:-60}"
HEAP_DUMP=0
SKIP_INSTALL=0
KEEP_NS=0

# ── Parse CLI flags ──────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --heap-dump) HEAP_DUMP=1 ;;
    --skip-install) SKIP_INSTALL=1 ;;
    --keep) KEEP_NS=1 ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# ── Verify prerequisites ────────────────────────────────────────────
for cmd in kubectl helm kind docker python3 jq npx; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "ERROR: $cmd not found. Please install it."
    exit 1
  fi
done

mkdir -p "$RESULTS_DIR"

# ── Cleanup handler ─────────────────────────────────────────────────
SAMPLER_PID=""
WARMUP_JOB="memleak-uac-warmup"
STRESS_JOB="memleak-uac-stress"

cleanup() {
  echo ""
  echo "==> Cleaning up..."
  [ -n "$SAMPLER_PID" ] && kill "$SAMPLER_PID" 2>/dev/null || true
  kubectl -n "$NAMESPACE" delete job "$WARMUP_JOB" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  kubectl -n "$NAMESPACE" delete job "$STRESS_JOB" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  if [ "$KEEP_NS" -eq 0 ]; then
    echo "    Deleting namespace $NAMESPACE (use --keep to retain)..."
    kubectl delete namespace "$NAMESPACE" --wait=false --ignore-not-found >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# ══════════════════════════════════════════════════════════════════════
echo "================================================================"
echo "  MEMORY LEAK HARNESS — KIND / K8S MODE"
echo "================================================================"
echo "  Namespace : ${NAMESPACE}"
echo "  Warmup    : ${WARMUP_CALLS} calls @ ${RATE} cps"
echo "  Stress    : ${STRESS_CALLS} calls @ ${RATE} cps"
echo "  Workers   : ${WORKER_REPLICAS} replicas"
echo "  Proxies   : ${PROXY_REPLICAS} replicas"
echo "  Scenario  : ${SCENARIO}"
echo "  Results   : ${RESULTS_DIR}"
echo "================================================================"
echo ""

# ── Step 1: Ensure cluster + images + stack ─────────────────────────
echo "==> Step 1: Bringing up kind cluster + images + helm stack..."
cd "$PROJECT_DIR"

if [ "$SKIP_INSTALL" -eq 0 ]; then
  echo "    Ensuring kind cluster..."
  npx tsx tests/k8s/scripts/up-if-needed.ts

  echo "    Building + loading container images..."
  npx tsx tests/k8s/scripts/images.ts

  echo "    Creating namespace ${NAMESPACE}..."
  kubectl create namespace "$NAMESPACE" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

  echo "    Installing sipp chart (UAS + call-control mock)..."
  helm upgrade --install sipp tests/k8s/charts/sipp \
    -n "$NAMESPACE" --wait --timeout 90s >/dev/null

  echo "    Installing b2bua-worker chart with --expose-gc overlay (replicas=${WORKER_REPLICAS})..."
  helm upgrade --install b2bua-worker deploy/helm/b2bua-worker \
    -n "$NAMESPACE" --wait --timeout 180s \
    -f tests/k8s/values/b2bua-worker.yaml \
    -f sippperftest/values-memleak-worker.yaml \
    --set replicaCount="$WORKER_REPLICAS" >/dev/null

  echo "    Installing sip-front-proxy chart (replicas=${PROXY_REPLICAS})..."
  helm upgrade --install sip-front-proxy deploy/helm/sip-front-proxy \
    -n "$NAMESPACE" --wait --timeout 180s \
    -f tests/k8s/values/sip-front-proxy.yaml \
    --set replicaCount="$PROXY_REPLICAS" >/dev/null

  echo "    Stack ready."
else
  echo "    --skip-install: assuming namespace ${NAMESPACE} already has the stack."
fi

# ── Step 2: Discover pods ───────────────────────────────────────────
echo "==> Step 2: Discovering pods..."
mapfile -t WORKER_PODS < <(kubectl -n "$NAMESPACE" get pod \
  -l app.kubernetes.io/name=b2bua-worker \
  --field-selector=status.phase=Running \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
mapfile -t PROXY_PODS < <(kubectl -n "$NAMESPACE" get pod \
  -l app.kubernetes.io/name=sip-front-proxy \
  --field-selector=status.phase=Running \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')

echo "    Worker pods: ${WORKER_PODS[*]:-(none)}"
echo "    Proxy pods : ${PROXY_PODS[*]:-(none)}"

if [ "${#WORKER_PODS[@]}" -eq 0 ] || [ "${#PROXY_PODS[@]}" -eq 0 ]; then
  echo "ERROR: missing worker or proxy pods. Check helm install logs."
  exit 1
fi

# ── Helpers ──────────────────────────────────────────────────────────
# wget is available via busybox in node:22-alpine (and sipp:dev). The
# worker StatusServer listens on 3002.

snapshot_workers() {
  local outfile="$1"
  : > "$outfile"
  for pod in "${WORKER_PODS[@]}"; do
    local body
    body=$(kubectl -n "$NAMESPACE" exec "$pod" -c worker -- \
      wget -qO- "http://localhost:3002/debug/memory" 2>/dev/null) || continue
    echo "$body" | jq -c --arg pod "$pod" '. + {pod:$pod}' >> "$outfile" 2>/dev/null || true
  done
}

snapshot_proxies() {
  local outfile="$1"
  : > "$outfile"
  for pod in "${PROXY_PODS[@]}"; do
    local status rss hwm data
    status=$(kubectl -n "$NAMESPACE" exec "$pod" -- cat /proc/1/status 2>/dev/null) || continue
    rss=$(echo "$status"  | awk '/^VmRSS:/  {print $2}')
    hwm=$(echo "$status"  | awk '/^VmHWM:/  {print $2}')
    data=$(echo "$status" | awk '/^VmData:/ {print $2}')
    jq -nc \
      --arg pod  "$pod" \
      --argjson rss  "${rss:-0}" \
      --argjson hwm  "${hwm:-0}" \
      --argjson data "${data:-0}" \
      --argjson ts   "$(date +%s%3N)" \
      '{pod:$pod, rssKB:$rss, hwmKB:$hwm, dataKB:$data, ts:$ts}' >> "$outfile"
  done
}

trigger_worker_gc() {
  for pod in "${WORKER_PODS[@]}"; do
    kubectl -n "$NAMESPACE" exec "$pod" -c worker -- \
      wget -q --post-data="" -O- "http://localhost:3002/debug/gc" >/dev/null 2>&1 || true
  done
}

trigger_worker_heap_snapshot() {
  for pod in "${WORKER_PODS[@]}"; do
    kubectl -n "$NAMESPACE" exec "$pod" -c worker -- \
      wget -q --post-data="" -O- "http://localhost:3002/debug/heap-snapshot" >/dev/null 2>&1 || true
  done
}

# Sum callsMap entries across all worker pods. Uses /debug/memory.
sum_calls_map() {
  local total=0
  for pod in "${WORKER_PODS[@]}"; do
    local n
    n=$(kubectl -n "$NAMESPACE" exec "$pod" -c worker -- \
      wget -qO- "http://localhost:3002/debug/memory" 2>/dev/null \
      | jq '[.workers[]?.mapSizes.callsMap // 0] | add // 0' 2>/dev/null) || n=0
    total=$((total + ${n:-0}))
  done
  echo "$total"
}

wait_drain() {
  local label="$1"
  local deadline=$((SECONDS + DRAIN_TIMEOUT))
  echo "    Waiting for callsMap to drain across all workers (max ${DRAIN_TIMEOUT}s)..."
  while [ $SECONDS -lt $deadline ]; do
    local total
    total=$(sum_calls_map)
    if [ "$total" = "0" ]; then
      echo "    All calls drained for $label."
      return 0
    fi
    echo "    $label: total callsMap=$total — waiting..."
    sleep 2
  done
  echo "    WARNING: drain timeout reached for $label."
  return 0
}

# Render + apply a one-shot sipp UAC Job that targets the in-cluster
# sip-front-proxy Service. Returns when the Job reaches a terminal state.
run_sipp_job() {
  local name="$1"
  local calls="$2"
  local rate="$3"
  local timeout="$4"
  local logfile="$5"

  kubectl -n "$NAMESPACE" delete job "$name" --ignore-not-found >/dev/null 2>&1 || true

  local manifest
  manifest=$(mktemp /tmp/sipp-job-XXXXXX.yaml)
  cat > "$manifest" <<EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: ${name}
  namespace: ${NAMESPACE}
  labels:
    app.kubernetes.io/name: sipp-uac
    sipp-job-name: ${name}
spec:
  backoffLimit: 0
  ttlSecondsAfterFinished: 300
  template:
    metadata:
      labels:
        app.kubernetes.io/name: sipp-uac
        sipp-job-name: ${name}
    spec:
      restartPolicy: Never
      nodeSelector:
        tier: load
      containers:
        - name: uac
          image: sipp:dev
          imagePullPolicy: IfNotPresent
          args:
            - "sip-front-proxy:5060"
            - "-s"
            - "uas"
            - "-sf"
            - "/scenarios/${SCENARIO}"
            - "-m"
            - "${calls}"
            - "-r"
            - "${rate}"
            - "-rp"
            - "1000"
            - "-timeout"
            - "${timeout}s"
            - "-trace_err"
            - "-error_file"
            - "/tmp/uac-err.log"
          volumeMounts:
            - name: scenarios
              mountPath: /scenarios
      volumes:
        - name: scenarios
          configMap:
            name: sipp-scenarios
EOF
  kubectl apply -f "$manifest" >/dev/null
  rm -f "$manifest"

  # Wait for completion (success OR failure). `kubectl wait` only
  # supports one condition per call, so race them. We `wait` only on
  # these two specific PIDs — a bare `wait` would block on the
  # background sampler too, hanging forever.
  ( kubectl -n "$NAMESPACE" wait --for=condition=complete --timeout="${timeout}s" "job/${name}" >/dev/null 2>&1 ) &
  local pc=$!
  ( kubectl -n "$NAMESPACE" wait --for=condition=failed   --timeout="${timeout}s" "job/${name}" >/dev/null 2>&1 ) &
  local pf=$!
  if wait -n "$pc" "$pf"; then :; fi
  kill "$pc" "$pf" 2>/dev/null || true
  wait "$pc" 2>/dev/null || true
  wait "$pf" 2>/dev/null || true

  kubectl -n "$NAMESPACE" logs "job/${name}" > "$logfile" 2>&1 || true
}

# Background memory sampler. Appends one JSON record per pod per tick to
# memory-timeseries-{workers,proxies}.jsonl.
start_sampler() {
  local workers_out="$1"
  local proxies_out="$2"
  : > "$workers_out"
  : > "$proxies_out"
  (
    while true; do
      local ts
      ts=$(date +%s%3N)
      for pod in "${WORKER_PODS[@]}"; do
        local body
        body=$(kubectl -n "$NAMESPACE" exec "$pod" -c worker -- \
          wget -qO- "http://localhost:3002/debug/memory" 2>/dev/null) || continue
        echo "$body" \
          | jq -c --arg pod "$pod" --argjson ts "$ts" '. + {pod:$pod, ts:$ts}' \
          >> "$workers_out" 2>/dev/null || true
      done
      for pod in "${PROXY_PODS[@]}"; do
        local status rss hwm data
        status=$(kubectl -n "$NAMESPACE" exec "$pod" -- cat /proc/1/status 2>/dev/null) || continue
        rss=$(echo "$status"  | awk '/^VmRSS:/  {print $2}')
        hwm=$(echo "$status"  | awk '/^VmHWM:/  {print $2}')
        data=$(echo "$status" | awk '/^VmData:/ {print $2}')
        jq -nc \
          --arg pod  "$pod" \
          --argjson rss  "${rss:-0}" \
          --argjson hwm  "${hwm:-0}" \
          --argjson data "${data:-0}" \
          --argjson ts   "$ts" \
          '{pod:$pod, rssKB:$rss, hwmKB:$hwm, dataKB:$data, ts:$ts}' \
          >> "$proxies_out" 2>/dev/null || true
      done
      sleep "$SAMPLE_INTERVAL"
    done
  ) &
  SAMPLER_PID=$!
}

stop_sampler() {
  if [ -n "$SAMPLER_PID" ]; then
    kill "$SAMPLER_PID" 2>/dev/null || true
    wait "$SAMPLER_PID" 2>/dev/null || true
    SAMPLER_PID=""
  fi
}

# ── Step 3: Warmup ──────────────────────────────────────────────────
WARMUP_TIMEOUT=$(( SIPP_TIMEOUT_BUFFER + WARMUP_CALLS / RATE ))
echo "==> Step 3: Running warmup (${WARMUP_CALLS} calls @ ${RATE} cps, timeout ${WARMUP_TIMEOUT}s)..."
run_sipp_job "$WARMUP_JOB" "$WARMUP_CALLS" "$RATE" "$WARMUP_TIMEOUT" \
  "$RESULTS_DIR/warmup.log"
echo "    Warmup Job finished."

# ── Step 4: Drain warmup ────────────────────────────────────────────
echo "==> Step 4: Draining warmup calls..."
wait_drain "warmup"

# ── Step 5: Capture baseline ────────────────────────────────────────
echo "==> Step 5: Waiting 60s for transactions to fully expire before baseline..."
sleep 60
trigger_worker_gc
sleep 2
echo "    Capturing baseline memory..."
snapshot_workers "$RESULTS_DIR/baseline-workers.jsonl"
snapshot_proxies "$RESULTS_DIR/baseline-proxies.jsonl"

if [ "$HEAP_DUMP" -eq 1 ]; then
  echo "    Triggering baseline heap snapshots on workers..."
  trigger_worker_heap_snapshot
  sleep 5
  # Rename baseline snapshots so they don't get overwritten/confused
  # with the stress snapshots written into the same /tmp/heapdumps dir.
  for pod in "${WORKER_PODS[@]}"; do
    kubectl -n "$NAMESPACE" exec "$pod" -c worker -- sh -c \
      'for f in /tmp/heapdumps/*.heapsnapshot; do
         [ -e "$f" ] || continue
         case "$f" in *.baseline.heapsnapshot) ;; *) mv "$f" "${f%.heapsnapshot}.baseline.heapsnapshot" ;; esac
       done' >/dev/null 2>&1 || true
  done
fi

# ── Step 6: Run stress ──────────────────────────────────────────────
STRESS_TIMEOUT=$(( SIPP_TIMEOUT_BUFFER + STRESS_CALLS / RATE ))
echo "==> Step 6: Running stress test (${STRESS_CALLS} calls @ ${RATE} cps, timeout ${STRESS_TIMEOUT}s)..."
echo "    Estimated duration: ~$((STRESS_CALLS / RATE))s"

start_sampler \
  "$RESULTS_DIR/memory-timeseries-workers.jsonl" \
  "$RESULTS_DIR/memory-timeseries-proxies.jsonl"

run_sipp_job "$STRESS_JOB" "$STRESS_CALLS" "$RATE" "$STRESS_TIMEOUT" \
  "$RESULTS_DIR/stress.log"
echo "    Stress Job finished."

# ── Step 7: Drain stress ────────────────────────────────────────────
echo "==> Step 7: Draining stress calls..."
wait_drain "stress"

stop_sampler

# ── Step 8: Capture stress snapshot ─────────────────────────────────
echo "==> Step 8: Waiting 60s for transactions to fully expire before stress snapshot..."
sleep 60
trigger_worker_gc
sleep 2
echo "    Capturing stress memory..."
snapshot_workers "$RESULTS_DIR/stress-workers.jsonl"
snapshot_proxies "$RESULTS_DIR/stress-proxies.jsonl"

if [ "$HEAP_DUMP" -eq 1 ]; then
  echo "==> Step 8b: Triggering stress heap snapshots on workers..."
  trigger_worker_heap_snapshot
  sleep 5
  for pod in "${WORKER_PODS[@]}"; do
    kubectl -n "$NAMESPACE" cp "$pod:/tmp/heapdumps" \
      "$RESULTS_DIR/heapdumps-${pod}" -c worker 2>/dev/null || true
  done
fi

# ── Step 9: Report ──────────────────────────────────────────────────
echo ""
echo "==> Step 9: Generating comparison report..."
echo ""

python3 - "$RESULTS_DIR" "$WARMUP_CALLS" "$STRESS_CALLS" "$RATE" <<'PYEOF'
import json, sys, os, glob

results_dir = sys.argv[1]
warmup_calls = int(sys.argv[2])
stress_calls = int(sys.argv[3])
rate = int(sys.argv[4])

def load_jsonl(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out

def mb(b):
    return b / 1048576

def kb_to_mb(kb):
    return kb / 1024

baseline_workers = load_jsonl(os.path.join(results_dir, "baseline-workers.jsonl"))
stress_workers   = load_jsonl(os.path.join(results_dir, "stress-workers.jsonl"))
baseline_proxies = load_jsonl(os.path.join(results_dir, "baseline-proxies.jsonl"))
stress_proxies   = load_jsonl(os.path.join(results_dir, "stress-proxies.jsonl"))

print("=" * 76)
print("  K8S MEMORY LEAK DETECTION REPORT")
print("=" * 76)
print(f"  Warmup : {warmup_calls} calls @ {rate} cps")
print(f"  Stress : {stress_calls} calls @ {rate} cps")
print()

leak_flags = []

# ── Workers ──────────────────────────────────────────────────────
b_by_pod = {w["pod"]: w for w in baseline_workers}
s_by_pod = {w["pod"]: w for w in stress_workers}

for pod, sw in s_by_pod.items():
    bw = b_by_pod.get(pod, {})
    bm = bw.get("process", {}).get("memory", {})
    sm = sw.get("process", {}).get("memory", {})

    print(f"  WORKER POD {pod} — process memory (MB)")
    print("  " + "-" * 72)
    for k in ["rss", "heapTotal", "heapUsed", "external", "arrayBuffers"]:
        b = mb(bm.get(k, 0))
        s = mb(sm.get(k, 0))
        d = s - b
        pct = (d / b * 100) if b > 0 else 0
        flag = " *** LEAK?" if d > 10 and pct > 20 else ""
        print(f"    {k:20s}  baseline={b:8.1f}  stress={s:8.1f}  delta={d:+8.1f}  ({pct:+.1f}%){flag}")
        if k == "heapUsed" and d > 50:
            leak_flags.append(f"{pod}/heapUsed +{d:.0f}MB")

    # Map sizes from in-process worker (cluster mode). Iterate workers[].
    print()
    print(f"  WORKER POD {pod} — map sizes (entries, summed across cluster workers)")
    print("  " + "-" * 72)
    def sum_maps(snap, key):
        return sum(int(w.get("mapSizes", {}).get(key, 0))
                   for w in snap.get("workers", []) if w.get("status") == "ok")
    for key in ["txnMap", "callsMap", "sipIndex", "semaphores", "fibersMap"]:
        b = sum_maps(bw, key)
        s = sum_maps(sw, key)
        d = s - b
        flag = " *** LEAK?" if d > 10 else ""
        print(f"    {key:20s}  baseline={b:8d}  stress={s:8d}  delta={d:+8d}{flag}")
        if d > 10:
            leak_flags.append(f"{pod}/{key} +{d}")
    print()

# ── Proxies ──────────────────────────────────────────────────────
b_proxy = {p["pod"]: p for p in baseline_proxies}
s_proxy = {p["pod"]: p for p in stress_proxies}

for pod, sp in s_proxy.items():
    bp = b_proxy.get(pod, {})
    print(f"  PROXY POD {pod} — process memory (MB, from /proc/1/status)")
    print("  " + "-" * 72)
    for k, label in [("rssKB", "VmRSS"), ("hwmKB", "VmHWM (peak)"), ("dataKB", "VmData")]:
        b = kb_to_mb(bp.get(k, 0))
        s = kb_to_mb(sp.get(k, 0))
        d = s - b
        pct = (d / b * 100) if b > 0 else 0
        flag = " *** LEAK?" if k == "rssKB" and d > 25 and pct > 25 else ""
        print(f"    {label:20s}  baseline={b:8.1f}  stress={s:8.1f}  delta={d:+8.1f}  ({pct:+.1f}%){flag}")
        if k == "rssKB" and d > 25 and pct > 25:
            leak_flags.append(f"{pod}/proxyRSS +{d:.0f}MB")
    print()

# ── Timeseries linear regression on heapUsed (workers) and RSS (proxies)
ts_workers = load_jsonl(os.path.join(results_dir, "memory-timeseries-workers.jsonl"))
ts_proxies = load_jsonl(os.path.join(results_dir, "memory-timeseries-proxies.jsonl"))

def regress(xs, ys):
    n = len(xs)
    if n < 3:
        return (0.0, 0.0)
    mx = sum(xs) / n
    my = sum(ys) / n
    num = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    dx2 = sum((xs[i] - mx) ** 2 for i in range(n))
    if dx2 == 0:
        return (0.0, 0.0)
    slope = num / dx2
    # R^2
    dy2 = sum((ys[i] - my) ** 2 for i in range(n))
    if dy2 == 0:
        return (slope, 0.0)
    ssr = sum((ys[i] - (my + slope * (xs[i] - mx))) ** 2 for i in range(n))
    r2 = max(0.0, 1.0 - ssr / dy2)
    return (slope, r2)

print("  TIMESERIES TREND (slope = MB/hour, R² = fit confidence)")
print("  " + "-" * 72)

worker_series = {}
for r in ts_workers:
    pod = r.get("pod"); ts = r.get("ts", 0)
    used = r.get("process", {}).get("memory", {}).get("heapUsed", 0)
    worker_series.setdefault(pod, []).append((ts, used))

for pod, series in worker_series.items():
    series.sort()
    if not series: continue
    t0 = series[0][0]
    xs = [(t - t0) / 1000.0 / 3600.0 for t, _ in series]
    ys = [mb(u) for _, u in series]
    slope, r2 = regress(xs, ys)
    flag = " *** SUSPECTED LEAK" if slope > 5 and r2 > 0.7 else ""
    print(f"    worker {pod:48s}  heapUsed slope={slope:+7.1f} MB/hr  R²={r2:.2f}{flag}")
    if slope > 5 and r2 > 0.7:
        leak_flags.append(f"{pod}/heapUsed slope {slope:+.1f}MB/hr")

proxy_series = {}
for r in ts_proxies:
    pod = r.get("pod"); ts = r.get("ts", 0)
    proxy_series.setdefault(pod, []).append((ts, r.get("rssKB", 0)))

for pod, series in proxy_series.items():
    series.sort()
    if not series: continue
    t0 = series[0][0]
    xs = [(t - t0) / 1000.0 / 3600.0 for t, _ in series]
    ys = [kb_to_mb(u) for _, u in series]
    slope, r2 = regress(xs, ys)
    flag = " *** SUSPECTED LEAK" if slope > 5 and r2 > 0.7 else ""
    print(f"    proxy  {pod:48s}  RSS      slope={slope:+7.1f} MB/hr  R²={r2:.2f}{flag}")
    if slope > 5 and r2 > 0.7:
        leak_flags.append(f"{pod}/proxyRSS slope {slope:+.1f}MB/hr")

# ── SIPp summary (parsed from stress.log if present) ──────────────
stress_log = os.path.join(results_dir, "stress.log")
if os.path.exists(stress_log):
    import re
    with open(stress_log) as f:
        text = f.read()
    def grab(pat):
        m = re.search(pat, text)
        return int(m.group(1)) if m else None
    successful = grab(r"Successful call\s+\|\s+\S+\s+\|\s+(\d+)")
    failed     = grab(r"Failed call\s+\|\s+\S+\s+\|\s+(\d+)")
    created    = grab(r"Outgoing calls created\s+\|\s+\S+\s+\|\s+(\d+)")
    print()
    print("  SIPP SUMMARY (stress phase)")
    print("  " + "-" * 72)
    print(f"    created    = {created}")
    print(f"    successful = {successful}")
    print(f"    failed     = {failed}")

# ── Verdict ──────────────────────────────────────────────────────
print()
if leak_flags:
    print("  VERDICT: *** LIKELY MEMORY LEAK DETECTED ***")
    for f in leak_flags:
        print(f"    - {f}")
else:
    print("  VERDICT: No obvious leak detected.")
print()
print("=" * 76)
print(f"  Full results in: {results_dir}")
print("=" * 76)
PYEOF

echo ""
echo "Done."
