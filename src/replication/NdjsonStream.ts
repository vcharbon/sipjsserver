/**
 * Length-prefixed-binary frame stream → `PullFrame` stream.
 *
 * Shared between `/replog` and `/bootstrap` consumers. Post-msgpackr-
 * migration the wire format is:
 *
 *   ┌─────────────────────────┬───────────────────────────────────┐
 *   │ 4-byte BE uint32 length │ msgpack-encoded payload (`length`)│
 *   └─────────────────────────┴───────────────────────────────────┘
 *
 * Frames can span multiple input chunks (or several frames can arrive in
 * one chunk), so this re-assembler buffers bytes across chunks and emits
 * frames as soon as the length prefix plus payload are both available.
 * Decode failures surface as `ProtocolError` via `decodeFrame`.
 *
 * The module keeps its historical name `NdjsonStream` for one release
 * cycle (call sites import the export `streamNdjsonLines` which has
 * been retained as an alias so the rest of the replication wiring does
 * not need to update import paths simultaneously with the codec swap).
 */

import { Effect, Stream } from "effect"
import {
  decodeFrame,
  ProtocolError,
  type PullFrame,
} from "./ReplicationProtocol.js"

const LENGTH_PREFIX_BYTES = 4

/**
 * Re-assemble a stream of arbitrary-sized byte chunks into length-
 * prefixed msgpack frames. Internal state is a single Buffer accumulator
 * scoped to the stream's run-time; backpressure is governed by the
 * caller's downstream consumption rate.
 */
export const streamLengthPrefixedFrames = <E>(
  bytes: Stream.Stream<Uint8Array, E>
): Stream.Stream<PullFrame, E | ProtocolError> =>
  Stream.suspend(() => {
    let accumulator: Buffer = Buffer.alloc(0)

    const drain = (): ReadonlyArray<PullFrame> | ProtocolError => {
      const out: Array<PullFrame> = []
      while (accumulator.length >= LENGTH_PREFIX_BYTES) {
        const length = accumulator.readUInt32BE(0)
        if (accumulator.length < LENGTH_PREFIX_BYTES + length) break
        const payload = accumulator.subarray(
          LENGTH_PREFIX_BYTES,
          LENGTH_PREFIX_BYTES + length,
        )
        accumulator = accumulator.subarray(LENGTH_PREFIX_BYTES + length)
        try {
          out.push(decodeFrame(payload))
        } catch (err) {
          if (err instanceof ProtocolError) return err
          return new ProtocolError({
            reason: err instanceof Error ? err.message : String(err),
          })
        }
      }
      return out
    }

    return bytes.pipe(
      Stream.mapEffect((chunk) =>
        Effect.suspend(() => {
          accumulator = Buffer.concat([accumulator, Buffer.from(chunk)])
          const drained = drain()
          if (drained instanceof ProtocolError) return Effect.fail(drained)
          return Effect.succeed(drained)
        }),
      ),
      Stream.flatMap((frames) => Stream.fromIterable(frames)),
    )
  })

/**
 * Back-compat alias — the old NDJSON parser is gone but the name lives
 * on so the surrounding code does not need to update imports as part
 * of the codec migration. Remove in a follow-up after a release cycle.
 */
export const streamNdjsonLines = streamLengthPrefixedFrames
