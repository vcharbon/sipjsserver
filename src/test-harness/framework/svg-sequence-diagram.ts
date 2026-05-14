/**
 * SVG sequence diagram renderer for SIP message traces.
 *
 * Lane identity is `(ip, port)` — every column header shows the wire
 * address as the primary label and any registered name(s) underneath.
 * This is the structural defense against the "report invents names/IPs"
 * failure mode: a name slot can only contain values that were actually
 * registered as participants; if no name is known the slot stays empty.
 *
 * Arrows are placed on their `fromAddr`/`toAddr` columns, NOT on their
 * `from`/`to` name fields, so a transport that fabricates a name string
 * cannot move the arrow to a different lane.
 */

import type { SipMessage } from "../../sip/types.js"
import {
  laneKey,
  type Lane,
  type NetworkTag,
  type ReplicationTraceEntry,
  type TraceEntry,
  type TransportKind,
} from "./types.js"

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const PARTICIPANT_SPACING = 250
const ROW_HEIGHT = 55
const HEADER_HEIGHT = 80
const PARTICIPANT_BOX_WIDTH = 200
const PARTICIPANT_BOX_HEIGHT = 56
const MARGIN_LEFT = 40
const MARGIN_TOP = 20
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
  return msg.getHeader("call-id")
}

function getFromTag(msg: SipMessage): string {
  return msg.getHeader("from").tag ?? ""
}

function getToTag(msg: SipMessage): string {
  return msg.getHeader("to").tag ?? ""
}

