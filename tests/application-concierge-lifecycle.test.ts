import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { APPLICATION_CONCIERGE_MATCHING_VERSION } from '../functions/src/applicationConciergeConstants.js';
import { withdrawAssistedApplication } from '../functions/src/assistedApplicationWithdrawal.js';
import { conciergeRefreshDue } from '../functions/src/applicationConciergeLifecyclePolicy.js';
import { createMemoryFirestore } from './helpers/memoryFirestore';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getNewsletterSecrets: vi.fn(async () => ({ newsletterSecret: 'test-only-secret' })), getRemoteConfigValue: vi.fn(async () => '') }));
vi.mock('../functions/src/applicationConciergeMatching.js', () => ({ runApplicationConciergeMatching: vi.fn() }));
vi.mock('../functions/src/assistedApplicationNotifications.js', () => ({ sendOrderNotification: vi.fn() }));
vi.mock('../functions/src/applicationConciergeRenewalMaterials.js', () => ({ inheritConciergeRenewalMaterials: vi.fn(async () => ({ copied: false })) }));
vi.mock('../functions/src/applicationConciergePaymentReminders.js', () => ({ paymentReminderUrl: (uid: string) => `https://example.test/unsubscribe/?uid=${uid}` }));
const { isFreshConciergeProposalRefreshRequest, runConciergeLifecycleSweep, runConciergeProposalRefresh } = await import('../functions/src/applicationConciergeLifecycle.js');
const { buildConciergeRenewalEmail } = await import('../functions/src/applicationConciergeLifecycleEmails.js');

const DAY = 24 * 60 * 60 * 1000;
const now = Date.now();
let records: Map<string, any>;
let queue: Promise<any>;
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
const passThroughJobCards = async (proposals: any[]) => proposals;
const send = vi.fn(async ({ recordRef, key, build, eligible }: any) => db.runTransaction(async (transaction: any) => {
  const current = (await transaction.get(recordRef)).data();
  if (eligible && !await eligible(current, transaction)) return { ok: false, reason: 'ineligible' };
  if (current.notifications?.[key]) return { ok: false, reason: 'already_sent' };
  await build(current, {});
  deliveries.push(key);
  await transaction.set(recordRef, { notifications: { ...current.notifications, [key]: { status: 'sent' } } });
  return { ok: true };
}));
const match = vi.fn(async ({ serviceId }: any) => {
  await ref(`application_concierge_services/${serviceId}/proposals/new-job`).set({ status: 'proposed', eligibilityStatus: 'compatible', jobTitle: 'Commerciale', companyName: 'Example' });
  await ref(`application_concierge_services/${serviceId}`).set({ matchingCompletedAt: new Date(now), matchingStatus: 'complete', matchingVersion: APPLICATION_CONCIERGE_MATCHING_VERSION });
  return { status: 'complete' };
});
const sweep = (options = {}) => runConciergeLifecycleSweep({ db, nowMs: now, match, send, enrichJobCards: passThroughJobCards, unsubscribeSecret: 'test-only-secret', enqueueOnly: false, ...options });
const refresh = (options: any) => runConciergeProposalRefresh({ db, nowMs: now, match, send, enrichJobCards: passThroughJobCards, ...options });
beforeEach(() => { records = new Map(); queue = Promise.resolve(); deliveries.length = 0; vi.clearAllMocks(); });

