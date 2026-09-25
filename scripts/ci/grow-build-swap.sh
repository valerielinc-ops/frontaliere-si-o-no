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
set -euo pipefail

SIZE_GB=8
# Margine di sicurezza sul filesystem oltre la taglia dello swapfile: /mnt
# ospita anche lo swapfile di default del runner e file temporanei del job.
MARGIN_MB=4096
SWAPFILE=/mnt/build-swapfile
REQUIRED_MB=$(( SIZE_GB * 1024 + MARGIN_MB ))

if swapon --show=NAME --noheadings 2>/dev/null | grep -qx "$SWAPFILE"; then
  echo "[grow-build-swap] ${SWAPFILE} gia' attivo — no-op"
  exit 0
fi

if [ ! -d /mnt ]; then
  echo "::warning::[grow-build-swap] /mnt assente: swap extra non creato (il preflight di buildMemoryGuard fermera' il build se il tetto V8 lo richiede)"
  exit 0
fi

free_mb=$(df -Pm /mnt | awk 'NR==2{print $4}')
if [ -z "${free_mb}" ] || [ "${free_mb}" -le "${REQUIRED_MB}" ]; then
  echo "::warning::[grow-build-swap] /mnt ha ${free_mb:-?} MB liberi (< ${REQUIRED_MB}): swap extra non creato (il preflight di buildMemoryGuard fermera' il build se il tetto V8 lo richiede)"
  exit 0
fi

sudo fallocate -l "${SIZE_GB}G" "$SWAPFILE" || sudo dd if=/dev/zero of="$SWAPFILE" bs=1M count=$(( SIZE_GB * 1024 ))
sudo chmod 600 "$SWAPFILE"
sudo mkswap "$SWAPFILE"
sudo swapon "$SWAPFILE"
echo "[grow-build-swap] +${SIZE_GB} GB su ${SWAPFILE}"
swapon --show || true
free -m
