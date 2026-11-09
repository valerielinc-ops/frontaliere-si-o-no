import { describe, expect, it } from 'vitest';
import {
  loadConfirmationFollowupCandidates,
  planConfirmationFollowups,
} from '../scripts/lib/confirmation-followup-scan.mjs';

function fixtureCollection(rows: Array<{ id: string; status?: string }>) {
  const matches = (values?: string[]) => rows.filter((row) => values?.includes(String(row.status)));
  const collection = {
    where(field: string, operator: string, values: string[]) {
      expect(field).toBe('status');
      expect(operator).toBe('in');
      return {
        get: async () => ({
          docs: matches(values).map((row) => ({ id: row.id, data: () => row, ref: { id: row.id } })),
        }),
        count: () => ({ get: async () => ({ data: () => ({ count: matches(values).length }) }) }),
      };
    },
    count: () => ({ get: async () => ({ data: () => ({ count: rows.length }) }) }),
  };
  return collection as any;
}

describe('confirmation follow-up candidate scan', () => {
  it('reads only pending documents while preserving case-insensitive policy counts', async () => {
    const rows = [
      { id: 'one', status: 'pending' },
      { id: 'two', status: 'PENDING' },
      { id: 'old', status: 'Expired' },
      { id: 'confirmed', status: 'confirmed' },
      { id: 'legacy' },
    ];

    const result = await loadConfirmationFollowupCandidates(fixtureCollection(rows));

    expect(result.docs.map((doc: { id: string }) => doc.id).sort()).toEqual(['one', 'two']);
    expect(result.totalDocuments).toBe(5);
    expect(result.alreadyExpiredDocuments).toBe(1);
    expect(result.docs.length + result.alreadyExpiredDocuments).toBeLessThan(result.totalDocuments);
  });

  it('preserves every original plan bucket using the aggregate census', () => {
    const now = Date.UTC(2026, 10, 8, 12);
    const epochMs = Date.parse('2026-08-14T00:00:00.000Z');
    const plan = planConfirmationFollowups([
      { id: 'fresh', data: { status: 'pending', created_at: new Date(now - 60_000) } },
      { id: 'old', data: { status: 'PENDING', created_at: '2026-04-01T00:00:00.000Z' } },
    ], { now, epochMs, totalDocuments: 10, alreadyExpiredDocuments: 2 });

    expect(plan.total).toBe(10);
    expect(plan.send.map((item) => item.id)).toEqual(['fresh']);
    expect(plan.skipped).toMatchObject({ backlog: 1, 'already-expired': 2, 'not-pending': 6 });
    expect(plan.send.length + plan.expire.length
      + Object.values(plan.skipped).reduce((sum, value) => sum + value, 0)).toBe(10);
  });
});
