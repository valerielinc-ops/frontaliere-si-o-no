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
  [[ "$val" =~ ^[0-9]+$ ]] || val=0
  printf '%s' "$val"
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

# shard_pat_push <push_dir> <shard_repo> <refspec> [label] [force]
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
shard_pat_push() {
  local dir="$1" repo="$2" refspec="$3" label="${4:-shard}" force="${5:-1}"
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
  echo "$label: retrying over HTTPS with a PAT (deploy-key push did not succeed)"
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
    echo "::warning::$label: pushed via the PAT fallback — the deploy key for this shard is broken (never registered on the repo, read-only, revoked, or a shadowed secret). Fix the key; the fallback is a safety net, not the intended path."
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
  local delay="${SHARD_PUSH_RETRY_DELAY:-5}" try out rc
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
  shard_pat_push "$dir" "$repo" "$refspec" "$label"
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
