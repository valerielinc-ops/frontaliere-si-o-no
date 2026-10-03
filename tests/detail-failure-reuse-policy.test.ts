import { describe, expect, it } from 'vitest';
import {
  DETAIL_FAILURE_MAX_RATIO,
  applyDetailFailureReuse,
  isDetailFailureWithinGrace,
} from '../scripts/lib/detail-failure-reuse-policy.mjs';

describe('detail failure/reuse policy', () => {
  it('keeps the shared 15% boundary explicit and fail-closed on malformed counts', () => {
    expect(DETAIL_FAILURE_MAX_RATIO).toBe(0.15);
    expect(isDetailFailureWithinGrace(3, 20)).toBe(true);
    expect(isDetailFailureWithinGrace(4, 20)).toBe(false);
    expect(isDetailFailureWithinGrace(0, 0)).toBe(false);
    expect(isDetailFailureWithinGrace(1.5, 20)).toBe(false);
    expect(isDetailFailureWithinGrace(1, 0)).toBe(false);
  });

  it('reuses only the exact failed identity from a previous validated snapshot', () => {
    const previous = [
      { id: 'event:a', title: 'Previous A', startDate: '2026-10-01' },
      { id: 'event:b', title: 'Previous B', startDate: '2026-10-02' },
    ];
    const result = applyDetailFailureReuse({
      freshRows: [
        { id: 'event:a', title: 'Listing-only A', startDate: '2026-10-01' },
        { id: 'event:c', title: 'Fresh C', startDate: '2026-10-03' },
      ],
      failedIdentities: ['event:a', 'event:b'],
      attemptedCount: 20,
      previousRows: previous,
      identityOf: (row) => row.id,
      fallbackOf: (row) => row.title && row.startDate ? { ...row } : null,
      requireReuse: true,
    });

    expect(result.canPublish).toBe(true);
    expect(result.reusedDetailIdentities).toEqual(['event:a', 'event:b']);
    expect(result.rows).toEqual([
      { id: 'event:a', title: 'Previous A', startDate: '2026-10-01' },
      { id: 'event:c', title: 'Fresh C', startDate: '2026-10-03' },
      { id: 'event:b', title: 'Previous B', startDate: '2026-10-02' },
    ]);
  });

  it('rejects missing, colliding, duplicate, or over-quota reuse evidence', () => {
    const base = {
      freshRows: [{ id: 'event:a', title: 'Fresh A' }],
      failedIdentities: ['event:a'],
      attemptedCount: 20,
      identityOf: (row: { id: string }) => row.id,
      requireReuse: true,
    };

    expect(applyDetailFailureReuse(base).canPublish).toBe(false);
    expect(applyDetailFailureReuse({
      ...base,
      previousRows: [{ id: 'event:a', title: 'A1' }, { id: 'event:a', title: 'A2' }],
      fallbackOf: (row) => ({ ...row }),
    }).canPublish).toBe(false);
    expect(applyDetailFailureReuse({
      ...base,
      failedIdentities: ['event:a', 'event:a'],
      previousRows: [{ id: 'event:a', title: 'A' }],
      fallbackOf: (row) => ({ ...row }),
    }).canPublish).toBe(false);
    expect(applyDetailFailureReuse({
      ...base,
      failedIdentities: ['event:a', 'event:b', 'event:c', 'event:d'],
      previousRows: [
        { id: 'event:a', title: 'A' },
        { id: 'event:b', title: 'B' },
        { id: 'event:c', title: 'C' },
        { id: 'event:d', title: 'D' },
      ],
      fallbackOf: (row) => ({ ...row }),
    }).canPublish).toBe(false);
  });

  it('allows a new event row under the bound when the caller does not require prior reuse', () => {
    const result = applyDetailFailureReuse({
      freshRows: [{ id: 'event:new', title: 'Listing-backed event' }],
      failedIdentities: ['event:new'],
      attemptedCount: 10,
      previousRows: [],
      identityOf: (row) => row.id,
      requireReuse: false,
    });

    expect(result.withinGrace).toBe(true);
    expect(result.canPublish).toBe(true);
    expect(result.reusedDetailCount).toBe(0);
    expect(result.rows).toEqual([{ id: 'event:new', title: 'Listing-backed event' }]);
  });
});
