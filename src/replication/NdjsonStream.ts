/**
 * Line-buffered NDJSON byte stream → `PullFrame` stream.
 *
 * Shared between `/replog` and `/bootstrap` consumers. Built on the
 * standard Effect v4 byte-to-line pipeline:
 *
 *   Uint8Array  →  decodeText  →  splitLines  →  mapEffect(decode)
 *
 * `Stream.decodeText` lazily allocates a `TextDecoder` inside `suspend`
 * so each stream execution gets its own decoder — restart-safe.
 * `Stream.splitLines` handles `\n`, `\r`, and `\r\n` delimiters across
 * chunks, including multi-byte characters split mid-codepoint.
 * Decode failures surface as `ProtocolError` via `decodeFrameEffect`.
 */

import { Effect, Stream } from "effect"
import {
  decodeFrame,
  ProtocolError,
  type PullFrame,
} from "./ReplicationProtocol.js"

export const streamNdjsonLines = <E>(
  bytes: Stream.Stream<Uint8Array, E>
): Stream.Stream<PullFrame, E | ProtocolError> =>
  bytes.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.filter((line) => line.length > 0),
    Stream.mapEffect(decodeFrameEffect)
  )

const decodeFrameEffect = (
  line: string
): Effect.Effect<PullFrame, ProtocolError> =>
  Effect.try({
    try: () => {
      const frame = decodeFrame(line)
      if (frame === null) {
        // `decodeFrame` only returns null for whitespace-only lines,
        // which the upstream `Stream.filter` already drops. Reaching
        // here means a non-empty line decoded to null — treat as a
        // protocol bug rather than silently swallowing.
        throw new ProtocolError({ reason: "unexpected null frame", raw: line })
      }
      return frame
    },
    catch: (err) =>
      err instanceof ProtocolError
        ? err
        : new ProtocolError({
            reason: err instanceof Error ? err.message : String(err),
            raw: line,
          }),
  })
