#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# scripts/lib/shard-git-helpers.sh — shared git-plumbing helpers for the
# section/locale/article shard push scripts (push-section-shard.sh,
# push-locale-shard.sh, compact-article-shard-history.sh). SOURCED, not
# executed (the standard shared-shell-library `source` convention).
#
# Issue #4881 (shard safety rails). Extracted because push-section-shard.sh
# and push-locale-shard.sh had two independent, byte-for-byte-duplicated
# copies of every function below (AGENTS.md #6) — fixing the bugs in one
# copy without extracting would have left the sibling's copy silently
# unfixed (exactly the class of drift #6 exists to prevent).
#
# shard_read_counter fixes a real, previously-live bug: both scripts read
# their `.shard-deploys` / `.shard-filecount` bookkeeping counters via
# `[ -f "$stage/.shard-deploys" ] && cat "$stage/.shard-deploys"` against a
# `git clone --filter=blob:none --no-checkout` clone. `--no-checkout` means
# `git help clone`'s "No checkout of HEAD is performed after the clone is
# complete" applies literally and universally (every transport) — NO
# working-tree file is EVER materialized on that clone, so the `[ -f ... ]`
# check was ALWAYS false. Concretely: `dcount` was always read as 0, so
# SHARD_HISTORY_CAP's orphan-flatten (meant to bound `.git` growth) has
# never actually fired for any section/locale shard, and `prev_n` (fetched
# via raw.githubusercontent.com, not from this clone at all) was fragile
# for a different reason (unauthenticated 60/hr rate limit + CDN staleness).
# `git show HEAD:<path>` reads the blob straight from the object graph
# regardless of checkout state — the pattern already proven correct in
# scripts/lib/push-article-shard-incremental.sh:185.
# ─────────────────────────────────────────────────────────────────────────────

# shard_read_counter <clone_dir> <path-in-repo>
# Prints the numeric content of <path> at HEAD in <clone_dir>, or 0 if the
# path is absent, the clone has no commits yet, or the content isn't numeric.
shard_read_counter() {
  local dir="$1" path="$2" val
  val="$(git -C "$dir" show "HEAD:$path" 2>/dev/null || echo 0)"
  # Older section pushes wrote the `wc -l` padding into this marker. Keep
  # reading those trees while all new writes use the canonical decimal form.
  val="${val//[[:space:]]/}"
  [[ "$val" =~ ^[0-9]+$ ]] || val=0
  printf '%s' "$val"
}

# shard_delta_manifest_sidecar <locale>
# The build manifest lives outside dist/. Delta mode carries a filtered,
# per-shard snapshot in the published tree so the next push has an atomic
# previous-manifest/base-tree pair. Full mode carries it only when the
# advisory verifier is enabled, so the canary compares the complete tree that
# delta would publish and primes the next delta run without changing payloads.
shard_delta_manifest_sidecar() {
  local locale="$1"
  printf '.deploy-manifest/v1/%s.jsonl' "$locale"
}

# shard_manifest_snapshot <current_manifest> <scope> <source_root> <tool> <out_dir>
# Validates the current build manifest and writes the filtered snapshot used by
# a full fallback as well as by a successful delta. The Node tool owns the
# JSONL contract; bash only decides whether the result is safe to publish.
shard_manifest_snapshot() {
  local current="$1" scope="$2" source_root="$3" tool="$4" out_dir="$5"
  mkdir -p "$out_dir"
  if node "$tool" \
      --current="$current" \
      --scope="$scope" \
      --source-root="$source_root" \
      --out="$out_dir" \
      --snapshot-only; then
    return 0
  fi
  SHARD_DELTA_REASON='current manifest invalid or payload missing'
  return 1
}

# shard_delta_clone_and_prepare <stage> <repo> <current_manifest>
#   <sidecar_path> <scope> <source_root> <tool> <out_dir> <history_cap> <label>
# Clone the remote without checking out blobs, validate both manifest sides,
# and seed the index from HEAD. Return 0 only when the caller may apply a delta.
# Normal fallback reasons return 1 and are exposed in SHARD_DELTA_REASON.
shard_delta_clone_and_prepare() {
  local stage="$1" repo="$2" current="$3" sidecar="$4" scope="$5"
  local source_root="$6" tool="$7" out_dir="$8" history_cap="$9" label="${10:-shard}"
  local clone_err previous_manifest
  SHARD_DELTA_REASON=''
  SHARD_DELTA_DCOUNT=0
  SHARD_DELTA_PREV_N=0

  rm -rf "$stage"
  mkdir -p "$stage" "$out_dir"
  clone_err="$(mktemp)"
  if ! git clone -q --depth 1 --filter=blob:none --no-checkout "$repo" "$stage" 2>"$clone_err"; then
    echo "::warning::$label delta clone failure: $(cat "$clone_err")" >&2
    rm -f "$clone_err"
    SHARD_DELTA_REASON='clone failure'
    return 1
  fi
  rm -f "$clone_err"

  if ! git -C "$stage" rev-parse -q --verify HEAD >/dev/null 2>&1; then
    echo "$label delta: remote is empty — full fallback" >&2
    SHARD_DELTA_REASON='first push / remote empty'
    return 1
  fi

  SHARD_DELTA_DCOUNT="$(shard_read_counter "$stage" .shard-deploys)"
  SHARD_DELTA_PREV_N="$(shard_read_counter "$stage" .shard-filecount)"
  if [ "$SHARD_DELTA_DCOUNT" -ge "$history_cap" ]; then
    SHARD_DELTA_REASON="history cap $history_cap reached"
    return 1
  fi
  if [ ! -s "$current" ]; then
    SHARD_DELTA_REASON='current manifest missing'
    return 1
  fi

  previous_manifest="$out_dir/previous.jsonl"
  if ! git -C "$stage" show "HEAD:$sidecar" > "$previous_manifest" 2>/dev/null; then
    SHARD_DELTA_REASON='previous manifest missing'
    return 1
  fi

  if ! node "$tool" \
      --current="$current" \
      --previous="$previous_manifest" \
      --scope="$scope" \
      --source-root="$source_root" \
      --out="$out_dir"; then
    SHARD_DELTA_REASON='current or previous manifest invalid'
    return 1
  fi

  if ! git -C "$stage" read-tree HEAD; then
    SHARD_DELTA_REASON='remote index initialization failed'
    return 1
  fi
  return 0
}

