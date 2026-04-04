/**
 * SIP Parser Benchmark — standalone script.
 *
 * Measures parse throughput and memory for each parser implementation.
 * Run with: node --expose-gc --import tsx bench/sip-parser-bench.ts
 * Or:       npx tsx bench/sip-parser-bench.ts  (without GC metrics)
 */

import { jssipParser } from "../src/sip/parsers/jssip-adapter.js"
import { sipParserNpm } from "../src/sip/parsers/sip-parser-adapter.js"
import { customParser } from "../src/sip/parsers/custom/index.js"
import type { SipParserImpl } from "../src/sip/parsers/interface.js"
import { generateInvites, generateOKs, generateBYEs } from "./corpus.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ITERATIONS = 1_000_000
const WARMUP = 10_000
const CORPUS_SIZE = 1000

// ---------------------------------------------------------------------------
// Benchmark runner
// ---------------------------------------------------------------------------

interface BenchResult {
  parser: string
  msgType: string
  iterations: number
  totalMs: number
  avgUs: number
  msgsPerSec: number
  heapDeltaKb: number
  avgMsgBytes: number
}

function tryGC(): void {
  if (typeof globalThis.gc === "function") {
    globalThis.gc()
  }
}

function benchmarkParser(
  impl: SipParserImpl,
  corpus: Buffer[],
  msgType: string,
  iterations: number
): BenchResult {
  const avgMsgBytes = Math.round(
    corpus.reduce((sum, b) => sum + b.length, 0) / corpus.length
  )

  // Warm-up
  for (let i = 0; i < WARMUP; i++) {
    impl.parse(corpus[i % corpus.length]!)
  }

  tryGC()

  const startHeap = process.memoryUsage().heapUsed
  const startTime = process.hrtime.bigint()

  for (let i = 0; i < iterations; i++) {
    impl.parse(corpus[i % corpus.length]!)
  }

  const elapsed = process.hrtime.bigint() - startTime
  const endHeap = process.memoryUsage().heapUsed

  const totalMs = Number(elapsed) / 1e6
  const avgUs = Number(elapsed) / iterations / 1e3
  const msgsPerSec = Math.round(iterations / (Number(elapsed) / 1e9))
  const heapDeltaKb = Math.round((endHeap - startHeap) / 1024)

  return { parser: impl.name, msgType, iterations, totalMs, avgUs, msgsPerSec, heapDeltaKb, avgMsgBytes }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function formatTable(results: BenchResult[]): string {
  const header = "| Parser     | Msg Type | Avg Bytes | Avg (μs) | Msgs/sec   | Heap Δ (KB) |"
  const sep    = "|------------|----------|-----------|----------|------------|-------------|"
  const rows = results.map((r) =>
    `| ${r.parser.padEnd(10)} | ${r.msgType.padEnd(8)} | ${String(r.avgMsgBytes).padStart(9)} | ${r.avgUs.toFixed(1).padStart(8)} | ${r.msgsPerSec.toLocaleString().padStart(10)} | ${String(r.heapDeltaKb).padStart(11)} |`
  )
  return [header, sep, ...rows].join("\n")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.log(`SIP Parser Benchmark`)
console.log(`  Iterations: ${ITERATIONS.toLocaleString()} per parser per message type`)
console.log(`  Corpus: ${CORPUS_SIZE} unique messages per type`)
console.log(`  GC available: ${typeof globalThis.gc === "function" ? "yes" : "no (run with --expose-gc for heap metrics)"}`)
console.log()

const parsers: SipParserImpl[] = [jssipParser, sipParserNpm, customParser]
const corpora: Array<{ name: string; buffers: Buffer[] }> = [
  { name: "INVITE", buffers: generateInvites(CORPUS_SIZE) },
  { name: "200 OK", buffers: generateOKs(CORPUS_SIZE) },
  { name: "BYE", buffers: generateBYEs(CORPUS_SIZE) },
]

const results: BenchResult[] = []

for (const { name, buffers } of corpora) {
  for (const impl of parsers) {
    process.stdout.write(`  Benchmarking ${impl.name} × ${name}...`)
    const result = benchmarkParser(impl, buffers, name, ITERATIONS)
    results.push(result)
    console.log(` ${result.avgUs.toFixed(1)} μs/msg (${result.msgsPerSec.toLocaleString()} msgs/sec)`)
  }
}

console.log()
console.log(formatTable(results))

// Summary: speedup ratios
console.log()
console.log("## Speedup vs JsSIP (INVITE)")
const jssipInvite = results.find((r) => r.parser === "jssip" && r.msgType === "INVITE")
if (jssipInvite) {
  for (const r of results.filter((r) => r.msgType === "INVITE" && r.parser !== "jssip")) {
    const speedup = jssipInvite.avgUs / r.avgUs
    console.log(`  ${r.parser}: ${speedup.toFixed(2)}x ${speedup > 1 ? "faster" : "slower"}`)
  }
}
