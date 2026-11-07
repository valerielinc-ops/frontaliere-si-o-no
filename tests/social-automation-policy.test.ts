import { describe, expect, it } from 'vitest';

import {
  partitionAutomatedDeliveryChannels,
  shouldHoldAutomatedSocialDelivery,
  socialAutomatedDeliveryPolicy,
} from '../scripts/lib/social-automation-policy.mjs';

describe('social automated delivery policy', () => {
  it('holds TikTok publishing independently of configured credentials or app audit', () => {
    expect(socialAutomatedDeliveryPolicy('tiktok')).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('eligible'),
    });
    expect(shouldHoldAutomatedSocialDelivery('tiktok')).toBe(true);
  });

  it('keeps local content previews available while delivery is held', () => {
    expect(shouldHoldAutomatedSocialDelivery('tiktok', { dryRun: true })).toBe(false);
  });

  it('filters held platforms from browser-robot runs but admits the verified route', () => {
    expect(partitionAutomatedDeliveryChannels(['instagram', 'tiktok'])).toEqual({
      allowed: [],
      held: [
        { channel: 'instagram', reason: expect.stringContaining('Meta express permission') },
        { channel: 'tiktok', reason: expect.stringContaining('eligible') },
      ],
    });
    expect(partitionAutomatedDeliveryChannels(['instagram', 'tiktok'], {
      instagramBrowserPublishingApproved: true,
    })).toEqual({
      allowed: ['instagram'],
      held: [{ channel: 'tiktok', reason: expect.stringContaining('eligible') }],
    });
    expect(socialAutomatedDeliveryPolicy('instagram')).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Meta express permission'),
    });
    expect(shouldHoldAutomatedSocialDelivery('instagram')).toBe(true);
    expect(socialAutomatedDeliveryPolicy('instagram', { instagramBrowserPublishingApproved: true })).toEqual({
      allowed: true,
      reason: null,
    });
  });
});
