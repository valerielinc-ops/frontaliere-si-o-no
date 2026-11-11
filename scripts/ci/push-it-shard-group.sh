#!/usr/bin/env bash
set -euo pipefail
group_id="${1:-}"
plan_file="${IT_SHARD_PLAN_FILE:-}"
source_run_id="${SOURCE_RUN_ID:-}"
source_sha="${SOURCE_SHA:-}"
expected_build_id="${DEPLOY_BUILD_ID:-}"
job_start="${CDN_JOB_START_EPOCH:-}"
if [[ -z "$group_id" || -z "$plan_file" || -z "$source_run_id" || -z "$source_sha" || -z "$expected_build_id" ]]; then
  echo "::error::push-it-shard-group requires group id, source identity, build id, and plan file"
  exit 2
fi
if [[ ! "$job_start" =~ ^[0-9]+$ ]]; then
  echo "::error::push-it-shard-group requires the publisher job start epoch"
  exit 2
fi
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"
node scripts/ci/it-shard-group-plan.mjs --validate-plan "$plan_file" --source-run-id "$source_run_id" --source-sha "$source_sha" --build-id "$expected_build_id"
export GITHUB_SHA="$source_sha"
group_sections="$(jq -r --arg group "$group_id" '.groups[] | select(.id == $group) | .sections[]' "$plan_file")"
group_count="$(jq -r --arg group "$group_id" '[.groups[] | select(.id == $group)] | length' "$plan_file")"
[[ "$group_count" == 1 ]] || { echo "::error::unknown IT shard group $group_id"; exit 2; }
sections_remaining="$(jq -r --arg group "$group_id" '.groups[] | select(.id == $group) | .sections | length' "$plan_file")"
mkdir -p "$RUNNER_TEMP/shard-content-manifests/it" "$RUNNER_TEMP/it-shard-results"
source scripts/lib/shard-cdn-rewrite.sh
cleanup_grace_seconds=600
post_push_reserve_seconds=1200
section_timeout_cap_seconds=3600
fail=0
failed_sections=()
while IFS= read -r section; do
  [[ -n "$section" ]] || continue
  sections_remaining=$((sections_remaining - 1))
  skip_var="$(printf '%s' "$section" | LC_ALL=C tr '[:lower:]' '[:upper:]')_BUILD_EMIT_SKIP"
  if [[ "${!skip_var:-false}" == true ]]; then
    echo "::error::source plan unexpectedly contains BUILD_EMIT_SKIP section $section"
    fail=1
    continue
  fi
  now_epoch="$(date +%s)"
  available_seconds=$((job_start + 360 * 60 - now_epoch - cleanup_grace_seconds - post_push_reserve_seconds))
  if (( available_seconds <= 0 )); then
    echo "::error::[section-push] event=timeout locale=it section=$section timeout_seconds=0 cleanup_grace_seconds=$cleanup_grace_seconds post_push_reserve_seconds=$post_push_reserve_seconds group=$group_id"
    fail=1
    failed_sections+=("$section")
    continue
  fi
  timeout_seconds=$((available_seconds / (sections_remaining + 1)))
  if (( timeout_seconds > section_timeout_cap_seconds )); then
    timeout_seconds=$section_timeout_cap_seconds
  fi
  if (( timeout_seconds <= 0 )); then
    echo "::error::[section-push] event=timeout locale=it section=$section timeout_seconds=$timeout_seconds cleanup_grace_seconds=$cleanup_grace_seconds post_push_reserve_seconds=$post_push_reserve_seconds group=$group_id"
    fail=1
    failed_sections+=("$section")
    continue
  fi
  echo "[section-push] event=start locale=it section=$section timeout_seconds=$timeout_seconds cleanup_grace_seconds=$cleanup_grace_seconds post_push_reserve_seconds=$post_push_reserve_seconds group=$group_id"
  if timeout --verbose --signal=TERM --kill-after="${cleanup_grace_seconds}s" "${timeout_seconds}s" \
    node scripts/ci/with-shard-writer-lock.mjs \
      --section "$section" --locale it --policy wait --timeout-ms "$((timeout_seconds * 1000))" -- \
      bash scripts/lib/push-section-shard.sh "$section" it dist; then
    echo "[section-push] event=finish locale=it section=$section outcome=success"
  else
    rc=$?
    if [[ "$rc" == 124 ]]; then
      echo "::error::[section-push] event=timeout locale=it section=$section timeout_seconds=$timeout_seconds cleanup_grace_seconds=$cleanup_grace_seconds post_push_reserve_seconds=$post_push_reserve_seconds exit_code=$rc"
    elif [[ "$rc" == 137 ]]; then
      echo "::error::[section-push] event=forced-termination locale=it section=$section exit_code=$rc"
    else
      echo "::error::[section-push] event=finish locale=it section=$section outcome=failure exit_code=$rc"
    fi
    fail=1
    failed_sections+=("$section")
  fi
