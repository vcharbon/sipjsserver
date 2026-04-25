/**
 * Recording codec — YAML serializer / parser scoped to the CallRecording
 * schema only. Intentionally NOT a general-purpose YAML library.
 *
 * Hand-editable shape:
 *
 *   scenario: basic-call
 *   serviceCase: basic-call          # or: ~ for null
 *   callId: 12345abcd@host
 *   startMs: 0
 *   entries:
 *     - kind: message
 *       direction: sent
 *       from: alice
 *       to: DUT
 *       label: alice.invite          # optional
 *       sentMs: 0
 *       receivedMs: 15
 *       raw: |
 *         INVITE sip:+1234@127.0.0.1:15060 SIP/2.0
 *         Via: ...
 *         <CRLF>
 *         <body bytes>
 *     - kind: timeout
 *       agent: alice
 *       waitingFor: 180 Ringing
 *       atMs: 5000
 *       label: alice.expectRinging   # optional
 *     - kind: marker
 *       atMs: 1000
 *       label: phaseTwo
 *       note: caller-hangup
 *
 * Round-trip property: `parse(serialize(rec))` deep-equals rec.
 */

import type {
  CallRecording,
  RecordedMarker,
  RecordedMessage,
  RecordedTimeout,
  RecordingEntry,
} from "./recording.js"

// ---------------------------------------------------------------------------
// Serialize
// ---------------------------------------------------------------------------

const INDENT = "  "

