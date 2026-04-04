#!/usr/bin/env python3
"""
Performance analysis with CLI charts for the SIP B2BUA memleak harness.

Reads data from a results directory produced by memleak-test.sh and generates:
  1. CPU hotpath heatmap (from .cpuprofile files)
  2. CPU% over time (from memory-timeseries.jsonl)
  3. Event loop lag chart
  4. Memory trend chart + leak regression
  5. GC pressure chart
  6. Map sizes chart
  7. SIPp load profile + summary

Usage:
    python3 analyze-perf.py <results-dir>

Install plotext for full terminal charts:
    pip install plotext
"""

import json
import sys
import os
import math
import glob as globmod

# ── Plotext availability ─────────────────────────────────────────────
try:
    import plotext as plt
    HAS_PLOTEXT = True
except ImportError:
    HAS_PLOTEXT = False

# ── Constants ────────────────────────────────────────────────────────
CHART_WIDTH = 78
CHART_HEIGHT = 15
MIN_DATA_POINTS = 3
BAR_CHAR = "\u2588"  # █
SPARK_CHARS = "\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588"

# ── Utility functions ────────────────────────────────────────────────


def mb(b):
    return b / 1048576


def fmt_mb(b):
    return f"{mb(b):.1f}"


def fmt_pct(v):
    return f"{v:.1f}%"


def padL(s, n):
    return str(s).rjust(n)


def padR(s, n):
    return str(s).ljust(n)


def sparkline(values, width=55, label=""):
    """Render a compact sparkline with min/max annotations."""
    if not values:
        return f"  {label:20s} (no data)"
    sampled = values
    if len(values) > width:
        step = len(values) / width
        sampled = [values[int(i * step)] for i in range(width)]
    vmin, vmax = min(sampled), max(sampled)
    span = vmax - vmin or 1
    chars = ""
    for v in sampled:
        idx = min(int((v - vmin) / span * (len(SPARK_CHARS) - 1)), len(SPARK_CHARS) - 1)
        chars += SPARK_CHARS[idx]
    return f"  {label:20s} {vmin:8.1f} {chars} {vmax:8.1f}"


def bar_chart_line(label, pct, max_bar=40):
    """Render a single horizontal bar with label and percentage."""
    bar_len = max(1, int(pct / 100 * max_bar)) if pct > 0.5 else 0
    bar = BAR_CHAR * bar_len
    return f"  {bar:{max_bar}s} {pct:5.1f}%  {label}"


def section_header(title):
    print()
    print(f"  {title}")
    print("  " + "\u2500" * (CHART_WIDTH - 4))  # ─


# ── Linear regression (no numpy) ────────────────────────────────────


def linear_regression(xs, ys):
    """Returns (slope, intercept, r_squared) using manual OLS."""
    n = len(xs)
    if n < 2:
        return 0.0, 0.0, 0.0
    sum_x = sum(xs)
    sum_y = sum(ys)
    sum_xy = sum(x * y for x, y in zip(xs, ys))
    sum_x2 = sum(x * x for x in xs)
    denom = n * sum_x2 - sum_x * sum_x
    if denom == 0:
        return 0.0, sum_y / n, 0.0
    slope = (n * sum_xy - sum_x * sum_y) / denom
    intercept = (sum_y - slope * sum_x) / n
    ss_res = sum((y - (slope * x + intercept)) ** 2 for x, y in zip(xs, ys))
    mean_y = sum_y / n
    ss_tot = sum((y - mean_y) ** 2 for y in ys)
    r_squared = 1 - (ss_res / ss_tot) if ss_tot > 0 else 0.0
    return slope, intercept, r_squared


# ── Data parsers ─────────────────────────────────────────────────────


def parse_memory_jsonl(path):
    """Parse memory timeseries — handles both concatenated JSON and proper JSONL."""
    if not os.path.exists(path):
        return []
    with open(path) as f:
        data = f.read().strip()
    if not data:
        return []
    # Handle concatenated JSON (no newlines between records)
    fixed = data.replace("}{", "}\n{")
    records = []
    for line in fixed.split("\n"):
        line = line.strip()
        if line:
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return records


