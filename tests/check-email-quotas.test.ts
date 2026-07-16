import { describe, it, expect } from 'vitest';
import { computePacingSignal, buildPacingIssueBody } from '../scripts/check-email-quotas.mjs';

// Cycle anchored on the 6th, mirrors functions/src/emailCascade.js's
// RESEND_CYCLE_ANCHOR_DAY. 30-day cycle for round-number pacing math.
const cycleStart = new Date('2026-07-06T00:00:00.000Z');
const cycleEnd = new Date('2026-08-06T00:00:00.000Z');

describe('check-email-quotas — computePacingSignal', () => {
  it('is not ahead of pace when usage tracks time elapsed', () => {
    // 15 days into a 31-day cycle (~48%), used ~48% of quota — on pace.
    const now = new Date('2026-07-21T00:00:00.000Z').getTime();
    const s = computePacingSignal({ count: 24000, monthlyLimit: 50000, cycleStart, cycleEnd, now });
    expect(s.aheadOfPace).toBe(false);
  });

  it('flags ahead-of-pace when usage ratio exceeds expected ratio by more than the buffer', () => {
    // 15 days in (~48% expected), but already at 90% of quota.
    const now = new Date('2026-07-21T00:00:00.000Z').getTime();
    const s = computePacingSignal({ count: 45000, monthlyLimit: 50000, cycleStart, cycleEnd, now });
    expect(s.aheadOfPace).toBe(true);
    expect(s.daysRemaining).toBeGreaterThan(0);
  });

  it('does not flag a small overshoot within the 15% slack buffer', () => {
    // Expected ~48%, actual ~53% — within 1.15x buffer, should stay quiet.
    const now = new Date('2026-07-21T00:00:00.000Z').getTime();
    const s = computePacingSignal({ count: 26500, monthlyLimit: 50000, cycleStart, cycleEnd, now });
    expect(s.aheadOfPace).toBe(false);
  });

  it('ignores early-cycle noise below the minimum usage-ratio floor', () => {
    // Day 1 of the cycle: 3 transactional sends look like "infinite pace" in
    // ratio terms but are a negligible absolute risk — must not alert.
    const now = new Date('2026-07-06T06:00:00.000Z').getTime();
    const s = computePacingSignal({ count: 3, monthlyLimit: 50000, cycleStart, cycleEnd, now });
    expect(s.aheadOfPace).toBe(false);
  });

  it('never returns a negative daysRemaining even past cycle end', () => {
    const now = cycleEnd.getTime() + 86_400_000;
    const s = computePacingSignal({ count: 50000, monthlyLimit: 50000, cycleStart, cycleEnd, now });
    expect(s.daysRemaining).toBeGreaterThanOrEqual(1);
  });
});

describe('check-email-quotas — buildPacingIssueBody', () => {
  it('surfaces the key numbers and stays a reporter, not a directive', () => {
    const now = new Date('2026-07-21T00:00:00.000Z').getTime();
    const s = computePacingSignal({ count: 45000, monthlyLimit: 50000, cycleStart, cycleEnd, now });
    const body = buildPacingIssueBody(s);
    expect(body).toContain('45000');
    expect(body).toContain('50000');
    expect(body).toContain('2026-07-06');
    expect(body).toContain('2026-08-06');
  });
});
