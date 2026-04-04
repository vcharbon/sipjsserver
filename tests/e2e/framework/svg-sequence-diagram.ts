/**
 * SVG sequence diagram renderer for SIP message traces.
 *
 * Generates a raw SVG string from TraceEntry[] and participant list.
 * Supports per-arrow Call-ID text coloring, pass/fail/unexpected styling,
 * click targets for message inspection, and timing annotations.
 */

import type { SipMessage } from "../../../src/sip/types.js"
import type { TraceEntry } from "./types.js"

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const PARTICIPANT_SPACING = 250
const ROW_HEIGHT = 55
const HEADER_HEIGHT = 60
const PARTICIPANT_BOX_WIDTH = 120
const PARTICIPANT_BOX_HEIGHT = 35
const MARGIN_LEFT = 40
const MARGIN_TOP = 20
const PAUSE_GAP = 30
const FONT_SIZE = 12
const LABEL_FONT_SIZE = 11
const ARROWHEAD_SIZE = 8

// ---------------------------------------------------------------------------
// Call-ID color palette
// ---------------------------------------------------------------------------

const CALL_ID_COLORS = [
  "#2563eb", // blue
  "#dc2626", // red
  "#059669", // emerald
  "#7c3aed", // violet
  "#d97706", // amber
  "#0891b2", // cyan
  "#be185d", // pink
  "#4f46e5", // indigo
]

function getCallIdColor(callId: string, colorMap: Map<string, string>): string {
  let color = colorMap.get(callId)
  if (!color) {
    color = CALL_ID_COLORS[colorMap.size % CALL_ID_COLORS.length]!
    colorMap.set(callId, color)
  }
  return color
}

// ---------------------------------------------------------------------------
// Message description helpers
// ---------------------------------------------------------------------------

function getCallId(msg: SipMessage): string {
  return msg.headers.find((h) => h.name.toLowerCase() === "call-id")?.value ?? "unknown"
}

function getFromTag(msg: SipMessage): string {
  const from = msg.headers.find((h) => h.name.toLowerCase() === "from")?.value ?? ""
  const match = /;tag=([^\s;,>]+)/i.exec(from)
  return match?.[1] ?? ""
}

function getToTag(msg: SipMessage): string {
  const to = msg.headers.find((h) => h.name.toLowerCase() === "to")?.value ?? ""
  const match = /;tag=([^\s;,>]+)/i.exec(to)
  return match?.[1] ?? ""
}

function getCSeqMethod(msg: SipMessage): string {
  const cseq = msg.headers.find((h) => h.name.toLowerCase() === "cseq")?.value ?? ""
  return cseq.split(/\s+/)[1] ?? ""
}

function hasSdp(msg: SipMessage): boolean {
  if (msg.body.length === 0) return false
  const ct = msg.headers.find((h) => h.name.toLowerCase() === "content-type")?.value ?? ""
  return ct.includes("application/sdp") || new TextDecoder().decode(msg.body.slice(0, 4)) === "v=0\r"
}

function isInitialInvite(msg: SipMessage): boolean {
  if (msg.type !== "request" || msg.method !== "INVITE") return false
  const toTag = getToTag(msg)
  return !toTag
}

function getArrowLabel(msg: SipMessage): string {
  const sdpTag = hasSdp(msg) ? " [SDP]" : ""
  if (msg.type === "request") {
    if (isInitialInvite(msg)) {
      return `${msg.method} ${msg.uri}${sdpTag}`
    }
    return `${msg.method}${sdpTag}`
  }
  const method = getCSeqMethod(msg)
  const methodTag = method ? ` (${method})` : ""
  return `${msg.status} ${msg.reason}${methodTag}${sdpTag}`
}

