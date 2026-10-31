import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { executionController, executionLease, executionMaterialVersion, prepareRemoteExecution, remoteExecutionReason,
  recoveryReasonForDispatch, remoteExecutorReady, EXECUTION_LEASE_MS } from '../functions/src/assistedApplicationExecution.js';
import { captchaInfrastructureProof, infrastructureReasonForEvent, navigationInfrastructureProof,
  verifiedInfrastructureProof } from '../functions/src/lib/portalInfrastructureEvidence.js';
import { submissionGuard } from '../functions/src/assistedApplicationSubmissionGuard.js';
import { enterExecution } from '../scripts/assisted-application/lib/execution-runtime.mjs';

const ORDER = 'order_remote_fixture';
const ROOT = `assisted_applications/${ORDER}`;
const SHA = 'a'.repeat(40);
const ENGINE = 'b'.repeat(64);
// Metadata copied from the historical ALTEN / FELFEL evidence, without order,
// profile, portal URL, answers, candidate text or screenshot.
const measuredResponses = [{ host: 'api.nopecha.com', path: '/v1/status', status: 403, errors: [{ message: 'Banned IP' }] },
  { host: 'api.nopecha.com', path: '/v1/recognition/turnstile', status: 520 }];
const CAPTCHA_PROOF = captchaInfrastructureProof('captcha', { diagnostics: { responses: measuredResponses }, attempt: 1 });
function fixture() {
  const cv = `assisted-application-uploads/${ORDER}/cv.pdf`;
  const order = { paymentStatus: 'paid', submissionStatus: 'ready_for_manual_submission', cvStorageKey: cv, cvUploadedAt: 10,
    cvFileCheck: { key: cv, verdict: 'ok', detectedType: 'pdf' }, consentVersion: 'assisted-application-v2', consentedAt: 10 };
  const flow = { state: 'submitting', round: 1, dispatch: { mode: 'submit', round: 1, requestedAt: 100,
    recoveryReason: 'portal:captcha_provider_unavailable' }, infrastructureProof: CAPTCHA_PROOF };
  const draft = { status: 'ready', round: 1, verdict: 'good', job: { source: 'job_detail', title: 'Engineer' },
    channel: { type: 'lever' }, factCheck: { ok: true, unsupported: [] }, questions: [], coverLetter: 'Approved letter' };
  const submission = { r1: { state: 'failed', channel: 'portal', clickedAt: null, releasedAt: 90 } };
  return { order, flow, draft, submission };
}
async function prepared() {
  const data = fixture();
  const store = createMemoryFirestore({ [ROOT]: data.order, [`${ROOT}/automation/flow`]: data.flow,
    [`${ROOT}/ai_drafts/current`]: data.draft, [`${ROOT}/automation/submission`]: data.submission });
  await prepareRemoteExecution({ db: store.db, orderId: ORDER, flow: data.flow, mode: 'submit', round: 1, sourceSha: SHA, nowMs: 100, id: 'execution-fixture' });
  await executionController({ db: store.db, orderId: ORDER, executionId: 'execution-fixture', sourceSha: SHA, runId: 'run-fixture', now: () => 100 }).ready();
  return store;
}
function lease(store: Awaited<ReturnType<typeof prepared>>, extra = {}) {
  return executionLease({ db: store.db, orderId: ORDER, executionId: 'execution-fixture', sourceSha: SHA,
    engineVersion: ENGINE, owner: 'run-fixture', token: 'lease-fixture', now: () => 110, ...extra });
}

