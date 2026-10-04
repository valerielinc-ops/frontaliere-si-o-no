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
// Il revisore automatico pubblica con un'identità diversa per repo: nel sito
// come `frontaliere-automation` (o `claude`), nel corpus come `github-actions`
// (GITHUB_TOKEN del workflow). Un login fisso faceva leggere al report del
// corpus «0 review del bot» su ogni PR. `github-actions` da solo è generico
// (qualunque workflow può recensire con quel token): lì vale come revisore solo
// la review che porta il marcatore d'ingresso del revisore. Repo sconosciuto →
// regola del sito, cioè il comportamento precedente. Il marcatore deve occupare
// una riga intera nella forma canonica (lib/review-input-revision.mjs, non
// importato per tenere lo script autonomo): una citazione inline del marcatore
// in un altro commento non basta.
const REVIEW_INPUT_MARKER = /^<!-- REVIEW_INPUT_REVISION: body:[0-9a-f]{64} -->$/im;
const SITE_REVIEW_BOT = Object.freeze({
  login: /^(?:claude|frontaliere-automation)(?:\[bot\])?$/i,
  marker: null,
});
export const REVIEW_BOT_BY_REPO = Object.freeze({
  'valerielinc-ops/frontaliere-si-o-no': SITE_REVIEW_BOT,
  'nanakokyobashi-rgb/frontaliere-articles': Object.freeze({
    login: /^github-actions(?:\[bot\])?$/i,
    marker: REVIEW_INPUT_MARKER,
  }),
});
export function reviewBotFor(repo) {
  return REVIEW_BOT_BY_REPO[String(repo || '').toLowerCase()] || SITE_REVIEW_BOT;
}
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
export function summarizeRunStats(runs, { limit = RUN_LIST_LIMIT, truncated: knownTruncated } = {}) {
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
  // A caller that merged several bounded reads (runStats reads one UTC day at
  // a time) knows which read hit its limit; the merged length does not.
  const truncated = typeof knownTruncated === 'boolean'
    ? knownTruncated
    : Number.isFinite(limit) && runs.length === limit;
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

const DAY_MS = 86_400_000;

/**
 * The UTC days covered by `--created >since`. GitHub reads a date-only
 * `>YYYY-MM-DD` as "after that whole UTC day" (measured on 2026-10-03: the
 * oldest run returned for `>2026-09-26` was created 2026-09-27T02:46Z, and
 * `--created 2026-09-26` returns exactly that day), so the window starts at
 * midnight of the following day and ends now.
 *
 * @returns {{start: number, days: string[]}|null} null for an unreadable date
 */
export function runListWindow(since, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(since))) return null;
  const sinceDay = Date.parse(`${since}T00:00:00Z`);
  const end = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(sinceDay) || !Number.isFinite(end)) return null;
  const start = sinceDay + DAY_MS;
  const days = [];
  for (let t = start; t <= end; t += DAY_MS) days.push(new Date(t).toISOString().slice(0, 10));
  return { start, days };
}

/**
 * One `gh run list` per UTC day of the window, merged.
 *
 * A single `--created >since --limit 1000` read was truncated on every busy
 * workflow from mid-September (issue 1951): two thirds of the issue-fix runs
 * are `skipped` and they filled the 1000-row cap, so the failure rate stayed
 * `n/d` for weeks. Reading by day keeps each read under the cap; the result is
 * declared truncated only when ONE day reaches it. A run seen by two reads is
 * counted once (by `databaseId`), and a row created before the window start
 * is dropped so the window stays exactly `--created >since`.
 */
