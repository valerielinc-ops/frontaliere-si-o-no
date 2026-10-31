/** Exclusive execution of an approved, certainly-unsent portal recovery. */
import { createHash, randomUUID } from 'node:crypto';
import { evaluateRedFlags, roundWasSent } from './assistedApplicationFlow.js';
import { hasAssistedApplicationConsent, ASSISTED_APPLICATION_ORDER_ID_RE } from './assistedApplicationConstants.js';
import { AUTOMATED_PORTAL_CHANNELS } from './lib/portalChannels.js';
import { verifiedInfrastructureProof } from './lib/portalInfrastructureEvidence.js';
import { hasRecordedSubmission } from './assistedApplicationSubmissionGuard.js';
import { automationEligibility } from './assistedApplicationEligibility.js';
import { assistedApplicationRetained } from './lib/assistedApplicationRetentionPolicy.js';

export const REMOTE_EXECUTOR_FLAG = 'ASSISTED_APPLICATION_REMOTE_EXECUTOR';
export const REMOTE_EXECUTOR = 'mac-agenti';
export const REMOTE_EXECUTION_LIMIT = 2;
export const REMOTE_EXECUTION_WINDOW_MS = 24 * 60 * 60 * 1000;
export const EXECUTION_LEASE_MS = 120_000;
export const EXECUTION_HEARTBEAT_MS = 30_000;
export const CONTROLLER_LEASE_MS = 90_000;
export const CONTROLLER_HEARTBEAT_MS = 20_000;
export const EXECUTOR_HEARTBEAT_MAX_AGE_MS = 90_000;
const SOURCE_SHA = /^[a-f0-9]{40}$/;
const ENGINE_VERSION = /^[a-f0-9]{64}$/;
const REMOTE_REASONS = new Set(['portal:captcha_provider_unavailable', 'portal:navigation_unavailable']);

/** Only positively identified pre-click infrastructure failures change host. */
export function remoteExecutionReason(flow, mode) {
  const reason = flow?.dispatch?.recoveryReason;
  const proof = verifiedInfrastructureProof(flow?.infrastructureProof);
  return mode === 'submit' && proof && REMOTE_REASONS.has(reason) && reason === `portal:${proof.class}` ? reason : null;
}

export function recoveryReasonForDispatch(flow, reason) {
  const proof = verifiedInfrastructureProof(flow?.infrastructureProof);
  if (!proof) return null;
  const held = flow?.heldBy || [];
  const allowed = new Set(['portal:captcha_provider_unavailable', 'portal:navigation_unavailable', 'portal:remote_executor_unavailable',
    'portal:captcha', 'portal:portal_needs_candidate', 'portal:portal_antibot', 'portal_antibot']);
  if ((held.length === 1 && allowed.has(held[0])) || reason === 'transient_retry') return `portal:${proof.class}`;
  return null;
}

export function remoteExecutorReady(registry, nowMs = Date.now()) {
  const heartbeat = Number(registry?.heartbeatAt);
  return registry?.ready === true && registry.protocol === 1 && registry.slots === 1
    && SOURCE_SHA.test(registry.sourceSha || '') && Number.isFinite(heartbeat) && heartbeat > 0
    && heartbeat <= nowMs && nowMs - heartbeat < EXECUTOR_HEARTBEAT_MAX_AGE_MS;
}

function canonical(value) {
  if (value instanceof Date) return { date: value.toISOString() };
  if (value && typeof value.toMillis === 'function' && Number.isInteger(value.seconds) && Number.isInteger(value.nanoseconds)) {
    return { seconds: value.seconds, nanoseconds: value.nanoseconds };
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])]));
  return value;
}

