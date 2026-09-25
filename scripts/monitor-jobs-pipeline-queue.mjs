#!/usr/bin/env node
/**
 * monitor-jobs-pipeline-queue.mjs — observability for the `jobs-data-pipeline`
 * concurrency group's `queue: max` behaviour (PR #7035, follow-up items 3+4 of
 * #7063, issue #7165).
 *
 * PR #7035 set `cancel-in-progress: false` + `queue: max` on every workflow
 * sharing the `jobs-data-pipeline` concurrency group, so a run that arrives
 * while another is in flight should WAIT (queued, up to GitHub's documented
 * cap of 100 pending runs — changelog 2026-05-07) instead of being cancelled.
 * Nothing observed whether that assumption actually holds in this repo's plan:
 *   (a) if the plan/context does not fully honour `queue: max`, it can degrade
 *       silently back to the old "1 pending run" limit, which CANCELS the
 *       superseded run instead of queuing it — with `cancel-in-progress: false`
 *       declared, a queued run being cancelled is exactly that signature;
 *   (b) if the queue genuinely fills toward the 100-run cap (crawler burst),
 *       runs beyond it are dropped with no operational signal at all.
 *
 * This scanner covers both, same shape as `scripts/ci/scan-job-timeouts.mjs`
 * (periodic `gh api` scan + `createGithubIssue`, not a change to the
 * pipeline workflows themselves — no workflow file needs to know it exists).
 *
 * Group membership is discovered by scanning every `.github/workflows/*.yml`
 * for a literal `concurrency.group: jobs-data-pipeline` — the same condition
 * `tests/job-translation-queue.test.ts` already enforces for PR #7035 — so a
 * fifth workflow added to the group later is picked up without touching this
 * file. (Detecting a group built via a GitHub `${{ }}` expression is a
 * separate, narrower gap — #7164/PR #7229 — out of scope here.) Parsed with a
 * small line-based scanner, not the `yaml` package: that package is a
 * devDependency, and this script — same convention as
 * `scripts/ci/scan-job-timeouts.mjs` — runs from a bare checkout with no
 * `npm ci` step, Node stdlib + local modules only.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createGithubIssue } from './lib/github-issue-creator.mjs';
import { intFromEnv } from './lib/int-from-env.mjs';
import { buildScheda } from './lib/monitor-scheda.mjs';

const DRY_RUN = process.argv.includes('--dry-run');
const REPO = process.env.GH_REPO || process.env.GITHUB_REPOSITORY || '';
const WORKFLOWS_DIR = process.env.WORKFLOWS_DIR || '.github/workflows';
const JOBS_DATA_PIPELINE_GROUP = 'jobs-data-pipeline';
// GitHub's documented cap for a `queue: max` concurrency group (changelog 2026-05-07).
const QUEUE_CAP = 100;
const SATURATION_WARN_THRESHOLD = intFromEnv('QUEUE_SATURATION_WARN_THRESHOLD', 80);
const CANCELLED_LOOKBACK_MINUTES = intFromEnv('QUEUE_CANCELLED_LOOKBACK_MINUTES', 180);
const TELEMETRY_LOOKBACK_HOURS = intFromEnv('QUEUE_TELEMETRY_LOOKBACK_HOURS', 24);

function repoPath(suffix) {
  return REPO ? `repos/${REPO}/${suffix}` : `repos/{owner}/{repo}/${suffix}`;
}

function gh(args, { allowFailure = false } = {}) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
  } catch (err) {
    if (allowFailure) return null;
    throw err;
  }
}

function ghJson(path, { allowFailure = true } = {}) {
  const out = gh(['api', path], { allowFailure });
  if (!out) return null;
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * True when `yamlText` declares a top-level `concurrency:` mapping whose
 * `group:` key equals `groupName`. Deliberately NOT a full YAML parse (see
 * module docstring): walks the indented block that follows a `concurrency:`
 * line and reads its `group:` entry the same way every workflow in this
 * group actually writes it (`group: jobs-data-pipeline`, unquoted).
 */
export function workflowDeclaresGroup(yamlText, groupName) {
  const lines = yamlText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^concurrency:\s*$/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const indent = line.match(/^(\s*)/)[1].length;
      if (indent === 0) break; // block-mapping ended, back to top level
      const match = line.match(/^\s*group:\s*(.+?)\s*$/);
      if (match) return match[1].replace(/^["']|["']$/g, '') === groupName;
    }
  }
  return false;
}

/**
 * Every workflow file whose `concurrency.group` is the literal
 * `jobs-data-pipeline` string. Mirrors the inventory check in
 * `tests/job-translation-queue.test.ts` so a new group member is observed
 * automatically instead of needing this file edited too.
 */
