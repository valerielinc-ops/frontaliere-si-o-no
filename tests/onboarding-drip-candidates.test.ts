import { describe, expect, it, vi } from 'vitest';
import { loadOnboardingDripCandidates } from '../scripts/lib/onboarding-drip-candidates.mjs';

type Filter = { field: string; operator: string; value: unknown };

function comparable(value: unknown): number | string | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') return value;
  return null;
}

function matches(actual: unknown, filter: Filter): boolean {
  const left = comparable(actual);
  const right = comparable(filter.value);
  if (left == null || right == null || typeof left !== typeof right) return false;
  switch (filter.operator) {
    case '==': return left === right;
    case '>=': return left >= right;
    case '<=': return left <= right;
    default: throw new Error(`unexpected operator ${filter.operator}`);
  }
}

function fixtureDb(rows: Array<{ id: string; data: Record<string, unknown> }>) {
  const queryCalls: Array<{ filters: Filter[]; pageSize: number }> = [];
  const docs = rows.map((row) => ({
    id: row.id,
    ref: { id: row.id, path: `newsletter_subscribers/${row.id}` },
    data: row.data,
  }));

  class Query {
    constructor(
      private filters: Filter[] = [],
      private orderField: string | null = null,
      private pageSize = Number.POSITIVE_INFINITY,
      private afterId: string | null = null,
    ) {}

    where(field: string, operator: string, value: unknown) {
      return new Query([...this.filters, { field, operator, value }], this.orderField, this.pageSize, this.afterId);
    }

    orderBy(field: string) {
      return new Query(this.filters, field, this.pageSize, this.afterId);
    }

    limit(value: number) {
      return new Query(this.filters, this.orderField, value, this.afterId);
    }

    startAfter(doc: { id: string }) {
      return new Query(this.filters, this.orderField, this.pageSize, doc.id);
    }

    async get() {
      queryCalls.push({ filters: this.filters, pageSize: this.pageSize });
      let found = docs.filter((doc) => this.filters.every((filter) => matches(doc.data[filter.field], filter)));
      if (this.orderField) {
        found = found.sort((a, b) => {
          const left = comparable(a.data[this.orderField!]);
          const right = comparable(b.data[this.orderField!]);
          return left == null || right == null || typeof left !== typeof right ? 0 : left < right ? -1 : left > right ? 1 : 0;
        });
      }
      if (this.afterId) {
        const afterIndex = found.findIndex((doc) => doc.id === this.afterId);
        found = found.slice(afterIndex + 1);
      }
      const page = found.slice(0, this.pageSize);
      return { docs: page, size: page.length, empty: page.length === 0 };
    }
  }

  const collection = {
    where: vi.fn((field: string, operator: string, value: unknown) => new Query().where(field, operator, value)),
    get: vi.fn(() => Promise.reject(new Error('unfiltered collection scan is forbidden'))),
  };
  return {
    db: { collection: vi.fn(() => collection) } as any,
    collection,
    queryCalls,
  };
}

describe('onboarding drip candidate reads', () => {
  it('bounds reads to due progress and recent enrollment queries, with cursor pages', async () => {
    const now = new Date('2026-11-08T12:00:00.000Z');
    const ago = (days: number) => new Date(now.getTime() - days * 86400000);
    const rows = [
      { id: 'due-0-a', data: { drip_last_step: 0, drip_started_at: ago(6) } },
      { id: 'due-0-b', data: { drip_last_step: 0, drip_started_at: ago(5) } },
      { id: 'due-0-c', data: { drip_last_step: 0, drip_started_at: ago(4) } },
      { id: 'due-1', data: { drip_last_step: 1, drip_started_at: ago(8) } },
      { id: 'upcoming', data: { drip_last_step: 2, drip_started_at: ago(10) } },
      { id: 'completed', data: { drip_last_step: 3, drip_started_at: ago(30) } },
      { id: 'fresh-timestamp', data: { confirmed_at: ago(1) } },
      { id: 'fresh-legacy-string', data: { confirmedAt: ago(2).toISOString() } },
      { id: 'stale', data: { confirmed_at: ago(5) } },
      { id: 'future', data: { confirmed_at: new Date(now.getTime() + 86400000) } },
      ...Array.from({ length: 1_000 }, (_, index) => ({
        id: `unrelated-${index}`,
        data: { status: 'confirmed', confirmed_at: ago(200) },
      })),
    ];
    const { db, collection, queryCalls } = fixtureDb(rows);

    const result = await loadOnboardingDripCandidates(db, { now, pageSize: 2 });

    expect(result.docs.map((doc: any) => doc.id).sort()).toEqual([
      'due-0-a', 'due-0-b', 'due-0-c', 'due-1', 'fresh-legacy-string', 'fresh-timestamp',
    ]);
    expect(result.queryCount).toBe(7);
    // Due step 0 reads three matching docs across two pages; the other six
    // queries each cost at least one read (9 billed reads for 7 queries).
    expect(result.reads).toBe(9);
    expect(queryCalls.every(({ pageSize }) => pageSize === 2)).toBe(true);
    expect(collection.get).not.toHaveBeenCalled();
    expect(db.collection).toHaveBeenCalledWith('newsletter_subscribers');
    expect(result.reads).toBeLessThan(rows.length / 50);
  });
});
