#!/usr/bin/env python3
"""Look up a SIP call trace in Tempo by Call-ID or Request-URI (substring match)."""

import sys
import json
import urllib.request
import urllib.parse
import re
import argparse

TEMPO_URL = "http://localhost:3200"

def search(query: str, limit: int = 5) -> list:
    params = urllib.parse.urlencode({"q": query, "limit": limit})
    url = f"{TEMPO_URL}/api/search?{params}"
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read()).get("traces", [])
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        print(f"  (query failed: {body[:200]})", file=sys.stderr)
        return []

def fetch_trace(trace_id: str) -> dict:
    with urllib.request.urlopen(f"{TEMPO_URL}/api/traces/{trace_id}") as resp:
        return json.loads(resp.read())

def extract_spans(data: dict) -> list:
    spans = []
    for batch in data.get("batches", []):
        for scope in batch.get("scopeSpans", []):
            for span in scope.get("spans", []):
                attrs = {}
                for a in span.get("attributes", []):
                    v = a.get("value", {})
                    attrs[a["key"]] = v.get("stringValue") or v.get("intValue") or v.get("boolValue", "")
                spans.append({
                    "id": span["spanId"],
                    "parent": span.get("parentSpanId", ""),
                    "name": span["name"],
                    "start": int(span.get("startTimeUnixNano", 0)),
                    "end": int(span.get("endTimeUnixNano", 0)),
                    "attrs": attrs,
                })
    return spans

def print_tree(spans: list):
    by_id = {s["id"]: s for s in spans}
    children = {}
    root = None
    for s in spans:
        if not s["parent"] or s["parent"] not in by_id:
            root = s
        else:
            children.setdefault(s["parent"], []).append(s)
    # Sort children by start time
    for kids in children.values():
        kids.sort(key=lambda s: s["start"])

    if not root:
        print("  (no root span found)")
        return

    def fmt_duration(s):
        ns = s["end"] - s["start"]
        if ns >= 1_000_000:
            return f"{ns / 1_000_000:.1f}ms"
        return f"{ns / 1_000:.1f}us"

    def walk(span, depth=0):
        indent = "  " * depth
        prefix = "\u25a0" if depth == 0 else "\u2514\u2500"
        dur = fmt_duration(span)
        # Show key SIP attributes inline
        a = span["attrs"]
        tags = []
        if "sip.method" in a:
            tags.append(a["sip.method"])
        if "sip.status_code" in a:
            tags.append(str(a["sip.status_code"]))
        if "sip.direction" in a:
            tags.append(a["sip.direction"])
        if "net.peer.addr" in a:
            tags.append(a["net.peer.addr"])
        tag_str = f"  [{', '.join(tags)}]" if tags else ""
        print(f"{indent}{prefix} {span['name']}  ({dur}){tag_str}")

        # Print raw message snippet if present (first 120 chars of first line)
        if "sip.raw_message" in a:
            first_line = a["sip.raw_message"].split("\\r\\n")[0][:120]
            print(f"{indent}   \u2502 {first_line}")

        for child in children.get(span["id"], []):
            walk(child, depth + 1)

    walk(root)

def escape_traceql(term: str) -> str:
    """Escape regex metacharacters for TraceQL (Go RE2 inside double-quoted string)."""
    escaped = ""
    for c in term:
        if c in r"\.+*?^${}()|[]":
            escaped += "\\\\" + c
        else:
            escaped += c
    return escaped

def main():
    parser = argparse.ArgumentParser(
        description="Look up SIP call traces in Tempo by Call-ID or Request-URI (substring match)")
    parser.add_argument("term", help="Search term (matched against a-leg Call-ID, b-leg Call-ID, and Request-URI)")
    parser.add_argument("--json", metavar="FILE", help="Export raw Tempo JSON payload to FILE (use - for stdout)")
    parser.add_argument("--url", default="http://localhost:3200", help="Tempo API URL (default: http://localhost:3200)")
    parser.add_argument("--limit", type=int, default=5, help="Max traces per query (default: 5)")
    args = parser.parse_args()

    global TEMPO_URL
    TEMPO_URL = args.url

    escaped = escape_traceql(args.term)

    queries = [
        f'{{span.sip.call_id.a_leg =~ ".*{escaped}.*"}}',
        f'{{span.sip.call_id.b_leg =~ ".*{escaped}.*"}}',
        f'{{span.sip.request_uri =~ ".*{escaped}.*"}}',
    ]

    seen = {}
    for q in queries:
        for t in search(q, args.limit):
            tid = t["traceID"]
            if tid not in seen:
                seen[tid] = t

    if not seen:
        print(f"No traces found matching '{args.term}'")
        sys.exit(1)

    # Fetch all trace payloads
    traces = {}
    for tid in seen:
        traces[tid] = fetch_trace(tid)

    # Export JSON if requested
    if args.json:
        payload = {"traces": {tid: data for tid, data in traces.items()}}
        json_str = json.dumps(payload, indent=2)
        if args.json == "-":
            print(json_str)
            return
        else:
            with open(args.json, "w") as f:
                f.write(json_str)
            print(f"Exported {len(traces)} trace(s) to {args.json}")

    # Print human-readable output
    print(f"Found {len(seen)} trace(s) matching '{args.term}':\n")

    for tid, meta in sorted(seen.items(), key=lambda x: x[1].get("startTimeUnixNano", ""), reverse=True):
        span_count = sum(s.get("spanCount", 0) for s in meta.get("serviceStats", {}).values())
        dur = meta.get("durationMs", "?")
        print(f"=== Trace {tid}  ({span_count} spans, {dur}ms) ===")

        data = traces[tid]
        spans = extract_spans(data)
        if not spans:
            print("  (no spans returned)")
            continue

        root = next((s for s in spans if not s["parent"] or s["parent"] not in {x["id"] for x in spans}), None)
        if root:
            a = root["attrs"]
            print(f"  Call-ID (a): {a.get('sip.call_id.a_leg', 'n/a')}")
            print(f"  Call-ID (b): {a.get('sip.call_id.b_leg', 'n/a')}")
            print(f"  From:        {a.get('sip.from_uri', 'n/a')}")
            print(f"  Request-URI: {a.get('sip.request_uri', 'n/a')}")
            print(f"  Peer:        {a.get('net.peer.addr', 'n/a')}")
            print()

        print_tree(spans)
        print()

if __name__ == "__main__":
    main()
