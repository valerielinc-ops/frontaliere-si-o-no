#!/usr/bin/env bash
# Mette in STAGING una riga JSON (letta da stdin) destinata a
# data/build-history/memory-peaks.jsonl. Non tocca git.
#
# Fino a #9247 questo script appendeva, committava e pushava su main dentro
# ogni gamba del matrix build-locale: tre produttori x quattro gambe = dodici
# push concorrenti per run, in gara fra loro e con ogni altro scrittore di main.
# Il push respinto rifaceva il rebase di un checkout grande nel percorso critico
# della gamba: run 37107091990, step "Append build memory history row" a 37,8
# min sulla gamba it (34,5 de, 32,9 fr), e quattro righe perse dietro il
# continue-on-error. Ora la gamba scrive solo un file locale; lo step
# "Upload build-history rows" lo carica come artifact e il job
# build-history-commit, dopo tutte le gambe, fa UN commit per run
# (scripts/lib/commit-build-history-rows.sh). Nessuna contesa sulla gamba.
#
# Il formato delle righe non cambia: la riga arriva gia' serializzata dallo
# step chiamante e viene solo validata (un oggetto JSON su una riga).
#
# Env:
#   HISTORY_STAGE_DIR  cartella di staging (obbligatoria; in CI
#                      ${{ runner.temp }}/build-history-rows)
#   HISTORY_LABEL      tipo di riga e prefisso del file (default: build-history)
#   HISTORY_LOCALE     gamba del matrix (default: $ROW_LOCALE)
#
# Scrive in append "$HISTORY_STAGE_DIR/<HISTORY_LABEL>-<HISTORY_LOCALE>.jsonl".
set -euo pipefail

row="$(cat)"
label="${HISTORY_LABEL:-build-history}"
if [ -z "$row" ]; then
  echo "[$label] nessuna riga da appendere"
  exit 0
fi

stage_dir="${HISTORY_STAGE_DIR:-}"
if [ -z "$stage_dir" ]; then
  echo "::error::[$label] HISTORY_STAGE_DIR non impostata: la riga non ha dove andare"
  exit 1
fi
locale="${HISTORY_LOCALE:-${ROW_LOCALE:-}}"

# Label e locale finiscono nel nome del file: niente separatori di percorso.
for part in "$label" "$locale"; do
  if ! [[ "$part" =~ ^[a-z0-9][a-z0-9-]*$ ]]; then
    echo "::error::[$label] label/locale non validi per il file di staging: '$part'"
    exit 1
  fi
done

# Una riga JSONL e' una riga: un a-capo interno spezzerebbe il file in due
# righe non JSON quando il job di commit le concatena.
if [[ "$row" == *$'\n'* ]]; then
  echo "::error::[$label] la riga contiene un a-capo: rifiutata"
  exit 1
fi
if ! printf '%s' "$row" | node -e '
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    let value;
    try { value = JSON.parse(raw); } catch { process.exit(1); }
    if (value === null || typeof value !== "object" || Array.isArray(value)) process.exit(1);
  });
'; then
  echo "::error::[$label] la riga non e' un oggetto JSON: rifiutata"
  exit 1
fi

mkdir -p "$stage_dir"
stage_file="$stage_dir/$label-$locale.jsonl"
printf '%s\n' "$row" >> "$stage_file"
echo "[$label] riga in staging in $stage_file (commit unico nel job build-history-commit)"
