/**
 * Orchestrator of the automated assisted application (the second half of the
 * 0,99 € service, formerly done by hand).
 *
 * Split of responsibilities (owner decisions 2026-09-30):
 *   - GitHub Actions (`assisted-application-agent.yml`) does the heavy work:
 *     Codex Luna Max drafts the application, and later submits it. It only
 *     ever receives the order id; it reports back by writing a document in
 *     `assisted_applications/{id}/automation_events`.
 *   - This module owns the state, the clocks and the side effects: it starts
 *     the flow when a CV is verified, applies every event through the pure
 *     state machine (assistedApplicationFlow.js), sends the e-mails, dispatches
 *     the workflow and marks the order as submitted.
 *
 * Where the state lives:
 *   - `assisted_applications/{id}/automation/flow` — the full flow (held-by
 *     reasons, history, candidate feedback and answers). No firestore.rules
 *     entry matches it, so clients are denied.
 *   - the order document only mirrors `automationState` and `automationDueAt`
 *     (the next moment a clock or a watchdog must look at it), because the
 *     customer can read their order and the sweep needs a queryable field.
 *
 * The whole flow is gated by the Remote Config flag
 * ASSISTED_APPLICATION_AUTOMATION ('true' = on). Default: off.
 */

import { FieldValue } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { ASSISTED_APPLICATIONS_COLLECTION } from './assistedApplicationConstants.js';
import { buildAssistedApplicationEvent } from './assistedApplicationAudit.js';
import { isAssistedApplicationCvKey } from './assistedApplicationCvCheck.js';
import { TERMINAL_STATES, transition } from './assistedApplicationFlow.js';
import { GITHUB_API, getRepoConfig } from './githubProxy.js';
import { githubApiHeaders } from './githubApiHeaders.js';
import { getRemoteConfigValue } from './remoteConfigSecrets.js';

export const AUTOMATION_FLAG_KEY = 'ASSISTED_APPLICATION_AUTOMATION';
export const AGENT_WORKFLOW = 'assisted-application-agent.yml';
export const AUTOMATION_SUBCOLLECTION = 'automation';
export const FLOW_DOC_ID = 'flow';
export const AUTOMATION_EVENTS_SUBCOLLECTION = 'automation_events';
export const AI_DRAFTS_SUBCOLLECTION = 'ai_drafts';
export const AI_DRAFT_DOC_ID = 'current';

/** A dispatched run that reported nothing for this long is presumed lost. */
export const RUN_WATCHDOG_MS = 45 * 60 * 1000;
/** Draft runs at Codex effort max take ~10–15 min; submissions can take longer. */
export const MAX_DISPATCH_ATTEMPTS = 2;
const DISPATCH_TIMEOUT_MS = 20_000;
const SWEEP_BATCH = 50;
const RUNNER_EVENT_TYPES = new Set([
  'draft_ready',
  'draft_failed',
  'posting_closed',
  'submit_succeeded',
  'submit_handoff',
  'submit_needs_candidate',
  'submit_failed',
]);
const STARTABLE_STATUSES = new Set(['awaiting_upload', 'ready_for_manual_submission', 'in_progress']);
const SUPPORTED_CV_TYPES = new Set(['pdf', 'docx', 'doc']);

export function orderRefFor(db, orderId) {
  return db.collection(ASSISTED_APPLICATIONS_COLLECTION).doc(String(orderId));
}

export function flowRefFor(db, orderId) {
  return orderRefFor(db, orderId).collection(AUTOMATION_SUBCOLLECTION).doc(FLOW_DOC_ID);
}

export function draftRefFor(db, orderId) {
  return orderRefFor(db, orderId).collection(AI_DRAFTS_SUBCOLLECTION).doc(AI_DRAFT_DOC_ID);
}

/**
 * The Remote Config flag: "true" automates every order; "false" or empty
 * none; anything else is a list of order ids (commas or spaces) and automates
 * only those — the final trial run, before switching on for everyone.
 */
export function parseAutomationFlag(value) {
  const text = String(value || '').trim();
  if (text.toLowerCase() === 'true') return { all: true, orders: new Set() };
  if (!text || text.toLowerCase() === 'false') return { all: false, orders: new Set() };
  return { all: false, orders: new Set(text.split(/[\s,]+/).filter(Boolean)) };
}

