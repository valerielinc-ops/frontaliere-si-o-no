// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  grantRewardedApplicationAccess,
  getRewardedApplicationAccessExpiresAt,
  hasRewardedApplicationAccess,
  REWARDED_APPLICATION_ACCESS_STORAGE_KEY,
  REWARDED_APPLICATION_ACCESS_TTL_HOURS,
  REWARDED_APPLICATION_ACCESS_TTL_MS,
} from '@/services/rewardedApplicationAccess';

const HOUR_MS = 60 * 60 * 1000;

describe('rewarded application access', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('matches the one-hour reward entitlement of the AdSense Offerwall', () => {
    expect(REWARDED_APPLICATION_ACCESS_TTL_MS).toBe(HOUR_MS);
    expect(REWARDED_APPLICATION_ACCESS_TTL_HOURS).toBe(1);
  });

  it('reads an active entitlement within the TTL unchanged', () => {
    const now = 1_800_000_000_000;
    const expiresAt = now + 30 * 60 * 1000;
    window.localStorage.setItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY, String(expiresAt));

    expect(getRewardedApplicationAccessExpiresAt(now + 1)).toBe(expiresAt);
    expect(window.localStorage.getItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY)).toBe(String(expiresAt));
    expect(hasRewardedApplicationAccess(expiresAt - 1)).toBe(true);
  });

  it('shortens a legacy twelve-hour grant to at most one TTL from now, and stores it back', () => {
    const grantedAt = 1_800_000_000_000;
    const legacyExpiresAt = grantedAt + 12 * HOUR_MS;
    window.localStorage.setItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY, String(legacyExpiresAt));

    const now = grantedAt + 5 * 60 * 1000;
    const clamped = now + REWARDED_APPLICATION_ACCESS_TTL_MS;
    expect(getRewardedApplicationAccessExpiresAt(now)).toBe(clamped);
    expect(window.localStorage.getItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY)).toBe(String(clamped));
    // A later read does not push it further: the clamp is not a renewal.
    expect(getRewardedApplicationAccessExpiresAt(now + 10 * 60 * 1000)).toBe(clamped);
    expect(hasRewardedApplicationAccess(clamped)).toBe(false);
  });

  it('removes expired access and fails closed', () => {
    const now = 1_800_000_000_000;
    window.localStorage.setItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY, String(now));

    expect(getRewardedApplicationAccessExpiresAt(now)).toBeNull();
    expect(hasRewardedApplicationAccess(now)).toBe(false);
    expect(window.localStorage.getItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY)).toBeNull();
  });

  it('grants a browser-scoped entitlement for one hour', () => {
    const now = 1_800_000_000_000;

    expect(grantRewardedApplicationAccess(now)).toBe(now + HOUR_MS);
    expect(window.localStorage.getItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY)).toBe(String(now + HOUR_MS));
    expect(hasRewardedApplicationAccess(now + 1)).toBe(true);
    expect(hasRewardedApplicationAccess(now + HOUR_MS)).toBe(false);
  });
});