# shard_delta_add_file <stage> <source_file> <target_path>
# Compare against the remote-seeded index and update only when the source blob
# is new/different. This is the key distinction from `git add -A` on an empty
# no-checkout working tree.
shard_delta_add_file() {
  local stage="$1" source="$2" target="$3" old_oid new_oid blob_oid
  if [ "${source#/}" = "$source" ]; then source="$(pwd)/$source"; fi
  [ -f "$source" ] || return 1
  old_oid="$(git -C "$stage" -c core.quotePath=false ls-files --stage -z -- "$target" 2>/dev/null \
    | perl -0ne 'if (/^[^ ]+ ([0-9a-f]+) /) { print $1; exit }')"
  new_oid="$(git -C "$stage" hash-object --path="$target" "$source")" || return 1
  if [ "$old_oid" = "$new_oid" ]; then
    SHARD_DELTA_REUSED_FILES=$((SHARD_DELTA_REUSED_FILES + 1))
    return 0
  fi
  blob_oid="$(git -C "$stage" hash-object -w --path="$target" "$source")" || return 1
  git -C "$stage" update-index --add --cacheinfo "100644,$blob_oid,$target" || return 1
  SHARD_DELTA_CHANGED_FILES=$((SHARD_DELTA_CHANGED_FILES + 1))
  SHARD_DELTA_CONTENT_CHANGES=$((SHARD_DELTA_CONTENT_CHANGES + 1))
  return 0
}

# shard_delta_add_text <stage> <target_path> <content> [count_as_content]
shard_delta_add_text() {
  local stage="$1" target="$2" content="$3" count_change="${4:-1}"
  local old_oid new_oid blob_oid
  old_oid="$(git -C "$stage" -c core.quotePath=false ls-files --stage -z -- "$target" 2>/dev/null \
    | perl -0ne 'if (/^[^ ]+ ([0-9a-f]+) /) { print $1; exit }')"
  new_oid="$(printf '%s' "$content" | git -C "$stage" hash-object --stdin --path="$target")" || return 1
  if [ "$old_oid" = "$new_oid" ]; then return 0; fi
  blob_oid="$(printf '%s' "$content" | git -C "$stage" hash-object -w --stdin --path="$target")" || return 1
  git -C "$stage" update-index --add --cacheinfo "100644,$blob_oid,$target" || return 1
  if [ "$count_change" = 1 ]; then
    SHARD_DELTA_CONTENT_CHANGES=$((SHARD_DELTA_CONTENT_CHANGES + 1))
  fi
  return 0
}

# shard_count_files <directory>
# Counts regular files without letting a filename's bytes affect the count or
# the output format. The latter matters for `.shard-filecount`: full and delta
# must commit the same canonical decimal marker, not two `wc` spellings.
shard_count_files() {
  local dir="$1"
  find "$dir" -type f -print0 | tr -cd '\0' | wc -c | tr -d '[:space:]'
}

# shard_index_has_content_changes <stage>
# A NUL-safe equivalent of the old quiet diff check. `--name-only -z` keeps the
# path transport lossless even though the result is consumed only as a boolean.
shard_index_has_content_changes() {
  local stage="$1"
  git -C "$stage" -c core.quotePath=false diff --cached --name-only -z -- \
    . ':!.shard-deploys' ':!.shard-filecount' \
    | perl -0ne '$found = 1; END { exit($found ? 0 : 1) }'
}

