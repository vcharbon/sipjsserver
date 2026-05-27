#!/bin/bash
# Orchestrate the ABNF fuzz suite. For each target:
#   1. Concatenate _common.abnf with the per-target grammar.
#   2. Generate N samples with abnfgen (varied seeds, one per line).
#   3. Pipe samples to scripts/abnf-fuzz-driver.ts with --target <name>.
#   4. Print a one-line summary; full reports land in ${OUT}/<target>.report.json.
#
# Requires `abnfgen` (https://www.quut.com/abnfgen/). Build it once:
#     curl -sSL https://www.quut.com/abnfgen/abnfgen-0.20.tar.gz | tar xz -C /tmp
#     (cd /tmp/abnfgen-0.20 && ./configure && make)
# then export ABNFGEN=/tmp/abnfgen-0.20/abnfgen.
#
# Tunables:
#   N        samples per target (default 1000)
#   OUT      report/working dir (default /tmp/abnf-fuzz-out)
#   ABNFGEN  path to the abnfgen binary (default: abnfgen on $PATH)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

ABNFGEN=${ABNFGEN:-abnfgen}
GRAMMARS="${HERE}/grammars"
OUT=${OUT:-/tmp/abnf-fuzz-out}
N=${N:-1000}

if ! command -v "$ABNFGEN" >/dev/null 2>&1; then
  echo "abnfgen not found at \"$ABNFGEN\". See header of this script." >&2
  exit 1
fi

mkdir -p "$OUT"

# target | start-symbol
TARGETS=(
  "sip-uri:SIP-URI"
  "from:from-spec"
  "pai:pai-header-value"
  "contact:contact-value"
  "via:via-header-value"
  "cseq:cseq-value"
  "rack:rack-value"
  "replaces:replaces-value"
  "refer-to:refer-to-value"
  "request-line:request-line"
)

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  start="${entry##*:}"
  grammar="$OUT/${target}.abnf"
  samples="$OUT/${target}.samples"
  report="$OUT/${target}.report.json"

  cat "$GRAMMARS/_common.abnf" "$GRAMMARS/${target}.abnf" > "$grammar"

  printf "%-14s start=%-22s … " "$target" "$start" >&2
  : > "$samples"
  for r in $(seq 1 "$N"); do
    "$ABNFGEN" -s "$start" -r "$r" "$grammar" 2>/dev/null >> "$samples" || true
    printf "\n" >> "$samples"
  done

  cd "$REPO" && npx tsx scripts/abnf-fuzz-driver.ts --target "$target" < "$samples" > "$report"
  python3 -c "
import json
d = json.load(open('$report'))
print(f'  total={d[\"total\"]:>5} accepted={d[\"accepted\"]:>5} policy={d[\"policyRejected\"]:>4} ({d[\"policyRate\"]})  buggy={d[\"buggyRejected\"]:>4} ({d[\"buggyRate\"]})  silentMis={d[\"silentMisparses\"]:>4}')
" >&2
done
