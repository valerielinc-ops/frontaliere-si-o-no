#!/usr/bin/env bash
# scripts/lib/post-build-tasks.sh
#
# Task registry for the 18 post-build validators/audits/SPA/E2E checks that
# run in deploy.yml. Used by both the inline pool in deploy.yml and the
# matrix-split test workflow (.github/workflows/post-build-matrix-test.yml).
#
# Usage:
#   source scripts/lib/post-build-tasks.sh
#   run_post_build_task <task-name>
#
# Each task must be idempotent and read-only against dist/ + data/ — they
# share no state and can run in any order. Task names match those used in
# deploy.yml's spawn_capped invocations and per-task wall_s reports.

run_post_build_task() {
  local name="$1"
  case "$name" in
    audit:text-html-ratio)        npm run audit:text-html-ratio ;;
    audit:page-weight)            npm run audit:page-weight ;;
    audit:h1-title-duplicates)    npm run audit:h1-title-duplicates ;;
    audit:title-length)           npm run audit:title-length ;;
    audit:title-no-disambig-hash) npm run audit:title-no-disambig-hash ;;
    audit:title-uniqueness)       npm run audit:title-uniqueness ;;
    audit:hreflang)               npm run audit:hreflang ;;
    audit:content-duplicates)     npm run audit:content-duplicates ;;
    audit:orphan-sitemap-pages)   npm run audit:orphan-sitemap-pages -- --gate=baseline ;;
    audit:sitemap-canonicals)     npm run audit:sitemap-canonicals ;;
    audit:faqpage-validity)       npm run audit:faqpage-validity ;;
    validate:jobposting-schema)   npm run validate:jobposting-schema ;;
    validate:jobs-quality)        npm run validate:jobs-quality ;;
    validate:sitemap-links)       npm run validate:sitemap-links ;;
    validate:spa-render)          timeout 300 node scripts/validate-spa-render.mjs ;;
    validate:structured-data)     node scripts/validate-structured-data-completeness.mjs ;;
    validate:soft-404)            node scripts/validate-soft404.mjs ;;
    validate:content-quality)     node scripts/validate-content-quality.mjs ;;
    validate:canonical)           node scripts/validate-canonical.mjs ;;
    test:e2e:smoke)               timeout 180 npx playwright test ;;
    gate:seo-source)              npm run gate:seo-source ;;
    *) echo "❌ Unknown post-build task: $name" >&2; return 2 ;;
  esac
}

# All 18 task names (order matches LPT bucket assignments below).
ALL_POST_BUILD_TASKS=(
  audit:text-html-ratio
  validate:spa-render
  test:e2e:smoke
  validate:jobs-quality
  validate:jobposting-schema
  audit:page-weight
  audit:h1-title-duplicates
  audit:content-duplicates
  audit:title-length
  audit:title-no-disambig-hash
  audit:orphan-sitemap-pages
  audit:title-uniqueness
  validate:structured-data
  validate:soft-404
  validate:content-quality
  audit:hreflang
  validate:sitemap-links
  audit:sitemap-canonicals
  validate:canonical
  gate:seo-source
  audit:faqpage-validity
)

# LPT-balanced 4-shard assignment based on prior wall_s measurements
# (sum~690s, max bucket~232s, see deploy.yml:365 comment for rationale).
# Each shard runs its tasks with internal MAX_PARALLEL=2 (matches 2-core
# ubuntu-latest), so per-shard wall ≈ shard_sum / 2.
POST_BUILD_SHARD_1=(
  audit:text-html-ratio
  audit:content-duplicates
  audit:title-uniqueness
  validate:soft-404
  audit:sitemap-canonicals
  audit:faqpage-validity
)
POST_BUILD_SHARD_2=(
  validate:spa-render
  audit:h1-title-duplicates
  validate:structured-data
  validate:sitemap-links
)
POST_BUILD_SHARD_3=(
  test:e2e:smoke
  audit:page-weight
  audit:title-length
  audit:title-no-disambig-hash
  validate:content-quality
  validate:canonical
)
POST_BUILD_SHARD_4=(
  validate:jobs-quality
  validate:jobposting-schema
  audit:orphan-sitemap-pages
  audit:hreflang
  gate:seo-source
)

# Print the task list for a given shard number (1-4) one per line.
print_post_build_shard() {
  local shard="$1"
  case "$shard" in
    1) printf '%s\n' "${POST_BUILD_SHARD_1[@]}" ;;
    2) printf '%s\n' "${POST_BUILD_SHARD_2[@]}" ;;
    3) printf '%s\n' "${POST_BUILD_SHARD_3[@]}" ;;
    4) printf '%s\n' "${POST_BUILD_SHARD_4[@]}" ;;
    *) echo "❌ Unknown shard: $shard (expected 1-4)" >&2; return 2 ;;
  esac
}
