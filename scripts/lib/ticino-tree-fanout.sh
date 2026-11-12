#!/usr/bin/env bash
# Keep oversized job-section trees below GitHub's 50 MiB tree object limit. The
# public URL remains <section>/<entry>/...; only the Pages shard storage path
# is fanned out into deterministic hash buckets.

TICINO_TREE_FANOUT_DIR="_tree"
TICINO_TREE_FANOUT_TOOL="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/ticino-tree-fanout.mjs"
SECTION_TREE_LAYOUT_REGISTRY_TOOL="${SECTION_TREE_LAYOUT_REGISTRY_TOOL:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/section-tree-layout-registry.mjs}"
SECTION_TREE_LAYOUT_STAGE_TOOL="${SECTION_TREE_LAYOUT_STAGE_TOOL:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/section-tree-layout-stage.mjs}"

section_tree_load_layout_registry() {
  local sections
  if ! sections="$(node "$SECTION_TREE_LAYOUT_REGISTRY_TOOL" sections)"; then
    echo "::error::unable to read the durable section tree layout registry; refusing an unsafe canonical publish" >&2
    return 1
  fi
  if ! jq -e 'type == "array" and all(.[]; type == "string")' >/dev/null <<< "$sections"; then
    echo "::error::section tree layout registry returned an invalid section list" >&2
    return 1
  fi
  SECTION_TREE_LAYOUT_SECTIONS_JSON="$sections"
  export SECTION_TREE_LAYOUT_SECTIONS_JSON
}

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
    case "$1" in
      ticino|zurigo) printf '%s-hash-v1' "$1" ;;
      *) printf 'ticino-hash-v1' ;;
    esac
  else
    fanout_rc="$?"
    if [ "$fanout_rc" -ne 1 ]; then return "$fanout_rc"; fi
    printf 'canonical'
  fi
}

# Manifest metadata describes the physical layout by section. Keep the
# historical marker for section-shard helpers separate from this self-named
# receipt so dynamically fanned sections can be recorded without new code.
section_tree_manifest_layout() {
  local fanout_rc
  if section_tree_uses_hash_fanout "$1"; then
    printf '%s-hash-v1' "$1"
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
  local headers curl_rc attempt fanout_rc max_attempts=18

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
  for ((attempt = 1; attempt <= max_attempts; attempt += 1)); do
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
      if [ "$attempt" -lt "$max_attempts" ]; then
        echo "::warning::active Worker does not yet advertise hash-v1 for $section_name at $section_sub (attempt $attempt/$max_attempts); waiting for registry propagation" >&2
        sleep 20
        continue
      fi
      echo "::error::active Worker does not advertise hash-v1 routing for section $section_name at $section_sub; refusing to publish hashed paths" >&2
      return 1
    else
      curl_rc="$?"
      case "$curl_rc" in
        6|7|22|28|35|52|56|92)
          if [ "$attempt" -lt "$max_attempts" ]; then
            echo "::warning::${section_name} shard layout probe not ready for $section_sub (curl $curl_rc; attempt $attempt/$max_attempts) — retrying in 20s" >&2
            sleep 20
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