describe('portal infrastructure host recovery', () => {
  it.each(['portal:captcha_provider_unavailable', 'portal:navigation_unavailable'])('routes the failure class %s, independently of employer', reason => {
    const proof = reason.includes('captcha') ? CAPTCHA_PROOF : navigationInfrastructureProof(Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }));
    expect(remoteExecutionReason({ infrastructureProof: proof, dispatch: { recoveryReason: reason } }, 'submit')).toBe(reason);
  });
  it.each(['portal:captcha', 'portal:portal_needs_candidate', 'portal:account', 'hard_fact', 'portal_ambiguous', 'transport:email_provider_unavailable'])('does not route %s', reason => {
    expect(remoteExecutionReason({ dispatch: { recoveryReason: reason } }, 'submit')).toBeNull();
  });
  it('never routes draft or verifier work to the submission executor', () => {
    for (const mode of ['draft', 'verify_portal', 'dry_run']) expect(remoteExecutionReason(fixture().flow, mode)).toBeNull();
  });
  it.each(['captcha', 'portal_needs_candidate', 'portal_antibot'])('normalises the observed legacy %s only with real provider diagnostics', raw => {
    const proof = captchaInfrastructureProof(raw, { diagnostics: { responses: measuredResponses }, attempt: 1 });
    expect(infrastructureReasonForEvent(raw, proof)).toBe('captcha_provider_unavailable');
    const flow = { ...fixture().flow, heldBy: [`portal:${raw}`], infrastructureProof: proof };
    const reason = recoveryReasonForDispatch(flow, 'portal_auto_retry');
    expect(remoteExecutionReason({ ...flow, dispatch: { ...flow.dispatch, recoveryReason: reason } }, 'submit')).toBe('portal:captcha_provider_unavailable');
    expect(recoveryReasonForDispatch({ ...flow, infrastructureProof: null }, 'portal_auto_retry')).toBeNull();
  });
  it.each(['posting_mismatch', 'portal_ambiguous', 'hard_fact', 'consent_missing'])('never reinterprets %s despite the same unrelated provider responses', raw => {
    expect(captchaInfrastructureProof(raw, { diagnostics: { responses: measuredResponses }, attempt: 1 })).toBeNull();
    expect(infrastructureReasonForEvent(raw, CAPTCHA_PROOF)).toBeNull();
  });
  it('rejects generic model/operator text and post-click proofs', () => {
    expect(captchaInfrastructureProof('captcha', { diagnostics: { responses: [] }, attempt: 1 })).toBeNull();
    expect(captchaInfrastructureProof('captcha', { diagnostics: { responses: measuredResponses }, attempt: 1, finalClickAttempted: true })).toBeNull();
    expect(verifiedInfrastructureProof({ ...CAPTCHA_PROOF, source: 'model' })).toBeNull();
    expect(verifiedInfrastructureProof({ ...CAPTCHA_PROOF, phase: 'post_submit' })).toBeNull();
    expect(verifiedInfrastructureProof({ ...CAPTCHA_PROOF, observation: { ...measuredResponses[0], errors: {} } })).toBeNull();
    expect(captchaInfrastructureProof('captcha', { diagnostics: { responses: [{ host: 'api.nopecha.com',
      path: '/v1/recognition/turnstile/?token=private', status: 520, attempt: 1 }] }, attempt: 1 })).toBeNull();
  });
  it('requires a fresh, attested single-slot executor instead of an offline host', () => {
    const registry = { ready: true, protocol: 1, slots: 1, sourceSha: SHA, heartbeatAt: 100 };
    expect(remoteExecutorReady(registry, 110)).toBe(true);
    expect(remoteExecutorReady({ ...registry, heartbeatAt: 1 }, 200_000)).toBe(false);
    expect(remoteExecutorReady({ ...registry, ready: false }, 110)).toBe(false);
  });
  it('hashes approved answers independently of key insertion order, but detects changed materials', () => {
    const data = fixture();
    const original = executionMaterialVersion(data);
    expect(executionMaterialVersion({ ...data, order: { ...data.order, paymentStatus: 'paid' } })).toBe(original);
    expect(executionMaterialVersion({ ...data, draft: { ...data.draft, coverLetter: 'Changed' } })).not.toBe(original);
    expect(executionMaterialVersion({ ...data, flow: { ...data.flow, answers: { salary: 'different' } } })).not.toBe(original);
  });
  it('admits only one live lease and blocks a different run before any browser work', async () => {
    const store = await prepared();
    await lease(store).claim();
    await expect(lease(store, { owner: 'second-run', token: 'second-token' }).claim()).rejects.toThrow('execution_already_leased');
    await lease(store).assert();
  });
  it.each(['retentionPurgingAt', 'retentionPurgedAt', 'retentionPayloadPurgedAt'])('denies %s even with an active talent pool', async tombstone => {
    const store = await prepared(); Object.assign(store.read(ROOT)!, { talentPoolConsent: true, [tombstone]: 110 });
    await expect(lease(store).claim()).rejects.toThrow();
    expect(store.read(`${ROOT}/automation/flow`)!.remoteExecutionAttempts).toBeUndefined();
  });
  it('fences the old worker after lease expiry and reassignment', async () => {
    const store = await prepared(); let nowMs = 110;
    const first = lease(store, { now: () => nowMs });
    await first.claim(); nowMs += EXECUTION_LEASE_MS + 1;
    store.read(`${ROOT}/automation/execution`)!.controller.expiresAt = nowMs + EXECUTION_LEASE_MS;
    const second = lease(store, { owner: 'second', token: 'second', now: () => nowMs });
    await second.claim();
    await expect(first.assert()).rejects.toThrow('execution_lease_lost');
    await second.assert();
  });
  it.each(['source', 'engine', 'materials', 'withdrawal', 'submissionWithdrawal', 'receiptHistory', 'consent', 'payment', 'round', 'dispatch', 'dispatchMode', 'controller'])('rejects changed %s before a final click', async change => {
    const store = await prepared(); const guard = lease(store); await guard.claim();
    if (change === 'source') await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('execution').set({ sourceSha: 'c'.repeat(40) }, { merge: true });
    if (change === 'engine') await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('execution').set({ engineVersion: 'd'.repeat(64) }, { merge: true });
    if (change === 'materials') await store.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current').set({ coverLetter: 'Unapproved change' }, { merge: true });
    if (change === 'withdrawal') await store.db.collection('assisted_applications').doc(ORDER).set({ withdrawnAt: 111 }, { merge: true });
    if (change === 'submissionWithdrawal') store.read(`${ROOT}/automation/submission`)!.withdrawnAt = 111;
    if (change === 'receiptHistory') store.read(`${ROOT}/automation/flow`)!.history = [{ state: 'submitted', event: 'submit_succeeded' }];
    if (change === 'consent') store.read(ROOT)!.consentVersion = null;
    if (change === 'controller') store.read(`${ROOT}/automation/execution`)!.controller.expiresAt = 0;
    if (change === 'payment') await store.db.collection('assisted_applications').doc(ORDER).set({ paymentStatus: 'refunded' }, { merge: true });
    if (change === 'round') await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('flow').set({ round: 2 }, { merge: true });
    if (change === 'dispatch') await store.db.collection('assisted_applications').doc(ORDER).collection('automation').doc('flow').set({ dispatch: { requestedAt: 200 } }, { merge: true });
    if (change === 'dispatchMode') store.read(`${ROOT}/automation/flow`)!.dispatch.mode = 'draft';
    await expect(guard.assert()).rejects.toThrow(/^execution_/);
  });
  it.each(['sending', 'sent', 'clicked', 'unpaid', 'unapproved', 'sentAttempt', 'hardfact'])('does not queue a recovery with %s', async danger => {
    const data = fixture(); const store = await prepared();
    if (danger === 'sending' || danger === 'sent') store.read(`${ROOT}/automation/submission`)!.r1.state = danger;
    if (danger === 'clicked') store.read(`${ROOT}/automation/submission`)!.r1.clickedAt = 95;
    if (danger === 'unpaid') store.read(ROOT)!.paymentStatus = 'pending';
    if (danger === 'unapproved') store.read(`${ROOT}/automation/flow`)!.dispatch.mode = 'draft';
    if (danger === 'sentAttempt') store.read(`${ROOT}/ai_drafts/current`)!.sentAttempt = { at: 95 };
    if (danger === 'hardfact') store.read(`${ROOT}/ai_drafts/current`)!.factCheck = { ok: false, unsupported: ['invented fact'] };
    await expect(prepareRemoteExecution({ db: store.db, orderId: ORDER, flow: data.flow, mode: 'submit', round: 1, sourceSha: SHA, nowMs: 101 })).resolves.toBeNull();
  });
  it('caps remote attempts for the same round', async () => {
    const store = await prepared();
    await lease(store).claim();
    let nowMs = 110 + EXECUTION_LEASE_MS + 1;
    store.read(`${ROOT}/automation/execution`)!.controller.expiresAt = nowMs + EXECUTION_LEASE_MS;
    await lease(store, { owner: 'second', token: 'second', now: () => nowMs }).claim();
    nowMs += EXECUTION_LEASE_MS + 1;
    store.read(`${ROOT}/automation/execution`)!.controller.expiresAt = nowMs + EXECUTION_LEASE_MS;
    await expect(lease(store, { owner: 'third', token: 'third', now: () => nowMs }).claim()).rejects.toThrow('execution_attempt_limit');
  });
  it('does not consume an actual attempt while the Mac is offline', async () => {
    const store = await prepared();
    expect(store.read(`${ROOT}/automation/flow`)!.remoteExecutionAttempts).toBeUndefined();
    expect(store.read(`${ROOT}/automation/execution`)!.state).toBe('ready');
  });
  it('rejects an unknown execution protocol before a worker or controller can claim it', async () => {
    const store = await prepared(); store.read(`${ROOT}/automation/execution`)!.protocol = 2;
    await expect(lease(store).claim()).rejects.toThrow('execution_superseded');
    store.read(`${ROOT}/automation/execution`)!.state = 'queued'; store.read(`${ROOT}/automation/execution`)!.controller = null;
    await expect(executionController({ db: store.db, orderId: ORDER, executionId: 'execution-fixture', sourceSha: SHA,
      runId: 'run-fixture', now: () => 100 }).ready()).rejects.toThrow('controller_execution_mismatch');
  });
  it('returns an offline delivery to the normal clock without spending an admission', async () => {
    const store = await prepared();
    const controller = executionController({ db: store.db, orderId: ORDER, executionId: 'execution-fixture', sourceSha: SHA, runId: 'run-fixture', now: () => 115 });
    await expect(controller.defer()).resolves.toBe(true);
    expect(store.read(`${ROOT}/automation/flow`)!.remoteExecutionAttempts).toBeUndefined();
    expect(store.read(`${ROOT}/automation/execution`)).toMatchObject({ state: 'finished', outcome: 'deferred' });
  });
  it('never defers or releases an ambiguous final click', async () => {
    const store = await prepared(); const actor = lease(store); await actor.claim();
    const guard = submissionGuard(store.db, ORDER, 1, { execution: actor });
    await guard.claim('portal'); await guard.markClicked(112);
    await expect(guard.release('runtime_unavailable')).rejects.toThrow('execution_ambiguous_release_forbidden');
    const controller = executionController({ db: store.db, orderId: ORDER, executionId: 'execution-fixture', sourceSha: SHA, runId: 'run-fixture', now: () => 115 });
    await expect(controller.defer()).resolves.toBe(false);
    expect(store.read(`${ROOT}/automation/submission`)!.r1).toMatchObject({ state: 'sending', clickedAt: 112 });
  });
  it('returns an unknown worker outcome to the normal clock only with fenced pre-click proof', async () => {
    const store = await prepared(); const actor = lease(store); await actor.claim();
    await submissionGuard(store.db, ORDER, 1, { execution: actor }).claim('portal');
    await actor.complete();
    expect(store.read(`${ROOT}/automation/execution`)).toMatchObject({ state: 'finished', outcome: 'unknown' });
    const controller = executionController({ db: store.db, orderId: ORDER, executionId: 'execution-fixture', sourceSha: SHA,
      runId: 'run-fixture', now: () => 115 });
    await expect(controller.defer()).resolves.toBe(true);
    expect(store.read(`${ROOT}/automation/execution`)).toMatchObject({ outcome: 'deferred', fencedGeneration: 1 });
    expect(store.read(`${ROOT}/automation/submission`)!.r1).toMatchObject({ state: 'sending', clickedAt: null, executionGeneration: 1 });
  });
  it('fences every stale outcome after a new generation, including completion', async () => {
    const store = await prepared(); let nowMs = 110; const first = lease(store, { now: () => nowMs }); await first.claim();
    const firstGuard = submissionGuard(store.db, ORDER, 1, { execution: first }); await firstGuard.claim('portal');
    nowMs += EXECUTION_LEASE_MS + 1;
    store.read(`${ROOT}/automation/execution`)!.controller.expiresAt = nowMs + EXECUTION_LEASE_MS;
    const second = lease(store, { owner: 'second', token: 'second', now: () => nowMs }); await second.claim();
    const event = store.db.collection('assisted_applications').doc(ORDER).collection('automation_events').doc('stale');
    await expect(first.report(event, { type: 'submit_handoff' })).rejects.toThrow('execution_lease_lost');
    await expect(firstGuard.release('portal_navigation')).rejects.toThrow('execution_lease_lost');
    await expect(firstGuard.markSent({})).rejects.toThrow('execution_lease_lost');
    await first.complete();
    expect(store.read(`${ROOT}/automation/execution`)).toMatchObject({ state: 'running', lease: { token: 'second' } });
  });
  it('honours the legacy CV-upload stamp without mistaking it for an employer receipt', async () => {
    const store = await prepared();
    store.read(ROOT)!.submittedAt = 95;
    expect(store.read(ROOT)!.submissionStatus).toBe('ready_for_manual_submission');
    await expect(lease(store).claim()).resolves.toMatchObject({ executionId: 'execution-fixture' });
  });
  it('denies expired CV retention even when the purge job has not run', async () => {
    const store = await prepared(); store.read(ROOT)!.cvUploadedAt = 1;
    const expired = 91 * 86400_000;
    await expect(prepareRemoteExecution({ db: store.db, orderId: ORDER, flow: fixture().flow, mode: 'submit', round: 1,
      sourceSha: SHA, nowMs: expired })).resolves.toBeNull();
    store.read(`${ROOT}/automation/execution`)!.controller.expiresAt = expired + EXECUTION_LEASE_MS;
    await expect(lease(store, { now: () => expired }).claim()).rejects.toThrow('execution_not_submittable');
  });
  it.each([undefined, 'not-a-timestamp'])('denies a missing or malformed retention anchor: %s', async anchor => {
    const store = await prepared(); store.read(ROOT)!.cvUploadedAt = anchor;
    await expect(lease(store).claim()).rejects.toThrow('execution_not_submittable');
    expect(store.read(`${ROOT}/automation/flow`)!.remoteExecutionAttempts).toBeUndefined();
  });
  it('rechecks retention expiring after admission and before the click', async () => {
    const store = await prepared(); let nowMs = 110; store.read(ROOT)!.cvUploadedAt = 1;
    const actor = lease(store, { now: () => nowMs }); await actor.claim();
    const guard = submissionGuard(store.db, ORDER, 1, { execution: actor }); await guard.claim('portal');
    nowMs = 91 * 86400_000;
    store.read(`${ROOT}/automation/execution`)!.controller.expiresAt = nowMs + EXECUTION_LEASE_MS;
    store.read(`${ROOT}/automation/execution`)!.lease.expiresAt = nowMs + EXECUTION_LEASE_MS;
    await expect(guard.markClicked(nowMs)).rejects.toThrow('execution_not_submittable');
    expect(store.read(`${ROOT}/automation/submission`)!.r1.clickedAt).toBeNull();
  });
  it('preserves the canonical positive talent-pool retention exception', async () => {
    const store = await prepared(); const nowMs = 91 * 86400_000;
    store.read(ROOT)!.cvUploadedAt = 1; store.read(ROOT)!.talentPoolConsent = true;
    store.read(`${ROOT}/automation/execution`)!.controller.expiresAt = nowMs + EXECUTION_LEASE_MS;
    await expect(lease(store, { now: () => nowMs }).claim()).resolves.toMatchObject({ executionId: 'execution-fixture' });
  });
  it('preserves a real outcome after the runner stores its own sent record', async () => {
    const store = await prepared(); const guard = lease(store); await guard.claim();
    const submission = submissionGuard(store.db, ORDER, 1, { execution: guard });
    await submission.claim('portal'); await submission.markClicked(111); await submission.markSent({ channel: 'portal' }, 112);
    await store.db.collection('assisted_applications').doc(ORDER).collection('ai_drafts').doc('current').set({ sent: { at: 112 }, portalAnswers: { answers: [] } }, { merge: true });
    const event = store.db.collection('assisted_applications').doc(ORDER).collection('automation_events').doc('receipt');
    await guard.report(event, { type: 'submit_succeeded' });
    expect(store.read(`${ROOT}/automation_events/receipt`)?.executionId).toBe('execution-fixture');
    await guard.complete(); await expect(store.db.runTransaction(guard.assertOutcomeInTransaction)).rejects.toThrow('execution_lease_lost');
    expect(store.read(`${ROOT}/automation/execution`)!.outcome).toBe('sent');
  });
  it.each(['payment', 'consent', 'withdrawal', 'state', 'newRound'])('preserves a clicked receipt after %s changes without authorising another click', async change => {
    const store = await prepared(); const actor = lease(store); await actor.claim();
    const guard = submissionGuard(store.db, ORDER, 1, { execution: actor });
    await guard.claim('portal'); await guard.markClicked(111);
    if (change === 'payment') store.read(ROOT)!.paymentStatus = 'refunded';
    if (change === 'consent') store.read(ROOT)!.consentVersion = null;
    if (change === 'withdrawal') store.read(ROOT)!.withdrawnAt = 112;
    if (change === 'state') store.read(`${ROOT}/automation/flow`)!.state = 'withdrawn';
    if (change === 'newRound') Object.assign(store.read(`${ROOT}/automation/flow`)!, { round: 2, executionId: 'new-round', dispatch: { requestedAt: 200 } });
    await expect(guard.markClicked(113)).rejects.toThrow();
    await guard.markSent({ channel: 'portal' }, 114);
    const event = store.db.collection('assisted_applications').doc(ORDER).collection('automation_events').doc('late-receipt');
    await actor.report(event, { type: 'submit_succeeded' });
    expect(store.read(`${ROOT}/automation/submission`)!.r1).toMatchObject({ state: 'sent', clickedAt: 111, sentAt: 114 });
    expect(store.read(`${ROOT}/automation_events/late-receipt`)!.type).toBe('submit_succeeded');
    if (change === 'newRound') expect(store.read(`${ROOT}/automation/flow`)!.round).toBe(2);
    await expect(guard.release('portal_navigation')).rejects.toThrow();
  });
  it.each(['generation', 'token', 'source', 'engine', 'materials'])('rejects a late receipt with changed execution %s', async change => {
    const store = await prepared(); const actor = lease(store); await actor.claim();
    const guard = submissionGuard(store.db, ORDER, 1, { execution: actor });
    await guard.claim('portal'); await guard.markClicked(111);
    const current = store.read(`${ROOT}/automation/execution`)!;
    if (change === 'generation') current.generation++;
    if (change === 'token') current.lease.token = 'another-attempt';
    if (change === 'source') current.sourceSha = 'c'.repeat(40);
    if (change === 'engine') current.engineVersion = 'c'.repeat(64);
    if (change === 'materials') current.materialVersion = 'c'.repeat(64);
    await expect(guard.markSent({ channel: 'portal' }, 114)).rejects.toThrow();
    expect(store.read(`${ROOT}/automation/submission`)!.r1.state).toBe('sending');
  });
  it.each(['beforeReceipt', 'beforeReport'])('keeps only a minimum receipt if purge happens %s', async phase => {
    const store = await prepared(); const actor = lease(store); await actor.claim();
    const guard = submissionGuard(store.db, ORDER, 1, { execution: actor });
    await guard.claim('portal'); await guard.markClicked(111);
    const record = { channel: 'portal', finalUrl: 'https://employer.example/private-receipt', sent: { files: ['private-file-name'] } };
    if (phase === 'beforeReport') await guard.markSent(record, 112);
    Object.assign(store.read(ROOT)!, { retentionPurgingAt: 113, retentionPurgedAt: 114 });
    for (const path of ['automation/flow', 'automation/submission', 'ai_drafts/current']) store.docs.delete(`${ROOT}/${path}`);
    if (phase === 'beforeReceipt') await expect(guard.markSent(record, 115)).resolves.toEqual({ minimal: true });
    const event = store.db.collection('assisted_applications').doc(ORDER).collection('automation_events').doc('purged-receipt');
    await actor.report(event, { type: 'submit_succeeded', privateValue: 'must-not-return' });
    await actor.complete({ artifacts: { stop: { privateValue: 'must-not-return' } } });
    const execution = store.read(`${ROOT}/automation/execution`)!;
    expect(execution).toMatchObject({ outcome: 'sent', artifacts: null, minimalReceipt: { status: 'sent', round: 1 } });
    expect(execution.minimalReceipt.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(execution)).not.toMatch(/private-file-name|private-receipt|must-not-return/);
    expect(store.read(`${ROOT}/automation_events/purged-receipt`)).toBeUndefined();
    expect(store.read(`${ROOT}/automation/submission`)).toBeUndefined();
    expect(store.read(`${ROOT}/ai_drafts/current`)).toBeUndefined();
    await expect(actor.claim()).rejects.toThrow();
  });
  it('uses fresh retention time after receipt reads while preserving the observed timestamp', async () => {
    vi.useFakeTimers(); vi.setSystemTime(110);
    try {
      const store = await prepared(); const actor = lease(store); await actor.claim();
      const guard = submissionGuard(store.db, ORDER, 1, { execution: actor }); await guard.claim('portal'); await guard.markClicked(111);
      const run = store.db.runTransaction.bind(store.db);
      store.db.runTransaction = callback => run(transaction => callback({ ...transaction, async get(ref) {
        const value = await transaction.get(ref);
        if (ref.path === `${ROOT}/automation/submission`) vi.setSystemTime(112);
        return value;
      } }));
      const observedAt = 10 + 90 * 24 * 60 * 60_000 - 1;
      await expect(guard.markSent({ channel: 'portal', private: 'must-not-write' }, observedAt)).resolves.toEqual({ minimal: true });
      expect(store.read(`${ROOT}/automation/execution`)!.minimalReceipt.at).toBe(observedAt);
      expect(store.read(`${ROOT}/automation/submission`)!.r1).not.toHaveProperty('private');
      expect(store.read(`${ROOT}/automation/submission`)!.r1.state).toBe('sending');
    } finally { vi.useRealTimers(); }
  });
  it('caps receipt observation at the original wait and never renews it with heartbeats', async () => {
    const store = await prepared(); let nowMs = 110;
    const actor = lease(store, { now: () => nowMs }); await actor.claim();
    const guard = submissionGuard(store.db, ORDER, 1, { execution: actor }); await guard.claim('portal');
    await expect(guard.markClicked(111, { receiptWaitMs: 240_000 })).resolves.toBe(90_111);
    nowMs = 112; store.read(ROOT)!.withdrawnAt = 112;
    expect(await actor.heartbeat()).toEqual({ receiptOnly: true, until: 90_111 });
    nowMs = 91_000;
    expect(await actor.heartbeat()).toEqual({ receiptOnly: true, until: 90_111 });
    expect(store.read(`${ROOT}/automation/execution`)!.lease.expiresAt).toBe(90_111);
    await expect(guard.markClicked(nowMs)).rejects.toThrow();
    // The observation deadline is not a proof TTL: a strong late acknowledgement
    // still belongs to the immutable original attempt and cannot trigger a resend.
    await guard.markSent({ channel: 'portal' }, nowMs);
    expect(store.read(`${ROOT}/automation/submission`)!.r1.state).toBe('sent');
  });
  it('hands over after a live shared-answer change despite unchanged child materials', async () => {
    const store = await prepared(); let nowMs = 110; let currentSource = 'source-A'; let sourceChecks = 0;
    const actor = lease(store, { now: () => nowMs }); await actor.claim();
    const guard = submissionGuard(store.db, ORDER, 1, { execution: actor }); await guard.claim('portal');
    const sourceGuard = { async assertInTransaction() { sourceChecks++; if (currentSource !== 'source-A') throw new Error('evidence_source_changed'); } };
    const originalMaterial = store.read(`${ROOT}/automation/execution`)!.materialVersion;
    await expect(actor.heartbeat({ answerSourceGuard: sourceGuard })).resolves.toEqual({ receiptOnly: false });
    expect(sourceChecks).toBe(1);
    await guard.markClicked(110);
    await expect(actor.heartbeat({ answerSourceGuard: sourceGuard })).resolves.toEqual({ receiptOnly: false });
    expect(sourceChecks).toBe(2);
    nowMs = 112; currentSource = 'source-C';
    await expect(actor.heartbeat({ answerSourceGuard: sourceGuard })).resolves.toEqual({ receiptOnly: true, until: 60_110 });
    expect(sourceChecks).toBe(3);
    expect(store.read(`${ROOT}/automation/execution`)!.materialVersion).toBe(originalMaterial);
    await expect(guard.markClicked(113)).rejects.toThrow();
    await guard.markSent({ channel: 'portal' }, 114);
    expect(store.read(`${ROOT}/automation/submission`)!.r1.state).toBe('sent');
  });
  it.each([false, true])('requires a quiescence ACK before retaining the page after authority loss (ACK=%s)', async ack => {
    vi.useFakeTimers(); vi.setSystemTime(110);
    const store = await prepared(); const closed = vi.fn(async () => {}); const lost = vi.fn();
    const runtime = await enterExecution({ db: store.db, orderId: ORDER, flow: store.read(`${ROOT}/automation/flow`),
      mode: 'submit', sourceSha: SHA, engineVersion: ENGINE, onLeaseLost: lost,
      env: { ASSISTED_APPLICATION_EXECUTION_ID: 'execution-fixture', ASSISTED_APPLICATION_EXECUTOR: 'mac-agenti',
        ASSISTED_APPLICATION_SOURCE_SHA: SHA, GITHUB_RUN_ID: 'run-fixture' } });
    try {
      runtime!.receiptControl.register({ quiesce: async () => ack, close: closed });
      const guard = submissionGuard(store.db, ORDER, 1, { execution: runtime!.lease });
      await guard.claim('portal'); await guard.markClicked(110, { receiptWaitMs: 5_000 });
      store.read(ROOT)!.withdrawnAt = 111; vi.setSystemTime(112);
      expect(await runtime!.receiptControl.authorizeContinuation()).toBe(false);
      expect(runtime!.receiptControl.receiptOnly).toBe(true);
      expect(closed).toHaveBeenCalledTimes(ack ? 0 : 1);
      if (ack) {
        await vi.advanceTimersByTimeAsync(5_001);
        expect(closed).toHaveBeenCalledTimes(1);
      }
      expect(runtime!.receiptControl.closed).toBe(true);
      expect(await runtime!.receiptControl.authorizeContinuation()).toBe(false);
      expect(lost).not.toHaveBeenCalled();
      expect(store.read(`${ROOT}/automation/submission`)!.r1).toMatchObject({ state: 'sending', clickedAt: 110 });
    } finally { await runtime!.close(); vi.useRealTimers(); }
  });
  it.each(['pending', 'rejected'])('terminates boundedly when context cleanup is %s across the receipt deadline', async failure => {
    vi.useFakeTimers(); vi.setSystemTime(110);
    const store = await prepared(); const lost = vi.fn();
    const runtime = await enterExecution({ db: store.db, orderId: ORDER, flow: store.read(`${ROOT}/automation/flow`),
      mode: 'submit', sourceSha: SHA, engineVersion: ENGINE, onLeaseLost: lost,
      env: { ASSISTED_APPLICATION_EXECUTION_ID: 'execution-fixture', ASSISTED_APPLICATION_EXECUTOR: 'mac-agenti',
        ASSISTED_APPLICATION_SOURCE_SHA: SHA, GITHUB_RUN_ID: 'run-fixture' } });
    try {
      const close = vi.fn(() => failure === 'pending' ? new Promise<void>(() => {}) : Promise.reject(new Error('synthetic_close_failed')));
      runtime!.receiptControl.register({ quiesce: async () => true, close });
      const guard = submissionGuard(store.db, ORDER, 1, { execution: runtime!.lease });
      await guard.claim('portal'); await guard.markClicked(110, { receiptWaitMs: 20 });
      store.read(ROOT)!.withdrawnAt = 111; vi.setSystemTime(112);
      expect(await runtime!.receiptControl.authorizeContinuation()).toBe(false);
      // A pending/failed cleanup never unregisters the close capability.
      void close().catch(() => {});
      await vi.advanceTimersByTimeAsync(3050);
      expect(close.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(lost).toHaveBeenCalledTimes(1);
      expect(runtime!.receiptControl.closed).toBe(true);
      expect(await runtime!.receiptControl.authorizeContinuation()).toBe(false);
      expect(store.read(`${ROOT}/automation/submission`)!.r1.state).toBe('sending');
    } finally { await runtime!.close(); vi.useRealTimers(); }
  });
  it('closes boundedly after a durable ACK even if cleanup stalls and the order is purged', async () => {
    vi.useFakeTimers(); vi.setSystemTime(110);
    const store = await prepared(); const lost = vi.fn();
    const runtime = await enterExecution({ db: store.db, orderId: ORDER, flow: store.read(`${ROOT}/automation/flow`),
      mode: 'submit', sourceSha: SHA, engineVersion: ENGINE, onLeaseLost: lost,
      env: { ASSISTED_APPLICATION_EXECUTION_ID: 'execution-fixture', ASSISTED_APPLICATION_EXECUTOR: 'mac-agenti',
        ASSISTED_APPLICATION_SOURCE_SHA: SHA, GITHUB_RUN_ID: 'run-fixture' } });
    try {
      const close = vi.fn(() => new Promise<void>(() => {}));
      runtime!.receiptControl.register({ quiesce: async () => true, close });
      const guard = submissionGuard(store.db, ORDER, 1, { execution: runtime!.lease });
      await guard.claim('portal'); await guard.markClicked(110); await guard.markSent({ channel: 'portal' }, 111);
      const closing = runtime!.receiptControl.received();
      Object.assign(store.read(ROOT)!, { retentionPurgingAt: 112, retentionPurgedAt: 113 });
      for (const suffix of ['automation/flow', 'automation/submission', 'ai_drafts/current']) store.docs.delete(`${ROOT}/${suffix}`);
      await vi.advanceTimersByTimeAsync(3050); await closing;
      expect(close).toHaveBeenCalledTimes(1); expect(lost).toHaveBeenCalledTimes(1);
      expect(runtime!.receiptControl.closed).toBe(true);
      expect(await runtime!.receiptControl.authorizeContinuation()).toBe(false);
      expect(store.read(`${ROOT}/automation/execution`)!.minimalReceipt).toMatchObject({ status: 'sent', round: 1 });
      expect(store.read(`${ROOT}/ai_drafts/current`)).toBeUndefined();
    } finally { await runtime!.close(); vi.useRealTimers(); }
  });
});
