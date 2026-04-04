#!/usr/bin/env node
/**
 * V8 heap snapshot analyzer — zero dependencies.
 *
 * Usage:
 *   node analyze-heap.mjs <snapshot.heapsnapshot>                  # summary
 *   node analyze-heap.mjs <baseline.heapsnapshot> <stress.heapsnapshot>  # diff
 *
 * Parses the V8 JSON format directly and produces:
 *   - Top constructors by retained count and self-size
 *   - (diff mode) Delta between two snapshots, sorted by growth
 */

import { readFileSync } from "node:fs"

// ── Snapshot parser ─────────────────────────────────────────────────

function parseSnapshot(path) {
  process.stderr.write(`Loading ${path}...\n`)
  const raw = readFileSync(path, "utf8")
  process.stderr.write(`Parsing JSON...\n`)
  const snap = JSON.parse(raw)

  const meta = snap.snapshot.meta
  const nodeFields = meta.node_fields
  const nodeTypes = meta.node_types[0] // array of type strings
  const fieldCount = nodeFields.length
  const nodes = snap.nodes
  const strings = snap.strings

  // Field indices
  const TYPE_IDX = nodeFields.indexOf("type")
  const NAME_IDX = nodeFields.indexOf("name")
  const SELF_SIZE_IDX = nodeFields.indexOf("self_size")
  const EDGE_COUNT_IDX = nodeFields.indexOf("edge_count")

  // Aggregate by constructor name
  const byConstructor = new Map() // name -> { count, selfSize }

  const nodeCount = snap.snapshot.node_count
  for (let i = 0; i < nodeCount; i++) {
    const base = i * fieldCount
    const typeIdx = nodes[base + TYPE_IDX]
    const nameIdx = nodes[base + NAME_IDX]
    const selfSize = nodes[base + SELF_SIZE_IDX]

    const typeName = nodeTypes[typeIdx] ?? "unknown"
    const name = strings[nameIdx] ?? ""

    // Use "type/name" as the key for grouping
    // For objects: constructor name; for closures: function name; etc.
    let key
    if (typeName === "object" || typeName === "closure" || typeName === "regexp") {
      key = name || `(anonymous ${typeName})`
    } else if (typeName === "string" || typeName === "concatenated string" || typeName === "sliced string") {
      key = `(${typeName})`
    } else if (typeName === "code") {
      key = `(compiled code)`
    } else if (typeName === "native") {
      key = name ? `(native) ${name}` : "(native)"
    } else {
      key = `(${typeName}) ${name || ""}`.trim()
    }

    const entry = byConstructor.get(key)
    if (entry) {
      entry.count++
      entry.selfSize += selfSize
    } else {
      byConstructor.set(key, { count: 1, selfSize })
    }
  }

  return { nodeCount, byConstructor, path }
}

// ── Formatters ──────────────────────────────────────────────────────

function formatBytes(bytes) {
  const sign = bytes < 0 ? "-" : ""
  const abs = Math.abs(bytes)
  if (abs < 1024) return `${sign}${abs} B`
  if (abs < 1048576) return `${sign}${(abs / 1024).toFixed(1)} KB`
  return `${sign}${(abs / 1048576).toFixed(1)} MB`
}

function padL(s, n) { return String(s).padStart(n) }
function padR(s, n) { return String(s).padEnd(n) }

// ── Single snapshot summary ─────────────────────────────────────────

