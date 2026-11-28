#!/usr/bin/env bash
# mount-compressed-dist.sh — dist/ logico su un volume btrfs compresso, nello
# stesso disco del runner standard (nessun runner a pagamento).
#
#   bash scripts/ci/mount-compressed-dist.sh mount  dist   # prima di estrarre il trunk
#   bash scripts/ci/mount-compressed-dist.sh report dist   # chi occupa cosa
#
# Perche'. Dai log dell'ultima cathedral verde (run 41728609739, 2026-11-03):
#   dopo free-runner-disk.sh              18G usati su 145G   (227k inode)
#   + checkout, npm ci, trunk, en/de/fr   34G                 (1,73M inode)
#   + sezioni                            123G, 22G liberi     (11,9M inode)
#   dist/                                 6.469.845 file
# Le sezioni da sole sono ~89G per ~10,2M inode: una directory per pagina, e su
# ext4 ogni directory costa un blocco da 4 KiB piu' l'arrotondamento a 4 KiB di
# ogni file. Dal 2026-11-27 i 22G non bastano piu' (ENOSPC nel rehydrate o allo
# step dopo, issue #19102/#17161/#7421). Su btrfs le directory vivono nei
# metadati e l'HTML si comprime: stessi file, stessi percorsi, stessi
# controlli, meno blocchi.
#
# Il volume e' un file sparso grande "spazio libero meno riserva": occupa sul
# disco solo quanto viene scritto (discard=async restituisce i blocchi
# cancellati) e non puo' riempire il filesystem di sistema. Se dist/ non ci
# stesse, fallisce chi scrive in dist/ con un errore nel log, invece di uccidere
# il runner (che muore senza log quando non riesce piu' a scrivere in _diag).
#
# dist/ e' un bind mount, non un symlink: `find dist` non segue un symlink.
# REHYDRATE_CLONE_ROOT porta i clone di fallback sullo stesso volume, cosi' la
# riserva di sistema non deve contenere un checkout da molti GB.
#
# Fail-open sul comportamento di prima: se il volume non si monta, dist/ resta
# una directory normale (warning). La completezza la decide sempre
# scripts/ci/assert-dist-complete.mjs.
set -uo pipefail

CMD="${1:-}"
DIST="${2:-}"
case "$CMD" in
  mount|report) ;;
  *) echo "uso: $0 <mount|report> <dist-dir>" >&2; exit 2 ;;
esac
[ -n "$DIST" ] || { echo "uso: $0 <mount|report> <dist-dir>" >&2; exit 2; }

VOLUME_ROOT="${DIST_VOLUME_ROOT:-/var/tmp/frontaliere-dist-volume}"
IMAGE="$VOLUME_ROOT/volume.img"
FS_DIR="$VOLUME_ROOT/fs"
# Cosa resta al filesystem di sistema: zip dei batch in volo (~5 GB compressi
# per locale nel giro seriale), tar del trunk (~1,7 GB), npm ci (~2 GB),
# report e log degli audit.
RESERVE_GIB="${DIST_VOLUME_RESERVE_GIB:-16}"
MIN_GIB="${DIST_VOLUME_MIN_GIB:-40}"
GIB=$((1024 * 1024 * 1024))

report() {
  echo "::group::Disk usage by area"
  df -h /
  df -i /
  if mountpoint -q "$FS_DIR" 2>/dev/null; then
    sudo btrfs filesystem sync "$FS_DIR" >/dev/null 2>&1 || true
    echo "dist volume (compressed):"
    df -h "$FS_DIR"
    sudo btrfs filesystem df "$FS_DIR" || true
    echo "host blocks held by the volume image:"
    sudo du -h "$IMAGE" || true
  else
    echo "dist volume: not mounted"
  fi
  # Gli altri consumatori sul disco di sistema. dist/ resta fuori: camminarlo
  # con du costa minuti e il suo peso e' gia' nelle righe qui sopra.
  local p
  for p in "${GITHUB_WORKSPACE:-$PWD}/.git" "${GITHUB_WORKSPACE:-$PWD}/node_modules" \
    "${RUNNER_TEMP:-}" /tmp /swapfile /mnt; do
    [ -n "$p" ] && [ -e "$p" ] || continue
    sudo -n du -sxh "$p" 2>/dev/null || true
  done
  echo "::endgroup::"
}

if [ "$CMD" = report ]; then
  report
  exit 0
fi

skip() {
  echo "::warning::compressed dist volume not mounted ($1) — $DIST stays on the runner root filesystem"
  mkdir -p "$DIST"
  exit 0
}

# Smonta solo cio' che ha creato questo script, poi ricade sul percorso di prima.
abort_mount() {
  mountpoint -q "$DIST" 2>/dev/null && sudo umount "$DIST"
  mountpoint -q "$FS_DIR" 2>/dev/null && sudo umount "$FS_DIR"
  mountpoint -q "$FS_DIR" 2>/dev/null || sudo rm -f "$IMAGE"
  skip "$1"
}

# Un mount sopra una directory piena nasconderebbe i file gia' presenti.
if [ -d "$DIST" ] && [ -n "$(ls -A "$DIST" 2>/dev/null)" ]; then
  skip "$DIST is not empty"
fi
[ "$(uname -s)" = Linux ] || skip "not a Linux host"
sudo -n true 2>/dev/null || skip "no passwordless sudo"
if ! command -v mkfs.btrfs >/dev/null 2>&1; then
  sudo timeout 180 apt-get install -y -qq btrfs-progs >/dev/null 2>&1 \
    || skip "btrfs-progs unavailable"
fi

sudo mkdir -p "$FS_DIR" || skip "cannot create $FS_DIR"
avail="$(df -B1 --output=avail "$VOLUME_ROOT" | tail -n 1 | tr -d '[:space:]')"
case "$avail" in ''|*[!0-9]*) skip "cannot read free space" ;; esac
size=$((avail - RESERVE_GIB * GIB))
[ "$size" -ge $((MIN_GIB * GIB)) ] \
  || skip "only $((avail / GIB)) GiB free, need $((RESERVE_GIB + MIN_GIB)) GiB"

sudo truncate -s "$size" "$IMAGE" || abort_mount "cannot create the sparse image"
# single anche per i metadati: il volume e' usa e getta, la copia DUP
# raddoppierebbe i metadati di ~11M inode.
sudo mkfs.btrfs -q -f -m single -d single "$IMAGE" || abort_mount "mkfs.btrfs failed"
sudo mount -t btrfs -o loop,noatime,compress-force=zstd:1,discard=async "$IMAGE" "$FS_DIR" \
  || abort_mount "mount failed"
sudo mkdir -p "$FS_DIR/dist" "$FS_DIR/clones" || abort_mount "cannot prepare the volume"
sudo chown "$(id -u):$(id -g)" "$FS_DIR/dist" "$FS_DIR/clones" || abort_mount "chown failed"
mkdir -p "$DIST" || abort_mount "cannot create $DIST"
sudo mount --bind "$FS_DIR/dist" "$DIST" || abort_mount "bind mount failed"
probe="$DIST/.volume-probe"
{ echo ok > "$probe" && [ "$(cat "$probe")" = ok ] && rm -f "$probe"; } \
  || abort_mount "volume is not writable"

if [ -n "${GITHUB_ENV:-}" ]; then
  echo "REHYDRATE_CLONE_ROOT=$FS_DIR/clones" >> "$GITHUB_ENV"
fi
echo "$DIST mounted on a $((size / GIB)) GiB btrfs volume (compress-force=zstd:1); ${RESERVE_GIB} GiB stay reserved on /"
report
exit 0
