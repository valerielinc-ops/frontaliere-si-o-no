#!/usr/bin/env node

/**
 * Guardiano del cron di orchestrate-crawlers.
 *
 * Il workflow principale invia la wave e possiede gia' il proprio report di
 * errore. Questo controllo risponde a una domanda diversa: GitHub ha creato
 * almeno una run scheduled per l'ultima slot dovuta? Un cron saltato non ha una
 * run che possa fallire, quindi senza questo heartbeat resta invisibile.
 *
 * L'API viene letta con una pagina limitata e la risposta viene validata prima
 * di essere considerata vuota. Il grace period di default e' 180 minuti,
 * calibrato sulla coda cron osservata nel repository; un ritardo normale non
 * diventa un falso allarme, mentre una slot completamente assente viene pagata
 * con un issue stabile e deduplicato.
 *
 * Read-only verso l'API Actions. L'unica scrittura ammessa e' l'issue stabile
 * di allarme/resolution, gestita dal workflow chiamante.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGithubIssue, resolveGithubIssue } from '../lib/github-issue-creator.mjs';

export const ORCHESTRATOR_WORKFLOW_FILE = 'orchestrate-crawlers.yml';
export const ORCHESTRATOR_WORKFLOW_PATH = `.github/workflows/${ORCHESTRATOR_WORKFLOW_FILE}`;
export const DEFAULT_SCHEDULE_SLOTS = Object.freeze(['09:00', '21:00']);
export const DEFAULT_GRACE_MINUTES = 180;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const MISSING_ISSUE_TITLE = 'Orchestrator heartbeat: scheduled run missing';
export const API_ISSUE_TITLE = 'Orchestrator heartbeat: Actions API unavailable';

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
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate() + dayOffset,
    slot.hour,
    slot.minute,
    0,
    0,
  ));
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

function isTargetRun(run) {
  return run?.path === ORCHESTRATOR_WORKFLOW_PATH && run?.event === 'schedule';
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
} = {}) {
  const checkedAt = validDate(now, 'now');
  const grace = Number(graceMinutes);
  if (!Number.isFinite(grace) || grace < 0 || grace > 24 * 60) {
    throw new RangeError('graceMinutes must be between 0 and 1440');
  }
  const due = latestDueSlot(checkedAt, scheduleSlots);
  const graceEnds = new Date(due.at.getTime() + grace * 60 * 1_000);
  const candidates = (Array.isArray(runs) ? runs : [])
    .filter(isTargetRun)
    .filter((run) => {
      const createdAt = parseRunCreatedAt(run);
      return createdAt && createdAt >= due.at && createdAt < due.nextAt;
    })
    .sort(compareRuns);
  const latestRun = candidates[0] ?? null;
  const observed = latestRun !== null;
  const active = observed && ACTIVE_STATUSES.has(String(latestRun.status ?? ''));
  const state = observed
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
    reason: observed
      ? (active ? 'scheduled_run_in_progress' : 'scheduled_run_observed')
      : (state === 'within_grace' ? 'waiting_for_cron_dispatch' : 'no_scheduled_run_for_due_slot'),
    latestRun: publicRun(latestRun),
    observedRunCount: candidates.length,
  };
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
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('actions_response_too_large');
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('actions_response_too_large');
  try { return JSON.parse(body); } catch { throw new Error('actions_response_invalid_json'); }
}

export async function fetchScheduledRuns({
  apiUrl = process.env.GITHUB_API_URL,
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  fetchImpl = fetch,
} = {}) {
  const base = apiBaseUrl(apiUrl);
  const repo = repositoryPath(repository);
  if (typeof token !== 'string' || token.length === 0) throw new TypeError('GH_TOKEN is required');
  const endpoint = `${base}/repos/${repo}/actions/workflows/${encodeURIComponent(ORCHESTRATOR_WORKFLOW_FILE)}/runs?event=schedule&per_page=100`;
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
    ...fetchOptions
  } = options;
  try {
    const fetched = await fetchScheduledRuns({ ...fetchOptions, fetchImpl });
    return {
      ...classifyHeartbeat({ now, runs: fetched.runs, scheduleSlots, graceMinutes }),
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

function descriptionFor(report) {
  const lines = [
    `**Stato:** \`${report.state}\``,
    `**Slot attesa:** ${report.expectedSlot?.label ?? 'n/d'} (${report.expectedSlot?.at ?? 'n/d'})`,
    `**Grace:** ${report.graceMinutes ?? 'n/d'} minuti`,
    `**Motivo:** \`${report.reason}\``,
    `**Controllato:** ${report.checkedAt}`,
  ];
  if (report.latestRun?.url) lines.push(`**Run osservata:** ${report.latestRun.url}`);
  if (report.error) lines.push(`**Errore API:** \`${report.error}\``);
  lines.push('', 'Il heartbeat controlla solo la presenza della dispatch scheduled; gli errori interni della run restano responsabilita\u0300 del workflow orchestratore.');
  return lines.join('\n');
}

async function reportState(report) {
  if (report.state === 'missing') {
    await createGithubIssue({
      title: MISSING_ISSUE_TITLE,
      description: descriptionFor(report),
      priority: 2,
      labels: ['Bug', 'workflow-watchdog'],
      workflow: 'orchestrator-heartbeat',
    });
    resolveGithubIssue(API_ISSUE_TITLE, { workflow: 'orchestrator-heartbeat' });
    return;
  }
  if (report.state === 'inconclusive') {
    await createGithubIssue({
      title: API_ISSUE_TITLE,
      description: descriptionFor(report),
      priority: 2,
      labels: ['Bug', 'workflow-watchdog'],
      workflow: 'orchestrator-heartbeat',
    });
    return;
  }
  if (report.state === 'observed' || report.state === 'running') {
    resolveGithubIssue(MISSING_ISSUE_TITLE, {
      workflow: 'orchestrator-heartbeat',
      runUrl: report.latestRun?.url,
    });
    resolveGithubIssue(API_ISSUE_TITLE, { workflow: 'orchestrator-heartbeat' });
  }
}

function argumentValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : null;
}

async function main() {
  const output = argumentValue(process.argv.slice(2), '--output');
  const report = await runHeartbeat();
  if (output) {
    const absolute = path.resolve(output);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    const temporary = `${absolute}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.renameSync(temporary, absolute);
  }
  console.log(JSON.stringify(report));
  await reportState(report);
  if (report.alert) process.exitCode = 1;
}

const isDirectRun = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) main().catch((error) => {
  console.error(`[orchestrator-heartbeat] ${error.message}`);
  process.exitCode = 1;
});
