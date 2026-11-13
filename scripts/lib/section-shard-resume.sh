#!/usr/bin/env bash
# Site-only resumable section-shard publishing. Kept separate from the
# adapted shared shard-git-helpers.sh because the corpus publisher does not
# use the section-shard checkpoint protocol.

# section_shard_push_fast_forward <push_dir> <repo> <refspec> [label]
# Retry without force and use the same owner-aware PAT fallback as the shared
# publisher. Checkpoint and main promotion refs must only advance from the
# expected parent; a non-fast-forward is a hard failure.
section_shard_push_fast_forward() {
  shard_refspec_has_source "${3:-}" "${4:-section shard}" || return 1
  local dir="$1" repo="$2" refspec="$3" label="${4:-section shard}"
  local delay="${SHARD_PUSH_RETRY_DELAY:-5}" try out rc fallback_reason='unclassified SSH push failure' remote_line
  out="$(mktemp)"
  for try in 1 2 3; do
    rc=0
    git -C "$dir" push "$repo" "$refspec" 2>"$out" || rc=$?
    cat "$out" >&2
    if [ "$rc" -eq 0 ]; then
      rm -f "$out"
      return 0
    fi
    if shard_push_error_is_remote_object_limit "$out"; then
      fallback_reason="$(shard_push_failure_reason "$out")"
      remote_line="$(grep -Ei "$SHARD_REMOTE_OBJECT_LIMIT_PATTERN" "$out" | head -n 1 || true)"
      echo "::error::$label: GitHub remote object/tree size limit is permanent, not transient — remote: ${remote_line:-object-size rejection}" >&2
      shard_record_push_failure_reason "$fallback_reason"
      rm -f "$out"
      return 3
    fi
    fallback_reason="$(shard_push_failure_reason "$out")"
    if shard_push_error_is_auth "$out"; then
      echo "::warning::$label: deploy-key auth failure (not transient) — skipping the remaining SSH retries and falling back to a token push" >&2
      break
    fi
    if [ "$try" -lt 3 ]; then
      echo "::warning::$label push attempt $try/3 failed — retrying in ${delay}s" >&2
      sleep "$delay"
      delay=$((delay * 2))
    fi
  done
  rm -f "$out"
  shard_pat_push "$dir" "$repo" "$refspec" "$label" 0 "$fallback_reason"
}