export function runStats(workflow, since, runGh = gh, {
  repo = REPO,
  now = new Date(),
  limit = RUN_LIST_LIMIT,
} = {}) {
  const window = runListWindow(since, now);
  if (!window) return unavailableRunStats('invalid-window');
  const byId = new Map();
  const withoutId = [];
  let truncated = false;
  try {
    for (const day of window.days) {
      const rows = runGh(['run', 'list', '--repo', repo, '--workflow', workflow,
        '--created', day, '--limit', String(limit),
        '--json', 'databaseId,conclusion,status,createdAt']);
      if (!Array.isArray(rows)) return unavailableRunStats('invalid-github-response');
      if (rows.length >= limit) truncated = true;
      for (const run of rows) {
        const createdAt = Date.parse(run?.createdAt);
        if (Number.isFinite(createdAt) && createdAt < window.start) continue;
        const id = run?.databaseId;
        if (id === undefined || id === null) withoutId.push(run);
        else if (!byId.has(String(id))) byId.set(String(id), run);
      }
    }
  } catch {
    return unavailableRunStats('github-api-error');
  }
  // Newest first, like a single `gh run list`: fixerJobStats inspects the
  // first FIX_JOB_INSPECTION_LIMIT records as "the most recent".
  const created = (run) => {
    const t = Date.parse(run?.createdAt);
    return Number.isFinite(t) ? t : -Infinity;
  };
  const runs = [...byId.values(), ...withoutId].sort((a, b) => created(b) - created(a));
  return summarizeRunStats(runs, { limit, truncated });
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

export function botReviewCount(pr, repo = REPO) {
  const bot = reviewBotFor(repo);
  return (Array.isArray(pr?.reviews) ? pr.reviews : [])
    .filter((review) => bot.login.test(review?.author?.login || '')
      && (!bot.marker || bot.marker.test(String(review?.body || '')))).length;
}

export function mergedPrStats(since, runGh = gh, { repo = REPO } = {}) {
  let prs;
  try {
    prs = runGh(['pr', 'list', '--repo', repo, '--state', 'merged',
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
  const singleReview = prs.filter((pr) => botReviewCount(pr, repo) === 1).length;
  const zeroReview = prs.filter((pr) => botReviewCount(pr, repo) === 0).length;
  const totalReviews = prs.reduce((sum, pr) => sum + botReviewCount(pr, repo), 0);
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

/** Open issues carrying `label`, with the requested `gh issue list` fields. */
export function labelIssues(label, runGh = gh, {
  repo = REPO,
  limit = LABEL_LIST_LIMIT,
  fields = ['number'],
} = {}) {
  try {
    const out = runGh(['issue', 'list', '--repo', repo, '--state', 'open',
      '--label', label, '--json', fields.join(','), '--limit', String(limit)]);
    if (!Array.isArray(out)) return { measured: false, issues: [], truncated: false };
    if (out.some((issue) => !Number.isInteger(issue?.number) || issue.number <= 0)) {
      return { measured: false, issues: [], truncated: false };
    }
    return { measured: true, issues: out, truncated: out.length === limit };
  } catch {
    return { measured: false, issues: [], truncated: false };
  }
}

export function labelStats(label, runGh = gh, options = {}) {
  const result = labelIssues(label, runGh, options);
  return result.measured
    ? { measured: true, value: result.issues.length, truncated: result.truncated }
    : { measured: false, value: null, truncated: false };
}

// ── Stadio di chiusura ─────────────────────────────────────────────────────
// The report counted the entry of the loop (queue, zombies) but not its exit:
// `maybe-resolved` issues waiting for someone to verify and close them were
// invisible (38 open on 2026-10-03). The label is a request for verification,
// never a proof of resolution, so nothing here calls them "to close".
export const VERIFY_LABEL = 'maybe-resolved';
export const CLOSING_STALE_HOURS = 72;
export const CLOSING_STAGE_INSPECTION_LIMIT = 40;
const CLOSING_OLDEST_SHOWN = 5;
const RECONCILE_KILL_SWITCH = 'RECONCILE_NO_AUTOCLOSE';
const PIN_LABELS = ['keep-open', LBL_NO_AGE_OUT];
const MONITOR_TITLE_PREFIXES = ['[crawler-health]', 'CF 5xx:', 'App Error:', 'CWV Regression'];
const MONITOR_LABEL = /^loop-l/i;

const labelNames = (issue) => (Array.isArray(issue?.labels) ? issue.labels : [])
  .map((label) => (typeof label === 'string' ? label : label?.name))
  .filter((name) => typeof name === 'string');

/**
 * Who is expected to close a `maybe-resolved` issue other than a human
 * verifier. `null` = nobody declared: that is what the alarm counts.
 *
 * @returns {'pin'|'follow-up'|'monitor'|null}
 */
export function closingOwner(issue) {
  const labels = labelNames(issue);
  if (labels.some((label) => PIN_LABELS.includes(label))) return 'pin';
  if (labels.includes('follow-up')) return 'follow-up';
  const title = String(issue?.title || '');
  if (MONITOR_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix))
      || labels.some((label) => MONITOR_LABEL.test(label))) return 'monitor';
  return null;
}

/**
 * When `maybe-resolved` was last applied, from the REST issue events. The
 * GraphQL `timelineItems` connection is not used on purpose: measured on
 * 2026-10-03 it returned `totalCount: 0` for 10 of 22 issues in a batched
 * query and omitted the label event of issue 7421 even when read alone.
 *
 * @returns {number|null} epoch ms, or null when unreadable or absent
 */
export function verifyLabelAppliedAt(issueNumber, runGh = gh, { repo = REPO } = {}) {
  let out;
  try {
    out = runGh([
      'api', '--paginate',
      `repos/${repo}/issues/${issueNumber}/events?per_page=100`,
      '--jq', `.[] | select(.event == "labeled" and .label.name == "${VERIFY_LABEL}") | .created_at`,
    ], { json: false });
  } catch {
    return null;
  }
  const times = String(out || '').split('\n')
    .map((line) => Date.parse(line.trim().replace(/^"|"$/g, '')))
    .filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : null;
}

/**
 * `vars.RECONCILE_NO_AUTOCLOSE` turns the follow-up auto-close of
 * followup-reconcile.yml into flag-only. In the workflow the value comes from
 * `vars` through the environment (GITHUB_TOKEN cannot read repository
 * variables); locally `gh variable get` is used. Unreadable stays unmeasured:
 * never a supposed value.
 *
 * @returns {{measured: boolean, value: string|null}}
 */
export function reconcileKillSwitch(runGh = gh, { repo = REPO, env = process.env } = {}) {
  if (env.LOOP_HEALTH_VARS_FROM_WORKFLOW === '1') {
    const value = String(env[RECONCILE_KILL_SWITCH] || '').trim();
    return { measured: true, value: value || null };
  }
  try {
    const out = runGh(['variable', 'get', RECONCILE_KILL_SWITCH, '--repo', repo], { json: false });
    const value = String(out || '').trim();
    return { measured: true, value: value || null };
  } catch (error) {
    const text = `${error?.message || ''}\n${error?.stderr || ''}`;
    if (/was not found|HTTP 404/i.test(text)) return { measured: true, value: null };
    return { measured: false, value: null };
  }
}

function killSwitchLabel(killSwitch) {
  if (!killSwitch) return null;
  if (!killSwitch.measured) return `\`vars.${RECONCILE_KILL_SWITCH}\` non misurato`;
  if (killSwitch.value === null) return `\`vars.${RECONCILE_KILL_SWITCH}\` non impostata`;
  if (killSwitch.value === '1') return `\`vars.${RECONCILE_KILL_SWITCH}=1\`: auto-close spento, solo flag`;
  return `\`vars.${RECONCILE_KILL_SWITCH}=${killSwitch.value}\` (spegne l'auto-close solo con \`1\`)`;
}

/**
 * Measure the closing stage. Ages are read for at most
 * CLOSING_STAGE_INSPECTION_LIMIT issues (oldest created first): one events
 * read per issue, bounded like the zombie check.
 */
export function closingStageStats(runGh = gh, {
  repo = REPO,
  now = Date.now(),
  inspectionLimit = CLOSING_STAGE_INSPECTION_LIMIT,
  env = process.env,
} = {}) {
  const list = labelIssues(VERIFY_LABEL, runGh, {
    repo,
    fields: ['number', 'title', 'labels', 'createdAt'],
  });
  if (!list.measured) return { measured: false, truncated: false, issues: [], killSwitch: null };
  const ordered = [...list.issues].sort((a, b) => (
    (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0) || a.number - b.number
  ));
  const issues = ordered.map((issue, index) => {
    const appliedAt = index < inspectionLimit ? verifyLabelAppliedAt(issue.number, runGh, { repo }) : null;
    return {
      number: issue.number,
      title: String(issue.title || ''),
      owner: closingOwner(issue),
      inspected: index < inspectionLimit,
      ageHours: appliedAt === null ? null : Math.max(0, (now - appliedAt) / 3_600_000),
    };
  });
  const killSwitch = issues.some((issue) => issue.owner === 'follow-up')
    ? reconcileKillSwitch(runGh, { repo, env })
    : null;
  return {
    measured: true,
    truncated: list.truncated || ordered.length > inspectionLimit,
    listTruncated: list.truncated,
    issues,
    killSwitch,
  };
}

const OWNER_TEXT = {
  'follow-up': 'auto-close a due tier di `followup-reconcile.yml` (cron 06:00Z)',
  pin: 'pin `keep-open`/`agent:no-age-out`',
  monitor: 'monitor proprietario (`[crawler-health]`, `CF 5xx:`, `App Error:`, `CWV Regression`, label `loop-l*`)',
};

function ageLabel(hours) {
  if (hours === null) return 'età n/d';
  return hours >= 48 ? `${Math.floor(hours / 24)}g` : `${Math.floor(hours)}h`;
}

/**
 * Render the closing-stage section and its single warning. The warning counts
 * only the issues older than CLOSING_STALE_HOURS with NO declared closer; the
 * owned ones are listed with their owner and never alarmed.
 *
 * @returns {{lines: string[], warnings: string[], incomplete: boolean}}
 */
export function renderClosingStage(stats) {
  const heading = `### Stadio di chiusura (\`${VERIFY_LABEL}\`)`;
  if (!stats?.measured) {
    return {
      lines: [heading, `**${VERIFY_LABEL} aperte:** n/d (lista issue non misurabile).`],
      warnings: [`stadio di chiusura non misurabile: lista ${VERIFY_LABEL} illeggibile`],
      incomplete: true,
    };
  }
  const issues = stats.issues;
  const aged = issues.filter((issue) => issue.ageHours !== null);
  // Two different gaps, reported apart: an issue skipped by the inspection cap
  // was never read, an inspected one with no age is a read error (or a label
  // event the API did not return).
  const notInspected = issues.filter((issue) => issue.inspected === false).length;
  const unmeasured = issues.length - aged.length - notInspected;
  const stale = aged.filter((issue) => issue.ageHours > CLOSING_STALE_HOURS);
  const staleUnowned = stale.filter((issue) => issue.owner === null);
  const ref = (issue) => `#${issue.number} (${ageLabel(issue.ageHours)})`;
  const lines = [heading];
  lines.push(`**${VERIFY_LABEL} aperte:** ${issues.length} · età della label misurata su ${aged.length}/${issues.length}.`);
  lines.push(`**${VERIFY_LABEL} aperte da più di ${CLOSING_STALE_HOURS} h: ${stale.length}** · senza un chiuditore dichiarato ${staleUnowned.length}${staleUnowned.length ? ` (${staleUnowned.slice(0, CLOSING_OLDEST_SHOWN).map(ref).join(', ')})` : ''}.`);
  for (const owner of ['follow-up', 'pin', 'monitor']) {
    const owned = stale.filter((issue) => issue.owner === owner);
    if (owned.length === 0) continue;
    const extra = owner === 'follow-up' ? `, ${killSwitchLabel(stats.killSwitch)}` : '';
    lines.push(`**Oltre ${CLOSING_STALE_HOURS} h con chiuditore — ${OWNER_TEXT[owner]}${extra}:** ${owned.length} (${owned.slice(0, CLOSING_OLDEST_SHOWN).map(ref).join(', ')}).`);
  }
  const oldest = [...aged].sort((a, b) => b.ageHours - a.ageHours).slice(0, CLOSING_OLDEST_SHOWN);
  if (oldest.length) {
    lines.push(`**Le ${oldest.length} con la label più vecchia:** ${oldest.map((issue) => `${ref(issue)} ${issue.title.slice(0, 60)}`).join(' · ')}.`);
  }
  lines.push(`_\`${VERIFY_LABEL}\` chiede una verifica, non prova che la issue sia risolta._`);
  const warnings = [];
  if (staleUnowned.length > 0) {
    warnings.push(`${staleUnowned.length} issue ${VERIFY_LABEL} oltre ${CLOSING_STALE_HOURS} h senza un chiuditore dichiarato: verifica da fare`);
  }
  if (unmeasured > 0) {
    warnings.push(`età della label ${VERIFY_LABEL} non misurata su ${unmeasured}/${issues.length} issue`);
  }
  if (notInspected > 0) {
    warnings.push(`età della label ${VERIFY_LABEL} letta solo sulle prime ${issues.length - notInspected}/${issues.length} issue (limite di ispezione)`);
  }
  if (stats.listTruncated) {
    warnings.push(`stadio di chiusura troncato: lista ${VERIFY_LABEL} oltre il limite di lettura`);
  }
  return { lines, warnings, incomplete: unmeasured > 0 || notInspected > 0 || Boolean(stats.truncated) };
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
      warns.push(`run list troncata su ${wf} al limite ${RUN_LIST_LIMIT} in un giorno: failure-rate non completo`);
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
  const automationDeferred = labelStats('automation-deferred');
  for (const [label, stat] of [
    ['agent:fix-queued', queued],
    ['fu-parked', parked],
    ['needs-human', needsHuman],
    ['automation-deferred', automationDeferred],
  ]) {
    if (!stat.measured) {
      dataIncomplete = true;
      warns.push(`conteggio label ${label} non misurabile`);
    } else if (stat.truncated) {
      dataIncomplete = true;
      warns.push(`conteggio label ${label} troncato al limite ${LABEL_LIST_LIMIT}`);
    }
  }
  lines.push(`**Backlog:** agent:fix zombie ${countLabel(zombies.measured && !zombies.truncated ? zombies.value : null)} · in coda ${countLabel(queued.measured && !queued.truncated ? queued.value : null)} · fu-parked ${countLabel(parked.measured && !parked.truncated ? parked.value : null)} · needs-human ${countLabel(needsHuman.measured && !needsHuman.truncated ? needsHuman.value : null)} · automation-deferred ${countLabel(automationDeferred.measured && !automationDeferred.truncated ? automationDeferred.value : null)}.`);

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

  // Lo stadio di CHIUSURA del ciclo: senza questa sezione il report vedeva
  // solo l'ingresso (coda, zombie) e non le issue in attesa di verifica.
  // Resta PRIMA della sezione soglie: warnStreaks legge come avvisi tutti i
  // bullet che seguono `### ⚠️ Da investigare`.
  const closing = renderClosingStage(closingStageStats());
  if (closing.incomplete) dataIncomplete = true;
  warns.push(...closing.warnings);
  lines.push('');
  lines.push(...closing.lines);

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