/** Hash only; candidate text and answers never leave the private order. */
export function executionMaterialVersion({ order, flow, draft }) {
  const { sent, sentAttempt, ...approvedDraft } = draft || {};
  return createHash('sha256').update(JSON.stringify(canonical({
    cvStorageKey: order?.cvStorageKey, cvFileCheck: order?.cvFileCheck,
    consentVersion: order?.consentVersion, consentedAt: order?.consentedAt,
    identity: { userId: order?.userId, customerEmail: order?.customerEmail, applicantEmail: order?.applicantEmail,
      applicantName: order?.applicantName, applicantPhone: order?.applicantPhone },
    draft: approvedDraft, round: flow?.round,
    answers: flow?.answers || {}, documents: flow?.documents || {},
    formOverrides: flow?.formOverrides || {}, questionAnswers: flow?.questionAnswers || {},
  }))).digest('hex');
}

export function executionEligibility({ orderId, order, flow, draft, submission, round, resumeExecution = null, nowMs = Date.now() }) {
  if (!automationEligibility(order, orderId).eligible) return 'order_ineligible';
  if (!assistedApplicationRetained(order, nowMs)) return 'retention_expired';
  if (flow?.history != null && !Array.isArray(flow.history)) return 'submission_history_unknown';
  if (hasRecordedSubmission({ order, flow, draft, submission })) return 'submission_proven';
  if (order?.paymentStatus !== 'paid' || order.withdrawnAt || submission?.withdrawnAt || order.retentionPurgedAt
    || ['pending', 'succeeded', 'refunded'].includes(order.refundStatus)
    || !['awaiting_upload', 'ready_for_manual_submission', 'in_progress'].includes(order.submissionStatus)) return 'order_ineligible';
  if (!hasAssistedApplicationConsent(order)) return 'consent_missing';
  if (flow?.state !== 'submitting' || Number(flow.round) !== Number(round) || !roundWasSent(flow, round)) return 'round_not_approved';
  if (draft?.status !== 'ready' || Number(draft.round) !== Number(round) || draft.sent || draft.sentAttempt || flow.postingExpiredAt) return 'draft_ineligible';
  if (!AUTOMATED_PORTAL_CHANNELS.has(draft.channel?.type)) return 'not_a_portal_channel';
  const flags = evaluateRedFlags(draft, flow.answers || {}, flow.documents || {}, flow.questionAnswers);
  if (flags.owner.length || flags.candidate.length || flags.documents.length) return 'approval_held';
  const current = submission?.[`r${round}`];
  const resumable = resumeExecution && current?.state === 'sending' && current.channel === 'portal' && !current.clickedAt
    && current.executionId === resumeExecution.id && current.executionGeneration === resumeExecution.lease?.generation;
  const records = Object.entries(submission || {}).filter(([key]) => /^r\d+$/.test(key));
  if (records.some(([key, record]) => record?.state === 'sent' || record?.clickedAt
    || (record?.state === 'sending' && !(key === `r${round}` && resumable)))) return 'submission_not_certainly_unsent';
  if (!resumable && (current?.state !== 'failed' || current.channel !== 'portal' || !Number(current.releasedAt) || current.clickedAt)) return 'no_failed_portal_proof';
  return null;
}

function refs(db, orderId) {
  if (!ASSISTED_APPLICATION_ORDER_ID_RE.test(String(orderId || ''))) throw new Error('execution_order_invalid');
  const order = db.collection('assisted_applications').doc(orderId);
  return { order, flow: order.collection('automation').doc('flow'), draft: order.collection('ai_drafts').doc('current'),
    submission: order.collection('automation').doc('submission'), execution: order.collection('automation').doc('execution') };
}

async function contextIn(transaction, ref) {
  const [order, flow, draft, submission, execution] = await Promise.all(
    [ref.order, ref.flow, ref.draft, ref.submission, ref.execution].map(value => transaction.get(value)));
  return { orderId: ref.order.id, order: order.data() || {}, flow: flow.data() || {}, draft: draft.data() || {},
    submission: submission.data() || {}, execution: execution.data() || {} };
}

