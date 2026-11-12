#!/usr/bin/env bash
# Confronta il vecchio heap interno da 12 GiB con il limite del runner che oggi
# governa `typecheck:gate`. Le due misure girano sullo stesso checkout e runner;
# la cache incrementale viene rimossa prima di ciascuna per mantenere uguale la
# fase osservata.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
SAMPLER="$ROOT/scripts/ci/sample-mem-during.sh"
BUILD_INFO="$ROOT/.cache/tsc/tsconfig.tsbuildinfo"
OLD_HEAP_MB=12288
NEW_HEAP_MB=10240
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

cd "$ROOT"

host_mem_mb="$(awk '/^MemTotal:/ { print int($2 / 1024); exit }' /proc/meminfo 2>/dev/null || true)"
cgroup_bytes=""
if [ -r /sys/fs/cgroup/memory.max ]; then
  cgroup_bytes="$(cat /sys/fs/cgroup/memory.max)"
elif [ -r /sys/fs/cgroup/memory/memory.limit_in_bytes ]; then
  cgroup_bytes="$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)"
fi

if ! [[ "$host_mem_mb" =~ ^[1-9][0-9]*$ ]]; then
  echo "::error::MemTotal del runner non misurabile; confronto heap non verificabile."
  exit 2
fi

runner_limit_mb="$host_mem_mb"
if [[ "$cgroup_bytes" =~ ^[1-9][0-9]*$ ]]; then
  cgroup_mb=$((cgroup_bytes / 1024 / 1024))
  if [ "$cgroup_mb" -gt 0 ] && [ "$cgroup_mb" -lt "$runner_limit_mb" ]; then
    runner_limit_mb="$cgroup_mb"
  fi
fi

run_variant() {
  local label="$1"
  local heap_mb="$2"
  local log="$TMP_DIR/$label.log"
  local status

  rm -f "$BUILD_INFO"
  set +e
  env NODE_OPTIONS="--max-old-space-size=$heap_mb" \
    bash "$SAMPLER" -- npm run typecheck:gate >"$log" 2>&1
  status=$?
  set -e

  cat "$log"
  local peak
  peak="$(sed -nE 's/.*peak_rss_mb=([0-9]+)MB.*/\1/p' "$log" | tail -n 1)"
  if ! [[ "$peak" =~ ^[1-9][0-9]*$ ]]; then
    echo "::error::$label: peak RSS non misurabile."
    return 2
  fi

  printf -v "${label}_status" '%s' "$status"
  printf -v "${label}_peak_mb" '%s' "$peak"
}

old_status=2
old_peak_mb=0
new_status=2
new_peak_mb=0
run_variant old "$OLD_HEAP_MB"
run_variant new "$NEW_HEAP_MB"

headroom_mb=$((runner_limit_mb - new_peak_mb))
summary="old_status=$old_status old_peak_rss_mb=$old_peak_mb new_status=$new_status new_peak_rss_mb=$new_peak_mb runner_limit_mb=$runner_limit_mb new_headroom_mb=$headroom_mb"
echo "[typecheck-heap-comparison] $summary"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "old_status=$old_status"
    echo "old_peak_rss_mb=$old_peak_mb"
    echo "new_status=$new_status"
    echo "new_peak_rss_mb=$new_peak_mb"
    echo "runner_limit_mb=$runner_limit_mb"
    echo "new_headroom_mb=$headroom_mb"
  } >>"$GITHUB_OUTPUT"
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### Typecheck heap comparison"
    echo
    echo "| Variante | Heap max | Exit | Peak RSS |"
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
if [ "$new_peak_mb" -ge "$runner_limit_mb" ]; then
  echo "::error::Il peak RSS corrente non resta sotto il limite del runner ($summary)."
  exit 1
fi
