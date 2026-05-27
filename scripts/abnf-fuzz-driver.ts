/**
 * ABNF fuzz driver — for each `--target` flag, read lines from stdin and
 * exercise the matching parser. Reports total/accepted/rejected counts,
 * a sample of rejected inputs, and (where applicable) a "silent misparse"
 * count where the parser succeeds but the parsed structure is obviously
 * wrong (e.g. user-info present in input but `parsed.user === undefined`).
 *
 * Usage:
 *   npx tsx scripts/abnf-fuzz-driver.ts --target sip-uri < samples.txt
 *
 * Not a permanent script — kept under scripts/ for the duration of the
 * parser-fuzzing investigation. Drop once findings have been actioned.
 */

import { readFileSync } from "node:fs"
import { parseArgs } from "node:util"

import {
  findUriEmbeddedHeadersStart,
  parseNameAddr,
  parseVia,
  parseContact,
  parseCSeq,
  parseRack,
  parseReplaces,
  parseReferTo,
  parseSipUriString,
  validateStrictSipUri,
  splitTopLevelCommas,
} from "../src/sip/parsers/custom/structured-headers.js"

const { values } = parseArgs({
  options: {
    target: { type: "string", short: "t" },
    samples: { type: "string", short: "n" },
  },
})

const target = values.target
if (target === undefined) {
  console.error("Usage: --target <name> (sip-uri | from | pai | contact | via | cseq | rack | replaces | refer-to | request-line)")
  process.exit(2)
}

const lines = readFileSync(0, "utf8").split(/\r?\n/).filter(Boolean)

interface Stat {
  total: number
  accepted: number
  policyRejected: number  // rejections expected per policy on top of pure ABNF
  buggyRejected: number   // rejections that may indicate a real parser bug
  buggySamples: Array<{ input: string; reason: string }>
  policySamples: Array<{ input: string; reason: string }>
  silentMisparses: number
  silentSamples: Array<{ input: string; parsed: unknown }>
}

const stat: Stat = {
  total: lines.length,
  accepted: 0,
  policyRejected: 0,
  buggyRejected: 0,
  buggySamples: [],
  policySamples: [],
  silentMisparses: 0,
  silentSamples: [],
}

// Reasons that reflect known semantic constraints (RFC limits beyond pure
// ABNF) rather than parser bugs. abnfgen happily generates port=88161 or
// degenerate empty-hostport URIs that the parser correctly rejects.
const POLICY_PATTERNS: RegExp[] = [
  /port out of range/,
  /non-digit in port/,
  /empty hostport/,
  /empty host/,
  /multiple `@`/,
  /multiple `:` in hostport/,
  /hostport starts with `:`/,
  /unclosed IPv6 reference/,
  /empty IPv6 reference/,
]

function isPolicy(reason: string): boolean {
  return POLICY_PATTERNS.some((re) => re.test(reason))
}

function recordReject(input: string, reason: string): void {
  if (isPolicy(reason)) {
    stat.policyRejected++
    if (stat.policySamples.length < 5) stat.policySamples.push({ input, reason })
  } else {
    stat.buggyRejected++
    if (stat.buggySamples.length < 12) stat.buggySamples.push({ input, reason })
  }
}

function recordSilent(input: string, parsed: unknown): void {
  stat.silentMisparses++
  if (stat.silentSamples.length < 12) stat.silentSamples.push({ input, parsed })
}

function fuzzSipUri(line: string): void {
  const reason = validateStrictSipUri(line)
  if (reason !== undefined) { recordReject(line, reason); return }
  stat.accepted++
  if (line.includes("@")) {
    const parsed = parseSipUriString(line)
    if (parsed !== undefined && parsed.user === undefined) {
      recordSilent(line, parsed)
    }
  }
}

function fuzzNameAddr(line: string, headerName: string): void {
  const parsed = parseNameAddr(line)
  if (parsed.uri.length === 0) { recordReject(line, "empty parsed.uri"); return }
  const reason = validateStrictSipUri(parsed.uri)
  if (reason !== undefined) {
    recordReject(line, `Strict ${headerName} URI: ${reason} ("${parsed.uri}")`)
    return
  }
  stat.accepted++
  // Silent-misparse heuristic: if input has `@` inside `<...>` then parsed.uri
  // must contain `@` too (URI extracted intact).
  const lt = line.indexOf("<")
  const gt = line.indexOf(">", lt + 1)
  if (lt !== -1 && gt !== -1) {
    const between = line.slice(lt + 1, gt)
    if (between.includes("@") && !parsed.uri.includes("@")) {
      recordSilent(line, parsed)
    }
  }
}

function fuzzCommaList(line: string, perEntry: (entry: string) => void): void {
  const entries = splitTopLevelCommas(line)
  for (const entry of entries) {
    if (entry.length === 0) continue
    perEntry(entry)
  }
}

function fuzzPaiEntry(entry: string): void {
  // PAI permits sip:/sips:/tel: — the strict URI validator returns undefined
  // for non-sip schemes (pass-through), so a tel: URI is accepted as long as
  // parseNameAddr extracts it.
  const parsed = parseNameAddr(entry)
  if (parsed.uri.length === 0) { recordReject(entry, "empty parsed.uri"); return }
  const reason = validateStrictSipUri(parsed.uri)
  if (reason !== undefined) {
    recordReject(entry, `Strict PAI URI: ${reason} ("${parsed.uri}")`)
    return
  }
  stat.accepted++
}

