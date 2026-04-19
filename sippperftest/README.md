# SIPp Performance & Memory Testing

Scripts for load testing, memory leak detection, CPU profiling, and automated performance
analysis of the SIP B2BUA.

## Prerequisites

### Required

| Dependency | Install | Used by |
|------------|---------|---------|
| **sipp** | `sudo apt install sipp` | All load tests (UAC/UAS traffic generation) |
| **redis-cli** | `sudo apt install redis-tools` | `memleak-test.sh` (flush DB, residual key check) |
| **redis-server** | `sudo apt install redis-server` | Must be running on `localhost:6379` |
| **curl** | `sudo apt install curl` | `memleak-test.sh` (debug endpoint calls) |
| **jq** | `sudo apt install jq` | `memleak-test.sh` (JSON parsing in drain check) |
| **python3** | Pre-installed on most Linux | `memleak-test.sh` report + `analyze-perf.py` |
| **node** (v20+) | Project prerequisite | B2BUA server, `analyze-heap.mjs` |
| **tmux** | `sudo apt install tmux` | `sipp-perf.sh`, `overload.sh` (interactive tests only) |

**Quick install (Debian/Ubuntu):**

```bash
sudo apt install sipp redis-server redis-tools curl jq tmux
```

### Optional

| Dependency | Install | Purpose |
|------------|---------|---------|
| **plotext** | `pip install plotext` | Full terminal charts (line/bar/scatter) in `analyze-perf.py` |

Without plotext, `analyze-perf.py` falls back to compact Unicode sparklines — still
informative, zero extra dependencies. The script prints a hint when plotext is missing.

### Build the project

Before running any test, build the B2BUA from the project root:

```bash
npm run build
```

(`memleak-test.sh` runs `npm run build` automatically as its first step.)

## Scripts

### `sipp-perf.sh` — Interactive throughput test

Launches UAS + UAC in a tmux session. Start the B2BUA separately first.

```bash
# Start B2BUA in another terminal
npm run dev

# Run the perf test
./sipp-perf.sh [num_calls] [concurrency] [rate]

# Examples
./sipp-perf.sh              # defaults: 1000 calls, 10 concurrent, 50 cps
./sipp-perf.sh 500000 50000 100  # 5000 calls, 50 concurrent, 200 cps
```

### `overload.sh` — Interactive overload test

Sustained load with no call cap. Runs until interrupted with Ctrl-C.

```bash
./overload.sh [rate] [concurrency]

# Examples
./overload.sh           # defaults: 100 cps, 50 concurrent
./overload.sh 500 200   # 500 cps, 200 concurrent
```

### `memleak-test.sh` — Automated memory leak + performance analysis

Fully automated harness that:
1. Flushes Redis
2. Builds and starts the B2BUA with memory caps + `--expose-gc`
3. Runs a short warmup load, captures baseline memory
4. Runs a longer stress load while collecting memory timeseries every 2s
5. Triggers a 10-second V8 CPU profile mid-stress for hotpath analysis
6. Stops the B2BUA, checks Redis for residual keys
7. Compares baseline vs stress and prints a detailed report
8. Runs `analyze-perf.py` to generate charts, CPU hotpath heatmap, and performance summary

#### Quick start

```bash
cd sippperftest

# Default: 1000 warmup + 50000 stress calls at 200 cps, 2 workers
./memleak-test.sh

# Quick validation with low traffic
WARMUP_CALLS=200 STRESS_CALLS=2000 RATE=50 ./memleak-test.sh

# Full run with heap snapshots for Chrome DevTools analysis
./memleak-test.sh --heap-dump

# Custom configuration
WARMUP_CALLS=1000 STRESS_CALLS=100000 RATE=300 CLUSTER_WORKERS=4 ./memleak-test.sh --heap-dump
```

#### Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `WARMUP_CALLS` | 1000 | Number of calls in warmup phase |
| `STRESS_CALLS` | 50000 | Number of calls in stress phase |
| `RATE` | 200 | Calls per second (CPS) |
| `CLUSTER_WORKERS` | 2 | Number of worker processes |
| `WORKER_MAX_HEAP_MB` | 600 | V8 heap limit per process (MB) |
| `UAS_HOST` | 127.0.0.1 | SIPp UAS bind address |
| `UAS_PORT` | 5666 | SIPp UAS port |
| `UAC_HOST` | 127.0.0.1 | SIPp UAC bind address |
| `UAC_PORT` | 5555 | SIPp UAC port |
| `B2BUA_HOST` | 127.0.0.1 | B2BUA address |
| `B2BUA_PORT` | 5060 | B2BUA SIP port |

