import { describe, expect, it, vi } from 'vitest';
import { loadSuppressionDecayScan } from '../scripts/lib/suppression-decay-scan.mjs';

type Filter = { field: string; operator: string; value: unknown };

function fixtureDb(rows: Array<{ id: string; data: Record<string, unknown> }>) {
  const reads: Array<{ filters: Filter[]; pageSize: number | null }> = [];
  const docs = rows.map((row) => ({
    id: row.id,
    ref: { id: row.id, path: `newsletter_subscribers/${row.id}` },
    data: () => row.data,
  }));

  class Query {
    constructor(
      private filters: Filter[] = [],
      private orderField: string | null = null,
      private pageSize: number | null = null,
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

    private filteredRows() {
      let found = docs.filter((doc) => this.filters.every((filter) => {
        const actual = doc.data()[filter.field];
        if (filter.operator === 'in') return (filter.value as unknown[]).includes(actual);
        if (filter.operator === '>=') return typeof actual === 'string' && actual >= String(filter.value);
        throw new Error(`unexpected operator ${filter.operator}`);
      }));
      if (this.orderField) {
        found = found.sort((a, b) => String(a.data()[this.orderField!]).localeCompare(String(b.data()[this.orderField!])));
      }
      if (this.afterId) found = found.slice(found.findIndex((doc) => doc.id === this.afterId) + 1);
      return found;
    }

    async get() {
      const found = this.filteredRows();
      const page = found.slice(0, this.pageSize ?? found.length);
      reads.push({ filters: this.filters, pageSize: this.pageSize });
      return { docs: page, size: page.length, empty: page.length === 0 };
    }

    count() {
      return {
        get: async () => {
          const count = this.filteredRows().length;
          return { data: () => ({ count }) };
        },
      };
    }
  }

  const collection = {
    where: vi.fn((field: string, operator: string, value: unknown) => new Query().where(field, operator, value)),
    count: vi.fn(() => new Query().count()),
    doc: vi.fn((id: string) => ({
      get: async () => ({ exists: id === '_meta_' && docs.some((doc) => doc.id === id) }),
    })),
    get: vi.fn(() => Promise.reject(new Error('full collection scan is forbidden'))),
  };

  return {
    db: { collection: vi.fn(() => collection) } as any,
    collection,
    reads,
  };
}

describe('suppression-decay indexed reads', () => {
  it('counts the collection with aggregates and reads only suppressions and the prior cohort', async () => {
    const rows = [
      { id: '_meta_', data: {} },
      { id: 'bounced-alive', data: { status: 'bounced', reprobe_batch: '2026-11-01T00:00:00.000Z' } },
      { id: 'suppressed-unknown', data: { status: 'suppressed' } },
      { id: 'hard-bounce', data: { status: 'bounced' } },
      { id: 'unsubscribed', data: { status: 'unsubscribed' } },
      { id: 'complained', data: { status: 'complained' } },
      { id: 'confirmed-cohort', data: { status: 'confirmed', reprobe_batch: '2026-11-01T00:00:00.000Z' } },
      ...Array.from({ length: 1_000 }, (_, index) => ({
        id: `confirmed-${index}`,
        data: { status: 'confirmed' },
      })),
    ];
    const { db, collection, reads } = fixtureDb(rows);

    const result = await loadSuppressionDecayScan(db, 'newsletter_subscribers', {
      includeCohorts: true,
      pageSize: 2,
    });

    expect(result.totalDocuments).toBe(rows.length - 1);
    expect(result.terminalStatuses).toBe(2);
    expect(result.decayableDocs.map((doc: any) => doc.id).sort()).toEqual([
      'bounced-alive', 'hard-bounce', 'suppressed-unknown',
    ]);
    expect(result.cohorts.get('2026-11-01T00:00:00.000Z')).toHaveLength(2);
    expect(result.estimatedReads).toBe(10);
    expect(reads.every(({ pageSize }) => pageSize === 2)).toBe(true);
    expect(collection.get).not.toHaveBeenCalled();
    expect(db.collection).toHaveBeenCalledWith('newsletter_subscribers');
  });
});