/** Fails closed: any error reading Remote Config means "off". */
async function readAutomationFlag(read) {
  try {
    return parseAutomationFlag(await (read || getRemoteConfigValue)(AUTOMATION_FLAG_KEY));
  } catch (error) {
    console.warn('[assistedApplicationAutomation] flag read failed', error instanceof Error ? error.message : String(error));
    return parseAutomationFlag('');
  }
}

/** On for at least one order: the sweeps run (they only touch orders that have a flow). */
export async function isAutomationEnabled(read = null) {
  const flag = await readAutomationFlag(read);
  return flag.all || flag.orders.size > 0;
}

/** On for this order: whatever creates a flow or changes its e-mails asks this. */
export async function isAutomationEnabledFor(orderId, read = null) {
  const flag = await readAutomationFlag(read);
  return flag.all || flag.orders.has(String(orderId || ''));
}

/** The order's CV passed the magic-byte check for its current key. */
export function isCvReady(order) {
  const check = order?.cvFileCheck;
  return Boolean(order?.cvStorageKey && check && check.key === order.cvStorageKey && check.verdict === 'ok');
}

export function automationEligibility(order, orderId) {
  if (!order || order.paymentStatus !== 'paid') return { eligible: false, reason: 'not_paid' };
  if (!STARTABLE_STATUSES.has(order.submissionStatus)) return { eligible: false, reason: 'order_closed' };
  if (order.refundStatus === 'pending') return { eligible: false, reason: 'refund_in_progress' };
  if (!isAssistedApplicationCvKey(orderId, order.cvStorageKey)) return { eligible: false, reason: 'cv_missing' };
  if (!isCvReady(order)) return { eligible: false, reason: 'cv_not_verified' };
  if (!SUPPORTED_CV_TYPES.has(order.cvFileCheck.detectedType)) return { eligible: false, reason: 'cv_format_unsupported' };
  return { eligible: true, reason: null };
}

/** Next moment the sweep must look at this flow (clock, reminder or watchdog). */
export function computeDueAt(flow) {
  if (!flow || TERMINAL_STATES.has(flow.state)) return null;
  if (['drafting', 'regenerating', 'submitting'].includes(flow.state)) {
    const requestedAt = Number(flow.dispatch?.requestedAt) || 0;
    return requestedAt ? requestedAt + RUN_WATCHDOG_MS : null;
  }
  const candidates = [flow.deadlineAt, flow.reminderAt].map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length ? Math.min(...candidates) : null;
}

function mirrorFields(flow) {
  return {
    automationState: flow.state,
    automationDueAt: computeDueAt(flow),
    automationUpdatedAt: FieldValue.serverTimestamp(),
  };
}

// ── GitHub Actions dispatch ────────────────────────────────────────────────

/**
 * Dispatch the agent workflow. Only the order id, the mode and the round
 * leave for GitHub: the repository is public, so nothing personal may appear
 * in the run's inputs.
 */
