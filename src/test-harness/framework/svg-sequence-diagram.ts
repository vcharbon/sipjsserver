/**
 * SVG sequence diagram renderer for SIP message traces.
 *
 * Generates a raw SVG string from TraceEntry[] and participant list.
 * Supports per-arrow Call-ID text coloring, pass/fail/unexpected styling,
 * click targets for message inspection, and timing annotations.
 */

import type { SipMessage } from "../../sip/types.js"
import type { NetworkTag, Participant, TraceEntry } from "./types.js"

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

/**
 * Format a virtual-clock offset (in ms, relative to the first trace
 * entry) as `T+SEC.mmms` — e.g. `T+0.015s`, `T+1.230s`, `T+1m02.345s`.
 * Matches the text-report format so the two views agree on time.
 */
function formatRelativeTimestamp(ms: number): string {
  if (ms < 0) ms = 0
  const totalSec = Math.floor(ms / 1000)
  const millis = ms % 1000
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  const body = min > 0
    ? `${min}m${sec.toString().padStart(2, "0")}.${millis.toString().padStart(3, "0")}s`
    : `${sec}.${millis.toString().padStart(3, "0")}s`
  return `T+${body}`
}

// ---------------------------------------------------------------------------
// Message description helpers
// ---------------------------------------------------------------------------

function getCallId(msg: SipMessage): string {
  return msg.parsed.callId
}

function getFromTag(msg: SipMessage): string {
  return msg.parsed.from.tag ?? ""
}

function getToTag(msg: SipMessage): string {
  return msg.parsed.to.tag ?? ""
}