| CLI Flag | Description |
|----------|-------------|
| `--heap-dump` | Trigger V8 heap snapshots after stress (saved to `/tmp/heapdumps/`) |

#### Output

Results are saved to `/tmp/memleak-results/YYYYMMDD-HHMMSS/`:

| File | Contents |
|------|----------|
| `baseline-memory.json` | Memory + CPU + map sizes + GC after warmup drain |
| `stress-memory.json` | Memory + CPU + map sizes + GC after stress drain |
| `memory-timeseries.jsonl` | Memory/CPU/GC/maps sampled every 2s during stress (one JSON per line) |
| `warmup-stats.csv` | SIPp statistics for warmup phase |
| `stress-stats.csv` | SIPp statistics for stress phase |
| `warmup-errors.log` | SIPp error log for warmup |
| `stress-errors.log` | SIPp error log for stress |
| `redis-residual.txt` | Residual Redis key counts after shutdown |
| `*.heapsnapshot` | V8 heap snapshots (only with `--heap-dump`) |
| `*.cpuprofile` | V8 CPU profiles captured mid-stress (10s sample) |

#### Interpreting the report

The harness produces two reports:

**Step 15 — Memory comparison report** (inline Python) compares baseline vs stress:

- **Master process memory** — RSS, heap total/used, external, array buffers
- **Per-worker memory** — same fields per worker
- **Per-worker map sizes** — `txnMap`, `callsMap`, `sipIndex`, `semaphores`, `fibersMap`
- **Redis residual keys** — `call:*`, `leg:*`, `ctx:*`, `limiter:*`

A `*** LEAK?` flag appears when:
- A map has >10 more entries in stress than baseline (entries should return to ~0 after drain)
- Heap used grew >50MB between baseline and stress
- Redis has residual keys after shutdown

**Step 16 — Performance analysis** (`analyze-perf.py`) produces charts and metrics.
See the `analyze-perf.py` section below for details.

#### Analyzing heap snapshots

When `--heap-dump` is used, the harness captures baseline (post-warmup) and stress (post-stress)
heap snapshots and automatically runs `analyze-heap.mjs` to compare them.

You can also run the analyzer manually:

```bash
# Summary of a single snapshot
node sippperftest/analyze-heap.mjs /tmp/heapdumps/heap-worker-0-123456.heapsnapshot

# Compare two snapshots — baseline vs stress (shows what grew)
node sippperftest/analyze-heap.mjs \
  /tmp/memleak-results/20260412-140000/heap-worker-0-123.baseline.heapsnapshot \
  /tmp/memleak-results/20260412-140000/heap-worker-0-456.heapsnapshot

# Compare worker snapshots from the latest harness run
LATEST=$(ls -td /tmp/memleak-results/*/ | head -1)
node sippperftest/analyze-heap.mjs \
  "$LATEST"/heap-worker-0-*.baseline.heapsnapshot \
  "$LATEST"/heap-worker-0-*.heapsnapshot
```

The diff report shows:
- **Top growers by size** — constructors that consumed the most additional memory
- **Top growers by count** — constructors with the most new instances
- **Shrinkers** — what was freed (GC working correctly for those types)
- **Suspect constructors** — anything that grew > 1MB (flagged with `***`)

For deeper retainer-chain analysis, open `.heapsnapshot` files in Chrome DevTools:

1. Open Chrome, go to `chrome://inspect` > "Open dedicated DevTools for Node"
2. Memory tab > Load > select the file
3. Use the "Comparison" view to find what holds leaked objects alive

### `analyze-perf.py` — Performance analysis with CLI charts

Automatically run as step 16 of `memleak-test.sh`, or standalone against any results directory:

```bash
# Run against the latest results
LATEST=$(ls -td /tmp/memleak-results/*/ | head -1)
python3 sippperftest/analyze-perf.py "$LATEST"

# Run against a specific results directory
python3 sippperftest/analyze-perf.py /tmp/memleak-results/20260412-174501/
```

#### Chart modes

The script supports two rendering modes:

**Full charts (with plotext):**

```bash
pip install plotext
```

Produces multi-series line charts with axes, legends, and Unicode rendering directly in the
terminal. Recommended for development machines.

**Sparkline fallback (zero dependencies):**

When plotext is not installed, the script renders compact inline sparklines using Unicode block
characters (`▁▂▃▄▅▆▇█`) with min/max annotations. Useful for CI environments or minimal
installations where pip is not available.

Example sparkline output:
```
  Worker 0              39.7 ▁▂▄▃▄▅▆▇▅▆▆▇▇▇▇▆▆▅▅▇▅▅▇▅▆▆▇▆▅▆▆▅▅▇▆▇▇▅▆█▆▆▅▆▇▅▅▆▅▅▅▅▅▆▆    224.1
  Worker 1              39.7 ▁▂▂▄▄▅▅▆▅▇▇▅▇▅▇▇▆▅▆▅▆▅▆▆▇▆▅▆▆▇▇▇▅▇▇▆▇▆▇▆▇▆█▆▆▇▅▆▇▆▇▇▇▆▇    214.4
```

#### Output sections

1. **CPU Hotpath Heatmap** — Top functions sorted by self-time from V8 CPU profiles
   (`.cpuprofile` files). Shows a per-function table with `Self%`, function name, and source
   file location, plus a file-level heatmap aggregating CPU% per source directory. Use this to
   identify which code paths to optimize first.

2. **CPU% Over Time** — Per-worker CPU utilization plotted over the stress duration. Derived
   from `process.cpuUsage()` deltas between consecutive timeseries samples. Values are per-core
   percentages (can exceed 100% on multi-core systems — e.g., 200% means 2 cores fully used).

3. **Event Loop Lag** — P95 event loop lag per worker over time. Sustained spikes above ~10ms
   indicate the event loop is being starved by synchronous CPU work. This is the primary signal
   that the application is CPU-bound.

4. **Memory Trend + Leak Regression** — HeapUsed per worker plotted over time with OLS linear
   regression. Reports the slope (MB/hour) and R-squared (confidence). Interpretation:
   - High slope + high R² (>0.7) = likely leak
   - High slope + low R² = GC sawtooth noise, not a real leak
   - Flags workers with slope > 5 MB/hr AND R² > 0.7 as `*** SUSPECTED LEAK`

5. **GC Pressure** — GC pause time per reporting window per worker. Correlates with CPU spikes
   and memory pressure. Sustained high GC pauses mean the heap is too full.

6. **Map Sizes** — callsMap and txnMap entries plotted over time. During load these should rise
   and fall with concurrent calls. A plateau above zero after all calls drain = map entry leak.

