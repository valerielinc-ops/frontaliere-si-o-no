#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { realpathSync } from 'node:fs';

/**
 * Guardiano delle slot Cloud Scheduler di orchestrate-crawlers e send-job-alerts.
 *
 * Il workflow principale invia la wave e possiede gia' il proprio report di
 * errore. Questo controllo risponde a una domanda diversa: esiste almeno una
 * run per l'ultima slot dovuta? Una slot saltata non ha una run che possa
 * fallire, quindi senza questo heartbeat resta invisibile.
 *
 * Dal 2026-09-28 l'orologio e' Cloud Scheduler (dispatchCrawlerOrchestrator e
 * dispatchJobAlerts in functions/index.js), che crea le run come
 * `workflow_dispatch` pochi secondi dopo la slot; i cron GitHub rimossi le
 * creavano ore dopo. Contano quindi le run `workflow_dispatch` col marcatore
 * `[cloud-scheduler <slot>]` nel run-name (un dispatch manuale o dry-run non
 * basta). Per il crawler restano riconosciute anche le vecchie run `schedule`;
 * per job alert il fallback nativo delle 12:07 non prova il primario. Il grace
 * period di default e' 120 minuti: due ore assorbono i retry di Cloud Scheduler
 * e un deploy delle functions in corso.
 *
 * L'API viene letta con una pagina limitata e la risposta viene validata prima
 * di essere considerata vuota. Una slot completamente assente viene pagata con
 * un issue stabile e deduplicato.
 *
 * Read-only verso l'API Actions. L'unica scrittura ammessa e' l'issue stabile
 * di allarme/resolution, gestita dal workflow chiamante.
 */

import fs from 'node:fs';
import path from 'node:path';

import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';
import { readBoundedResponseBytes } from '../lib/bounded-response-body.mjs';
import {
  JOB_ALERT_PRIMARY_INTRODUCED_AT,
  JOB_ALERT_PRIMARY_SLOT_UTC,
  JOB_ALERT_WORKFLOW,
} from '../../functions/src/jobAlertSchedule.js';
import { ORCHESTRATOR_SLOTS_UTC } from '../../functions/src/orchestratorSchedule.js';
import {
  SCHEDULER_RUN_MARKER_PREFIX as SHARED_SCHEDULER_RUN_MARKER_PREFIX,
} from '../../functions/src/cloudSchedulerWorkflowContract.js';
import { normalizeOrchestratorSlot } from '../../functions/src/lib/orchestratorSlot.js';

export const ORCHESTRATOR_WORKFLOW_FILE = 'orchestrate-crawlers.yml';
export const ORCHESTRATOR_WORKFLOW_PATH = `.github/workflows/${ORCHESTRATOR_WORKFLOW_FILE}`;
export const DEFAULT_SCHEDULE_SLOTS = ORCHESTRATOR_SLOTS_UTC;
export const JOB_ALERT_WORKFLOW_FILE = JOB_ALERT_WORKFLOW;
export const JOB_ALERT_WORKFLOW_PATH = `.github/workflows/${JOB_ALERT_WORKFLOW_FILE}`;
export const JOB_ALERT_SCHEDULE_SLOTS = Object.freeze([JOB_ALERT_PRIMARY_SLOT_UTC]);
export const DEFAULT_GRACE_MINUTES = 120;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const MISSING_ISSUE_TITLE = 'Orchestrator heartbeat: scheduled run missing';
export const API_ISSUE_TITLE = 'Orchestrator heartbeat: Actions API unavailable';
export const JOB_ALERT_MISSING_ISSUE_TITLE = 'Job alert heartbeat: primary scheduled run missing';
export const JOB_ALERT_API_ISSUE_TITLE = 'Job alert heartbeat: Actions API unavailable';

const ACTIVE_STATUSES = new Set(['queued', 'requested', 'waiting', 'pending', 'in_progress']);

