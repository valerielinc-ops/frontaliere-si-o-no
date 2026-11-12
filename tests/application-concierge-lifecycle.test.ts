import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { APPLICATION_CONCIERGE_MATCHING_VERSION } from '../functions/src/applicationConciergeConstants.js';
import { CONCIERGE_ELIGIBILITY_VERSION } from '../functions/src/applicationConciergeEligibility.js';
import { withdrawAssistedApplication } from '../functions/src/assistedApplicationWithdrawal.js';
import {
  conciergeMatchingRecoveryContext,
  conciergeRefreshDue,
  conciergeStaleRecoveryExhausted,
  CONCIERGE_MATCHING_STALE_AFTER_MS,
  CONCIERGE_STALE_RECOVERY_BACKOFF_MS,
  CONCIERGE_STALE_RECOVERY_MAX_ATTEMPTS,
} from '../functions/src/applicationConciergeLifecyclePolicy.js';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { mergeConciergeMatchingRuntime } from '../functions/src/applicationConciergeRuntime.js';

const renewalRollout = vi.hoisted(() => ({ isEnabledFor: vi.fn(async () => true) }));

vi.mock('firebase-admin/firestore', () => {
  class DeleteTransform {}
  return {
    FieldValue: {
      delete: () => new DeleteTransform(),
      serverTimestamp: () => '__server_timestamp__',
      increment: (value: number) => ({ __increment: value }),
    },
    Timestamp: { now: () => new Date(), fromMillis: (value: number) => new Date(value) },
  };
});

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getNewsletterSecrets: vi.fn(async () => ({ newsletterSecret: 'test-only-secret' })), getRemoteConfigValue: vi.fn(async () => '') }));
vi.mock('../functions/src/applicationConciergeRenewalRollout.js', () => ({
  isApplicationConciergeRenewalEnabledFor: renewalRollout.isEnabledFor,
}));
vi.mock('../functions/src/applicationConciergeMatching.js', () => ({
  runApplicationConciergeMatching: vi.fn(),
  proposalDocumentId: vi.fn(() => 'job-test'),
  rankingFeaturesForJob: vi.fn(() => ({})),
}));
vi.mock('../functions/src/assistedApplicationNotifications.js', () => ({
  customerEmailFor: (service: any) => {
    for (const candidate of [service?.applicantEmail, service?.customerEmail]) {
      const value = String(candidate || '').trim().toLowerCase();
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 320) return value;
    }
    return '';
  },
  sendOrderNotification: vi.fn(),
}));
vi.mock('../functions/src/applicationConciergeRenewalMaterials.js', () => ({ inheritConciergeRenewalMaterials: vi.fn(async () => ({ copied: false })) }));
vi.mock('../functions/src/applicationConciergePaymentReminders.js', () => ({ paymentReminderUrl: (uid: string) => `https://example.test/unsubscribe/?uid=${uid}` }));
const { isFreshConciergeProposalRefreshRequest, queueConciergeMatchingRefresh, runConciergeLifecycleSweep, runConciergeMatchingWithLease, runConciergeProposalRefresh } = await import('../functions/src/applicationConciergeLifecycle.js');
const { buildConciergeNewJobsEmail, buildConciergeRenewalEmail } = await import('../functions/src/applicationConciergeLifecycleEmails.js');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
let records: Map<string, any>;
let queue: Promise<any>;
function serviceWithRuntime(path: string) {
  return mergeConciergeMatchingRuntime(records.get(path) || {}, records.get(`${path}/runtime/matching`) || null);
}
function storeServiceWithRuntime(store: ReturnType<typeof createMemoryFirestore>, path: string) {
  return mergeConciergeMatchingRuntime(store.read(path) || {}, store.read(`${path}/runtime/matching`) || null);
}
function ref(path: string): any {
  return { id: path.split('/').at(-1),
    get: async () => ({ exists: records.has(path), data: () => records.get(path), id: path.split('/').at(-1), ref: ref(path) }),
    set: async (patch: any) => {
      const next = { ...records.get(path) };
      for (const [key, value] of Object.entries(patch)) {
        if ((value as any)?.constructor?.name === 'DeleteTransform') delete next[key]; else next[key] = value;
      }
      records.set(path, next);
    },
    collection: (name: string) => collection(`${path}/${name}`),
  };
}
function collection(path: string): any {
  return { doc: (id: string) => ref(`${path}/${id}`),
    get: async () => ({ docs: await Promise.all([...records.keys()].filter(key => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')).map(key => ref(key).get())) }),
    where: (field: string, _operator: string, value: any) => ({ get: async () => ({ docs: (await collection(path).get()).docs.filter((doc: any) => doc.data()[field] === value) }) }),
  };
}
const tx = { get: (document: any) => document.get(), set: (document: any, patch: any) => document.set(patch) };
const db: any = { collection, runTransaction: (callback: any) => {
  const result = queue.then(() => callback(tx)); queue = result.catch(() => {}); return result;
} };
function active(patch = {}) {
  return { userId: 'candidate', customerEmail: 'candidate@example.test', paymentStatus: 'paid', serviceStatus: 'active',
    locale: 'it', expiresAt: now + DAY, paidAt: now - 29 * DAY, cvStorageKey: 'private/cv.pdf', consentedAt: now - 29 * DAY,
    matchingCompletedAt: now - 3 * DAY, matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION, acceptedPositionsCount: 2, ...patch };
}
const deliveries: string[] = [];
const trackingTargets: Array<{ key: string; trackingTarget?: any }> = [];
const passThroughJobCards = async (proposals: any[]) => proposals;
const eligibleProposal = (patch: Record<string, unknown> = {}) => ({
  status: 'proposed', eligibilityStatus: 'compatible', eligibilityVersion: CONCIERGE_ELIGIBILITY_VERSION,
  eligibilityCvStorageKey: 'private/cv.pdf', eligibilityFactsRevision: 0,
  eligibilityAcceptableSince: new Date(now), proposalNoticeSentAt: null,
  ...patch,
});
const recipientHash = (email: string) => createHash('sha256').update(`service|${email.trim().toLowerCase()}`).digest('hex').slice(0, 24);
const send = vi.fn(async ({ recordRef, key, build, eligible, trackingTarget }: any) => db.runTransaction(async (transaction: any) => {
  const current = (await transaction.get(recordRef)).data();
  if (eligible && !await eligible(current, transaction)) return { ok: false, reason: 'ineligible' };
  if (current.notifications?.[key]) return { ok: false, reason: 'already_sent' };
  await build(current, {});
  deliveries.push(key);
  trackingTargets.push({ key, trackingTarget });
  await transaction.set(recordRef, { notifications: { ...current.notifications, [key]: { status: 'sent' } } });
  return { ok: true };
}));
const match = vi.fn(async ({ serviceId }: any) => {
  const proposalRef = ref(`application_concierge_services/${serviceId}/proposals/new-job`);
  const existing = (await proposalRef.get()).data() || null;
  if (!existing || existing.status === 'retracted') {
    await proposalRef.set(eligibleProposal({ jobTitle: 'Commerciale', companyName: 'Example',
      ...(existing?.status === 'retracted' ? { reactivatedAt: new Date(now) } : {}) }));
  }
  await ref(`application_concierge_services/${serviceId}`).set({ matchingCompletedAt: new Date(now), matchingStatus: 'complete', matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION });
  return { status: 'complete' };
});
const sweep = (options = {}) => runConciergeLifecycleSweep({ db, nowMs: now, match, send, enrichJobCards: passThroughJobCards, unsubscribeSecret: 'test-only-secret', enqueueOnly: false, ...options });
const refresh = (options: any) => runConciergeProposalRefresh({ db, nowMs: now, match, send, enrichJobCards: passThroughJobCards, ...options });
beforeEach(() => {
  records = new Map(); queue = Promise.resolve(); deliveries.length = 0; trackingTargets.length = 0;
  vi.clearAllMocks(); renewalRollout.isEnabledFor.mockResolvedValue(true);
});

describe('concierge refresh and notification lifecycle', () => {
  it('coalesces repeated matcher-version invalidations before queueing a full refresh', async () => {
    records.set('application_concierge_services/service', active({ matchingStatus: 'complete', matchingVersion: 'legacy-version', matchingCompletedAt: now }));

    const first = await sweep({ enqueueOnly: true });
    expect(first.queuedRefreshes).toBe(0);
    expect(records.get('application_concierge_services/service')).toMatchObject({
      matchingVersionRefreshVersion: APPLICATION_CONCIERGE_MATCHING_VERSION,
      matchingVersionRefreshObservedAt: new Date(now),
    });
    expect(match).not.toHaveBeenCalled();

    const later = now + 60 * 60 * 1000;
    const beforeSettle = await sweep({ enqueueOnly: true, nowMs: later - 1 });
    expect(beforeSettle.queuedRefreshes).toBe(0);
    const ready = await sweep({ enqueueOnly: true, nowMs: later });
    expect(ready.queuedRefreshes).toBe(1);
    expect(match).not.toHaveBeenCalled();
    expect(records.get('application_concierge_services/service').matchingVersionRefreshObservedAt).toBeUndefined();
  });

  it('coalesces event-driven matcher refreshes in the lifecycle sweep', async () => {
    records.set('application_concierge_services/service', active({ matchingStatus: 'complete', matchingCompletedAt: now }));

    expect(await queueConciergeMatchingRefresh({ db, serviceId: 'service', nowMs: now })).toBe(true);
    expect(records.get('application_concierge_services/service')).toMatchObject({ matchingStatus: 'complete' });
    expect(records.get('application_concierge_services/service')).not.toHaveProperty('matchingEventRefreshRequestedAt');
    expect(records.get('application_concierge_services/service/runtime/matching')).toMatchObject({
      schemaVersion: 3, matchingEventRefreshRequestedAt: new Date(now),
    });

    const queued = await sweep({ enqueueOnly: true });
    expect(queued.queuedRefreshes).toBe(1);
    expect(match).not.toHaveBeenCalled();
    expect(records.get('application_concierge_services/service/runtime/matching').matchingEventRefreshRequestedAt).toBeUndefined();
    expect(records.get('application_concierge_services/service').proposalRefreshRequestId).toEqual(expect.any(String));

    records.set('application_concierge_services/running', active({ matchingStatus: 'running' }));
    expect(await queueConciergeMatchingRefresh({ db, serviceId: 'running', nowMs: now })).toBe(true);
    expect(records.get('application_concierge_services/running').matchingStatus).toBe('running');
    expect(records.get('application_concierge_services/running/runtime/matching').matchingEventRefreshRequestedAt).toBeInstanceOf(Date);
  });

  it('respects a future retry when discovery is complete, without postponing fresh discovery', () => {
    const service = active({ matchingStatus: 'complete', matchingCompletedAt: now - 3600000,
      matchingPendingCount: 0, matchingUnverifiedCount: 2, matchingRetryAt: now + 12 * 3600000 });
    expect(conciergeRefreshDue(service, now)).toBe(false);
    expect(conciergeRefreshDue(service, now + 12 * 3600000)).toBe(true);
    expect(conciergeRefreshDue({ ...service, matchingPendingCount: 10 }, now)).toBe(true);
  });
  it('continues an unfinished search hourly while respecting expiry and the assisted-application cap', () => {
    const service = active({ matchingStatus: 'complete', matchingCompletedAt: now - 60 * 60 * 1000, matchingPendingCount: 20, matchingUnverifiedCount: 0 });
    expect(conciergeRefreshDue(service, now)).toBe(true);
    expect(conciergeRefreshDue({ ...service, matchingCompletedAt: now - (60 * 60 * 1000 - 1) }, now)).toBe(false);
    expect(conciergeRefreshDue({ ...service, matchingCompletedAt: now - 30 * 60 * 1000 }, now)).toBe(false);
    expect(conciergeRefreshDue({ ...service, acceptedPositionsCount: 10 }, now)).toBe(false);
    expect(conciergeRefreshDue({ ...service, expiresAt: now - 1 }, now)).toBe(false);
  });
  it('keeps the 15-minute lifecycle poll separate from the hourly pending-scan gate', () => {
    const completion = now - 30 * 60 * 1000;
    const service = active({ matchingStatus: 'complete', matchingCompletedAt: completion,
      matchingPendingCount: 20, matchingUnverifiedCount: 0 });
    expect(conciergeRefreshDue(service, now)).toBe(false);
    expect(conciergeRefreshDue(service, completion + 15 * 60 * 1000)).toBe(false);
    expect(conciergeRefreshDue(service, completion + 60 * 60 * 1000)).toBe(true);
    const source = readFileSync(new URL('../functions/index.js', import.meta.url), 'utf8');
    const start = source.indexOf('export const sweepApplicationConciergeLifecycle = onSchedule(');
    expect(source.slice(start, start + 600)).toContain("schedule: 'every 15 minutes'");
  });
  it('recovers stale matcher runs with input-scoped, bounded backoff', () => {
    const stale = active({ matchingStatus: 'running', matchingStartedAt: now - CONCIERGE_MATCHING_STALE_AFTER_MS - 1 });
    const context = conciergeMatchingRecoveryContext(stale);
    expect(conciergeRefreshDue(stale, now)).toBe(true);
    expect(conciergeRefreshDue({ ...stale, matchingStartedAt: now - CONCIERGE_MATCHING_STALE_AFTER_MS + 1 }, now)).toBe(false);

    const retry = { ...stale, matchingStaleRecoveryContext: context, matchingStaleRecoveryAttempt: 1,
      matchingStaleRecoveryRetryAt: now + CONCIERGE_STALE_RECOVERY_BACKOFF_MS[0] };
    expect(conciergeRefreshDue(retry, now)).toBe(false);
    expect(conciergeRefreshDue(retry, now + CONCIERGE_STALE_RECOVERY_BACKOFF_MS[0])).toBe(true);
    expect(conciergeRefreshDue({ ...retry, cvStorageKey: 'private/new-cv.pdf' }, now)).toBe(true);
    expect(conciergeRefreshDue({ ...stale, matchingStatus: 'complete', matchingCompletedAt: now,
      proposalRefreshRerunAfterWorker: true, proposalRefreshRerunAfterWorkerContext: context }, now)).toBe(true);

    const exhausted = { ...stale, matchingStaleRecoveryContext: context,
      matchingStaleRecoveryAttempt: CONCIERGE_STALE_RECOVERY_MAX_ATTEMPTS,
      matchingStaleRecoveryRetryAt: now - 1 };
    expect(conciergeRefreshDue(exhausted, now)).toBe(false);
    expect(conciergeStaleRecoveryExhausted(exhausted, now)).toBe(true);
  });
  it('queues due services separately instead of doing their AI work in the hourly sweep', async () => {
    records.set('application_concierge_services/service', active());
    const result = await sweep({ enqueueOnly: true });
    expect(result.queuedRefreshes).toBe(1);
    expect(match).not.toHaveBeenCalled();
    expect(records.get('application_concierge_services/service').proposalRefreshRequestId).toEqual(expect.any(String));
    await sweep({ enqueueOnly: true });
    expect(match).not.toHaveBeenCalled();
  });
  it('claims one refresh across concurrent sweeps and sends one genuinely-new-jobs notice', async () => {
    records.set('application_concierge_services/service', active());
    await Promise.all([sweep(), sweep()]);
    expect(match).toHaveBeenCalledTimes(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatch(/^new_proposals_/);
    expect(trackingTargets[0]).toEqual({ key: deliveries[0], trackingTarget: { kind: 'application-concierge', id: 'service' } });
    await sweep();
    expect(deliveries).toHaveLength(1);
  });
  it('enriches the visible proposal cards before building the new-opportunities email', async () => {
    const proposal = {
      status: 'proposed', jobId: 'stadt-zuerich-job', companyId: 'stadt-zuerich',
      companyName: 'Stadt Zürich', jobTitle: 'Application Manager',
      jobUrl: 'https://jobs.example.test/application-manager', location: 'Zürich',
    };
    records.set('application_concierge_services/service', active({
      pendingProposalNotice: { key: 'new_proposals_card', proposalIds: ['card-proposal'] },
    }));
    records.set('application_concierge_services/service/proposals/card-proposal', eligibleProposal(proposal));
    const companyLogo = 'https://cdn.frontaliereticino.ch/images/brands/stadt-zuerich.png';
    const enrichJobCards = vi.fn(async (items: any[]) => items.map((item) => ({ ...item, companyLogo })));
    const messages: any[] = [];
    const buildAndSend = vi.fn(async ({ recordRef, build, eligible }: any) => db.runTransaction(async (transaction: any) => {
      const current = (await transaction.get(recordRef)).data();
      if (eligible && !await eligible(current, transaction)) return { ok: false, reason: 'ineligible' };
      messages.push(await build(current, {}));
      return { ok: true };
    }));

    const result = await sweep({ enqueueOnly: true, send: buildAndSend, enrichJobCards });

    expect(result.newJobEmails).toBe(1);
    expect(enrichJobCards).toHaveBeenCalledWith([expect.objectContaining(proposal)]);
    expect(messages).toHaveLength(1);
    expect(messages[0].html).toContain(`<img src="${companyLogo}"`);
  });
  it('rechecks acceptability before retrying an announcement and drops stale pending notices', async () => {
    records.set('application_concierge_services/service', active({
      eligibilityFactsRevision: 1,
      pendingProposalNotice: { key: 'new_proposals_stale', proposalIds: ['stale-proposal'] },
    }));
    records.set('application_concierge_services/service/proposals/stale-proposal', eligibleProposal({ eligibilityFactsRevision: 0 }));
    const sendNotice = vi.fn(async () => ({ ok: true }));

    await sweep({ enqueueOnly: true, send: sendNotice });

    expect(sendNotice).not.toHaveBeenCalled();
    expect(serviceWithRuntime('application_concierge_services/service').pendingProposalNotice).toBeUndefined();
  });
  it.each([{ acceptedPositionsCount: 10 }, { expiresAt: now }])('does not refresh beyond the cap or expiry: %j', async patch => {
    records.set('application_concierge_services/service', active(patch));
    await sweep();
    expect(match).not.toHaveBeenCalled();
    expect(deliveries.filter(key => key.startsWith('new_proposals_'))).toHaveLength(0);
  });
  it('does not notify jobs that were already present before the refresh', async () => {
    records.set('application_concierge_services/service', active());
    records.set('application_concierge_services/service/proposals/new-job', eligibleProposal({
      eligibilityAcceptableSince: new Date(now - DAY), proposalNoticeSentAt: new Date(now - DAY),
    }));
    await sweep();
    expect(deliveries).toHaveLength(0);
  });
  it('consumes a refresh request once even when Firestore redelivers after the worker finishes', async () => {
    records.set('application_concierge_services/service', active({ proposalRefreshRequestId: 'refresh-request' }));
    const options = { db, serviceId: 'service', requestId: 'refresh-request', nowMs: now, match, send };
    await refresh(options);
    await refresh(options);
    expect(match).toHaveBeenCalledTimes(1);
    expect(deliveries).toHaveLength(1);
    expect(records.get('application_concierge_services/service/runtime/matching').proposalRefreshCompletedRequestId).toBe('refresh-request');
  });
  it('serializes duplicate deliveries with an owner lease and does not release another worker lock', async () => {
    const event = await realWithdrawal();
    let finishMatch: ((value: { status: string }) => void) | undefined;
    const blockedMatch = vi.fn(async ({ db: workerDb }: any) => {
      await workerDb.collection('application_concierge_services').doc(WITHDRAWAL_SERVICE_ID)
        .set({ matchingStatus: 'running', matchingStartedAt: new Date(WITHDRAWAL_NOW) }, { merge: true });
      return new Promise<{ status: string }>(resolve => { finishMatch = resolve; });
    });
    const options = { db: event.store.db, serviceId: WITHDRAWAL_SERVICE_ID, requestId: event.requestId,
      nowMs: WITHDRAWAL_NOW, match: blockedMatch, send };
    const first = refresh(options);
    await vi.waitFor(() => expect(blockedMatch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(event.store.read(WITHDRAWAL_SERVICE_PATH).matchingStatus).toBe('running'));
    const duplicate = await refresh(options);
    expect(duplicate).toEqual({ refreshed: 0, newJobEmails: 0 });
    expect(blockedMatch).toHaveBeenCalledTimes(1);

    finishMatch?.({ status: 'complete' });
    await first;
    const after = storeServiceWithRuntime(event.store, WITHDRAWAL_SERVICE_PATH);
    expect(event.store.read(`${WITHDRAWAL_SERVICE_PATH}/runtime/matching`)).not.toHaveProperty('proposalRefreshWorkerLeaseId');
    expect(after.proposalRefreshRequestId).toBe(event.requestId);
    expect(after.proposalRefreshRerunAfterWorker).toBeUndefined();
  });
  it('uses the same lease for the initial CV/location trigger and lifecycle recovery', async () => {
    const store = withdrawalRefreshFixture();
    let finishMatch: ((value: { status: string }) => void) | undefined;
    const blockedMatch = vi.fn(() => new Promise<{ status: string }>(resolve => { finishMatch = resolve; }));
    const first = runConciergeMatchingWithLease({ db: store.db, serviceId: WITHDRAWAL_SERVICE_ID,
      nowMs: WITHDRAWAL_NOW, match: blockedMatch });
    await vi.waitFor(() => expect(blockedMatch).toHaveBeenCalledTimes(1));
    await store.db.collection('application_concierge_services').doc(WITHDRAWAL_SERVICE_ID)
      .set({ proposalRefreshRequestId: 'refresh-during-initial-match' }, { merge: true });

    const duplicate = await runConciergeProposalRefresh({ db: store.db, serviceId: WITHDRAWAL_SERVICE_ID,
      requestId: 'refresh-during-initial-match', nowMs: WITHDRAWAL_NOW, match: blockedMatch, send });
    expect(duplicate).toEqual({ refreshed: 0, newJobEmails: 0 });
    expect(blockedMatch).toHaveBeenCalledTimes(1);
    expect(readFileSync(new URL('../functions/index.js', import.meta.url), 'utf8'))
      .toContain('runConciergeMatchingWithLease({ db, serviceId: event.params.serviceId');

    finishMatch?.({ status: 'complete' });
    await first;
    const after = storeServiceWithRuntime(store, WITHDRAWAL_SERVICE_PATH);
    expect(store.read(`${WITHDRAWAL_SERVICE_PATH}/runtime/matching`)).not.toHaveProperty('proposalRefreshWorkerLeaseId');
    expect(after.proposalRefreshRequestId).not.toBe('refresh-during-initial-match');
    expect(after.proposalRefreshRequestedBy).toBe('lifecycle');
    expect(after.proposalRefreshRerunAfterWorker).toBeUndefined();
  });

  it('queues a fresh pass when candidate facts change during an active match', async () => {
    const store = withdrawalRefreshFixture();
    let finishMatch: ((value: { status: string }) => void) | undefined;
    const blockedMatch = vi.fn(() => new Promise<{ status: string }>(resolve => { finishMatch = resolve; }));
    const first = runConciergeMatchingWithLease({ db: store.db, serviceId: WITHDRAWAL_SERVICE_ID,
      nowMs: WITHDRAWAL_NOW, match: blockedMatch });
    await vi.waitFor(() => expect(blockedMatch).toHaveBeenCalledTimes(1));

    await store.db.collection('application_concierge_services').doc(WITHDRAWAL_SERVICE_ID)
      .set({ eligibilityFactsRevision: 1, matchingStatus: 'queued' }, { merge: true });
    const duplicate = await runConciergeMatchingWithLease({ db: store.db, serviceId: WITHDRAWAL_SERVICE_ID,
      nowMs: WITHDRAWAL_NOW, match: blockedMatch });
    expect(duplicate).toMatchObject({ status: 'skipped', reason: 'matching_worker_active' });

    finishMatch?.({ status: 'complete' });
    await first;
    const after = storeServiceWithRuntime(store, WITHDRAWAL_SERVICE_PATH);
    expect(after.proposalRefreshRequestedBy).toBe('lifecycle');
    expect(after.proposalRefreshRequestId).toBeTruthy();
    expect(after.proposalRefreshRerunAfterWorker).toBeUndefined();
  });

  it('backs off stale worker recovery, caps retries, and marks exhausted services explicitly', async () => {
    const store = withdrawalRefreshFixture({
      matchingStatus: 'running',
      matchingStartedAt: WITHDRAWAL_NOW - CONCIERGE_MATCHING_STALE_AFTER_MS - 1,
      proposalRefreshRequestId: 'stale-run-1',
    });
    const servicePath = WITHDRAWAL_SERVICE_PATH;
    const failedMatch = vi.fn(async () => { throw new Error('simulated worker exit'); });
    let attemptNow = WITHDRAWAL_NOW;

    for (let attempt = 0; attempt < CONCIERGE_STALE_RECOVERY_MAX_ATTEMPTS; attempt += 1) {
      const service = storeServiceWithRuntime(store, servicePath);
      if (attempt > 0) {
        attemptNow = new Date(service.matchingStaleRecoveryRetryAt).getTime();
        await store.db.collection('application_concierge_services').doc(WITHDRAWAL_SERVICE_ID).set({
          proposalRefreshRequestId: `stale-run-${attempt + 1}`,
          matchingStatus: 'running',
          matchingStartedAt: WITHDRAWAL_NOW - CONCIERGE_MATCHING_STALE_AFTER_MS - 1,
        }, { merge: true });
      }
      const requestId = `stale-run-${attempt + 1}`;
      await expect(runConciergeProposalRefresh({ db: store.db, serviceId: WITHDRAWAL_SERVICE_ID,
        requestId, nowMs: attemptNow, match: failedMatch, send })).rejects.toThrow('simulated worker exit');
      const updated = storeServiceWithRuntime(store, servicePath);
      expect(updated.matchingStaleRecoveryAttempt).toBe(attempt + 1);
      expect(updated.matchingStaleRecoveryRetryAt).toBeInstanceOf(Date);
      expect(store.read(`${servicePath}/runtime/matching`)?.proposalRefreshWorkerLeaseId).toBeUndefined();
      if (attempt < CONCIERGE_STALE_RECOVERY_MAX_ATTEMPTS - 1) {
        expect(conciergeRefreshDue(updated, attemptNow)).toBe(false);
        expect(conciergeRefreshDue(updated, new Date(updated.matchingStaleRecoveryRetryAt).getTime())).toBe(true);
      }
    }

    const exhaustedAt = new Date(storeServiceWithRuntime(store, servicePath).matchingStaleRecoveryRetryAt).getTime();
    const runtimeRef = store.db.collection('application_concierge_services').doc(WITHDRAWAL_SERVICE_ID)
      .collection('runtime').doc('matching');
    await runtimeRef.set({
      schemaVersion: 3,
      matchingRunStatus: 'running',
      matchingStartedAt: new Date(exhaustedAt - CONCIERGE_MATCHING_STALE_AFTER_MS - 1),
    }, { merge: true });
    expect(conciergeStaleRecoveryExhausted(storeServiceWithRuntime(store, servicePath), exhaustedAt)).toBe(true);
    const result = await runConciergeLifecycleSweep({ db: store.db, nowMs: exhaustedAt, match: failedMatch,
      send, unsubscribeSecret: 'test-only-secret', enqueueOnly: false, enrichJobCards: passThroughJobCards });
    expect(result.refreshed).toBe(0);
    expect(failedMatch).toHaveBeenCalledTimes(CONCIERGE_STALE_RECOVERY_MAX_ATTEMPTS);
    expect(storeServiceWithRuntime(store, servicePath)).toMatchObject({
      matchingStatus: 'failed',
      matchingError: 'stale_worker_retry_exhausted',
      matchingStaleRecoveryAttempt: CONCIERGE_STALE_RECOVERY_MAX_ATTEMPTS,
    });
    expect(store.read(`${servicePath}/runtime/matching`)).not.toHaveProperty('matchingRunStatus');
    expect(store.read(`${servicePath}/runtime/matching`)).not.toHaveProperty('matchingStartedAt');
  });
  it('counts ordinary failed matcher runs against the same bounded recovery budget', async () => {
    const requestId = 'ordinary-failed-match-retry';
    const store = withdrawalRefreshFixture({ matchingStatus: 'failed', matchingCompletedAt: WITHDRAWAL_NOW - 60 * 60 * 1000,
      matchingError: 'job_search_failed', proposalRefreshRequestId: requestId });
    const failedMatch = vi.fn(async () => { throw new Error('simulated matcher failure'); });

    await expect(runConciergeProposalRefresh({ db: store.db, serviceId: WITHDRAWAL_SERVICE_ID, requestId,
      nowMs: WITHDRAWAL_NOW, match: failedMatch, send })).rejects.toThrow('simulated matcher failure');

    const updated = storeServiceWithRuntime(store, WITHDRAWAL_SERVICE_PATH);
    expect(updated).toMatchObject({ matchingStatus: 'failed', matchingError: 'job_search_failed',
      matchingStaleRecoveryAttempt: 1, proposalRefreshLastError: 'matching_failed' });
    expect(updated.matchingStaleRecoveryRetryAt).toBeInstanceOf(Date);
    expect(conciergeRefreshDue(updated, WITHDRAWAL_NOW)).toBe(false);
    expect(conciergeRefreshDue(updated, updated.matchingStaleRecoveryRetryAt.getTime())).toBe(true);
  });
  it('notifies a retracted proposal that becomes available again, once per actual reactivation', async () => {
    records.set('application_concierge_services/service', active());
    await sweep();
    const firstKey = deliveries[0];
    await ref('application_concierge_services/service/proposals/new-job').set({ status: 'retracted' });
    await refresh({ db, serviceId: 'service', nowMs: now + 1, match, send });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[1]).not.toBe(firstKey);
    await refresh({ db, serviceId: 'service', nowMs: now + 2, match, send });
    expect(deliveries).toHaveLength(2);
  });
  it('completes an empty refresh without sending an empty opportunities notice', async () => {
    records.set('application_concierge_services/service', active({ proposalRefreshRequestId: 'empty-request' }));
    const emptyMatch = vi.fn(async () => ({ status: 'complete' }));
    const options = { db, serviceId: 'service', requestId: 'empty-request', nowMs: now, match: emptyMatch, send };
    await refresh(options);
    await refresh(options);
    expect(emptyMatch).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
  it.each([{ acceptedPositionsCount: 10 }, { expiresAt: now }])('does not deliver an existing notice after eligibility ends: %j', async patch => {
    records.set('application_concierge_services/service', active({ ...patch, pendingProposalNotice: { key: 'new_proposals_pending', proposalIds: ['new-job'] } }));
    records.set('application_concierge_services/service/proposals/new-job', { status: 'proposed' });
    await sweep();
    expect(deliveries.filter(key => key.startsWith('new_proposals_'))).toHaveLength(0);
  });
  it('retries a failed notice without repeating the matching run', async () => {
    records.set('application_concierge_services/service', active({ matchingCompletedAt: now, pendingProposalNotice: { key: 'new_proposals_retry', proposalIds: ['new-job'] } }));
    records.set('application_concierge_services/service/proposals/new-job', eligibleProposal({ jobTitle: 'Example', companyName: 'Example' }));
    const failure = vi.fn(async () => ({ ok: false, reason: 'provider_failed' }));
    await sweep({ send: failure });
    expect(serviceWithRuntime('application_concierge_services/service').pendingProposalNotice).toBeTruthy();
    await sweep();
    expect(match).not.toHaveBeenCalled();
    expect(deliveries).toEqual(['new_proposals_retry']);
    expect(serviceWithRuntime('application_concierge_services/service').pendingProposalNotice).toBeUndefined();
  });
  it('records an ambiguous announcement as unknown and never requeues it or starts the decision timer', async () => {
    records.set('application_concierge_services/service', active({ matchingCompletedAt: now,
      pendingProposalNotice: { key: 'new_proposals_ambiguous', proposalIds: ['new-job'] } }));
    records.set('application_concierge_services/service/proposals/new-job', eligibleProposal());
    const ambiguousNotice = vi.fn(async ({ recordRef, eligible }: any) => db.runTransaction(async (transaction: any) => {
      const current = (await transaction.get(recordRef)).data();
      if (eligible && !await eligible(current, transaction)) return { ok: false, reason: 'ineligible' };
      return { ok: false, reason: 'already_ambiguous' };
    }));

    await sweep({ send: ambiguousNotice });
    await ref('application_concierge_services/service/proposals/new-job').set({ eligibilityStatus: 'unverified' });
    await sweep({ send: ambiguousNotice });
    await ref('application_concierge_services/service/proposals/new-job').set({ eligibilityStatus: 'compatible' });
    await sweep({ send: ambiguousNotice });

    expect(ambiguousNotice).toHaveBeenCalledTimes(1);
    expect(serviceWithRuntime('application_concierge_services/service').pendingProposalNotice).toBeUndefined();
    expect(records.get('application_concierge_services/service/proposals/new-job')).toMatchObject({
      proposalNoticeStatus: 'unknown', proposalNoticeUnknownAt: expect.any(Date),
    });
    expect(records.get('application_concierge_services/service/proposals/new-job')).not.toHaveProperty('proposalNoticeSentAt');
  });
  it.each([
    ['already_delivered', 'sent', true],
    ['already_bounced', 'undeliverable', false],
    ['already_complained', 'undeliverable', false],
  ] as const)('settles terminal provider outcome %s without a repeat send', async (reason, expectedStatus, startsTimer) => {
    records.set('application_concierge_services/service', active({ matchingCompletedAt: now,
      pendingProposalNotice: { key: `new_proposals_${reason}`, proposalIds: ['new-job'] } }));
    records.set('application_concierge_services/service/proposals/new-job', eligibleProposal());
    const terminalNotice = vi.fn(async ({ recordRef, eligible }: any) => db.runTransaction(async (transaction: any) => {
      const current = (await transaction.get(recordRef)).data();
      if (eligible && !await eligible(current, transaction)) return { ok: false, reason: 'ineligible' };
      return { ok: false, reason };
    }));

    await sweep({ send: terminalNotice });
    await sweep({ send: terminalNotice });

    const proposal = records.get('application_concierge_services/service/proposals/new-job');
    expect(terminalNotice).toHaveBeenCalledTimes(1);
    expect(serviceWithRuntime('application_concierge_services/service').pendingProposalNotice).toBeUndefined();
    expect(proposal.proposalNoticeStatus).toBe(expectedStatus);
    expect(Boolean(proposal.proposalNoticeSentAt)).toBe(startsTimer);
    if (startsTimer) expect(proposal.proposalNoticeSentAt).toBeInstanceOf(Date);
    else expect(proposal.proposalNoticeUndeliverableAt).toBeInstanceOf(Date);
  });
  it('requeues a provider-bounced proposal only after the candidate changes the recipient address', async () => {
    const oldKey = 'new_proposals_old_recipient';
    const oldEmail = 'old@example.test';
    const newEmail = 'corrected@example.test';
    records.set('application_concierge_services/service', active({ matchingCompletedAt: now,
      applicantEmail: newEmail,
      notifications: { [oldKey]: { status: 'sent', providerStatus: 'accepted', deliveryStatus: 'bounced',
        to: oldEmail, bouncedAt: new Date(now - 1000) } },
    }));
    records.set('application_concierge_services/service/proposals/new-job', eligibleProposal({
      proposalNoticeSentAt: new Date(now - 60_000), proposalNoticeStatus: 'sent',
      proposalNoticeKey: oldKey, proposalNoticeRecipientHash: recipientHash(oldEmail),
    }));

    await sweep();

    const proposal = records.get('application_concierge_services/service/proposals/new-job');
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatch(/^new_proposals_/);
    expect(deliveries[0]).not.toBe(oldKey);
    expect(proposal).toMatchObject({
      proposalNoticeStatus: 'sent',
      proposalNoticeKey: deliveries[0],
      proposalNoticeRecipientHash: recipientHash(newEmail),
      proposalNoticeSentAt: expect.any(Date),
    });
    expect(serviceWithRuntime('application_concierge_services/service').pendingProposalNotice).toBeUndefined();
  });
  it('moves an unsent pending proposal notice to a corrected recipient without reusing the old idempotency key', async () => {
    const oldEmail = 'old@example.test';
    const newEmail = 'corrected@example.test';
    records.set('application_concierge_services/service', active({ matchingCompletedAt: now, applicantEmail: newEmail,
      pendingProposalNotice: { key: 'new_proposals_pending_old_email', proposalIds: ['new-job'],
        recipientHash: recipientHash(oldEmail), createdAt: new Date(now - 1000) },
    }));
    records.set('application_concierge_services/service/proposals/new-job', eligibleProposal());

    await sweep();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).not.toBe('new_proposals_pending_old_email');
    expect(records.get('application_concierge_services/service/proposals/new-job')).toMatchObject({
      proposalNoticeStatus: 'sent', proposalNoticeRecipientHash: recipientHash(newEmail),
    });
  });
  it('uses the queued recipient fingerprint when a bounce webhook arrives before the sender persists its address', async () => {
    const oldEmail = 'old@example.test';
    const newEmail = 'corrected@example.test';
    const oldKey = 'new_proposals_bounced_before_to';
    records.set('application_concierge_services/service', active({ matchingCompletedAt: now, applicantEmail: newEmail,
      notifications: { [oldKey]: { status: 'sent', providerStatus: 'accepted', deliveryStatus: 'bounced' } },
      pendingProposalNotice: { key: oldKey, proposalIds: ['new-job'], recipientHash: recipientHash(oldEmail),
        createdAt: new Date(now - 1000) },
    }));
    records.set('application_concierge_services/service/proposals/new-job', eligibleProposal());

    await sweep();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).not.toBe(oldKey);
    expect(records.get('application_concierge_services/service/proposals/new-job')).toMatchObject({
      proposalNoticeStatus: 'sent', proposalNoticeRecipientHash: recipientHash(newEmail),
    });
  });
  it('does not retry a provider complaint after the candidate changes the recipient address', async () => {
    const oldKey = 'new_proposals_complaint';
    const oldEmail = 'old@example.test';
    records.set('application_concierge_services/service', active({ matchingCompletedAt: now,
      applicantEmail: 'corrected@example.test',
      notifications: { [oldKey]: { status: 'sent', providerStatus: 'accepted', deliveryStatus: 'complained',
        to: oldEmail, complainedAt: new Date(now - 1000) } },
    }));
    records.set('application_concierge_services/service/proposals/new-job', eligibleProposal({
      proposalNoticeSentAt: new Date(now - 60_000), proposalNoticeStatus: 'sent',
      proposalNoticeKey: oldKey, proposalNoticeRecipientHash: recipientHash(oldEmail),
    }));

    await sweep();

    const proposal = records.get('application_concierge_services/service/proposals/new-job');
    expect(deliveries).toHaveLength(0);
    expect(proposal).toMatchObject({ proposalNoticeStatus: 'undeliverable', proposalNoticeFailureReason: 'complained' });
    expect(proposal.proposalNoticeSentAt).toBeUndefined();
    expect(serviceWithRuntime('application_concierge_services/service').pendingProposalNotice).toBeUndefined();
  });
  it('rechecks acceptability before retrying a failed announcement', async () => {
    records.set('application_concierge_services/service', active({ matchingCompletedAt: now,
      pendingProposalNotice: { key: 'new_proposals_retry_stale', proposalIds: ['new-job'] } }));
    records.set('application_concierge_services/service/proposals/new-job', eligibleProposal({
      eligibilityFactsDependency: { languages: true, answers: false }, eligibilityLanguagesRevision: 0,
    }));
    const failedNotice = vi.fn(async () => ({ ok: false, reason: 'provider_failed' }));
    await sweep({ send: failedNotice });
    expect(failedNotice).toHaveBeenCalledTimes(1);
    expect(serviceWithRuntime('application_concierge_services/service').pendingProposalNotice).toBeTruthy();

    await ref('application_concierge_services/service').set({ eligibilityLanguagesRevision: 1 });
    await sweep({ send: failedNotice });

    expect(failedNotice).toHaveBeenCalledTimes(1);
    expect(serviceWithRuntime('application_concierge_services/service').pendingProposalNotice).toBeUndefined();
  });
  it('revalidates every proposal inside the announcement claim before building the email', async () => {
    records.set('application_concierge_services/service', active({ matchingCompletedAt: now,
      pendingProposalNotice: { key: 'new_proposals_race', proposalIds: ['still-eligible', 'stale-at-claim'] } }));
    records.set('application_concierge_services/service/proposals/still-eligible', eligibleProposal());
    records.set('application_concierge_services/service/proposals/stale-at-claim', eligibleProposal());
    const build = vi.fn(async (buildMessage: any, current: any, options: any) => buildMessage(current, options));
    const claimNotice = vi.fn(async ({ recordRef, eligible, build: buildMessage }: any) => {
      await ref('application_concierge_services/service/proposals/stale-at-claim').set({ eligibilityStatus: 'unverified' });
      const current = (await recordRef.get()).data();
      const transaction = { get: (document: any) => document.get() };
      if (!await eligible(current, transaction)) return { ok: false, reason: 'ineligible' };
      await build(buildMessage, current, {});
      return { ok: true };
    });

    await sweep({ enqueueOnly: true, send: claimNotice });

    expect(claimNotice).toHaveBeenCalledTimes(1);
    expect(build).not.toHaveBeenCalled();
    expect(serviceWithRuntime('application_concierge_services/service').pendingProposalNotice?.proposalIds)
      .toEqual(['still-eligible']);
  });
  it('sends the current daily renewal once, respects opt-out and stops after payment or deadline', async () => {
    records.set('application_concierge_services/service', active({ expiresAt: now - DAY }));
    await sweep(); await sweep();
    expect(deliveries).toEqual(['renewal_day_1']);
    expect(trackingTargets[0]).toEqual({ key: 'renewal_day_1', trackingTarget: { kind: 'application-concierge', id: 'service' } });
    records.set('users/candidate', { applicationConciergePaymentReminder: { optedOut: true } });
    await sweep({ nowMs: now + DAY });
    expect(deliveries).toHaveLength(1);
    records.delete('users/candidate');
    await ref('application_concierge_services/service').set({ renewedByServiceId: 'renewal' });
    await sweep({ nowMs: now + DAY });
    expect(deliveries).toHaveLength(1);
    await ref('application_concierge_services/service').set({ renewedByServiceId: null });
    await sweep({ nowMs: now + 2 * DAY });
    expect(deliveries).toHaveLength(1);
  });
  it('does not send a renewal reminder outside the Remote Config rollout', async () => {
    records.set('application_concierge_services/service', active({ expiresAt: now - DAY }));
    renewalRollout.isEnabledFor.mockResolvedValue(false);
    await sweep();
    expect(renewalRollout.isEnabledFor).toHaveBeenCalledWith('candidate');
    expect(deliveries).toEqual([]);
  });
  it('delivers exactly the three daily reminder stages and none at the 72-hour deadline', async () => {
    records.set('application_concierge_services/service', active({ expiresAt: now }));
    for (const offset of [0, 0, DAY, DAY, 2 * DAY, 2 * DAY, 3 * DAY]) await sweep({ nowMs: now + offset });
    expect(deliveries).toEqual(['renewal_day_0', 'renewal_day_1', 'renewal_day_2']);
    expect(match).not.toHaveBeenCalled();
  });
  it.each([
    ['it', 'circa il 25%', '72 ore'],
    ['en', 'about 25%', '72 hours'],
    ['de', 'rund 25 %', '72 Stunden'],
    ['fr', 'environ 25 %', '72 heures'],
  ])('renders the fixed deadline, 25% savings hook, branded layout and opt-out in %s', (locale, savingsHook, offerWindow) => {
    const email = buildConciergeRenewalEmail(active({ expiresAt: now, locale }), 'service', { nowMs: now, unsubscribeUrl: 'https://example.test/unsubscribe/' });
    expect(email.html).toContain('https://example.test/unsubscribe/');
    expect(email.text).toMatch(/29[,.]99/);
    expect(email.text).toContain(savingsHook);
    expect(email.text).toContain(offerWindow);
    expect(email.html).toContain(savingsHook);
    expect(email.html).toContain('application_concierge_renewal=1');
    expect(email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const finalReminder = buildConciergeRenewalEmail(active({ expiresAt: now, locale }), 'service', { nowMs: now + 2 * DAY, unsubscribeUrl: 'https://example.test/unsubscribe/' });
    expect(finalReminder.subject).toMatch(/25\s?%/);
    expect(() => buildConciergeRenewalEmail(active({ expiresAt: now - 3 * DAY }), 'service', { nowMs: now, unsubscribeUrl: 'https://example.test/unsubscribe/' })).toThrow('concierge_renewal_offer_expired');
  });
  it.each([
    ['it', 'di nuovo disponibile'],
    ['en', 'available again'],
    ['de', 'wieder verfügbar'],
    ['fr', 'de nouveau disponible'],
  ])('announces a reactivated proposal as available again in %s', (locale, phrase) => {
    const email = buildConciergeNewJobsEmail(active({ locale }), 'service', [
      { jobTitle: 'Example', companyName: 'Example SA', reactivatedAt: new Date(now) },
    ]);
    expect(`${email.subject}\n${email.text}`).toContain(phrase);
    expect(email.subject.toLowerCase()).not.toContain('new opportunity');
    expect(email.text).toMatch(/12[- ]hour|12 ore|12 Stunden|12 heures/);
  });
});

const WITHDRAWAL_NOW = now;
const WITHDRAWAL_ORDER_ID = 'order_withdraw_refresh_test';
const WITHDRAWAL_SERVICE_ID = 'service_withdraw_refresh_test';
const WITHDRAWAL_ORDER_PATH = `assisted_applications/${WITHDRAWAL_ORDER_ID}`;
const WITHDRAWAL_SERVICE_PATH = `application_concierge_services/${WITHDRAWAL_SERVICE_ID}`;

function withdrawalRefreshFixture(servicePatch: Record<string, any> = {}) {
  return createMemoryFirestore({
    [WITHDRAWAL_ORDER_PATH]: {
      billingMode: 'application_concierge', paymentStatus: 'paid', userId: 'candidate_refresh_test',
      parentServiceId: WITHDRAWAL_SERVICE_ID, parentProposalId: 'proposal_withdrawn', submissionStatus: 'in_progress',
    },
    [`${WITHDRAWAL_ORDER_PATH}/automation/flow`]: { state: 'submitting', round: 1, dispatch: { mode: 'submit', round: 1 } },
    [`${WITHDRAWAL_ORDER_PATH}/ai_drafts/current`]: { status: 'ready', round: 1 },
    [WITHDRAWAL_SERVICE_PATH]: {
      userId: 'candidate_refresh_test', paymentStatus: 'paid', serviceStatus: 'active',
      expiresAt: new Date(WITHDRAWAL_NOW + 30 * DAY), cvStorageKey: 'private/cv.pdf', consentedAt: WITHDRAWAL_NOW - DAY,
      acceptedPositionsCount: 4, maxPositions: 10, ...servicePatch,
    },
    [`${WITHDRAWAL_SERVICE_PATH}/proposals/proposal_withdrawn`]: { status: 'accepted', childApplicationId: WITHDRAWAL_ORDER_ID },
    [`${WITHDRAWAL_SERVICE_PATH}/proposals/old-proposed`]: { status: 'proposed', eligibilityStatus: 'compatible' },
  });
}

async function realWithdrawal(servicePatch: Record<string, any> = {}) {
  const store = withdrawalRefreshFixture(servicePatch);
  const before = structuredClone(store.read(WITHDRAWAL_SERVICE_PATH));
  await withdrawAssistedApplication({ db: store.db, orderId: WITHDRAWAL_ORDER_ID, round: 1, withdrawalReason: 'La posizione non fa per me', nowMs: WITHDRAWAL_NOW });
  const after = structuredClone(store.read(WITHDRAWAL_SERVICE_PATH));
  return { store, before, after, requestId: after.proposalRefreshRequestId };
}

function refreshStubs() {
  const match = vi.fn(async ({ db, serviceId }: any) => {
    const ref = db.collection('application_concierge_services').doc(serviceId);
    await ref.collection('proposals').doc('new-compatible').set(eligibleProposal({ eligibilityFactsRevision: 0 }));
    await ref.collection('proposals').doc('new-unverified').set({ status: 'proposed', eligibilityStatus: 'unverified' });
    await ref.collection('proposals').doc('new-declined').set({ status: 'declined', eligibilityStatus: 'compatible' });
    return { status: 'complete' };
  });
  const notices: Array<{ key: string; proposalIds: string[] }> = [];
  const send = vi.fn(async ({ recordRef, key, eligible }: any) => {
    const [parentSnapshot, runtimeSnapshot] = await Promise.all([
      recordRef.get(), recordRef.collection('runtime').doc('matching').get(),
    ]);
    const current = mergeConciergeMatchingRuntime(parentSnapshot.data() || {}, runtimeSnapshot.data() || null);
    if (eligible && !(await eligible(current, { get: (document: any) => document.get() }))) return { ok: false, reason: 'ineligible' };
    notices.push({ key, proposalIds: [...(current.pendingProposalNotice?.proposalIds || [])] });
    return { ok: true };
  });
  return { match, send, notices };
}

describe('candidate withdrawal → trigger → idempotent replenishment worker', () => {
  it('routes a real withdrawal marker to the shared worker and notifies only new compatible proposals', async () => {
    const event = await realWithdrawal();
    expect(event.after).toMatchObject({ acceptedPositionsCount: 3, proposalRefreshRequestedBy: 'candidate_withdrawal' });
    expect(event.after.expiresAt).toEqual(event.before.expiresAt);
    expect(isFreshConciergeProposalRefreshRequest(event.before, event.after)).toBe(true);
    expect(readFileSync(new URL('../functions/index.js', import.meta.url), 'utf8'))
      .toContain('isFreshConciergeProposalRefreshRequest(before, data)');

    const { match, send, notices } = refreshStubs();
    const result = await refresh({
      db: event.store.db, serviceId: WITHDRAWAL_SERVICE_ID, requestId: event.requestId, nowMs: WITHDRAWAL_NOW, match, send,
    });

    expect(result).toMatchObject({ refreshed: 1, newJobEmails: 1 });
    expect(match).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(1);
    expect(notices[0].proposalIds).toEqual(['new-compatible']);
    expect(event.store.read(`${WITHDRAWAL_SERVICE_PATH}/runtime/matching`).proposalRefreshCompletedRequestId).toBe(event.requestId);
  });

  it('rejects a stale trigger event and a worker request with the wrong id', async () => {
    const stale = await realWithdrawal({
      proposalRefreshRequestId: `withdraw-${WITHDRAWAL_ORDER_ID}`,
      proposalRefreshRequestedBy: 'candidate_withdrawal',
    });
    expect(isFreshConciergeProposalRefreshRequest(stale.before, stale.after)).toBe(false);

    const fresh = await realWithdrawal();
    const { match, send } = refreshStubs();
    const result = await refresh({
      db: fresh.store.db, serviceId: WITHDRAWAL_SERVICE_ID, requestId: 'withdraw-wrong-request', nowMs: WITHDRAWAL_NOW, match, send,
    });
    expect(result).toEqual({ refreshed: 0, newJobEmails: 0 });
    expect(match).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('claims a duplicated trigger delivery once and does not repeat the notice', async () => {
    const event = await realWithdrawal();
    const { match, send, notices } = refreshStubs();
    const options = { db: event.store.db, serviceId: WITHDRAWAL_SERVICE_ID, requestId: event.requestId, nowMs: WITHDRAWAL_NOW, match, send };
    await refresh(options);
    await refresh(options);
    expect(match).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(notices).toHaveLength(1);
  });

  it.each([
    ['refund', { paymentStatus: 'refunded' }],
    ['inactive', { serviceStatus: 'expired' }],
    ['expired', { expiresAt: new Date(WITHDRAWAL_NOW) }],
    ['cap10', { acceptedPositionsCount: 10 }],
  ])('does not refresh after the worker gate closes: %s', async (_name, patch) => {
    const event = await realWithdrawal();
    await event.store.db.collection('application_concierge_services').doc(WITHDRAWAL_SERVICE_ID).set(patch, { merge: true });
    const { match, send } = refreshStubs();
    const result = await refresh({
      db: event.store.db, serviceId: WITHDRAWAL_SERVICE_ID, requestId: event.requestId, nowMs: WITHDRAWAL_NOW, match, send,
    });
    expect(result).toEqual({ refreshed: 0, newJobEmails: 0 });
    expect(match).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('notifies once when a retracted legacy proposal becomes verified and proposed again', async () => {
    const store = withdrawalRefreshFixture({ proposalRefreshRequestId: 'legacy-recovery-request' });
    const recoveredPath = `${WITHDRAWAL_SERVICE_PATH}/proposals/legacy-recovered`;
    await store.db.collection('application_concierge_services').doc(WITHDRAWAL_SERVICE_ID)
      .collection('proposals').doc('legacy-recovered').set({ status: 'retracted', eligibilityStatus: 'unverified' });
    const match = vi.fn(async ({ db }: any) => {
      const proposalRef = db.collection('application_concierge_services').doc(WITHDRAWAL_SERVICE_ID)
        .collection('proposals').doc('legacy-recovered');
      const existing = (await proposalRef.get()).data() || {};
      await proposalRef.set(eligibleProposal({ ...existing, status: 'proposed', eligibilityStatus: 'compatible',
        ...(existing.status === 'retracted' ? { reactivatedAt: new Date(WITHDRAWAL_NOW) } : {}) }), { merge: true });
      return { status: 'complete' };
    });
    const { send, notices } = refreshStubs();

    const first = await refresh({ db: store.db, serviceId: WITHDRAWAL_SERVICE_ID, requestId: 'legacy-recovery-request', nowMs: WITHDRAWAL_NOW, match, send });
    const second = await refresh({ db: store.db, serviceId: WITHDRAWAL_SERVICE_ID, requestId: 'legacy-recovery-request', nowMs: WITHDRAWAL_NOW, match, send });

    expect(first).toMatchObject({ refreshed: 1, newJobEmails: 1 });
    expect(second).toEqual({ refreshed: 0, newJobEmails: 0 });
    expect(notices).toHaveLength(1);
    expect(notices[0].proposalIds).toContain('legacy-recovered');
    expect(store.read(recoveredPath)).toMatchObject({ status: 'proposed', eligibilityStatus: 'compatible' });
  });
});
