#!/usr/bin/env bash
# UNICO scrittore di data/build-history/memory-peaks.jsonl per run di deploy.
#
# Le gambe del matrix build-locale mettono le loro righe in staging
# (scripts/lib/append-build-history-row.sh) e le caricano come artifact
# build-history-rows-<locale>-<attempt>. Il job build-history-commit di
# deploy.yml le scarica tutte sotto una cartella e chiama questo script, che:
#   1. concatena i file di staging in ordine di percorso (deterministico);
#   2. scarta, dichiarandole, le righe che non sono un oggetto JSON (un
#      artifact troncato non deve corrompere lo storico);
#   3. appende solo le righe che lo storico non contiene gia' (riga identica):
#      il rerun di una gamba riscarica gli artifact delle gambe che non sono
#      state rifatte, e il loro commit e' gia' su main;
#   4. fa UN commit e lo pusha con il retry condiviso. Su conflitto di rebase
#      l'append viene rifatto da capo su origin/main aggiornato
#      (--regenerate-cmd), invece di rebasare un checkout sporco.
#
# Uso:
#   HISTORY_ROWS_DIR=<dir> [HISTORY_COMMIT_MSG=<msg>] \
#     bash scripts/lib/commit-build-history-rows.sh
#   bash scripts/lib/commit-build-history-rows.sh append <righe-unite.jsonl>
#     (solo append + stage: e' il comando di rigenerazione del push)
set -euo pipefail

history_path='data/build-history/memory-peaks.jsonl'
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Appende a $history_path le righe di $1 che non ci sono gia' e le mette in
# stage. Idempotente: rieseguito sullo stesso file non aggiunge niente.
append_new_rows() {
  local merged="$1"
  local fresh
  fresh="$(mktemp)"
  mkdir -p "$(dirname "$history_path")"
  node scripts/ci/assert-accumulator-write.mjs "$history_path"
  # getline su un file assente restituisce -1: lo storico vuoto e' gestito
  # senza il trucco NR==FNR, che con il primo file vuoto si rompe.
  awk -v hist="$history_path" '
    BEGIN { while ((getline line < hist) > 0) seen[line] = 1 }
    !($0 in seen) { seen[$0] = 1; print }
  ' "$merged" > "$fresh"
  local added
  added="$(wc -l < "$fresh" | tr -d ' ')"
  if [ "$added" -gt 0 ]; then
    # Un file che non finisce con un a-capo incollerebbe la prima riga nuova
    # all'ultima vecchia.
    if [ -s "$history_path" ] && [ -n "$(tail -c1 "$history_path")" ]; then
      printf '\n' >> "$history_path"
    fi
    cat "$fresh" >> "$history_path"
  fi
  rm -f -- "$fresh"
  node scripts/ci/assert-accumulator-write.mjs "$history_path"
  echo "[build-history-commit] righe nuove appese: $added"
  git add -- "$history_path"
}

if [ "${1:-}" = "append" ]; then
  append_new_rows "${2:?usage: commit-build-history-rows.sh append <file>}"
  exit 0
fi

rows_dir="${HISTORY_ROWS_DIR:?HISTORY_ROWS_DIR non impostata}"
commit_msg="${HISTORY_COMMIT_MSG:-chore(build-history): append rows run ${GITHUB_RUN_ID:-local}}"

# Ricorsivo: download-artifact senza merge-multiple mette ogni artifact nella
# sua sottocartella. Unire in una cartella sola farebbe sovrascrivere fra loro
# i file omonimi di due tentativi della stessa gamba.
row_files=()
while IFS= read -r file; do
  row_files+=("$file")
done < <(find "$rows_dir" -type f -name '*.jsonl' 2>/dev/null | LC_ALL=C sort)
if [ "${#row_files[@]}" -eq 0 ]; then
  echo "::warning::[build-history-commit] nessun file di righe in $rows_dir: nessuna gamba ha caricato build-history-rows-* (gambe morte prima dell'upload, o run cancellata)"
  exit 0
fi

# Il file unito vive FUORI dal checkout: il reset a origin/main del ramo di
# rigenerazione non deve poterlo cancellare.
merged="$(mktemp)"
echo "[build-history-commit] righe per file di staging:"
for file in "${row_files[@]}"; do
  echo "  ${file#"$rows_dir"/}: $(grep -c '' "$file")"
done
# Un a-capo dopo ogni file: un artifact troncato senza a-capo finale non deve
# incollare la sua ultima riga alla prima del file successivo.
for file in "${row_files[@]}"; do
  cat -- "$file"
  printf '\n'
done | node -e '
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { raw += chunk; });
  process.stdin.on("end", () => {
    let dropped = 0;
    const out = [];
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let value;
      try { value = JSON.parse(line); } catch { value = undefined; }
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        dropped += 1;
        continue;
      }
      out.push(line);
    }
    if (dropped > 0) {
      console.error(`::warning::[build-history-commit] ${dropped} riga/e non JSON scartate dagli artifact di staging`);
    }
    process.stdout.write(out.map((line) => `${line}\n`).join(""));
  });
' > "$merged"

git config user.name "build-history-bot"
git config user.email "build-history-bot@frontaliereticino.ch"
append_new_rows "$merged"

unexpected_paths="$(git diff --cached --name-only | grep -Fvx -- "$history_path" || true)"
if [ -n "$unexpected_paths" ]; then
  echo "::error::[build-history-commit] refusing to commit staged paths outside $history_path"
  printf '%s\n' "$unexpected_paths" | sed 's/^/  unexpected: /'
  exit 1
fi
if git diff --cached --quiet -- "$history_path"; then
  echo "[build-history-commit] nessuna riga nuova rispetto a main: niente da committare"
  exit 0
fi
git commit --only -m "$commit_msg" -- "$history_path"

regenerate_cmd="bash scripts/lib/commit-build-history-rows.sh append $(printf '%q' "$merged")"
bash "$script_dir/git-push-with-retry.sh" --max-attempts 5 --regenerate-cmd "$regenerate_cmd"
