#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSISTED_APPLICATIONS_COLLECTION,
  ASSISTED_APPLICATION_ORDER_ID_RE,
} from '../../functions/src/assistedApplicationConstants.js';
import { FLOW_STATES } from '../../functions/src/assistedApplicationFlow.js';
import { isCaptchaPortalHold } from '../../functions/src/assistedApplicationPortalRetryPolicy.js';
import { isInvokedDirectly } from '../lib/is-invoked-directly.mjs';
import { withSingleFlightLockAsync } from '../lib/single-flight-lock.mjs';

const HOUR_MS = 3_600_000;
const MAX_ORDERS = 2_000;
const PAGE_SIZE = 200;
const ISSUE_LIMIT = 1_000;
export const ISSUE_TITLE = 'Assisted application: ordini fuori SLA';
export const SNAPSHOT_COLLECTION = 'assisted_application_sla';
export const SLA_HOURS = Object.freeze({
  awaiting_upload: 24,
  blocked: 24,
  in_progress: 12,
  ready_for_manual_submission: 12,
  owner_review: 1,
  owner_takeover: 2,
  captcha_requires_owner: 2,
});
const BASE_STATES = new Set(['awaiting_upload', 'blocked', 'in_progress', 'ready_for_manual_submission']);
const OWNER_STATES = new Set(['owner_review', 'owner_takeover']);
const TERMINAL = new Set(['submitted', 'refunded', 'failed', 'withdrawn', 'cancelled']);
const CLOSURE_FIELDS = [
  'withdrawnAt', 'refundedAt', 'submittedAt', 'purgingAt', 'purgedAt',
  'retentionPurgingAt', 'retentionPurgedAt', 'retentionPayloadPurgedAt',
];
class ReportError extends Error {}

const ORDER_FIELDS = [
  'paymentStatus', 'submissionStatus', 'automationState', 'refundStatus', 'automationRefundDueAt',
  'statusChangedAt', 'createdAt', 'paidAt', 'paymentProvider', 'billingMode', ...CLOSURE_FIELDS,
];

export function timestampMs(value, nowMs) {
  let ms = value;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value?.toMillis === 'function') {
    try {
      ms = value.toMillis();
    } catch {
      return null;
    }
  }
  // Firestore timestamps may include sub-millisecond precision.
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 && ms <= nowMs
    && (typeof value !== 'number' || Number.isSafeInteger(ms)) ? ms : null;
}

export function includesOrder(order) {
  return order.paymentStatus === 'paid'
    && !TERMINAL.has(order.submissionStatus) && !TERMINAL.has(order.automationState)
    && !['pending', 'completed', 'succeeded', 'refunded'].includes(order.refundStatus)
    && order.automationRefundDueAt == null
    && !CLOSURE_FIELDS.some(field => order[field] != null);
}

export function flowEntryMs(history, state, nowMs) {
  if (!Array.isArray(history) || history.at(-1)?.state !== state) return null;
  // History is capped by the writer. A preceding different state proves
  // entry into the final continuous run even when older events were trimmed.
  let enteredAt = Infinity;
  for (let index = history.length - 1; index >= 0; index--) {
    const entry = history[index];
    const at = timestampMs(entry?.at, nowMs);
    if (at == null || at > enteredAt || !FLOW_STATES.includes(entry.state)) return null;
    if (entry.state !== state) return enteredAt;
    enteredAt = at;
  }
  return null;
}

export function classifyOrder(order, flow, nowMs) {
  if (!includesOrder(order) || TERMINAL.has(flow?.state) || flow?.withdrawnAt != null) return null;
  const { automationState, submissionStatus } = order;
  if (OWNER_STATES.has(automationState)) {
    if (flow?.state !== automationState || !Array.isArray(flow.heldBy)) {
      return { state: 'unknown', ageMs: null };
    }
    const state = isCaptchaPortalHold(flow) ? 'captcha_requires_owner' : automationState;
    const entry = flowEntryMs(flow.history, automationState, nowMs);
    return { state, ageMs: entry == null ? null : nowMs - entry };
  }
  if (!BASE_STATES.has(submissionStatus) || (automationState != null && !FLOW_STATES.includes(automationState))) {
    return { state: 'unknown', ageMs: null };
  }
  let entry = timestampMs(order.statusChangedAt, nowMs);
  if (submissionStatus === 'awaiting_upload' && automationState == null && order.statusChangedAt == null) {
    const { paymentProvider, billingMode, paidAt, createdAt } = order;
    if (billingMode === 'application_concierge') {
      // Concierge children enter awaiting_upload in the creation write.
      if (paymentProvider === 'parent_service' && paidAt == null) entry = timestampMs(createdAt, nowMs);
    } else if (paymentProvider == null || paymentProvider === 'stripe' || paymentProvider === 'sumup') {
      // The checkout webhook writes paidAt and awaiting_upload together.
      const paid = timestampMs(paidAt, nowMs);
      // A future creation time still contradicts an otherwise valid paidAt.
      const created = timestampMs(createdAt, Infinity);
      if (paid != null && (created == null || paid >= created)) entry = paid;
    }
  }
  return { state: submissionStatus, ageMs: entry == null ? null : nowMs - entry };
}