describe('concierge refresh and notification lifecycle', () => {
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
    expect(conciergeRefreshDue({ ...service, matchingCompletedAt: now - 30 * 60 * 1000 }, now)).toBe(false);
    expect(conciergeRefreshDue({ ...service, acceptedPositionsCount: 10 }, now)).toBe(false);
    expect(conciergeRefreshDue({ ...service, expiresAt: now - 1 }, now)).toBe(false);
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
    records.set('application_concierge_services/service/proposals/card-proposal', proposal);
    const companyLogo = 'https://cdn.frontaliereticino.ch/images/brands/stadt-zuerich.png';
    const enrichJobCards = vi.fn(async (items: any[]) => items.map((item) => ({ ...item, companyLogo })));
    const messages: any[] = [];
    const buildAndSend = vi.fn(async ({ recordRef, build, eligible }: any) => {
      const current = (await recordRef.get()).data();
      if (eligible && !await eligible(current)) return { ok: false, reason: 'ineligible' };
      messages.push(await build(current, {}));
      return { ok: true };
    });

    const result = await sweep({ enqueueOnly: true, send: buildAndSend, enrichJobCards });

    expect(result.newJobEmails).toBe(1);
    expect(enrichJobCards).toHaveBeenCalledWith([proposal]);
    expect(messages).toHaveLength(1);
    expect(messages[0].html).toContain(`<img src="${companyLogo}"`);
  });
  it.each([{ acceptedPositionsCount: 10 }, { expiresAt: now }])('does not refresh beyond the cap or expiry: %j', async patch => {
    records.set('application_concierge_services/service', active(patch));
    await sweep();
    expect(match).not.toHaveBeenCalled();
    expect(deliveries.filter(key => key.startsWith('new_proposals_'))).toHaveLength(0);
  });
  it('does not notify jobs that were already present before the refresh', async () => {
    records.set('application_concierge_services/service', active());
    records.set('application_concierge_services/service/proposals/new-job', { status: 'proposed' });
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
    expect(records.get('application_concierge_services/service').proposalRefreshCompletedRequestId).toBe('refresh-request');
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
    records.set('application_concierge_services/service/proposals/new-job', { status: 'proposed', jobTitle: 'Example', companyName: 'Example' });
    const failure = vi.fn(async () => ({ ok: false, reason: 'provider_failed' }));
    await sweep({ send: failure });
    expect(records.get('application_concierge_services/service').pendingProposalNotice).toBeTruthy();
    await sweep();
    expect(match).not.toHaveBeenCalled();
    expect(deliveries).toEqual(['new_proposals_retry']);
    expect(records.get('application_concierge_services/service').pendingProposalNotice).toBeUndefined();
  });
  it('sends the current daily renewal once, respects opt-out and stops after payment or deadline', async () => {
    records.set('application_concierge_services/service', active({ expiresAt: now - DAY }));
    await sweep(); await sweep();
    expect(deliveries).toEqual(['renewal_day_1']);
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
  it('delivers exactly the three daily reminder stages and none at the 72-hour deadline', async () => {
    records.set('application_concierge_services/service', active({ expiresAt: now }));
    for (const offset of [0, 0, DAY, DAY, 2 * DAY, 2 * DAY, 3 * DAY]) await sweep({ nowMs: now + offset });
    expect(deliveries).toEqual(['renewal_day_0', 'renewal_day_1', 'renewal_day_2']);
    expect(match).not.toHaveBeenCalled();
  });
  it.each(['it', 'en', 'de', 'fr'])('renders the fixed deadline, branded layout and opt-out in %s', locale => {
    const email = buildConciergeRenewalEmail(active({ expiresAt: now, locale }), 'service', { nowMs: now, unsubscribeUrl: 'https://example.test/unsubscribe/' });
    expect(email.html).toContain('https://example.test/unsubscribe/');
    expect(email.text).toMatch(/29[,.]99/);
    expect(email.html).toContain('application_concierge_renewal=1');
    expect(email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(() => buildConciergeRenewalEmail(active({ expiresAt: now - 3 * DAY }), 'service', { nowMs: now, unsubscribeUrl: 'https://example.test/unsubscribe/' })).toThrow('concierge_renewal_offer_expired');
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
  await withdrawAssistedApplication({ db: store.db, orderId: WITHDRAWAL_ORDER_ID, round: 1, nowMs: WITHDRAWAL_NOW });
  const after = structuredClone(store.read(WITHDRAWAL_SERVICE_PATH));
  return { store, before, after, requestId: after.proposalRefreshRequestId };
}

function refreshStubs() {
  const match = vi.fn(async ({ db, serviceId }: any) => {
    const ref = db.collection('application_concierge_services').doc(serviceId);
    await ref.collection('proposals').doc('new-compatible').set({ status: 'proposed', eligibilityStatus: 'compatible' });
    await ref.collection('proposals').doc('new-unverified').set({ status: 'proposed', eligibilityStatus: 'unverified' });
    await ref.collection('proposals').doc('new-declined').set({ status: 'declined', eligibilityStatus: 'compatible' });
    return { status: 'complete' };
  });
  const notices: Array<{ key: string; proposalIds: string[] }> = [];
  const send = vi.fn(async ({ recordRef, key, eligible }: any) => {
    const current = (await recordRef.get()).data() || {};
    if (eligible && !(await eligible(current))) return { ok: false, reason: 'ineligible' };
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
    expect(event.store.read(WITHDRAWAL_SERVICE_PATH).proposalRefreshCompletedRequestId).toBe(event.requestId);
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
});
