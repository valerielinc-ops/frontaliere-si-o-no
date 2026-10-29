import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ getNewsletterSecrets: vi.fn(async () => ({ newsletterSecret: 'test-only-secret' })), getRemoteConfigValue: vi.fn(async () => '') }));
vi.mock('../functions/src/applicationConciergeMatching.js', () => ({ runApplicationConciergeMatching: vi.fn() }));
vi.mock('../functions/src/assistedApplicationNotifications.js', () => ({ sendOrderNotification: vi.fn() }));
vi.mock('../functions/src/applicationConciergeRenewalMaterials.js', () => ({ inheritConciergeRenewalMaterials: vi.fn(async () => ({ copied: false })) }));
vi.mock('../functions/src/applicationConciergePaymentReminders.js', () => ({ paymentReminderUrl: (uid: string) => `https://example.test/unsubscribe/?uid=${uid}` }));
const { runConciergeLifecycleSweep } = await import('../functions/src/applicationConciergeLifecycle.js');
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
    matchingCompletedAt: now - 3 * DAY, acceptedPositionsCount: 2, ...patch };
}
const deliveries: string[] = [];
const send = vi.fn(async ({ recordRef, key, build, eligible }: any) => db.runTransaction(async (transaction: any) => {
  const current = (await transaction.get(recordRef)).data();
  if (eligible && !await eligible(current, transaction)) return { ok: false, reason: 'ineligible' };
  if (current.notifications?.[key]) return { ok: false, reason: 'already_sent' };
  build(current, {});
  deliveries.push(key);
  await transaction.set(recordRef, { notifications: { ...current.notifications, [key]: { status: 'sent' } } });
  return { ok: true };
}));
const match = vi.fn(async ({ serviceId }: any) => {
  await ref(`application_concierge_services/${serviceId}/proposals/new-job`).set({ status: 'proposed', jobTitle: 'Commerciale', companyName: 'Example' });
  await ref(`application_concierge_services/${serviceId}`).set({ matchingCompletedAt: new Date(now), matchingStatus: 'complete' });
  return { status: 'complete' };
});
const sweep = (options = {}) => runConciergeLifecycleSweep({ db, nowMs: now, match, send, unsubscribeSecret: 'test-only-secret', enqueueOnly: false, ...options });
beforeEach(() => { records = new Map(); queue = Promise.resolve(); deliveries.length = 0; vi.clearAllMocks(); });

describe('concierge refresh and notification lifecycle', () => {
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
  it.each(['it', 'en', 'de', 'fr'])('renders the fixed deadline, branded layout and opt-out in %s', locale => {
    const email = buildConciergeRenewalEmail(active({ expiresAt: now, locale }), 'service', { nowMs: now, unsubscribeUrl: 'https://example.test/unsubscribe/' });
    expect(email.html).toContain('https://example.test/unsubscribe/');
    expect(email.text).toMatch(/29[,.]99/);
    expect(email.html).toContain('application_concierge_renewal=1');
    expect(email.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(() => buildConciergeRenewalEmail(active({ expiresAt: now - 3 * DAY }), 'service', { nowMs: now, unsubscribeUrl: 'https://example.test/unsubscribe/' })).toThrow('concierge_renewal_offer_expired');
  });
});
