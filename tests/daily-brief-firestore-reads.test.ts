import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// @ts-expect-error — .mjs module without type declarations
import { fetchBriefClicks } from '@/scripts/send-daily-brief.mjs';

const firestoreIndexes = JSON.parse(
  readFileSync(path.resolve(__dirname, '..', 'firestore.indexes.json'), 'utf8'),
) as {
  indexes: Array<{
    collectionGroup: string;
    queryScope: string;
    fields: Array<{ fieldPath: string; order: string }>;
  }>;
};

function fakeDb(docs: Array<{ data: () => Record<string, unknown> }>) {
  const whereCalls: Array<[string, string, unknown]> = [];
  const query = {
    where(field: string, op: string, value: unknown) {
      whereCalls.push([field, op, value]);
      return query;
    },
    async get() {
      return { docs };
    },
  };

  return {
    db: {
      collectionGroup(name: string) {
        expect(name).toBe('campaign_deliveries');
        return query;
      },
    },
    whereCalls,
  };
}

describe('daily brief click attribution query', () => {
  it('declares the collection-group composite in the range-filter order', () => {
    // Firestore multiple-range queries require the composite fields in the order
    // requested by FAILED_PRECONDITION: campaign_id first, then clicked_at.
    expect(firestoreIndexes.indexes).toContainEqual({
      collectionGroup: 'campaign_deliveries',
      queryScope: 'COLLECTION_GROUP',
      fields: [
        { fieldPath: 'campaign_id', order: 'ASCENDING' },
        { fieldPath: 'clicked_at', order: 'ASCENDING' },
      ],
    });
  });

  it('narrows the server query to daily-brief campaigns without changing attribution', async () => {
    const sinceMs = Date.parse('2026-10-01T00:00:00.000Z');
    const fake = fakeDb([
      {
        data: () => ({
          email: 'brief-recipient',
          campaign_id: 'daily-brief-2026-10-17',
          clicked_at: new Date(sinceMs + 1_000),
        }),
      },
      {
        data: () => ({
          email: 'brief-recipient',
          campaign_id: 'daily-brief-2026-10-18',
          clicked_at: new Date(sinceMs + 2_000),
        }),
      },
      {
        data: () => ({
          email: 'weekly-recipient',
          campaign_id: 'weekly-2026-W42',
          clicked_at: new Date(sinceMs + 3_000),
        }),
      },
    ]);

    const result = await fetchBriefClicks(fake.db, sinceMs);

    expect(fake.whereCalls[0][0]).toBe('clicked_at');
    expect(fake.whereCalls[0][1]).toBe('>=');
    expect((fake.whereCalls[0][2] as Date).getTime()).toBe(sinceMs);
    expect(fake.whereCalls.slice(1)).toEqual([
      ['campaign_id', '>=', 'daily-brief-'],
      ['campaign_id', '<', 'daily-brief.'],
    ]);
    expect(result.mode).toBe('brief-attributed');
    expect([...result.byEmail.entries()]).toEqual([
      ['brief-recipient', sinceMs + 2_000],
    ]);
  });
});
