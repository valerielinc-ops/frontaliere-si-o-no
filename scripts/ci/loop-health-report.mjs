/**
 * loop-health-report.mjs — osservabilità DETERMINISTICA del loop autonomo
 * (zero-model). Calcola le metriche di salute che altrimenti vanno raccolte
 * a mano: failure-rate dei workflow di automazione, PR con una sola review del
 * bot, zombie agent:fix e backlog della coda.
 *
 * Perché: il sistema si auto-ripara solo se l'osservazione è essa stessa
 * automatica. Questo report chiude il ciclo osserva→fixa→valida: dopo ogni
 * tuning (es. turn-cap bump #1919) il trend dei failure-rate dice se il fix
 * performa o va revertato — senza sessione di analisi dedicata.
 *
 * Output: report markdown su stdout + commento su una issue-tracker dedup
 * (titolo stabile, find-or-create) così lo storico resta consultabile in un
 * posto solo. Soglie ⚠️ inline per le regressioni più care.
 *
 * Uso:  node scripts/ci/loop-health-report.mjs [--days 7] [--no-post]
 * Env:  GH_TOKEN (GITHUB_TOKEN basta: sola lettura + issue comment),
 *       GITHUB_REPOSITORY o GH_REPO.
 */
import { execFileSync } from 'node:child_process';

const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const argv = process.argv.slice(2);
const DAYS = Number(argv.includes('--days') ? argv[argv.indexOf('--days') + 1] : 7);
const NO_POST = argv.includes('--no-post');
const TRACKER_TITLE = '📊 Loop health report (tracker)';
// Never eligible for followup-drainer's age-out close (#5615): a quiet stretch
// with nothing to report still makes this tracker look old+idle to the
// drainer, which would close it — the next run just recreates it, but the
// historical comment thread is lost. Checked in isAgeOutEligible
// (scripts/ci/followup-drainer.mjs); keep the literal in sync.
const LBL_NO_AGE_OUT = 'agent:no-age-out';

// Workflow di automazione osservati dal report. Il provider può cambiare: il
// report non usa questi run per inferire consumo di modello o token.
const AUTOMATION_WORKFLOWS = [
  'issue-fix.yml',
  'pr-redflag-fixer.yml',
  'pr-redcheck-fixer.yml',
  'post-merge-followup.yml',
  'lessons-harvester.yml',
];
// Failure-rate sopra questa soglia sui run terminali eleggibili = regressione
// da investigare (baseline post-#1919: redflag-fixer era al 56%).
const FAIL_RATE_WARN = 0.2;
// Target misurati nell'issue #8306: la quota non deve essere assorbita dalla
// riparazione delle PR generate dal ciclo. Sono warning, non gate: il report
// deve restare osservabile anche quando l'API restituisce un periodo vuoto.
export const PR_REPAIR_RUN_WARN = 400;
export const REPAIR_TO_ISSUE_RATIO_WARN = 7;
export const MERGED_PR_LIST_LIMIT = 1000;
export const RUN_LIST_LIMIT = 1000;
export const FIX_JOB_INSPECTION_LIMIT = 40;
export const ZOMBIE_PR_CHECK_LIMIT = 40;
export const LABEL_LIST_LIMIT = 200;
const REVIEW_BOT_LOGIN = /^(?:claude|frontaliere-automation)(?:\[bot\])?$/i;
const TERMINAL_CONCLUSIONS = new Set([
  'success',
  'failure',
  'cancelled',
  'skipped',
  'neutral',
  'timed_out',
  'startup_failure',
  'action_required',
  'stale',
]);
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure', 'action_required', 'stale']);
const ACTIVE_JOB_STATUSES = new Set(['queued', 'waiting', 'requested', 'pending']);

function gh(args, { json = true } = {}) {
  const out = execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return json ? JSON.parse(out) : out;
}

function isoDaysAgo(d) {
  return new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
}

function unavailableRunStats(reason = 'github-api-error') {
  return {
    measured: false,
    reason,
    total: null,
    completed: null,
    eligible: null,
    running: null,
    unknown: null,
    fail: null,
    ok: null,
    cancelled: null,
    skipped: null,
    rate: null,
    truncated: false,
    records: [],
  };
}

/**
 * Summarize a run-list response without treating an active run as a completed
 * attempt. `records` is retained only for the bounded job inspection below;
 * no provider, token, or delivery claim is derived from it.
 */
