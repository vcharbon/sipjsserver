#!/usr/bin/env node
// Dump outgoing edges + retainers of a single node by id.
// Usage: node inspect-node.mjs <snapshot> <id>

import { readFileSync } from "node:fs"
const [, , path, idArg] = process.argv
const targetId = Number(idArg)

const snap = JSON.parse(readFileSync(path, "utf8"))
const meta = snap.snapshot.meta
const NF = meta.node_fields.length, EF = meta.edge_fields.length
const NTYPE = meta.node_fields.indexOf("type")
const NNAME = meta.node_fields.indexOf("name")
const NID = meta.node_fields.indexOf("id")
const NSIZE = meta.node_fields.indexOf("self_size")
const NEDGES = meta.node_fields.indexOf("edge_count")
const ETYPE = meta.edge_fields.indexOf("type")
const ENAME = meta.edge_fields.indexOf("name_or_index")
const ETO = meta.edge_fields.indexOf("to_node")
const nodes = snap.nodes, edges = snap.edges, strings = snap.strings
const nodeTypes = meta.node_types[0]
const edgeTypes = meta.edge_types[0]
const nodeCount = snap.snapshot.node_count

const offsets = new Int32Array(nodeCount + 1)
let c = 0
for (let i = 0; i < nodeCount; i++) { offsets[i] = c; c += nodes[i * NF + NEDGES] }
offsets[nodeCount] = c

let idx = -1
for (let i = 0; i < nodeCount; i++) {
  if (nodes[i * NF + NID] === targetId) { idx = i; break }
}
if (idx === -1) { console.error(`id ${targetId} not found`); process.exit(1) }

const lbl = (i) => {
  const t = nodeTypes[nodes[i * NF + NTYPE]]
  const n = strings[nodes[i * NF + NNAME]] ?? "(anon)"
  const s = nodes[i * NF + NSIZE]
  const id = nodes[i * NF + NID]
  return `${t}/${n}@${id}[${s}B]`
}
const elabel = (e) => {
  const t = edgeTypes[edges[e * EF + ETYPE]]
  const v = edges[e * EF + ENAME]
  const name = (t === "element" || t === "hidden") ? `[${v}]` : strings[v] ?? `${v}`
  return `.${name}(${t})`
}

console.log(`Inspecting: ${lbl(idx)}`)
console.log()
console.log("Outgoing edges:")
for (let e = offsets[idx]; e < offsets[idx + 1]; e++) {
  const tgtIdx = edges[e * EF + ETO] / NF
  console.log(`  ${elabel(e)} → ${lbl(tgtIdx)}`)
}