function printSummary(snap) {
  const sorted = [...snap.byConstructor.entries()]
    .sort((a, b) => b[1].selfSize - a[1].selfSize)

  const totalSize = sorted.reduce((sum, [, v]) => sum + v.selfSize, 0)
  const totalCount = sorted.reduce((sum, [, v]) => sum + v.count, 0)

  console.log("=".repeat(80))
  console.log(`  HEAP SNAPSHOT SUMMARY: ${snap.path}`)
  console.log("=".repeat(80))
  console.log(`  Total nodes: ${totalCount.toLocaleString()}`)
  console.log(`  Total self-size: ${formatBytes(totalSize)}`)
  console.log()

  // Top 30 by self-size
  console.log("  TOP 30 BY SELF-SIZE")
  console.log("  " + "-".repeat(76))
  console.log(
    `  ${padR("Constructor / Type", 45)} ${padL("Count", 10)} ${padL("Self-Size", 14)}`
  )
  console.log("  " + "-".repeat(76))

  for (const [name, data] of sorted.slice(0, 30)) {
    const displayName = name.length > 44 ? name.slice(0, 41) + "..." : name
    console.log(
      `  ${padR(displayName, 45)} ${padL(data.count.toLocaleString(), 10)} ${padL(formatBytes(data.selfSize), 14)}`
    )
  }

  console.log()

  // Top 30 by count
  const sortedByCount = [...snap.byConstructor.entries()]
    .sort((a, b) => b[1].count - a[1].count)

  console.log("  TOP 30 BY INSTANCE COUNT")
  console.log("  " + "-".repeat(76))
  console.log(
    `  ${padR("Constructor / Type", 45)} ${padL("Count", 10)} ${padL("Self-Size", 14)}`
  )
  console.log("  " + "-".repeat(76))

  for (const [name, data] of sortedByCount.slice(0, 30)) {
    const displayName = name.length > 44 ? name.slice(0, 41) + "..." : name
    console.log(
      `  ${padR(displayName, 45)} ${padL(data.count.toLocaleString(), 10)} ${padL(formatBytes(data.selfSize), 14)}`
    )
  }

  console.log("=".repeat(80))
}

// ── Diff two snapshots ──────────────────────────────────────────────