export function summarizeRunStats(runs, { limit = RUN_LIST_LIMIT } = {}) {
  if (!Array.isArray(runs)) return unavailableRunStats('invalid-github-response');
  const by = {};
  for (const run of runs) {
    const key = typeof run?.conclusion === 'string' && run.conclusion.length > 0
      ? run.conclusion
      : typeof run?.status === 'string' && run.status.length > 0
        ? run.status
        : 'unknown';
    by[key] = (by[key] || 0) + 1;
  }
  const terminal = runs.filter((run) => TERMINAL_CONCLUSIONS.has(run?.conclusion));
  const activeStatuses = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
  const running = runs.filter((run) => !run?.conclusion && activeStatuses.has(run?.status));
  const unknown = runs.length - terminal.length - running.length;
  const eligible = terminal.filter((run) => !['cancelled', 'skipped'].includes(run.conclusion));
  const fail = eligible.filter((run) => FAILURE_CONCLUSIONS.has(run.conclusion)).length;
  const truncated = Number.isFinite(limit) && runs.length === limit;
  return {
    measured: true,
    reason: null,
    total: runs.length,
    completed: terminal.length,
    eligible: eligible.length,
    running: running.length,
    unknown,
    fail,
    ok: by.success || 0,
    cancelled: by.cancelled || 0,
    skipped: by.skipped || 0,
    // A full run list with no eligible denominator is measured but undefined,
    // not a reassuring 0%.
    // An unrecognised conclusion makes the period incomplete: keep it out of
    // the denominator, but also avoid presenting a partial rate as definitive.
    rate: !truncated && unknown === 0 && eligible.length > 0 ? fail / eligible.length : null,
    truncated,
    records: runs,
  };
}

export function runStats(workflow, since, runGh = gh) {
  try {
    const runs = runGh(['run', 'list', '--repo', REPO, '--workflow', workflow,
      '--created', `>${since}`, '--limit', String(RUN_LIST_LIMIT),
      '--json', 'databaseId,conclusion,status,createdAt']);
    return summarizeRunStats(runs);
  } catch {
    return unavailableRunStats('github-api-error');
  }
}

function unavailableFixerStats(reason = 'github-api-error') {
  return {
    measured: false,
    reason,
    total: null,
    inspected: 0,
    started: null,
    skipped: null,
    running: null,
    pending: null,
    success: null,
    failure: null,
    cancelled: null,
    neutral: null,
    unknown: null,
    truncated: false,
  };
}

/**
 * Classify only the dedicated issue-fix job. A skipped `fix` job is not a
 * fixer execution; a terminal job conclusion is only a job result, never a
 * claim that a model ran or that a PR was delivered.
 */
export function classifyFixerJob(jobs) {
  if (!Array.isArray(jobs)) return { state: 'unknown', outcome: null };
  const rawJob = jobs.find((candidate) => candidate?.name === 'fix');
  if (!rawJob) return { state: 'unknown', outcome: null };
  const job = {
    name: rawJob.name,
    status: typeof rawJob.status === 'string' ? rawJob.status : null,
    conclusion: typeof rawJob.conclusion === 'string' && rawJob.conclusion.length > 0
      ? rawJob.conclusion
      : null,
    // The jobs endpoint is REST-shaped (`started_at`); retain camelCase only
    // as a compatibility input for older local fixtures.
    startedAt: rawJob.started_at ?? rawJob.startedAt ?? null,
  };
  if (job.conclusion === 'skipped') return { state: 'skipped', outcome: 'skipped' };
  const hasStartedAt = typeof job.startedAt === 'string'
    && Number.isFinite(Date.parse(job.startedAt));
  // A terminal conclusion is the result. Check it before using `status` or
  // `started_at` as execution evidence, so `status: completed` never becomes
  // the reported outcome when the actual result is `success`/`failure`.
  if (TERMINAL_CONCLUSIONS.has(job.conclusion)) {
    return hasStartedAt
      ? { state: 'started', outcome: job.conclusion }
      : { state: 'unknown', outcome: null };
  }
  if (job.conclusion !== null) return { state: 'unknown', outcome: null };
  if (job.status === 'in_progress') {
    return { state: 'started', outcome: 'in_progress' };
  }
  if (ACTIVE_JOB_STATUSES.has(job.status)) {
    return hasStartedAt
      ? { state: 'started', outcome: job.status }
      : { state: 'pending', outcome: job.status };
  }
  return { state: 'unknown', outcome: null };
}

/**
 * Inspect at most `FIX_JOB_INSPECTION_LIMIT` recent issue-fix runs. The cap is
 * deliberate: a report must not turn a metric into an unbounded jobs API scan.
 */