# section_tree_measure_unfanned_pct <stage> <section> <sub> <filesystem|index> <label>
# A scratch index presents the current section in canonical form. Git's
# largest-tree report therefore measures the bytes that would be published
# without fan-out, including on a fast overlay whose remote index is already
# hash-fanned.
section_tree_measure_unfanned_pct() {
  local stage="$1" section_name="$2" sub="$3" mode="$4" label="${5:-$section_name shard}"
  local work index_path tree report pct
  work="$(mktemp -d "${TMPDIR:-/tmp}/section-tree-measure.XXXXXX")" || return 1
  index_path="$work/index"
  : > "$index_path"
  if [ "$mode" = filesystem ]; then
    if ! GIT_INDEX_FILE="$index_path" git -C "$stage" read-tree --empty \
       || ! GIT_INDEX_FILE="$index_path" git -C "$stage" add -A -- "$sub"; then
      echo "::error::$label: could not stage the canonical section tree for measurement" >&2
      rm -rf "$work"
      return 1
    fi
  elif [ "$mode" = index ]; then
    if ! cp "$(git -C "$stage" rev-parse --absolute-git-dir)/index" "$index_path"; then
      echo "::error::$label: section tree index is unavailable for measurement" >&2
      rm -rf "$work"
      return 1
    fi
    if ! GIT_INDEX_FILE="$index_path" node "$TICINO_TREE_FANOUT_TOOL" \
      index-layout "$stage" "$section_name" "$sub" canonical >/dev/null; then
      echo "::error::$label: could not normalize the section index for canonical measurement" >&2
      rm -rf "$work"
      return 1
    fi
  else
    echo "::error::$label: unsupported measurement mode '$mode'" >&2
    rm -rf "$work"
    return 1
  fi

  if ! tree="$(GIT_INDEX_FILE="$index_path" git -C "$stage" write-tree --missing-ok)"; then
    echo "::error::$label: could not write the canonical measurement tree" >&2
    rm -rf "$work"
    return 1
  fi
  if ! report="$(SHARD_REMOTE_TREE_REJECT_BYTES=999999999999 shard_report_largest_tree "$stage" "$tree" "$label" 2>&1)"; then
    printf '%s\n' "$report" >&2
    rm -rf "$work"
    return 1
  fi
  printf '%s\n' "$report" >&2
  pct="$(sed -nE 's/.*\(([0-9]+([.][0-9]+)?)% of the remote tree limit\).*/\1/p' <<< "$report" | head -n 1)"
  rm -rf "$work"
  if [ -z "$pct" ]; then
    echo "::error::$label: could not read the un-fanned tree percentage" >&2
    return 1
  fi
  printf '%s' "$pct"
}

# section_tree_evaluate_and_apply <section> <locale> <stage> <sub> <filesystem|index> <label>
# The Node stage tool reads the latest registry, decides, persists add-only
# state, waits for the live Worker, and then fans the temporary tree/index.
# Its JSON result is kept separate from the GitHub annotation log lines.
section_tree_evaluate_and_apply() {
  local section_name="$1" locale="$2" stage="$3" sub="$4" mode="$5" label="$6"
  local pct result
  if ! pct="$(section_tree_measure_unfanned_pct "$stage" "$section_name" "$sub" "$mode" "$label")"; then
    return 1
  fi
  if ! result="$(node "$SECTION_TREE_LAYOUT_STAGE_TOOL" stage \
      --section "$section_name" --locale "$locale" --pct "$pct" \
      --stage "$stage" --sub "$sub" --mode "$mode" \
      --threshold "${FANOUT_AUTO_THRESHOLD_PCT:-40}")"; then
    return 1
  fi
  SECTION_TREE_LAYOUT_MOVE_COUNT="$(jq -er '.moved | numbers' <<< "$result")" || return 1
  SECTION_TREE_LAYOUT_SECTIONS_JSON="$(jq -cer '.sections | arrays' <<< "$result")" || return 1
  SECTION_TREE_LAYOUT_DECISION="$(jq -er '.decision | strings' <<< "$result")" || return 1
  export SECTION_TREE_LAYOUT_MOVE_COUNT SECTION_TREE_LAYOUT_SECTIONS_JSON SECTION_TREE_LAYOUT_DECISION
}

# section_tree_unfanout_stage <section> <section-root>
#
# Rehydrate the physical Pages representation back to the canonical dist tree.
# Tar artifacts are made from the canonical build and do not need this; the
# clone fallback in rehydrate-section-shards.sh does.
section_tree_unfanout_stage() {
  local root="$2"
  # Physical shards are self-describing. Rehydrate may run without R2 access,
  # so use the cloned tree's _tree directory instead of requiring a registry read.
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
