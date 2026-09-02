#!/usr/bin/env node
// Guard against #7091: each crawler group has TWO entry points that share no
// process, filesystem, or account — the disabled workflow_dispatch file
// (crawler-group-NN.yml, manual re-test only) and the live reusable
// workflow_call sibling (crawler-group-NN-logic.yml), invoked cross-repo by
// nanakokyobashi-rgb/frontaliere-articles on its own schedule. The in-process
// HOST_DELAY_MS pacing in scripts/lib/albergo-gardenia-job-parser.mjs cannot
// coordinate between two separate ephemeral runner VMs, so if both entry
// points are ever live at once the same target host sees double the request
// rate.
//
// A `concurrency:` block cannot substitute for this check: GitHub Actions
// concurrency groups do not span repositories, and adding one to the
// workflow_call side broke cross-repo dispatch outright (see commit
// 7ba496e37ff, reverted — see also assertCrawlerLogicParity's
// `logicWorkflow.concurrency !== undefined` invariant in
// scripts/generate-crawler-group-workflows.mjs, which enforces that the
// regression stays reverted). This script instead asks the OTHER entry
// point's own Actions API directly whether it has a live run right now, and
// refuses to start if so — each side checks the other, so the race is closed
// from both directions.
//
// PROCEED-SAFE: any failure to determine the answer (missing token, `gh`
// error, unparseable JSON) must NOT block the crawl — this guard exists to
// avoid an occasional doubled request rate, not to become a new single point
// of failure for the whole group.
import { execFileSync } from 'node:child_process';

export function parseArgs(argv) {
  const [groupFile, ...rest] = argv;
  const opts = { repo: 'nanakokyobashi-rgb/frontaliere-articles', tokenEnv: 'GITHUB_PAT_NANAKO' };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--repo') opts.repo = rest[++i];
    else if (rest[i] === '--token-env') opts.tokenEnv = rest[++i];
  }
  return { groupFile, ...opts };
}

export function hasLiveRun(groupFile, { repo, token, gh = execFileSync } = {}) {
  if (!groupFile || !repo || !token) return false; // PROCEED-SAFE: can't check, don't block
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
    return false; // PROCEED-SAFE
  }
  let runs;
  try {
    runs = JSON.parse(raw);
  } catch {
    return false; // PROCEED-SAFE
  }
  if (!Array.isArray(runs)) return false;
  return runs.some((run) => run?.status === 'in_progress' || run?.status === 'queued');
}

function main() {
  const { groupFile, repo, tokenEnv } = parseArgs(process.argv.slice(2));
  if (!groupFile) {
    console.error('usage: check-crawler-group-live-run.mjs <group-file.yml> [--repo owner/repo] [--token-env VAR]');
    process.exit(0); // PROCEED-SAFE
  }
  const token = process.env[tokenEnv] || '';
  if (!token) {
    console.log(`ℹ️ ${tokenEnv} not set — skipping cross-entry-point guard (proceeding).`);
    process.exit(0);
  }
  if (hasLiveRun(groupFile, { repo, token })) {
    console.error(`::error::${groupFile} already has a live/queued run in ${repo} — refusing to start a second one (issue #7091: unco-ordinated cross-process rate limiting). Re-run once it finishes.`);
    process.exit(1);
  }
  console.log(`✅ No live run of ${groupFile} found in ${repo} — proceeding.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