export function fixerJobStats(runs, runGh = gh, {
  repo = REPO,
  limit = FIX_JOB_INSPECTION_LIMIT,
} = {}) {
  if (!Array.isArray(runs)) return unavailableFixerStats('invalid-run-list');
  const runsWithIds = runs.filter((run) => run?.databaseId);
  const candidates = runsWithIds.slice(0, limit);
  const truncated = candidates.length < runs.length;
  let measured = runsWithIds.length === runs.length;
  let started = 0;
  let skipped = 0;
  let pending = 0;
  let running = 0;
  let success = 0;
  let failure = 0;
  let cancelled = 0;
  let neutral = 0;
  let unknown = 0;
  for (const run of candidates) {
    let response;
    try {
      response = runGh([
        'api',
        `repos/${repo}/actions/runs/${run.databaseId}/jobs?filter=latest&per_page=100`,
      ]);
    } catch {
      measured = false;
      continue;
    }
    const result = classifyFixerJob(response?.jobs);
    if (result.state === 'skipped') {
      skipped += 1;
    } else if (result.state === 'pending') {
      pending += 1;
    } else if (result.state === 'started') {
      started += 1;
      if (result.outcome === 'success') success += 1;
      else if (FAILURE_CONCLUSIONS.has(result.outcome)) failure += 1;
      else if (result.outcome === 'cancelled') cancelled += 1;
      else if (result.outcome === 'neutral') neutral += 1;
      else if (['in_progress', ...ACTIVE_JOB_STATUSES].includes(result.outcome)) running += 1;
      else {
        unknown += 1;
        measured = false;
      }
    } else {
      unknown += 1;
      measured = false;
    }
  }
  return {
    measured,
    reason: measured ? null : 'jobs-api-error-or-incomplete-response',
    total: runs.length,
    inspected: candidates.length,
    started,
    skipped,
    pending,
    running,
    success,
    failure,
    cancelled,
    neutral,
    unknown,
    truncated,
  };
}

export function repairAllocation({
  prRepairRuns = null,
  issueFixRuns = null,
} = {}) {
  const repairs = prRepairRuns === null || prRepairRuns === undefined ? null : Number(prRepairRuns);
  const issueFix = issueFixRuns === null || issueFixRuns === undefined ? null : Number(issueFixRuns);
  const repairRuns = Number.isFinite(repairs) ? repairs : null;
  const issueFixValue = Number.isFinite(issueFix) ? issueFix : null;
  const ratio = repairRuns !== null && issueFixValue !== null && issueFixValue > 0
    ? `${(repairRuns / issueFixValue).toFixed(1)}:1`
    : 'n/d';
  return { repairRuns, issueFixRuns: issueFixValue, ratio };
}

export function botReviewCount(pr) {
  return (Array.isArray(pr?.reviews) ? pr.reviews : [])
    .filter((review) => REVIEW_BOT_LOGIN.test(review?.author?.login || '')).length;
}

export function mergedPrStats(since, runGh = gh) {
  let prs;
  try {
    prs = runGh(['pr', 'list', '--repo', REPO, '--state', 'merged',
      '--search', `merged:>${since}`, '--limit', String(MERGED_PR_LIST_LIMIT), '--json', 'number,reviews']);
  } catch {
    return {
      measured: false,
      merged: null,
      singleReview: null,
      zeroReview: null,
      totalReviews: null,
      limit: MERGED_PR_LIST_LIMIT,
      truncated: false,
    };
  }
  if (!Array.isArray(prs)) {
    return {
      measured: false,
      merged: null,
      singleReview: null,
      zeroReview: null,
      totalReviews: null,
      limit: MERGED_PR_LIST_LIMIT,
      truncated: false,
    };
  }
  if (prs.some((pr) => !Number.isInteger(pr?.number) || pr.number <= 0 || !Array.isArray(pr.reviews))) {
    return {
      measured: false,
      merged: null,
      singleReview: null,
      zeroReview: null,
      totalReviews: null,
      limit: MERGED_PR_LIST_LIMIT,
      truncated: false,
    };
  }
  const merged = prs.length;
  const singleReview = prs.filter((pr) => botReviewCount(pr) === 1).length;
  const zeroReview = prs.filter((pr) => botReviewCount(pr) === 0).length;
  const totalReviews = prs.reduce((sum, pr) => sum + botReviewCount(pr), 0);
  return {
    measured: true,
    merged,
    singleReview,
    zeroReview,
    totalReviews,
    limit: MERGED_PR_LIST_LIMIT,
    truncated: merged === MERGED_PR_LIST_LIMIT,
  };
}

/** Zombie: issue follow-up con agent:fix, ferma da >24h, senza PR fix APERTA
 * (stessa semantica open-only del drainer post-#1919). */
