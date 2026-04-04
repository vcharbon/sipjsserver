# SIP Parser Benchmark

Compares parse throughput and memory across three parser implementations:
- **jssip** — current JsSIP PEG.js-based parser (baseline)
- **sip-parser** — npm `sip-parser` (Formup) standalone parser
- **custom** — zero-regex state-machine parser built for this project

## Running

```bash
# With GC heap metrics (recommended)
node --expose-gc --import tsx bench/sip-parser-bench.ts

# Without GC metrics (simpler, heap delta will be inaccurate)
npx tsx bench/sip-parser-bench.ts
```

## What it measures

- **1M iterations** per parser per message type (INVITE, 200 OK, BYE)
- **Corpus**: 1000 unique pre-built `Buffer` objects per message type (varying Call-ID/branch)
- **Warm-up**: 10k iterations discarded before measurement
- **Metrics**: avg μs/parse, msgs/sec, heap delta (KB), avg message size

## Output

Markdown table to stdout plus speedup ratios vs JsSIP baseline.

## Compliance tests

The compliance matrix (RFC 4475 torture tests) is in the test suite, not here:

```bash
npx vitest run tests/sip/parser-compliance.test.ts
```
