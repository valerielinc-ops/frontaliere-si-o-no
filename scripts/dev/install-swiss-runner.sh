#!/bin/bash

# Launch agent of the Swiss runner (scripts/assisted-application/local-runner.mjs) on a Mac whose network
# exit is in Switzerland: every 2 minutes it takes at most one assisted-application run that a portal
# refuses from GitHub's network, and runs it from here (owner decision 2026-11-11).
#
#   bash scripts/dev/install-swiss-runner.sh install [--checkout PATH] [--headed]
#                                                    write and load ~/Library/LaunchAgents/ch.frontaliere.swiss-runner.plist
#   bash scripts/dev/install-swiss-runner.sh print-plist [--checkout PATH] [--headed]
#                                                    print the plist install would write, loading nothing
#   bash scripts/dev/install-swiss-runner.sh run       one cycle (what launchd runs)
#   bash scripts/dev/install-swiss-runner.sh status    launch agent state and the last log lines
#   bash scripts/dev/install-swiss-runner.sh uninstall unload and remove the plist (the runner stops taking work)
#
# --checkout: the site checkout the runner executes (default: the checkout holding this script). It must
# have node_modules (Playwright, firebase-admin). Before each cycle `run` fast-forwards it to origin/main
# when it is on `main` with a clean tree; on any other branch, or with local changes, it runs it as it is
# and says so in the log.
# --headed: the agent opens a visible Chrome window on this Mac (ASSISTED_APPLICATION_HEADED=1). Default:
# headless, nothing appears on the owner's screen.
#
# Credentials: the service account in ~/.config/frontaliere/sa-frontaliere-ticino.json (SWISS_RUNNER_SA to
# override); Remote Config is read by the runner itself; Codex uses this Mac's login (~/.codex/auth.json).
# Log: ~/Library/Logs/frontaliere/swiss-runner.log (trimmed to its last lines by `run`).
#
# Bash 3.2 (macOS /bin/bash): no associative arrays, no ${var,,}.

set -u

label=ch.frontaliere.swiss-runner
home_dir=${HOME:-~}
log_dir=${SWISS_RUNNER_LOG_DIR:-$home_dir/Library/Logs/frontaliere}
log_file="$log_dir/swiss-runner.log"
agents_dir=${SWISS_RUNNER_LAUNCH_AGENTS_DIR:-$home_dir/Library/LaunchAgents}
plist="$agents_dir/$label.plist"
sa_file=${SWISS_RUNNER_SA:-$home_dir/.config/frontaliere/sa-frontaliere-ticino.json}
interval=${SWISS_RUNNER_INTERVAL:-120}
max_log_lines=20000

script_dir=$(CDPATH="" cd -- "$(dirname -- "$0")" && pwd -P) || exit 1
default_site=$(CDPATH="" cd -- "$script_dir/../.." && pwd -P) || exit 1
site=${SWISS_RUNNER_SITE:-$default_site}

log() {
  /bin/mkdir -p "$log_dir" 2>/dev/null || return 0
  printf '%s %s\n' "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*" >>"$log_file"
}

verify_agent_entry_point() {
  output=$(cd "$site" && node --input-type=module -e "await import('./scripts/assisted-application/agent.mjs')" 2>&1)
  status=$?
  if [ "$status" -eq 0 ]; then
    echo '✔ assisted-application agent entry point is available'
    return 0
  fi
  missing_module=$(printf '%s\n' "$output" | /usr/bin/sed -n "s/.*Cannot find package '\([^']*\)'.*/\1/p" | /usr/bin/head -n 1)
  if [ -n "$missing_module" ]; then
    echo "⚠ assisted-application agent entry point unavailable: $missing_module"
  else
    echo '⚠ assisted-application agent entry point unavailable'
  fi
  echo '  The runner will leave requests queued until its dependencies are available.'
  echo '  From the main site checkout, run: npm install && npm --prefix functions install'
  return 0
}

trim_log() {
  [ -f "$log_file" ] || return 0
  lines=$(/usr/bin/wc -l <"$log_file")
  if [ "$lines" -gt "$max_log_lines" ]; then
    /usr/bin/tail -n $((max_log_lines / 2)) "$log_file" >"$log_file.tmp" && /bin/mv "$log_file.tmp" "$log_file"
  fi
}

