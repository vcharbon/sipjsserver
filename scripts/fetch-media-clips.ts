/**
 * Render the reference media clips to listenable `.wav` files under
 * `src/test-harness/media/audio/clips/`.
 *
 * The clips are synthesized deterministically by `clips.ts` (see SOURCES.md),
 * so this script's job is just to materialize them on disk for humans to play
 * and to document the provenance / upgrade path. Re-running it reproduces
 * byte-identical files. When real CC0 speech clips replace the synthetic
 * voices, this is where the download + trim + resample steps belong.
 *
 *   tsx scripts/fetch-media-clips.ts
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { CLIP_NAMES, CLIP_SAMPLE_RATE, referenceClip } from "../src/test-harness/media/audio/clips.js"
import { encodeWav } from "../src/test-harness/media/audio/wav.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(here, "../src/test-harness/media/audio/clips")

fs.mkdirSync(outDir, { recursive: true })

for (const name of CLIP_NAMES) {
  const pcm = referenceClip(name)
  const wav = encodeWav(pcm, CLIP_SAMPLE_RATE)
  const file = path.join(outDir, `${name}.wav`)
  fs.writeFileSync(file, wav)
  const seconds = (pcm.length / CLIP_SAMPLE_RATE).toFixed(2)
  console.log(`wrote ${path.relative(process.cwd(), file)} (${seconds}s, ${pcm.length} samples)`)
}

console.log(`\n${CLIP_NAMES.length} clips written to ${path.relative(process.cwd(), outDir)}`)
