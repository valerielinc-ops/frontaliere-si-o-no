import { describe, expect, it, vi } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { DAY_MS, followupDueAt, scheduleFollowups } from '../functions/src/assistedApplicationFollowup.js';
const now = Date.now(); const id = 'synthetic-followup'; const base = `assisted_applications/${id}`;
const payload = { to: 'hr@example.test', subject: 'Synthetic application', messageId: '<synthetic@example.test>', sentAt: now, round: 1 };
function fixture(patch: any = {}) {
  return createMemoryFirestore({ [base]: { cvUploadedAt: now, ...patch }, [`${base}/automation/flow`]: { round: 1 } });
}
describe('one retained transaction schedules the existing follow-up cadence', () => {
  it('creates both index and sequence together and preserves an advanced sequence on replay', async () => {
    const f = fixture(); const transaction = vi.spyOn(f.db, 'runTransaction');
    await expect(scheduleFollowups(f.db, id, payload, now)).resolves.toBe(now + 7 * DAY_MS);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(f.read(base).followupDueAt).toBe(now + 7 * DAY_MS);
    f.docs.set(`${base}/automation/followup`, { ...f.read(`${base}/automation/followup`), sent: 1, dueAt: followupDueAt(now, 2), history: [{ event: 'sent', at: now + 7 * DAY_MS }] });
    f.read(base).followupDueAt = followupDueAt(now, 2);
    const previous = structuredClone(f.read(`${base}/automation/followup`));
    await expect(scheduleFollowups(f.db, id, payload, now + 8 * DAY_MS)).resolves.toBe(now + 14 * DAY_MS);
    expect(f.read(`${base}/automation/followup`)).toEqual(previous);
    expect(f.read(base).followupDueAt).toBe(now + 14 * DAY_MS);
  });
  it.each(['missing', 'expired', 'purging', 'purged', 'payload_purged', 'refund_pending', 'round_changed'])('writes neither document nor index for %s', async reason => {
    const f = fixture();
    if (reason === 'missing') f.docs.delete(base);
    if (reason === 'expired') f.read(base).cvUploadedAt = now - 90 * DAY_MS;
    if (reason === 'purging') f.read(base).retentionPurgingAt = now;
    if (reason === 'purged') f.read(base).retentionPurgedAt = now;
    if (reason === 'payload_purged') f.read(base).retentionPayloadPurgedAt = now;
    if (reason === 'refund_pending') f.read(base).refundStatus = 'pending';
    if (reason === 'round_changed') f.read(`${base}/automation/flow`).round = 2;
    await expect(scheduleFollowups(f.db, id, payload, now)).resolves.toBeNull();
    expect(f.read(`${base}/automation/followup`)).toBeUndefined(); expect(f.read(base)?.followupDueAt).toBeUndefined();
  });
  it.each(['read', 'material_conversion'])('rechecks the clock after %s crosses the deadline', async mode => {
    const f = fixture({ cvUploadedAt: now - 90 * DAY_MS + 1 }); let wall = now;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => wall); const original = f.db.runTransaction.bind(f.db);
    f.db.runTransaction = (callback: any) => original((tx: any) => callback({ ...tx, get: async (ref: any) => {
      const snapshot = await tx.get(ref);
      if (mode === 'material_conversion' && ref.path === base) return { ...snapshot, data: () => { const data = snapshot.data(); wall = now + 2; return data; } };
      if (mode === 'read' && ref.path.endsWith('/automation/followup')) wall = now + 2; return snapshot;
    } }));
    try {
      await expect(scheduleFollowups(f.db, id, payload, now)).resolves.toBeNull();
      expect(f.read(`${base}/automation/followup`)).toBeUndefined(); expect(f.read(base).followupDueAt).toBeUndefined();
    } finally { clock.mockRestore(); }
  });
  it('does not restore either field when the transaction retries after a purge', async () => {
    const f = fixture(); const original = f.db.runTransaction.bind(f.db); let first = true;
    f.db.runTransaction = (callback: any) => original(async (tx: any) => {
      if (first) {
        first = false; await callback({ ...tx, set: () => {} }); // Discard the contended attempt, as Firestore does.
        f.read(base).retentionPurgingAt = now;
      }
      return callback(tx);
    });
    await expect(scheduleFollowups(f.db, id, payload, now)).resolves.toBeNull();
    expect(f.read(`${base}/automation/followup`)).toBeUndefined(); expect(f.read(base).followupDueAt).toBeUndefined();
  });
});
