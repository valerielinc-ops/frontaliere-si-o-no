/**
 * First-party content used only after a consented Google rewarded request has
 * no deliverable demand.
 *
 * Keep this URL absolute: the production site serves static files from the
 * CDN and does not expose the repository's `/assets` directory at the site
 * origin. This is not a Google impression; a future sponsor can replace the
 * asset or the same path can be backed by a GAM House line item.
 */
export const REWARDED_HOUSE_VIDEO_URL =
  'https://cdn.frontaliereticino.ch/assets/rewarded-frontaliere-house.mp4';

const REWARDED_HOUSE_VIDEO_PRELOAD_ATTRIBUTE = 'data-rewarded-house-video-preload';

let preloadLink: HTMLLinkElement | null = null;

/** Preload the deterministic fallback while the Google request is warming up. */
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
