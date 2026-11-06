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

  it('filters held platforms from a shared browser-robot run', () => {
    expect(partitionAutomatedDeliveryChannels(['instagram', 'tiktok'])).toEqual({
      allowed: ['instagram'],
      held: [{
        channel: 'tiktok',
        reason: expect.stringContaining('eligible'),
      }],
    });
  });
});
