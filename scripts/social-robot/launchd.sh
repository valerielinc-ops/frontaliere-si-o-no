#!/bin/bash

# Launch agent of the social robot on the agents' Mac host: two windows a day
# in which the robot publishes (or, in a dry run, prepares) the queued
# Instagram and TikTok carousels from the owner's Chrome profile.
#
#   bash scripts/social-robot/launchd.sh install    write and load the plist (this Mac, this checkout)
#   bash scripts/social-robot/launchd.sh run        one window (what launchd runs)
#   bash scripts/social-robot/launchd.sh status     launch agent, last log lines
#   bash scripts/social-robot/launchd.sh uninstall  unload and remove the plist
#
# Neither launchd nor `run` executes the checkout's working tree, which may sit
# on somebody else's branch: install copies this script into the state folder
# (the plist runs that copy), and `run` fetches origin/main, extracts the robot's files of that
# commit (`git archive`) into a frozen snapshot under the state folder, links
# the checkout's node_modules (Playwright) and runs it from there. The mode
# comes from Remote Config (SOCIAL_ROBOT_MODE, read with the site's own
# loader and the service account in ~/.config/frontaliere): the plist always
# passes --publish, and only `live` makes the robot press the button.
#
# Logs: ~/Library/Logs/frontaliere/social-robot.log (and .launchd.*.log).
# State (profile, journal, diagnostics): ~/Library/Application Support/frontaliere/social-robot
# Windows: SR_WINDOWS="HH:MM HH:MM" at install time (default 11:30 and 18:30
# local time, after the posters' 08:20/08:25 UTC runs have committed the queue);
# the robot adds up to 20 minutes of random delay to each.
#
# Bash 3.2 (macOS /bin/bash): no associative arrays, no ${var,,}.

set -u

label=ch.frontaliere.social-robot
home_dir=${HOME:-~}
log_dir=${SR_LOG_DIR:-$home_dir/Library/Logs/frontaliere}
log_file="$log_dir/social-robot.log"
agents_dir=${SR_LAUNCH_AGENTS_DIR:-$home_dir/Library/LaunchAgents}
state_dir=${SOCIAL_ROBOT_STATE_DIR:-$home_dir/Library/Application Support/frontaliere/social-robot}
sa_file=${SR_SERVICE_ACCOUNT:-$home_dir/.config/frontaliere/sa-frontaliere-ticino.json}
windows=${SR_WINDOWS:-11:30 18:30}
max_log_lines=4000

# The robot's import closure, extracted from origin/main for every run.
# tests/social-robot.test.ts checks that it covers every relative import of
# run.mjs and of the loader, so a new import cannot silently break the Mac host.
snapshot_paths="scripts/social-robot scripts/lib/social-publish-queue.mjs scripts/lib/social-carousel-video.mjs scripts/lib/github-issue-creator.mjs scripts/load-rc-env.mjs scripts/lib/google-service-account-token.mjs"

script_dir=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
site=${SR_SITE_REPO:-$(CDPATH="" cd -- "$script_dir/../.." && pwd -P)}

log() {
  /bin/mkdir -p "$log_dir" 2>/dev/null || return 0
  printf '%s %s\n' "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$log_file"
}

trim_log() {
  [ -f "$log_file" ] || return 0
  lines=$(/usr/bin/wc -l <"$log_file")
  if [ "$lines" -gt "$max_log_lines" ]; then
    /usr/bin/tail -n $((max_log_lines / 2)) "$log_file" >"$log_file.tmp" && /bin/mv "$log_file.tmp" "$log_file"
  fi
}

g() {
  git -C "$site" "$@"
}

