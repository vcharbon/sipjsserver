#!/usr/bin/env bash
# Render all .mmd Mermaid sources to .svg next to them.
# Requires @mermaid-js/mermaid-cli (mmdc). Picks up local install or /tmp install.

set -euo pipefail
cd "$(dirname "$0")"

MMDC=""
for cand in ./node_modules/.bin/mmdc ../node_modules/.bin/mmdc /tmp/node_modules/.bin/mmdc; do
    if [ -x "$cand" ]; then MMDC="$cand"; break; fi
done
if [ -z "$MMDC" ]; then
    echo "mmdc not found. Install with: npm install --no-save @mermaid-js/mermaid-cli" >&2
    exit 1
fi

for src in *.mmd; do
    out="${src%.mmd}.svg"
    echo "→ $out"
    "$MMDC" -i "$src" -o "$out" -c mermaid-config.json -b transparent >/dev/null
done
echo "Done."