# shard_delta_remove_stale_payload_paths <stage> <scope_prefix>
#   <payload_file_list> <removed_file> [require_tombstones]
# The seeded index is the previous inventory. Remove every tracked payload
# path under the scope that is absent from the current payload list, including
# unmanifested files and children of a still-live manifest page. Root service
# files are handled separately by the caller and are never part of this set.
# One raw parser emits all deletion records and, by default, cross-checks every
# manifest tombstone before one index-info update. The advisory verifier passes
# 0 when no previous sidecar exists and derives deletions from the old index.
shard_delta_remove_stale_payload_paths() {
  local stage="$1" scope_prefix="$2" payload_file_list="$3" removed_file="$4"
  local require_tombstones="${5:-1}"
  local work index_dump delete_info count_file missing_file removed_count
  [ -f "$payload_file_list" ] || return 1
  [ -f "$removed_file" ] || return 1
  work="$(mktemp -d)" || return 1
  index_dump="$work/index.dump"
  delete_info="$work/delete.info"
  count_file="$work/count"
  missing_file="$work/missing-tombstones"
  if [ -n "$scope_prefix" ]; then
    if ! git -C "$stage" -c core.quotePath=false ls-files --stage -z -- "$scope_prefix/" > "$index_dump"; then
      rm -rf "$work"
      return 1
    fi
  elif ! git -C "$stage" -c core.quotePath=false ls-files --stage -z > "$index_dump"; then
    rm -rf "$work"
    return 1
  fi
  if ! perl -e '
      use strict;
      use warnings;

      my ($index_file, $payload_file, $removed_file, $scope_prefix,
          $delete_info_file, $count_file, $missing_file) = @ARGV;
      my (%live, %removed, %found);
      my $nul = "\0";

      sub read_nul_records {
        my ($file, $callback) = @_;
        open my $handle, "<:raw", $file or die "open $file: $!";
        local $/ = $nul;
        while (defined(my $record = <$handle>)) {
          chop $record;
          next if $record eq q{};
          $callback->($record);
        }
        close $handle or die "close $file: $!";
      }

      read_nul_records($payload_file, sub {
        my ($relative) = @_;
        my $target = $scope_prefix eq q{} ? $relative : "$scope_prefix/$relative";
        $live{$target} = 1;
      });
      read_nul_records($removed_file, sub {
        my ($path) = @_;
        $path =~ s{/+\z}{};
        $removed{$path} = 1 if $path ne q{};
      });

      open my $delete_handle, ">:raw", $delete_info_file or die "open $delete_info_file: $!";
      open my $missing_handle, ">:raw", $missing_file or die "open $missing_file: $!";
      my $matched = 0;

      my $mark_removed_candidates = sub {
        my ($path) = @_;
        my $candidate = $path;
        $found{$candidate} = 1 if exists $removed{$candidate};
        if ($candidate =~ s{/index\.html\z}{}) {
          $found{$candidate} = 1 if exists $removed{$candidate};
        } elsif ($candidate =~ s{\.html\z}{}) {
          $found{$candidate} = 1 if exists $removed{$candidate};
        }
        while ($candidate =~ s{/[^/]*\z}{}) {
          $found{$candidate} = 1 if exists $removed{$candidate};
        }
      };

      read_nul_records($index_file, sub {
        my ($record) = @_;
        my $tab = index($record, "\t");
        die "index record without path separator" if $tab < 0;
        my $target = substr($record, $tab + 1);
        my $is_service = $target eq q{.nojekyll}
          || $target eq q{CNAME}
          || $target eq q{404.html}
          || $target eq q{index.html}
          || $target eq q{.shard-deploys}
          || $target eq q{.shard-filecount}
          || index($target, q{.deploy-manifest/}) == 0
          || ($scope_prefix ne q{} && $target eq "$scope_prefix.html");
        return if $is_service || exists $live{$target};
        print {$delete_handle} "0 0000000000000000000000000000000000000000\t$target$nul";
        $matched += 1;
        $mark_removed_candidates->($target);
      });
      close $delete_handle or die "close $delete_info_file: $!";

      for my $path (keys %removed) {
        print {$missing_handle} "$path$nul" unless exists $found{$path};
      }
      close $missing_handle or die "close $missing_file: $!";
      open my $count_handle, ">:raw", $count_file or die "open $count_file: $!";
      print {$count_handle} "$matched\n";
      close $count_handle or die "close $count_file: $!";
    ' "$index_dump" "$payload_file_list" "$removed_file" "$scope_prefix" \
      "$delete_info" "$count_file" "$missing_file"; then
    rm -rf "$work"
    return 1
  fi
  if [ "$require_tombstones" = 1 ] && [ -s "$missing_file" ]; then
    SHARD_DELTA_REASON='manifest tombstone cross-check failed'
    rm -rf "$work"
    return 1
  fi
  removed_count="$(cat "$count_file")"
  if [ "$removed_count" -gt 0 ] && ! git -C "$stage" -c core.quotePath=false update-index -z --index-info < "$delete_info"; then
    rm -rf "$work"
    return 1
  fi
  SHARD_DELTA_REMOVED_FILES=$((SHARD_DELTA_REMOVED_FILES + removed_count))
  SHARD_DELTA_CONTENT_CHANGES=$((SHARD_DELTA_CONTENT_CHANGES + removed_count))
  rm -rf "$work"
  return 0
}

# shard_delta_remove_file <stage> <target_path>
shard_delta_remove_file() {
  local stage="$1" target="$2"
  if [ "$(git -C "$stage" -c core.quotePath=false ls-files --stage -z -- "$target" 2>/dev/null \
      | wc -c | tr -d '[:space:]')" -gt 0 ]; then
    git -C "$stage" -c core.quotePath=false update-index --force-remove -- "$target" || return 1
    SHARD_DELTA_REMOVED_FILES=$((SHARD_DELTA_REMOVED_FILES + 1))
    SHARD_DELTA_CONTENT_CHANGES=$((SHARD_DELTA_CONTENT_CHANGES + 1))
  fi
  return 0
}

