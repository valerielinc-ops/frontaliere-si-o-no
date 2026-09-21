// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  grantRewardedApplicationAccess,
  getRewardedApplicationAccessExpiresAt,
  hasRewardedApplicationAccess,
  REWARDED_APPLICATION_ACCESS_STORAGE_KEY,
  REWARDED_APPLICATION_ACCESS_TTL_MS,
} from '@/services/rewardedApplicationAccess';

describe('rewarded application access', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('reads an active legacy entitlement without changing its scope', () => {
    const now = 1_800_000_000_000;
    const expiresAt = now + 12 * 60 * 60 * 1000;
    window.localStorage.setItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY, String(expiresAt));

    expect(getRewardedApplicationAccessExpiresAt(now + 1)).toBe(expiresAt);
    expect(hasRewardedApplicationAccess(expiresAt - 1)).toBe(true);
  });

  it('removes expired access and fails closed', () => {
    const now = 1_800_000_000_000;
    window.localStorage.setItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY, String(now));

    expect(getRewardedApplicationAccessExpiresAt(now)).toBeNull();
    expect(hasRewardedApplicationAccess(now)).toBe(false);
    expect(window.localStorage.getItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY)).toBeNull();
  });

  it('grants a browser-scoped entitlement for twelve hours', () => {
    const now = 1_800_000_000_000;

    expect(grantRewardedApplicationAccess(now)).toBe(now + REWARDED_APPLICATION_ACCESS_TTL_MS);
    expect(window.localStorage.getItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY)).toBe(String(now + REWARDED_APPLICATION_ACCESS_TTL_MS));
    expect(hasRewardedApplicationAccess(now + 1)).toBe(true);
  });
});