function validDate(value, label) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid date`);
  return date;
}

export function parseScheduleSlot(raw) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(raw ?? '').trim());
  if (!match) throw new TypeError(`schedule slot must look like HH:MM, got "${raw}"`);
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) throw new RangeError(`schedule slot out of range: "${raw}"`);
  return { hour, minute, label: `${match[1]}:${match[2]}` };
}

function normalizeScheduleSlots(slots) {
  const normalized = (Array.isArray(slots) ? slots : DEFAULT_SCHEDULE_SLOTS)
    .map(parseScheduleSlot)
    .sort((left, right) => (left.hour * 60 + left.minute) - (right.hour * 60 + right.minute));
  if (normalized.length === 0) throw new RangeError('at least one schedule slot is required');
  return normalized;
}

function slotInstant(date, slot, dayOffset = 0) {
  return normalizeOrchestratorSlot(new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + dayOffset,
    slot.hour,
    slot.minute,
    0,
    0,
  )));
}

/**
 * Return the latest due slot and the following slot in UTC.
 *
 * @returns {{slot: string, at: Date, nextAt: Date}}
 */
export function latestDueSlot(now = new Date(), scheduleSlots = DEFAULT_SCHEDULE_SLOTS) {
  const date = validDate(now, 'now');
  const slots = normalizeScheduleSlots(scheduleSlots);
  const candidates = [];
  for (const dayOffset of [-1, 0, 1]) {
    for (const slot of slots) candidates.push({ slot, at: slotInstant(date, slot, dayOffset) });
  }
  candidates.sort((left, right) => left.at - right.at);
  const dueIndex = candidates.reduce((index, candidate, candidateIndex) => (
    candidate.at <= date ? candidateIndex : index
  ), -1);
  if (dueIndex < 0 || dueIndex + 1 >= candidates.length) {
    throw new Error('could not determine the next orchestrator schedule slot');
  }
  const due = candidates[dueIndex];
  const next = candidates[dueIndex + 1];
  return { slot: due.slot.label, at: due.at, nextAt: next.at };
}

function parseRunCreatedAt(run) {
  const createdAt = new Date(run?.created_at ?? '');
  return Number.isFinite(createdAt.getTime()) ? createdAt : null;
}

// A `workflow_dispatch` counts only when it carries the Cloud Scheduler
// marker the workflow's run-name derives from its inputs
// (`[cloud-scheduler <slot ISO>]`, never set on a dry run): an unmarked manual
// or dry-run dispatch must not hide a slot the scheduler missed. `schedule`
// covers the runs created before the GitHub cron was removed. The marker is
// shared with both Cloud Scheduler dispatchers by construction.
export const SCHEDULER_RUN_MARKER_PREFIX = SHARED_SCHEDULER_RUN_MARKER_PREFIX;

function isTargetRun(run, { workflowPath, acceptScheduleEvent }) {
  if (run?.path !== workflowPath) return false;
  if (acceptScheduleEvent && run?.event === 'schedule') return true;
  return run?.event === 'workflow_dispatch'
    && String(run?.display_title ?? '').includes(SCHEDULER_RUN_MARKER_PREFIX);
}

function compareRuns(left, right) {
  const byDate = (parseRunCreatedAt(right)?.getTime() ?? -Infinity)
    - (parseRunCreatedAt(left)?.getTime() ?? -Infinity);
  if (byDate !== 0) return byDate;
  return Number(right?.id ?? 0) - Number(left?.id ?? 0);
}

function publicRun(run) {
  if (!run) return null;
  return {
    id: run.id ?? null,
    status: run.status ?? null,
    conclusion: run.conclusion ?? null,
    createdAt: run.created_at ?? null,
    startedAt: run.run_started_at ?? null,
    url: run.html_url ?? null,
    name: run.name ?? null,
    displayTitle: run.display_title ?? null,
    path: run.path ?? null,
    event: run.event ?? null,
  };
}

/**
 * Classify the most recent due slot from an already fetched Actions response.
 * This function never calls GitHub and is deterministic for a given `now`.
 */
export function classifyHeartbeat({
  now = new Date(),
  runs = [],
  scheduleSlots = DEFAULT_SCHEDULE_SLOTS,
  graceMinutes = DEFAULT_GRACE_MINUTES,
  workflowPath = ORCHESTRATOR_WORKFLOW_PATH,
  acceptScheduleEvent = true,
  introducedAt = null,
} = {}) {
  const checkedAt = validDate(now, 'now');
  const grace = Number(graceMinutes);
  if (!Number.isFinite(grace) || grace < 0 || grace > 24 * 60) {
    throw new RangeError('graceMinutes must be between 0 and 1440');
  }
  const introduction = introducedAt == null ? null : validDate(introducedAt, 'introducedAt');
  const due = latestDueSlot(checkedAt, scheduleSlots);
  const graceEnds = new Date(due.at.getTime() + grace * 60 * 1_000);
  const candidates = (Array.isArray(runs) ? runs : [])
    .filter((run) => isTargetRun(run, { workflowPath, acceptScheduleEvent }))
    .filter((run) => {
      const createdAt = parseRunCreatedAt(run);
      return createdAt && createdAt >= due.at && createdAt < due.nextAt;
    })
    .sort(compareRuns);
  const latestRun = candidates[0] ?? null;
  const observed = latestRun !== null;
  const active = observed && ACTIVE_STATUSES.has(String(latestRun.status ?? ''));
  const notYetIntroduced = introduction !== null && due.at < introduction;
  const state = notYetIntroduced
    ? 'not_yet_introduced'
    : observed
      ? (active ? 'running' : 'observed')
      : (checkedAt < graceEnds ? 'within_grace' : 'missing');

  return {
    checkedAt: checkedAt.toISOString(),
    expectedSlot: {
      label: due.slot,
      at: due.at.toISOString(),
      graceEndsAt: graceEnds.toISOString(),
      nextSlotAt: due.nextAt.toISOString(),
    },
    graceMinutes: grace,
    state,
    alert: state === 'missing',
    reason: notYetIntroduced
      ? 'slot_before_introduction'
      : observed
        ? (active ? 'scheduled_run_in_progress' : 'scheduled_run_observed')
        : (state === 'within_grace' ? 'waiting_for_cron_dispatch' : 'no_scheduled_run_for_due_slot'),
    latestRun: publicRun(latestRun),
    observedRunCount: candidates.length,
  };
}

/** Classify the primary job-alert slot; its native fallback must not count. */
export function classifyJobAlertHeartbeat(options = {}) {
  return classifyHeartbeat({
    ...options,
    scheduleSlots: options.scheduleSlots ?? JOB_ALERT_SCHEDULE_SLOTS,
    workflowPath: JOB_ALERT_WORKFLOW_PATH,
    acceptScheduleEvent: false,
    introducedAt: JOB_ALERT_PRIMARY_INTRODUCED_AT,
  });
}

function apiBaseUrl(value) {
  const raw = String(value || 'https://api.github.com').replace(/\/$/, '');
  const parsed = new URL(raw);
  if (parsed.protocol !== 'https:') throw new TypeError('GITHUB_API_URL must use HTTPS');
  return parsed.toString().replace(/\/$/, '');
}

function repositoryPath(repository) {
  if (!/^[^/]+\/[^/]+$/.test(String(repository ?? ''))) {
    throw new TypeError('GITHUB_REPOSITORY must look like owner/repository');
  }
  return String(repository).split('/').map(encodeURIComponent).join('/');
}

async function readJsonBounded(response) {
  // The cap is applied while the body streams: `response.text()` followed by a
  // size check would download a chunked response in full first (#9729).
  const bytes = await readBoundedResponseBytes(response, MAX_RESPONSE_BYTES);
  if (bytes === null) throw new Error('actions_response_too_large');
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new Error('actions_response_invalid_json'); }
}

export async function fetchScheduledRuns({
  workflowFile = ORCHESTRATOR_WORKFLOW_FILE,
  apiUrl = process.env.GITHUB_API_URL,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  fetchImpl = fetch,
} = {}) {
  const base = apiBaseUrl(apiUrl);
  const repo = repositoryPath(repository);
  if (typeof token !== 'string' || token.length === 0) throw new TypeError('GH_TOKEN is required');
  const endpoint = `${base}/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=100`;
  const response = await fetchImpl(endpoint, {
    method: 'GET',
    redirect: 'error',
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  const body = await readJsonBounded(response);
  if (!response.ok) throw new Error(`actions_api_http_${response.status}`);
  if (!body || !Array.isArray(body.workflow_runs)) throw new Error('actions_response_missing_workflow_runs');
  return { runs: body.workflow_runs, endpoint, totalCount: body.total_count ?? null };
}

export async function runHeartbeat(options = {}) {
  const {
    now = new Date(),
    fetchImpl = fetch,
    scheduleSlots = DEFAULT_SCHEDULE_SLOTS,
    graceMinutes = Number(process.env.ORCHESTRATOR_HEARTBEAT_GRACE_MINUTES ?? DEFAULT_GRACE_MINUTES),
    workflowFile = ORCHESTRATOR_WORKFLOW_FILE,
    workflowPath = ORCHESTRATOR_WORKFLOW_PATH,
    acceptScheduleEvent = true,
    classifier = classifyHeartbeat,
    ...fetchOptions
  } = options;
  try {
    const fetched = await fetchScheduledRuns({ ...fetchOptions, workflowFile, fetchImpl });
    return {
      ...classifier({ now, runs: fetched.runs, scheduleSlots, graceMinutes, workflowPath, acceptScheduleEvent }),
      api: { endpoint: fetched.endpoint, totalCount: fetched.totalCount },
    };
  } catch (error) {
    const checkedAt = validDate(now, 'now');
    return {
      checkedAt: checkedAt.toISOString(),
      state: 'inconclusive',
      alert: true,
      reason: 'actions_api_unavailable',
      error: String(error?.message || error).slice(0, 240),
    };
  }
}

export async function runJobAlertHeartbeat(options = {}) {
  return runHeartbeat({
    ...options,
    workflowFile: JOB_ALERT_WORKFLOW_FILE,
    workflowPath: JOB_ALERT_WORKFLOW_PATH,
    scheduleSlots: options.scheduleSlots ?? JOB_ALERT_SCHEDULE_SLOTS,
    acceptScheduleEvent: false,
    classifier: classifyJobAlertHeartbeat,
  });
}

/** Run both independent Cloud Scheduler watches in one heartbeat invocation. */
export async function runAllHeartbeats(options = {}) {
  const {
    now = new Date(),
    graceMinutes = Number(process.env.ORCHESTRATOR_HEARTBEAT_GRACE_MINUTES ?? DEFAULT_GRACE_MINUTES),
    ...fetchOptions
  } = options;
  const [orchestrator, jobAlerts] = await Promise.all([
    runHeartbeat({ ...fetchOptions, now, graceMinutes }),
    runJobAlertHeartbeat({ ...fetchOptions, now, graceMinutes }),
  ]);
  return {
    checkedAt: validDate(now, 'now').toISOString(),
    alert: orchestrator.alert || jobAlerts.alert,
    orchestrator,
    jobAlerts,
  };
}

function descriptionFor(report, workflowLabel) {
  const lines = [
    `**Stato:** \`${report.state}\``,
    `**Slot attesa:** ${report.expectedSlot?.label ?? 'n/d'} (${report.expectedSlot?.at ?? 'n/d'})`,
    `**Grace:** ${report.graceMinutes ?? 'n/d'} minuti`,
    `**Motivo:** \`${report.reason}\``,
    `**Controllato:** ${report.checkedAt}`,
  ];
  if (report.latestRun?.url) lines.push(`**Run osservata:** ${report.latestRun.url}`);
  if (report.error) lines.push(`**Errore API:** \`${report.error}\``);
  lines.push('', `Il heartbeat controlla solo la presenza di una run marcata per ${workflowLabel} (Cloud Scheduler \u2192 workflow_dispatch); gli errori interni della run restano responsabilita\u0300 del workflow chiamato.`);
  return lines.join('\n');
}

