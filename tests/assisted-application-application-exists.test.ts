import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  getRemoteConfigValue: vi.fn(async () => ''),
  bridgeEmailCascadeCredentialsToEnv: vi.fn(async () => {}),
}));

const { handleRunnerEvent, relaunchAuthorizedOwnerTakeover } = await import('../functions/src/assistedApplicationAutomation.js');
const { runAutomationEffect } = await import('../functions/src/assistedApplicationAutomationEffects.js');
const { submissionGuard } = await import('../functions/src/assistedApplicationSubmissionGuard.js');
const { transition } = await import('../functions/src/assistedApplicationFlow.js');
const { verifySubmissionReceipt } = await import('../functions/src/lib/submissionReceiptContract.js');
const { applicationExistsRoute, vacancyBoundToOrder, applicationExistsEvidenceOf } = await import('../functions/src/lib/applicationExistsReconciliation.js');

const ORDER = 'order_exists_test';
const ROOT = `assisted_applications/${ORDER}`;
const T0 = Date.UTC(2026, 10, 26, 12);
const HOST = 'recruitingapp-0000.umantis.com';
const ALIAS = 'maria.rossi.abcd@candidature.frontaliereticino.ch';
const APPLY_URL = `https://${HOST}/Vacancies/1234/Application/New/1`;
const EXISTS_PATH = '/Vacancies/1234/FurtherApplication/ApplicationExists/9';
const hostKey = HOST.replace(/[^a-z0-9-]/g, '_');
let store: ReturnType<typeof createMemoryFirestore>;

const evidence = (over: Record<string, unknown> = {}) => ({
  routeKind: 'umantis_application_exists', host: HOST, vacancyId: '1234', pagePath: EXISTS_PATH, vacancyBound: true, ...over,
});

async function seed({ clicked = true, accountEmail = ALIAS, ambiguousEvent = false, vacancy = '1234' } = {}) {
  store = createMemoryFirestore({
    [ROOT]: { paymentStatus: 'paid', submissionStatus: 'in_progress', candidateAlias: { address: ALIAS, active: true } },
    [`${ROOT}/automation/flow`]: { state: 'submitting', round: 1, heldBy: [], dispatch: { mode: 'submit', round: 1, attempts: 1, requestedAt: T0 }, answers: {} },
    [`${ROOT}/ai_drafts/current`]: { round: 1, status: 'ready', questions: [], channel: { applyUrl: APPLY_URL.replace('1234', vacancy) } },
    [`${ROOT}/automation/accounts`]: { [hostKey]: { email: accountEmail, status: 'verified' } },
  });
  const guard = submissionGuard(store.db, ORDER, 1);
  await guard.claim('portal', T0);
  if (clicked) await guard.markClicked(T0, { formBinding: 'a'.repeat(64) });
  // What the next run's claim and release leave behind: the click survives as priorClickedAt.
  if (clicked) {
    await guard.release('portal_review_pending', T0 + 1);
    await submissionGuard(store.db, ORDER, 1).claim('portal', T0 + 2);
  }
  if (ambiguousEvent) {
    await store.db.collection('assisted_applications').doc(ORDER).collection('automation_events').add({ type: 'submit_failed', error: 'portal_ambiguous', round: 1 });
  }
}

async function handoff(applicationExists: unknown) {
  const eventRef = await store.db.collection('assisted_applications').doc(ORDER).collection('automation_events').add({
    type: 'submit_handoff', reason: 'account_application_already_applied', round: 1, applicationExists,
  });
  // Only the order's own projection runs for real: the owner e-mail of a held handoff is not under test.
  const runEffect = async (context: any) => (context.effect.type === 'mark_submitted' ? runAutomationEffect(context) : { ok: true });
  return handleRunnerEvent({ db: store.db, orderId: ORDER, eventRef, data: store.read(eventRef.path), runEffect, nowMs: T0 + 10 });
}