function getTagLabel(msg: SipMessage): string {
  const fromTag = getFromTag(msg)
  const toTag = getToTag(msg)
  const parts: string[] = []
  if (fromTag) parts.push(`F:${fromTag.slice(0, 8)}`)
  if (toTag) parts.push(`T:${toTag.slice(0, 8)}`)
  return parts.join(" ")
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

/** Serialize a SipMessage to a human-readable string for the detail panel. */
export function serializeMessage(msg: SipMessage): string {
  const lines: string[] = []
  if (msg.type === "request") {
    lines.push(`${msg.method} ${msg.uri} ${msg.version}`)
  } else {
    lines.push(`${msg.version} ${msg.status} ${msg.reason}`)
  }
  for (const h of msg.headers) {
    lines.push(`${h.name}: ${h.value}`)
  }
  lines.push("")
  if (msg.body.length > 0) {
    lines.push(new TextDecoder().decode(msg.body))
  }
  return lines.join("\r\n")
}

// ---------------------------------------------------------------------------
// SVG renderer
// ---------------------------------------------------------------------------

export function renderSequenceDiagram(
  trace: readonly TraceEntry[],
  participants: readonly string[]
): string {
  if (participants.length === 0 || trace.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
      <text x="200" y="50" text-anchor="middle" font-family="monospace" font-size="14" fill="#666">No messages to display</text>
    </svg>`
  }

  const callIdColorMap = new Map<string, string>()
  const participantX = new Map<string, number>()

  // Compute participant X positions
  for (let i = 0; i < participants.length; i++) {
    participantX.set(participants[i]!, MARGIN_LEFT + i * PARTICIPANT_SPACING + PARTICIPANT_BOX_WIDTH / 2)
  }

  // Compute SVG dimensions
  const totalWidth = MARGIN_LEFT * 2 + (participants.length - 1) * PARTICIPANT_SPACING + PARTICIPANT_BOX_WIDTH
  let currentY = MARGIN_TOP + HEADER_HEIGHT
  const rowYs: number[] = []

  // Pre-compute row Y positions (account for pause gaps if we add them later)
  for (let i = 0; i < trace.length; i++) {
    rowYs.push(currentY)
    currentY += ROW_HEIGHT
  }

  const totalHeight = currentY + 40 // bottom margin

  const svgParts: string[] = []

  // --- SVG header ---
  svgParts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" class="sip-diagram">`)

  // --- Defs: arrowhead markers ---
  svgParts.push(`<defs>
    <marker id="arrowhead-pass" markerWidth="${ARROWHEAD_SIZE}" markerHeight="${ARROWHEAD_SIZE}" refX="${ARROWHEAD_SIZE}" refY="${ARROWHEAD_SIZE / 2}" orient="auto">
      <polygon points="0 0, ${ARROWHEAD_SIZE} ${ARROWHEAD_SIZE / 2}, 0 ${ARROWHEAD_SIZE}" fill="#374151"/>
    </marker>
    <marker id="arrowhead-fail" markerWidth="${ARROWHEAD_SIZE}" markerHeight="${ARROWHEAD_SIZE}" refX="${ARROWHEAD_SIZE}" refY="${ARROWHEAD_SIZE / 2}" orient="auto">
      <polygon points="0 0, ${ARROWHEAD_SIZE} ${ARROWHEAD_SIZE / 2}, 0 ${ARROWHEAD_SIZE}" fill="#dc2626"/>
    </marker>
    <marker id="arrowhead-unexpected" markerWidth="${ARROWHEAD_SIZE}" markerHeight="${ARROWHEAD_SIZE}" refX="${ARROWHEAD_SIZE}" refY="${ARROWHEAD_SIZE / 2}" orient="auto">
      <polygon points="0 0, ${ARROWHEAD_SIZE} ${ARROWHEAD_SIZE / 2}, 0 ${ARROWHEAD_SIZE}" fill="#d97706"/>
    </marker>
  </defs>`)

  // --- Background ---
  svgParts.push(`<rect width="${totalWidth}" height="${totalHeight}" fill="#ffffff"/>`)

  // --- Participant boxes ---
  for (const [name, x] of participantX) {
    const boxX = x - PARTICIPANT_BOX_WIDTH / 2
    const boxY = MARGIN_TOP
    svgParts.push(`<rect x="${boxX}" y="${boxY}" width="${PARTICIPANT_BOX_WIDTH}" height="${PARTICIPANT_BOX_HEIGHT}" rx="4" fill="#f3f4f6" stroke="#6b7280" stroke-width="1.5"/>`)
    svgParts.push(`<text x="${x}" y="${boxY + PARTICIPANT_BOX_HEIGHT / 2 + 5}" text-anchor="middle" font-family="monospace" font-size="${FONT_SIZE}" font-weight="bold" fill="#111827">${escapeXml(name)}</text>`)
  }

  // --- Lifelines ---
  for (const [, x] of participantX) {
    svgParts.push(`<line x1="${x}" y1="${MARGIN_TOP + PARTICIPANT_BOX_HEIGHT}" x2="${x}" y2="${totalHeight - 20}" stroke="#d1d5db" stroke-width="1" stroke-dasharray="4,4"/>`)
  }

  // --- Arrows ---
  for (let i = 0; i < trace.length; i++) {
    const entry = trace[i]!
    const y = rowYs[i]!
    const fromX = participantX.get(entry.from)
    const toX = participantX.get(entry.to)

    if (fromX === undefined || toX === undefined) continue

    const callId = getCallId(entry.message)
    const color = getCallIdColor(callId, callIdColorMap)
    const label = getArrowLabel(entry.message)
    const tagLabel = getTagLabel(entry.message)

    // Arrow line styling
    const isLeftToRight = fromX < toX
    const lineColor = entry.status === "fail" ? "#dc2626"
      : entry.status === "unexpected" ? "#d97706"
      : "#374151"
    const dashArray = entry.status === "pass" ? "" : `stroke-dasharray="6,4"`
    const markerEnd = entry.status === "fail" ? "url(#arrowhead-fail)"
      : entry.status === "unexpected" ? "url(#arrowhead-unexpected)"
      : "url(#arrowhead-pass)"

    // Clickable group
    svgParts.push(`<g class="trace-arrow" data-step-index="${entry.stepIndex}" style="cursor:pointer">`)

    // Arrow line
    const arrowFromX = isLeftToRight ? fromX + 5 : fromX - 5
    const arrowToX = isLeftToRight ? toX - 5 : toX + 5
    svgParts.push(`<line x1="${arrowFromX}" y1="${y}" x2="${arrowToX}" y2="${y}" stroke="${lineColor}" stroke-width="1.5" marker-end="${markerEnd}" ${dashArray}/>`)

    // Label (method/status + URI) — colored by Call-ID
    const midX = (fromX + toX) / 2
    const labelY = y - 14
    svgParts.push(`<text x="${midX}" y="${labelY}" text-anchor="middle" font-family="monospace" font-size="${LABEL_FONT_SIZE}" fill="${color}">${escapeXml(label)}</text>`)

    // Tag label (From-tag / To-tag) — smaller, below the main label
    if (tagLabel) {
      svgParts.push(`<text x="${midX}" y="${y - 3}" text-anchor="middle" font-family="monospace" font-size="${LABEL_FONT_SIZE - 2}" fill="#9ca3af">${escapeXml(tagLabel)}</text>`)
    }

    // Timing annotation for expect steps
    if (entry.direction === "receive" && entry.durationMs !== undefined) {
      const timingX = isLeftToRight ? toX + 8 : toX - 8
      const anchor = isLeftToRight ? "start" : "end"
      svgParts.push(`<text x="${timingX}" y="${y + 4}" text-anchor="${anchor}" font-family="monospace" font-size="${LABEL_FONT_SIZE - 2}" fill="#6b7280">${entry.durationMs}ms</text>`)
    }

    // Unexpected badge
    if (entry.status === "unexpected") {
      const badgeX = isLeftToRight ? toX + 8 : toX - 70
      svgParts.push(`<text x="${badgeX}" y="${y + 4}" text-anchor="start" font-family="monospace" font-size="${LABEL_FONT_SIZE - 1}" font-weight="bold" fill="#d97706">UNEXPECTED</text>`)
    }

    // Invisible wide click target
    svgParts.push(`<rect x="${Math.min(fromX, toX)}" y="${y - 20}" width="${Math.abs(toX - fromX)}" height="30" fill="transparent"/>`)

    svgParts.push(`</g>`)
  }

  svgParts.push(`</svg>`)

  return svgParts.join("\n")
}