def parse_sipp_time(s):
    """Parse SIPp time format HH:MM:SS:UUUUUU to milliseconds."""
    parts = s.split(":")
    if len(parts) != 4:
        return 0.0
    try:
        h, m, sec, us = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
        return (h * 3600 + m * 60 + sec) * 1000 + us / 1000
    except (ValueError, IndexError):
        return 0.0


def parse_sipp_elapsed(s):
    """Parse SIPp elapsed time HH:MM:SS to seconds."""
    parts = s.split(":")
    if len(parts) != 3:
        return 0
    try:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    except ValueError:
        return 0


def parse_sipp_csv(path):
    """Parse SIPp trace_stat CSV (semicolon-delimited)."""
    if not os.path.exists(path):
        return None, None, []
    with open(path) as f:
        lines = f.readlines()
    if len(lines) < 2:
        return None, None, []
    header = lines[0].strip().rstrip(";").split(";")
    col_idx = {name: i for i, name in enumerate(header)}
    rows = []
    for line in lines[1:]:
        fields = line.strip().rstrip(";").split(";")
        if len(fields) >= len(header):
            rows.append(fields)
    return header, col_idx, rows


def parse_cpuprofile(path):
    """Parse a V8 .cpuprofile and compute self-time per function."""
    with open(path) as f:
        prof = json.load(f)
    nodes = {n["id"]: n for n in prof.get("nodes", [])}
    samples = prof.get("samples", [])
    time_deltas = prof.get("timeDeltas", [])

    # Count self-time per node (microseconds)
    self_time = {}
    for i, node_id in enumerate(samples):
        us = time_deltas[i] if i < len(time_deltas) else 0
        self_time[node_id] = self_time.get(node_id, 0) + abs(us)

    total_us = sum(abs(d) for d in time_deltas) if time_deltas else 1

    # Aggregate by function
    func_stats = {}
    for node_id, us in self_time.items():
        node = nodes.get(node_id)
        if not node:
            continue
        cf = node.get("callFrame", {})
        name = cf.get("functionName", "") or "(anonymous)"
        url = cf.get("url", "")
        line = cf.get("lineNumber", -1) + 1
        key = f"{url}:{name}"
        if key in func_stats:
            func_stats[key]["self_us"] += us
        else:
            func_stats[key] = {"self_us": us, "name": name, "url": url, "line": line}

    return func_stats, total_us, len(samples)


def map_to_source(url):
    """Map dist JS paths back to src TS paths."""
    if not url:
        return "(native)"
    if "node_modules" in url:
        return "(node_modules)"
    path = url.replace("file://", "")
    if "/dist/" in path:
        rel = path.split("/dist/", 1)[1]
        return "src/" + rel.replace(".js", ".ts")
    if not path or path.startswith("<"):
        return "(V8 internals)"
    return path


def map_to_dir(source_path):
    """Collapse a source path to a directory-level grouping."""
    if source_path.startswith("("):
        return source_path
    parts = source_path.split("/")
    if len(parts) <= 2:
        return source_path
    # Keep first two levels: src/sip/, src/b2bua/, src/cluster/, etc.
    return "/".join(parts[:3]) + "/"


# ── Chart functions ──────────────────────────────────────────────────


def plot_line_chart(title, series_dict, xlabel="elapsed (s)", ylabel=""):
    """Plot a multi-series line chart. series_dict: {label: (xs, ys)}"""
    if HAS_PLOTEXT:
        plt.clear_figure()
        plt.theme("clear")
        plt.plot_size(CHART_WIDTH, CHART_HEIGHT)
        plt.title(title)
        plt.xlabel(xlabel)
        if ylabel:
            plt.ylabel(ylabel)
        for label, (xs, ys) in series_dict.items():
            if xs and ys:
                plt.plot(xs, ys, label=label)
        if len(series_dict) > 1:
            plt.show()
        else:
            plt.show()
    else:
        section_header(title)
        for label, (xs, ys) in series_dict.items():
            print(sparkline(ys, label=label))


