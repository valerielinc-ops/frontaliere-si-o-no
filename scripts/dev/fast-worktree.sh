#!/usr/bin/env bash
# Crea un worktree sparse in pochi secondi invece di materializzare 6,7 GB.
#
# Perche'. Un `git worktree add` normale scrive tutti i 41'707 file tracciati
# (6,7 GB), perche' `public/images` (14'016 file, 4,4 GB) e `data/` (1,9 GB)
# sono versionati. Con quattro agent in parallelo sono ~27 GB di checkout
# duplicato per un lavoro che tocca `scripts/` e `build-plugins/`. Misurato qui:
# 214 MB / 6'970 file in ~3s.
#
# I percorsi esclusi sono gli stessi che i workflow escludono in CI: la lista
# viene letta da scripts/ci/checkout-buckets.json, quindi c'e' UNA sorgente di
# verita' sola. Se domani una cartella pesante nasce o sparisce, si rigenera
# quella tabella e sia la CI sia questo script la seguono.
#
#   scripts/dev/fast-worktree.sh <nome> [--base origin/main] [--add <path>]...
#   scripts/dev/fast-worktree.sh fix-5995 --add data/health-premiums
#
# `--add` re-include un percorso escluso (accetta anche un singolo file).
# Serve un file che non avevi previsto? Non ricreare il worktree:
#   git sparse-checkout add <path>
#
# Nota bash 3.2 (il /bin/bash di macOS): niente array associativi, niente
# `timeout`, niente `mapfile`.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

NAME=""
BASE="origin/main"
ADDS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="$2"; shift 2 ;;
    --add)  ADDS="$ADDS $2"; shift 2 ;;
    --help|-h) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "opzione sconosciuta: $1" >&2; exit 2 ;;
    *) NAME="$1"; shift ;;
  esac
done
[ -n "$NAME" ] || { echo "uso: $0 <nome> [--base <ref>] [--add <path>]..." >&2; exit 2; }

WT_DIR=".claude/worktrees/$NAME"
[ -e "$WT_DIR" ] && { echo "esiste gia': $WT_DIR" >&2; exit 1; }

START=$(date +%s)

# Il fetch della base: senza, `origin/main` puo' essere di giorni fa e il
# worktree nasce vecchio senza dirlo.
case "$BASE" in
  origin/*) git fetch --quiet origin "${BASE#origin/}" 2>/dev/null || true ;;
esac

# --no-checkout e' obbligatorio: senza, git scrive l'albero pieno PRIMA che si
# possa applicare la sparsita', e i 6,7 GB li hai gia' pagati.
git worktree add --no-checkout -b "$NAME" "$WT_DIR" "$BASE" >/dev/null

PATTERNS=$(node -e '
const t = require("./scripts/ci/checkout-buckets.json");
const out = ["/*", ...t.buckets.map(b => "!/" + b.id)];
process.stdout.write(out.join("\n") + "\n");
')
for p in $ADDS; do PATTERNS="$PATTERNS
/${p#/}"; done

cd "$WT_DIR"
printf '%s\n' "$PATTERNS" | git sparse-checkout set --no-cone --stdin
git checkout --quiet

# Verifica, non fiducia. Un checkout pieno mascherato da sparse e' gia'
# successo su questa macchina (15-08: `--no-checkout` che materializza tutto
# lo stesso), e senza controllo te ne accorgi solo dal disco pieno.
FAILED=""
for d in public/images data/jobs packages/articles/content; do
  case " $ADDS " in *" $d "*) continue ;; esac
  [ -e "$d" ] && FAILED="$FAILED $d"
done
if [ -n "$FAILED" ]; then
  echo "⚠️  la sparsita' NON e' stata applicata: materializzato$FAILED" >&2
  echo "    il worktree resta, ma occupa quanto un checkout pieno." >&2
  exit 1
fi

# node_modules condiviso: `npm install` qui dentro sarebbe 1,7 GB duplicati.
if [ -d "$REPO_ROOT/node_modules" ] && [ ! -e node_modules ]; then
  ln -s "$REPO_ROOT/node_modules" node_modules
fi

SIZE=$(du -sh . 2>/dev/null | cut -f1)
FILES=$(find . -path ./.git -prune -o -type f -print 2>/dev/null | wc -l | tr -d ' ')
echo "✅ $WT_DIR — $SIZE, $FILES file, $(($(date +%s) - START))s (albero pieno: 6,7 GB / 41'707 file)"
echo "   branch $NAME da $BASE"
echo "   manca un percorso? git sparse-checkout add <path>   (non serve ricreare il worktree)"
