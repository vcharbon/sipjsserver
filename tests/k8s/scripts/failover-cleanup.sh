#!/usr/bin/env bash
# Manual archive cleanup for test-results/k8s-failover/<runId>/.
#
# Defaults to LISTING runs without deleting. Pass --keep N to delete
# all but the N most recent runs. Pass --yes to skip the confirmation
# prompt.
#
# Examples:
#   bash tests/k8s/scripts/failover-cleanup.sh                # list only
#   bash tests/k8s/scripts/failover-cleanup.sh --keep 10       # prompt to delete all but 10 newest
#   bash tests/k8s/scripts/failover-cleanup.sh --keep 10 --yes # delete without prompt
#
# Per the plan: archives are NOT auto-pruned. The user runs this when
# disk usage matters. Each archive carries the full summary,
# categories.json, routing-decisions.ndjson, kill-timeline.json,
# sipp-traces/, proxy-logs/, and worker-logs/ — typically 10-50 MB
# per run for 20cps × 35-80s loads.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)/test-results/k8s-failover"

KEEP=""
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep)
      KEEP="${2:-}"
      shift 2
      ;;
    --yes|-y)
      ASSUME_YES=1
      shift
      ;;
    --help|-h)
      sed -n '2,/^$/p' "$0" | sed 's/^# *//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ ! -d "$ROOT" ]]; then
  echo "No archive root at $ROOT — nothing to clean up."
  exit 0
fi

# List runs sorted oldest -> newest by mtime.
mapfile -t runs < <(find "$ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' \
  | sort -n \
  | awk '{print $2}')

if [[ ${#runs[@]} -eq 0 ]]; then
  echo "No runs under $ROOT."
  exit 0
fi

if [[ -z "$KEEP" ]]; then
  printf 'Found %d run(s) under %s (oldest first):\n' "${#runs[@]}" "$ROOT"
  for d in "${runs[@]}"; do
    size=$(du -sh "$d" 2>/dev/null | awk '{print $1}')
    printf '  %s\t(%s)\n' "$(basename "$d")" "$size"
  done
  echo
  echo "Pass --keep N to delete all but the N most recent."
  exit 0
fi

if ! [[ "$KEEP" =~ ^[0-9]+$ ]]; then
  echo "--keep value must be a non-negative integer (got: $KEEP)" >&2
  exit 2
fi

total=${#runs[@]}
if (( total <= KEEP )); then
  echo "Have $total run(s); --keep $KEEP — nothing to delete."
  exit 0
fi

delete_count=$((total - KEEP))
to_delete=("${runs[@]:0:$delete_count}")

echo "Will delete $delete_count of $total run(s) (keeping the $KEEP most recent):"
for d in "${to_delete[@]}"; do
  size=$(du -sh "$d" 2>/dev/null | awk '{print $1}')
  printf '  - %s\t(%s)\n' "$(basename "$d")" "$size"
done

if [[ $ASSUME_YES -ne 1 ]]; then
  read -r -p "Proceed? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "Aborted."; exit 1 ;;
  esac
fi

for d in "${to_delete[@]}"; do
  rm -rf -- "$d"
  echo "deleted $(basename "$d")"
done

echo "Done. ${KEEP} run(s) retained."
