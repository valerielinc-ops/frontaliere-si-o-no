import { describe, expect, it, vi } from 'vitest';
import { loadApplicationIntentReminderCandidates } from '../scripts/lib/application-intent-reminder-candidates.mjs';

type Filter = { field: string; operator: string; value: unknown };

function comparable(value: unknown): number | string | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' || typeof value === 'string') return value;
  return null;
}

function fieldValue(data: Record<string, unknown>, field: string): unknown {
  return field.split('.').reduce<unknown>((value, segment) => (
    value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined
  ), data);
}

function matches(actual: unknown, filter: Filter): boolean {
  if ((actual instanceof Date) !== (filter.value instanceof Date)) return false;
  if (typeof actual !== typeof filter.value) return false;
  const left = comparable(actual);
  const right = comparable(filter.value);
  if (left == null || right == null || typeof left !== typeof right) return false;
  switch (filter.operator) {
    case '>=': return left >= right;
    case '<=': return left <= right;
    default: throw new Error(`unexpected operator ${filter.operator}`);
  }
}

function fixtureDb(rows: Array<{ id: string; data: Record<string, unknown> }>) {
  const queryCalls: Array<{ filters: Filter[]; pageSize: number }> = [];
  const docs = rows.map((row) => ({
    id: row.id,
    ref: { id: row.id, path: `users/user-1/application_intents/${row.id}` },
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
      let found = docs.filter((doc) => this.filters.every((filter) => matches(fieldValue(doc.data, filter.field), filter)));
      if (this.orderField) {
        found = found.sort((a, b) => {
          const left = comparable(fieldValue(a.data, this.orderField!));
          const right = comparable(fieldValue(b.data, this.orderField!));
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

  const collectionGroup = {
    where: vi.fn((field: string, operator: string, value: unknown) => new Query().where(field, operator, value)),
    get: vi.fn(() => Promise.reject(new Error('unfiltered collection-group scan is forbidden'))),
  };
  return {
    db: { collectionGroup: vi.fn(() => collectionGroup) } as any,
    collectionGroup,
    queryCalls,
  };
}

describe('application-intent reminder candidate reads', () => {
  it('pages due-only queries across canonical and legacy timestamp fields', async () => {
    const now = new Date('2026-11-08T12:00:00.000Z');
    const recent = new Date(now.getTime() - 10 * 86400000);
    const dueRows = [
      { id: 'canonical-a', data: { reminder: { dueAt: recent } } },
      { id: 'canonical-b', data: { reminder: { dueAt: new Date(recent.getTime() + 1000) } } },
      { id: 'canonical-c', data: { reminder: { dueAt: new Date(recent.getTime() + 2000) } } },
      { id: 'legacy-timestamp', data: { reminder_due_at: recent } },
      { id: 'legacy-string', data: { reminder_due_at: recent.toISOString() } },
      { id: 'legacy-number', data: { reminder_due_at: recent.getTime() } },
      { id: 'top-level-timestamp', data: { dueAt: recent } },
      { id: 'top-level-string', data: { dueAt: recent.toISOString() } },
      { id: 'top-level-number', data: { dueAt: recent.getTime() } },
    ];
    const rows = [
      ...dueRows,
      { id: 'stale', data: { reminder: { dueAt: new Date(now.getTime() - 120 * 86400000) } } },
      { id: 'future', data: { reminder: { dueAt: new Date(now.getTime() + 86400000) } } },
      ...Array.from({ length: 1_000 }, (_, index) => ({
        id: `unrelated-${index}`,
        data: { status: 'completed', timestamp: recent },
      })),
    ];
    const { db, collectionGroup, queryCalls } = fixtureDb(rows);

    const result = await loadApplicationIntentReminderCandidates(db, { now, pageSize: 2 });

    expect(result.docs.map((doc: any) => doc.id).sort()).toEqual(dueRows.map(({ id }) => id).sort());
    expect(result.queryCount).toBe(9);
    // Three timestamp candidates span two pages; the other eight filtered
    // queries each read one candidate. None of the 1,002 unrelated records is read.
    expect(result.reads).toBe(11);
    expect(queryCalls.every(({ pageSize }) => pageSize === 2)).toBe(true);
    expect(collectionGroup.get).not.toHaveBeenCalled();
    expect(db.collectionGroup).toHaveBeenCalledWith('application_intents');
    expect(result.reads).toBeLessThan(rows.length / 50);
  });
});
