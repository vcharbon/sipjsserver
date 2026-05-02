#!/usr/bin/env node
// List ALL direct retainers of one node (instead of walking one chain).
// Usage: node list-retainers.mjs <snapshot> <ConstructorName>

import { readFileSync } from "node:fs"

const [, , path, ctor] = process.argv
const snap = JSON.parse(readFileSync(path, "utf8"))
const meta = snap.snapshot.meta
const NF = meta.node_fields.length
const EF = meta.edge_fields.length
const NTYPE = meta.node_fields.indexOf("type")
const NNAME = meta.node_fields.indexOf("name")
const NID = meta.node_fields.indexOf("id")
const NSIZE = meta.node_fields.indexOf("self_size")
const NEDGES = meta.node_fields.indexOf("edge_count")
const ETYPE = meta.edge_fields.indexOf("type")
const ENAME = meta.edge_fields.indexOf("name_or_index")
const ETO = meta.edge_fields.indexOf("to_node")
const nodeTypes = meta.node_types[0]
const edgeTypes = meta.edge_types[0]
const nodes = snap.nodes, edges = snap.edges, strings = snap.strings
const nodeCount = snap.snapshot.node_count

const offsets = new Int32Array(nodeCount + 1)
let c = 0
for (let i = 0; i < nodeCount; i++) {
  offsets[i] = c
  c += nodes[i * NF + NEDGES]
}
offsets[nodeCount] = c

const inverse = Array.from({ length: nodeCount }, () => [])
for (let i = 0; i < nodeCount; i++) {
  for (let e = offsets[i]; e < offsets[i + 1]; e++) {
    const target = edges[e * EF + ETO] / NF
    if (target >= 0 && target < nodeCount) inverse[target].push([i, e])
  }
}

const candidates = []
for (let i = 0; i < nodeCount; i++) {
  if (nodeTypes[nodes[i * NF + NTYPE]] !== "object") continue
  if (strings[nodes[i * NF + NNAME]] === ctor) candidates.push(i)
}
console.log(`Found ${candidates.length} ${ctor}.`)

// Take the first candidate, list all its retainers.
const sample = candidates[0]
console.log(`Sample: id=${nodes[sample * NF + NID]}`)
const parents = inverse[sample]
console.log(`Direct retainers (${parents.length}):`)
for (const [p, e] of parents) {
  const eType = edgeTypes[edges[e * EF + ETYPE]]
  const eName = eType === "element" || eType === "hidden"
    ? `[${edges[e * EF + ENAME]}]`
    : strings[edges[e * EF + ENAME]] ?? `${edges[e * EF + ENAME]}`
  const pType = nodeTypes[nodes[p * NF + NTYPE]]
  const pName = strings[nodes[p * NF + NNAME]] ?? "(anon)"
  console.log(`  via .${eName}(${eType}) ← ${pType}/${pName} [${nodes[p * NF + NSIZE]}B] @${nodes[p * NF + NID]}`)
}

// Tally retainer types across ALL candidates.
const tally = new Map()
let withMultiple = 0
let withZero = 0
let parentCounts = []
for (const idx of candidates) {
  const parents = inverse[idx]
  parentCounts.push(parents.length)
  if (parents.length === 0) withZero++
  if (parents.length > 1) withMultiple++
  for (const [p, e] of parents) {
    const eType = edgeTypes[edges[e * EF + ETYPE]]
    const pType = nodeTypes[nodes[p * NF + NTYPE]]
    const pName = strings[nodes[p * NF + NNAME]] ?? "(anon)"
    const key = `${pType}/${pName} via (${eType})`
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
}
console.log(`\nRetainer counts: ${withZero} have zero, ${withMultiple} have >1, ${candidates.length - withZero - withMultiple} have exactly 1`)
console.log(`\nRetainer type tally across all ${candidates.length} ${ctor}:`)
const sorted = [...tally.entries()].sort((a, b) => b[1] - a[1])
for (const [k, v] of sorted.slice(0, 20)) console.log(`  ${v.toString().padStart(6)}  ${k}`)

// Show all retainers for a sample with >1 parent, if any
if (withMultiple > 0) {
  for (const idx of candidates) {
    if (inverse[idx].length > 1) {
      console.log(`\nSample with ${inverse[idx].length} retainers (id=${nodes[idx * NF + NID]}):`)
      for (const [p, e] of inverse[idx]) {
        const eType = edgeTypes[edges[e * EF + ETYPE]]
        const eName = eType === "element" || eType === "hidden"
          ? `[${edges[e * EF + ENAME]}]`
          : strings[edges[e * EF + ENAME]] ?? `${edges[e * EF + ENAME]}`
        const pType = nodeTypes[nodes[p * NF + NTYPE]]
        const pName = strings[nodes[p * NF + NNAME]] ?? "(anon)"
        console.log(`  via .${eName}(${eType}) ← ${pType}/${pName} [${nodes[p * NF + NSIZE]}B] @${nodes[p * NF + NID]}`)
      }
      break
    }
  }
}
