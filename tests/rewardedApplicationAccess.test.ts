// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';
import {
  getRewardedApplicationAccessExpiresAt,
  hasRewardedApplicationAccess,
  REWARDED_APPLICATION_ACCESS_STORAGE_KEY,
} from '@/services/rewardedApplicationAccess';

describe('rewarded application access', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('reads an existing legacy browser entitlement until its expiry', () => {
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
});