export function zombieStats(runGh = gh, {
  repo = REPO,
  issueLimit = 100,
  prCheckLimit = ZOMBIE_PR_CHECK_LIMIT,
} = {}) {
  let issues;
  try {
    issues = runGh(['issue', 'list', '--repo', repo, '--state', 'open',
      '--label', 'agent:fix', '--label', 'follow-up',
      '--json', 'number,updatedAt', '--limit', String(issueLimit)]);
  } catch {
    return { measured: false, value: null, candidates: null, inspected: 0, truncated: false };
  }
  if (!Array.isArray(issues)) {
    return { measured: false, value: null, candidates: null, inspected: 0, truncated: false };
  }
  if (issues.some((issue) => (
    !Number.isInteger(issue?.number)
    || issue.number <= 0
    || !Number.isFinite(Date.parse(issue.updatedAt))
  ))) {
    return { measured: false, value: null, candidates: null, inspected: 0, truncated: false };
  }
  const old = issues.filter((issue) => Date.now() - Date.parse(issue.updatedAt) > 24 * 3_600_000);
  const candidates = old.slice(0, prCheckLimit);
  let measured = true;
  let zombies = 0;
  for (const issue of candidates) {
    try {
      const prs = runGh(['pr', 'list', '--repo', repo, '--head', `fix/issue-${issue.number}`,
        '--state', 'open', '--json', 'number', '--limit', '1']);
      if (!Array.isArray(prs) || prs.some((pr) => !Number.isInteger(pr?.number) || pr.number <= 0)) {
        measured = false;
      } else if (prs.length === 0) zombies += 1;
    } catch {
      measured = false;
    }
  }
  const truncated = issues.length === issueLimit || old.length > candidates.length;
  return {
    measured,
    value: measured ? zombies : null,
    candidates: old.length,
    inspected: candidates.length,
    truncated,
  };
}

export function labelStats(label, runGh = gh, {
  repo = REPO,
  limit = LABEL_LIST_LIMIT,
} = {}) {
  try {
    const out = runGh(['issue', 'list', '--repo', repo, '--state', 'open',
      '--label', label, '--json', 'number', '--limit', String(limit)]);
    if (!Array.isArray(out)) return { measured: false, value: null, truncated: false };
    if (out.some((issue) => !Number.isInteger(issue?.number) || issue.number <= 0)) {
      return { measured: false, value: null, truncated: false };
    }
    return { measured: true, value: out.length, truncated: out.length === limit };
  } catch {
    return { measured: false, value: null, truncated: false };
  }
}

/** Tracker issue number (find only — creation stays in the posting path). */
function findTracker() {
  try {
    const found = gh(['issue', 'list', '--repo', REPO, '--state', 'open',
      '--search', `in:title "${TRACKER_TITLE}"`, '--json', 'number,title', '--limit', '5']);
    if (!Array.isArray(found)) return { measured: false, number: null };
    if (found.some((issue) => (
      !Number.isInteger(issue?.number)
      || issue.number <= 0
      || typeof issue.title !== 'string'
    ))) return { measured: false, number: null };
    return { measured: true, number: (found.find((i) => i.title === TRACKER_TITLE) || {}).number || null };
  } catch { return { measured: false, number: null }; }
}

/**
 * Stable key for a warning, so a streak survives the numbers changing.
 * "failure-rate 53% su issue-fix.yml (54/102 run eleggibili)" → "failure-rate:issue-fix.yml".
 */
export function warnKey(text) {
  const s = String(text || '');
  const wf = s.match(/\bsu ([a-z0-9-]+\.yml)/i);
  if (/failure-rate/i.test(s) && wf) return `failure-rate:${wf[1]}`;
  if (/first-shot LGTM rate/i.test(s) || /PR con una sola review del bot/i.test(s)) return 'single-bot-review-rate';
  if (/agent:fix zombie/i.test(s)) return 'zombie';
  if (/PR repair volume/i.test(s)) return 'pr-repair-volume';
  if (/rapporto riparazione PR:issue-fix/i.test(s)) return 'repair-to-issue-ratio';
  if (/coda agent:fix-queued in crescita/i.test(s)) return 'queued-growth';
  return s.replace(/\d+/g, '#').trim();
}

/**
 * Backlog values from prior reports, preserving missing values so two reports
 * separated by an unreadable/malformed report cannot look consecutive.
 * @param {unknown[]} comments oldest first
 * @returns {(number|null)[]}
 */
