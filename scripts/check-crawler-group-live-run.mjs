#!/usr/bin/env node

// Guard against #7091: the disabled workflow_dispatch file and the live
// workflow_call sibling are separate entry points, and the latter is invoked
// from the corpus repository. Their runner processes cannot share the
// in-memory HOST_DELAY_MS pacing used by the Gardenia transport, so starting
// both at once would double the request rate against the same host.
//
// A concurrency group cannot cover this boundary: GitHub scopes concurrency
// groups to one repository. Each entry point therefore checks the other
// repository's Actions API before launching the grouped crawlers.
//
// PROCEED-SAFE: a missing credential or an unavailable/malformed API response
// must not turn this advisory guard into a new outage for the crawler. The
// normal global data-pipeline lease still protects the later writer phase.
import { execFileSync } from 'node:child_process';

const LIVE_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);

export function parseArgs(argv) {
  const [groupFile, ...rest] = argv;
  const opts = {
    repo: 'nanakokyobashi-rgb/frontaliere-articles',
    tokenEnv: 'GITHUB_PAT_NANAKO',
  };
  for (let index = 0; index < rest.length; index += 1) {
    if (rest[index] === '--repo' && rest[index + 1]) opts.repo = rest[++index];
    else if (rest[index] === '--token-env' && rest[index + 1]) opts.tokenEnv = rest[++index];
  }
  return { groupFile, ...opts };
}

export function hasLiveRun(groupFile, { repo, token, gh = execFileSync } = {}) {
  if (!groupFile || !repo || !token) return false;

  let raw;
  try {
    raw = gh('gh', [
      'run', 'list',
      '-w', groupFile,
      '-R', repo,
      '-L', '10',
      '--json', 'status',
    ], { encoding: 'utf8', env: { ...process.env, GH_TOKEN: token } });
  } catch {
    return false;
  }

  let runs;
  try {
    runs = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!Array.isArray(runs)) return false;
  return runs.some((run) => LIVE_STATUSES.has(run?.status));
}

function main() {
  const { groupFile, repo, tokenEnv } = parseArgs(process.argv.slice(2));
  if (!groupFile) {
    console.error('usage: check-crawler-group-live-run.mjs <group-file.yml> [--repo owner/repo] [--token-env VAR]');
    return;
  }

  const token = process.env[tokenEnv] || '';
  if (!token) {
    console.log(`ℹ️ ${tokenEnv} not set — skipping cross-entry-point guard (proceeding).`);
    return;
  }
  if (hasLiveRun(groupFile, { repo, token })) {
    console.error(`::error::${groupFile} already has a live/queued run in ${repo} — refusing to start a second one (issue #7091: uncoordinated cross-process rate limiting). Re-run once it finishes.`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ No live run of ${groupFile} found in ${repo} — proceeding.`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
