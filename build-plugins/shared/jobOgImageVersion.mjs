export const JOB_OG_IMAGE_VERSION = 'v6-2026-11-02-hiring-strip';

export function versionedJobOgImageUrl(baseUrl, slug) {
  if (!slug) return null;
  return `${baseUrl}/og/jobs/${slug}.webp?v=${JOB_OG_IMAGE_VERSION}`;
}