7. **SIPp Load Profile + Summary** — Call rate and concurrent calls over time, followed by a
   summary table with total/successful/failed calls, average CPS, error rate, and response time
   distribution (from SIPp's `ResponseTimeRepartition` buckets).

**Consolidated summary** printed at the end:
```
  PERFORMANCE SUMMARY
  ═══════════════════
  CPU:      avg 78.3%  peak 142.7%  (per-core)
  Loop lag: avg 2.1ms  peak 48.3ms
  GC:       total 1.2s  max pause 23ms
  Memory W0: peak RSS 625MB  heap 227MB  leak +2.1 MB/hr (R²=0.12)
  SIPp:     avg 154.2 cps  50000/50000 ok  0 failed
  Latency:  mean 13.0ms
```

#### CPU profiling

The `memleak-test.sh` harness automatically triggers a 10-second V8 CPU profile mid-stress
(after approximately 30% of the stress run completes). This captures which code paths are hot
under realistic sustained load, not during startup or cooldown.

**How it works:**
1. The harness sends `POST /debug/cpu-profile` to the status server
2. The server starts V8's built-in CPU profiler on the master process and all workers
3. After 10 seconds, profiling stops and `.cpuprofile` JSON files are written
4. Files are copied from `/tmp/cpuprofiles/` to the results directory
5. `analyze-perf.py` parses the profiles and renders the hotpath heatmap

**Trigger profiling manually** (during any running B2BUA instance):

```bash
curl -X POST http://localhost:3002/debug/cpu-profile
# Wait 10+ seconds for profiling to complete
ls /tmp/cpuprofiles/
```

**Open CPU profiles in Chrome DevTools** for deeper call-tree analysis:

1. Open Chrome, navigate to `chrome://inspect`
2. Click "Open dedicated DevTools for Node"
3. Go to the Performance tab > Load profile > select the `.cpuprofile` file
4. Use the flame chart and bottom-up views to trace call stacks

### `analyze-heap.mjs` — V8 heap snapshot analyzer

Zero-dependency Node.js script that parses V8 heap snapshot files and produces text reports.
See the "Analyzing heap snapshots" section above for usage.

## Debug HTTP endpoints

The B2BUA exposes debug endpoints on the status server (port 3002):

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/debug/memory` | GET | Memory + CPU usage + map sizes + GC stats + event loop lag for master and all workers |
| `/debug/gc` | POST | Trigger garbage collection on master + all workers (requires `--expose-gc`) |
| `/debug/heap-snapshot` | POST | Write V8 heap snapshots to `/tmp/heapdumps/` |
| `/debug/cpu-profile` | POST | Start 10s V8 CPU profile on master + all workers (writes to `/tmp/cpuprofiles/`) |

The `--expose-gc` flag is required for GC triggering (set automatically by `memleak-test.sh`).

### `/debug/memory` response format

```json
{
  "process": {
    "pid": 12345,
    "title": "sipb2bua-dispatcher",
    "memory": { "rss": 273887232, "heapTotal": 42205184, "heapUsed": 39068920, "external": 3903953, "arrayBuffers": 99355 },
    "cpuUsage": { "user": 1234567, "system": 234567 }
  },
  "workers": [
    {
      "worker": 0,
      "status": "ok",
      "memory": { "rss": 293466112, "heapTotal": 44445696, "heapUsed": 41643528, "external": 4062982, "arrayBuffers": 131875 },
      "mapSizes": { "txnMap": 0, "callsMap": 0, "sipIndex": 0, "semaphores": 0, "fibersMap": 0 },
      "cpuUsage": { "user": 5678901, "system": 678901 },
      "loopLagMsP95": 0.5,
      "gc": { "totalCount": 42, "totalPauseMs": 120, "maxPauseMs": 15, "windowCount": 2, "windowPauseMs": 8, "lastPauseTimestamp": 1776008784222, "lastPauseDurationMs": 4, "lastPauseKind": "minor" }
    }
  ],
  "timestamp": 1776008784222
}
```

Fields `cpuUsage.user` and `cpuUsage.system` are cumulative microseconds from `process.cpuUsage()`.
To compute CPU% between two samples: `(delta_user + delta_system) / (delta_wall_time_us) * 100`.

## Typical workflow

1. **Quick smoke test:**
   ```bash
   WARMUP_CALLS=1000 STRESS_CALLS=50000 RATE=150 ./memleak-test.sh  --heap-dump
   ```

2. **Full memory leak test:**
   ```bash
   ./memleak-test.sh --heap-dump
   ```

3. **CPU optimization investigation:**
   ```bash
   # Run with enough load to saturate
   STRESS_CALLS=100000 RATE=300 ./memleak-test.sh
   # Check the CPU HOTPATH section in the output
   # Open .cpuprofile in Chrome DevTools for call-tree analysis
   ```

4. **Re-analyze previous results:**
   ```bash
   LATEST=$(ls -td /tmp/memleak-results/*/ | head -1)
   python3 sippperftest/analyze-perf.py "$LATEST"
   node sippperftest/analyze-heap.mjs "$LATEST"/heap-worker-0-*.baseline.heapsnapshot "$LATEST"/heap-worker-0-*.heapsnapshot
   ```

5. **Interactive stress testing (manual):**
   ```bash
   npm run dev                    # terminal 1: start B2BUA
   ./sipp-perf.sh 10000 100 300  # terminal 2: run load test
   curl -X POST localhost:3002/debug/cpu-profile  # terminal 3: trigger profiling mid-test
   ```
