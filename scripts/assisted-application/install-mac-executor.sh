#!/bin/bash
# Install the outbound, single-slot executor from reviewed origin/main only.
# No provider is enabled here; Remote Config remains the activation switch.
set -euo pipefail
case "$(uname -s)" in Darwin) ;; *) echo 'macOS is required' >&2; exit 1 ;; esac
repository="${1:?usage: install-mac-executor.sh <existing-site-repository>}"
repository="$(cd "$repository" && pwd)"
origin="$(git -C "$repository" remote get-url origin)"
case "$origin" in
  https://github.com/valerielinc-ops/frontaliere-si-o-no|https://github.com/valerielinc-ops/frontaliere-si-o-no.git|git@github.com:valerielinc-ops/frontaliere-si-o-no.git) ;;
  *) echo 'The authorised existing site repository is required.' >&2; exit 1 ;;
esac
node_bin="$(command -v node)"
state="$HOME/.local/share/frontaliere/assisted-application-executor"
credentials="$HOME/.config/frontaliere/sa-frontaliere-ticino.json"
label='ch.frontaliere.assisted-application-executor'
test -f "$credentials"
umask 077
mkdir -p "$state"
chmod 700 "$state"
if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
  echo 'Executor already installed: drain it before an explicit transport upgrade.' >&2
  exit 1
fi
pin="$(git -C "$repository" rev-parse origin/main)"
staging="$(mktemp -d "${TMPDIR:-/tmp}/assisted-executor-bootstrap.XXXXXX")"
trap 'rm -rf -- "$staging"' EXIT
mkdir -p "$staging/scripts/assisted-application/lib" "$staging/scripts/lib"
git -C "$repository" show "$pin:scripts/assisted-application/lib/execution-release.mjs" > "$staging/scripts/assisted-application/lib/execution-release.mjs"
git -C "$repository" show "$pin:scripts/lib/single-flight-lock.mjs" > "$staging/scripts/lib/single-flight-lock.mjs"
"$node_bin" --input-type=module - "$staging/scripts/assisted-application/lib/execution-release.mjs" "$repository" "$state" "$pin" "$credentials" "$label" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
const [modulePath, repository, stateDirectory, sourceSha, credentials, label] = process.argv.slice(2);
const { compileExecutionRelease } = await import(pathToFileURL(modulePath).href);
const stat = fs.statfsSync(stateDirectory);
if (Number(stat.bavail) * Number(stat.bsize) < 5 * 1024 ** 3) throw new Error('executor_needs_five_gib_free_for_private_dependencies');
const release = await compileExecutionRelease({ repository, stateDirectory, sourceSha });
const log = path.join(os.homedir(), 'Library/Logs/frontaliere/assisted-application-executor.log');
fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
const encode = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const args = [process.execPath, path.join(release.root, 'scripts/assisted-application/remote-executor.mjs'),
  '--repository', repository, '--state', stateDirectory, '--credentials', credentials, '--manifest', release.manifestSha];
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>Label</key><string>${encode(label)}</string>
<key>ProgramArguments</key><array>${args.map(value => `<string>${encode(value)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${encode(path.dirname(repository))}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${encode(`${path.dirname(process.execPath)}:${path.join(os.homedir(), '.local/bin')}:/usr/bin:/bin`)}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>60</integer><key>ProcessType</key><string>Background</string><key>Nice</key><integer>10</integer>
<key>StandardOutPath</key><string>${encode(log)}</string><key>StandardErrorPath</key><string>${encode(log)}</string>
</dict></plist>`;
const target = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
fs.writeFileSync(target, plist, { mode: 0o600 });
console.log('Reviewed immutable executor installed; operational Remote Config activation is separate.');
JS
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$label.plist"