function printDiff(baseline, stress) {
  // Merge keys from both
  const allKeys = new Set([
    ...baseline.byConstructor.keys(),
    ...stress.byConstructor.keys(),
  ])

  const diffs = []
  for (const key of allKeys) {
    const b = baseline.byConstructor.get(key) ?? { count: 0, selfSize: 0 }
    const s = stress.byConstructor.get(key) ?? { count: 0, selfSize: 0 }
    diffs.push({
      name: key,
      countBaseline: b.count,
      countStress: s.count,
      countDelta: s.count - b.count,
      sizeBaseline: b.selfSize,
      sizeStress: s.selfSize,
      sizeDelta: s.selfSize - b.selfSize,
    })
  }

  const totalBaselineSize = [...baseline.byConstructor.values()].reduce((s, v) => s + v.selfSize, 0)
  const totalStressSize = [...stress.byConstructor.values()].reduce((s, v) => s + v.selfSize, 0)

  console.log("=".repeat(90))
  console.log("  HEAP SNAPSHOT COMPARISON")
  console.log("=".repeat(90))
  console.log(`  Baseline : ${baseline.path}`)
  console.log(`  Stress   : ${stress.path}`)
  console.log(`  Total self-size: baseline=${formatBytes(totalBaselineSize)}  stress=${formatBytes(totalStressSize)}  delta=${formatBytes(totalStressSize - totalBaselineSize)}`)
  console.log()

  // ── Top growers by size delta ─────────────────────────────────
  const byGrowth = diffs
    .filter((d) => d.sizeDelta > 0)
    .sort((a, b) => b.sizeDelta - a.sizeDelta)

  console.log("  TOP 30 GROWERS BY SIZE (what grew between baseline and stress)")
  console.log("  " + "-".repeat(86))
  console.log(
    `  ${padR("Constructor / Type", 36)} ${padL("Base #", 9)} ${padL("Stress #", 9)} ${padL("Delta #", 9)} ${padL("Base Size", 11)} ${padL("Delta Size", 11)}`
  )
  console.log("  " + "-".repeat(86))

  for (const d of byGrowth.slice(0, 30)) {
    const displayName = d.name.length > 35 ? d.name.slice(0, 32) + "..." : d.name
    const flag = d.sizeDelta > 1048576 ? " ***" : ""
    console.log(
      `  ${padR(displayName, 36)} ${padL(d.countBaseline.toLocaleString(), 9)} ${padL(d.countStress.toLocaleString(), 9)} ${padL("+" + d.countDelta.toLocaleString(), 9)} ${padL(formatBytes(d.sizeBaseline), 11)} ${padL("+" + formatBytes(d.sizeDelta), 11)}${flag}`
    )
  }

  console.log()

  // ── Top growers by count delta ────────────────────────────────
  const byCountGrowth = diffs
    .filter((d) => d.countDelta > 0)
    .sort((a, b) => b.countDelta - a.countDelta)

  console.log("  TOP 30 GROWERS BY COUNT (most new instances)")
  console.log("  " + "-".repeat(86))
  console.log(
    `  ${padR("Constructor / Type", 36)} ${padL("Base #", 9)} ${padL("Stress #", 9)} ${padL("Delta #", 9)} ${padL("Base Size", 11)} ${padL("Delta Size", 11)}`
  )
  console.log("  " + "-".repeat(86))

  for (const d of byCountGrowth.slice(0, 30)) {
    const displayName = d.name.length > 35 ? d.name.slice(0, 32) + "..." : d.name
    const flag = d.countDelta > 1000 ? " ***" : ""
    console.log(
      `  ${padR(displayName, 36)} ${padL(d.countBaseline.toLocaleString(), 9)} ${padL(d.countStress.toLocaleString(), 9)} ${padL("+" + d.countDelta.toLocaleString(), 9)} ${padL(formatBytes(d.sizeBaseline), 11)} ${padL("+" + formatBytes(d.sizeDelta), 11)}${flag}`
    )
  }

  console.log()

  // ── Top shrinkers ─────────────────────────────────────────────
  const shrinkers = diffs
    .filter((d) => d.sizeDelta < -1024)
    .sort((a, b) => a.sizeDelta - b.sizeDelta)

  if (shrinkers.length > 0) {
    console.log("  TOP 10 SHRINKERS BY SIZE (freed between baseline and stress)")
    console.log("  " + "-".repeat(86))
    console.log(
      `  ${padR("Constructor / Type", 36)} ${padL("Base #", 9)} ${padL("Stress #", 9)} ${padL("Delta #", 9)} ${padL("Base Size", 11)} ${padL("Delta Size", 11)}`
    )
    console.log("  " + "-".repeat(86))

    for (const d of shrinkers.slice(0, 10)) {
      const displayName = d.name.length > 35 ? d.name.slice(0, 32) + "..." : d.name
      console.log(
        `  ${padR(displayName, 36)} ${padL(d.countBaseline.toLocaleString(), 9)} ${padL(d.countStress.toLocaleString(), 9)} ${padL(d.countDelta.toLocaleString(), 9)} ${padL(formatBytes(d.sizeBaseline), 11)} ${padL(formatBytes(d.sizeDelta), 11)}`
      )
    }
    console.log()
  }

  // ── Verdict ───────────────────────────────────────────────────
  const bigGrowers = byGrowth.filter((d) => d.sizeDelta > 1048576) // > 1MB
  if (bigGrowers.length > 0) {
    console.log("  SUSPECT CONSTRUCTORS (grew > 1MB):")
    for (const d of bigGrowers) {
      console.log(`    ${d.name}: +${formatBytes(d.sizeDelta)} (+${d.countDelta.toLocaleString()} instances)`)
    }
  } else {
    console.log("  No constructors grew by more than 1MB.")
  }

  console.log("=".repeat(90))
}

// ── Main ────────────────────────────────────────────────────────────

const args = process.argv.slice(2)

if (args.length === 0) {
  console.log("Usage:")
  console.log("  node analyze-heap.mjs <snapshot>                     # summary of one snapshot")
  console.log("  node analyze-heap.mjs <baseline> <stress>            # diff two snapshots")
  console.log()
  console.log("Example:")
  console.log("  node analyze-heap.mjs /tmp/heapdumps/heap-worker-0-*.heapsnapshot")
  process.exit(0)
}

if (args.length === 1) {
  const snap = parseSnapshot(args[0])
  printSummary(snap)
} else {
  const baseline = parseSnapshot(args[0])
  const stress = parseSnapshot(args[1])
  printDiff(baseline, stress)
}
