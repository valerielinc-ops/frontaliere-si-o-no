import { execFileSync } from 'node:child_process';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { LIVE_DATA_ROOTS } from './live-data-test-guard.mjs';

export const LIVE_DATA_ROOT_AUDIT_TITLE = 'Live-data root drift (30-day bot inventory)';
const AUTOMATED_PR_TITLE = /^chore\((?:data|licenses|images)\):/iu;
const BOT_AUTHOR = /(?:\[bot\]$|^app\/)/iu;
const AUDIT_HISTORY_REF = 'refs/remotes/origin/live-data-root-audit-main';

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

// A transient GitHub answer (502 from GraphQL, a dropped connection) must not
// decide the audit: retry the same read a bounded number of times, then fail
// loudly as before.
const GH_READ_ATTEMPTS = 3;
const GH_RETRY_DELAYS_MS = [2_000, 5_000];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function ghJson(args, { exec = run, sleep = sleepSync } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= GH_READ_ATTEMPTS; attempt += 1) {
    try {
      const output = exec(process.env.TRUSTED_GH_BIN || 'gh', args);
      return JSON.parse(output || '[]');
    } catch (error) {
      lastError = error;
      if (attempt < GH_READ_ATTEMPTS) sleep(GH_RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  throw lastError;
}

/**
 * Fetch only the commit and tree objects needed by the path audit, then read
 * the complete name-only history in one pass. The audit never needs blobs:
 * fetching them from every data snapshot made the cost grow with repository
 * size instead of with the 30-day window.
 */
export function collectAuditGitHistory({
  since,
  historyRef = AUDIT_HISTORY_REF,
  runGit = run,
  onTiming = () => {},
  onCommand = () => {},
} = {}) {
  const fetchStarted = Date.now();
  try {
    onCommand('fetch');
    runGit('git', [
      'fetch',
      '--no-tags',
      '--no-auto-gc',
      '--filter=blob:none',
      '--shallow-since=' + since,
      'origin',
      '+refs/heads/main:' + historyRef,
    ]);
  } finally {
    onTiming('git_fetch_ms', Date.now() - fetchStarted);
  }

  const logStarted = Date.now();
  let log;
  try {
    onCommand('log');
    log = runGit('git', [
      'log', historyRef, '--since=' + since, '--no-renames', '--format=@@%an|%s', '--name-only',
    ]);
  } finally {
    onTiming('git_log_ms', Date.now() - logStarted);
  }
  return {
    log,
    commitPaths: directBotCommitPaths(log),
    squashPaths: squashCommitPathsByPullNumber(log),
  };
}

function daysAgoDate(days, now = new Date()) {
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return from.toISOString().slice(0, 10);
}

/** Every calendar day (UTC, YYYY-MM-DD) from `sinceDate` to `now`, inclusive. */
export function dayWindows(sinceDate, now = new Date()) {
  const last = now.toISOString().slice(0, 10);
  const days = [];
  for (let day = new Date(sinceDate + 'T00:00:00Z'); ; day = new Date(day.getTime() + 24 * 60 * 60 * 1000)) {
    const iso = day.toISOString().slice(0, 10);
    if (iso > last) break;
    days.push(iso);
  }
  return days;
}

// One search per day, restricted to titles carrying `chore` (the token every
// AUTOMATED_PR_TITLE starts with), and WITHOUT `files`. The first version asked
// for the files of every PR of 30 days in one query: 3536 PRs on 2026-10-14,
// beyond the 1000 a search can list, and GraphQL answered 502 even for a single
// day as long as the files of large data PRs were in the query. So the audit
// threw on every run since it landed and the live-data tests behind it never
// ran. A day holds ~55 such PRs; the per-window cap keeps completeness.
export const PR_WINDOW_LIMIT = 1000;

export function listPullRequestsByDay({ repo, sinceDate, now = new Date(), read = ghJson }) {
  const byNumber = new Map();
  for (const day of dayWindows(sinceDate, now)) {
    const listed = read([
      'pr', 'list', '--repo', repo, '--state', 'all', '--limit', String(PR_WINDOW_LIMIT),
      '--search', 'created:' + day + ' in:title chore',
      '--json', 'number,title,author,createdAt,state',
    ]);
    if (!Array.isArray(listed) || listed.length >= PR_WINDOW_LIMIT) {
      throw new Error('PR list del ' + day + ' ha raggiunto il limite di ' + PR_WINDOW_LIMIT
        + ': copertura incompleta, nessun audit parziale viene riportato');
    }
    for (const pr of listed) byNumber.set(pr.number, pr);
  }
  return [...byNumber.values()];
}

/** Paths of every squash commit `... (#N)` in the git-log format of the audit, by PR number. */
export function squashCommitPathsByPullNumber(log = '') {
  const byNumber = new Map();
  let current = null;
  for (const line of String(log).split(/\r?\n/u)) {
    if (line.startsWith('@@')) {
      const subject = line.slice(2).split('|').slice(1).join('|');
      const match = /\(#([0-9]+)\)$/u.exec(subject);
      current = match ? Number(match[1]) : null;
      if (current !== null && !byNumber.has(current)) byNumber.set(current, new Set());
      continue;
    }
    if (current === null) continue;
    const file = validRepoPath(line);
    if (file) byNumber.get(current).add(file);
  }
  return new Map([...byNumber].map(([number, paths]) => [number, [...paths].sort()]));
}

/**
 * Attach the complete file list to each automated PR without asking GraphQL
 * for it: a merged PR's files are its squash commit on main (already in the
 * audited history), an open PR's come from the paginated REST endpoint, and a
 * PR closed without merging never wrote to main, so it has nothing to audit.
 * A merged PR whose commit is missing stops the audit: the list would be
 * partial.
 */
export function resolveAutomatedPullRequestFiles(candidates, { squashPaths, repo, readOpenFiles }) {
  const resolved = [];
  let skippedClosed = 0;
  for (const pr of candidates) {
    const state = String(pr.state || '').toUpperCase();
    if (state === 'MERGED') {
      const files = squashPaths.get(pr.number);
      if (!files) {
        throw new Error('PR #' + pr.number + ' mergiata ma senza commit (#' + pr.number
          + ') nella storia della finestra: l’audit non può assumere una lista completa');
      }
      resolved.push({ ...pr, files });
    } else if (state === 'OPEN') {
      resolved.push({ ...pr, files: readOpenFiles(repo, pr.number) });
    } else if (state === 'CLOSED') {
      skippedClosed += 1;
    } else {
      throw new Error('PR #' + pr.number + ' con stato sconosciuto ' + JSON.stringify(pr.state));
    }
  }
  return { resolved, skippedClosed };
}

function readOpenPullRequestFiles(repo, number, read = ghJson) {
  const pages = read([
    'api', '-X', 'GET', '--paginate', '--slurp',
    'repos/' + repo + '/pulls/' + number + '/files?per_page=100',
  ]);
  return pages.flat().map((file) => file?.filename).filter(Boolean);
}

async function main(argv = process.argv.slice(2)) {
  const timings = {};
  const auditStarted = Date.now();
  let ghCalls = 0;
  let gitCommands = 0;
  const daysIndex = argv.indexOf('--since-days');
  try {
    const days = daysIndex >= 0 ? Number(argv[daysIndex + 1]) : 30;
    if (!Number.isInteger(days) || days < 1 || days > 90) {
      throw new Error('--since-days deve essere un intero fra 1 e 90');
    }
    const repo = String(process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '').trim();
    if (!repo) throw new Error('GH_REPO o GITHUB_REPOSITORY mancante');
    const sinceDate = daysAgoDate(days);
    const since = sinceDate + 'T00:00:00Z';
    const history = collectAuditGitHistory({
      since,
      onTiming: (name, duration) => { timings[name] = duration; },
      onCommand: () => { gitCommands += 1; },
    });
    const readGh = (args) => {
      ghCalls += 1;
      return ghJson(args);
    };
    const listedStarted = Date.now();
    let listed;
    try {
      listed = listPullRequestsByDay({ repo, sinceDate, read: readGh });
    } finally {
      timings.pull_request_list_ms = Date.now() - listedStarted;
    }
    const filesStarted = Date.now();
    let resolved;
    let skippedClosed;
    try {
      ({ resolved, skippedClosed } = resolveAutomatedPullRequestFiles(
        listed.filter(isAutomatedDataPullRequest),
        {
          squashPaths: history.squashPaths,
          repo,
          readOpenFiles: (openRepo, number) => readOpenPullRequestFiles(openRepo, number, readGh),
        },
      ));
    } finally {
      timings.pull_request_files_ms = Date.now() - filesStarted;
    }
    const rootEvaluationStarted = Date.now();
    const { candidates, paths: pullRequestPaths } = automatedPullRequestPaths(resolved);
    const audit = auditLiveDataRoots({
      directPaths: history.commitPaths,
      pullRequestPaths,
    });
    timings.root_evaluation_ms = Date.now() - rootEvaluationStarted;
    if (skippedClosed) {
      console.log('live-data-root-audit: ' + skippedClosed
        + ' PR automatiche chiuse senza merge, nulla su main da verificare');
    }
    const runUrl = process.env.GITHUB_RUN_ID && process.env.GITHUB_SERVER_URL
      ? process.env.GITHUB_SERVER_URL + '/' + repo + '/actions/runs/' + process.env.GITHUB_RUN_ID
      : '';
    console.log('live-data-root-audit: ' + history.commitPaths.length + ' percorsi da commit diretti, '
      + candidates.length + ' PR automatiche, ' + audit.uncovered.length + ' percorsi fuori inventario');
    if (!audit.uncovered.length) return 0;
    if (argv.includes('--dry-run')) {
      console.log(audit.uncovered.join('\n'));
      return 0;
    }
    const issueStarted = Date.now();
    try {
      const { createGithubIssue } = await import('../lib/github-issue-creator.mjs');
      const result = await createGithubIssue({
        title: LIVE_DATA_ROOT_AUDIT_TITLE,
        description: renderLiveDataRootDrift({
          sinceDate,
          commitPaths: history.commitPaths,
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
    } finally {
      timings.issue_create_ms = Date.now() - issueStarted;
    }
    return 0;
  } finally {
    timings.git_commands = gitCommands;
    timings.gh_calls = ghCalls;
    timings.total_ms = Date.now() - auditStarted;
    console.log('[audit-timing] ' + JSON.stringify(timings));
  }
}

if (isInvokedDirectly(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error('[live-data-root-audit] ' + (error?.stack || error));
    process.exitCode = 1;
  });
}