export function discoverJobsDataPipelineWorkflows(dir = WORKFLOWS_DIR) {
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => join(dir, name))
    .filter((workflowPath) => workflowDeclaresGroup(readFileSync(workflowPath, 'utf8'), JOBS_DATA_PIPELINE_GROUP));
}

function workflowFileName(workflowPath) {
  return workflowPath.split('/').pop();
}

/**
 * Current pending queue depth for the group: sum of `status=queued` runs
 * across every member workflow. `gh api` scopes the runs listing to one
 * workflow file at a time — there is no group-level endpoint — so the group
 * total is the sum over its members.
 */
export function measureQueueDepth(workflowPaths) {
  let depth = 0;
  const perWorkflow = [];
  for (const workflowPath of workflowPaths) {
    const file = workflowFileName(workflowPath);
    const data = ghJson(repoPath(`actions/workflows/${file}/runs?status=queued&per_page=100`));
    const count = Array.isArray(data?.workflow_runs) ? data.workflow_runs.length : 0;
    depth += count;
    perWorkflow.push({ file, count });
  }
  return { depth, perWorkflow };
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function timestamp(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Summarize queue health without making any network calls. `runs` is the
 * bounded set returned by the Actions workflow-runs endpoint for the watched
 * workflows. Wait is measured from creation to the first runner start; the
 * utilization numerator is the union of runner intervals, so overlapping or
 * duplicate observations cannot push it above 100%.
 */
export function summarizeQueueTelemetry(
  runs,
  { now = Date.now(), lookbackMs = TELEMETRY_LOOKBACK_HOURS * 60 * 60_000 } = {},
) {
  const windowStart = now - Math.max(1, lookbackMs);
  const validRuns = Array.isArray(runs) ? runs : [];
  const queuedRuns = validRuns.filter((run) => run?.status === 'queued');
  const activeRuns = validRuns.filter((run) => run?.status === 'in_progress');
  const waits = validRuns
    .map((run) => {
      const created = timestamp(run?.created_at);
      const started = timestamp(run?.run_started_at || run?.started_at);
      return created !== null && started !== null && started >= windowStart && started <= now
        ? Math.max(0, started - created)
        : null;
    })
    .filter((wait) => wait !== null);
  const queuedWaits = queuedRuns
    .map((run) => {
      const created = timestamp(run?.created_at);
      return created !== null && created <= now ? Math.max(0, now - created) : null;
    })
    .filter((wait) => wait !== null);

  const intervals = validRuns
    .map((run) => {
      const started = timestamp(run?.run_started_at || run?.started_at);
      if (started === null || started > now) return null;
      const ended = run?.status === 'in_progress'
        ? now
        : (timestamp(run?.completed_at || run?.updated_at) ?? now);
      const from = Math.max(windowStart, started);
      const to = Math.min(now, ended);
      return to > from ? [from, to] : null;
    })
    .filter(Boolean)
    .sort((a, b) => a[0] - b[0]);
  let busyMs = 0;
  let current = null;
  for (const [from, to] of intervals) {
    if (!current || from > current[1]) {
      if (current) busyMs += current[1] - current[0];
      current = [from, to];
    } else {
      current[1] = Math.max(current[1], to);
    }
  }
  if (current) busyMs += current[1] - current[0];

  const effectiveLookbackMs = Math.max(1, lookbackMs);
  return {
    sampledRuns: validRuns.length,
    queued: queuedRuns.length,
    active: activeRuns.length,
    medianWaitMs: median(waits),
    medianQueuedWaitMs: median(queuedWaits),
    oldestQueuedWaitMs: queuedWaits.length > 0 ? Math.max(...queuedWaits) : null,
    busyMs,
    utilizationPct: Math.min(100, (busyMs / effectiveLookbackMs) * 100),
    lookbackMs: effectiveLookbackMs,
  };
}

/**
 * Fetch the bounded historical sample used by the watchdog's utilization and
 * wait metrics. The queue-depth scan remains separate because it needs the
 * current `status=queued` view and is intentionally cheap.
 */
export function measureQueueTelemetry(
  workflowPaths,
  now = Date.now(),
  lookbackMs = TELEMETRY_LOOKBACK_HOURS * 60 * 60_000,
) {
  const since = new Date(now - lookbackMs).toISOString();
  const allRuns = [];
  const perWorkflow = [];
  for (const workflowPath of workflowPaths) {
    const file = workflowFileName(workflowPath);
    const encodedSince = encodeURIComponent(since);
    const data = ghJson(repoPath(
      `actions/workflows/${file}/runs?status=all&created=%3E%3D${encodedSince}&per_page=100`,
    ));
    const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
    allRuns.push(...runs);
    perWorkflow.push({ file, runs: runs.length });
  }
  return {
    ...summarizeQueueTelemetry(allRuns, { now, lookbackMs }),
    perWorkflow,
  };
}

/**
 * A run cancelled BEFORE any of its jobs ever started is the signature of
 * `queue: max` NOT being honoured: with `cancel-in-progress: false` declared,
 * a queued run is only supposed to wait, never be dropped. `job.started_at`
 * is null on a job that never left the queue — an ordinary failure/cancel
 * that at least started always carries a `started_at`.
 */
export function wasCancelledWhileQueued(job) {
  return job?.status === 'completed' && job?.conclusion === 'cancelled' && !job?.started_at;
}

function findCancelledWhileQueued(workflowPaths, cutoffMs) {
  const hits = [];
  for (const workflowPath of workflowPaths) {
    const file = workflowFileName(workflowPath);
    const data = ghJson(repoPath(`actions/workflows/${file}/runs?status=cancelled&per_page=50`));
    const runs = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
    for (const run of runs) {
      const observedAt = Date.parse(run.updated_at || run.created_at || '');
      if (Number.isFinite(observedAt) && observedAt < cutoffMs) continue;
      const jobsData = ghJson(repoPath(`actions/runs/${run.id}/jobs?per_page=100`));
      const jobs = Array.isArray(jobsData?.jobs) ? jobsData.jobs : [];
      const queuedKills = jobs.filter(wasCancelledWhileQueued);
      if (queuedKills.length > 0) hits.push({ run, workflow: file, jobs: queuedKills });
    }
  }
  return hits;
}

export async function main() {
  const workflowPaths = discoverJobsDataPipelineWorkflows();
  console.log(
    `[monitor-jobs-pipeline-queue] group members: `
      + `${workflowPaths.map(workflowFileName).join(', ') || '(none found)'}`,
  );
  if (workflowPaths.length === 0) {
    console.log(
      '[monitor-jobs-pipeline-queue] no workflow declares the jobs-data-pipeline '
        + 'concurrency group — nothing to observe.',
    );
    return;
  }

  const { depth, perWorkflow } = measureQueueDepth(workflowPaths);
  console.log(
    `[monitor-jobs-pipeline-queue] queue depth: ${depth}/${QUEUE_CAP} `
      + `(${perWorkflow.map((w) => `${w.file}=${w.count}`).join(', ')})`,
  );

  const telemetry = measureQueueTelemetry(workflowPaths);
  const formatMs = (value) => value === null ? 'n/a' : `${Math.round(value / 60_000)}m`;
  console.log(
    `[monitor-jobs-pipeline-queue] telemetry: active=${telemetry.active}, `
      + `median wait=${formatMs(telemetry.medianWaitMs)}, `
      + `oldest queued=${formatMs(telemetry.oldestQueuedWaitMs)}, `
      + `utilization=${telemetry.utilizationPct.toFixed(1)}%/${TELEMETRY_LOOKBACK_HOURS}h`,
  );

  const cutoffMs = Date.now() - CANCELLED_LOOKBACK_MINUTES * 60_000;
  const cancelledWhileQueued = findCancelledWhileQueued(workflowPaths, cutoffMs);

  if (cancelledWhileQueued.length > 0) {
    console.log(
      `[monitor-jobs-pipeline-queue] ALERT: ${cancelledWhileQueued.length} run(s) `
        + 'cancelled while queued',
    );
    const title = 'jobs-data-pipeline: run cancellata mentre era in coda — '
      + 'queue:max potrebbe non essere applicato dal piano';
    const body = [
      '## Run cancellate prima di partire',
      '',
      '`queue: max` con `cancel-in-progress: false` (PR #7035) non dovrebbe mai '
        + 'cancellare una run in coda — solo farla attendere fino al cap di 100. '
        + 'Una run cancellata da `queued` (nessun job mai avviato) è il segnale che '
        + 'il piano/contesto di questo repo non applica la feature per intero e '
        + 'degrada silenziosamente al vecchio limite di 1 run pending.',
      '',
      ...cancelledWhileQueued.map(
        ({ run, workflow, jobs }) => `- **${workflow}** ${run.html_url} — `
          + `${jobs.length} job cancellati mentre erano in coda`,
      ),
      '',
      'Rilevato da `scripts/monitor-jobs-pipeline-queue.mjs` (scan periodico).',
      '',
      buildScheda({
        causa: [
          "(ipotesi, da confermare.) Una run cancellata da `queued`, senza nessun job mai",
          "avviato, e' il segnale che il piano di questo repo non applica `queue: max` per",
          "intero e degrada al vecchio limite di una sola run pendente. E' un'ipotesi sul",
          'piano, non sul workflow: va confermata prima di riscrivere la concorrenza.',
        ],
        fix: [
          "Dipende da cosa conferma l'esame; non preassegnata qui. | **REPO**: sito.",
        ],
        metrica: `prima=${cancelledWhileQueued.length} run cancellate in coda nella finestra atteso=0`,
        comando: 'node scripts/monitor-jobs-pipeline-queue.mjs --dry-run',
        note: [
          'Il comando rifa la stessa scansione e stampa il verdetto senza coniare: la issue si',
          'chiude quando la finestra non porta piu\' nessuna run cancellata mentre era in coda.',
        ],
        osservatore: [
          'Questo stesso monitor, rigirato dal suo cron, che riconia la issue se il caso',
          "ricapita. Non esiste un closer automatico: il comando qui sopra e' il criterio.",
        ],
        fallimento: `\`${title}\``,
      }),
    ].join('\n');
    if (DRY_RUN) {
      console.log(`[monitor-jobs-pipeline-queue] (dry-run) would report "${title}"`);
    } else {
      await createGithubIssue({
        title,
        description: body,
        priority: 1,
        labels: ['Bug', 'ci-timeout'],
        workflow: 'jobs-pipeline-queue-monitor',
      });
    }
  } else {
    console.log('[monitor-jobs-pipeline-queue] no run cancelled-while-queued in the lookback window.');
  }

  if (depth >= SATURATION_WARN_THRESHOLD) {
    console.log(
      `[monitor-jobs-pipeline-queue] ALERT: queue depth ${depth} >= threshold ${SATURATION_WARN_THRESHOLD}`,
    );
    const title = `jobs-data-pipeline: coda in saturazione (${depth}/${QUEUE_CAP})`;
    const body = [
      '## Preallarme saturazione coda',
      '',
      `Profondità corrente della coda \`jobs-data-pipeline\`: **${depth}/${QUEUE_CAP}** `
        + `(soglia di preallarme: ${SATURATION_WARN_THRESHOLD}).`,
      '',
      ...perWorkflow.map((w) => `- ${w.file}: ${w.count} run in coda`),
      `- Telemetria ${TELEMETRY_LOOKBACK_HOURS}h: active=${telemetry.active}, `
        + `median wait=${formatMs(telemetry.medianWaitMs)}, `
        + `utilization=${telemetry.utilizationPct.toFixed(1)}%`,
      '',
      `Oltre il cap di ${QUEUE_CAP} le run vengono scartate silenziosamente, senza `
        + 'segnale operativo. Rilevato da `scripts/monitor-jobs-pipeline-queue.mjs`.',
      '',
      buildScheda({
        causa: [
          `(ipotesi, da confermare.) La coda e' a ${depth} su ${QUEUE_CAP}: qualcosa accoda piu'`,
          'run di quante ne smaltisce. Se sia un aumento della produzione o un rallentamento',
          'del consumo lo dice la ripartizione per workflow qui sopra, non questo totale.',
        ],
        fix: [
          "Dipende da quale dei due; non preassegnata qui. | **REPO**: sito.",
        ],
        metrica: `prima=${depth} run in coda su ${QUEUE_CAP} atteso=<${SATURATION_WARN_THRESHOLD}`,
        comando: 'node scripts/monitor-jobs-pipeline-queue.mjs --dry-run',
        note: [
          'Il comando rilegge la profondita\' corrente senza coniare: la issue si chiude quando',
          'la coda torna sotto la soglia di preallarme.',
        ],
        osservatore: [
          'Questo stesso monitor, rigirato dal suo cron, che riconia la issue se la coda',
          "risale. Non esiste un closer automatico: il comando qui sopra e' il criterio.",
        ],
        fallimento: `\`${title}\``,
      }),
    ].join('\n');
    if (DRY_RUN) {
      console.log(`[monitor-jobs-pipeline-queue] (dry-run) would report "${title}"`);
    } else {
      await createGithubIssue({
        title,
        description: body,
        priority: 2,
        labels: ['Bug'],
        workflow: 'jobs-pipeline-queue-monitor',
      });
    }
  } else {
    console.log('[monitor-jobs-pipeline-queue] queue depth below saturation threshold — no alert.');
  }
}

// Esegui solo come CLI (non quando importato dai test → evita di lanciare gh).
if (process.argv[1]?.endsWith('monitor-jobs-pipeline-queue.mjs')) {
  main().catch((err) => {
    console.error(`[monitor-jobs-pipeline-queue] fatal: ${err.message}`);
    process.exit(1);
  });
}
