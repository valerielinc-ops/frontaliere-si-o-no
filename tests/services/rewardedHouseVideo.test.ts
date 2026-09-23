// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import {
  preloadRewardedHouseVideo,
  REWARDED_HOUSE_VIDEO_URL,
} from '@/services/rewardedHouseVideo';

afterEach(() => {
  document.head.querySelectorAll('[data-rewarded-house-video-preload]').forEach((node) => node.remove());
});

describe('rewarded house video preload', () => {
  it('adds one CDN video preload and reuses it', () => {
    preloadRewardedHouseVideo();
    preloadRewardedHouseVideo();

    const links = document.head.querySelectorAll<HTMLLinkElement>(
      '[data-rewarded-house-video-preload]',
    );
    expect(links).toHaveLength(1);
    expect(links[0].rel).toBe('preload');
    expect(links[0].as).toBe('video');
    expect(new URL(REWARDED_HOUSE_VIDEO_URL).origin).toBe(
      'https://cdn.frontaliereticino.ch',
    );
    expect(links[0].getAttribute('href')).toBe(REWARDED_HOUSE_VIDEO_URL);
  });
});
