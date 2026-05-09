/**
 * Contract test — production puller transport must NOT be a Stream.fail stub.
 *
 * This test guards against the regression that drove
 * `endurance-2026-05-09t16-15-02-748z` to a 481 storm: production
 * main.ts had the puller's `openStream` wired to
 * `Stream.fail(new PullerTransportError({ reason: "Slice 8: HTTP transport not yet wired" }))`
 * which left every backup partition empty. Fake-clock tests passed
 * because `tests/support/k8sFakeStack.ts` wires its own working
 * `openStream` via `buildPullStream` directly. This test is the
 * crossbar that prevents anyone from reverting `main.ts` to the stub
 * shape without it being noticed.
 *
 * Static text inspection rather than live integration so the test
 * runs in milliseconds and provides an unambiguous error message.
 */

import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, resolve } from "node:path"

const here = dirname(fileURLToPath(import.meta.url))
const mainPath = resolve(here, "../../src/main.ts")
const transportPath = resolve(here, "../../src/replication/PullerHttpTransport.ts")

describe("replication: production puller transport wiring", () => {
  const mainSrc = readFileSync(mainPath, "utf8")
  const transportSrc = readFileSync(transportPath, "utf8")

  it("main.ts must not contain the 'HTTP transport not yet wired' stub message", () => {
    expect(mainSrc).not.toMatch(/HTTP transport not yet wired/)
  })

  it("main.ts must consume makePullerOpenStream — not roll its own openStream inline", () => {
    expect(mainSrc).toMatch(/makePullerOpenStream\(/)
  })

  it("main.ts must provide FetchHttpClient.layer to the replication consumer scope", () => {
    expect(mainSrc).toMatch(/FetchHttpClient\.layer/)
  })

  it("PullerHttpTransport must be backed by HttpClientResponse.stream", () => {
    expect(transportSrc).toMatch(/HttpClientResponse\.stream\s*\(/)
  })

  it("PullerHttpTransport must build an HTTP GET against the peer's /replog endpoint", () => {
    expect(transportSrc).toMatch(/HttpClientRequest\.get\([^)]*\/replog/)
  })

  it("PullerHttpTransport must inject caller/gen/counter/chunk_size via setUrlParams", () => {
    const block = transportSrc.match(/setUrlParams\(\{[\s\S]*?\}\)/)
    expect(block).not.toBeNull()
    expect(block![0]).toMatch(/caller:/)
    expect(block![0]).toMatch(/gen:\s*String\(args\.sinceGen\)/)
    expect(block![0]).toMatch(/counter:\s*String\(args\.sinceCounter\)/)
    expect(block![0]).toMatch(/chunk_size:\s*String\(args\.chunkSize\)/)
  })

  it("PullerHttpTransport must log a WARN line on every reconnect attempt", () => {
    expect(transportSrc).toMatch(
      /Effect\.logWarning\([\s\S]*opening \/replog stream/
    )
  })

  it("PullerHttpTransport must log a WARN line on transport errors", () => {
    expect(transportSrc).toMatch(/Stream\.tapError/)
    expect(transportSrc).toMatch(/Effect\.logWarning\([\s\S]*stream error/)
  })
})
