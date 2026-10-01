#!/usr/bin/env bash
# free-runner-disk.sh — la pulizia del disco del runner, in UN posto solo.
#
# Perche' esiste: i job che riassemblano il dist/ logico (trunk + 3 shard
# locale + 27 sezioni x 4 locali: ~5,2 M file e una directory per ogni pagina
# job) chiudono il rehydrate a 134 GB usati su 145 (run 36539937776, ultimo
# verde: "/dev/root 145G 134G 11G"), e il 2026-10-01 sono morti con
# "No space left on device" dentro lo step di rehydrate (deploy-publish
# 36810296662, cathedral-seo-gates-check 36810296254). La pulizia c'era gia',
# ma in nove copie inline divergenti: cathedral-seo-gates-check ne aveva una
# da 6 path senza `docker image prune`, post-deploy-validate-dist e i seed-*
# una da 9 path, matrix-equivalence-check un loop suo. Qui c'e' l'unica lista;
# i workflow la chiamano subito dopo il Checkout (lo script vive nel repo).
#
# Rimuove SOLO toolchain che i job chiamanti non usano: girano node (da
# setup-node, che sta in /opt/hostedtoolcache/node e resta), npm, gh, git, jq,
# tar, unzip. Nessuno di quei job usa python del tool cache, java, browser,
# docker o pwsh. Lo swapfile resta: i validator girano con heap V8 fino a
# 8 GB su un runner da 16 GB.
#
# Best-effort DI PROPOSITO, come le copie inline che sostituisce: un path gia'
# tolto da un refresh dell'immagine non deve far fallire il job. Il
# fail-closed sta a valle (rehydrate + scripts/ci/assert-dist-complete.mjs);
# qui si stampa `df` — blocchi E inode — prima e dopo, cosi' un'immagine che
# cambia si legge nel log invece che venti minuti dopo come ENOSPC.
set -uo pipefail

report() {
  df -h /
  df -i /
}

echo "::group::Disk usage BEFORE cleanup"
report
echo "::endgroup::"

PATHS=(
  # La lista storica delle copie inline.
  /usr/share/dotnet
  /usr/local/lib/android
  /opt/ghc
  /usr/local/share/powershell
  /usr/local/share/chromium
  /usr/local/lib/node_modules
  /usr/local/share/boost
  /usr/share/swift
  # 2026-10-01: il resto delle toolchain preinstallate su ubuntu-24.04.
  /usr/local/.ghcup
  /usr/lib/jvm
  /usr/share/miniconda
  /usr/share/rust
  /usr/local/share/vcpkg
  /usr/lib/google-cloud-sdk
  /opt/az
  /opt/microsoft
  /opt/google
  /usr/lib/firefox
  /opt/pipx
  /usr/local/aws-cli
  /usr/local/aws-sam-cli
  /home/linuxbrew
  /usr/share/kotlinc
)
for p in "${PATHS[@]}" /usr/local/julia*; do
  [ -e "$p" ] || continue
  sudo rm -rf "$p" 2>/dev/null &
done
# Tool cache: tutto (CodeQL compreso) tranne node, che setup-node riusa
# invece di riscaricarlo.
for p in /opt/hostedtoolcache/*; do
  [ -e "$p" ] || continue
  [ "$(basename "$p")" = node ] && continue
  sudo rm -rf "$p" 2>/dev/null &
done
wait
if command -v docker >/dev/null 2>&1; then
  sudo docker image prune -af >/dev/null 2>&1 || true
fi

echo "::group::Disk usage AFTER cleanup"
report
echo "::endgroup::"
exit 0