export function summarizeOrders(rows, nowMs) {
  const empty = () => ({ total: 0, overdue: 0, unknownAge: 0, maxAgeMs: null });
  const report = {
    observedAt: new Date(nowMs).toISOString(),
    ...empty(),
    states: Object.fromEntries([...Object.keys(SLA_HOURS), 'unknown'].map(state => [state, empty()])),
  };
  const overdue = [];
  for (const { id, order, flow } of rows) {
    const classification = classifyOrder(order, flow, nowMs);
    if (!classification) continue;
    const { state, ageMs } = classification;
    const late = ageMs != null && ageMs > SLA_HOURS[state] * HOUR_MS;
    for (const counts of [report, report.states[state]]) {
      counts.total++;
      if (ageMs == null) counts.unknownAge++;
      else counts.maxAgeMs = Math.max(counts.maxAgeMs ?? 0, ageMs);
      if (late) counts.overdue++;
    }
    if (late) overdue.push({ id, state });
  }
  return { report, overdue };
}

export async function scanOrders(db, documentId, nowMs) {
  const rows = await db.runTransaction(async transaction => {
    const query = db.collection(ASSISTED_APPLICATIONS_COLLECTION)
      .where('paymentStatus', '==', 'paid').orderBy(documentId).select(...ORDER_FIELDS);
    const docs = [];
    while (true) {
      const size = Math.min(PAGE_SIZE, MAX_ORDERS + 1 - docs.length);
      const page = docs.length ? query.startAfter(docs.at(-1)) : query;
      const result = await transaction.get(page.limit(size));
      docs.push(...result.docs);
      if (docs.length > MAX_ORDERS) throw new ReportError('Paid order scan exceeds cap of 2000');
      if (result.docs.length < size) break;
    }
    const rows = [];
    for (const doc of docs) {
      const order = doc.data();
      if (!includesOrder(order)) continue;
      let flow;
      if (OWNER_STATES.has(order.automationState)) {
        const query = doc.ref.collection('automation').where(documentId, '==', 'flow')
          .select('state', 'heldBy', 'history', 'withdrawnAt');
        const result = await transaction.get(query);
        flow = result.docs[0]?.data();
      }
      rows.push({ id: doc.id, order, flow });
    }
    return rows;
  }, { readOnly: true });
  return summarizeOrders(rows, nowMs);
}

export function parseArgs(argv, env = process.env) {
  const options = { json: false, record: false, notify: false, privateRepo: null };
  for (let index = 0; index < argv.length; index++) {
    switch (argv[index]) {
      case '--json': options.json = true; break;
      case '--record': options.record = true; break;
      case '--notify': options.notify = true; break;
      case '--private-repo': options.privateRepo = argv[++index] ?? ''; break;
      default: throw new ReportError('Unrecognized SLA report option');
    }
  }
  validateNotification(options, env);
  return options;
}

function validateNotification({ notify, privateRepo }, env) {
  if (notify && env.GITHUB_ACTIONS) throw new ReportError('--notify is disabled in GitHub Actions');
  if (notify && !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(privateRepo ?? '')) {
    throw new ReportError('--notify requires --private-repo OWNER/NAME');
  }
  if (!notify && privateRepo != null) throw new ReportError('--private-repo requires --notify');
}

function runGh(args) {
  const result = spawnSync(join(homedir(), '.local', 'bin', 'gh'), args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000, killSignal: 'SIGKILL',
  });
  if (result.status !== 0) throw new ReportError('GitHub shim command failed');
  return result.stdout;
}