describe('portal «application exists» page', () => {
  it('recognises only the exact route and binds its vacancy to the order posting', () => {
    expect(applicationExistsRoute(`https://${HOST}${EXISTS_PATH}`)).toMatchObject({ routeKind: 'umantis_application_exists', vacancyId: '1234' });
    expect(applicationExistsRoute(`http://${HOST}${EXISTS_PATH}`)).toBeNull();
    expect(applicationExistsRoute(`https://example.test${EXISTS_PATH}`)).toBeNull();
    expect(applicationExistsRoute(`https://${HOST}/Vacancies/1234/Application/New/1`)).toBeNull();
    const route = applicationExistsRoute(`https://${HOST}${EXISTS_PATH}`);
    expect(vacancyBoundToOrder(route, [APPLY_URL])).toBe(true);
    expect(vacancyBoundToOrder(route, [APPLY_URL.replace('1234', '999')])).toBe(false);
    expect(vacancyBoundToOrder(route, [APPLY_URL, APPLY_URL.replace('1234', '999')])).toBe(false);
    expect(vacancyBoundToOrder(route, [])).toBe(false);
    expect(applicationExistsEvidenceOf({ ...evidence(), vacancyId: '77' })).toBeNull();
  });

  it('settles the order as sent when the page, the alias account and an earlier send of the round all agree', async () => {
    await seed();
    const result = await handoff(evidence());
    expect(result).toMatchObject({ ok: true, flow: { state: 'submitted', submittedVia: 'portal' } });
    expect(store.read(ROOT)?.submissionStatus).toBe('submitted');
    const record = store.read(`${ROOT}/automation/submission`)?.r1;
    expect(record).toMatchObject({ state: 'sent', confirmedBy: 'portal_application_exists', receipt: { proofKind: 'portal_application_exists' } });
    expect(verifySubmissionReceipt(record.receipt, { orderId: ORDER, round: 1 })).toBe(true);
  });

  it('also settles it from a recorded ambiguous runner event when no click survives on the record', async () => {
    await seed({ clicked: false, ambiguousEvent: true });
    expect(await handoff(evidence())).toMatchObject({ ok: true, flow: { state: 'submitted' } });
  });

  it('stays held and unknown when no send of ours is on record for the round', async () => {
    await seed({ clicked: false });
    const result = await handoff(evidence());
    expect(result).toMatchObject({ ok: true, flow: { state: 'owner_takeover', heldBy: ['portal:account_application_already_applied'], portalAutoRetryAt: null } });
    expect(store.read(ROOT)?.submissionStatus).toBe('in_progress');
  });

  it('stays unknown when the account is not the order alias account', async () => {
    await seed({ accountEmail: 'someone.else@example.test' });
    expect(await handoff(evidence())).toMatchObject({ flow: { state: 'owner_takeover', heldBy: ['portal:account_application_already_applied'] } });
  });

  it('stays unknown when the page vacancy is not the order posting', async () => {
    await seed({ vacancy: '999' });
    expect(await handoff(evidence())).toMatchObject({ flow: { state: 'owner_takeover' } });
    await seed();
    expect(await handoff(evidence({ vacancyBound: false }))).toMatchObject({ flow: { state: 'owner_takeover' } });
  });
});

describe('vacancy id domain', () => {
  it('settles an order whose vacancy id has more than 20 digits, and refuses one beyond the shared limit', async () => {
    const long = '123456789012345678901';
    expect(applicationExistsRoute(`https://${HOST}/Vacancies/${long}/FurtherApplication/ApplicationExists/9`)?.vacancyId).toBe(long);
    expect(applicationExistsRoute(`https://${HOST}/Vacancies/${'1'.repeat(65)}/FurtherApplication/ApplicationExists/9`)).toBeNull();
    await seed({ vacancy: long });
    store.docs.set(`${ROOT}/ai_drafts/current`, { round: 1, status: 'ready', questions: [], channel: { applyUrl: `https://${HOST}/Vacancies/${long}/Application/New/1` } });
    const result = await handoff(evidence({ vacancyId: long, pagePath: `/Vacancies/${long}/FurtherApplication/ApplicationExists/9` }));
    expect(result).toMatchObject({ ok: true, flow: { state: 'submitted' } });
    const record = store.read(`${ROOT}/automation/submission`)?.r1;
    expect(verifySubmissionReceipt(record.receipt, { orderId: ORDER, round: 1 })).toBe(true);
  });
});

describe('owner confirmation «not sent»', () => {
  it('unblocks an owner_takeover with an ambiguous marker on the current round only with confirmedNotSent', () => {
    const draft = { round: 1, status: 'ready', questions: [] };
    const flow = { state: 'owner_takeover', round: 1, heldBy: ['portal:account_sign_in_failed'], ambiguousSubmit: { round: 1, at: T0, error: 'portal_ambiguous' }, dispatch: { mode: 'submit', round: 1, attempts: 1 } };
    expect(transition(flow, { type: 'owner_retry_submit' }, { draft, nowMs: T0 }).ignored).toBe('send_outcome_unconfirmed');
    expect(transition(flow, { type: 'owner_retry_submit', confirmedNotSent: true }, { draft, nowMs: T0 }).flow.state).toBe('submitting');
  });

  it('the admin action forwards raw.confirmedNotSent and nothing else turns it on', async () => {
    store = createMemoryFirestore({
      [ROOT]: { paymentStatus: 'paid', submissionStatus: 'in_progress' },
      [`${ROOT}/automation/flow`]: { state: 'owner_takeover', round: 1, heldBy: ['portal:account_sign_in_failed'], ambiguousSubmit: { round: 1, at: T0, error: 'portal_ambiguous' }, dispatch: { mode: 'submit', round: 1, attempts: 1 }, answers: {} },
      [`${ROOT}/ai_drafts/current`]: { round: 1, status: 'ready', questions: [] },
    });
    const { applyAutomationEvent } = await import('../functions/src/assistedApplicationAutomation.js');
    const runEffect = async () => ({ ok: true });
    const refused = await applyAutomationEvent({ db: store.db, orderId: ORDER, event: { type: 'owner_retry_submit' }, actor: 'owner:test', runEffect, nowMs: T0 });
    expect(refused).toMatchObject({ ok: false, ignored: 'send_outcome_unconfirmed' });
    const allowed = await applyAutomationEvent({ db: store.db, orderId: ORDER, event: { type: 'owner_retry_submit', confirmedNotSent: true }, actor: 'owner:test', runEffect, nowMs: T0 });
    expect(allowed).toMatchObject({ ok: true, flow: { state: 'submitting' } });
  });
});