# section_shard_publish_resumable <stage> <repo> <base_sha> <target_tree>
#   <checkpoint_ref> <main_commit_message> <label> [files_per_checkpoint] [base|empty]
# A large delta is written to a private, non-Pages ref in bounded path chunks.
# Each chunk commit is pushed before the next one, so its blobs remain in the
# shard repository if the job deadline interrupts a later chunk. The final
# commit is a single child of <base_sha> and is promoted to main only after the
# complete target tree has been assembled and checked by the caller. Layout
# migrations may seed checkpoints from an empty index so an already oversized
# canonical base tree is never repushed in intermediate checkpoint trees. A later
# run fetches the checkpoint tip (blobless) and reuses its objects while
# rebuilding from the still-live main tree. The checkpoint branch is keyed by
# the base SHA and is deleted after successful promotion.
section_shard_publish_resumable() {
  local stage="$1" repo="$2" base_sha="$3" target_tree="$4"
  local checkpoint_ref="$5" main_message="$6" label="${7:-shard}"
  local files_per_checkpoint="${8:-10000}"
  local checkpoint_seed="${9:-base}"
  local final_index partial_index work raw_diff chunk_count checkpoint_parent
  local chunk_file chunk_number partial_tree commit_message checkpoint_commit final_commit actual_tree
  local existing remote_sha checkpoint_message checkpoint_target checkpoint_progress checkpoint_plan partial_start
  local completed_chunks checkpoint_chunks phase_started empty_tree diff_base
  local chunk_plan_sha

  case "$files_per_checkpoint" in
    ''|*[!0-9]*|0)
      echo "::error::$label: SHARD_DELTA_CHECKPOINT_FILES must be a positive integer" >&2
      return 1
      ;;
  esac
  case "$checkpoint_ref" in
    refs/heads/shard-resume/*) ;;
    *) echo "::error::$label: refusing unsafe checkpoint ref '$checkpoint_ref'" >&2; return 1 ;;
  esac
  case "$checkpoint_seed" in
    base|empty) ;;
    *) echo "::error::$label: checkpoint seed must be base or empty" >&2; return 1 ;;
  esac

  work="$(mktemp -d)" || return 1
  final_index="$stage/.git/index.shard-final"
  partial_index="$stage/.git/index.shard-partial"
  raw_diff="$work/target.diff"
  if ! cp "$(git -C "$stage" rev-parse --git-path index)" "$final_index"; then
    echo "::error::$label: could not preserve the complete delta index" >&2
    rm -rf "$work" "$final_index" "$partial_index"
    return 1
  fi
  if [ "$checkpoint_seed" = empty ]; then
    if ! empty_tree="$(git -C "$stage" mktree </dev/null)"; then
      echo "::error::$label: could not create the empty checkpoint seed tree" >&2
      rm -rf "$work" "$final_index" "$partial_index"
      return 1
    fi
    diff_base="$empty_tree"
  else
    diff_base="$base_sha"
  fi
  if ! GIT_INDEX_FILE="$final_index" git -C "$stage" diff-index --cached --raw -z --no-renames --abbrev=40 "$diff_base" -- > "$raw_diff"; then
    echo "::error::$label: could not enumerate the complete target against its checkpoint seed" >&2
    rm -rf "$work" "$final_index" "$partial_index"
    return 1
  fi

  if ! chunk_count="$(perl -e '
      use strict;
      use warnings;
      my ($raw_file, $out_dir, $limit) = @ARGV;
      open my $raw, "<:raw", $raw_file or die "open $raw_file: $!";
      my $delete_raw_path = "$out_dir/deletions.info";
      my $update_raw_path = "$out_dir/updates.info";
      open my $deletions, ">:raw", $delete_raw_path or die "open $delete_raw_path: $!";
      open my $updates, ">:raw", $update_raw_path or die "open $update_raw_path: $!";
      local $/ = "\0";
      my $total = 0;
      while (defined(my $header = <$raw>)) {
        chop $header;
        die "unexpected raw diff header" unless $header =~ s/^://;
        my ($old_mode, $new_mode, $old_oid, $new_oid, $status) = split / /, $header;
        my $path = <$raw>;
        die "raw diff path missing" unless defined $path;
        chop $path;
        die "unsupported raw diff status $status" unless defined($status) && $status =~ /^[AMDTUXB]$/;
        if ($new_mode eq "000000") {
          die "invalid deletion object id" unless defined($new_oid) && $new_oid =~ /^0+$/;
          print {$deletions} "0 $new_oid\t$path\0";
        } else {
          die "invalid target mode/object id" unless defined($new_mode) && $new_mode =~ /^\d{6}$/
            && defined($new_oid) && $new_oid =~ /^[0-9a-f]+$/;
          print {$updates} "$new_mode $new_oid\t$path\0";
        }
        $total++;
      }
      close $raw or die "close $raw_file: $!";
      close $deletions or die "close $delete_raw_path: $!";
      close $updates or die "close $update_raw_path: $!";
      die "delta target contains no changed paths" unless $total;
      my $chunk = 0;
      sub split_stream {
        my ($input_path, $out_dir, $max_records, $chunk_ref) = @_;
        open my $input, "<:raw", $input_path or die "open $input_path: $!";
        my ($within, $output) = (0, undef);
        while (defined(my $record = <$input>)) {
          if (!$output || $within >= $max_records) {
            close $output if $output;
            $$chunk_ref++;
            $within = 0;
            my $name = sprintf "%s/chunk-%06d.info", $out_dir, $$chunk_ref;
            open $output, ">:raw", $name or die "open $name: $!";
          }
          print {$output} $record;
          $within++;
        }
        close $output if $output;
        close $input or die "close $input_path: $!";
      }
      # Delete obsolete paths first so intermediate trees stay close to or
      # below the final path count while additions are applied afterward.
      split_stream($delete_raw_path, $out_dir, $limit, \$chunk);
      split_stream($update_raw_path, $out_dir, $limit, \$chunk);
      print $chunk;
    ' "$raw_diff" "$work" "$files_per_checkpoint")"; then
    echo "::error::$label: could not split delta target into resumable checkpoints" >&2
    rm -rf "$work" "$final_index" "$partial_index"
    return 1
  fi

  if ! chunk_plan_sha="$(perl -MDigest::SHA -e '
      use strict;
      use warnings;
      my ($files_per_chunk, $seed, @chunks) = @ARGV;
      my $sha = Digest::SHA->new(256);
      $sha->add("files-per-checkpoint=$files_per_chunk\0");
      $sha->add("checkpoint-seed=$seed\0");
      my $index = 0;
      for my $path (@chunks) {
        open my $input, "<:raw", $path or die "open $path: $!";
        $sha->add("chunk=" . ++$index . "\0");
        while (1) {
          my $bytes = read $input, my $buffer, 65536;
          die "read $path: $!" unless defined $bytes;
          last unless $bytes;
          $sha->add($buffer);
        }
        close $input or die "close $path: $!";
      }
      die "checkpoint chunk plan is empty" unless $index;
      print $sha->hexdigest;
    ' "$files_per_checkpoint" "$checkpoint_seed" "$work"/chunk-*.info)"; then
    echo "::error::$label: could not fingerprint the ordered checkpoint chunk plan" >&2
    rm -rf "$work" "$final_index" "$partial_index"
    return 1
  fi
  echo "$label: resumable checkpoint seed=$checkpoint_seed, chunks=$chunk_count, files-per-chunk=$files_per_checkpoint"

  if ! existing="$(git -C "$stage" ls-remote --heads "$repo" "$checkpoint_ref")"; then
    echo "::error::$label: could not inspect checkpoint ref $checkpoint_ref" >&2
    rm -rf "$work" "$final_index" "$partial_index"
    return 1
  fi
  checkpoint_parent="$base_sha"
  completed_chunks=0
  if [ -n "$existing" ]; then
    remote_sha="${existing%%$'\t'*}"
    if ! git -C "$stage" fetch -q --depth=1 --filter=blob:none "$repo" "+$checkpoint_ref:refs/remotes/shard-resume/current"; then
      echo "::error::$label: could not fetch checkpoint history from $checkpoint_ref" >&2
      rm -rf "$work" "$final_index" "$partial_index"
      return 1
    fi
    checkpoint_parent="$(git -C "$stage" rev-parse refs/remotes/shard-resume/current 2>/dev/null || true)"
    checkpoint_message="$(git -C "$stage" show -s --format=%B "$checkpoint_parent" 2>/dev/null || true)"
    if [ -z "$checkpoint_parent" ] || [ "$checkpoint_parent" != "$remote_sha" ] \
       || ! printf '%s\n' "$checkpoint_message" | grep -Fq "[resume-base:$base_sha]"; then
      echo "::error::$label: existing checkpoint does not match main base $base_sha; refusing to overwrite it" >&2
      rm -rf "$work" "$final_index" "$partial_index"
      return 1
    fi
    checkpoint_target="$(printf '%s\n' "$checkpoint_message" | sed -nE 's/.*\[resume-target:([0-9a-f]+)\].*/\1/p' | tail -n 1)"
    checkpoint_plan="$(printf '%s\n' "$checkpoint_message" | sed -nE 's/.*\[resume-plan:([0-9a-f]{64})\].*/\1/p' | tail -n 1)"
    checkpoint_progress="$(printf '%s\n' "$checkpoint_message" | sed -nE 's/.*checkpoint ([0-9]+)\/([0-9]+).*/\1 \2/p' | tail -n 1)"
    if [ "$checkpoint_target" = "$target_tree" ] \
       && [ "$checkpoint_plan" = "$chunk_plan_sha" ] && [ -n "$checkpoint_progress" ]; then
      read -r completed_chunks checkpoint_chunks <<< "$checkpoint_progress"
      case "$completed_chunks:$checkpoint_chunks" in
        *[!0-9:]*|:*|*:) completed_chunks=0 ;;
        *)
          if [ "$checkpoint_chunks" -eq "$chunk_count" ] && [ "$completed_chunks" -le "$chunk_count" ]; then
            : # The stored progress is compatible with this exact target tree.
          else
            completed_chunks=0
          fi
          ;;
      esac
    fi
    if [ "$completed_chunks" -gt 0 ]; then
      echo "$label: resuming hidden checkpoint at $checkpoint_parent (base $base_sha, target $target_tree, already $completed_chunks/$chunk_count chunks)"
    else
      echo "$label: rebuilding checkpoint progress from main at $checkpoint_parent (base $base_sha; target or chunk plan changed)"
    fi
  fi

  if [ "$completed_chunks" -gt 0 ]; then
    partial_start="$checkpoint_parent"
  elif [ "$checkpoint_seed" = empty ]; then
    partial_start="$empty_tree"
  else
    partial_start="$base_sha"
  fi
  if ! GIT_INDEX_FILE="$partial_index" git -C "$stage" read-tree "$partial_start"; then
    echo "::error::$label: could not initialize the private checkpoint index from main" >&2
    rm -rf "$work" "$final_index" "$partial_index"
    return 1
  fi

  chunk_number=0
  for chunk_file in "$work"/chunk-*.info; do
    [ -f "$chunk_file" ] || continue
    chunk_number=$((chunk_number + 1))
    if [ "$chunk_number" -le "$completed_chunks" ]; then
      echo "[$label] checkpoint $chunk_number/$chunk_count already persisted; reusing it"
      continue
    fi
    phase_started=$SECONDS
    if ! GIT_INDEX_FILE="$partial_index" git -C "$stage" -c core.quotePath=false update-index -z --index-info < "$chunk_file"; then
      echo "::error::$label: applying checkpoint chunk $chunk_number/$chunk_count failed" >&2
      rm -rf "$work" "$final_index" "$partial_index"
      return 1
    fi
    echo "[$label] checkpoint $chunk_number/$chunk_count index-update $((SECONDS - phase_started))s"
    phase_started=$SECONDS
    if ! partial_tree="$(GIT_INDEX_FILE="$partial_index" git -C "$stage" write-tree --missing)"; then
      echo "::error::$label: writing checkpoint tree $chunk_number/$chunk_count failed" >&2
      rm -rf "$work" "$final_index" "$partial_index"
      return 1
    fi
    echo "[$label] checkpoint $chunk_number/$chunk_count write-tree $((SECONDS - phase_started))s"
    commit_message="$main_message [resume-base:$base_sha] [resume-target:$target_tree] [resume-plan:$chunk_plan_sha] checkpoint $chunk_number/$chunk_count"
    phase_started=$SECONDS
    if ! checkpoint_commit="$(git -C "$stage" commit-tree "$partial_tree" -p "$checkpoint_parent" -m "$commit_message")"; then
      echo "::error::$label: creating checkpoint commit $chunk_number/$chunk_count failed" >&2
      rm -rf "$work" "$final_index" "$partial_index"
      return 1
    fi
    echo "[$label] checkpoint $chunk_number/$chunk_count commit-tree $((SECONDS - phase_started))s"
    echo "[$label] checkpoint $chunk_number/$chunk_count paths=$(perl -0ne '$count += 1; END { print $count + 0 }' < "$chunk_file")"
    phase_started=$SECONDS
    if ! section_shard_push_fast_forward "$stage" "$repo" "$checkpoint_commit:$checkpoint_ref" \
        "$label checkpoint $chunk_number/$chunk_count"; then
      echo "::error::$label: checkpoint $chunk_number/$chunk_count was not persisted; main remains unchanged" >&2
      rm -rf "$work" "$final_index" "$partial_index"
      return 1
    fi
    echo "[$label] checkpoint $chunk_number/$chunk_count push $((SECONDS - phase_started))s"
    checkpoint_parent="$checkpoint_commit"
  done

  if [ "$chunk_number" -ne "$chunk_count" ]; then
    echo "::error::$label: only $chunk_number/$chunk_count checkpoint chunks were applied" >&2
    rm -rf "$work" "$final_index" "$partial_index"
    return 1
  fi
  if ! actual_tree="$(GIT_INDEX_FILE="$partial_index" git -C "$stage" write-tree --missing)" \
     || [ "$actual_tree" != "$target_tree" ]; then
    echo "::error::$label: checkpoint tree does not match complete target tree" >&2
    rm -rf "$work" "$final_index" "$partial_index"
    return 1
  fi
  if ! final_commit="$(git -C "$stage" commit-tree "$target_tree" -p "$base_sha" -m "$main_message [delta]")"; then
    echo "::error::$label: creating final main commit failed" >&2
    rm -rf "$work" "$final_index" "$partial_index"
    return 1
  fi
  if ! section_shard_push_fast_forward "$stage" "$repo" "$final_commit:refs/heads/main" "$label promote complete tree"; then
    echo "::error::$label: complete tree promotion failed; hidden checkpoint remains available for retry" >&2
    rm -rf "$work" "$final_index" "$partial_index"
    return 1
  fi
  if ! git -C "$stage" push --force-with-lease="$checkpoint_ref:$checkpoint_parent" \
      "$repo" ":$checkpoint_ref" >/dev/null 2>&1; then
    echo "::warning::$label: complete tree is live but its private checkpoint ref cleanup failed; the leftover ref is not served from main" >&2
  else
    echo "[$label] complete tree promoted; hidden checkpoint removed"
  fi

  rm -rf "$work" "$final_index" "$partial_index"
  return 0
}