async function notifyRepository(privateRepo, result, gh) {
  const repo = `github.com/${privateRepo}`;
  // The shim caches read commands by argv. Make these decisions from fresh
  // responses, including the visibility check immediately before mutation.
  const fresh = () => ['--jq', `. | select("${randomUUID()}" != "")`];
  const verifyPrivate = () => {
    const info = JSON.parse(gh(['repo', 'view', repo, '--json', 'nameWithOwner,visibility', ...fresh()]));
    if (info?.nameWithOwner !== privateRepo || info.visibility !== 'PRIVATE') {
      throw new ReportError('Notification requires verified PRIVATE visibility for the exact repository');
    }
  };
  verifyPrivate();
  const issues = JSON.parse(gh([
    'issue', 'list', '--repo', repo, '--state', 'open', '--limit', String(ISSUE_LIMIT),
    '--json', 'number,title', ...fresh(),
  ]));
  if (!Array.isArray(issues) || issues.length >= ISSUE_LIMIT
    || issues.some(issue => typeof issue?.title !== 'string' || !Number.isSafeInteger(issue.number) || issue.number <= 0)) {
    throw new ReportError('Open issue scan incomplete');
  }
  const matches = issues.filter(issue => issue.title === ISSUE_TITLE);
  if (matches.length > 1) throw new ReportError('Multiple open SLA issues with the exact title');
  const issue = matches[0];
  if (result.overdue.length === 0) {
    if (issue && result.report.unknownAge === 0) {
      verifyPrivate();
      gh(['issue', 'close', String(issue.number), '--repo', repo]);
    }
    return;
  }
  if (result.overdue.some(({ id }) => !ASSISTED_APPLICATION_ORDER_ID_RE.test(id))) {
    throw new ReportError('Unexpected overdue order ID format');
  }
  const body = result.overdue.map(({ id, state }) => `- \`${id}\` — \`${state}\``).join('\n');
  if (Buffer.byteLength(body) > 65_536) throw new ReportError('SLA issue body exceeds GitHub size limit');

  // The workspace coordinator does not forward client stdin to gh. A
  // private, short-lived body file keeps order IDs out of argv and output.
  const directory = mkdtempSync(join(tmpdir(), 'assisted-sla-issue-'));
  try {
    const path = join(directory, 'body.md');
    writeFileSync(path, body, { mode: 0o600, flag: 'wx' });
    verifyPrivate();
    const action = issue ? ['edit', String(issue.number)] : ['create', '--title', ISSUE_TITLE];
    gh(['issue', ...action, '--repo', repo, '--body-file', path]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function runReport(options, { db, documentId, nowMs = Date.now(), env = process.env, gh = runGh }) {
  validateNotification(options, env);
  const result = await scanOrders(db, documentId, nowMs);
  if (options.record) {
    const hour = new Date(Math.floor(nowMs / HOUR_MS) * HOUR_MS).toISOString();
    await db.collection(SNAPSHOT_COLLECTION).doc(hour).set(result.report);
  }
  if (options.notify) await notifyRepository(options.privateRepo, result, gh);
  return result.report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const timeout = setTimeout(() => {
    console.error('SLA report timed out');
    process.exit(1);
  }, 240_000);
  timeout.unref();
  try {
    const lockPath = join(tmpdir(), 'frontaliere-assisted-application-sla.lock');
    const execution = await withSingleFlightLockAsync(lockPath, async () => {
      const require = createRequire(new URL('../../functions/src/', import.meta.url));
      const { applicationDefault, initializeApp, deleteApp } = require('firebase-admin/app');
      const { FieldPath, getFirestore } = require('firebase-admin/firestore');
      const app = initializeApp({ credential: applicationDefault() });
      try {
        return await runReport(options, { db: getFirestore(app), documentId: FieldPath.documentId() });
      } finally {
        await deleteApp(app);
      }
    });
    if (!execution.acquired) throw new ReportError('SLA report already running');
    console.log(JSON.stringify(execution.value, null, options.json ? 0 : 2));
  } finally {
    clearTimeout(timeout);
  }
}

if (isInvokedDirectly(import.meta.url)) {
  main().catch(error => {
    // SDK/CLI errors can contain document paths or task payloads.
    console.error(error instanceof ReportError ? error.message : 'SLA report failed');
    process.exitCode = 1;
  });
}
