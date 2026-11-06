import { afterEach, describe, expect, it, vi } from 'vitest';

const send = vi.hoisted(() => vi.fn());
vi.mock('../scripts/lib/email-cascade.mjs', () => ({ sendEmailCascade: send, BULK_PROVIDER_MIN_INTERVAL_MS: {} }));
import { __setFirestoreAdminForTest, sendBatch, enqueueFailedEmails } from '../scripts/send-job-alerts.mjs';
import { buildJobAlertFunnel } from '../scripts/lib/job-alert-funnel.mjs';

afterEach(() => { vi.clearAllMocks(); __setFirestoreAdminForTest(null); });

describe('discovery provider outcomes', () => {
  it('does not finalize a transport exception as a definite rejection', async () => {
    const persist = vi.fn();
    __setFirestoreAdminForTest({ runTransaction: persist });
    send.mockRejectedValueOnce(new Error('transport timeout'));
    await expect(sendBatch([{ to: 'discovery@example.test', alertId: 'empty', subject: 'Popular', html: '<p>Popular</p>',
      discoveryMode: true, discoveryClaim: { attemptId: 'claim', deliveryId: 'stable' } }]))
      .rejects.toThrow('transport timeout');
    expect(persist).not.toHaveBeenCalled();
  });

  it('keeps successful targeted bookkeeping available when discovery failure persistence throws', async () => {
    const set = vi.fn(async () => {});
    const ref = { set, collection: () => ({ doc: () => ({ set }) }) };
    __setFirestoreAdminForTest({ collection: () => ({ doc: () => ref }), runTransaction: async () => { throw new Error('unavailable'); } });
    send.mockImplementation(async (items) => ({ sent: [{ ...items[0], provider: 'resend', messageId: 'accepted' }],
      failed: [{ ...items[1], ambiguousDelivery: false, error: 'explicit rejection' }], ambiguous: [] }));
    const result = await sendBatch([
      { to: 'targeted@example.test', alertId: 'targeted', subject: 'Jobs', html: '<p>Jobs</p>' },
      { to: 'discovery@example.test', alertId: 'empty', subject: 'Popular', html: '<p>Popular</p>', discoveryMode: true,
        discoveryClaim: { attemptId: 'claim', deliveryId: 'stable' } },
    ]);
    expect(result.sent).toBe(1);
    expect(result.confirmedDeliveryKeys.has('targeted@example.test\0targeted')).toBe(true);
    expect(result.failed).toBe(1);
  });

  it('quarantines an unidentifiable discovery and does not put it into the historical retry queue', async () => {
    const set = vi.fn(async () => {});
    const ref = { set, collection: () => ({ doc: () => ref }) };
    __setFirestoreAdminForTest({ collection: () => ({ doc: () => ref }), runTransaction: async () => {} });
    send.mockImplementation(async (items) => {
      const unknown = { ...items[0], provider: 'resend' };
      return { sent: [unknown], failed: [], ambiguous: [unknown] };
    });
    const result = await sendBatch([{ to: 'discovery@example.test', alertId: 'empty', subject: 'Popular', html: '<p>Popular</p>',
      discoveryMode: true, discoveryClaim: { attemptId: 'claim', deliveryId: 'stable' } }]);
    expect(result).toMatchObject({ sent: 0, failed: 1, discoveryUnknown: 1, ambiguous: 0 });
    const db = { collection: vi.fn(() => { throw new Error('must not enqueue'); }) };
    await enqueueFailedEmails(db, result.failedItems);
    expect(db.collection).not.toHaveBeenCalled();
    const funnel = buildJobAlertFunnel({ archive: 1, base: 1, eligible: 1, planned: 1, failed: 1, discoveryUnknown: 1 });
    expect(funnel.balanced).toBe(true);
    expect(funnel.rows.find((row: { label: string }) => row.label.includes('discovery con esito'))).toMatchObject({ count: 1 });
  });
});