done <<< "$group_sections"
shard_cdn_rewrite_wait_all "$RUNNER_TEMP" || true
while IFS= read -r section; do
  [[ -n "$section" ]] || continue
  marker="$RUNNER_TEMP/shard-ok-$section-it"
  [[ -f "$marker" ]] || { echo "::error::no push ok-marker for required section $section-it"; fail=1; continue; }
  if ! shard_cdn_rewrite_ready "$RUNNER_TEMP" "$section" it; then
    echo "::error::CDN rewrite did not complete for required section $section-it"
    fail=1
    continue
  fi
  slug="$(jq -er --arg section "$section" '.[$section].it' scripts/lib/section-shard-slugs.json)"
  stage="$RUNNER_TEMP/${section}-src-it/dist"
  [[ -d "$stage/$slug" ]] || { echo "::error::no staged subtree for required section $section-it"; fail=1; continue; }
  live_src_n="$(find "$stage/$slug" -type f | wc -l | tr -d '[:space:]')"
  source_count_file="$RUNNER_TEMP/shard-srcn-$section-it"
  if [[ -f "$source_count_file" ]]; then
    persisted_src_n="$(cat "$source_count_file")"
    if [[ "$live_src_n" != "$persisted_src_n" ]]; then
      echo "::error::$section-it subtree shrank between push and pack (persisted=$persisted_src_n live=$live_src_n)"
      fail=1
      continue
    fi
  fi
  tar_path="$RUNNER_TEMP/$section-dist-it.tar"
  if ! packed_n="$(tar -C "$stage" -cf "$tar_path" "$slug" && tar -tf "$tar_path" | awk '!/\/$/ { n++ } END { print n + 0 }')"; then
    rm -f "$tar_path"
    echo "::warning::failed to pack $section-it staged subtree"
    continue
  fi
  if [[ "$packed_n" != "$live_src_n" ]]; then
    rm -f "$tar_path"
    echo "::error::$section-it tar file count mismatch (packed=$packed_n source=$live_src_n)"
    fail=1
    continue
  fi
  node scripts/ci/shard-content-manifest.mjs create-section \
    --root "$stage/$slug" --prefix "$slug" --locale it --section "$section" \
    --source-run-id "$source_run_id" --source-sha "$source_sha" --artifact-run-id "$GITHUB_RUN_ID" \
    --tar "$tar_path" --page-manifest "$RUNNER_TEMP/it-publish-plan/locale-sitemap-manifest-it.json" \
    --evidence-manifest "$RUNNER_TEMP/it-publish-plan/expired-archive-evidence-it.json" \
    --out "$RUNNER_TEMP/shard-content-manifests/it/$section.json"
  cp "$tar_path" "$RUNNER_TEMP/it-shard-results/"
done <<< "$group_sections"
if (( ${#failed_sections[@]} )); then
  node scripts/ci/report-shard-push-failure.mjs --locale it --shards "$(IFS=,; echo "${failed_sections[*]}")" || true
fi
if [[ -z "${CF_API_TOKEN:-}" ]]; then
  echo "::warning::CF_API_TOKEN missing after Remote Config load; shard edges keep cached copies until TTL expiry"
else
  sections=()
  while IFS= read -r section; do
    [[ -n "$section" && -f "$RUNNER_TEMP/shard-ok-$section-it" ]] && sections+=("$section")
  done <<< "$group_sections"
  if (( ${#sections[@]} )); then
    while IFS= read -r batch_urls; do
      [[ -n "$batch_urls" ]] || continue
      node scripts/cf-purge-cache.mjs "--files=$batch_urls" || { echo "::warning::a section edge purge batch failed"; fail=1; }
    done < <(node scripts/ci/section-shard-purge-urls.mjs it "${sections[@]}")
  fi
fi
echo "it_group=$group_id" >> "$GITHUB_OUTPUT"
echo "sections=$(jq -c --arg group "$group_id" '.groups[] | select(.id == $group) | .sections' "$plan_file")" >> "$GITHUB_OUTPUT"
exit "$fail"