# ── Section 1: CPU Hotpath Heatmap ───────────────────────────────────


def print_cpu_hotpath(results_dir):
    """Analyze .cpuprofile files and print hotpath heatmap."""
    profiles = sorted(globmod.glob(os.path.join(results_dir, "*.cpuprofile")))
    if not profiles:
        # Also check /tmp/cpuprofiles/
        profiles = sorted(globmod.glob("/tmp/cpuprofiles/*.cpuprofile"))
    if not profiles:
        section_header("CPU HOTPATH (skipped \u2014 no .cpuprofile files found)")
        print("  Trigger profiling: curl -X POST http://localhost:3002/debug/cpu-profile")
        return

    for prof_path in profiles:
        basename = os.path.basename(prof_path)
        func_stats, total_us, sample_count = parse_cpuprofile(prof_path)
        if not func_stats:
            continue

        duration_s = total_us / 1_000_000
        label = basename.replace(".cpuprofile", "")

        print()
        print("=" * CHART_WIDTH)
        print(f"  CPU HOTPATH \u2014 {label} ({duration_s:.1f}s, {sample_count:,} samples)")
        print("=" * CHART_WIDTH)

        # ── Top functions by self-time ──
        sorted_funcs = sorted(func_stats.values(), key=lambda f: f["self_us"], reverse=True)
        top_n = 25

        section_header("TOP FUNCTIONS BY SELF TIME")
        print(f"  {'Self%':>6s}  {'Function':<32s}  {'Source'}")
        print("  " + "\u2500" * 6 + "  " + "\u2500" * 32 + "  " + "\u2500" * 30)

        for entry in sorted_funcs[:top_n]:
            pct = entry["self_us"] / total_us * 100
            if pct < 0.3:
                break
            name = entry["name"]
            if len(name) > 31:
                name = name[:28] + "..."
            source = map_to_source(entry["url"])
            line = entry["line"]
            loc = f"{source}:{line}" if line > 0 else source
            if len(loc) > 30:
                loc = "..." + loc[-27:]
            bar_len = max(0, min(6, int(pct / 100 * 30)))
            bar = BAR_CHAR * bar_len
            print(f"  {bar:<6s} {pct:5.1f}%  {name:<32s}  {loc}")

        # ── File heatmap ──
        file_times = {}
        for entry in func_stats.values():
            source = map_to_source(entry["url"])
            d = map_to_dir(source)
            file_times[d] = file_times.get(d, 0) + entry["self_us"]

        sorted_files = sorted(file_times.items(), key=lambda x: x[1], reverse=True)

        section_header("FILE HEATMAP (where CPU time is spent)")
        max_bar = 30
        for path, us in sorted_files[:12]:
            pct = us / total_us * 100
            if pct < 0.5:
                break
            print(bar_chart_line(path, pct, max_bar))


# ── Section 2: CPU% Over Time ────────────────────────────────────────


def compute_cpu_pct(records):
    """Compute per-worker CPU% between consecutive timeseries samples."""
    # Discover worker count from first record with workers
    worker_count = 0
    for r in records:
        workers = r.get("workers", [])
        ok_workers = [w for w in workers if w.get("status") == "ok"]
        if ok_workers:
            worker_count = len(ok_workers)
            break
    if worker_count == 0:
        return {}, {}

    # {worker_idx: [(elapsed_s, cpu_pct)]}
    cpu_series = {i: [] for i in range(worker_count)}
    lag_series = {i: [] for i in range(worker_count)}
    t0 = records[0].get("timestamp", 0)

    for i in range(1, len(records)):
        prev, curr = records[i - 1], records[i]
        dt_ms = curr.get("timestamp", 0) - prev.get("timestamp", 0)
        if dt_ms <= 0:
            continue
        dt_us = dt_ms * 1000  # ms → µs
        elapsed_s = (curr["timestamp"] - t0) / 1000

        for wi in range(worker_count):
            pw = prev.get("workers", [])
            cw = curr.get("workers", [])
            if wi >= len(pw) or wi >= len(cw):
                continue
            p, c = pw[wi], cw[wi]
            if p.get("status") != "ok" or c.get("status") != "ok":
                continue

            # CPU% from cpuUsage deltas
            pc = p.get("cpuUsage")
            cc = c.get("cpuUsage")
            if pc and cc:
                delta_cpu = (cc["user"] - pc["user"]) + (cc["system"] - pc["system"])
                cpu_pct = delta_cpu / dt_us * 100
                cpu_series[wi].append((elapsed_s, cpu_pct))

            # Loop lag
            lag = c.get("loopLagMsP95")
            if lag is not None:
                lag_series[wi].append((elapsed_s, lag))

    return cpu_series, lag_series