# shard_delta_apply_source_tree <stage> <source_root> <target_prefix>
#   <changed_file_list> <unmanifested_file_list> <payload_file_list>
# Manifest-covered paths arrive from shard-manifest-delta.mjs as a changed
# file list; all other payload paths arrive as a second list. Unchanged live
# paths stay as index entries pointing at the remote blobs and are never
# materialized. The two lists are joined, hashed in one batch, compared with
# one index dump, and applied with one index-info stream: there is no
# per-payload-file git process here.
shard_delta_apply_source_tree() {
  local stage="$1" source_root="$2" target_prefix="$3"
  local changed_file_list="$4" unmanifested_file_list="$5" payload_file_list="$6"
  local work candidate_list metadata source_paths index_dump hashes
  local changed_sources index_info count_file source_count changed_count
  [ -d "$source_root" ] || return 1
  source_root="$(cd "$source_root" && pwd)" || return 1
  [ -f "$changed_file_list" ] || return 1
  [ -f "$unmanifested_file_list" ] || return 1
  [ -f "$payload_file_list" ] || return 1
  SHARD_DELTA_SOURCE_FILES=0
  SHARD_DELTA_CHANGED_FILES=0
  SHARD_DELTA_REUSED_FILES=0
  SHARD_DELTA_REMOVED_FILES=0
  SHARD_DELTA_CONTENT_CHANGES=0
  work="$(mktemp -d)" || return 1
  candidate_list="$work/candidates.list"
  metadata="$work/metadata.list"
  source_paths="$work/source-paths.list"
  index_dump="$work/index.dump"
  hashes="$work/hashes"
  changed_sources="$work/changed-sources.list"
  index_info="$work/index.info.list"
  count_file="$work/counts"

  if ! cp "$changed_file_list" "$candidate_list" \
    || ! cat "$unmanifested_file_list" >> "$candidate_list"; then
    rm -rf "$work"
    return 1
  fi
  source_count="$(tr -cd '\0' < "$payload_file_list" | wc -c | tr -d '[:space:]')"
  SHARD_DELTA_SOURCE_FILES="${source_count:-0}"

  if [ -s "$candidate_list" ]; then
    # Keep source and target paths as raw byte strings. The metadata stream is
    # two NUL-terminated fields per candidate; unlike whitespace/tab parsing,
    # this preserves Unicode, spaces, apostrophes, and embedded newlines.
    if ! perl -e '
        use strict;
        use warnings;
        my ($root, $prefix, $candidate_file, $metadata_file, $source_file) = @ARGV;
        open my $input, "<:raw", $candidate_file or die "open $candidate_file: $!";
        open my $metadata, ">:raw", $metadata_file or die "open $metadata_file: $!";
        open my $sources, ">:raw", $source_file or die "open $source_file: $!";
        local $/ = "\0";
        while (defined(my $relative = <$input>)) {
          chop $relative;
          next if $relative eq q{};
          my $source = "$root/$relative";
          my $target = $prefix eq q{} ? $relative : "$prefix/$relative";
          print {$metadata} "$source\0$target\0";
          # `git hash-object --stdin-paths` has no NUL switch: it consumes one
          # literal path per line. Keep this bridge unquoted and byte-for-byte;
          # the NUL streams remain authoritative everywhere else.
          print {$sources} "$source\n";
        }
        close $input or die "close $candidate_file: $!";
        close $metadata or die "close $metadata_file: $!";
        close $sources or die "close $source_file: $!";
      ' "$source_root" "$target_prefix" "$candidate_list" "$metadata" "$source_paths"; then
      rm -rf "$work"
      return 1
    fi
    if ! git -C "$stage" -c core.quotePath=false ls-files --stage -z > "$index_dump"; then
      rm -rf "$work"
      return 1
    fi
    if ! git -C "$stage" hash-object --stdin-paths < "$source_paths" > "$hashes"; then
      rm -rf "$work"
      return 1
    fi
    if ! perl -e '
        use strict;
        use warnings;
        my ($index_file, $metadata_file, $hash_file, $changed_file,
            $index_info_file, $count_file) = @ARGV;
        my %old_oid;
        my $nul = "\0";

        open my $index, "<:raw", $index_file or die "open $index_file: $!";
        {
          local $/ = $nul;
          while (defined(my $record = <$index>)) {
            chop $record;
            next if $record eq q{};
            my $tab = index($record, "\t");
            die "index record without path separator" if $tab < 0;
            my $header = substr($record, 0, $tab);
            my $path = substr($record, $tab + 1);
            my (undef, $oid) = split / /, $header, 3;
            $old_oid{$path} = $oid;
          }
        }
        close $index or die "close $index_file: $!";

        open my $metadata, "<:raw", $metadata_file or die "open $metadata_file: $!";
        my @fields;
        {
          local $/ = $nul;
          while (defined(my $field = <$metadata>)) {
            chop $field;
            push @fields, $field;
          }
        }
        close $metadata or die "close $metadata_file: $!";

        open my $hashes, "<:raw", $hash_file or die "open $hash_file: $!";
        my @oids;
        {
          local $/ = "\n";
          @oids = <$hashes>;
        }
        close $hashes or die "close $hash_file: $!";
        chomp @oids;
        die "metadata/hash count mismatch" if @fields / 2 != @oids;

        open my $changed, ">:raw", $changed_file or die "open $changed_file: $!";
        open my $index_info, ">:raw", $index_info_file or die "open $index_info_file: $!";
        my ($changed_count, $reused_count) = (0, 0);
        for (my $i = 0; $i < @oids; $i++) {
          my $source = $fields[$i * 2];
          my $target = $fields[$i * 2 + 1];
          my $oid = $oids[$i];
          if (defined $old_oid{$target} && $old_oid{$target} eq $oid) {
            $reused_count += 1;
          } else {
            # See the source-path bridge above: hash-object reads literal LF
            # records, while the index-info stream below is NUL-delimited.
            print {$changed} "$source\n";
            print {$index_info} "100644 $oid\t$target$nul";
            $changed_count += 1;
          }
        }
        close $changed or die "close $changed_file: $!";
        close $index_info or die "close $index_info_file: $!";
        open my $counts, ">:raw", $count_file or die "open $count_file: $!";
        print {$counts} "$changed_count $reused_count\n";
        close $counts or die "close $count_file: $!";
      ' "$index_dump" "$metadata" "$hashes" "$changed_sources" "$index_info" "$count_file"; then
      rm -rf "$work"
      return 1
    fi
    read -r changed_count source_count < "$count_file"
    if [ "$changed_count" -gt 0 ]; then
      if ! git -C "$stage" hash-object -w --stdin-paths < "$changed_sources" >/dev/null; then
        rm -rf "$work"
        return 1
      fi
      if ! git -C "$stage" -c core.quotePath=false update-index -z --index-info < "$index_info"; then
        rm -rf "$work"
        return 1
      fi
    fi
    SHARD_DELTA_CHANGED_FILES="$changed_count"
    SHARD_DELTA_CONTENT_CHANGES="$changed_count"
  fi
  SHARD_DELTA_REUSED_FILES=$((SHARD_DELTA_SOURCE_FILES - SHARD_DELTA_CHANGED_FILES))
  rm -rf "$work"
  return 0
}

# shard_delta_remove_manifest_sidecars <stage>
# The full overlay starts from an empty working tree, so it removes stale
# sidecars. A verification plan must model that same result before adding the
# one current snapshot (when a manifest is available).
shard_delta_remove_manifest_sidecars() {
  local stage="$1" path
  while IFS= read -r -d '' path; do
    [ -n "$path" ] || continue
    git -C "$stage" -c core.quotePath=false update-index --force-remove -- "$path" || return 1
  done < <(git -C "$stage" -c core.quotePath=false ls-files -z --name-only -- '.deploy-manifest/' 2>/dev/null)
  return 0
}

