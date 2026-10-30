import { describe, expect, it, vi } from 'vitest';

const repair = vi.hoisted(() => vi.fn(async (_context: { orderId: string }) => ({ changed: true })));
vi.mock('../../functions/src/assistedApplicationAutomation.js', () => ({ reconcileFactRepairSchedule: repair }));
const { reconcileFactRepairSchedules } = await import('../../scripts/reconcile-assisted-application-fact-repairs.mjs');

describe('fact-repair schedule reconciliation pagination', () => {
  it.each([200, 201])('visits every order once at the %s document boundary', async total => {
    repair.mockClear();
    const docs = Array.from({ length: total }, (_, index) => ({ id: `order-${String(index).padStart(4, '0')}` }));
    const query = (cursor: string | null = null, size = 200): any => ({
      where: () => query(cursor, size),
      orderBy: () => query(cursor, size),
      limit: (next: number) => query(cursor, next),
      startAfter: (last: { id: string }) => query(last.id, size),
      get: async () => {
        const page = docs.filter(doc => !cursor || doc.id > cursor).slice(0, size);
        return { docs: page, size: page.length };
      },
    });
    const db = { collection: () => query() };
    expect(await reconcileFactRepairSchedules({ db })).toEqual({ scanned: total, changed: total, apply: false });
    expect(repair.mock.calls.map(call => (call[0] as any).orderId)).toEqual(docs.map(doc => doc.id));
    expect(repair).toHaveBeenLastCalledWith({ db, orderId: docs.at(-1)?.id, apply: false });
  });
});