async function reportState(report, {
  missingIssueTitle,
  apiIssueTitle,
  workflowLabel,
} = {}) {
  if (report.state === 'not_yet_introduced') return;
  if (report.state === 'missing') {
    await createGithubIssue({
      title: missingIssueTitle,
      description: descriptionFor(report, workflowLabel),
      priority: 2,
      labels: ['Bug', 'workflow-watchdog'],
      workflow: 'orchestrator-heartbeat',
    });
    resolveGithubIssue(apiIssueTitle, { workflow: 'orchestrator-heartbeat' });
    return;
  }
  if (report.state === 'inconclusive') {
    await createGithubIssue({
      title: apiIssueTitle,
      description: descriptionFor(report, workflowLabel),
      priority: 2,
      labels: ['Bug', 'workflow-watchdog'],
      workflow: 'orchestrator-heartbeat',
    });
    return;
  }
  if (report.state === 'observed' || report.state === 'running') {
    resolveGithubIssue(missingIssueTitle, {
      workflow: 'orchestrator-heartbeat',
      runUrl: report.latestRun?.url,
    });
    resolveGithubIssue(apiIssueTitle, { workflow: 'orchestrator-heartbeat' });
  }
}

function argumentValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

async function main() {
  const output = argumentValue(process.argv.slice(2), '--output');
  const report = await runAllHeartbeats();
  if (output) {
    const absolute = path.resolve(output);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, absolute);
  }
  console.log(JSON.stringify(report));
  await reportState(report.orchestrator, {
    missingIssueTitle: MISSING_ISSUE_TITLE,
    apiIssueTitle: API_ISSUE_TITLE,
    workflowLabel: ORCHESTRATOR_WORKFLOW_FILE,
  });
  await reportState(report.jobAlerts, {
    missingIssueTitle: JOB_ALERT_MISSING_ISSUE_TITLE,
    apiIssueTitle: JOB_ALERT_API_ISSUE_TITLE,
    workflowLabel: JOB_ALERT_WORKFLOW_FILE,
  });
  if (report.alert) process.exitCode = 1;
}

const isDirectRun = process.argv[1]
  && (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (isDirectRun) main().catch((error) => {
  console.error(`[orchestrator-heartbeat] ${error.message}`);
  process.exitCode = 1;
});
