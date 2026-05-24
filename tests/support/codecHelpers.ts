/**
 * Tiny test helpers for the post-msgpackr-migration Buffer body shape.
 *
 * `bodyBuf(v)` is the CANONICAL test encoder — it routes through the
 * same `mpPack` used by `src/call/CallCodec.ts`, so tests exercise the
 * real codec rather than a JSON-as-Buffer shortcut. Use this for every
 * fabricated Call body in test fixtures.
 *
 * `legacyJsonBuf(v)` is a deliberate ESCAPE HATCH for the two tests
 * that specifically cover the rolling-upgrade auto-detect path (legacy
 * v1-format bodies written by an older worker). Do NOT use it for new
 * fixtures — it bypasses the production encode path.
 *
 * `decodeBuf(buf)` unpacks a Buffer body through the same auto-detect
 * dispatch the production read path uses (legacy JSON when first byte
 * is `0x7B`, msgpack otherwise).
 */

import { mpPack, mpUnpack } from "../../src/call/CallCodec.js"

export const bodyBuf = (value: unknown): Buffer => mpPack(value)

export const legacyJsonBuf = (value: unknown): Buffer =>
  Buffer.from(JSON.stringify(value))

export const decodeBuf = (buf: Buffer): unknown => {
  if (buf.length > 0 && buf[0] === 0x7b) {
    return JSON.parse(buf.toString("utf8"))
  }
  return mpUnpack(buf)
}

export const bufToString = (buf: Buffer): string => buf.toString("utf8")
