#!/usr/bin/env bash
# Appende UNA riga JSON (letta da stdin) a data/build-history/memory-peaks.jsonl
# e la pusha su main con il retry-con-rebase condiviso.
#
# Estratto dallo step "Append build memory history row" di deploy.yml quando
# e' arrivato un SECONDO produttore di righe ("Append post-build phase timings
# row", issue #7301): le fasi post-build — push degli shard di sezione e pack
# tar — finiscono DOPO quello step, quindi non possono essere chiavi della sua
# riga, e senza questo script i due step duplicherebbero identiche le ~25
# righe di commit + pull --rebase + backoff. Un solo posto da correggere se il
# backoff cambia.
#
# Il retry (5 tentativi, backoff 5/10/15/25/40s) e' lo stesso di "Commit
# dist-size-history row": i 4 leg del matrix scrivono in concorrenza e gli
# altri produttori su main (crawlers/thin-promotions/fuel/weather) out-race
# regolarmente una finestra piu' corta.
#
# Env:
#   HISTORY_COMMIT_MSG  messaggio di commit (obbligatorio)
#   HISTORY_LABEL       prefisso dei log diagnostici (default: build-history)
set -euo pipefail

row="$(cat)"
label="${HISTORY_LABEL:-build-history}"
if [ -z "$row" ]; then
  echo "[$label] nessuna riga da appendere"
  exit 0
fi

history_path='data/build-history/memory-peaks.jsonl'
mkdir -p data/build-history
# The deploy checkout contains the prepared data snapshot as dirty state. Guard
# the accumulator before and after appending so a degraded read cannot turn the
# telemetry checkpoint into a destructive rewrite.
node scripts/ci/assert-accumulator-write.mjs "$history_path"
printf '%s\n' "$row" >> "$history_path"
node scripts/ci/assert-accumulator-write.mjs "$history_path"

git config user.name "build-history-bot"
git config user.email "build-history-bot@frontaliereticino.ch"
git add -- "$history_path"
unexpected_paths="$(git diff --cached --name-only | grep -Fvx -- "$history_path" || true)"
if [ -n "$unexpected_paths" ]; then
  echo "::error::[$label] refusing to commit staged paths outside $history_path"
  printf '%s\n' "$unexpected_paths" | sed 's/^/  unexpected: /'
  exit 1
fi
# `--only` is intentional: the build leaves a generated data snapshot in the
# checkout, and a broad `git commit` can pull those staged bytes into this
# append-only history commit.
git commit --only -m "$HISTORY_COMMIT_MSG" -- "$history_path"
bash scripts/lib/git-push-with-retry.sh --max-attempts 5 --stash-dirty