# shard_delta_verify_prepare <stage> <repo> <current_manifest> <sidecar>
#   <scope> <source_root> <tool> <out_dir> <history_cap> <label>
# Build a delta index without ever pushing it. This is advisory-only plumbing
# for SHARD_PUSH_VERIFY=1 in full mode. If the remote has no sidecar yet (the
# normal first canary after the flag was introduced), the verifier falls back
# to hashing the complete payload in one batch and lets the tombstone pass
# derive removals from the previous index. That still proves the tree contract
# without changing delta mode's stricter sidecar precondition.
shard_delta_verify_prepare() {
  local stage="$1" repo="$2" current="$3" sidecar="$4" scope="$5"
  local source_root="$6" tool="$7" out_dir="$8" history_cap="$9" label="${10:-shard}"
  local clone_err previous_manifest payload_root manifest_ready=0 require_tombstones=0
  local current_ok=0
  SHARD_VERIFY_REASON=''
  SHARD_VERIFY_SNAPSHOT=''
  SHARD_VERIFY_BASE_TREE=''
  SHARD_VERIFY_DCOUNT=0
  SHARD_VERIFY_PREV_N=0

  rm -rf "$stage" "$out_dir"
  if ! mkdir -p "$stage" "$out_dir"; then
    SHARD_VERIFY_REASON='verification staging directory unavailable'
    return 1
  fi

  # A valid current manifest gives us the same filtered payload lists as delta
  # mode and a sidecar snapshot to compare/publish. Missing/invalid manifests
  # remain advisory: the source payload is still sufficient to verify tree
  # equivalence, even though delta mode itself will fall back to full.
  if [ -s "$current" ] && shard_manifest_snapshot "$current" "$scope" "$source_root" "$tool" "$out_dir"; then
    manifest_ready=1
    current_ok=1
    SHARD_VERIFY_SNAPSHOT="$out_dir/snapshot.jsonl"
  fi
  payload_root="$source_root/$scope"
  if [ ! -d "$payload_root" ]; then
    SHARD_VERIFY_REASON='verification payload root missing'
    return 1
  fi
  if [ "$manifest_ready" != 1 ]; then
    rm -rf "$out_dir"
    if ! mkdir -p "$out_dir"; then
      SHARD_VERIFY_REASON='verification output directory unavailable'
      return 1
    fi
    if ! ( cd "$payload_root" && find . -type f -print0 | perl -0pe 's#^\./##' ) > "$out_dir/payload-files.txt"; then
      SHARD_VERIFY_REASON='verification payload listing failed'
      return 1
    fi
    cp "$out_dir/payload-files.txt" "$out_dir/changed-files.txt"
    : > "$out_dir/unmanifested-files.txt"
    : > "$out_dir/removed.txt"
  fi

  clone_err="$(mktemp)"
  if ! git clone -q --depth 1 --filter=blob:none --no-checkout "$repo" "$stage" 2>"$clone_err"; then
    echo "::warning::$label verification clone failure: $(cat "$clone_err")" >&2
    rm -f "$clone_err"
    SHARD_VERIFY_REASON='verification clone failure'
    return 1
  fi
  rm -f "$clone_err"

  if git -C "$stage" rev-parse -q --verify HEAD >/dev/null 2>&1; then
    if ! SHARD_VERIFY_BASE_TREE="$(git -C "$stage" rev-parse 'HEAD^{tree}')"; then
      SHARD_VERIFY_REASON='verification base tree unavailable'
      return 1
    fi
    SHARD_VERIFY_DCOUNT="$(shard_read_counter "$stage" .shard-deploys)"
    SHARD_VERIFY_PREV_N="$(shard_read_counter "$stage" .shard-filecount)"
    # A full push flattens at the cap. Model its reset counters in the plan so
    # the comparison is about the published tree, not history bookkeeping.
    if [ "$SHARD_VERIFY_DCOUNT" -ge "$history_cap" ]; then SHARD_VERIFY_DCOUNT=0; fi
    if ! git -C "$stage" read-tree HEAD; then
      SHARD_VERIFY_REASON='verification index initialization failed'
      return 1
    fi
    previous_manifest="$out_dir/previous.jsonl"
    if [ "$current_ok" = 1 ] && git -C "$stage" show "HEAD:$sidecar" > "$previous_manifest" 2>/dev/null \
      && node "$tool" \
        --current="$current" \
        --previous="$previous_manifest" \
        --scope="$scope" \
        --source-root="$source_root" \
        --out="$out_dir"; then
      require_tombstones=1
    else
      # No previous sidecar is expected while full mode is still the default.
      # The payload list is the conservative baseline: every source file is
      # hashed and stale payload paths are treated as tombstones.
      cp "$out_dir/payload-files.txt" "$out_dir/changed-files.txt"
      : > "$out_dir/unmanifested-files.txt"
      : > "$out_dir/removed.txt"
      require_tombstones=0
    fi
  else
    # Empty bare remotes are a valid first-push case. Keep an empty index and
    # compare the full push against an all-add delta plan.
    if ! git -C "$stage" read-tree --empty; then
      SHARD_VERIFY_REASON='verification empty index initialization failed'
      return 1
    fi
    if ! SHARD_VERIFY_BASE_TREE="$(git -C "$stage" mktree < /dev/null)"; then
      SHARD_VERIFY_REASON='verification empty base tree unavailable'
      return 1
    fi
    cp "$out_dir/payload-files.txt" "$out_dir/changed-files.txt"
    : > "$out_dir/unmanifested-files.txt"
    : > "$out_dir/removed.txt"
    require_tombstones=0
  fi

  if ! shard_delta_apply_source_tree \
      "$stage" "$payload_root" "$scope" \
      "$out_dir/changed-files.txt" \
      "$out_dir/unmanifested-files.txt" \
      "$out_dir/payload-files.txt"; then
    SHARD_VERIFY_REASON='verification source hashing failed'
    return 1
  fi
  if ! shard_delta_remove_stale_payload_paths \
      "$stage" "$scope" "$out_dir/payload-files.txt" "$out_dir/removed.txt" "$require_tombstones"; then
    SHARD_VERIFY_REASON="${SHARD_DELTA_REASON:-verification tombstone application failed}"
    return 1
  fi
  return 0
}

