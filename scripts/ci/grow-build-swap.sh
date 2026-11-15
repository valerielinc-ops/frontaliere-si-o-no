#!/usr/bin/env bash
# grow-build-swap.sh — lo swapfile del build, in UN posto solo.
#
# Perche' esiste (#6134 → PR #6150 → review): il tetto V8 di `build:ci` e' a
# 14336 MB su runner da 15,99 GB, e regge solo se l'host ha capacita' di
# evizione (il grafo Vite/Rollup ~4 GB resta fermo per tutta la fase SSG e
# puo' vivere in swap). La PR #6150 aveva copiato lo step inline in 3 job di
# 2 workflow, lasciando SCOPERTI gli altri due workflow che lanciano
# `npm run build:ci` (post-build-matrix-test, matrix-equivalence-check) e
# duplicando 3 volte la coppia di literal «8G / 12288». Questo script e'
# l'unica sorgente dei numeri; i workflow lo chiamano dopo il Checkout.
#
# Fail-open DI PROPOSITO: se /mnt manca o e' pieno, qui esce 0 con un
# ::warning. Il fail-closed sta dal lato giusto — dentro il processo di
# build: il preflight di buildMemoryGuard (resolvePreflight) fa fallire in
# 5 secondi, con un errore nominato, qualunque build:ci parta col tetto
# alzato senza lo swap che questo script doveva creare. Cosi' un'immagine
# runner che cambia produce una diagnosi, non un warning che nessuno legge
# seguito da un OOM 40 minuti dopo.
#
# UN TOTALE, non una taglia fissa (W0-G, 2026-11-14). Lo script creava sempre
# +8 GB sopra lo swap gia' presente sull'immagine. Ma lo swap dell'immagine
# varia (ubuntu-latest sta migrando a 26.04): il 2026-11-14 il leg en della run
# 43520109946 e' partito con 8191 MB totali invece dei 11263 attesi, il
# preflight ha fermato il build, e per le altre immagini la somma poteva
# superare il necessario senza che nessuno lo vedesse. Ora l'obiettivo e' il
# TOTALE: si legge SwapTotal da /proc/meminfo e si crea soltanto la differenza
# fino a TARGET_TOTAL_GB. Lo stesso numero giustifica il preflight di
# buildMemoryGuard (PREFLIGHT_MIN_SWAP_MB = 10240 resta il pavimento: 2 GiB
# sotto il target, cosi' una immagine che arrotonda non lo fa scattare).

set -euo pipefail

# L'UNICA costante: lo swap TOTALE che il build si aspetta (RAM esclusa).
TARGET_TOTAL_GB=12
# Margine di sicurezza sul filesystem oltre la taglia dello swapfile: /mnt
# ospita anche lo swapfile di default del runner e file temporanei del job.
MARGIN_MB=4096
# Sotto questa differenza non vale la pena di creare un altro swapfile.
MIN_ADD_MB=256
SWAPFILE="${GROW_SWAP_FILE:-/mnt/build-swapfile}"
MEMINFO="${GROW_SWAP_MEMINFO:-/proc/meminfo}"

swap_total_mb() {
  awk '/^SwapTotal:/ { printf "%d\n", $2 / 1024; found = 1 } END { if (!found) print 0 }' "$MEMINFO" 2>/dev/null || echo 0
}

current_mb="$(swap_total_mb)"
TARGET_MB=$(( TARGET_TOTAL_GB * 1024 ))
ADD_MB=$(( TARGET_MB - current_mb ))
REQUIRED_MB=$(( ADD_MB + MARGIN_MB ))

if [ "${GROW_SWAP_PLAN_ONLY:-0}" = "1" ]; then
  # Sola lettura: serve al test, che passa un /proc/meminfo finto.
  echo "plan: current_mb=${current_mb} target_mb=${TARGET_MB} add_mb=$(( ADD_MB > 0 ? ADD_MB : 0 ))"
  exit 0
fi

if swapon --show=NAME --noheadings 2>/dev/null | grep -qx "$SWAPFILE"; then
  echo "[grow-build-swap] ${SWAPFILE} gia' attivo — swap totale ${current_mb} MB, no-op"
  exit 0
fi

if [ "$ADD_MB" -lt "$MIN_ADD_MB" ]; then
  echo "[grow-build-swap] swap totale ${current_mb} MB >= obiettivo ${TARGET_MB} MB — nulla da aggiungere"
  free -m || true
  exit 0
fi

MNT_DIR="$(dirname "$SWAPFILE")"
if [ ! -d "$MNT_DIR" ]; then
  echo "::warning::[grow-build-swap] ${MNT_DIR} assente: swap extra non creato, totale ${current_mb} MB su ${TARGET_MB} MB (il preflight di buildMemoryGuard fermera' il build se il tetto V8 lo richiede)"
  exit 0
fi

free_mb=$(df -Pm "$MNT_DIR" | awk 'NR==2{print $4}')
if [ -z "${free_mb}" ] || [ "${free_mb}" -le "${REQUIRED_MB}" ]; then
  echo "::warning::[grow-build-swap] ${MNT_DIR} ha ${free_mb:-?} MB liberi (< ${REQUIRED_MB}): swap extra non creato, totale ${current_mb} MB su ${TARGET_MB} MB (il preflight di buildMemoryGuard fermera' il build se il tetto V8 lo richiede)"
  exit 0
fi

sudo fallocate -l "${ADD_MB}M" "$SWAPFILE" || sudo dd if=/dev/zero of="$SWAPFILE" bs=1M count="$ADD_MB"
sudo chmod 600 "$SWAPFILE"
sudo mkswap "$SWAPFILE"
sudo swapon "$SWAPFILE"
final_mb="$(swap_total_mb)"
echo "[grow-build-swap] +${ADD_MB} MB su ${SWAPFILE}: swap totale ${current_mb} -> ${final_mb} MB (obiettivo ${TARGET_MB} MB)"
if [ "$final_mb" -lt "$TARGET_MB" ]; then
  echo "::warning::[grow-build-swap] swap totale ${final_mb} MB < obiettivo ${TARGET_MB} MB dopo swapon"
fi
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "Swap totale del runner: ${final_mb} MB (obiettivo ${TARGET_MB} MB)" >> "$GITHUB_STEP_SUMMARY"
fi
swapon --show || true
free -m
