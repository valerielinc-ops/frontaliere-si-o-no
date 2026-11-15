#!/usr/bin/env bash
# Shared classification of a failed `git push` to this repository's GitHub
# branches. Sourced (not executed) by scripts/lib/git-push-with-retry.sh and
# scripts/lib/git-commit-data.sh, whose retry loops rebase and push again on
# a rejection.
#
# Two permanent classes, both decided by GitHub from the pushed content or the
# pushing identity, never by a ref race:
#   - GH013 / GH006: a repository ruleset or protected-branch rule declined it.
#   - GH001: a blob in the pushed commit exceeds GitHub's 100 MB file limit
#     (`remote: error: File data/url-first-seen.json is 213.54 MB; this exceeds
#     GitHub's file size limit of 100.00 MB` / `GH001: Large files detected`).
#     A rebase keeps the same blob, so run 43692928043 rebased and re-pushed it
#     five times for nothing.

# git_push_rejection_is_permanent <push output>
# True when GitHub declined the push through a repository ruleset (GH013) or a
# classic protected-branch rule (GH006). That is a verdict on the pushing
# identity or on the commit itself, not a lost ref race: a fetch + rebase
# changes neither, so every further attempt is declined the same way. After
# the move to actions/checkout@v7 the main writers retried it 40 times
# (persist-job-stats run 36784759656, ~16 min) or 14 times
# (recover-prev-slugs run 36759949398), and traffic-scheduler.yml spent its
# whole 15-minute cap on it (run 36827826194), ending `cancelled` so its
# `if: failure()` reporter never ran.
#
# Deliberately narrow: a `fetch first` / non-fast-forward rejection, a
# `cannot lock ref` race and transport errors are NOT matched — those are the
# cases a retry exists for. Only GitHub's own error codes and the
# `! [remote rejected] … (push declined due to repository rule violations)`
# summary line count.
git_push_rejection_is_permanent() {
  printf '%s' "${1:-}" | grep -qE 'error: GH0(13|06):|push declined due to repository rule violations|error: GH001:|exceeds GitHub.s file size limit'
}

# git_push_rejection_is_file_size <push output>
# True for the GH001 / file-size-limit refusal specifically, so a caller can
# say what is wrong instead of blaming a ruleset. Always a subset of
# git_push_rejection_is_permanent.
git_push_rejection_is_file_size() {
  printf '%s' "${1:-}" | grep -qE 'error: GH001:|exceeds GitHub.s file size limit'
}

# git_push_rejection_reason <push output>
# One sentence naming the permanent class, for the ::error / log line of the
# caller that stops retrying.
git_push_rejection_reason() {
  if git_push_rejection_is_file_size "${1:-}"; then
    printf '%s' "a file in the commit exceeds GitHub's 100 MB file size limit (GH001): the same blob is pushed again by every retry, so rebasing cannot change the verdict. Find the path in the 'remote: error: File ...' line above; a growing accumulator must be sharded or pruned"
  else
    printf '%s' "declined by a repository rule (GH013/GH006): not a ref race, rebasing cannot change the verdict. Check the pushing identity (scripts/lib/configure-main-push-auth.sh) or the ruleset"
  fi
}
