import { execFileSync } from 'node:child_process';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { LIVE_DATA_ROOTS } from './live-data-test-guard.mjs';

export const LIVE_DATA_ROOT_AUDIT_TITLE = 'Live-data root drift (30-day bot inventory)';
const AUTOMATED_PR_TITLE = /^chore\((?:data|licenses|images)\):/iu;
const BOT_AUTHOR = /(?:\[bot\]$|^app\/)/iu;

function validRepoPath(value) {
  const file = String(value || '').trim().replaceAll('\\', '/');
  if (!file || file.startsWith('/') || file.split('/').includes('..')) return '';
  return file;
}

/** Parse the exact git-log format used by the 30-day bot-output audit. */
export function directBotCommitPaths(log = '') {
  let botDirectCommit = false;
  const paths = new Set();
  for (const line of String(log).split(/\r?\n/u)) {
    if (line.startsWith('@@')) {
      const [author = '', ...subjectParts] = line.slice(2).split('|');
      const subject = subjectParts.join('|');
      botDirectCommit = /(?:bot|github actions)/iu.test(author)
        && !/\(#[0-9]+\)$/u.test(subject);
      continue;
    }
    if (!botDirectCommit) continue;
    const file = validRepoPath(line);
    if (file) paths.add(file);
  }
  return [...paths].sort();
}

export function isAutomatedDataPullRequest(pr) {
  const login = String(pr?.author?.login || '');
  const isBot = pr?.author?.is_bot === true || BOT_AUTHOR.test(login);
  return isBot && AUTOMATED_PR_TITLE.test(String(pr?.title || ''));
}

/** Pull request records may carry paths as strings or gh files objects. */
export function automatedPullRequestPaths(pullRequests = []) {
  const paths = new Set();
  const candidates = [];
  for (const pr of pullRequests) {
    if (!isAutomatedDataPullRequest(pr)) continue;
    candidates.push(pr);
    for (const item of Array.isArray(pr.files) ? pr.files : []) {
      const file = validRepoPath(typeof item === 'string' ? item : item?.path);
      if (file) paths.add(file);
    }
  }
  return { candidates, paths: [...paths].sort() };
}

export function auditLiveDataRoots({
  directPaths = [],
  pullRequestPaths = [],
  roots = LIVE_DATA_ROOTS,
} = {}) {
  const direct = new Set(directPaths.map(validRepoPath).filter(Boolean));
  const fromPullRequests = new Set(pullRequestPaths.map(validRepoPath).filter(Boolean));
  const all = new Set([...direct, ...fromPullRequests]);
  const uncovered = [...all].filter((file) => !roots.some((root) => file.startsWith(root))).sort();
  return {
    directPathCount: direct.size,
    pullRequestPathCount: fromPullRequests.size,
    uncovered,
    directOnly: uncovered.filter((file) => direct.has(file) && !fromPullRequests.has(file)),
    pullRequestOnly: uncovered.filter((file) => fromPullRequests.has(file) && !direct.has(file)),
    both: uncovered.filter((file) => direct.has(file) && fromPullRequests.has(file)),
  };
}

export function renderLiveDataRootDrift({
  sinceDate,
  commitPaths = [],
  pullRequestCount = 0,
  pullRequestPaths = [],
  uncovered = [],
  runUrl = '',
} = {}) {
  const lines = [
    '## Rilevazione',
    '',
    'Finestra inclusiva dal ' + sinceDate + '; commit diretti dei bot: '
      + commitPaths.length + ' percorsi distinti; PR automatiche considerate: '
      + pullRequestCount + ' (' + pullRequestPaths.length + ' percorsi distinti).',
    '',
    'Sono emersi ' + uncovered.length + ' percorsi non coperti da LIVE_DATA_ROOTS '
      + 'in scripts/ci/live-data-test-guard.mjs. Questo osservatore non li autorizza '
      + 'né modifica l’inventario: ogni radice va verificata prima di aggiungerla, '
      + 'così i test di codice non escono dal gate delle PR senza evidenza.',
    '',
    '## Percorsi da verificare',
    '',
    ...uncovered.map((file) => '- ' + file),
    '',
    runUrl ? 'Run: ' + runUrl : '',
  ];
  return lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n').trim();
}

function run(bin, args, options = {}) {
  return execFileSync(bin, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
}

function ghJson(args) {
  const output = run(process.env.TRUSTED_GH_BIN || 'gh', args);
  return JSON.parse(output || '[]');
}

function daysAgoDate(days, now = new Date()) {
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return from.toISOString().slice(0, 10);
}

async function main(argv = process.argv.slice(2)) {
  const daysIndex = argv.indexOf('--since-days');
  const days = daysIndex >= 0 ? Number(argv[daysIndex + 1]) : 30;
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    throw new Error('--since-days deve essere un intero fra 1 e 90');
  }
  const repo = String(process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '').trim();
  if (!repo) throw new Error('GH_REPO o GITHUB_REPOSITORY mancante');
  const sinceDate = daysAgoDate(days);
  const since = sinceDate + 'T00:00:00Z';
  const historyRef = 'refs/remotes/origin/live-data-root-audit-main';
  run('git', [
    'fetch',
    '--no-tags',
    '--shallow-since=' + since,
    'origin',
    '+refs/heads/main:' + historyRef,
  ]);
  const log = run('git', [
    'log', historyRef, '--since=' + since, '--format=@@%an|%s', '--name-only',
  ]);
  const commitPaths = directBotCommitPaths(log);
  const listed = ghJson([
    'pr', 'list', '--repo', repo, '--state', 'all', '--limit', '1000',
    '--search', 'created:>=' + sinceDate,
    '--json', 'number,title,author,createdAt,files',
  ]);
  if (!Array.isArray(listed) || listed.length >= 1000) {
    throw new Error('PR list ha raggiunto il limite di 1000: copertura incompleta, nessun audit parziale viene riportato');
  }
  const { candidates, paths: pullRequestPaths } = automatedPullRequestPaths(listed);
  for (const pr of candidates) {
    if (!Array.isArray(pr.files)) {
      throw new Error('PR #' + pr.number + ' senza elenco file; l’audit non può assumere una lista completa');
    }
    if (pr.files.length >= 100) {
      throw new Error('PR #' + pr.number + ' ha raggiunto il limite file della query; l’audit non può assumere una lista completa');
    }
  }
  const audit = auditLiveDataRoots({ directPaths: commitPaths, pullRequestPaths });
  const runUrl = process.env.GITHUB_RUN_ID && process.env.GITHUB_SERVER_URL
    ? process.env.GITHUB_SERVER_URL + '/' + repo + '/actions/runs/' + process.env.GITHUB_RUN_ID
    : '';
  console.log('live-data-root-audit: ' + commitPaths.length + ' percorsi da commit diretti, '
    + candidates.length + ' PR automatiche, ' + audit.uncovered.length + ' percorsi fuori inventario');
  if (!audit.uncovered.length) return 0;
  if (argv.includes('--dry-run')) {
    console.log(audit.uncovered.join('\n'));
    return 0;
  }
  const { createGithubIssue } = await import('../lib/github-issue-creator.mjs');
  const result = await createGithubIssue({
    title: LIVE_DATA_ROOT_AUDIT_TITLE,
    description: renderLiveDataRootDrift({
      sinceDate,
      commitPaths,
      pullRequestCount: candidates.length,
      pullRequestPaths,
      uncovered: audit.uncovered,
      runUrl,
    }),
    priority: 3,
    labels: ['Bug'],
    workflow: 'live-data-root-audit',
    exactTitle: true,
  });
  if (!result?.persisted) throw new Error('Issue di drift delle radici non consegnata');
  return 0;
}

if (isInvokedDirectly(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error('[live-data-root-audit] ' + (error?.stack || error));
    process.exitCode = 1;
  });
}
