// tests/schemas/border-wait-schema.test.ts
//
// Real shape confirmed from data/border-wait-current.json.
// The task spec assumed a flat measurement shape (crossing, observedAt,
// waitMinutes, direction, source) — actual data uses per-crossing entries
// written by scripts/snapshot-border-wait-history.mjs + trafficSchedulerCore.js.
//
// Actual per-crossing schema:
//   { waitTimeMinutes, approachMinutes, totalCrossingMinutes, status, source, lastUpdate }
//
// The top-level file shape: { updatedAt, perCrossing: Record<slug, entry> }.
import { describe, it, expect } from 'vitest';
import {
  BorderWaitCurrentEntrySchema,
  BorderWaitCurrentFileSchema,
} from '../../scripts/lib/schemas/borderWait.mjs';

const validEntry = {
  waitTimeMinutes: 25,
  approachMinutes: 5,
  totalCrossingMinutes: 30,
  status: 'green',
  source: 'here',
  lastUpdate: '2026-05-20T08:30:00.000Z',
};

describe('BorderWaitCurrentEntrySchema', () => {
  it('accepts a valid entry', () => {
    const r = BorderWaitCurrentEntrySchema.safeParse(validEntry);
    if (!r.success) console.error(r.error.issues);
    expect(r.success).toBe(true);
  });

  it('rejects negative waitTimeMinutes', () => {
    expect(
      BorderWaitCurrentEntrySchema.safeParse({ ...validEntry, waitTimeMinutes: -5 }).success,
    ).toBe(false);
  });

  it('rejects waitTimeMinutes > 720', () => {
    expect(
      BorderWaitCurrentEntrySchema.safeParse({ ...validEntry, waitTimeMinutes: 800 }).success,
    ).toBe(false);
  });

  it('rejects unknown status', () => {
    expect(
      BorderWaitCurrentEntrySchema.safeParse({ ...validEntry, status: 'purple' }).success,
    ).toBe(false);
  });

  it('rejects unknown source', () => {
    expect(
      BorderWaitCurrentEntrySchema.safeParse({ ...validEntry, source: 'bazg' }).success,
    ).toBe(false);
  });

  it('rejects malformed lastUpdate', () => {
    expect(
      BorderWaitCurrentEntrySchema.safeParse({
        ...validEntry,
        lastUpdate: '20/05/2026 08:30',
      }).success,
    ).toBe(false);
  });

  it('accepts null approachMinutes (crossing with no approach data)', () => {
    expect(
      BorderWaitCurrentEntrySchema.safeParse({
        ...validEntry,
        approachMinutes: null,
      }).success,
    ).toBe(true);
  });
});

describe('BorderWaitCurrentFileSchema', () => {
  it('accepts a valid current file', () => {
    const file = {
      updatedAt: '2026-05-20T08:30:00.000Z',
      perCrossing: {
        'chiasso-brogeda': validEntry,
        'chiasso-centro': { ...validEntry, approachMinutes: 0, totalCrossingMinutes: 1 },
      },
    };
    const r = BorderWaitCurrentFileSchema.safeParse(file);
    if (!r.success) console.error(r.error.issues);
    expect(r.success).toBe(true);
  });

  it('rejects a file with an invalid entry inside perCrossing', () => {
    const file = {
      updatedAt: '2026-05-20T08:30:00.000Z',
      perCrossing: {
        'chiasso-brogeda': { ...validEntry, waitTimeMinutes: -1 },
      },
    };
    expect(BorderWaitCurrentFileSchema.safeParse(file).success).toBe(false);
  });
});