xml_escape() {
  printf '%s' "$1" | /usr/bin/sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

check_site() {
  if [ ! -f "$1/scripts/assisted-application/local-runner.mjs" ]; then
    echo "✖ $1 is not a site checkout with scripts/assisted-application/local-runner.mjs" >&2
    return 1
  fi
  if [ ! -d "$1/node_modules/playwright" ] || [ ! -d "$1/node_modules/firebase-admin" ]; then
    echo "✖ $1 has no node_modules with playwright and firebase-admin (the runner does not install them)" >&2
    return 1
  fi
}

# Keep the checkout on origin/main between cycles, never touching a branch or local changes.
update_checkout() {
  branch=$(git -C "$site" symbolic-ref --quiet --short HEAD 2>/dev/null) || branch=''
  if [ "$branch" != 'main' ]; then
    log "checkout not on main (${branch:-detached}): running it as it is"
    return 0
  fi
  if [ -n "$(git -C "$site" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    log 'checkout has local changes: running it as it is'
    return 0
  fi
  # At most one fetch every 15 minutes, not one per 2-minute cycle.
  fetch_head=$(git -C "$site" rev-parse --path-format=absolute --git-path FETCH_HEAD 2>/dev/null) || fetch_head=''
  fetched_at=0
  [ -n "$fetch_head" ] && [ -f "$fetch_head" ] && fetched_at=$(/usr/bin/stat -f '%m' "$fetch_head" 2>/dev/null || echo 0)
  if [ $(( $(/bin/date +%s) - fetched_at )) -ge 900 ] && ! git -C "$site" fetch --quiet origin main 2>/dev/null; then
    log 'fetch of origin/main failed: running the checkout as it is'
    return 0
  fi
  git -C "$site" merge --ff-only --quiet origin/main 2>/dev/null || log 'fast-forward to origin/main failed: running the checkout as it is'
}

# Parse the install options and write the plist to $1 (validated with plutil).
write_plist() {
  out=$1
  shift
  headed=''
  while [ $# -gt 0 ]; do
    case "$1" in
      --checkout) site=$(CDPATH="" cd -- "${2:-}" && pwd -P) || { echo "✖ checkout not found: ${2:-}" >&2; return 1; }; shift 2 ;;
      --headed) headed=1; shift ;;
      *) echo "✖ unknown option: $1" >&2; return 1 ;;
    esac
  done
  check_site "$site" || return 1
  if [ ! -f "$sa_file" ]; then
    echo "✖ service account not found: $sa_file" >&2
    return 1
  fi
  node_bin=$(node -p 'process.execPath' 2>/dev/null) || { echo '✖ node not found in PATH' >&2; return 1; }
  node_dir=$(/usr/bin/dirname "$node_bin")
  headed_env=''
  if [ -n "$headed" ]; then
    headed_env="    <key>SWISS_RUNNER_HEADED</key><string>1</string>"
  fi
  tmp="$out.tmp.$$"
  cat >"$tmp" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$(xml_escape "$site/scripts/dev/install-swiss-runner.sh")</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$site")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml_escape "$node_dir"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>HOME</key><string>$(xml_escape "$home_dir")</string>
    <key>SWISS_RUNNER_SITE</key><string>$(xml_escape "$site")</string>
    <key>GOOGLE_APPLICATION_CREDENTIALS</key><string>$(xml_escape "$sa_file")</string>
$headed_env
  </dict>
  <key>StartInterval</key><integer>$interval</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "$log_file")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$log_file")</string>
</dict>
</plist>
EOF
  /usr/bin/plutil -lint "$tmp" >/dev/null || { /bin/rm -f "$tmp"; echo '✖ invalid plist' >&2; return 1; }
  /bin/mv "$tmp" "$out"
}

cmd_install() {
  /bin/mkdir -p "$agents_dir" "$log_dir" || return 1
  write_plist "$plist" "$@" || return 1
  uid=$(/usr/bin/id -u)
  /bin/launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
  /bin/launchctl bootstrap "gui/$uid" "$plist" || { echo "✖ launchctl bootstrap failed for $plist" >&2; return 1; }
  /bin/launchctl enable "gui/$uid/$label" >/dev/null 2>&1 || true
  verify_agent_entry_point
  echo "✔ $label installed: checkout $site, every ${interval}s, log $log_file${headed:+, headed}"
}

cmd_run() {
  trim_log
  check_site "$site" || { log "checkout unusable: $site"; return 1; }
  update_checkout
  cd "$site" || return 1
  exec node "$site/scripts/assisted-application/local-runner.mjs" --once
}

cmd_status() {
  uid=$(/usr/bin/id -u)
  if [ -f "$plist" ]; then echo "plist: $plist"; else echo 'plist: not installed'; fi
  /bin/launchctl print "gui/$uid/$label" 2>/dev/null | /usr/bin/grep -E '^\s*(state|last exit code|run interval|pid) =' || echo 'launch agent: not loaded'
  [ -f "$log_file" ] && /usr/bin/tail -n 20 "$log_file"
  return 0
}

cmd_uninstall() {
  uid=$(/usr/bin/id -u)
  /bin/launchctl bootout "gui/$uid/$label" >/dev/null 2>&1 || true
  /bin/rm -f "$plist"
  echo "✔ $label removed: no Swiss runner takes work from this Mac (queued orders are held for the owner after 20 minutes)"
}

case "${1:-}" in
  install) shift; cmd_install "$@" ;;
  print-plist) shift; out=$(/usr/bin/mktemp -d)/plist && write_plist "$out" "$@" && /bin/cat "$out" && /bin/rm -rf "$(/usr/bin/dirname "$out")" ;;
  run) cmd_run ;;
  status) cmd_status ;;
  uninstall) cmd_uninstall ;;
  *) echo "usage: $0 install [--checkout PATH] [--headed] | print-plist [...] | run | status | uninstall" >&2; exit 2 ;;
esac