/** Called by the normal dispatcher; never changes the approval state or submit record. */
export async function prepareRemoteExecution({ db, orderId, flow, mode, round, sourceSha, nowMs = Date.now(), id = randomUUID() }) {
  if (!SOURCE_SHA.test(sourceSha || '')) throw new Error('execution_source_invalid');
  const ref = refs(db, orderId);
  return db.runTransaction(async transaction => {
    const context = await contextIn(transaction, ref);
    const current = context.flow;
    const reason = remoteExecutionReason(current, mode);
    if (!reason || Number(current.dispatch?.requestedAt) !== Number(flow?.dispatch?.requestedAt)) return null;
    const previousProof = context.execution.outcome === 'deferred' && context.execution.fencedGeneration
      ? { id: context.execution.id, lease: { generation: context.execution.fencedGeneration } } : null;
    if (executionEligibility({ ...context, round, resumeExecution: previousProof, nowMs })) return null;
    if (context.execution.dispatchAt === Number(current.dispatch.requestedAt) && context.execution.sourceSha === sourceSha
      && context.execution.state === 'queued') return context.execution;
    if (context.execution.lease?.expiresAt > nowMs || context.execution.controller?.expiresAt > nowMs) throw new Error('execution_already_leased');
    const sameWindow = Number(current.remoteExecutionRound) === Number(round) && Number(context.execution.windowAt) > 0
      && nowMs - Number(context.execution.windowAt) < REMOTE_EXECUTION_WINDOW_MS;
    const attempts = sameWindow ? Number(current.remoteExecutionAttempts) || 0 : 0;
    if (attempts >= REMOTE_EXECUTION_LIMIT) throw new Error('execution_attempt_limit');
    const execution = { id, sourceSha, executor: REMOTE_EXECUTOR, mode, round: Number(round), reason,
      dispatchAt: Number(current.dispatch.requestedAt), materialVersion: executionMaterialVersion(context),
      requestedAt: nowMs, remoteAttempt: null, state: 'queued', protocol: 1, controller: null, generation: 0, lease: null,
      windowAt: sameWindow ? context.execution.windowAt : null,
      resumeProof: previousProof ? { id: previousProof.id, generation: previousProof.lease.generation } : null };
    transaction.set(ref.execution, execution);
    transaction.set(ref.flow, { executionId: id }, { merge: true });
    return execution;
  });
}

/** The hosted job owns the existing GitHub concurrency slot throughout remote work. */
export function executionController({ db, orderId, executionId, sourceSha, runId, now = Date.now }) {
  const ref = refs(db, orderId);
  const matches = context => {
    const execution = context.execution;
    if (!runId || execution.id !== executionId || context.flow.executionId !== executionId || execution.sourceSha !== sourceSha
      || execution.protocol !== 1 || execution.executor !== REMOTE_EXECUTOR || execution.mode !== 'submit'
      || !SOURCE_SHA.test(sourceSha || '') || execution.dispatchAt !== Number(context.flow.dispatch?.requestedAt)) throw new Error('controller_execution_mismatch');
    return execution;
  };
  return {
    async ready() {
      return db.runTransaction(async transaction => {
        const context = await contextIn(transaction, ref);
        const execution = matches(context);
        const denied = executionEligibility({ ...context, nowMs: now(), round: execution.round, resumeExecution: execution.resumeProof
          ? { id: execution.resumeProof.id, lease: { generation: execution.resumeProof.generation } } : null });
        if (denied || execution.materialVersion !== executionMaterialVersion(context)) throw new Error('controller_material_not_approved');
        if (execution.state !== 'queued' || execution.controller) throw new Error('controller_already_started');
        transaction.set(ref.execution, { state: 'ready', controller: { runId, expiresAt: now() + CONTROLLER_LEASE_MS } }, { merge: true });
        return execution;
      });
    },
    async heartbeat() {
      return db.runTransaction(async transaction => {
        const context = await contextIn(transaction, ref);
        const execution = matches(context);
        if (execution.state === 'finished') return 'finished';
        if (execution.controller?.runId !== runId || execution.controller.expiresAt <= now()) throw new Error('controller_lease_lost');
        transaction.set(ref.execution, { controller: { expiresAt: now() + CONTROLLER_LEASE_MS } }, { merge: true });
        return execution.state;
      });
    },
    async stop() {
      return db.runTransaction(async transaction => {
        const execution = (await transaction.get(ref.execution)).data();
        if (execution?.id === executionId && execution.controller?.runId === runId) transaction.set(ref.execution,
          { controller: { expiresAt: 0 } }, { merge: true });
      });
    },
    async defer() {
      return db.runTransaction(async transaction => {
        const context = await contextIn(transaction, ref);
        const execution = matches(context);
        if (execution.controller?.runId !== runId || (execution.state === 'finished' && execution.outcome !== 'unknown')) return false;
        if (execution.materialVersion !== executionMaterialVersion(context)) return false;
        const resume = execution.state === 'running' ? execution : execution.state === 'finished' && execution.outcome === 'unknown'
          ? { id: execution.id, lease: { generation: execution.generation } } : execution.resumeProof
          ? { id: execution.resumeProof.id, lease: { generation: execution.resumeProof.generation } } : null;
        if (executionEligibility({ ...context, nowMs: now(), round: execution.round, resumeExecution: resume })) return false;
        const records = Object.entries(context.submission).filter(([key]) => /^r\d+$/.test(key)).map(([, record]) => record);
        if (context.draft.sent || context.draft.sentAttempt || records.some(record => record?.state === 'sent' || record?.clickedAt)) return false;
        transaction.set(ref.execution, { state: 'finished', outcome: 'deferred', finishedAt: now(),
          controller: { expiresAt: 0 }, fencedGeneration: execution.lease?.generation || execution.generation || null, lease: null }, { merge: true });
        transaction.set(ref.order.collection('automation_events').doc(), { type: 'submit_handoff', reason: 'remote_executor_unavailable',
          error: 'remote_executor_unavailable', round: execution.round, mode: 'submit', createdAt: now(), runId,
          executionId, sourceSha, dispatchAt: execution.dispatchAt, executionGeneration: execution.generation || 0,
          engineVersion: execution.engineVersion || null, materialVersion: execution.materialVersion });
        return true;
      });
    },
    ref: ref.execution,
  };
}