function priorBacklogValues(comments) {
  return (Array.isArray(comments) ? comments : [])
    .filter((body) => /^## Loop health/m.test(String(body || '')))
    .map((body) => {
      const match = String(body || '').match(/^\*\*Backlog:.*?in coda\s+(\d+)/m);
      return match ? Number(match[1]) : null;
    });
}

/**
 * Warn only after two consecutive increases (three reports including today).
 * One noisy week is not enough; the current value is not persisted anywhere,
 * it is compared to the tracker's existing comments.
 *
 * @param {number} currentQueued current `agent:fix-queued` count
 * @param {unknown[]} comments prior tracker comments, oldest first
 * @returns {string}
 */
export function backlogTrendWarning(currentQueued, comments = []) {
  const current = currentQueued === null || currentQueued === undefined ? null : Number(currentQueued);
  if (current === null || !Number.isFinite(current)) return '';
  const history = priorBacklogValues(comments);
  if (history.length < 2) return '';
  const before = history.at(-2);
  const previous = history.at(-1);
  if (before === null || previous === null) return '';
  if (!(current > previous && previous > before)) return '';
  return `coda agent:fix-queued in crescita: ${before} → ${previous} → ${current} per 3 report consecutivi`;
}

/**
 * The high-cost allocation warnings from issue #8306. Pure so the thresholds
 * can be tested without calling GitHub. A zero issue-fix denominator stays
 * indeterminate rather than becoming a false alarm.
 *
 * @param {{repairRuns?: number, issueFixRuns?: number, queued?: number,
 *          priorComments?: unknown[]}} input
 * @returns {string[]}
 */
export function repairEfficiencyWarnings({
  repairRuns = null,
  issueFixRuns = null,
  queued = null,
  priorComments = [],
} = {}) {
  const repairs = repairRuns === null || repairRuns === undefined ? null : Number(repairRuns);
  const issueFix = issueFixRuns === null || issueFixRuns === undefined ? null : Number(issueFixRuns);
  const warnings = [];
  if (Number.isFinite(repairs) && repairs > PR_REPAIR_RUN_WARN) {
    warnings.push(`PR repair volume ${repairs} run workflow (> ${PR_REPAIR_RUN_WARN})`);
  }
  if (Number.isFinite(repairs) && Number.isFinite(issueFix)
      && issueFix > 0 && repairs / issueFix > REPAIR_TO_ISSUE_RATIO_WARN) {
    warnings.push(`rapporto riparazione PR:issue-fix ${repairs}:${issueFix} (> ${REPAIR_TO_ISSUE_RATIO_WARN}:1)`);
  }
  const trend = backlogTrendWarning(queued, priorComments);
  if (trend) warnings.push(trend);
  return warnings;
}

/**
 * How many CONSECUTIVE prior reports already carried each warning.
 *
 * A threshold line that has been on for two months and never changed state
 * carries no information: the reader learns nothing new from the ninth
 * identical "failure-rate 53% su issue-fix.yml". The count is what makes it
 * readable again — "1 report" is noise from a bad week, "9 consecutive" is an
 * escalation nobody acted on. Deliberately NOT a threshold change: the warning
 * still fires at exactly the same point (AGENTS.md Non-Negotiable #1), it just
 * says how long it has been firing.
 *
 * Source is the tracker's own prior comments — this script's own output — so
 * there is no new state file to keep in sync. Only the last `COMMENT_WINDOW`
 * comments are read, so a streak that reaches the far end of that window is
 * reported as a LOWER BOUND (`capped`) rather than as an exact count.
 *
 * @param {number|null} tracker issue number, or null when it does not exist yet
 * @returns {Map<string, {count: number, since: string, capped: boolean}>}
 */
export function warnStreaks(tracker, fetchComments = defaultFetchComments) {
  const streaks = new Map();
  if (!tracker) return streaks;
  const comments = fetchComments(tracker);
  if (!comments.length) return streaks;
  // Newest first: a streak ends at the first prior report that did NOT warn.
  const ordered = [...comments].reverse();
  const stillRunning = new Set();
  let first = true;
  let reportsSeen = 0;
  for (const body of ordered) {
    const text = String(body || '');
    if (!/^## Loop health/m.test(text)) continue;
    reportsSeen += 1;
    const section = text.split(/###\s*⚠️\s*Da investigare/)[1];
    const dateMatch = text.match(/\(dal (\d{4}-\d{2}-\d{2})\)/);
    const keys = new Set();
    if (section) {
      for (const line of section.split('\n')) {
        const bullet = line.match(/^-\s+(.*)$/);
        if (bullet) keys.add(warnKey(bullet[1]));
      }
    }
    if (first) {
      for (const k of keys) {
        streaks.set(k, { count: 1, since: dateMatch ? dateMatch[1] : '?', capped: false });
        stillRunning.add(k);
      }
      first = false;
      continue;
    }
    for (const k of [...stillRunning]) {
      if (keys.has(k)) {
        const cur = streaks.get(k);
        cur.count += 1;
        cur.since = dateMatch ? dateMatch[1] : cur.since;
      } else {
        stillRunning.delete(k);
      }
    }
    if (stillRunning.size === 0) break;
  }
  // Anything still running when the window ran out started before it.
  for (const k of stillRunning) {
    const cur = streaks.get(k);
    if (cur && cur.count === reportsSeen) cur.capped = true;
  }
  return streaks;
}

/** How far back a streak can be measured (tracker comments, newest last). */
const COMMENT_WINDOW = 14;
const TRACKER_COMMENTS_QUERY = [
  'query($owner:String!,$name:String!,$number:Int!){',
  'repository(owner:$owner,name:$name){issue(number:$number){',
  `comments(last:${COMMENT_WINDOW}){nodes{body}}}}}`,
].join('');

/** Last COMMENT_WINDOW tracker comments, requested bounded from GitHub. */
export function fetchTrackerComments(tracker, runGh = gh, { repo = REPO } = {}) {
  const [owner, name] = String(repo).split('/');
  if (!owner || !name || !Number.isInteger(Number(tracker)) || Number(tracker) <= 0) {
    return { measured: false, comments: [] };
  }
  try {
    const out = runGh([
      'api', 'graphql',
      '-f', `query=${TRACKER_COMMENTS_QUERY}`,
      '-F', `owner=${owner}`,
      '-F', `name=${name}`,
      '-F', `number=${Number(tracker)}`,
    ]);
    if (Array.isArray(out?.errors) && out.errors.length > 0) {
      return { measured: false, comments: [] };
    }
    const nodes = out?.data?.repository?.issue?.comments?.nodes;
    if (!Array.isArray(nodes) || nodes.some((comment) => typeof comment?.body !== 'string')) {
      return { measured: false, comments: [] };
    }
    return { measured: true, comments: nodes.map((comment) => comment.body) };
  } catch { return { measured: false, comments: [] }; }
}

function defaultFetchComments(tracker) {
  return fetchTrackerComments(tracker).comments;
}

function countLabel(value) {
  return value === null || value === undefined ? 'n/d' : String(value);
}

function percentLabel(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(0)}%` : 'n/d';
}

function unavailableFixerStatsForRunList() {
  return unavailableFixerStats('run-list-unavailable');
}

/**
 * Keep the healthy-state line honest when one or more source metrics are
 * incomplete. A report with no warnings is not the same as a complete report.
 */
export function renderThresholdSection(warns, dataIncomplete, streaks = new Map()) {
  if (warns.length) {
    return `### ⚠️ Da investigare\n${warns.map((warning) => {
      const streak = streaks.get(warnKey(warning));
      if (!streak) return `- ${warning} — **nuovo** questo report`;
      const count = `${streak.capped ? '≥' : ''}${streak.count + 1}`;
      return `- ${warning} — sopra soglia da **${count} report consecutivi** (almeno dal ${streak.since})`;
    }).join('\n')}`;
  }
  if (dataIncomplete) {
    return '### ⚠️ Dati incompleti\n- Nessuna soglia è stata dichiarata superata, ma una o più fonti non sono state misurate completamente.';
  }
  return '### ✅ Nessuna soglia superata';
}

function main() {
  if (!REPO) { console.error('GITHUB_REPOSITORY/GH_REPO mancante'); process.exit(1); }
  const since = isoDaysAgo(DAYS);
  const lines = [];
  const warns = [];
  let dataIncomplete = false;
  const workflowStats = {};

  lines.push(`## Loop health — ultimi ${DAYS}gg (dal ${since})`);
  lines.push('');
  lines.push('| Workflow | run eleggibili | ok | fail | rate | in corso | canc | skip |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const wf of AUTOMATION_WORKFLOWS) {
    const s = runStats(wf, since);
    workflowStats[wf] = s;
    if (!s.measured) {
      dataIncomplete = true;
      warns.push(`dati workflow non misurabili su ${wf}: ${s.reason}`);
    } else if (s.truncated) {
      dataIncomplete = true;
      warns.push(`run list troncata su ${wf} al limite ${RUN_LIST_LIMIT}: failure-rate non completo`);
    }
    if (s.measured && s.unknown > 0) {
      dataIncomplete = true;
      warns.push(`run workflow non classificabili su ${wf}: ${s.unknown}`);
    }
    if (s.measured && !s.truncated && s.eligible === 0) {
      dataIncomplete = true;
      warns.push(`failure-rate n/d su ${wf}: nessun run eleggibile nel periodo`);
    }
    const flag = s.rate !== null && s.rate > FAIL_RATE_WARN && s.eligible >= 5 ? ' ⚠️' : '';
    if (flag) warns.push(`failure-rate ${percentLabel(s.rate)} su ${wf} (${s.fail}/${s.eligible} run eleggibili)`);
    lines.push(`| ${wf}${flag} | ${countLabel(s.eligible)} | ${countLabel(s.ok)} | ${countLabel(s.fail)} | ${percentLabel(s.rate)} | ${countLabel(s.running)} | ${countLabel(s.cancelled)} | ${countLabel(s.skipped)} |`);
  }
  lines.push('');
  const issueFix = workflowStats['issue-fix.yml'];
  const fixer = issueFix?.measured ? fixerJobStats(issueFix.records) : unavailableFixerStatsForRunList();
  if (!fixer.measured) {
    dataIncomplete = true;
    warns.push(`job fixer issue-fix non misurabile: ${fixer.reason}`);
  } else if (fixer.truncated) {
    dataIncomplete = true;
    warns.push(`ispezione job fixer troncata al cap ${FIX_JOB_INSPECTION_LIMIT}: ${fixer.inspected}/${fixer.total} run`);
  }
  const fixerLabel = fixer.measured
    ? `job avviati ${fixer.started}, pending ${fixer.pending}, saltati ${fixer.skipped}, esito success ${fixer.success}, failure ${fixer.failure}, cancelled ${fixer.cancelled}, neutral ${fixer.neutral}, in corso ${fixer.running}`
    : 'n/d';
  lines.push(`**Esecuzione fixer issue-fix:** ${fixerLabel} (ispezionati ${countLabel(fixer.inspected)}/${countLabel(fixer.total)}). È un conteggio dei job GitHub: non misura consumo modello, token o PR consegnate.`);

  const pr = mergedPrStats(since);
  if (!pr.measured) {
    dataIncomplete = true;
    warns.push('PR merged non misurabili: GitHub API non disponibile');
  }
  const singleReviewRate = pr.measured && pr.merged > 0 ? pr.singleReview / pr.merged : null;
  if (pr.measured && !pr.truncated && pr.merged >= 10 && singleReviewRate < 0.5) {
    warns.push(`PR con una sola review del bot ${(singleReviewRate * 100).toFixed(0)}% (<50%)`);
  }
  if (pr.truncated) {
    dataIncomplete = true;
    warns.push(`merged PR list troncata al limite ${pr.limit}: conteggi review incompleti`);
  }
  lines.push('');
  const mergedLabel = pr.measured ? `${pr.merged} (${(pr.merged / DAYS).toFixed(1)}/g)` : 'n/d';
  const singleReviewLabel = pr.measured ? `${pr.singleReview}/${pr.merged} (${percentLabel(singleReviewRate)}, zero-review ${pr.zeroReview})` : 'n/d';
  const reviewTotalLabel = pr.measured
    ? `${pr.totalReviews} (overhead ${pr.merged ? ((pr.totalReviews / Math.max(pr.merged, 1) - 1) * 100).toFixed(0) : 0}%)`
    : 'n/d';
  lines.push(`**PR merged:** ${mergedLabel} · PR con una sola review del bot ${singleReviewLabel} · review bot totali ${reviewTotalLabel}.`);

  const zombies = zombieStats();
  if (!zombies.measured) {
    dataIncomplete = true;
    warns.push('zombie agent:fix non misurabili: GitHub API incompleta');
  } else if (zombies.truncated) {
    dataIncomplete = true;
    warns.push(`controllo zombie troncato al cap ${ZOMBIE_PR_CHECK_LIMIT}: risultato parziale`);
  } else if (zombies.value > 0) {
    warns.push(`${zombies.value} issue agent:fix zombie (>24h, nessuna PR aperta)`);
  }
  const queued = labelStats('agent:fix-queued');
  const parked = labelStats('fu-parked');
  const needsHuman = labelStats('needs-human');
  for (const [label, stat] of [['agent:fix-queued', queued], ['fu-parked', parked], ['needs-human', needsHuman]]) {
    if (!stat.measured) {
      dataIncomplete = true;
      warns.push(`conteggio label ${label} non misurabile`);
    } else if (stat.truncated) {
      dataIncomplete = true;
      warns.push(`conteggio label ${label} troncato al limite ${LABEL_LIST_LIMIT}`);
    }
  }
  lines.push(`**Backlog:** agent:fix zombie ${countLabel(zombies.measured && !zombies.truncated ? zombies.value : null)} · in coda ${countLabel(queued.measured && !queued.truncated ? queued.value : null)} · fu-parked ${countLabel(parked.measured && !parked.truncated ? parked.value : null)} · needs-human ${countLabel(needsHuman.measured && !needsHuman.truncated ? needsHuman.value : null)}.`);

  // The tracker comments are already the source for warning streaks. Reuse
  // the same read for the queue trend: no extra GitHub request per report.
  const trackerInfo = findTracker();
  const tracker = trackerInfo.number;
  if (!trackerInfo.measured) {
    dataIncomplete = true;
    warns.push('tracker loop health non misurabile: GitHub API incompleta');
  }
  const trackerCommentsResult = tracker ? fetchTrackerComments(tracker) : { measured: true, comments: [] };
  if (tracker && !trackerCommentsResult.measured) {
    dataIncomplete = true;
    warns.push('commenti tracker loop health non misurabili: GitHub API incompleta');
  }
  const trackerComments = trackerCommentsResult.comments;
  const completeWorkflowCount = (stats) => (
    stats?.measured && !stats.truncated && stats.unknown === 0 ? stats.eligible : null
  );
  const issueFixRuns = completeWorkflowCount(issueFix);
  const redFlagRuns = completeWorkflowCount(workflowStats['pr-redflag-fixer.yml']);
  const redCheckRuns = completeWorkflowCount(workflowStats['pr-redcheck-fixer.yml']);
  const allocation = repairAllocation({
    prRepairRuns: redFlagRuns !== null && redCheckRuns !== null ? redFlagRuns + redCheckRuns : null,
    issueFixRuns,
  });
  if (allocation.repairRuns === null || allocation.issueFixRuns === null) dataIncomplete = true;
  const allocationRepairs = allocation.repairRuns === null ? 'n/d' : allocation.repairRuns;
  lines.push(`**Allocazione workflow:** riparazione PR ${allocationRepairs} run eleggibili · issue-fix ${countLabel(issueFixRuns)} · rapporto ${allocation.ratio}. Non è una stima di consumo modello.`);
  warns.push(...repairEfficiencyWarnings({
    repairRuns: allocation.repairRuns,
    issueFixRuns: allocation.issueFixRuns,
    queued: queued.measured && !queued.truncated ? queued.value : null,
    priorComments: trackerComments,
  }));

  // Quanto dura ciascun allarme: una riga di soglia accesa da due mesi senza
  // mai cambiare stato non si legge più. Il conteggio la rende di nuovo
  // leggibile — "1 report" è rumore di una settimana storta, "9 consecutivi"
  // è un'escalation che nessuno ha raccolto.
  const streaks = warnStreaks(tracker, () => trackerComments);
  lines.push('');
  lines.push(renderThresholdSection(warns, dataIncomplete, streaks));
  lines.push('');
  lines.push('_Report deterministico da loop-health-report.yml. Non inferisce provider, consumo token o consegna PR. Baseline storico 2026-06-12 pre-tuning: ~89 run/g, redflag-fail 56%._');

  const report = lines.join('\n');
  console.log(report);

  if (NO_POST) return;
  // Find-or-create issue tracker, poi commenta il report (storico in un posto).
  let num = tracker;
  // A failed lookup is not evidence that the tracker is absent. Do not turn an
  // unreadable API response into an issue/label mutation.
  if (!num && trackerInfo.measured) {
    try {
      // Best-effort: `gh issue create --label` errors if the label doesn't
      // exist yet. `gh label create` errors if it already does — both fine.
      try { execFileSync('gh', ['label', 'create', LBL_NO_AGE_OUT, '--repo', REPO], { encoding: 'utf8' }); } catch { /* already exists */ }
      const url = gh(['issue', 'create', '--repo', REPO, '--title', TRACKER_TITLE,
        '--label', 'automation',
        '--label', LBL_NO_AGE_OUT,
        '--body', 'Tracker permanente: il report settimanale di salute del loop autonomo atterra qui come commento (loop-health-report.yml, deterministico e senza modello). NON chiudere: il prossimo run la ricreerebbe.'],
        { json: false });
      num = Number((url.match(/\/issues\/(\d+)/) || [])[1]) || null;
    } catch (e) { console.log(`::warning::create tracker fallita: ${String(e).slice(0, 160)}`); }
  }
  if (num) {
    try {
      gh(['issue', 'comment', String(num), '--repo', REPO, '--body', report], { json: false });
      console.log(`Report postato su #${num}.`);
    } catch (e) { console.log(`::warning::comment fallito: ${String(e).slice(0, 160)}`); }
  }
}

// Guarded so the pure helpers above (warnKey/warnStreaks) can be unit-tested
// without the module firing a full network report on import.
if (import.meta.url === `file://${process.argv[1]}`) main();