function fuzzContact(line: string): void {
  if (line.trim() === "*") { stat.accepted++; return }
  const entries = splitTopLevelCommas(line)
  for (const entry of entries) {
    if (entry.length === 0) continue
    const parsed = parseContact(entry)
    if (parsed.uri.length === 0) { recordReject(entry, "empty parsed.uri"); return }
    const reason = validateStrictSipUri(parsed.uri)
    if (reason !== undefined) {
      recordReject(entry, `Strict Contact URI: ${reason} ("${parsed.uri}")`)
      return
    }
  }
  stat.accepted++
}

function fuzzVia(line: string): void {
  // parseVia handles a single via-parm. The header value can be comma-list;
  // splitTopLevelCommas yields each one.
  for (const entry of splitTopLevelCommas(line)) {
    if (entry.length === 0) continue
    const parsed = parseVia(entry)
    if (parsed.transport.length === 0 || parsed.host.length === 0) {
      recordReject(entry, `empty transport/host (transport="${parsed.transport}" host="${parsed.host}")`)
      return
    }
  }
  stat.accepted++
}

function fuzzCSeq(line: string): void {
  const parsed = parseCSeq(line)
  // RFC 3261 grammar lets CSeq be 1*DIGIT, so "00 INVITE" is valid and
  // parses to seq=0. We can't distinguish "parser silently zeroed it" from
  // "input literally was 0..0" via the parsed value alone — trust the
  // parser unless it returns an empty method.
  if (parsed.method.length === 0) { recordReject(line, "empty method"); return }
  stat.accepted++
}

function fuzzRack(line: string): void {
  const parsed = parseRack(line)
  if (parsed === undefined) { recordReject(line, "parseRack returned undefined"); return }
  stat.accepted++
}

function fuzzReplaces(line: string): void {
  const parsed = parseReplaces(line)
  if (parsed === undefined) { recordReject(line, "parseReplaces returned undefined"); return }
  stat.accepted++
}

function fuzzReferTo(line: string): void {
  const parsed = parseReferTo(line)
  if (parsed === undefined) { recordReject(line, "parseReferTo returned undefined"); return }
  // Strict URI on the head (strip `?embedded-headers` per RFC 3261 §19.1.1).
  // Use the post-hostport `?` locator so a userinfo `?` doesn't truncate us.
  const uri = parsed.uri
  const qIdx = findUriEmbeddedHeadersStart(uri)
  const uriHead = qIdx === -1 ? uri : uri.slice(0, qIdx)
  const reason = validateStrictSipUri(uriHead)
  if (reason !== undefined) {
    recordReject(line, `Strict Refer-To URI: ${reason} ("${uriHead}")`)
    return
  }
  stat.accepted++
}

function fuzzRequestLine(line: string): void {
  // Request-Line: "METHOD SP REQUEST-URI SP SIP-Version". RFC 3261 §7.2
  // declares SIP-Version case-insensitive, so accept any casing of "SIP/2.0".
  const m = /^([A-Z!%*_+`'~A-Za-z0-9.-]+) (\S+) [sS][iI][pP]\/2\.0$/.exec(line)
  if (m === null) { recordReject(line, "request-line shape regex failed"); return }
  const reqUri = m[2]!
  const reason = validateStrictSipUri(reqUri)
  if (reason !== undefined) {
    recordReject(line, `Strict Request-URI: ${reason} ("${reqUri}")`)
    return
  }
  // Silent misparse on lenient parser too.
  const parsed = parseSipUriString(reqUri)
  if (parsed !== undefined && reqUri.includes("@") && parsed.user === undefined) {
    recordSilent(line, parsed)
  }
  stat.accepted++
}

const dispatch: Record<string, (s: string) => void> = {
  "sip-uri": fuzzSipUri,
  "from": (s) => fuzzNameAddr(s, "From"),
  "to": (s) => fuzzNameAddr(s, "To"),
  "pai": (s) => fuzzCommaList(s, fuzzPaiEntry),
  "contact": fuzzContact,
  "via": fuzzVia,
  "cseq": fuzzCSeq,
  "rack": fuzzRack,
  "replaces": fuzzReplaces,
  "refer-to": fuzzReferTo,
  "request-line": fuzzRequestLine,
}

const fn = dispatch[target]
if (fn === undefined) {
  console.error(`Unknown target: ${target}`)
  process.exit(2)
}

for (const line of lines) {
  try {
    fn(line)
  } catch (err) {
    recordReject(line, `THREW: ${(err as Error).message}`)
  }
}

const pct = (n: number) => stat.total === 0 ? "0.0000" : (n / stat.total).toFixed(4)
const out = {
  target,
  total: stat.total,
  accepted: stat.accepted,
  policyRejected: stat.policyRejected,
  policyRate: pct(stat.policyRejected),
  buggyRejected: stat.buggyRejected,
  buggyRate: pct(stat.buggyRejected),
  silentMisparses: stat.silentMisparses,
  silentMisparseRate: pct(stat.silentMisparses),
  buggySamples: stat.buggySamples,
  policySamples: stat.policySamples,
  silentSamples: stat.silentSamples,
}
console.log(JSON.stringify(out, null, 2))