/** Same Firestore lease protects browser entry, heartbeat, click and runner event. */
export function executionLease({ db, orderId, executionId, sourceSha, engineVersion, owner, token = randomUUID(), now = Date.now }) {
  const ref = refs(db, orderId);
  const identity = (context, { materials = true, outcome = false } = {}) => {
    const execution = context.execution;
    if (!executionId || execution.id !== executionId || (!outcome && context.flow.executionId !== executionId)
      || execution.sourceSha !== sourceSha || !SOURCE_SHA.test(sourceSha || '')
      || !ENGINE_VERSION.test(engineVersion || '') || execution.executor !== REMOTE_EXECUTOR
      || execution.protocol !== 1 || execution.mode !== 'submit'
      || (!outcome && execution.dispatchAt !== Number(context.flow.dispatch?.requestedAt))) throw new Error('execution_superseded');
    if (execution.engineVersion && execution.engineVersion !== engineVersion) throw new Error('execution_engine_changed');
    if (materials && execution.materialVersion !== executionMaterialVersion(context)) throw new Error('execution_material_changed');
    if (!outcome && (context.order.paymentStatus !== 'paid' || context.order.withdrawnAt || context.submission.withdrawnAt || !assistedApplicationRetained(context.order, now())
      || context.flow.submittedAt
      || ['pending', 'succeeded', 'refunded'].includes(context.order.refundStatus)
      || !['awaiting_upload', 'ready_for_manual_submission', 'in_progress'].includes(context.order.submissionStatus)
      || !hasAssistedApplicationConsent(context.order)
      || context.flow.state !== 'submitting' || Number(context.flow.round) !== execution.round
      || !roundWasSent(context.flow, execution.round))) throw new Error('execution_not_submittable');
    return execution;
  };
  const assertInTransaction = async (transaction, options) => {
    const context = await contextIn(transaction, ref);
    const execution = identity(context, options);
    if (options?.materials !== false && hasRecordedSubmission(context)) throw new Error('execution_submission_proven');
    if (execution.state !== 'running' || execution.lease?.token !== token || execution.lease?.owner !== owner
      || execution.lease?.generation !== execution.generation
      || (!options?.outcome && (execution.lease.expiresAt <= now() || execution.controller?.expiresAt <= now()
        || !execution.controller?.runId))) throw new Error('execution_lease_lost');
    return context;
  };
  let reportedType = null;
  return {
    async claim() {
      return db.runTransaction(async transaction => {
        const context = await contextIn(transaction, ref);
        const execution = identity(context);
        const denied = executionEligibility({ ...context, nowMs: now(), round: execution.round,
          resumeExecution: execution.state === 'running' ? execution : execution.resumeProof
            ? { id: execution.resumeProof.id, lease: { generation: execution.resumeProof.generation } } : null });
        if (denied) throw new Error(`execution_${denied}`);
        if (!['ready', 'running'].includes(execution.state) || !execution.controller?.runId
          || execution.controller.expiresAt <= now()) throw new Error('execution_controller_missing');
        if (execution.lease?.expiresAt > now()) throw new Error('execution_already_leased');
        const sameWindow = Number(context.flow.remoteExecutionRound) === execution.round && Number(execution.windowAt) > 0
          && now() - Number(execution.windowAt) < REMOTE_EXECUTION_WINDOW_MS;
        const attempts = sameWindow ? Number(context.flow.remoteExecutionAttempts) || 0 : 0;
        if (attempts >= REMOTE_EXECUTION_LIMIT) throw new Error('execution_attempt_limit');
        const generation = Number(execution.generation || 0) + 1;
        transaction.set(ref.execution, { state: 'running', engineVersion, generation, remoteAttempt: attempts + 1,
          windowAt: sameWindow ? execution.windowAt : now(),
          lease: { owner, token, generation, acquiredAt: now(), expiresAt: now() + EXECUTION_LEASE_MS } }, { merge: true });
        transaction.set(ref.flow, { remoteExecutionRound: execution.round, remoteExecutionAttempts: attempts + 1 }, { merge: true });
        return { executionId, sourceSha, engineVersion, round: execution.round };
      });
    },
    assertInTransaction,
    assertOutcomeInTransaction: transaction => assertInTransaction(transaction, { materials: false, outcome: true }),
    async assert() { return db.runTransaction(assertInTransaction); },
    async heartbeat() {
      return db.runTransaction(async transaction => {
        await assertInTransaction(transaction, { materials: false });
        transaction.set(ref.execution, { lease: { expiresAt: now() + EXECUTION_LEASE_MS } }, { merge: true });
      });
    },
    async complete({ artifacts = {} } = {}) {
      return db.runTransaction(async transaction => {
        const execution = (await transaction.get(ref.execution)).data();
        if (execution?.id !== executionId || execution.sourceSha !== sourceSha || execution.engineVersion !== engineVersion
          || execution.lease?.token !== token || execution.lease.owner !== owner || execution.lease.generation !== execution.generation) return;
        const outcome = reportedType === 'submit_succeeded' ? 'sent' : reportedType ? 'evidenced_failure' : 'unknown';
        transaction.set(ref.execution, { state: 'finished', outcome, artifacts, finishedAt: now(), lease: null }, { merge: true });
      });
    },
    async report(eventRef, event) {
      await db.runTransaction(async transaction => {
        const receipt = event.type === 'submit_succeeded';
        const context = await assertInTransaction(transaction, { materials: false, outcome: receipt });
        if (receipt) {
          const sent = context.submission[`r${context.execution.round}`];
          if (sent?.state !== 'sent' || !sent.clickedAt || sent.executionId !== executionId
            || sent.executionGeneration !== context.execution.generation || sent.executionSourceSha !== sourceSha
            || sent.executionEngineVersion !== engineVersion || sent.executionMaterialVersion !== context.execution.materialVersion
            || sent.executionTokenHash !== createHash('sha256').update(token).digest('hex')) throw new Error('execution_receipt_unproven');
        }
        transaction.set(eventRef, { ...event, round: context.execution.round, mode: context.execution.mode,
          executionId, sourceSha, engineVersion, executionGeneration: context.execution.generation,
          materialVersion: context.execution.materialVersion });
      });
      reportedType = event.type;
    },
  };
}