describe('retry of a send of unknown outcome', () => {
  const draft = { round: 1, status: 'ready', questions: [] };
  const held = (heldBy: string[], extra: Record<string, unknown> = {}) => ({
    state: 'owner_takeover', round: 1, heldBy, dispatch: { mode: 'submit', round: 1, attempts: 1 }, ...extra,
  });
  const retry = (flow: Record<string, unknown>, event: Record<string, unknown> = {}, context: Record<string, unknown> = {}) =>
    transition(flow, { type: 'owner_retry_submit', ...event }, { draft, nowMs: T0, ...context });

  it('refuses an owner retry on an ambiguous or history-uncertain hold unless the owner confirms it did not leave', () => {
    for (const hold of ['portal_ambiguous', 'portal:account_application_history_uncertain', 'portal:account_application_already_applied']) {
      expect(retry(held([hold])).ignored).toBe('send_outcome_unconfirmed');
      expect(retry(held([hold]), { confirmedNotSent: true }).flow.state).toBe('submitting');
    }
    expect(retry(held(['portal:account'])).flow.state).toBe('submitting');
  });

  it('keeps the doubt after a later stop replaced the hold, and after a click survives on the record', () => {
    const submitting = { state: 'submitting', round: 1, dispatch: { mode: 'submit', round: 1, attempts: 1 } };
    const failed = transition(submitting, { type: 'submit_failed', error: 'portal_ambiguous' }, { draft, nowMs: T0 });
    expect(failed.flow.ambiguousSubmit).toMatchObject({ round: 1, error: 'portal_ambiguous' });
    const laterStop = { ...failed.flow, dispatch: submitting.dispatch, heldBy: ['portal:account_sign_in_failed'] };
    expect(retry(laterStop).ignored).toBe('send_outcome_unconfirmed');
    const cleared = retry(laterStop, { confirmedNotSent: true });
    expect(cleared.flow).toMatchObject({ state: 'submitting', ambiguousSubmit: null });
    expect(retry(held(['portal:account']), {}, { sendMayHaveLeft: true }).ignored).toBe('send_outcome_unconfirmed');
  });

  it('never lets the clock retry an unconfirmed send, except the evidence-proven final-review recovery', () => {
    const due = { portalAutoRetryAt: T0 - 1, portalAutoRetryCount: 0 };
    const auto = (flow: Record<string, unknown>, context: Record<string, unknown> = {}) =>
      transition(flow, { type: 'portal_auto_retry' }, { draft, nowMs: T0, ...context });
    expect(auto(held(['portal:portal_needs_candidate'], due), { sendMayHaveLeft: true }).ignored).toBe('send_outcome_unconfirmed');
    expect(auto(held(['portal:portal_needs_candidate'], { ...due, ambiguousSubmit: { round: 1, at: T0 } })).ignored).toBe('send_outcome_unconfirmed');
    expect(auto(held(['portal:portal_needs_candidate'], due)).flow.state).toBe('submitting');
  });

  it('passes the owner confirmation through the authorised relaunch only when given', async () => {
    store = createMemoryFirestore({
      [ROOT]: { paymentStatus: 'paid', submissionStatus: 'in_progress' },
      [`${ROOT}/automation/flow`]: { ...held(['portal:account_application_history_uncertain']), answers: {} },
      [`${ROOT}/ai_drafts/current`]: { ...draft },
    });
    const runEffect = vi.fn(async () => ({ ok: true }));
    const blocked = await relaunchAuthorizedOwnerTakeover({ db: store.db, orderId: ORDER, authorizedOrderId: ORDER, runEffect, nowMs: T0 });
    expect(blocked).toMatchObject({ ok: false, ignored: 'send_outcome_unconfirmed' });
    const allowed = await relaunchAuthorizedOwnerTakeover({ db: store.db, orderId: ORDER, authorizedOrderId: ORDER, runEffect, confirmedNotSent: true, nowMs: T0 });
    expect(allowed.ok).toBe(true);
  });
});
