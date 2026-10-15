#!/bin/bash
# Compila candidatura — keeps the folder Chrome loads the extension from in
# step with the site's main branch, on the owner's Mac. The extension notices
# its new files by itself and reloads when no order is being filled
# (extension/background.js), so nobody presses «Ricarica» after a merge.
#
#   scripts/assisted-application/extension-sync.sh install [folder]
#       copy the extension to the folder Chrome loads (default:
#       ~/Library/Application Support/Frontaliere/compila-candidatura) and keep
#       it updated every 15 minutes with a launch agent. Not in Documents,
#       Desktop or Downloads: macOS does not let a launch agent write there
#       (2026-10-01 on the owner's Mac: «rsync: open: Operation not permitted»);
#   scripts/assisted-application/extension-sync.sh run
#       one sync (what the launch agent runs);
#   scripts/assisted-application/extension-sync.sh uninstall
#       remove the launch agent (the folder stays: Chrome keeps loading it).
#
# Only `git fetch` and `git archive` on the checkout's own repository: no
# working tree is touched, and the copy is exactly origin/main's folder.
set -euo pipefail

LABEL="ch.frontaliere.compila-candidatura-sync"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
STATE_DIR="${COMPILA_SYNC_STATE_DIR:-$HOME/.local/share/frontaliere/compila-candidatura}"
LOG_DIR="$HOME/Library/Logs/frontaliere"
EXTENSION_PATH="scripts/assisted-application/extension"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

sync_once() {
  local git_dir="${COMPILA_SYNC_GIT_DIR:?COMPILA_SYNC_GIT_DIR not set}"
  local dest="${COMPILA_SYNC_DEST:?COMPILA_SYNC_DEST not set}"
  # A failed fetch (offline, a concurrent fetch holding the ref) keeps the last origin/main.
  git --git-dir="$git_dir" fetch --quiet origin main || log "fetch failed, using the last origin/main"
  mkdir -p "$STATE_DIR"
  # This script too follows main: the next run uses the merged version.
  if git --git-dir="$git_dir" show "origin/main:scripts/assisted-application/extension-sync.sh" > "$STATE_DIR/extension-sync.sh.next" 2>/dev/null; then
    mv "$STATE_DIR/extension-sync.sh.next" "$STATE_DIR/extension-sync.sh"
  else
    rm -f "$STATE_DIR/extension-sync.sh.next"
  fi
  local tree
  # No origin/main yet (first run offline): the folder stays as it is until a fetch works.
  if ! tree="$(git --git-dir="$git_dir" rev-parse --verify --quiet "origin/main:$EXTENSION_PATH")"; then
    log "no origin/main to copy yet, $dest left as it is"
    return 1
  fi
  if [ -f "$STATE_DIR/synced-tree" ] && [ "$(cat "$STATE_DIR/synced-tree")" = "$tree" ] && [ -f "$dest/manifest.json" ]; then
    return 0
  fi
  local staging
  staging="$(mktemp -d "${TMPDIR:-/tmp}/compila-candidatura.XXXXXX")"
  # Each file is replaced whole (rsync writes a temporary file and renames it).
  # --checksum: git archive stamps every file with the commit's time, so two
  # merges in the same second leave a same-size file looking unchanged.
  if ! { git --git-dir="$git_dir" archive "origin/main:$EXTENSION_PATH" | tar -x -C "$staging" \
    && mkdir -p "$dest" \
    && rsync -a --checksum --delete --exclude '_metadata' "$staging/" "$dest/"; }; then
    rm -rf "$staging"
    log "sync of $dest failed"
    return 1
  fi
  rm -rf "$staging"
  printf '%s\n' "$tree" > "$STATE_DIR/synced-tree"
  log "synced $dest to origin/main $(git --git-dir="$git_dir" rev-parse --short origin/main) (extension tree ${tree:0:12})"
}

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

install() {
  local dest="${1:-$HOME/Library/Application Support/Frontaliere/compila-candidatura}"
  # launchd has no working directory of ours: a relative folder becomes absolute now.
  case "$dest" in /*) ;; *) dest="$PWD/$dest" ;; esac
  case "$dest" in
    "$HOME/Documents"|"$HOME/Documents/"*|"$HOME/Desktop"|"$HOME/Desktop/"*|"$HOME/Downloads"|"$HOME/Downloads/"*)
      echo "$dest is in a folder macOS protects from launch agents (Documents, Desktop, Downloads): choose another one." >&2
      exit 2 ;;
  esac
  local git_dir
  git_dir="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
  mkdir -p "$STATE_DIR" "$LOG_DIR" "$(dirname "$PLIST")"
  # The launch agent runs a copy: a checkout on another branch, or a removed worktree, does not change it.
  cp "${BASH_SOURCE[0]}" "$STATE_DIR/extension-sync.sh"
  chmod 755 "$STATE_DIR/extension-sync.sh"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$(xml_escape "$STATE_DIR/extension-sync.sh")</string>
		<string>run</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>$(xml_escape "$HOME")</string>
		<key>PATH</key>
		<string>/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>COMPILA_SYNC_GIT_DIR</key>
		<string>$(xml_escape "$git_dir")</string>
		<key>COMPILA_SYNC_DEST</key>
		<string>$(xml_escape "$dest")</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>StartInterval</key>
	<integer>900</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>StandardOutPath</key>
	<string>$(xml_escape "$LOG_DIR/compila-candidatura-sync.log")</string>
	<key>StandardErrorPath</key>
	<string>$(xml_escape "$LOG_DIR/compila-candidatura-sync.log")</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  log "installed $LABEL: $dest follows origin/main every 15 minutes (log: $LOG_DIR/compila-candidatura-sync.log)"
}

uninstall() {
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  log "removed $LABEL (the extension folder is left in place)"
}

case "${1:-}" in
  install) shift; install "$@" ;;
  run) sync_once ;;
  uninstall) uninstall ;;
  *) echo "usage: $0 install [folder] | run | uninstall" >&2; exit 2 ;;
esac