# Extract the robot of origin/main into $state_dir/runner/<sha>; print its path.
snapshot() {
  sha=$1
  runner_root="$state_dir/runner"
  dest="$runner_root/$sha"
  if [ ! -f "$dest/scripts/social-robot/run.mjs" ]; then
    /bin/mkdir -p "$runner_root" || return 1
    tmp="$runner_root/.tmp-$sha-$$"
    /bin/rm -rf "$tmp" && /bin/mkdir -p "$tmp" || return 1
    # shellcheck disable=SC2086 # snapshot_paths is a word list by design
    if ! g archive --format=tar "$sha" -- $snapshot_paths | /usr/bin/tar -x -C "$tmp"; then
      /bin/rm -rf "$tmp"
      return 1
    fi
    /bin/rm -rf "$dest" && /bin/mv "$tmp" "$dest" || return 1
  fi
  /bin/ln -sfn "$site/node_modules" "$dest/node_modules"
  # launchd runs the copy in the state folder, never the checkout's working
  # tree: refresh it from origin/main (atomic rename; this run keeps the old one).
  if ! /usr/bin/cmp -s "$dest/scripts/social-robot/launchd.sh" "$state_dir/launchd.sh"; then
    /bin/cp "$dest/scripts/social-robot/launchd.sh" "$state_dir/launchd.sh.tmp" && /bin/mv -f "$state_dir/launchd.sh.tmp" "$state_dir/launchd.sh"
  fi
  /bin/ln -sfn "$dest" "$runner_root/current.tmp" && /bin/mv -f "$runner_root/current.tmp" "$runner_root/current"
  # Keep the current snapshot and the previous one.
  for old in $(/bin/ls -1t "$runner_root" 2>/dev/null | /usr/bin/grep -E '^[0-9a-f]{40}$' | /usr/bin/tail -n +3); do
    /bin/rm -rf "${runner_root:?}/${old:?}"
  done
  printf '%s\n' "$dest"
}

# SOCIAL_ROBOT_MODE from Remote Config, through the site's loader. Prints the
# raw value or nothing; run.mjs normalises it exactly like the CI posters do
# (resolveSocialRobotMode: trimmed, lower case, unknown → `dry`), so ` Live`
# means the same thing on the Mac and in Actions.
rc_mode() {
  runner=$1
  [ -f "$sa_file" ] || { log "service account missing ($sa_file): SOCIAL_ROBOT_MODE unknown, dry run"; return 0; }
  line=$(GOOGLE_APPLICATION_CREDENTIALS="$sa_file" node "$runner/scripts/load-rc-env.mjs" 2>/dev/null \
    | /usr/bin/grep -E "^export SOCIAL_ROBOT_MODE='[^']{0,32}'$" | /usr/bin/head -n 1)
  [ -n "$line" ] || return 0
  printf '%s\n' "$line" | /usr/bin/sed -E "s/^export SOCIAL_ROBOT_MODE='([^']*)'$/\\1/"
}

cmd_run() {
  /bin/mkdir -p "$log_dir" "$state_dir" 2>/dev/null
  if ! out=$(g -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=60 fetch -q origin main 2>&1); then
    log "fetch failed, using the last fetched origin/main: $(printf '%s' "$out" | /usr/bin/tr '\n' ' ' | /usr/bin/cut -c1-200)"
  fi
  ref=${SR_REF:-origin/main} # SR_REF: another commit, only to try a branch by hand
  sha=$(g rev-parse --verify -q "$ref^{commit}") || { log "$ref unknown in $site: nothing run"; return 0; }
  runner=$(snapshot "$sha") || { log "snapshot of ${sha:0:8} failed: nothing run"; return 0; }
  mode=$(rc_mode "$runner")
  log "run ${sha:0:8} SOCIAL_ROBOT_MODE=${mode:-<absent>}"
  SOCIAL_ROBOT_MODE="$mode" SOCIAL_ROBOT_SITE_REPO="$site" SOCIAL_ROBOT_STATE_DIR="$state_dir" GH_REPO=valerielinc-ops/frontaliere-si-o-no \
    node "$runner/scripts/social-robot/run.mjs" --publish --jitter >>"$log_file" 2>&1
  log "exit $?"
  trim_log
  return 0
}

plist_path() {
  printf '%s/%s.plist\n' "$agents_dir" "$label"
}

