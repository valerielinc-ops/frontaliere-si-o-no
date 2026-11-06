#!/usr/bin/env bash
# Shared classification of a failed `git push` to this repository's GitHub
# branches. Sourced (not executed) by scripts/lib/git-push-with-retry.sh and
# scripts/lib/git-commit-data.sh, whose retry loops rebase and push again on
# a rejection.

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
  printf '%s' "${1:-}" | grep -qE 'error: GH0(13|06):|push declined due to repository rule violations'
}
