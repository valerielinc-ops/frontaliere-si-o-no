#!/usr/bin/env bash
# Misura quanti file attraversano ownership/merge/integrita' in un commit
# `--slice-only <dir>/` quando N slice sono GIA' pubblicati (HEAD non avanza) e
# solo K cambiano davvero. Uso: measure-commit-skip-identical.sh <git-commit-data.sh> [N] [K]
# Richiede bash >= 4 (lo script misurato usa array associativi).
set -euo pipefail
# Slice nel formato canonico (2 spazi + newline finale): il commit lo ripubblica
# byte-identico, come fanno i writer reali.
slice() { # key [with-locale]
  if [ "${2:-}" = 1 ]; then
    printf '{\n  "companyKey": "%s",\n  "jobs": [\n    {\n      "url": "https://j.example/%s/1",\n      "title": "J",\n      "titleByLocale": {\n        "en": "E"\n      }\n    }\n  ]\n}\n' "$1" "$1"
  else
    printf '{\n  "companyKey": "%s",\n  "jobs": [\n    {\n      "url": "https://j.example/%s/1",\n      "title": "J"\n    }\n  ]\n}\n' "$1" "$1"
  fi
}
SCRIPT="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
N="${2:-40}"; K="${3:-2}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
git init -q --bare --initial-branch=main "$T/origin"
git clone -q "$T/origin" "$T/repo" 2>/dev/null
cd "$T/repo"; git config user.email t@example.com; git config user.name T
mkdir -p data/jobs/by-crawler
for i in $(seq 1 "$N"); do
  slice "k$i" > "data/jobs/by-crawler/k$i.json"
done
git add .; git commit -q -m seed; git push -q origin HEAD:main
run() {
  env SKIP_AI_TRANSLATION=1 GH_TOKEN= GITHUB_TOKEN= GITHUB_RUN_ID= GITHUB_REPOSITORY= GITHUB_OUTPUT= \
    SLUG_HISTORY_SUMMARY_FILE="$T/none" JOBS_HOUSEKEEPING_PROOF_DIR="$T/noproof" \
    bash "$SCRIPT" --slice-only "measure" data/jobs/by-crawler/ 2>&1
}
# Primo commit della run: N-K slice modificati e pubblicati.
for i in $(seq 1 $((N - K))); do
  slice "k$i" 1 > "data/jobs/by-crawler/k$i.json"
done
run >/dev/null
# Commit successivo, HEAD invariato: cambiano solo K slice.
for i in $(seq $((N - K + 1)) "$N"); do
  slice "k$i" 1 > "data/jobs/by-crawler/k$i.json"
done
run | grep -E 'file\(s\) (computed|skipped)' | sed 's/^ℹ️ //'