function getCSeqMethod(msg: SipMessage): string {
  return msg.getHeader("cseq").method
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
 * dialog-creating INVITE. Used to mute keepalive-style arrows so call
 * signaling stays visually dominant.
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

/**
 * Build a pod-name → lane-key index for resolving replication frames.
 * A replication frame names pods (worker-1, worker-2, …); the renderer
 * places the arrow on whichever lane has that pod registered as one of
 * its names. Lanes with no SIP traffic at all are not in this map — the
 * caller falls back to a synthetic pod-only column when that happens.
 */
function buildPodLaneIndex(lanes: readonly Lane[]): Map<string, string> {
  const idx = new Map<string, string>()
  for (const lane of lanes) {
    const key = laneKey(lane.ip, lane.port)
    for (const name of lane.names) {
      if (!idx.has(name)) idx.set(name, key)
    }
  }
  return idx
}

/**
 * Render one replication-frame row inside the SVG sequence diagram.
 * Dashed indigo arrow with a one-line summary; click target carries
 * `data-repl-index` for the html-report handler.
 */
function renderReplicationRow(args: {
  readonly svgParts: string[]
  readonly repl: ReplicationTraceEntry
  readonly index: number
  readonly y: number
  readonly baseTs: number
  readonly laneX: Map<string, number>
  readonly podLaneIndex: Map<string, string>
}): void {
  const { svgParts, repl, index, y, baseTs, laneX, podLaneIndex } = args
  const fromLaneKey = podLaneIndex.get(repl.from)
  const toLaneKey = podLaneIndex.get(repl.to)
  const fromX = fromLaneKey !== undefined ? laneX.get(fromLaneKey) : undefined
  const toX = toLaneKey !== undefined ? laneX.get(toLaneKey) : undefined
  if (fromX === undefined || toX === undefined) return

  const isLeftToRight = fromX < toX
  const lineColor = "#4f46e5"
  const arrowFromX = isLeftToRight ? fromX + 5 : fromX - 5
  const arrowToX = isLeftToRight ? toX - 5 : toX + 5

  const summary = replicationSummary(repl.frame)

  svgParts.push(
    `<g class="repl-arrow" data-repl-index="${index}" style="cursor:pointer">`,
  )
  svgParts.push(
    `<line x1="${arrowFromX}" y1="${y}" x2="${arrowToX}" y2="${y}" stroke="${lineColor}" stroke-width="1.5" stroke-dasharray="3,3" marker-end="url(#arrowhead-repl)"/>`,
  )
  const midX = (fromX + toX) / 2
  svgParts.push(
    `<text x="${midX}" y="${y - 14}" text-anchor="middle" font-family="monospace" font-size="${LABEL_FONT_SIZE}" fill="${lineColor}">${escapeXml("⇢ repl: " + summary)}</text>`,
  )
  const rcvdLabel = formatRelativeTimestamp(repl.timestamp - baseTs)
  const receiverAnchor = isLeftToRight ? "start" : "end"
  const receiverX = isLeftToRight ? toX + 8 : toX - 8
  svgParts.push(
    `<text x="${receiverX}" y="${y + 4}" text-anchor="${receiverAnchor}" font-family="monospace" font-size="${LABEL_FONT_SIZE - 2}" fill="#4338ca">${rcvdLabel}</text>`,
  )
  svgParts.push(
    `<rect x="${Math.min(fromX, toX)}" y="${y - 20}" width="${Math.abs(toX - fromX)}" height="30" fill="transparent"/>`,
  )
  svgParts.push(`</g>`)
}

function replicationSummary(frame: unknown): string {
  if (typeof frame !== "object" || frame === null) return "?"
  const obj = frame as Record<string, unknown>
  const tag = typeof obj["_tag"] === "string" ? (obj["_tag"] as string) : ""
  if (tag === "Noop") {
    return `Noop g=${String(obj["gen"] ?? "")} c=${String(obj["counter"] ?? "")}`
  }
  if (tag === "Data") {
    const op = String(obj["op"] ?? "")
    const partition = String(obj["partition"] ?? "")
    const callRef = String(obj["callRef"] ?? "")
    const callRefShort = callRef.length > 22 ? callRef.slice(0, 22) + "…" : callRef
    return `${op} ${partition} ${callRefShort}`
  }
  return tag || "?"
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
 * Pastel background tints used to colour-band lanes by `NetworkTag`.
 * `ext` keeps a near-white background; `core` gets a faint amber so
 * dual-stack scenarios make the cross-fabric hop visually obvious.
 */
const NETWORK_LANE_COLORS: Record<NetworkTag, string> = {
  ext: "#ffffff",
  core: "#fef9c3", // amber-100
}

const NETWORK_LANE_LABEL_COLORS: Record<NetworkTag, string> = {
  ext: "#6b7280", // gray-500
  core: "#a16207", // amber-700
}

/**
 * Faint canvas tints applied behind the whole diagram so an operator
 * scanning thumbnails can recognize the transport kind at a glance.
 * Header chip in `html-report.ts` carries matching colors.
 */
const TRANSPORT_KIND_CANVAS: Record<TransportKind, string> = {
  fake: "#eef2ff", // indigo-50 — fake/simulated
  live: "#ecfdf5", // emerald-50 — live UDP
  hybrid: "#faf5ff", // purple-50 — composed fake+live
}

export function renderSequenceDiagram(
  trace: readonly TraceEntry[],
  lanes: readonly Lane[],
  replicationTrace: readonly ReplicationTraceEntry[] = [],
  transportKind: TransportKind = "fake",
): string {
  if (lanes.length === 0 || (trace.length === 0 && replicationTrace.length === 0)) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100">
      <text x="200" y="50" text-anchor="middle" font-family="monospace" font-size="14" fill="#666">No messages to display</text>
    </svg>`
  }

  const callIdColorMap = new Map<string, string>()
  // Lane-key (`"<ip>:<port>"`) → X centre coordinate.
  const laneX = new Map<string, number>()
  // Lane-key → resolved `Lane` (kept for kill-band rendering).
  const laneByKey = new Map<string, Lane>()

  for (let i = 0; i < lanes.length; i++) {
    const lane = lanes[i]!
    const key = laneKey(lane.ip, lane.port)
    laneX.set(key, MARGIN_LEFT + i * PARTICIPANT_SPACING + PARTICIPANT_BOX_WIDTH / 2)
    laneByKey.set(key, lane)
  }

  const podLaneIndex = buildPodLaneIndex(lanes)

  // Merge SIP and replication entries into a single timeline.
  type Row =
    | { readonly kind: "sip"; readonly index: number; readonly entry: TraceEntry }
    | { readonly kind: "repl"; readonly index: number; readonly entry: ReplicationTraceEntry }
  const rows: Row[] = []
  for (let i = 0; i < trace.length; i++) {
    rows.push({ kind: "sip", index: i, entry: trace[i]! })
  }
  for (let i = 0; i < replicationTrace.length; i++) {
    rows.push({ kind: "repl", index: i, entry: replicationTrace[i]! })
  }
  // Primary sort: `timestamp`. Secondary: `seq` from the shared
  // `EventSequencer` so same-ms events keep capture order across SIP +
  // replication layers (matters most for hybrid fake-ext + real-core
  // traces, where two clocks can land on the same ms). Tertiary: SIP
  // before replication when the harness ran without a sequencer (seq=0
  // on both sides) — preserves the legacy "SIP first" tiebreak.
  rows.sort((a, b) => {
    const dt = a.entry.timestamp - b.entry.timestamp
    if (dt !== 0) return dt
    const ds = a.entry.seq - b.entry.seq
    if (ds !== 0) return ds
    if (a.kind === b.kind) return 0
    return a.kind === "sip" ? -1 : 1
  })

  const baseTs = rows[0]!.entry.timestamp

  const totalWidth = MARGIN_LEFT * 2 + (lanes.length - 1) * PARTICIPANT_SPACING + PARTICIPANT_BOX_WIDTH
  let currentY = MARGIN_TOP + HEADER_HEIGHT
  const rowYs: number[] = []

  for (let i = 0; i < rows.length; i++) {
    rowYs.push(currentY)
    currentY += ROW_HEIGHT
  }

  const totalHeight = currentY + 40

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
    <marker id="arrowhead-repl" markerWidth="${ARROWHEAD_SIZE}" markerHeight="${ARROWHEAD_SIZE}" refX="${ARROWHEAD_SIZE}" refY="${ARROWHEAD_SIZE / 2}" orient="auto">
      <polygon points="0 0, ${ARROWHEAD_SIZE} ${ARROWHEAD_SIZE / 2}, 0 ${ARROWHEAD_SIZE}" fill="#4f46e5"/>
    </marker>
  </defs>`)

  // --- Canvas backdrop tinted by transport kind ---
  svgParts.push(
    `<rect width="${totalWidth}" height="${totalHeight}" fill="${TRANSPORT_KIND_CANVAS[transportKind]}"/>`,
  )

  // --- Per-network lane bands ---
  // Paint a coloured background band for each contiguous run of lanes
  // sharing a NetworkTag. With `ext`-only scenarios this is a no-op
  // over the canvas tint.
  {
    const distinctNetworks = new Set<NetworkTag>()
    for (const lane of lanes) distinctNetworks.add(lane.network)
    if (distinctNetworks.size > 1) {
      let i = 0
      while (i < lanes.length) {
        const net = lanes[i]!.network
        let j = i
        while (j + 1 < lanes.length && lanes[j + 1]!.network === net) j++
        const leftLane = lanes[i]!
        const rightLane = lanes[j]!
        const xStart = (laneX.get(laneKey(leftLane.ip, leftLane.port)) ?? 0) - PARTICIPANT_BOX_WIDTH / 2 - 8
        const xEnd = (laneX.get(laneKey(rightLane.ip, rightLane.port)) ?? 0) + PARTICIPANT_BOX_WIDTH / 2 + 8
        const width = Math.max(0, xEnd - xStart)
        const fill = NETWORK_LANE_COLORS[net]
        svgParts.push(`<rect x="${xStart}" y="0" width="${width}" height="${totalHeight}" fill="${fill}" opacity="0.5"/>`)
        const midX = (xStart + xEnd) / 2
        const labelColor = NETWORK_LANE_LABEL_COLORS[net]
        svgParts.push(`<text x="${midX}" y="${MARGIN_TOP - 4}" text-anchor="middle" font-family="monospace" font-size="${LABEL_FONT_SIZE - 1}" fill="${labelColor}" font-weight="bold">${escapeXml(net)}</text>`)
        i = j + 1
      }
    }
  }

  // --- Lane headers (two-line: address primary, names secondary) ---
  for (const [key, x] of laneX) {
    const lane = laneByKey.get(key)!
    const boxX = x - PARTICIPANT_BOX_WIDTH / 2
    const boxY = MARGIN_TOP
    svgParts.push(`<rect x="${boxX}" y="${boxY}" width="${PARTICIPANT_BOX_WIDTH}" height="${PARTICIPANT_BOX_HEIGHT}" rx="4" fill="#f3f4f6" stroke="#6b7280" stroke-width="1.5"/>`)
    // Primary line: address.
    const addrLabel = `${lane.ip}:${lane.port}`
    svgParts.push(`<text x="${x}" y="${boxY + 22}" text-anchor="middle" font-family="monospace" font-size="${FONT_SIZE}" font-weight="bold" fill="#111827">${escapeXml(addrLabel)}</text>`)
    // Secondary line: name(s). Empty when nothing was registered.
    const nameLabel = lane.names.join(", ")
    if (nameLabel.length > 0) {
      svgParts.push(`<text x="${x}" y="${boxY + 42}" text-anchor="middle" font-family="monospace" font-size="${FONT_SIZE - 1}" fill="#4b5563">${escapeXml(nameLabel)}</text>`)
    }
  }

  // --- Lifelines ---
  for (const [, x] of laneX) {
    svgParts.push(`<line x1="${x}" y1="${MARGIN_TOP + PARTICIPANT_BOX_HEIGHT}" x2="${x}" y2="${totalHeight - 20}" stroke="#d1d5db" stroke-width="1" stroke-dasharray="4,4"/>`)
  }

  // --- Kill bands ---
  // For each lane with a recorded kill, paint a horizontal red dashed
  // strip across its lifeline at the kill timestamp. Maps virtual time
  // to Y by snapping to the row whose timestamp is closest to the
  // kill instant; for single-row precision we'd need exact y-mapping
  // but the row-grain marker is sufficient to indicate the boundary.
  if (rows.length > 0) {
    for (const [key, lane] of laneByKey) {
      if (lane.killedAt.length === 0) continue
      const x = laneX.get(key)!
      for (const at of lane.killedAt) {
        // Find row idx whose timestamp >= `at`; place marker just above.
        let ry = totalHeight - 20
        for (let i = 0; i < rows.length; i++) {
          if (rows[i]!.entry.timestamp >= at) {
            ry = rowYs[i]! - ROW_HEIGHT / 2
            break
          }
        }
        svgParts.push(
          `<line x1="${x - 18}" y1="${ry}" x2="${x + 18}" y2="${ry}" stroke="#dc2626" stroke-width="3" stroke-dasharray="4,3"/>`,
        )
        svgParts.push(
          `<text x="${x + 22}" y="${ry + 3}" text-anchor="start" font-family="monospace" font-size="${LABEL_FONT_SIZE - 2}" font-weight="bold" fill="#991b1b">KILL</text>`,
        )
      }
    }
  }

  // --- Arrows ---
  for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
    const row = rows[rowIdx]!
    const y = rowYs[rowIdx]!

    if (row.kind === "repl") {
      renderReplicationRow({
        svgParts,
        repl: row.entry,
        index: row.index,
        y,
        baseTs,
        laneX,
        podLaneIndex,
      })
      continue
    }

    const entry = row.entry
    const fromX = laneX.get(laneKey(entry.fromAddr.ip, entry.fromAddr.port))
    const toX = laneX.get(laneKey(entry.toAddr.ip, entry.toAddr.port))

    if (fromX === undefined || toX === undefined) continue

    const callId = getCallId(entry.message)
    const color = getCallIdColor(callId, callIdColorMap)
    const label = getArrowLabel(entry.message)
    const tagLabel = getTagLabel(entry.message)

    const isLeftToRight = fromX < toX
    const lineColor = entry.status === "fail" ? "#dc2626"
      : entry.status === "unexpected" ? "#d97706"
      : "#374151"
    const dashArray = entry.status === "pass" ? "" : `stroke-dasharray="6,4"`
    const markerEnd = entry.status === "fail" ? "url(#arrowhead-fail)"
      : entry.status === "unexpected" ? "url(#arrowhead-unexpected)"
      : "url(#arrowhead-pass)"

    const arrowClasses = isOutOfDialogNonInvite(entry.message)
      ? "trace-arrow trace-arrow--out-of-dialog-non-invite"
      : "trace-arrow"
    svgParts.push(`<g class="${arrowClasses}" data-step-index="${entry.stepIndex}" data-trace-index="${row.index}" style="cursor:pointer">`)

    const arrowFromX = isLeftToRight ? fromX + 5 : fromX - 5
    const arrowToX = isLeftToRight ? toX - 5 : toX + 5
    svgParts.push(`<line x1="${arrowFromX}" y1="${y}" x2="${arrowToX}" y2="${y}" stroke="${lineColor}" stroke-width="1.5" marker-end="${markerEnd}" ${dashArray}/>`)

    const midX = (fromX + toX) / 2
    const labelY = y - 14
    svgParts.push(`<text x="${midX}" y="${labelY}" text-anchor="middle" font-family="monospace" font-size="${LABEL_FONT_SIZE}" fill="${color}">${escapeXml(label)}</text>`)

    if (tagLabel) {
      svgParts.push(`<text x="${midX}" y="${y - 3}" text-anchor="middle" font-family="monospace" font-size="${LABEL_FONT_SIZE - 2}" fill="#9ca3af">${escapeXml(tagLabel)}</text>`)
    }

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

    if (entry.status === "unexpected") {
      const badgeX = isLeftToRight ? toX + 8 : toX - 70
      svgParts.push(`<text x="${badgeX}" y="${y + 4}" text-anchor="start" font-family="monospace" font-size="${LABEL_FONT_SIZE - 1}" font-weight="bold" fill="#d97706">UNEXPECTED</text>`)
    }

    svgParts.push(`<rect x="${Math.min(fromX, toX)}" y="${y - 20}" width="${Math.abs(toX - fromX)}" height="30" fill="transparent"/>`)

    svgParts.push(`</g>`)
  }

  svgParts.push(`</svg>`)

  return svgParts.join("\n")
}
