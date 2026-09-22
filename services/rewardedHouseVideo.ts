/**
 * Small first-party video used only when Google rewarded inventory has no fill.
 *
 * The asset is intentionally preloaded alongside the GPT request so a no-fill
 * does not leave the user staring at a spinner while a second media request
 * starts. It is a clearly labelled house video, not a synthetic Google ad.
 */
export const REWARDED_HOUSE_VIDEO_URL = '/assets/rewarded-frontaliere-house.mp4';
const REWARDED_HOUSE_VIDEO_PRELOAD_ATTRIBUTE = 'data-rewarded-house-video-preload';

let preloadLink: HTMLLinkElement | null = null;

export function preloadRewardedHouseVideo(): void {
  if (typeof document === 'undefined') return;
  if (preloadLink?.isConnected) return;

  const existing = document.querySelector<HTMLLinkElement>(
    `link[${REWARDED_HOUSE_VIDEO_PRELOAD_ATTRIBUTE}]`,
  );
  if (existing) {
    preloadLink = existing;
    return;
  }

  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = 'video';
  link.type = 'video/mp4';
  link.href = REWARDED_HOUSE_VIDEO_URL;
  link.setAttribute(REWARDED_HOUSE_VIDEO_PRELOAD_ATTRIBUTE, 'true');
  document.head.appendChild(link);
  preloadLink = link;
}