def print_cpu_over_time(records):
    """Print CPU% and event loop lag charts."""
    if len(records) < MIN_DATA_POINTS:
        section_header("CPU% OVER TIME (skipped \u2014 too few samples)")
        return

    cpu_series, lag_series = compute_cpu_pct(records)

    # CPU%
    has_cpu = any(len(s) > 0 for s in cpu_series.values())
    if has_cpu:
        chart_data = {}
        for wi, points in cpu_series.items():
            if points:
                xs, ys = zip(*points)
                chart_data[f"Worker {wi}"] = (list(xs), list(ys))
        plot_line_chart("CPU% PER WORKER OVER TIME", chart_data, ylabel="CPU %")
    else:
        section_header("CPU% OVER TIME (skipped \u2014 no cpuUsage data, upgrade server)")

    # Event loop lag
    has_lag = any(len(s) > 0 for s in lag_series.values())
    if has_lag:
        chart_data = {}
        for wi, points in lag_series.items():
            if points:
                xs, ys = zip(*points)
                chart_data[f"Worker {wi}"] = (list(xs), list(ys))
        plot_line_chart("EVENT LOOP LAG P95 (ms)", chart_data, ylabel="ms")


# ── Section 3: Memory Trend + Regression ─────────────────────────────


def print_memory_trend(records):
    """Print memory trend charts and leak regression."""
    if len(records) < MIN_DATA_POINTS:
        section_header("MEMORY TREND (skipped \u2014 too few samples)")
        return

    t0 = records[0].get("timestamp", 0)
    # Discover worker count
    worker_count = 0
    for r in records:
        workers = [w for w in r.get("workers", []) if w.get("status") == "ok"]
        if workers:
            worker_count = len(workers)
            break

    # Build per-worker heapUsed series
    heap_series = {i: [] for i in range(worker_count)}
    for r in records:
        elapsed = (r.get("timestamp", 0) - t0) / 1000
        for wi in range(worker_count):
            workers = r.get("workers", [])
            if wi < len(workers) and workers[wi].get("status") == "ok":
                heap_mb = mb(workers[wi]["memory"]["heapUsed"])
                heap_series[wi].append((elapsed, heap_mb))

    # Chart
    chart_data = {}
    for wi, points in heap_series.items():
        if points:
            xs, ys = zip(*points)
            chart_data[f"Worker {wi}"] = (list(xs), list(ys))
    plot_line_chart("HEAP USED (MB) PER WORKER", chart_data, ylabel="MB")

    # Leak regression
    section_header("MEMORY LEAK REGRESSION")
    print(f"  {'Worker':>8s}  {'Slope':>10s}  {'R\u00b2':>6s}  {'Verdict'}")
    print("  " + "\u2500" * 8 + "  " + "\u2500" * 10 + "  " + "\u2500" * 6 + "  " + "\u2500" * 30)
    for wi, points in heap_series.items():
        if len(points) < MIN_DATA_POINTS:
            continue
        xs, ys = zip(*points)
        slope, _, r2 = linear_regression(list(xs), list(ys))
        mb_per_hour = slope * 3600
        if mb_per_hour > 5 and r2 > 0.7:
            verdict = "*** SUSPECTED LEAK"
        elif mb_per_hour > 2:
            verdict = "monitor"
        else:
            verdict = "ok"
        print(f"  {'W' + str(wi):>8s}  {mb_per_hour:>+8.1f}/hr  {r2:>6.2f}  {verdict}")


