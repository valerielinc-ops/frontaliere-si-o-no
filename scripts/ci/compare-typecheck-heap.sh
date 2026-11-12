#!/usr/bin/env bash
# Confronta il vecchio heap interno da 12 GiB con il limite del runner che oggi
# governa `typecheck:gate`. Le due misure girano sullo stesso checkout e runner;
# la cache incrementale viene rimossa prima di ciascuna per mantenere uguale la
# fase osservata. Il peak viene letto dal contatore kernel memory.peak del
# cgroup v2, che conserva anche gli spike tra i campioni VmRSS periodici.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SAMPLER="$ROOT/scripts/ci/sample-mem-during.sh"
CGROUP_PEAK="$ROOT/scripts/ci/run-with-cgroup-memory-peak.py"
BUILD_INFO="$ROOT/.cache/tsc/tsconfig.tsbuildinfo"
CONTRACT="$ROOT/scripts/ci/typecheck-heap-contract.env"
# shellcheck source=typecheck-heap-contract.env
source "$CONTRACT"
OLD_HEAP_MB="$TYPECHECK_HISTORICAL_HEAP_MB"
NEW_HEAP_MB="$TYPECHECK_CURRENT_HEAP_MB"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$ROOT"

runner_limit_bytes=0
runner_limit_mb=0

run_variant() {
  local label="$1"
  local heap_mb="$2"
  local log="$TMP_DIR/$label.log"
  local status

  if ! rm -f "$BUILD_INFO"; then
    echo "::error::${label}: cache incrementale non rimossa; confronto non valido."
    return 2
  fi
  if env NODE_OPTIONS="--max-old-space-size=$heap_mb" \
    python3 "$CGROUP_PEAK" -- bash "$SAMPLER" -- npm run typecheck:gate >"$log" 2>&1; then
    status=0
  else
    status=$?
  fi

  cat "$log"
  local peak_bytes measured_limit_bytes
  peak_bytes="$(sed -nE 's/.*peak_cgroup_memory_bytes=([0-9]+).*/\1/p' "$log" | tail -n 1)"
  measured_limit_bytes="$(sed -nE 's/.*runner_limit_bytes=([0-9]+).*/\1/p' "$log" | tail -n 1)"
  if ! [[ "$peak_bytes" =~ ^[1-9][0-9]*$ ]] || ! [[ "$measured_limit_bytes" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::${label}: peak o limite cgroup non misurabile."
    return 2
  fi

  if [ "$runner_limit_bytes" -eq 0 ]; then
    runner_limit_bytes="$measured_limit_bytes"
    runner_limit_mb=$((runner_limit_bytes / 1024 / 1024))
  elif [ "$runner_limit_bytes" -ne "$measured_limit_bytes" ]; then
    echo "::error::${label}: il limite effettivo è cambiato tra le due misure."
    return 2
  fi

  local peak_mb
  peak_mb=$(((peak_bytes + 1024 * 1024 - 1) / 1024 / 1024))
  printf -v "${label}_status" '%s' "$status"
  printf -v "${label}_peak_bytes" '%s' "$peak_bytes"
  printf -v "${label}_peak_mb" '%s' "$peak_mb"
}

old_status=2
old_peak_bytes=0
old_peak_mb=0
new_status=2
new_peak_bytes=0
new_peak_mb=0
if ! run_variant old "$OLD_HEAP_MB"; then
  exit 2
fi
if ! run_variant new "$NEW_HEAP_MB"; then
  exit 2
fi

headroom_bytes=$((runner_limit_bytes - new_peak_bytes))
headroom_mb=$((headroom_bytes / 1024 / 1024))
summary="old_status=$old_status old_peak_cgroup_memory_bytes=$old_peak_bytes old_peak_cgroup_memory_mb=$old_peak_mb new_status=$new_status new_peak_cgroup_memory_bytes=$new_peak_bytes new_peak_cgroup_memory_mb=$new_peak_mb runner_limit_bytes=$runner_limit_bytes runner_limit_mb=$runner_limit_mb new_headroom_mb=$headroom_mb"
echo "[typecheck-heap-comparison] $summary"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "old_status=$old_status"
    echo "old_peak_cgroup_memory_bytes=$old_peak_bytes"
    echo "old_peak_cgroup_memory_mb=$old_peak_mb"
    echo "new_status=$new_status"
    echo "new_peak_cgroup_memory_bytes=$new_peak_bytes"
    echo "new_peak_cgroup_memory_mb=$new_peak_mb"
    echo "runner_limit_bytes=$runner_limit_bytes"
    echo "runner_limit_mb=$runner_limit_mb"
    echo "new_headroom_bytes=$headroom_bytes"
    echo "new_headroom_mb=$headroom_mb"
  } >>"$GITHUB_OUTPUT"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Typecheck heap comparison"
    echo
    echo "| Variante | Heap max | Exit | Peak cgroup memory |"
    echo "|---|---:|---:|---:|"
    echo "| Storica | ${OLD_HEAP_MB} MB | ${old_status} | ${old_peak_mb} MB |"
    echo "| Corrente | ${NEW_HEAP_MB} MB | ${new_status} | ${new_peak_mb} MB |"
    echo
    echo "Limite effettivo runner: ${runner_limit_mb} MB; headroom corrente: ${headroom_mb} MB."
  } >>"$GITHUB_STEP_SUMMARY"
fi

if [ "$old_status" -ne 0 ] || [ "$new_status" -ne 0 ]; then
  echo "::error::Entrambe le varianti devono terminare con exit 0 ($summary)."
  exit 1
fi
if [ "$new_peak_bytes" -ge "$runner_limit_bytes" ]; then
  echo "::error::Il peak di memoria cgroup corrente non resta sotto il limite effettivo ($summary)."
  exit 1
fi