# section_shard_checkpoint_cleanup <stage> <repo> <checkpoint_ref> <label>
# Delete a completed/obsolete private checkpoint only if it still points at
# the exact commit observed by ls-remote. A concurrent writer can therefore
# never have its newer progress removed by this cleanup.
section_shard_checkpoint_cleanup() {
  local stage="$1" repo="$2" checkpoint_ref="$3" label="${4:-shard}"
  local existing checkpoint_sha
  case "$checkpoint_ref" in
    refs/heads/shard-resume/*) ;;
    *) echo "::warning::$label: refusing unsafe checkpoint cleanup ref '$checkpoint_ref'" >&2; return 1 ;;
  esac
  if ! existing="$(git -C "$stage" ls-remote --heads "$repo" "$checkpoint_ref")"; then
    echo "::warning::$label: could not inspect checkpoint ref during cleanup" >&2
    return 1
  fi
  [ -n "$existing" ] || return 0
  checkpoint_sha="${existing%%$'\t'*}"
  if ! git -C "$stage" push --force-with-lease="$checkpoint_ref:$checkpoint_sha" \
      "$repo" ":$checkpoint_ref" >/dev/null 2>&1; then
    echo "::warning::$label: checkpoint cleanup failed for $checkpoint_ref" >&2
    return 1
  fi
  echo "[$label] removed obsolete hidden checkpoint $checkpoint_ref"
  return 0
}

