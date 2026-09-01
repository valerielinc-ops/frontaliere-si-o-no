#!/usr/bin/env bash
set -euo pipefail

: "${ARTICLES_REPO_PAT:?ARTICLES_REPO_PAT is required for the corpus transport}"
: "${GITHUB_SHA:?GITHUB_SHA is required for a deduplicated transport branch}"

site_root=${GITHUB_WORKSPACE:-$(git rev-parse --show-toplevel)}
target_repo=nanakokyobashi-rgb/frontaliere-articles
target_owner=${target_repo%%/*}
target_name=${target_repo##*/}
target_url=${CRAWLER_SYNC_TARGET_URL:-https://github.com/${target_repo}.git}
branch_prefix=crawler-workflows-lockstep-
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

# Un'unica PR aperta e' il segnale di drift. Una run successiva continua quel
# branch; senza PR usa un branch deterministico per il commit sito, rendendo il
# retry della stessa consegna idempotente.
token_actor=$(gh api user --jq .login)
open_json=$(gh pr list --repo "$target_repo" --state open --limit 1000 \
  --json number,headRefName,baseRefName,headRepositoryOwner,headRepository,author,isCrossRepository \
  --jq "map(select(.headRefName | startswith(\"${branch_prefix}\")))")
open_count=$(printf '%s' "$open_json" | EXPECTED_OWNER="$target_owner" EXPECTED_NAME="$target_name" EXPECTED_AUTHOR="$token_actor" node -e '
let s=""; process.stdin.on("data", d => s += d).on("end", () => {
  const rows = JSON.parse(s);
  const valid = rows.filter(p => p.baseRefName === "main" &&
    p.headRepositoryOwner?.login === process.env.EXPECTED_OWNER &&
    p.headRepository?.name === process.env.EXPECTED_NAME &&
    p.author?.login === process.env.EXPECTED_AUTHOR &&
    p.isCrossRepository === false);
  if (valid.length !== rows.length) process.exit(3);
  console.log(valid.length);
})') || {
  echo '::error::crawler transport found a prefix-matching PR with unexpected base, owner, repository or author'
  exit 1
}
if [ "$open_count" -gt 1 ]; then
  echo "::error::found $open_count open crawler transport PRs; refusing to split or overwrite the signal"
  exit 1
fi
open_number=$(printf '%s' "$open_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0]?.number??""))')
target_branch=$(printf '%s' "$open_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0]?.headRefName??""))')
if [ -z "$target_branch" ]; then
  target_branch="${branch_prefix}${GITHUB_SHA:0:12}"
fi

git clone --filter=blob:none --no-checkout "$target_url" "$work/corpus"
cd "$work/corpus"
git sparse-checkout init --no-cone
git sparse-checkout set \
  '/.github/workflows/' \
  '/generator/data/crawler-cross-repo-contract.json' \
  '/generator/tests/crawler-cross-repo-artifacts.test.mjs' \
  '/scripts/ci/crawler-generation-observer-selector.mjs' \
  '/scripts/ci/lib/canonical-json-digest.mjs' \
  '/scripts/ci/lib/crawler-generation-observer-report.mjs' \
  '/scripts/ci/lib/crawler-generation-token.mjs' \
  '/scripts/ci/lib/github-actions-read-client.mjs' \
  '/scripts/ci/loop-sync-manifest.json'
git checkout main
git config user.name 'Valerie Linc'
git config user.email 'valerielinc@gmail.com'

remote_branch_exists=false
if git ls-remote --exit-code --heads origin "$target_branch" >/dev/null 2>&1; then
  remote_branch_exists=true
  git fetch origin "$target_branch:refs/remotes/origin/$target_branch"
  git checkout -b "$target_branch" "origin/$target_branch"
  git merge --no-edit origin/main
else
  git checkout -b "$target_branch"
fi

node "$site_root/scripts/ci/prepare-crawler-workflow-corpus-sync.mjs" \
  "$site_root/.github/corpus-workflows" "$PWD"
git show origin/main:scripts/ci/loop-sync-manifest.json | \
  node "$site_root/scripts/ci/prepare-crawler-workflow-corpus-sync.mjs" \
    --assert-manifest-delta "$PWD/scripts/ci/loop-sync-manifest.json"
git add -- \
  .github/workflows/crawler-group-*.yml \
  .github/workflows/crawler-generation-observer-shadow.yml \
  .github/workflows/translate-pending.yml \
  generator/data/crawler-cross-repo-contract.json \
  generator/tests/crawler-cross-repo-artifacts.test.mjs \
  scripts/ci/crawler-generation-observer-selector.mjs \
  scripts/ci/lib/canonical-json-digest.mjs \
  scripts/ci/lib/crawler-generation-observer-report.mjs \
  scripts/ci/lib/crawler-generation-token.mjs \
  scripts/ci/lib/github-actions-read-client.mjs \
  scripts/ci/loop-sync-manifest.json

allowed='^(\.github/workflows/crawler-group-(0[1-9]|1[0-9]|2[0-3])\.yml|\.github/workflows/crawler-generation-observer-shadow\.yml|\.github/workflows/translate-pending\.yml|generator/data/crawler-cross-repo-contract\.json|generator/tests/crawler-cross-repo-artifacts\.test\.mjs|scripts/ci/crawler-generation-observer-selector\.mjs|scripts/ci/lib/(canonical-json-digest|crawler-generation-observer-report|crawler-generation-token|github-actions-read-client)\.mjs|scripts/ci/loop-sync-manifest\.json)$'
bad=$(git diff --cached --name-only | grep -vE "$allowed" || true)
if [ -n "$bad" ]; then
  echo '::error::crawler transport staged a path outside its exact allowlist'
  printf '%s\n' "$bad" | sed 's/^/  offending: /'
  exit 1
fi
deleted=$(git diff --cached --diff-filter=D --name-only)
if [ -n "$deleted" ]; then
  echo '::error::crawler transport refuses artifact deletion; source may be truncated'
  printf '%s\n' "$deleted" | sed 's/^/  deleting: /'
  exit 1
fi

if ! git diff --cached --quiet; then
  git commit -m "Lockstep crawler workflows with frontaliere-si-o-no@${GITHUB_SHA:0:8}"
else
  echo 'Delivery commit already exists on the remote branch; ensuring its PR after a prior partial failure.'
fi

# Il guard decisivo è sull'INTERO delta della branch, non solo sullo staged di
# questa run: una branch orfana/PR preesistente non può contrabbandare file che
# il preparatore di oggi non ha toccato. Il test dedicato è un observer hashato
# e trasportato; nessun file corpus-only o altro path corpus è ammesso.
full_allowed='^(\.github/workflows/crawler-group-(0[1-9]|1[0-9]|2[0-3])\.yml|\.github/workflows/crawler-generation-observer-shadow\.yml|\.github/workflows/translate-pending\.yml|generator/data/crawler-cross-repo-contract\.json|generator/tests/crawler-cross-repo-artifacts\.test\.mjs|scripts/ci/crawler-generation-observer-selector\.mjs|scripts/ci/lib/(canonical-json-digest|crawler-generation-observer-report|crawler-generation-token|github-actions-read-client)\.mjs|scripts/ci/loop-sync-manifest\.json)$'
full_bad=$(git diff --name-only origin/main...HEAD | grep -vE "$full_allowed" || true)
if [ -n "$full_bad" ]; then
  echo '::error::crawler transport branch contains paths outside its complete allowlist'
  printf '%s\n' "$full_bad" | sed 's/^/  offending: /'
  exit 1
fi
full_deleted=$(git diff --diff-filter=D --name-only origin/main...HEAD)
if [ -n "$full_deleted" ]; then
  echo '::error::crawler transport branch contains deletions in its complete delta'
  printf '%s\n' "$full_deleted" | sed 's/^/  deleting: /'
  exit 1
fi

# Il no-op arriva soltanto DOPO il guard completo: una branch con payload già
# allineato ma un file estraneo non può sfruttare questa uscita per restare verde.
if git diff --quiet origin/main...HEAD; then
  echo 'Crawler workflow corpus transport already in sync on main.'
  exit 0
fi

# Solo dopo aver validato l'intero delta locale. Una branch remota contaminata
# viene quindi rifiutata senza mutare né la branch né la PR esistente.
if [ "$remote_branch_exists" = false ] || ! git diff --quiet "origin/$target_branch" HEAD; then
  git push -u origin "HEAD:$target_branch"
else
  echo 'Remote delivery branch already contains this commit; ensuring its PR.'
fi

body="$work/pr-body.md"
cat > "$body" <<'BODY'
## Implementato

- in questa PR: sincronizzati atomicamente i 24 workflow crawler eseguibili, il contratto hash del generatore, i sei observer dedicati e le 31 baseline del loop-sync manifest dalla sorgente portabile del sito; il diff è limitato da allowlist fail-closed.
- in questa PR: la branch di consegna viene aggiornata senza push su `main`; test, review automatica e auto-merge `## LGTM` del corpus restano obbligatori prima che la schedulazione cambi.

## Non implementato (ancora)

- by construction: nessun dato del corpus, engine o host viene copiato; il trasporto può toccare soltanto i 24 artifact, il loro contratto, l'observer dedicato e le baseline corrispondenti.
- per scelta: nessun merge diretto o manuale; la PR rimane aperta finché il ciclo autonomo del corpus non la approva.
BODY

head_ref=$(git rev-parse --abbrev-ref HEAD)
if [ -n "$open_number" ]; then
  # Non riscrivere il body: review finding, Closes e contesto aggiunti dopo la
  # creazione appartengono all'orchestratore e devono sopravvivere agli schedule.
  echo "Crawler workflow transport PR #$open_number already open; branch updated without replacing its body."
else
  gh pr create --repo "$target_repo" --base main --head "$head_ref" \
    --title 'Lockstep crawler workflows with the site' --body-file "$body"
fi
