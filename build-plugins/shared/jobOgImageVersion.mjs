import { getJobOgPhotoKey } from './jobOgImageCatalog.mjs';

// Keep this version tied to rasterized card pixels. Social metadata changes in
// jobsSeoPagesPlugin must not bump it: doing so invalidates every cached card
// and turns a metadata-only deploy into a multi-hour cold render.
export const JOB_OG_IMAGE_VERSION = 'v5-2026-11-02-portrait-q72';

export function versionedJobOgImageUrl(baseUrl, slug) {
  if (!slug) return null;
  const photoKey = getJobOgPhotoKey(slug);
  const versionedUrl = `${baseUrl}/og/jobs/${slug}.webp?v=${JOB_OG_IMAGE_VERSION}`;
  return photoKey ? `${versionedUrl}&photo=${encodeURIComponent(photoKey)}` : versionedUrl;
}