# ── Section 4: GC Pressure ───────────────────────────────────────────


def print_gc_pressure(records):
    """Print GC pause time chart."""
    if len(records) < MIN_DATA_POINTS:
        return

    t0 = records[0].get("timestamp", 0)
    worker_count = 0
    for r in records:
        workers = [w for w in r.get("workers", []) if w.get("status") == "ok"]
        if workers:
            worker_count = len(workers)
            break

    gc_series = {i: [] for i in range(worker_count)}
    for r in records:
        elapsed = (r.get("timestamp", 0) - t0) / 1000
        for wi in range(worker_count):
            workers = r.get("workers", [])
            if wi < len(workers) and workers[wi].get("status") == "ok":
                gc = workers[wi].get("gc")
                if gc:
                    gc_series[wi].append((elapsed, gc.get("windowPauseMs", 0)))

    has_gc = any(len(s) > 0 for s in gc_series.values())
    if has_gc:
        chart_data = {}
        for wi, points in gc_series.items():
            if points:
                xs, ys = zip(*points)
                chart_data[f"Worker {wi}"] = (list(xs), list(ys))
        plot_line_chart("GC PAUSE TIME PER WINDOW (ms)", chart_data, ylabel="ms")


# ── Section 5: Map Sizes ─────────────────────────────────────────────


def print_map_sizes(records):
    """Print in-memory map size charts."""
    if len(records) < MIN_DATA_POINTS:
        return

    t0 = records[0].get("timestamp", 0)
    worker_count = 0
    for r in records:
        workers = [w for w in r.get("workers", []) if w.get("status") == "ok"]
        if workers:
            worker_count = len(workers)
            break

    calls_series = {i: [] for i in range(worker_count)}
    txn_series = {i: [] for i in range(worker_count)}
    for r in records:
        elapsed = (r.get("timestamp", 0) - t0) / 1000
        for wi in range(worker_count):
            workers = r.get("workers", [])
            if wi < len(workers) and workers[wi].get("status") == "ok":
                ms = workers[wi].get("mapSizes", {})
                calls_series[wi].append((elapsed, ms.get("callsMap", 0)))
                txn_series[wi].append((elapsed, ms.get("txnMap", 0)))

    chart_data = {}
    for wi, points in calls_series.items():
        if points:
            xs, ys = zip(*points)
            chart_data[f"W{wi} calls"] = (list(xs), list(ys))
    for wi, points in txn_series.items():
        if points:
            xs, ys = zip(*points)
            chart_data[f"W{wi} txn"] = (list(xs), list(ys))
    if chart_data:
        plot_line_chart("MAP SIZES (callsMap + txnMap)", chart_data, ylabel="entries")


# ── Section 6: SIPp Load Profile ─────────────────────────────────────


