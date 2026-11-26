import { describe, expect, it } from 'vitest';
import { persistNewsletterInvocation } from '../scripts/send-newsletter.mjs';

function firestore() {
  const documents = new Map<string, Record<string, unknown>>();
  let revision = 0;
  const db = {
    collection: (name: string) => ({ doc: (id: string) => `${name}/${id}` }),
    async runTransaction(callback: (transaction: unknown) => Promise<void>) {
      for (;;) {
        const startedAt = revision;
        const snapshot = new Map(documents);
        const writes = new Map<string, Record<string, unknown>>();
        await callback({
          async get(ref: string) {
            if (writes.size) throw new Error('Reads must precede writes');
            return { exists: snapshot.has(ref), data: () => snapshot.get(ref) };
          },
          create(ref: string, value: Record<string, unknown>) {
            if (snapshot.has(ref)) throw new Error('Document already exists');
            writes.set(ref, value);
          },
          set(ref: string, value: Record<string, unknown>) {
            writes.set(ref, value);
          },
        });
        if (startedAt !== revision) continue;
        for (const [ref, value] of writes) documents.set(ref, value);
        if (writes.size) revision++;
        return;
      }
    },
  };
  return { db, documents };
}

const logPath = (id: string) => `newsletter_subscribers/_meta_/campaign_logs/${id}`;
const dailyPath = (day: string) => `newsletter_daily_kpi/${day}`;
const log = (sentAt: Date, recipientCount: number, status = 'sent') => ({
  sentAt, recipientCount, status, subject: 'Native subject', version: 'v2-ai',
});

describe('newsletter daily KPI transaction', () => {
  it('uses the native log instant at Rome midnight and writes only aggregate evidence', async () => {
    const { db, documents } = firestore();
    // July tests the summer offset: Rome midnight is 22:00 UTC.
    const year = new Date().getUTCFullYear();
    const midnight = new Date(Date.UTC(year, 6, 1, 22));
    const beforeDay = `${year}-07-01`;
    const afterDay = `${year}-07-02`;
    const before = log(new Date(midnight.getTime() - 1), 2);
    const after = log(midnight, 1);
    await persistNewsletterInvocation(db, logPath('initial'), before, 3);
    await persistNewsletterInvocation(db, logPath('resume'), after, 0);

    expect(documents.get(logPath('initial'))).toEqual({ ...before, quarantinedThisRun: 3 });
    expect(documents.get(dailyPath(beforeDay))).toEqual({
      schemaVersion: 1,
      day: beforeDay,
      timeZone: 'Europe/Rome',
      coverage: 'logged_invocations_only',
      confirmedRecipientCount: 2,
      unresolvedAcknowledgementCount: 3,
      sentInvocations: 1,
      failedInvocations: 0,
      unknownInvocations: 0,
      throughAt: before.sentAt,
    });
    expect(documents.get(dailyPath(afterDay))).toMatchObject({
      confirmedRecipientCount: 1,
      throughAt: after.sentAt,
    });
    expect(documents.has(dailyPath(`${year}-07-03`))).toBe(false);
  });

  it('merges concurrent logs, counts each invocation once and keeps the latest timestamp', async () => {
    const { db, documents } = firestore();
    const today = new Date();
    today.setUTCHours(12, 0, 0, 0);
    const latest = log(today, 0, 'unknown');
    const earlier = log(new Date(latest.sentAt.getTime() - 1000), 4);
    await Promise.all([
      persistNewsletterInvocation(db, logPath('unknown'), latest, 2),
      persistNewsletterInvocation(db, logPath('sent'), earlier, 1),
      persistNewsletterInvocation(db, logPath('sent'), earlier, 1),
      persistNewsletterInvocation(db, logPath('failed'), { ...earlier, status: 'failed', recipientCount: 0 }, 0),
    ]);
    expect(documents.size).toBe(4);
    expect(documents.get(dailyPath(today.toISOString().slice(0, 10)))).toMatchObject({
      confirmedRecipientCount: 4,
      unresolvedAcknowledgementCount: 3,
      sentInvocations: 1,
      failedInvocations: 1,
      unknownInvocations: 1,
      throughAt: latest.sentAt,
    });
  });

  it('rejects invalid inputs, stored counters and overflow without a partial write', async () => {
    const { db, documents } = firestore();
    const sentAt = new Date();
    sentAt.setUTCHours(12, 0, 0, 0);
    const daily = dailyPath(sentAt.toISOString().slice(0, 10));
    const next = logPath('next');
    await expect(persistNewsletterInvocation(db, next, log(sentAt, 1), -1)).rejects.toThrow('Invalid newsletter KPI counter');
    await expect(persistNewsletterInvocation(db, next, log(sentAt, 1, 'constructor'), 0)).rejects.toThrow('Invalid newsletter invocation status');
    expect(documents.size).toBe(0);

    await persistNewsletterInvocation(db, logPath('first'), log(sentAt, Number.MAX_SAFE_INTEGER), 0);
    const previous = documents.get(daily)!;
    await expect(persistNewsletterInvocation(db, next, log(sentAt, 1), 0)).rejects.toThrow('Invalid newsletter KPI counter');
    expect(documents.get(daily)).toEqual(previous);
    const corrupt = { ...previous, unknownInvocations: 0.5 };
    documents.set(daily, corrupt);
    await expect(persistNewsletterInvocation(db, next, log(sentAt, 0, 'failed'), 0)).rejects.toThrow('Invalid newsletter KPI counter');
    expect(documents.get(daily)).toEqual(corrupt);
    expect(documents.has(next)).toBe(false);
  });
});
