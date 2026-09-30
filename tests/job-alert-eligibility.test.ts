import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getJobAlertEligibility, resolveJobAlertEligibility } from '../services/jobAlertEligibility';
import { invalidateUserAlertsCache } from '../services/userAlertsCache';

const { getUserAlertsMock } = vi.hoisted(() => ({
  getUserAlertsMock: vi.fn(),
}));

vi.mock('../services/jobAlertService', () => ({
  getUserAlerts: getUserAlertsMock,
  MAX_ALERTS_PER_USER: 3,
}));

const alert = (keywords: string[], active = true, specificCompanyKey: string | null = null) => ({
  active,
  keywords,
  specificCompanyKey,
});

beforeEach(() => {
  getUserAlertsMock.mockReset();
  invalidateUserAlertsCache();
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

  it('does not count or match a company pin against the category-alert quota', () => {
    expect(resolveJobAlertEligibility(
      [alert(['Tecnologia'], true, 'coop')],
      'Tecnologia',
      1,
    )).toEqual({ eligible: true, reason: null });
  });

  it('rereads after a successful create invalidates the session snapshot', async () => {
    let currentAlerts = [];
    getUserAlertsMock.mockImplementation(async () => currentAlerts);

    await expect(getJobAlertEligibility('user-1', 'Tecnologia'))
      .resolves.toEqual({ eligible: true, reason: null });

    currentAlerts = [alert(['Tecnologia'])];
    invalidateUserAlertsCache();

    await expect(getJobAlertEligibility('user-1', 'Tecnologia'))
      .resolves.toEqual({ eligible: false, reason: 'already_subscribed' });
    expect(getUserAlertsMock).toHaveBeenCalledTimes(2);
  });

  it('rereads after a successful delete invalidates the session snapshot', async () => {
    let currentAlerts = [alert(['Tecnologia'])];
    getUserAlertsMock.mockImplementation(async () => currentAlerts);

    await expect(getJobAlertEligibility('user-1', 'Tecnologia'))
      .resolves.toEqual({ eligible: false, reason: 'already_subscribed' });

    currentAlerts = [];
    invalidateUserAlertsCache();

    await expect(getJobAlertEligibility('user-1', 'Tecnologia'))
      .resolves.toEqual({ eligible: true, reason: null });
    expect(getUserAlertsMock).toHaveBeenCalledTimes(2);
  });
});
