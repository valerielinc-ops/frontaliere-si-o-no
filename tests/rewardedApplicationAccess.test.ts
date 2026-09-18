// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRewardedApplicationAccess,
  getRewardedApplicationAccessExpiresAt,
  grantRewardedApplicationAccess,
  hasRewardedApplicationAccess,
  REWARDED_APPLICATION_ACCESS_STORAGE_KEY,
  REWARDED_APPLICATION_ACCESS_TTL_MS,
} from '@/services/rewardedApplicationAccess';

describe('rewarded application access', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    clearRewardedApplicationAccess();
  });

  it('grants exactly twelve hours of browser-scoped access', () => {
    const now = 1_800_000_000_000;

    expect(grantRewardedApplicationAccess(now)).toBe(now + REWARDED_APPLICATION_ACCESS_TTL_MS);
    expect(window.localStorage.getItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY)).toBe(String(now + REWARDED_APPLICATION_ACCESS_TTL_MS));
    expect(getRewardedApplicationAccessExpiresAt(now + 1)).toBe(now + REWARDED_APPLICATION_ACCESS_TTL_MS);
    expect(hasRewardedApplicationAccess(now + REWARDED_APPLICATION_ACCESS_TTL_MS - 1)).toBe(true);
  });

  it('removes expired access and fails closed', () => {
    const now = 1_800_000_000_000;
    window.localStorage.setItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY, String(now));

    expect(getRewardedApplicationAccessExpiresAt(now)).toBeNull();
    expect(hasRewardedApplicationAccess(now)).toBe(false);
    expect(window.localStorage.getItem(REWARDED_APPLICATION_ACCESS_STORAGE_KEY)).toBeNull();
  });
});