function getCSeqMethod(msg: SipMessage): string {
  return msg.parsed.cseq.method
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

/**
 * `true` when the message is an out-of-dialog request that is NOT a
 * dialog-creating INVITE — i.e. a request without a To-tag whose method
 * is anything other than INVITE. Catches OPTIONS keepalive, out-of-dialog
 * NOTIFY/INFO, and similar "non-call-establishing" traffic. Used to mute
 * such arrows in the report so call signaling stays visually dominant
 * while keepalive traffic remains visible (critical for HA scenarios
 * where probe loss is the protagonist).
 */
function isOutOfDialogNonInvite(msg: SipMessage): boolean {
  if (msg.type !== "request") return false
  if (msg.method === "INVITE") return false
  return !getToTag(msg)
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

/**
 * Pastel background tints used to colour-band participant lanes by
 * `NetworkTag`. Soft colours so the sequence-diagram text and arrows
 * stay legible. `ext` keeps the existing white-ish background;
 * `core` gets a faint amber so dual-stack scenarios make the
 * cross-fabric hop visually obvious.
 */
const NETWORK_LANE_COLORS: Record<NetworkTag, string> = {
  ext: "#ffffff",
  core: "#fef9c3", // amber-100
}

const NETWORK_LANE_LABEL_COLORS: Record<NetworkTag, string> = {
  ext: "#6b7280", // gray-500
  core: "#a16207", // amber-700
}

export function renderSequenceDiagram(
  trace: readonly TraceEntry[],
  participants: readonly Participant[]
): string {
  if (participants.length === 0 || trace.length === 0) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
      <text x="200" y="50" text-anchor="middle" font-family="monospace" font-size="14" fill="#666">No messages to display</text>
    </svg>`
  }

  const callIdColorMap = new Map<string, string>()
  const participantX = new Map<string, number>()
  const participantNetwork = new Map<string, NetworkTag>()

  // Base timestamp for T+ annotations — the first trace entry's
  // virtual-clock time. Everything downstream is rendered as an offset
  // from this so the sequence diagram matches the text report.
  const baseTs = trace[0]!.timestamp

  // Compute participant X positions
  for (let i = 0; i < participants.length; i++) {
    const p = participants[i]!
    participantX.set(p.name, MARGIN_LEFT + i * PARTICIPANT_SPACING + PARTICIPANT_BOX_WIDTH / 2)
    participantNetwork.set(p.name, p.network)
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

  // --- Per-network lane bands ---
  // For each contiguous run of participants that share a NetworkTag,
  // paint a coloured background band. With `ext`-only scenarios this
  // reduces to a no-op (white over white). Bands are drawn UNDER the
  // participant boxes / lifelines so arrow text stays readable.
  {
    const distinctNetworks = new Set<NetworkTag>()
    for (const p of participants) distinctNetworks.add(p.network)
    if (distinctNetworks.size > 1) {
      let i = 0
      while (i < participants.length) {
        const net = participants[i]!.network
        let j = i
        while (j + 1 < participants.length && participants[j + 1]!.network === net) j++
        const leftP = participants[i]!
        const rightP = participants[j]!
        const xStart = (participantX.get(leftP.name) ?? 0) - PARTICIPANT_BOX_WIDTH / 2 - 8
        const xEnd = (participantX.get(rightP.name) ?? 0) + PARTICIPANT_BOX_WIDTH / 2 + 8
        const width = Math.max(0, xEnd - xStart)
        const fill = NETWORK_LANE_COLORS[net]
        svgParts.push(`<rect x="${xStart}" y="0" width="${width}" height="${totalHeight}" fill="${fill}" opacity="0.6"/>`)
        // Network label, rendered just above the participant boxes.
        const midX = (xStart + xEnd) / 2
        const labelColor = NETWORK_LANE_LABEL_COLORS[net]
        svgParts.push(`<text x="${midX}" y="${MARGIN_TOP - 4}" text-anchor="middle" font-family="monospace" font-size="${LABEL_FONT_SIZE - 1}" fill="${labelColor}" font-weight="bold">${escapeXml(net)}</text>`)
        i = j + 1
      }
    }
  }

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

    // Clickable group. The lookup key is the entry's index in the sorted
    // trace, NOT `stepIndex` — internal hops (proxy↔worker, spliced in by
    // the interpreter) all share `stepIndex = -1` and would otherwise
    // collide in the click-handler map. `data-step-index` is kept on the
    // attribute for backward compatibility with anything that scrapes the
    // SVG; the click handler uses `data-trace-index` exclusively.
    const arrowClasses = isOutOfDialogNonInvite(entry.message)
      ? "trace-arrow trace-arrow--out-of-dialog-non-invite"
      : "trace-arrow"
    svgParts.push(`<g class="${arrowClasses}" data-step-index="${entry.stepIndex}" data-trace-index="${i}" style="cursor:pointer">`)

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

    // Timing annotations: show the virtual-clock moment the packet left
    // the sender (next to the sender lifeline) and the moment the receiver
    // observed it (next to the receiver lifeline). When the two are equal
    // (e.g. framework-synthesised entries for dangling offers/PRACKs) a
    // single annotation is rendered on the receiver side.
    const sentLabel = formatRelativeTimestamp(entry.sentMs - baseTs)
    const rcvdLabel = formatRelativeTimestamp(entry.receivedMs - baseTs)
    const senderAnchor = isLeftToRight ? "end" : "start"
    const senderX = isLeftToRight ? fromX - 8 : fromX + 8
    const receiverAnchor = isLeftToRight ? "start" : "end"
    const receiverX = isLeftToRight ? toX + 8 : toX - 8
    if (entry.sentMs === entry.receivedMs) {
      svgParts.push(`<text x="${receiverX}" y="${y + 4}" text-anchor="${receiverAnchor}" font-family="monospace" font-size="${LABEL_FONT_SIZE - 2}" fill="#6b7280">${rcvdLabel}</text>`)
    } else {
      svgParts.push(`<text x="${senderX}" y="${y + 4}" text-anchor="${senderAnchor}" font-family="monospace" font-size="${LABEL_FONT_SIZE - 2}" fill="#9ca3af">${sentLabel}</text>`)
      svgParts.push(`<text x="${receiverX}" y="${y + 4}" text-anchor="${receiverAnchor}" font-family="monospace" font-size="${LABEL_FONT_SIZE - 2}" fill="#6b7280">${rcvdLabel}</text>`)
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