# shard_delta_verify_add_service_tree <stage> <origin_host> <index_content>
#   <home_source> <home_target> <notfound_source> <snapshot> <sidecar>
# Add the non-payload paths that both the full and delta pushers publish.
shard_delta_verify_add_service_tree() {
  local stage="$1" origin_host="$2" index_content="$3" home_source="$4"
  local home_target="$5" notfound_source="$6" snapshot="$7" sidecar="$8"
  shard_delta_remove_manifest_sidecars "$stage" || return 1
  shard_delta_add_text "$stage" .nojekyll '' || return 1
  shard_delta_add_text "$stage" CNAME "$origin_host" || return 1
  if [ -n "$home_target" ]; then
    if [ -n "$home_source" ] && [ -f "$home_source" ]; then
      shard_delta_add_file "$stage" "$home_source" "$home_target" || return 1
    else
      shard_delta_remove_file "$stage" "$home_target" || return 1
    fi
  fi
  if [ -n "$notfound_source" ] && [ -f "$notfound_source" ]; then
    shard_delta_add_file "$stage" "$notfound_source" 404.html || return 1
  else
    shard_delta_remove_file "$stage" 404.html || return 1
  fi
  shard_delta_add_text "$stage" index.html "$index_content" || return 1
  if [ -n "$snapshot" ] && [ -s "$snapshot" ]; then
    mkdir -p "$stage/$(dirname "$sidecar")" || return 1
    shard_delta_add_file "$stage" "$snapshot" "$sidecar" || return 1
  fi
  return 0
}

# shard_delta_verify_report <plan_stage> <base_tree> <plan_tree>
#   <actual_stage> <actual_tree> <tool> <shard_repo> <wall_plan>
# Compare after the real push. Every failure is advisory: the function emits a
# diagnostic and returns 0 so continue-on-error remains a last-resort safety
# net, not the verifier's control flow.
shard_delta_verify_report() {
  local plan_stage="$1" base_tree="$2" plan_tree="$3" actual_stage="$4"
  local actual_tree="$5" tool="$6" shard_repo="$7" wall_plan="$8"
  local work report safe_shard shard_display files adds mods dels mismatches
  shard_display="$shard_repo"
  case "$shard_display" in
    git@github.com:*) shard_display="${shard_display#git@github.com:}" ;;
    https://github.com/*) shard_display="${shard_display#https://github.com/}" ;;
  esac
  shard_display="${shard_display%.git}"
  work="$(mktemp -d)" || return 0
  report="$work/report.json"
  if ! git -C "$plan_stage" ls-tree -r -z --full-tree "$base_tree" > "$work/base.tree" \
    || ! git -C "$plan_stage" ls-tree -r -z --full-tree "$plan_tree" > "$work/plan.tree" \
    || ! git -C "$actual_stage" ls-tree -r -z --full-tree "$actual_tree" > "$work/actual.tree"; then
    echo "::warning::[shard-push-verify] could not list one of the trees for $shard_display"
    rm -rf "$work"
    return 0
  fi
  if ! node "$tool" \
      --base="$work/base.tree" \
      --plan="$work/plan.tree" \
      --actual="$work/actual.tree" \
      --out="$report" >/dev/null; then
    echo "::warning::[shard-push-verify] comparator failed for $shard_display (advisory)"
    rm -rf "$work"
    return 0
  fi
  files="$(jq -r '.files // 0' "$report" 2>/dev/null || echo 0)"
  adds="$(jq -r '.adds // 0' "$report" 2>/dev/null || echo 0)"
  mods="$(jq -r '.mods // 0' "$report" 2>/dev/null || echo 0)"
  dels="$(jq -r '.dels // 0' "$report" 2>/dev/null || echo 0)"
  mismatches="$(jq -r '.mismatchCount // 0' "$report" 2>/dev/null || echo 0)"
  echo "[shard-push-verify] shard=$shard_display mode=full plan=delta files=$files adds=$adds mods=$mods dels=$dels mismatches=$mismatches wall_plan=${wall_plan}s"
  if [[ "$mismatches" =~ ^[1-9][0-9]*$ ]]; then
    safe_shard="$(printf '%s' "$shard_display" | tr -c 'A-Za-z0-9._-' '_')"
    mkdir -p "$RUNNER_TEMP/shard-push-verify"
    cp "$report" "$RUNNER_TEMP/shard-push-verify/${safe_shard}.json" || true
    echo "::warning::[shard-push-verify] $shard_display has $mismatches tree mismatch(es); first 50:"
    jq -r '.mismatches[]? | "  \(.kind) path=\(.path) expected=\(.expected // "-") actual=\(.actual // "-")"' "$report" | head -n 50 || true
  fi
  rm -rf "$work"
  return 0
}

# shard_delta_count_files <stage> <path-prefix>
shard_delta_count_files() {
  local stage="$1" prefix="$2"
  git -C "$stage" -c core.quotePath=false ls-files -z -- "$prefix" 2>/dev/null \
    | tr -cd '\0' | wc -c | tr -d '[:space:]'
}

# True when the final indexed tree loses more than <pct> percent of its files.
shard_delta_shrink_exceeded() {
  local previous="$1" current="$2" pct="$3"
  [ "$previous" -gt 0 ] \
    && [ "$((current * 100))" -lt "$((previous * (100 - pct)))" ]
}

# shard_orphan_init <dir>
# Resets <dir> to a fresh, history-less git repo on branch `main`. Caller is
# responsible for populating the working tree and committing.
shard_orphan_init() {
  local dir="$1"
  git -C "$dir" init -q
  git -C "$dir" checkout -q -b main
}

# Credential helper used by shard_pat_push. The token is read from
# $SHARD_PUSH_TOKEN *inside* the helper, so it never lands in the remote URL
# (git echoes URLs back in its own error messages), never in argv (`ps` is
# world-readable on a runner) and never in a `set -x` trace of the push.
_SHARD_CRED_HELPER='!f() { test "$1" = get && printf "username=x-access-token\npassword=%s\n" "$SHARD_PUSH_TOKEN"; }; f'

# shard_https_push_url <shard_repo>
# Maps a GitHub SSH remote to its HTTPS equivalent (git@github.com:o/r.git →
# https://github.com/o/r.git; the ssh:// spelling too). An https:// remote is
# passed through unchanged. Anything else (local path, other host) returns 1:
# a GitHub token push only makes sense against github.com.
shard_https_push_url() {
  local repo="$1"
  case "$repo" in
    git@github.com:*)       printf 'https://github.com/%s' "${repo#git@github.com:}" ;;
    ssh://git@github.com/*) printf 'https://github.com/%s' "${repo#ssh://git@github.com/}" ;;
    https://github.com/*)   printf '%s' "$repo" ;;
    *) return 1 ;;
  esac
}

