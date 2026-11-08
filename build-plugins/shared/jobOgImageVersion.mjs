import { getJobOgPhotoKey } from './jobOgImageCatalog.mjs';

// Keep this version tied to rasterized card pixels. Social metadata changes in
// jobsSeoPagesPlugin must not bump it: doing so invalidates every cached card
// and turns a metadata-only deploy into a multi-hour cold render.
export const JOB_OG_IMAGE_VERSION = 'v10-2026-11-08-employer-logo-q72';
// The archive card has its own raster version so copy or layout changes do not
// invalidate the thousands of per-offer images.
export const ARCHIVED_JOB_OG_IMAGE_VERSION = 'v1-2026-11-03-neutral';

export function versionedJobOgImageUrl(baseUrl, slug, selectedPhotoKey) {
  if (!slug) return null;
  // The selected photo key changes the CDN URL when role classification changes,
  // without cold-rendering every card through a global image-version bump.
  const photoKey = selectedPhotoKey || getJobOgPhotoKey(slug);
  const versionedUrl = `${baseUrl}/og/jobs/${slug}.webp?v=${JOB_OG_IMAGE_VERSION}`;
  return photoKey ? `${versionedUrl}&photo=${encodeURIComponent(photoKey)}` : versionedUrl;
}

export function archivedJobOgImageUrl(baseUrl) {
  return `${baseUrl}/og/jobs/archive-landing-card.webp?v=${ARCHIVED_JOB_OG_IMAGE_VERSION}&photo=archive-neutral`;
}
