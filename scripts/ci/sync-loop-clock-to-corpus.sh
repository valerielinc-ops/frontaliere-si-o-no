#!/usr/bin/env bash
set -euo pipefail

: "${ARTICLES_REPO_PAT:?ARTICLES_REPO_PAT is required for the loop-clock corpus transport}"
: "${GITHUB_SHA:?GITHUB_SHA is required for a deterministic transport branch}"

site_root=${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel)}
target_repo=nanakokyobashi-rgb/frontaliere-articles
target_url=${LOOP_CLOCK_CORPUS_URL:-https://github.com/${target_repo}.git}
target_branch=loop-clock-contract-sync
target_path=.github/workflows/issue-triage.yml
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

askpass="$work/askpass.sh"
cat > "$askpass" <<'ASKPASS'
#!/usr/bin/env bash
case "$1" in
  *Username*) printf '%s\n' x-access-token ;;
  *Password*) printf '%s\n' "$ARTICLES_REPO_PAT" ;;
esac
ASKPASS
chmod 700 "$askpass"
export GIT_ASKPASS="$askpass" GIT_TERMINAL_PROMPT=0 GH_TOKEN="$ARTICLES_REPO_PAT"

# A transport branch is shared by retries. Refuse a PR that happens to use the
# same branch name from a fork or a different actor, rather than mutating it.
token_actor=$(gh api user --jq .login)
open_json=$(gh pr list --repo "$target_repo" --state open --limit 100 \
  --head "$target_branch" \
  --json number,baseRefName,headRefName,headRepositoryOwner,headRepository,author,isCrossRepository)
open_count=$(printf '%s' "$open_json" | EXPECTED_OWNER="${target_repo%%/*}" EXPECTED_NAME="${target_repo##*/}" EXPECTED_AUTHOR="$token_actor" EXPECTED_BRANCH="$target_branch" node -e '
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const rows = JSON.parse(input);
  const valid = rows.filter((pr) => pr.baseRefName === "main" &&
    pr.headRefName === process.env.EXPECTED_BRANCH &&
    pr.headRepositoryOwner?.login === process.env.EXPECTED_OWNER &&
    pr.headRepository?.name === process.env.EXPECTED_NAME &&
    pr.author?.login === process.env.EXPECTED_AUTHOR &&
    pr.isCrossRepository === false);
  if (valid.length !== rows.length) process.exit(3);
  console.log(valid.length);
})') || {
  echo '::error::loop-clock transport found an unexpected open PR for its deterministic branch'
  exit 1
}
if [ "$open_count" -gt 1 ]; then
  echo '::error::more than one loop-clock transport PR is open; refusing to split the delivery'
  exit 1
fi

git clone --filter=blob:none --no-checkout "$target_url" "$work/corpus"
cd "$work/corpus"
git sparse-checkout init --no-cone
git sparse-checkout set "/$target_path"
git fetch origin main

if git ls-remote --exit-code --heads origin "$target_branch" >/dev/null 2>&1; then
  git fetch origin "$target_branch"
  git checkout -B "$target_branch" FETCH_HEAD
  git merge --no-edit origin/main
else
  git checkout -B "$target_branch" origin/main
fi

node "$site_root/scripts/ci/patch-corpus-loop-clock-workflow.mjs" --file "$target_path"
git diff --check
git add -- "$target_path"

assert_transport_delta() {
  local changed
  changed=$(git diff --name-only origin/main...HEAD)
  if [ -n "$changed" ] && [ "$changed" != "$target_path" ]; then
    echo '::error::loop-clock transport branch contains a path outside the single workflow target'
    printf '%s\n' "$changed"
    exit 1
  fi
  local deleted
  deleted=$(git diff --diff-filter=D --name-only origin/main...HEAD)
  if [ -n "$deleted" ]; then
    echo '::error::loop-clock transport branch contains a deletion'
    printf '%s\n' "$deleted"
    exit 1
  fi
}

# A retry can inherit a branch whose target is already patched. Validate the
# complete committed delta before treating that as a no-op; otherwise an old
# unrelated commit on the shared transport branch could be hidden by the
# early exit below.
assert_transport_delta

staged=$(git diff --cached --name-only)
if [ -n "$staged" ] && [ "$staged" != "$target_path" ]; then
  echo '::error::loop-clock transport staged a path outside the single workflow target'
  printf '%s\n' "$staged"
  exit 1
fi

if git diff --cached --quiet; then
  committed=$(git diff --name-only origin/main...HEAD)
  if [ -z "$committed" ]; then
    if [ "$open_count" -gt 0 ]; then
      echo 'Corpus issue-triage workflow already carries the loop-clock contract in its open PR.'
    else
      echo 'Corpus issue-triage workflow already carries the loop-clock contract; no transport PR is needed.'
    fi
    exit 0
  fi
  echo 'Corpus issue-triage workflow contract is already committed on the transport branch; delivering its PR.'
else
  git config user.name 'frontaliere-automation[bot]'
  git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
  git commit -m 'fix(ci): identify corpus loop-clock triage dispatches'
fi

assert_transport_delta
git push -u origin "HEAD:$target_branch"
body="$work/pr-body.md"
cat > "$body" <<'BODY'
## Implementato

- in questa PR: aggiunge a `.github/workflows/issue-triage.yml` l'input `loop_clock` e il `run-name` marcato che il dispatcher esterno usa per identificare il dispatch `corpus-triage-sweep`.
- in questa PR: preserva tutti gli altri trigger e job del workflow; il trasporto modifica esclusivamente questo file.
- in questa PR: applica il contratto di osservabilità della sorgente, secondo VISION D1/D2: il watchdog può distinguere un dispatch reale da cron e run manuali senza allargare la misura.

## Non implementato (ancora)

Nessuno
BODY

set +e
node "$site_root/scripts/ci/pr-body-check-gate.mjs" --body-file "$body"
gate_status=$?
set -e
if [ "$gate_status" -eq 2 ]; then
  echo '::error::loop-clock transport body PR non conforme; scrittura bloccata'
  exit 2
elif [ "$gate_status" -ne 0 ]; then
  echo "::error::loop-clock transport body PR non verificabile (gate exit $gate_status); branch gia' pushato, nessuna PR scritta"
  exit "$gate_status"
fi

if [ "$open_count" -eq 0 ]; then
  gh pr create --repo "$target_repo" --base main --head "$target_branch" \
    --title 'fix(ci): identify corpus loop-clock triage dispatches' --body-file "$body"
else
  echo "Loop-clock corpus transport PR already open for $target_branch; branch updated."
fi
