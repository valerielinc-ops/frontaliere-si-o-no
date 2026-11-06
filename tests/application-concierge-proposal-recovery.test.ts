import { describe, expect, it } from 'vitest';
import {
  isLegacyUnverifiedRetraction,
  legacyProposalRecoveryRetryFields,
  legacyProposalRecoveryTerminalFields,
  selectLegacyProposalRecovery,
  summarizeLegacyProposalRecovery,
} from '../functions/src/applicationConciergeProposalRecovery.js';

const now = Date.now();
const context = 'current-cv-and-profile';

function legacy(id: string, overrides: Record<string, unknown> = {}) {
  return { id, data: {
    status: 'retracted', eligibilityStatus: 'unverified',
    retractionReason: 'decisive_requirements_unverified', ...overrides,
  } };
}

describe('durable legacy proposal recovery queue', () => {
  it('selects a bounded fair batch and rotates past rows that entered backoff', () => {
    const rows = Array.from({ length: 12 }, (_, index) => legacy(`proposal-${String(index).padStart(2, '0')}`));
    rows.push(legacy('accepted', { status: 'accepted', childApplicationId: 'application-1' }));
    rows.push(legacy('unsafe-child', { childApplicationId: 'application-2' }));

    const first = selectLegacyProposalRecovery(rows, { context, nowMs: now });
    expect(first.selected.map(row => row.id)).toEqual(Array.from({ length: 8 }, (_, index) => `proposal-${String(index).padStart(2, '0')}`));
    expect(first.queued).toHaveLength(12);

    const afterAttempt = rows.map(row => first.selected.some(selected => selected.id === row.id)
      ? { ...row, data: { ...row.data, ...legacyProposalRecoveryRetryFields({}, { context, nowMs: now, reason: 'posting_incomplete' }) } }
      : row);
    const second = selectLegacyProposalRecovery(afterAttempt, { cursor: first.nextCursor, context, nowMs: now });
    expect(second.selected.map(row => row.id)).toEqual(['proposal-08', 'proposal-09', 'proposal-10', 'proposal-11']);
  });

  it('persists bounded backoff and summarizes pending rows for lifecycle scheduling', () => {
    const firstAttempt = legacyProposalRecoveryRetryFields({}, { context, nowMs: now, reason: 'posting_incomplete' });
    expect(firstAttempt).toMatchObject({ legacyRecoveryStatus: 'pending', legacyRecoveryAttempts: 1, legacyRecoveryNextAt: now + 60 * 60_000 });
    const secondAttempt = legacyProposalRecoveryRetryFields(firstAttempt, { context, nowMs: now + 60 * 60_000, reason: 'analysis_unavailable' });
    expect(secondAttempt.legacyRecoveryAttempts).toBe(2);
    expect(secondAttempt.legacyRecoveryNextAt).toBe(now + 4 * 60 * 60_000);
    const deferred = legacyProposalRecoveryRetryFields(secondAttempt, { context, nowMs: now + 2 * 60 * 60_000, reason: 'analysis_deferred' });
    expect(deferred.legacyRecoveryAttempts).toBe(2);
    expect(deferred.legacyRecoveryNextAt).toBe(now + 3 * 60 * 60_000);

    const rows = [legacy('pending', firstAttempt), legacy('due', { legacyRecoveryContext: context, legacyRecoveryNextAt: now - 1 })];
    const summary = summarizeLegacyProposalRecovery(rows, new Map(), { context, nowMs: now });
    expect(summary).toEqual({ count: 2, retryAt: now + 60 * 60_000 });

    const terminal = { ...legacy('pending').data, ...legacyProposalRecoveryTerminalFields({ context, nowMs: now, reason: 'job_closed' }), retractionReason: 'job_closed' };
    expect(isLegacyUnverifiedRetraction(terminal)).toBe(false);
    expect(summarizeLegacyProposalRecovery([legacy('done', terminal)], new Map(), { context, nowMs: now })).toEqual({ count: 0, retryAt: null });
  });
});