def print_sipp_profile(results_dir):
    """Print SIPp call rate and concurrent call charts + summary."""
    path = os.path.join(results_dir, "stress-stats.csv")
    header, col_idx, rows = parse_sipp_csv(path)
    if not rows or not col_idx:
        section_header("SIPP LOAD PROFILE (skipped \u2014 no stress-stats.csv)")
        return

    # Filter out zero-state rows
    elapsed_c_idx = col_idx.get("ElapsedTime(C)")
    call_rate_p_idx = col_idx.get("CallRate(P)")
    current_call_idx = col_idx.get("CurrentCall")
    successful_c_idx = col_idx.get("SuccessfulCall(C)")
    failed_c_idx = col_idx.get("FailedCall(C)")
    total_created_idx = col_idx.get("TotalCallCreated")
    resp_time_c_idx = col_idx.get("ResponseTime1(C)")

    data_rows = []
    for r in rows:
        elapsed = parse_sipp_elapsed(r[elapsed_c_idx]) if elapsed_c_idx is not None else 0
        # Skip zero-state initial row and terminal row
        rate_str = r[call_rate_p_idx] if call_rate_p_idx is not None else "0"
        try:
            rate = float(rate_str)
        except ValueError:
            rate = 0.0
        if elapsed == 0 and rate == 0:
            continue
        data_rows.append((elapsed, r))

    if not data_rows:
        return

    # Build chart series
    elapsed_xs = [d[0] for d in data_rows]
    call_rates = []
    concurrent = []
    for _, r in data_rows:
        try:
            call_rates.append(float(r[call_rate_p_idx]))
        except (ValueError, TypeError):
            call_rates.append(0.0)
        try:
            concurrent.append(int(r[current_call_idx]))
        except (ValueError, TypeError):
            concurrent.append(0)

    chart_data = {
        "Call Rate (cps)": (elapsed_xs, call_rates),
        "Concurrent": (elapsed_xs, concurrent),
    }
    plot_line_chart("SIPP LOAD PROFILE", chart_data, ylabel="cps / calls")

    # Summary stats from last row
    last = data_rows[-1][1]
    total = int(last[total_created_idx]) if total_created_idx is not None else 0
    successful = int(last[successful_c_idx]) if successful_c_idx is not None else 0
    failed = int(last[failed_c_idx]) if failed_c_idx is not None else 0
    error_pct = (failed / total * 100) if total > 0 else 0.0

    # Response time from cumulative column
    resp_time_ms = 0.0
    if resp_time_c_idx is not None:
        resp_time_ms = parse_sipp_time(last[resp_time_c_idx])

    # Parse response time repartition buckets for percentiles
    rt_buckets = []
    for name, idx in col_idx.items():
        if name.startswith("ResponseTimeRepartition1_"):
            threshold = name.split("_", 1)[1]
            try:
                count = int(last[idx])
            except (ValueError, IndexError):
                count = 0
            rt_buckets.append((threshold, count))

    avg_cps = total / elapsed_xs[-1] if elapsed_xs[-1] > 0 else 0

    section_header("SIPP SUMMARY")
    print(f"  Total calls:   {total:>10,}")
    print(f"  Successful:    {successful:>10,}")
    print(f"  Failed:        {failed:>10,}")
    print(f"  Error rate:    {error_pct:>9.1f}%")
    print(f"  Avg CPS:       {avg_cps:>10.1f}")
    print(f"  Resp time avg: {resp_time_ms:>8.1f} ms")
    if rt_buckets:
        print()
        print("  Response time distribution:")
        for threshold, count in rt_buckets:
            if count > 0:
                pct = count / successful * 100 if successful > 0 else 0
                print(f"    {threshold:>8s}: {count:>8,} ({pct:5.1f}%)")

    return {
        "total": total,
        "successful": successful,
        "failed": failed,
        "error_pct": error_pct,
        "avg_cps": avg_cps,
        "resp_time_ms": resp_time_ms,
    }


# ── Summary ──────────────────────────────────────────────────────────


