import { getJobOgPhotoKey } from './jobOgImageCatalog.mjs';

export const JOB_OG_IMAGE_VERSION = 'v6-2026-11-02-hiring-strip';

export function versionedJobOgImageUrl(baseUrl, slug) {
  if (!slug) return null;
  const photoKey = getJobOgPhotoKey(slug);
  const versionedUrl = `${baseUrl}/og/jobs/${slug}.webp?v=${JOB_OG_IMAGE_VERSION}`;
  return photoKey ? `${versionedUrl}&photo=${encodeURIComponent(photoKey)}` : versionedUrl;
}