xml() {
  printf '%s' "$1" | /usr/bin/sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# launchd does not inherit the shell's PATH: fix node's folder now, while the
# installer sees it; ~/.local/bin first, for the `gh` shim of the coordinator.
launchd_path() {
  node_bin=$(command -v node 2>/dev/null) || node_bin=''
  case "$node_bin" in
    /*) ;;
    *) printf 'social-robot: node not in PATH (PATH=%s): no plist written\n' "${PATH:-}" >&2; return 1 ;;
  esac
  out=''
  for entry in "$home_dir/.local/bin" "${node_bin%/*}" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin; do
    case ":$out:" in
      *":$entry:"*) ;;
      *) out=${out:+$out:}$entry ;;
    esac
  done
  printf '%s\n' "$out"
}

# One <dict> per HH:MM window.
calendar_entries() {
  for w in $windows; do
    case "$w" in
      [0-2][0-9]:[0-5][0-9]) ;;
      *) printf 'social-robot: bad window "%s" (HH:MM)\n' "$w" >&2; return 1 ;;
    esac
    h=${w%%:*}; m=${w##*:}
    h=${h#0}; m=${m#0}
    [ "${h:-0}" -le 23 ] || { printf 'social-robot: bad hour in "%s"\n' "$w" >&2; return 1; }
    printf '\t\t<dict><key>Hour</key><integer>%s</integer><key>Minute</key><integer>%s</integer></dict>\n' "${h:-0}" "${m:-0}"
  done
}

cmd_install() {
  launchd_env_path=$(launchd_path) || exit 69
  entries=$(calendar_entries) || exit 64
  /bin/mkdir -p "$agents_dir" "$log_dir" "$state_dir" || exit 73
  # The plist points at a copy in the state folder: the checkout may later sit
  # on a branch without this file. `run` keeps the copy on origin/main's version.
  if [ "$script_dir/launchd.sh" != "$state_dir/launchd.sh" ]; then
    /bin/cp "$script_dir/launchd.sh" "$state_dir/launchd.sh" || exit 73
  fi
  plist=$(plist_path)
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$label</string>
	<key>ProgramArguments</key>
	<array>
		<string>/bin/bash</string>
		<string>$(xml "$state_dir/launchd.sh")</string>
		<string>run</string>
	</array>
	<key>StartCalendarInterval</key>
	<array>
$entries
	</array>
	<key>ProcessType</key>
	<string>Interactive</string>
	<key>WorkingDirectory</key>
	<string>$(xml "$site")</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key><string>$(xml "$home_dir")</string>
		<key>PATH</key><string>$(xml "$launchd_env_path")</string>
		<key>SR_SITE_REPO</key><string>$(xml "$site")</string>
	</dict>
	<key>StandardOutPath</key>
	<string>$(xml "$log_dir/social-robot.launchd.out.log")</string>
	<key>StandardErrorPath</key>
	<string>$(xml "$log_dir/social-robot.launchd.err.log")</string>
</dict>
</plist>
EOF
  if [ -x /usr/bin/plutil ]; then /usr/bin/plutil -lint -s "$plist" || exit 65; fi
  [ -n "${SR_NO_LAUNCHCTL:-}" ] && { printf '%s\n' "$plist"; return 0; }
  domain="gui/$(/usr/bin/id -u)"
  /bin/launchctl bootout "$domain/$label" 2>/dev/null
  /bin/launchctl bootstrap "$domain" "$plist" || exit 1
  printf 'loaded %s (windows: %s): %s\n' "$label" "$windows" "$plist"
}

cmd_uninstall() {
  /bin/launchctl bootout "gui/$(/usr/bin/id -u)/$label" 2>/dev/null
  /bin/rm -f "$(plist_path)"
  printf 'removed %s\n' "$label"
}

cmd_status() {
  if /bin/launchctl print "gui/$(/usr/bin/id -u)/$label" >/dev/null 2>&1; then
    printf '%s loaded\n' "$label"
  else
    printf '%s not loaded (bash scripts/social-robot/launchd.sh install)\n' "$label"
  fi
  [ -f "$log_file" ] && /usr/bin/tail -n 20 "$log_file"
  return 0
}

# All the work is in functions called from the last line: bash reads the
# script in pieces, and a fetch may replace this file while it runs.
main() {
  case "${1:-run}" in
    run) cmd_run ;;
    install) cmd_install ;;
    uninstall) cmd_uninstall ;;
    status) cmd_status ;;
    -h|--help) /usr/bin/sed -n '3,26p' "$0" ;;
    *) printf 'usage: launchd.sh [run|install|uninstall|status]\n' >&2; exit 64 ;;
  esac
}
main "$@"; exit $?