function encodeScalar(v: string): string {
  // Quote when ambiguous: empty, contains special chars, or looks like a
  // number/bool/null literal. Otherwise emit bare. Always-safe quoting fallback.
  if (v === "") return '""'
  if (/^[A-Za-z_][\w.\-:/@+]*$/.test(v) && !["true", "false", "null", "~"].includes(v)) {
    return v
  }
  // Double-quoted with backslash escapes.
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`
}

function encodeBlockScalar(raw: string, indent: string): string {
  // RFC: `|` keeps newlines, `|-` strips trailing. We always use `|` and
  // suppress the magic indent indicator by indenting body by `indent + INDENT`.
  // To round-trip, we end with no trailing newline trimming: caller's `raw`
  // is preserved exactly. We use `|+` to keep all trailing newlines.
  const lines = raw.split("\n")
  const body = lines.map((l) => `${indent}${INDENT}${l}`).join("\n")
  return `|+\n${body}`
}

function emitEntry(e: RecordingEntry, baseIndent: string): string[] {
  const itemIndent = baseIndent
  const fieldIndent = `${baseIndent}  ` // for fields under "- "
  const lines: string[] = []
  if (e.kind === "message") {
    lines.push(`${itemIndent}- kind: message`)
    lines.push(`${fieldIndent}direction: ${e.direction}`)
    lines.push(`${fieldIndent}from: ${encodeScalar(e.from)}`)
    lines.push(`${fieldIndent}to: ${encodeScalar(e.to)}`)
    if (e.label !== undefined) {
      lines.push(`${fieldIndent}label: ${encodeScalar(e.label)}`)
    }
    if (e.unexpected) {
      lines.push(`${fieldIndent}unexpected: true`)
    }
    lines.push(`${fieldIndent}sentMs: ${e.sentMs}`)
    lines.push(`${fieldIndent}receivedMs: ${e.receivedMs}`)
    lines.push(`${fieldIndent}raw: ${encodeBlockScalar(e.raw, fieldIndent)}`)
  } else if (e.kind === "timeout") {
    lines.push(`${itemIndent}- kind: timeout`)
    lines.push(`${fieldIndent}agent: ${encodeScalar(e.agent)}`)
    lines.push(`${fieldIndent}waitingFor: ${encodeScalar(e.waitingFor)}`)
    lines.push(`${fieldIndent}atMs: ${e.atMs}`)
    if (e.label !== undefined) {
      lines.push(`${fieldIndent}label: ${encodeScalar(e.label)}`)
    }
  } else {
    lines.push(`${itemIndent}- kind: marker`)
    lines.push(`${fieldIndent}atMs: ${e.atMs}`)
    lines.push(`${fieldIndent}label: ${encodeScalar(e.label)}`)
    if (e.note !== undefined) {
      lines.push(`${fieldIndent}note: ${encodeScalar(e.note)}`)
    }
  }
  return lines
}

export function serializeRecording(rec: CallRecording): string {
  const lines: string[] = []
  lines.push(`scenario: ${encodeScalar(rec.scenarioId)}`)
  lines.push(`serviceCase: ${rec.serviceCaseId === null ? "~" : encodeScalar(rec.serviceCaseId)}`)
  lines.push(`callId: ${encodeScalar(rec.callId)}`)
  lines.push(`startMs: ${rec.startMs}`)
  if (rec.entries.length === 0) {
    lines.push("entries: []")
  } else {
    lines.push("entries:")
    for (const entry of rec.entries) {
      lines.push(...emitEntry(entry, ""))
    }
  }
  // No trailing "\n" appended: each block scalar's last body line already
  // carries the trailing-newline marker for raws that end with "\n" —
  // adding one here would make the parser see an extra empty body line
  // at EOF, breaking CRLF round-trip of the final `raw:` field.
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

interface ParseCursor {
  readonly lines: string[]
  pos: number
}

function indentOf(line: string): number {
  let i = 0
  while (i < line.length && line[i] === " ") i++
  return i
}

function isBlank(line: string): boolean {
  return line.trim().length === 0
}

function decodeScalar(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === "~" || trimmed === "null") return ""
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const body = trimmed.slice(1, -1)
    return body
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
  }
  return trimmed
}

function parseInline(value: string): { kind: "scalar"; v: string } | { kind: "null" } {
  const t = value.trim()
  if (t === "~" || t === "null") return { kind: "null" }
  return { kind: "scalar", v: decodeScalar(value) }
}

/**
 * Parse a `|+` block scalar. Caller has consumed the line containing the
 * `key: |+` marker; cursor sits on the first body line. Body terminates
 * when we encounter a line whose indent is < `bodyIndent` and is not blank.
 * We return the joined body with original line breaks; trailing newline
 * stripped (the encoder's `|+` keeps all but our list of lines was split
 * on `\n`, so we rejoin with `\n` and the encoder's last appended `\n`
 * becomes the trailing one we strip).
 */
/**
 * Parse a `|+` block scalar. `|+` preserves every trailing newline, so
 * we do NOT strip trailing empty lines — the split-and-rejoin idiom
 * lets each file line correspond to one element in the `body` array.
 *
 * A line below `bodyIndent` with actual (non-whitespace) content ends
 * the block. Whitespace-only lines are always part of the body; they
 * frequently carry the trailing `\r` of a CRLF separator between SIP
 * headers and body, which must round-trip exactly.
 */
function parseBlockScalar(c: ParseCursor, bodyIndent: number): string {
  const body: string[] = []
  while (c.pos < c.lines.length) {
    const line = c.lines[c.pos]!
    if (line.length === 0) {
      body.push("")
      c.pos++
      continue
    }
    const hasContent = line.trim().length > 0
    if (hasContent && indentOf(line) < bodyIndent) break
    if (line.length < bodyIndent) {
      // Whitespace-only line shorter than bodyIndent → preserve whatever
      // trails the indent (usually "" or "\r").
      body.push(line.slice(bodyIndent))
    } else {
      body.push(line.slice(bodyIndent))
    }
    c.pos++
  }
  return body.join("\n")
}

interface FieldSplit {
  key: string
  rest: string
}

function splitField(line: string): FieldSplit | null {
  // Find the first `:` followed by space-or-EOL outside quotes.
  let inQuote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') inQuote = !inQuote
    if (!inQuote && ch === ":" && (i + 1 === line.length || line[i + 1] === " ")) {
      return {
        key: line.slice(0, i).trim(),
        rest: line.slice(i + 1),
      }
    }
  }
  return null
}

interface RawEntry {
  fields: Map<string, string | { block: string }>
}

function parseEntries(c: ParseCursor, baseIndent: number): RecordingEntry[] {
  const entries: RecordingEntry[] = []
  while (c.pos < c.lines.length) {
    const line = c.lines[c.pos]!
    if (isBlank(line)) {
      c.pos++
      continue
    }
    const ind = indentOf(line)
    if (ind < baseIndent) break
    const trimmed = line.slice(ind)
    if (!trimmed.startsWith("- ")) break
    // Item starts.
    const raw: RawEntry = { fields: new Map() }
    // First inline field (e.g., "- kind: message").
    const firstField = trimmed.slice(2)
    const split = splitField(firstField)
    if (!split) {
      throw new Error(`Recording codec: malformed list item at line ${c.pos + 1}: "${line}"`)
    }
    raw.fields.set(split.key, split.rest.trim())
    c.pos++
    // Subsequent fields at indent = baseIndent + 2.
    const fieldIndent = baseIndent + 2
    while (c.pos < c.lines.length) {
      const fl = c.lines[c.pos]!
      if (isBlank(fl)) {
        c.pos++
        continue
      }
      const flInd = indentOf(fl)
      if (flInd < fieldIndent) break
      // If we hit another list item at same indent, stop.
      if (flInd === baseIndent && fl.slice(flInd).startsWith("- ")) break
      const flBody = fl.slice(flInd)
      const fsplit = splitField(flBody)
      if (!fsplit) {
        throw new Error(`Recording codec: malformed field at line ${c.pos + 1}: "${fl}"`)
      }
      const valuePart = fsplit.rest.trim()
      if (valuePart === "|+" || valuePart === "|") {
        c.pos++
        const block = parseBlockScalar(c, fieldIndent + 2)
        raw.fields.set(fsplit.key, { block })
      } else {
        raw.fields.set(fsplit.key, fsplit.rest)
        c.pos++
      }
    }
    entries.push(materializeEntry(raw))
  }
  return entries
}

function getStr(raw: RawEntry, key: string): string | undefined {
  const v = raw.fields.get(key)
  if (v === undefined) return undefined
  return typeof v === "string" ? decodeScalar(v) : v.block
}

function getNum(raw: RawEntry, key: string): number | undefined {
  const v = raw.fields.get(key)
  if (v === undefined) return undefined
  const s = typeof v === "string" ? v.trim() : v.block
  const n = Number(s)
  if (!Number.isFinite(n)) {
    throw new Error(`Recording codec: expected number for "${key}", got "${s}"`)
  }
  return n
}

function materializeEntry(raw: RawEntry): RecordingEntry {
  const kind = getStr(raw, "kind")
  if (kind === "message") {
    const direction = getStr(raw, "direction")
    if (direction !== "sent" && direction !== "received") {
      throw new Error(`Recording codec: invalid direction "${direction}"`)
    }
    const from = getStr(raw, "from") ?? ""
    const to = getStr(raw, "to") ?? ""
    const label = getStr(raw, "label")
    const sentMs = getNum(raw, "sentMs") ?? 0
    const receivedMs = getNum(raw, "receivedMs") ?? 0
    const rawWire = getStr(raw, "raw") ?? ""
    const unexRaw = getStr(raw, "unexpected")
    const unexpected = unexRaw === "true"
    const base: RecordedMessage = { kind: "message", direction, from, to, sentMs, receivedMs, raw: rawWire }
    const withLabel = label !== undefined ? { ...base, label } : base
    const msg: RecordedMessage = unexpected ? { ...withLabel, unexpected: true } : withLabel
    return msg
  }
  if (kind === "timeout") {
    const agent = getStr(raw, "agent") ?? ""
    const waitingFor = getStr(raw, "waitingFor") ?? ""
    const atMs = getNum(raw, "atMs") ?? 0
    const label = getStr(raw, "label")
    const t: RecordedTimeout = label !== undefined
      ? { kind: "timeout", agent, waitingFor, atMs, label }
      : { kind: "timeout", agent, waitingFor, atMs }
    return t
  }
  if (kind === "marker") {
    const atMs = getNum(raw, "atMs") ?? 0
    const label = getStr(raw, "label") ?? ""
    const note = getStr(raw, "note")
    const m: RecordedMarker = note !== undefined
      ? { kind: "marker", atMs, label, note }
      : { kind: "marker", atMs, label }
    return m
  }
  throw new Error(`Recording codec: unknown entry kind "${kind}"`)
}

export function parseRecording(text: string): CallRecording {
  const lines = text.split("\n")
  // Drop trailing blank-line emitted by serializer's `\n` terminator.
  const c: ParseCursor = { lines, pos: 0 }

  let scenarioId = ""
  let serviceCaseId: string | null = null
  let callId = ""
  let startMs = 0
  let entries: RecordingEntry[] = []
  let foundEntries = false

  while (c.pos < lines.length) {
    const line = lines[c.pos]!
    if (isBlank(line)) {
      c.pos++
      continue
    }
    const ind = indentOf(line)
    if (ind > 0) break // top-level keys only at indent 0
    const split = splitField(line.slice(ind))
    if (!split) {
      throw new Error(`Recording codec: top-level malformed line ${c.pos + 1}: "${line}"`)
    }
    if (split.key === "entries") {
      const v = split.rest.trim()
      c.pos++
      if (v === "[]") {
        entries = []
      } else if (v === "") {
        entries = parseEntries(c, 0)
      } else {
        throw new Error(`Recording codec: unexpected entries inline value "${v}"`)
      }
      foundEntries = true
      continue
    }
    const inline = parseInline(split.rest)
    c.pos++
    switch (split.key) {
      case "scenario":
        scenarioId = inline.kind === "scalar" ? inline.v : ""
        break
      case "serviceCase":
        serviceCaseId = inline.kind === "scalar" ? inline.v : null
        break
      case "callId":
        callId = inline.kind === "scalar" ? inline.v : ""
        break
      case "startMs":
        startMs = Number(inline.kind === "scalar" ? inline.v : "0")
        break
      default:
        throw new Error(`Recording codec: unknown top-level key "${split.key}"`)
    }
  }

  if (!foundEntries) {
    throw new Error(`Recording codec: missing required "entries" key`)
  }

  return { scenarioId, serviceCaseId, callId, startMs, entries }
}
