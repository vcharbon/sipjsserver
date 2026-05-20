// Loader for the native SIP parser addon. The TS adapter requires this
// file via a stable relative path; this file in turn resolves the correct
// per-platform .node binary. Phase 1/2A ships two linux x86_64 variants —
// glibc (host dev) and musl (the alpine runtime image). Try musl first
// when present, fall back to glibc.

"use strict"

const variants = [
  "./sipjs-native-parser.linux-x64-musl.node",
  "./sipjs-native-parser.linux-x64-gnu.node",
]

let loaded
let lastErr
for (const v of variants) {
  try {
    loaded = require(v)
    break
  } catch (err) {
    lastErr = err
  }
}

if (loaded === undefined) {
  throw lastErr ?? new Error("no native SIP parser .node variant resolved")
}

module.exports = loaded
