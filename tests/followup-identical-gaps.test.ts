import { describe, expect, it } from 'vitest';
import {
  CLAUDE_REVIEW_STEP_NAME,
  REVIEW_ABORT_STEP_NAME,
  REVIEW_GATE_STEP_NAME,
  reviewAbortedWithoutVerdict,
  reviewSkippedByGuard,
  vitestFailureIsReviewGate,
} from '../scripts/ci/lib/vitestCheck.mjs';
import {
  DEFAULT_MAX_REOPENS,
  decideReopen,
  renderReopenBudget,
} from '../scripts/ci/lib/reopen-breaker.mjs';

const gateFailure = { name: REVIEW_GATE_STEP_NAME, conclusion: 'failure' };
const reviewSkipped = { name: CLAUDE_REVIEW_STEP_NAME, conclusion: 'skipped' };
const redFingerprint = 'red-state';

describe('follow-up identical review gates', () => {
  it('un cancelled di un test impedisce di classificare il rosso come review gate (#1185)', () => {
    expect(vitestFailureIsReviewGate([
      { name: 'vitest related (PR diff)', conclusion: 'cancelled' },
      gateFailure,
    ])).toBe(false);
  });

  it('distingue il guard skip da un abort API esplicito (#1140)', () => {
    const skipped = [
      { name: 'Re-review guard', conclusion: 'success' },
      reviewSkipped,
      gateFailure,
    ];
    expect(reviewSkippedByGuard(skipped)).toBe(true);
    expect(reviewSkippedByGuard([
      ...skipped,
      { name: REVIEW_ABORT_STEP_NAME, conclusion: 'failure' },
    ])).toBe(false);
    expect(reviewAbortedWithoutVerdict([
      { name: CLAUDE_REVIEW_STEP_NAME, conclusion: 'failure' },
      gateFailure,
      { name: REVIEW_ABORT_STEP_NAME, conclusion: 'failure' },
    ])).toBe(true);
  });

  it('il guard skip non consuma il one-shot e lascia una causa leggibile', () => {
    const d = decideReopen({
      vitestConclusion: 'failure',
      fingerprint: redFingerprint,
      prior: null,
      reviewGateFailure: true,
      reviewSkippedByGuard: true,
    });
    expect(d.action).toBe('skip-failing-check');
    expect(d.cause).toBe('review-gate-skipped');
    const body = renderReopenBudget({
      count: d.count,
      max: DEFAULT_MAX_REOPENS,
      fingerprint: redFingerprint,
      action: d.action,
      reason: d.reason,
      cause: d.cause,
    });
    expect(body).toContain('cambi il codice del contributo');
    expect(body).not.toContain('close+reopen manuale');
  });

  it('sullo stesso stato la causa stuck-red prevale sul review gate (#1140)', () => {
    const d = decideReopen({
      vitestConclusion: 'failure',
      fingerprint: redFingerprint,
      prior: { count: DEFAULT_MAX_REOPENS, fingerprint: redFingerprint },
      failureNotAttributable: 'red-main',
      reviewGateFailure: true,
      reviewSkippedByGuard: true,
    });
    expect(d.action).toBe('skip-breaker');
    expect(d.cause).toBe('stuck-red');
    const body = renderReopenBudget({
      count: d.count,
      max: DEFAULT_MAX_REOPENS,
      fingerprint: redFingerprint,
      action: d.action,
      reason: d.reason,
      cause: d.cause,
    });
    expect(body).toMatch(/main|run fresco|run fresh/i);
    expect(body).not.toContain('review Claude approvante');
  });
});