# shard_push_error_is_auth <logfile>
# True when <logfile> holds a git-push failure that authentication/authorization
# caused — i.e. one that is NOT transient and that retrying the SAME credential
# can never fix. Incident 2026-07-30 (run 30522223432): `uri-it` burned 3
# retries + the orphan-flatten self-heal (6 pushes, 15s of sleeps) against
# "ERROR: Permission to nanakokyobashi-rgb/frontaliere-uri-it.git denied to
# deploy key" on EVERY deploy for 3 days. Retrying a read-only/wrong deploy key
# is pure waste; the useful move is to switch credential (shard_pat_push).
# Deliberately does NOT match git's generic "Please make sure you have the
# correct access rights and the repository exists." tail: git prints it for a
# plain unreachable/nonexistent remote too, so matching it would misclassify a
# transient outage as an auth failure and skip the retries that DO help there.
shard_push_error_is_auth() {
  grep -qEi 'denied to (deploy key|user)|permission denied \(publickey\)|permission to .+ denied|repository not found|403 forbidden' "$1"
}

# shard_push_failure_reason <logfile>
# Classifies the last SSH push failure for the PAT fallback's warning. Keep
# this deliberately narrower than shard_push_error_is_auth: a generic git
# access-rights tail is not proof of an auth failure, and a transport error
# must never be reported as a broken deploy key (incident 2026-09-14).
shard_push_failure_reason() {
  local logfile="$1"
  if shard_push_error_is_auth "$logfile"; then
    printf '%s' 'deploy-key authentication/authorization failure'
  elif grep -qEi 'closed by remote host|unexpected disconnect|remote end hung up|early EOF|connection (reset|timed out|refused)|failed to connect|could not resolve host|network is unreachable|sideband packet' "$logfile"; then
    printf '%s' 'transient SSH transport failure'
  else
    printf '%s' 'unclassified SSH push failure'
  fi
}

# shard_pat_push <push_dir> <shard_repo> <refspec> [label] [force] [reason]
# Last-resort force-push over HTTPS authenticated with a PAT
# ($SHARD_PUSH_PAT, else $GITHUB_PAT — the latter is hydrated from Firebase
# Remote Config by scripts/load-rc-env.mjs in every deploy job). Exists because
# a per-shard deploy key is a single point of failure with no operational
# safety net: there are 90+ of them, each one revocable/read-only/rotatable
# independently, and each one lives in a secret that can be silently shadowed
# (repo-level vs `shard-secrets-overflow` environment — see
# scripts/ci/check-shard-secret-shadowing.mjs). The PAT is account-wide and has
# write on every shard repo (both owners), so it recovers ALL of those failure
# modes without touching a single secret. Returns 0 on success, 1 otherwise.
# [force] defaults to 1 (force-push, what every full-replace shard push does).
# Pass 0 from a caller whose whole concurrency model depends on a non-fast-
# forward being an ERROR rather than something to overwrite — that is
# push-article-shard-incremental.sh, where a rejected push means a concurrent
# full deploy moved the tip and the content has to be rebuilt on the new base.
# [reason] is the classified SSH failure, used only to make the recovery
# warning actionable without claiming that every PAT fallback means a broken
# deploy key.
shard_pat_push() {
  local dir="$1" repo="$2" refspec="$3" label="${4:-shard}" force="${5:-1}" reason="${6:-unclassified SSH push failure}"
  # A plain string, not an array: `"${arr[@]}"` on an EMPTY array aborts under
  # `set -u` in bash 3.2 (still the default /bin/bash on macOS, where the test
  # suite runs). Unquoted expansion of a fixed, space-free flag is safe here.
  local url out rc force_flag=''
  if [ "$force" = 1 ]; then force_flag='-f'; fi
  SHARD_PUSH_TOKEN="${SHARD_PUSH_PAT:-${GITHUB_PAT:-}}"
  if [ -z "$SHARD_PUSH_TOKEN" ]; then
    echo "::warning::$label: no SHARD_PUSH_PAT/GITHUB_PAT in the environment — cannot fall back to an HTTPS token push"
    return 1
  fi
  if ! url="$(shard_https_push_url "$repo")"; then
    echo "::warning::$label: cannot derive an HTTPS URL from '$repo' — skipping the token-push fallback"
    return 1
  fi
  # Belt and braces: the RC-loaded PAT is NOT a GH Actions secret, so it is not
  # masked automatically. Register it, then scrub it from this push's output.
  echo "::add-mask::$SHARD_PUSH_TOKEN"
  export SHARD_PUSH_TOKEN
  echo "$label: retrying over HTTPS with a PAT after $reason"
  out="$(mktemp)"
  # stderr (where git writes the whole push transcript) is captured for
  # scrubbing, then re-emitted on stderr — NOT folded into stdout, so this
  # function does not change which stream a caller reads the transcript from.
  # `|| rc=$?` for the same errexit reason as in shard_push_with_retry: this
  # runs under `set -e` whenever the caller chain is bare.
  rc=0
  # shellcheck disable=SC2086  # deliberate: empty $force_flag must vanish
  git -C "$dir" -c credential.helper= -c "credential.helper=$_SHARD_CRED_HELPER" \
    push $force_flag "$url" "$refspec" 2>"$out" || rc=$?
  sed "s|$SHARD_PUSH_TOKEN|***|g" "$out" >&2
  rm -f "$out"
  unset SHARD_PUSH_TOKEN
  if [ "$rc" -eq 0 ]; then
    case "$reason" in
      deploy-key*)
        echo "::warning::$label: pushed via the PAT fallback after $reason — fix or rotate the deploy key; the fallback is a safety net, not the intended path."
        ;;
      transient*)
        echo "::warning::$label: pushed via the PAT fallback after $reason — the deploy key is not classified as broken; investigate recurring transport failures."
        ;;
      *)
        echo "::warning::$label: pushed via the PAT fallback after $reason — inspect the SSH failure above; the deploy key is not automatically classified as broken."
        ;;
    esac
    return 0
  fi
  echo "::warning::$label: PAT fallback push also failed (rc=$rc)"
  return 1
}

