// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest';
import {
  preloadRewardedHouseVideo,
  REWARDED_HOUSE_VIDEO_URL,
} from '@/services/rewardedHouseVideo';

afterEach(() => {
  document.querySelectorAll('link[data-rewarded-house-video-preload]').forEach((node) => node.remove());
});

describe('rewardedHouseVideo', () => {
  it('preloads the CDN asset once with video semantics', () => {
    preloadRewardedHouseVideo();
    preloadRewardedHouseVideo();

    const links = document.querySelectorAll('link[data-rewarded-house-video-preload]');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('rel')).toBe('preload');
    expect((links[0] as HTMLLinkElement).as).toBe('video');
    expect(links[0].getAttribute('type')).toBe('video/mp4');
    expect((links[0] as HTMLLinkElement).href).toBe(REWARDED_HOUSE_VIDEO_URL);
  });
});
