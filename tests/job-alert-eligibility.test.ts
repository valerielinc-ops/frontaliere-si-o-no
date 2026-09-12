import { describe, expect, it } from 'vitest';
import { resolveJobAlertEligibility } from '../services/jobAlertEligibility';

const alert = (keywords: string[], active = true) => ({
  active,
  keywords,
});

describe('job-alert CTA eligibility', () => {
  it('skips a CTA whose category is already covered', () => {
    expect(resolveJobAlertEligibility(
      [alert(['Tecnologia'])],
      'tecnologia',
      10,
    )).toEqual({ eligible: false, reason: 'already_subscribed' });
  });

  it('skips a CTA when the active-alert quota is full', () => {
    expect(resolveJobAlertEligibility(
      [alert(['uno']), alert(['due']), alert(['tre'])],
      'altro',
      3,
    )).toEqual({ eligible: false, reason: 'quota_full' });
  });

  it('keeps a CTA eligible for a new category below the quota', () => {
    expect(resolveJobAlertEligibility(
      [alert(['altro'])],
      'Tecnologia',
      3,
    )).toEqual({ eligible: true, reason: null });
  });

  it('ignores inactive alerts when checking an existing subscription', () => {
    expect(resolveJobAlertEligibility(
      [alert(['Tecnologia'], false)],
      'Tecnologia',
      10,
    )).toEqual({ eligible: true, reason: null });
  });

  it('does not count inactive alerts against the active-alert quota', () => {
    expect(resolveJobAlertEligibility(
      [alert(['uno'], false), alert(['due'], false), alert(['tre'], false)],
      'altro',
      3,
    )).toEqual({ eligible: true, reason: null });
  });
});