# shard_push_with_retry <push_dir> <shard_repo> <refspec> [label]
# Force-pushes <refspec> from <push_dir> to <shard_repo>, retrying up to 3
# attempts with exponential backoff (5s, 10s — $SHARD_PUSH_RETRY_DELAY seeds
# the first delay). An auth-class failure short-circuits the remaining SSH
# retries (see shard_push_error_is_auth). Either way the last resort is
# shard_pat_push. Returns 0 on success, 1 if every credential failed.
# [label] is cosmetic only (prefixes the ::warning:: lines).
shard_push_with_retry() {
  local dir="$1" repo="$2" refspec="$3" label="${4:-shard}"
  local delay="${SHARD_PUSH_RETRY_DELAY:-5}" try out rc fallback_reason='unclassified SSH push failure'
  out="$(mktemp)"
  for try in 1 2 3; do
    # Capture stderr to classify the failure, then put it back on stderr — see
    # the same note in shard_pat_push about not moving it to stdout.
    #
    # `|| rc=$?` is not decorative. The previous shape was `if git push; then`,
    # where the condition context suspended errexit for the push. A BARE failing
    # command does not get that, so under `set -e` it would abort the caller's
    # subshell on attempt 1 — no retries, no fallback, no return value to
    # inspect. Today every caller happens to be safe (the pushers call this from
    # an `if`; compact-article-shard-history.sh calls it bare but from a
    # `( set -e … ) || rc=$?` subshell, and a subshell inside an AND-OR list has
    # errexit suppressed throughout). That safety is one refactor away from
    # gone — dropping compact's `|| rc=$?` would give it push-section-shard.sh's
    # bare-subshell shape, where errexit IS live. The OR list makes this
    # call-context independent instead of accidentally fine.
    rc=0
    git -C "$dir" push -f "$repo" "$refspec" 2>"$out" || rc=$?
    cat "$out" >&2
    if [ "$rc" -eq 0 ]; then
      rm -f "$out"
      return 0
    fi
    fallback_reason="$(shard_push_failure_reason "$out")"
    if shard_push_error_is_auth "$out"; then
      echo "::warning::$label: deploy-key auth failure (not transient) — skipping the remaining SSH retries and falling back to a token push"
      break
    fi
    if [ "$try" -lt 3 ]; then
      echo "::warning::$label push attempt $try/3 failed — retrying in ${delay}s"
      sleep "$delay"; delay=$(( delay * 2 ))
    fi
  done
  rm -f "$out"
  shard_pat_push "$dir" "$repo" "$refspec" "$label" 1 "$fallback_reason"
}

# shard_orphan_flatten_and_push <stage_dir> <shard_repo> <commit_message> [label]
# Flattens <stage_dir> to a single fresh orphan commit and force-pushes it.
# ASSUMES <stage_dir>'s working tree ALREADY holds the exact desired final
# content — this function does not copy or build anything, it only resets
# `.git`, resets the `.shard-deploys` counter to 1 (a fresh flatten is
# deploy #1 since the last flatten), commits, and pushes with retry. Used
# both by push-section-shard.sh / push-locale-shard.sh's self-heal-flatten
# path (a failed incremental push retried as a full orphan push) and by
# compact-article-shard-history.sh's periodic history compaction — same
# mechanism, not a second implementation (AGENTS.md #6).
shard_orphan_flatten_and_push() {
  local dir="$1" repo="$2" msg="$3" label="${4:-shard}"
  rm -rf "${dir:?}/.git"
  shard_orphan_init "$dir"
  git -C "$dir" config user.email "valerielinc@gmail.com"
  git -C "$dir" config user.name "Valerie Linc"
  printf '%s' "1" > "$dir/.shard-deploys"
  git -C "$dir" add -A
  git -C "$dir" commit -qm "$msg"
  shard_push_with_retry "$dir" "$repo" "main" "$label"
}

# shard_history_needs_compaction <clone_dir> <cap>
# Issue #4881 defect B: push-section-shard.sh bounds `.git` growth via its
# `.shard-deploys` proxy counter, but push-article-shard-incremental.sh
# deliberately never increments it (see that script's header) — once a
# section's full-replace push stops running, the counter freezes and that
# cap check never fires again. This measures the ACTUAL commit count instead
# of relying on the frozen proxy: `git rev-list --count HEAD` is tree-graph
# only (same reasoning as shard_read_counter — never fetches blob content),
# so <clone_dir> only needs a `--filter=blob:none --no-checkout` clone.
#
# Prints the commit count at HEAD in <clone_dir> to stdout (or "0" if HEAD
# does not resolve). Return code:
#   0 — commit count >= <cap>: caller should flatten.
#   1 — commit count <  <cap>: below the threshold, no action needed.
#   2 — HEAD does not resolve (no commits yet on this clone/branch): nothing
#       to compact. Distinct from 1 so callers can treat an otherwise-live
#       shard with zero commits as the real error it is, not a quiet no-op.
#
# Caller note: `n=$(shard_history_needs_compaction ...)` under `set -e` MUST
# be guarded (e.g. `n="$(... )" || rc=$?`) — an unguarded plain assignment
# aborts the subshell on the very return codes (1, 2) this function uses to
# signal "no compaction needed" / "no commits yet", before the caller ever
# gets to inspect them. Exactly the same class of latent bug shard_read_counter
# and the shrink guard in push-section-shard.sh/push-locale-shard.sh fix
# elsewhere in this file — a plumbing helper whose non-zero return is a
# normal, expected outcome, not a hard failure.
shard_history_needs_compaction() {
  local dir="$1" cap="$2" n
  if ! git -C "$dir" rev-parse -q --verify HEAD >/dev/null 2>&1; then
    printf '%s' "0"
    return 2
  fi
  n="$(git -C "$dir" rev-list --count HEAD)"
  printf '%s' "$n"
  [ "$n" -ge "$cap" ]
}
