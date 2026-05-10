/**
 * Line-buffered NDJSON byte stream → `PullFrame` stream.
 *
 * Shared between `/replog` and `/bootstrap` consumers. The state (chunk
 * buffer + TextDecoder) is created lazily inside `Stream.unwrap`, so a
 * fresh buffer is allocated per stream execution — restart-safe.
 *
 * Multi-byte characters split across chunks are handled by passing
 * `{ stream: true }` to `TextDecoder.decode`. Empty lines (whitespace
 * only) are skipped. Decode failures surface as `ProtocolError`.
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
  Stream.unwrap(
    Effect.sync(() => {
      const decoder = new TextDecoder()
      const state = { buffer: "" }
      const decodeChunk = (
        chunk: Uint8Array
      ): Stream.Stream<PullFrame, ProtocolError> =>
        Stream.unwrap(
          Effect.gen(function* () {
            state.buffer += decoder.decode(chunk, { stream: true })
            const frames: Array<PullFrame> = []
            let nl = state.buffer.indexOf("\n")
            while (nl !== -1) {
              const line = state.buffer.slice(0, nl)
              state.buffer = state.buffer.slice(nl + 1)
              if (line.length > 0) {
                const frame = yield* decodeFrameEffect(line)
                if (frame !== null) frames.push(frame)
              }
              nl = state.buffer.indexOf("\n")
            }
            return Stream.fromIterable(frames)
          })
        )
      return bytes.pipe(Stream.flatMap(decodeChunk))
    })
  )

const decodeFrameEffect = (
  line: string
): Effect.Effect<PullFrame | null, ProtocolError> =>
  Effect.try({
    try: () => decodeFrame(line),
    catch: (err) =>
      err instanceof ProtocolError
        ? err
        : new ProtocolError({
            reason: err instanceof Error ? err.message : String(err),
            raw: line,
          }),
  })
