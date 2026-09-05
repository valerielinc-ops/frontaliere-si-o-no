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
set -uo pipefail

row="$(cat)"
label="${HISTORY_LABEL:-build-history}"
if [ -z "$row" ]; then
  echo "[$label] nessuna riga da appendere"
  exit 0
fi

mkdir -p data/build-history
printf '%s\n' "$row" >> data/build-history/memory-peaks.jsonl

git config user.name "build-history-bot"
git config user.email "build-history-bot@frontaliereticino.ch"
git add data/build-history/memory-peaks.jsonl
git commit -m "$HISTORY_COMMIT_MSG"
bash scripts/lib/configure-main-push-auth.sh
for i in 1 2 3 4 5; do
  if git -c rebase.autoStash=true -c rebase.backend=merge \
      pull --rebase origin main \
      && git push origin HEAD:main; then
    echo "[$label] pushed on attempt $i"
    exit 0
  fi
  git rebase --abort 2>/dev/null || true
  case "$i" in
    1) sleep 5 ;;
    2) sleep 10 ;;
    3) sleep 15 ;;
    4) sleep 25 ;;
    5) sleep 40 ;;
  esac
done
echo "::warning::[$label] push failed after 5 attempts — this row will not be in history"