def print_summary(records, sipp_stats):
    """Print consolidated performance summary."""
    print()
    print("=" * CHART_WIDTH)
    print("  PERFORMANCE SUMMARY")
    print("=" * CHART_WIDTH)

    cpu_series, lag_series = compute_cpu_pct(records)

    # CPU
    all_cpu = [pct for points in cpu_series.values() for _, pct in points]
    if all_cpu:
        avg_cpu = sum(all_cpu) / len(all_cpu)
        peak_cpu = max(all_cpu)
        print(f"  CPU:      avg {avg_cpu:.1f}%  peak {peak_cpu:.1f}%  (per-core)")
    else:
        print("  CPU:      (no data \u2014 upgrade server for cpuUsage)")

    # Loop lag
    all_lag = [lag for points in lag_series.values() for _, lag in points]
    if all_lag:
        avg_lag = sum(all_lag) / len(all_lag)
        peak_lag = max(all_lag)
        print(f"  Loop lag: avg {avg_lag:.1f}ms  peak {peak_lag:.1f}ms")

    # GC
    gc_total = 0
    gc_max = 0
    for r in records:
        for w in r.get("workers", []):
            if w.get("status") != "ok":
                continue
            gc = w.get("gc", {})
            gc_total += gc.get("windowPauseMs", 0)
            gc_max = max(gc_max, gc.get("maxPauseMs", 0))
    if gc_total > 0 or gc_max > 0:
        print(f"  GC:       total {gc_total / 1000:.1f}s  max pause {gc_max:.0f}ms")

    # Memory
    worker_count = 0
    for r in records:
        workers = [w for w in r.get("workers", []) if w.get("status") == "ok"]
        if workers:
            worker_count = len(workers)
            break

    t0 = records[0].get("timestamp", 0) if records else 0
    for wi in range(worker_count):
        heap_points = []
        peak_rss = 0
        peak_heap = 0
        for r in records:
            workers = r.get("workers", [])
            if wi < len(workers) and workers[wi].get("status") == "ok":
                elapsed = (r.get("timestamp", 0) - t0) / 1000
                heap_mb = mb(workers[wi]["memory"]["heapUsed"])
                heap_points.append((elapsed, heap_mb))
                peak_rss = max(peak_rss, mb(workers[wi]["memory"]["rss"]))
                peak_heap = max(peak_heap, heap_mb)
        if len(heap_points) >= MIN_DATA_POINTS:
            xs, ys = zip(*heap_points)
            slope, _, r2 = linear_regression(list(xs), list(ys))
            mb_hr = slope * 3600
            leak_str = f"  leak {mb_hr:+.1f} MB/hr (R\u00b2={r2:.2f})"
            if mb_hr > 5 and r2 > 0.7:
                leak_str += " ***"
        else:
            leak_str = ""
        print(f"  Memory W{wi}: peak RSS {peak_rss:.0f}MB  heap {peak_heap:.0f}MB{leak_str}")

    # SIPp
    if sipp_stats:
        s = sipp_stats
        print(f"  SIPp:     avg {s['avg_cps']:.1f} cps  {s['successful']}/{s['total']} ok  {s['failed']} failed")
        print(f"  Latency:  mean {s['resp_time_ms']:.1f}ms")

    print("=" * CHART_WIDTH)


# ── Main ─────────────────────────────────────────────────────────────


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 analyze-perf.py <results-dir>")
        print()
        print("Example:")
        print("  python3 analyze-perf.py /tmp/memleak-results/20260412-174501/")
        sys.exit(1)

    results_dir = sys.argv[1]
    if not os.path.isdir(results_dir):
        print(f"ERROR: {results_dir} is not a directory")
        sys.exit(1)

    if not HAS_PLOTEXT:
        print("  NOTE: Install plotext for full terminal charts: pip install plotext")
        print("        Falling back to sparkline mode.")
        print()

    print()
    print("=" * CHART_WIDTH)
    print("  PERFORMANCE ANALYSIS")
    print("=" * CHART_WIDTH)
    print(f"  Results: {results_dir}")

    # Load timeseries data
    ts_path = os.path.join(results_dir, "memory-timeseries.jsonl")
    records = parse_memory_jsonl(ts_path)
    if records:
        print(f"  Timeseries: {len(records)} samples")
    else:
        print("  Timeseries: (not found)")

    # 1. CPU hotpath heatmap
    print_cpu_hotpath(results_dir)

    # 2. CPU% and event loop lag over time
    print_cpu_over_time(records)

    # 3. Memory trend + regression
    print_memory_trend(records)

    # 4. GC pressure
    print_gc_pressure(records)

    # 5. Map sizes
    print_map_sizes(records)

    # 6. SIPp load profile + summary
    sipp_stats = print_sipp_profile(results_dir)

    # 7. Consolidated summary
    if records:
        print_summary(records, sipp_stats)

    print()
    print(f"  Full results in: {results_dir}")
    print()


if __name__ == "__main__":
    main()