export async function dispatchAgentWorkflow({ orderId, mode, round, fetchImpl = fetch, getRepoConfigImpl = getRepoConfig }) {
  const { pat, owner, repo } = await getRepoConfigImpl();
  if (!pat) throw new Error('github_pat_not_configured');
  const response = await fetchImpl(`${GITHUB_API}/repos/${owner}/${repo}/actions/workflows/${AGENT_WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: githubApiHeaders(pat, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ ref: 'main', inputs: { order_id: String(orderId), mode, round: String(round) } }),
    signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`agent_dispatch_failed:${response.status}:${body.slice(0, 160)}`);
  }
  return { ok: true };
}

// ── Applying events ────────────────────────────────────────────────────────

/**
 * Apply one event to one order's flow, atomically, then run its effects.
 *
 * @param {object} args
 * @param {FirebaseFirestore.Firestore} args.db
 * @param {string} args.orderId
 * @param {{type:string}} args.event
 * @param {string} [args.actor] 'runner' | 'candidate' | 'owner:<email>' | 'clock'
 * @param {(ctx:object)=>Promise<object>} args.runEffect executes one side effect
 * @param {number} [args.nowMs]
 * @param {(flow:object)=>object} [args.patchFlow] extra fields merged into the next flow
 * @param {FirebaseFirestore.DocumentReference} [args.claimRef] a runner event document: marked
 *   `appliedAt` in the SAME transaction as the transition, so an error in between can never leave
 *   an event marked applied with the flow unchanged (a redelivery then applies it)
 */
export async function applyAutomationEvent({ db, orderId, event, actor = 'system', runEffect, nowMs = Date.now(), patchFlow = null, claimRef = null }) {
  const orderRef = orderRefFor(db, orderId);
  const flowRef = flowRefFor(db, orderId);
  const draftRef = draftRefFor(db, orderId);
  let outcome = null;
  await db.runTransaction(async (transaction) => {
    const [orderSnapshot, flowSnapshot, draftSnapshot, claimSnapshot] = await Promise.all([
      transaction.get(orderRef),
      transaction.get(flowRef),
      transaction.get(draftRef),
      claimRef ? transaction.get(claimRef) : Promise.resolve(null),
    ]);
    if (claimSnapshot?.data()?.appliedAt) {
      outcome = { ok: false, ignored: 'already_applied' };
      return;
    }
    // Every deterministic outcome (applied or ignored) marks the event; an
    // exception aborts the whole transaction and leaves it unmarked.
    const claim = (result) => {
      if (claimRef) transaction.set(claimRef, { appliedAt: nowMs, result }, { merge: true });
    };
    if (!orderSnapshot.exists || !flowSnapshot.exists) {
      claim('ignored:no_flow');
      outcome = { ok: false, ignored: 'no_flow' };
      return;
    }
    const flow = flowSnapshot.data() || {};
    const draft = draftSnapshot.exists ? draftSnapshot.data() || {} : null;
    // A runner event from a superseded round is stale: never let it move the
    // current round (e.g. a slow draft of round 1 finishing after a rejection).
    if (RUNNER_EVENT_TYPES.has(event.type) && Number(event.round) && Number(event.round) !== Number(flow.round || 1)) {
      claim('ignored:stale_round');
      outcome = { ok: false, ignored: 'stale_round' };
      return;
    }
    const result = transition(flow, event, { draft, answers: flow.answers || {}, nowMs });
    if (result.ignored) {
      claim(`ignored:${result.ignored}`);
      outcome = { ok: false, ignored: result.ignored, state: flow.state };
      return;
    }
    const nextFlow = {
      ...flow,
      ...result.flow,
      ...(patchFlow ? patchFlow(flow) : {}),
      updatedAt: nowMs,
    };
    // A dispatch effect is recorded now, in the same write, so the watchdog
    // always knows when the run was asked for.
    const dispatch = result.effects.find((effect) => effect.type === 'dispatch');
    if (dispatch) {
      nextFlow.dispatch = {
        mode: dispatch.mode,
        round: nextFlow.round,
        requestedAt: nowMs,
        // A retry carries its count, so the watchdog and the flow share the limit.
        attempts: Number(dispatch.attempts) || 1,
        reason: dispatch.reason || null,
      };
    }
    claim('applied');
    transaction.set(flowRef, nextFlow);
    transaction.set(orderRef, mirrorFields(nextFlow), { merge: true });
    transaction.set(orderRef.collection('events').doc(), buildAssistedApplicationEvent('automation_transition', {
      actor: String(actor).slice(0, 120),
      eventType: event.type,
      fromState: flow.state || null,
      toState: nextFlow.state,
      round: nextFlow.round,
    }));
    outcome = { ok: true, fromState: flow.state, flow: nextFlow, effects: result.effects };
  });

  if (outcome?.ok && runEffect) {
    outcome.effectResults = [];
    for (const effect of outcome.effects) {
      try {
        outcome.effectResults.push(await runEffect({ db, orderId, effect, flow: outcome.flow, nowMs }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[assistedApplicationAutomation] effect failed', orderId, effect.type, effect.kind || effect.mode || '', message);
        outcome.effectResults.push({ ok: false, effect: effect.type, error: message });
      }
    }
  }
  return outcome || { ok: false, ignored: 'unknown' };
}

// ── Start ──────────────────────────────────────────────────────────────────

/**
 * Firestore onDocumentWritten for the order: when the CV has just been
 * verified and automation is on, create the flow and dispatch the first draft.
 */
export async function maybeStartAutomation(before, after, orderId, {
  db,
  enabled = isAutomationEnabledFor,
  runEffect,
  ensureAlias = null,
  nowMs = Date.now(),
} = {}) {
  if (!after) return { ok: true, skipped: 'deleted' };
  const cvJustReady = isCvReady(after) && !(isCvReady(before) && before?.cvStorageKey === after.cvStorageKey);
  if (!cvJustReady) return { ok: true, skipped: 'no_new_cv' };
  const eligibility = automationEligibility(after, orderId);
  if (!eligibility.eligible) return { ok: true, skipped: eligibility.reason };
  if (!(await enabled(orderId))) return { ok: true, skipped: 'automation_disabled' };
  return startAutomation({ db, orderId, runEffect, nowMs, reason: 'cv_verified', ensureAlias });
}

/** Create the flow (idempotent) and dispatch the first draft. */
export async function startAutomation({ db, orderId, runEffect, nowMs = Date.now(), reason = 'owner_request', ensureAlias = null }) {
  const orderRef = orderRefFor(db, orderId);
  const flowRef = flowRefFor(db, orderId);
  let created = null;
  await db.runTransaction(async (transaction) => {
    created = null; // Firestore retries a contended transaction: never keep a previous attempt's result
    const [orderSnapshot, flowSnapshot] = await Promise.all([transaction.get(orderRef), transaction.get(flowRef)]);
    if (!orderSnapshot.exists) return;
    const existing = flowSnapshot.exists ? flowSnapshot.data() || {} : null;
    // A live flow is never restarted; a finished takeover can be restarted by the owner.
    if (existing && !(reason === 'owner_request' && existing.state === 'owner_takeover')) return;
    const order = orderSnapshot.data() || {};
    if (!automationEligibility(order, orderId).eligible) return;
    const flow = {
      state: 'drafting',
      round: 1,
      deadlineAt: null,
      reminderAt: null,
      reminderSentAt: null,
      heldBy: [],
      feedback: existing?.feedback || [],
      answers: existing?.answers || {},
      history: [...(existing?.history || []), { at: nowMs, event: `start:${reason}`, state: 'drafting' }].slice(-40),
      dispatch: { mode: 'draft', round: 1, requestedAt: nowMs, attempts: 1, reason },
      startedAt: nowMs,
      updatedAt: nowMs,
    };
    transaction.set(flowRef, flow);
    transaction.set(orderRef, mirrorFields(flow), { merge: true });
    transaction.set(orderRef.collection('events').doc(), buildAssistedApplicationEvent('automation_transition', {
      actor: 'system',
      eventType: `start:${reason}`,
      fromState: existing?.state || null,
      toState: 'drafting',
      round: 1,
    }));
    created = flow;
  });
  if (!created) return { ok: true, skipped: 'already_started_or_ineligible' };
  // The alias must exist before the draft: the runner writes it into the
  // letter, the e-mail signature and the portal answers. Best-effort — an
  // inactive alias makes the runner fall back to the candidate's address.
  if (ensureAlias) {
    try {
      await ensureAlias({ db, orderId, nowMs });
    } catch (error) {
      console.error('[assistedApplicationAutomation] alias not created', orderId, error instanceof Error ? error.message : String(error));
    }
  }
  if (runEffect) {
    try {
      await runEffect({ db, orderId, effect: { type: 'dispatch', mode: 'draft', reason }, flow: created, nowMs });
    } catch (error) {
      console.error('[assistedApplicationAutomation] first dispatch failed', orderId, error instanceof Error ? error.message : String(error));
      // The watchdog re-dispatches within RUN_WATCHDOG_MS.
    }
  }
  return { ok: true, started: true };
}

// ── Sweep (clocks, reminders, watchdog) ────────────────────────────────────

/**
 * Every few minutes: fire due clocks and reminders, and re-dispatch (once) a
 * run that never reported back; a second silence hands the order to Valerie.
 */
export async function runAutomationSweep({ db, runEffect, nowMs = Date.now() } = {}) {
  const snapshot = await db.collection(ASSISTED_APPLICATIONS_COLLECTION)
    .where('automationDueAt', '<=', nowMs)
    .limit(SWEEP_BATCH)
    .get();
  const summary = { ticks: 0, redispatched: 0, timedOut: 0, ignored: 0, failed: 0, refunds: 0 };
  // Automatic refunds that failed (closed ad): retried until they go through
  // or the effect gives up and alerts the owner.
  const refunds = await db.collection(ASSISTED_APPLICATIONS_COLLECTION)
    .where('automationRefundDueAt', '<=', nowMs)
    .limit(SWEEP_BATCH)
    .get();
  for (const doc of refunds.docs || []) {
    try {
      const pending = doc.data()?.automationRefund || {};
      const flowSnapshot = await flowRefFor(db, doc.id).get();
      await runEffect({ db, orderId: doc.id, effect: { type: 'refund', reason: pending.reason || 'posting_closed', notify: pending.notify || null }, flow: flowSnapshot.data() || {}, nowMs });
      summary.refunds += 1;
    } catch (error) {
      summary.failed += 1;
      console.error('[assistedApplicationAutomation] refund retry failed for order', doc.id, error instanceof Error ? error.message : String(error));
    }
  }
  for (const doc of snapshot.docs || []) {
    try {
      const flowSnapshot = await flowRefFor(db, doc.id).get();
      const flow = flowSnapshot.exists ? flowSnapshot.data() || {} : null;
      if (!flow) {
        await orderRefFor(db, doc.id).set({ automationDueAt: null }, { merge: true });
        summary.ignored += 1;
        continue;
      }
      if (['drafting', 'regenerating', 'submitting'].includes(flow.state)) {
        const attempts = Number(flow.dispatch?.attempts) || 1;
        const mode = flow.dispatch?.mode || (flow.state === 'submitting' ? 'submit' : 'draft');
        if (attempts < MAX_DISPATCH_ATTEMPTS) {
          const dispatch = { ...flow.dispatch, mode, round: flow.round || 1, requestedAt: nowMs, attempts: attempts + 1 };
          await flowRefFor(db, doc.id).set({ dispatch, updatedAt: nowMs }, { merge: true });
          await orderRefFor(db, doc.id).set(mirrorFields({ ...flow, dispatch }), { merge: true });
          await runEffect({ db, orderId: doc.id, effect: { type: 'dispatch', mode, reason: 'watchdog' }, flow: { ...flow, dispatch }, nowMs });
          summary.redispatched += 1;
        } else {
          const failure = mode === 'submit' ? 'submit_failed' : 'draft_failed';
          await applyAutomationEvent({ db, orderId: doc.id, event: { type: failure, error: 'runner_timeout' }, actor: 'clock', runEffect, nowMs });
          summary.timedOut += 1;
        }
        continue;
      }
      const result = await applyAutomationEvent({ db, orderId: doc.id, event: { type: 'tick' }, actor: 'clock', runEffect, nowMs });
      if (result.ok) summary.ticks += 1;
      else {
        summary.ignored += 1;
        // Nothing due any more (e.g. a clock cleared by a held flag): stop
        // selecting this order until its flow changes again.
        await orderRefFor(db, doc.id).set({ automationDueAt: computeDueAt(flow) > nowMs ? computeDueAt(flow) : null }, { merge: true });
      }
    } catch (error) {
      summary.failed += 1;
      console.error('[assistedApplicationAutomation] sweep failed for order', doc.id, error instanceof Error ? error.message : String(error));
    }
  }
  return summary;
}

// ── Runner events (automation_events/{id}) ─────────────────────────────────

/**
 * Firestore onDocumentCreated for `automation_events/{eventId}`: the Actions
 * runner reports what happened. The document is marked as applied in the
 * same transaction as the flow's transition (applyAutomationEvent's
 * claimRef): a redelivered trigger cannot apply it twice, and a failure in
 * between leaves it unapplied, so the redelivery applies it.
 */
export async function handleRunnerEvent({ db, orderId, eventRef, data, runEffect, nowMs = Date.now() }) {
  const type = String(data?.type || '');
  if (!RUNNER_EVENT_TYPES.has(type)) {
    await eventRef.set({ appliedAt: nowMs, result: 'unknown_type' }, { merge: true });
    return { ok: false, ignored: 'unknown_type' };
  }
  const event = {
    type,
    round: Number(data.round) || null,
    error: data.error ? String(data.error).slice(0, 120) : undefined,
    reason: data.reason ? String(data.reason).slice(0, 120) : undefined,
    questions: Array.isArray(data.questions) ? data.questions.slice(0, 20) : undefined,
  };
  const result = await applyAutomationEvent({
    db,
    orderId,
    event,
    actor: 'runner',
    runEffect,
    nowMs,
    patchFlow: type === 'submit_succeeded' && data.channel ? () => ({ submittedVia: String(data.channel).slice(0, 40) }) : null,
    claimRef: eventRef,
  });
  return result;
}

export function newRequestId() {
  return randomUUID();
}
