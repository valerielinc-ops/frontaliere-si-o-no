import { ASSET_EXT_ALTERNATION } from './cdnAssetOffloadRx.mjs';

/** Shared URL route and file suffix contract for static CDN rewrites. */
export const CDN_OFFLOAD_IMAGE_EXTENSIONS = 'webp|png|jpe?g|avif|svg|ico|gif';
export const CDN_OFFLOAD_IMAGE_FILE_PATTERN = `([^"'\\s)?]+?\\.(?:${CDN_OFFLOAD_IMAGE_EXTENSIONS}))`;
export const CDN_OFFLOAD_ASSET_FILE_PATTERN = `([^"'\\s)?]+?\\.(?:${ASSET_EXT_ALTERNATION}))`;
export const CDN_OFFLOAD_DATA_FILE_PATTERN = `([^"'\\s)?<>]+?\\.(?:json|csv))`;

// Keep the image prefixes aligned with the runtime CDN image base and the
// deploy's CDN upload set. The invariant checker imports this same table.
export const CDN_OFFLOADED_IMAGE_TARGETS = Object.freeze([
  { dir: ['og'], url: '/og/' },
  { dir: ['images', 'blog', 'thumbnails'], url: '/images/blog/thumbnails/' },
  { dir: ['images', 'brands'], url: '/images/brands/' },
  { dir: ['images', 'insurers'], url: '/images/insurers/' },
  { dir: ['images', 'providers'], url: '/images/providers/' },
  { dir: ['images', 'logos'], url: '/images/logos/' },
  { dir: ['images', 'authors'], url: '/images/authors/' },
  { dir: ['images', 'publisher'], url: '/images/publisher/' },
  { dir: ['images', 'job-search-campaign'], url: '/images/job-search-campaign/' },
  { dir: ['images', 'events'], url: '/images/events/' },
].map((target) => Object.freeze({ ...target, dir: Object.freeze(target.dir) })));
