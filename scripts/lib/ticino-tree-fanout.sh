#!/usr/bin/env bash
# Keep oversized job-section trees below GitHub's 50 MiB tree object limit. The
# public URL remains <section>/<entry>/...; only the Pages shard storage path
# is fanned out into deterministic hash buckets.

TICINO_TREE_FANOUT_DIR="_tree"
TICINO_TREE_FANOUT_TOOL="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/ticino-tree-fanout.mjs"

# Fail closed before replacing a shard with the hashed layout. A Worker that
# predates the hash-bucket router would otherwise keep requesting canonical
# paths and turn every migrated page into a 404.
section_tree_uses_hash_fanout() {
  local result
  if ! result="$(node "$TICINO_TREE_FANOUT_TOOL" is-fanned "$1")"; then
    echo "::error::unable to classify the tree layout for section $1" >&2
    return 2
  fi
  case "$result" in
    true) return 0 ;;
    false) return 1 ;;
    *)
      echo "::error::tree layout classifier returned an invalid result for section $1" >&2
      return 2
      ;;
  esac
}

section_tree_layout() {
  local fanout_rc
  if section_tree_uses_hash_fanout "$1"; then
    # shard-git-helpers.sh is adapted to the corpus and recognizes this
    # compatibility marker. Physical path mapping itself is section-neutral.
    printf 'ticino-hash-v1'
  else
    fanout_rc="$?"
    if [ "$fanout_rc" -ne 1 ]; then return "$fanout_rc"; fi
    printf 'canonical'
  fi
}

section_tree_require_worker_layout() {
  local section_name="$1"
  local section_sub="$2"
  local probe_url="https://frontaliereticino.ch/${section_sub}/?__frontaliere_section_tree_layout=hash-v1&section=${section_name}"
  local headers curl_rc attempt fanout_rc

  if section_tree_uses_hash_fanout "$section_name"; then
    :
  else
    fanout_rc="$?"
    if [ "$fanout_rc" -eq 1 ]; then return 0; fi
    return "$fanout_rc"
  fi

  # A timeout is not evidence that the active Worker lacks hash-v1 routing.
  # Retry only transport failures, with a bounded budget; HTTP responses still
  # go straight to the semantic header check and every exhausted/unknown
  # failure remains fail-closed before the hashed tree is published.
  for attempt in 1 2 3; do
    if headers="$(curl --silent --show-error --fail --head --max-time 20 "$probe_url")"; then
      if printf '%s\n' "$headers" | tr -d '\r' \
          | grep -Eiq '^x-frontaliere-section-tree-layout:[[:space:]]*hash-v1[[:space:]]*$' \
          && printf '%s\n' "$headers" | tr -d '\r' \
            | grep -Eiq "^x-frontaliere-section:[[:space:]]*${section_name}[[:space:]]*$"; then
        return 0
      fi
      # Accept the section-specific response during the generic-probe rollout;
      # the next Worker deployment advertises both headers.
      if printf '%s\n' "$headers" | tr -d '\r' \
          | grep -Eiq "^x-frontaliere-${section_name}-tree-layout:[[:space:]]*hash-v1[[:space:]]*$"; then
        return 0
      fi
      echo "::error::active Worker does not advertise hash-v1 routing for section $section_name at $section_sub; refusing to publish hashed paths" >&2
      return 1
    else
      curl_rc="$?"
      case "$curl_rc" in
        6|7|28|35|52|56|92)
          if [ "$attempt" -lt 3 ]; then
            echo "::warning::${section_name} shard layout probe transport failure for $section_sub (curl $curl_rc; attempt $attempt/3) — retrying in 2s" >&2
            sleep 2
            continue
          fi
          ;;
      esac
      echo "::error::${section_name} shard layout probe failed for $section_sub; refusing to publish hashed paths" >&2
      return 1
    fi
  done
}

# section_tree_fanout_stage <section> <section-root>
#
# The source build stays canonical. This mutates only the temporary checkout
# that will be force-pushed to frontaliere-<section>-<locale>.git.
section_tree_fanout_stage() {
  local section_name="$1"
  local root="$2"
  local fanout_rc

  if section_tree_uses_hash_fanout "$section_name"; then
    :
  else
    fanout_rc="$?"
    if [ "$fanout_rc" -eq 1 ]; then return 0; fi
    return "$fanout_rc"
  fi
  if [ ! -d "$root" ]; then
    echo "::error::$section_name fan-out root is not a directory: $root" >&2
    return 1
  fi

  node "$TICINO_TREE_FANOUT_TOOL" fanout "$root"
}

# section_tree_unfanout_stage <section> <section-root>
#
# Rehydrate the physical Pages representation back to the canonical dist tree.
# Tar artifacts are made from the canonical build and do not need this; the
# clone fallback in rehydrate-section-shards.sh does.
section_tree_unfanout_stage() {
  local section_name="$1"
  local root="$2"
  local fanout_rc

  if section_tree_uses_hash_fanout "$section_name"; then
    :
  else
    fanout_rc="$?"
    if [ "$fanout_rc" -eq 1 ]; then return 0; fi
    return "$fanout_rc"
  fi
  node "$TICINO_TREE_FANOUT_TOOL" unfanout "$root"
}

# Compatibility wrappers for existing callers and operator scripts. New
# section-shard code uses the generic functions above so the two hash-fanned
# sections cannot drift apart.
ticino_tree_require_worker_layout() {
  section_tree_require_worker_layout ticino "$1"
}

ticino_tree_fanout_stage() {
  section_tree_fanout_stage "$@"
}

ticino_tree_unfanout_stage() {
  section_tree_unfanout_stage "$@"
}
