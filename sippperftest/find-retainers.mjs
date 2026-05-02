#!/usr/bin/env node
/**
 * Retainer-chain finder for V8 heap snapshots — zero dependencies.
 *
 * Usage:
 *   node find-retainers.mjs <snapshot.heapsnapshot> <ConstructorName> [maxSamples]
 *
 * For each instance of ConstructorName (up to maxSamples, default 5),
 * walks backward through the inverse edge graph until it hits a GC root
 * (synthetic node) or a depth cap, and prints the retainer chain.
 *
 * "Retainer of X" = a node that has an edge pointing TO X.
 */

import { readFileSync } from "node:fs"

const [, , snapshotPath, ctorName, maxSamplesArg] = process.argv
if (!snapshotPath || !ctorName) {
  console.error("Usage: node find-retainers.mjs <snapshot> <ConstructorName> [maxSamples]")
  process.exit(2)
}
const maxSamples = parseInt(maxSamplesArg ?? "5", 10)
const MAX_DEPTH = 30

process.stderr.write(`Loading ${snapshotPath}...\n`)
const snap = JSON.parse(readFileSync(snapshotPath, "utf8"))
process.stderr.write(`Indexing graph...\n`)

const meta = snap.snapshot.meta
const nodeFields = meta.node_fields
const nodeTypes = meta.node_types[0]
const edgeFields = meta.edge_fields
const edgeTypes = meta.edge_types[0]
const NF = nodeFields.length
const EF = edgeFields.length

const NTYPE = nodeFields.indexOf("type")
const NNAME = nodeFields.indexOf("name")
const NID = nodeFields.indexOf("id")
const NSIZE = nodeFields.indexOf("self_size")
const NEDGES = nodeFields.indexOf("edge_count")

const ETYPE = edgeFields.indexOf("type")
const ENAME = edgeFields.indexOf("name_or_index")
const ETO = edgeFields.indexOf("to_node")

const nodes = snap.nodes
const edges = snap.edges
const strings = snap.strings
const nodeCount = snap.snapshot.node_count
const edgeCount = snap.snapshot.edge_count

// Compute edge offset for each node (cumulative).
const edgeOffsetByNodeIdx = new Int32Array(nodeCount + 1)
let cursor = 0
for (let i = 0; i < nodeCount; i++) {
  edgeOffsetByNodeIdx[i] = cursor
  cursor += nodes[i * NF + NEDGES]
}
edgeOffsetByNodeIdx[nodeCount] = cursor

// to_node in edges is a BYTE OFFSET into the nodes array, not a node index.
// Convert to node index: nodeIdx = to_node / NF.
function toNodeIdx(edgeIdx) {
  return edges[edgeIdx * EF + ETO] / NF
}

// Build inverse edges: nodeIdx -> array of (parentIdx, edgeIdxFromParent).
process.stderr.write(`Building inverse edge index...\n`)
const inverse = Array.from({ length: nodeCount }, () => [])
for (let i = 0; i < nodeCount; i++) {
  const eStart = edgeOffsetByNodeIdx[i]
  const eEnd = edgeOffsetByNodeIdx[i + 1]
  for (let e = eStart; e < eEnd; e++) {
    const target = toNodeIdx(e)
    if (target >= 0 && target < nodeCount) {
      inverse[target].push([i, e])
    }
  }
}

function nodeLabel(idx) {
  const base = idx * NF
  const typeName = nodeTypes[nodes[base + NTYPE]] ?? "?"
  const name = strings[nodes[base + NNAME]] ?? ""
  const size = nodes[base + NSIZE]
  const id = nodes[base + NID]
  return `${typeName}/${name || "(anon)"}@${id} [${size}B]`
}

function edgeLabel(eIdx) {
  const tIdx = edges[eIdx * EF + ETYPE]
  const nameOrIdx = edges[eIdx * EF + ENAME]
  const t = edgeTypes[tIdx] ?? "?"
  // For "element" / "hidden" edges, name_or_index is a numeric index.
  // For named edges (property, internal, weak, ...), it's a string index.
  if (t === "element" || t === "hidden") return `[${nameOrIdx}](${t})`
  const s = strings[nameOrIdx] ?? `${nameOrIdx}`
  return `.${s}(${t})`
}

// Find target nodes by constructor name.
const candidates = []
for (let i = 0; i < nodeCount; i++) {
  const typeName = nodeTypes[nodes[i * NF + NTYPE]]
  if (typeName !== "object" && typeName !== "closure") continue
  const name = strings[nodes[i * NF + NNAME]]
  if (name === ctorName) candidates.push(i)
}

console.log(`Found ${candidates.length} instance(s) of "${ctorName}".`)
if (candidates.length === 0) process.exit(0)

const sample = candidates.slice(0, maxSamples)
console.log(`Walking retainer chains for ${sample.length} sample(s) (max depth ${MAX_DEPTH}):`)
console.log()

for (const startIdx of sample) {
  console.log(`── ${nodeLabel(startIdx)} ─────────────────────────────────`)
  // Walk one chain — pick the first non-weak parent at each step. Avoid
  // cycles by tracking visited.
  let cur = startIdx
  const visited = new Set([cur])
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const parents = inverse[cur]
    if (parents.length === 0) {
      console.log(`  (no retainer — GC root or unreachable from any edge)`)
      break
    }
    // Prefer non-weak edges; among them prefer non-synthetic parents
    // until we've climbed past the immediate roots.
    let pick = null
    for (const [p, e] of parents) {
      const eType = edgeTypes[edges[e * EF + ETYPE]]
      if (eType === "weak") continue
      if (visited.has(p)) continue
      pick = [p, e]
      break
    }
    if (pick === null) {
      // Fall back to any parent
      pick = parents.find(([p]) => !visited.has(p)) ?? null
    }
    if (pick === null) {
      console.log(`  (cycle / dead-end after depth ${depth})`)
      break
    }
    const [p, e] = pick
    console.log(`  ← ${edgeLabel(e)} from ${nodeLabel(p)}`)
    visited.add(p)
    cur = p
    const ptype = nodeTypes[nodes[p * NF + NTYPE]]
    if (ptype === "synthetic") {
      console.log(`  (reached synthetic GC root)`)
      break
    }
  }
  console.log()
}
