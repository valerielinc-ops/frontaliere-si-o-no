import { describe, expect, it } from 'vitest';

import {
  isInstagramBrowserPublishingApproved,
  isTikTokBrowserPublishingApproved,
  partitionAutomatedDeliveryChannels,
  shouldHoldAutomatedSocialDelivery,
  socialAutomatedDeliveryPolicy,
} from '../scripts/lib/social-automation-policy.mjs';

describe('social automated delivery policy', () => {
  it('holds both browser routes until their explicit approval flags are enabled', () => {
    expect(socialAutomatedDeliveryPolicy('tiktok')).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('owner-approved'),
    });
    expect(shouldHoldAutomatedSocialDelivery('tiktok')).toBe(true);
    expect(shouldHoldAutomatedSocialDelivery('tiktok', { dryRun: true })).toBe(false);
    expect(partitionAutomatedDeliveryChannels(['instagram', 'tiktok'])).toEqual({
      allowed: [],
      held: [
        { channel: 'instagram', reason: expect.stringContaining('owner-approved') },
        { channel: 'tiktok', reason: expect.stringContaining('owner-approved') },
      ],
    });
    expect(partitionAutomatedDeliveryChannels(['instagram', 'tiktok'], {
      instagramBrowserPublishingApproved: true,
      tiktokBrowserPublishingApproved: true,
    })).toEqual({
      allowed: ['instagram', 'tiktok'],
      held: [],
    });
    expect(socialAutomatedDeliveryPolicy('instagram')).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('owner-approved'),
    });
    expect(shouldHoldAutomatedSocialDelivery('instagram')).toBe(true);
    expect(socialAutomatedDeliveryPolicy('instagram', { instagramBrowserPublishingApproved: true })).toEqual({
      allowed: true,
      reason: null,
    });
    expect(isInstagramBrowserPublishingApproved({ SOCIAL_ROBOT_INSTAGRAM_BROWSER_PUBLISHING_OWNER_APPROVED: 'true' })).toBe(true);
    expect(isTikTokBrowserPublishingApproved({ SOCIAL_ROBOT_TIKTOK_BROWSER_PUBLISHING_OWNER_APPROVED: 'true' })).toBe(true);
  });
});
