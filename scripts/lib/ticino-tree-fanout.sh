#!/usr/bin/env bash
# Keep the physical tree of the Ticino section below GitHub's 50 MiB tree
# object limit. The public URL remains <section>/<entry>/...; only the Pages
# shard storage path is fanned out into deterministic hash buckets.

TICINO_TREE_FANOUT_DIR="_tree"
TICINO_TREE_FANOUT_TOOL="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/ticino-tree-fanout.mjs"

# Fail closed before replacing a shard with the hashed layout. A Worker that
# predates the hash-bucket router would otherwise keep requesting the old
# first-two-character paths and turn every migrated page into a 404.
ticino_tree_require_worker_layout() {
  local section_sub="$1"
  local probe_url="https://frontaliereticino.ch/${section_sub}/?__frontaliere_ticino_tree_layout=hash-v1"
  local headers

  if ! headers="$(curl --silent --show-error --fail --head --max-time 20 "$probe_url")"; then
    echo "::error::Ticino shard layout probe failed for $section_sub; refusing to publish hashed paths" >&2
    return 1
  fi
  if ! printf '%s\n' "$headers" | tr -d '\r' | grep -Eiq '^x-frontaliere-ticino-tree-layout:[[:space:]]*hash-v1[[:space:]]*$'; then
    echo "::error::active Worker does not advertise Ticino hash-v1 routing for $section_sub; refusing to publish hashed paths" >&2
    return 1
  fi
}

# ticino_tree_fanout_stage <section> <section-root>
#
# The source build stays canonical. This mutates only the temporary checkout
# that will be force-pushed to frontaliere-ticino-<locale>.git.
ticino_tree_fanout_stage() {
  local section_name="$1"
  local root="$2"

  [ "$section_name" = ticino ] || return 0
  if [ ! -d "$root" ]; then
    echo "::error::Ticino fan-out root is not a directory: $root" >&2
    return 1
  fi

  node "$TICINO_TREE_FANOUT_TOOL" fanout "$root"
}

# ticino_tree_unfanout_stage <section> <section-root>
#
# Rehydrate the physical Pages representation back to the canonical dist tree.
# Tar artifacts are made from the canonical build and do not need this; the
# clone fallback in rehydrate-section-shards.sh does.
ticino_tree_unfanout_stage() {
  local section_name="$1"
  local root="$2"

  [ "$section_name" = ticino ] || return 0
  node "$TICINO_TREE_FANOUT_TOOL" unfanout "$root"
}
