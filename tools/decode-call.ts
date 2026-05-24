#!/usr/bin/env tsx
/**
 * decode-call — operator tool for inspecting a msgpack-encoded call
 * body in Redis.
 *
 *   tsx tools/decode-call.ts pri:worker-0:call:<ref>
 *
 * Connects to the same Redis the workers use (REDIS_URL env var, falls
 * back to `redis://localhost:6379`), fetches the key via `getBuffer`,
 * dispatches between legacy JSON and msgpack on the first byte, and
 * prints the decoded JS value as pretty JSON.
 *
 * Why this exists: post-msgpackr-migration the body is binary, so
 * `redis-cli get <key>` is unreadable (high bytes confuse the terminal
 * decoder). This tool is the equivalent of "cat with a Buffer decoder".
 */

import IoRedis from "ioredis"
import { decodeBodyAuto } from "../src/call/CallCodec.js"

const RedisCtor = IoRedis.default

const main = async () => {
  const key = process.argv[2]
  if (key === undefined || key.length === 0) {
    process.stderr.write(
      "usage: tsx tools/decode-call.ts <full-redis-key>\n" +
        "example: tsx tools/decode-call.ts pri:worker-0:call:Wfb...\n",
    )
    process.exit(2)
  }
  const url = process.env["REDIS_URL"] ?? "redis://localhost:6379"
  const redis = new RedisCtor(url, { lazyConnect: true })
  try {
    await redis.connect()
    const buf = await redis.getBuffer(key)
    if (buf === null) {
      process.stderr.write(`key not found: ${key}\n`)
      process.exit(1)
    }
    const decoded = decodeBodyAuto(buf)
    process.stdout.write(`${JSON.stringify(decoded, null, 2)}\n`)
  } finally {
    redis.disconnect()
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    `decode-call failed: ${err instanceof Error ? err.message : String(err)}\n`,
  )
  process.exit(1)
})
