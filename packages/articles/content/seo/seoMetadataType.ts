// seoMetadataType.ts (packages/articles content-side)
//
// Package-side twin of the `SEOMetadata` interface exported by
// `services/seoService.ts`, for the same reason `blogImageCdnMirror.ts`
// exists: the article SEO chunks in this directory are corpus — one entry
// appended per generated article — but `packages/articles` must never reach
// outside its own tree (confinement gate, tests/packages-articles-confinement.test.ts),
// and `services/seoService.ts` is site code that lives in the consuming repo.
//
// This is TYPE-ONLY and erased at build time: zero runtime footprint, nothing
// to keep byte-compatible at execution. It only has to stay STRUCTURALLY
// compatible with the site's declaration, so the same chunk type-checks in
// both repositories. Keep the two in sync when a field is added.
export interface SEOMetadata {
  title: string;
  description: string;
  keywords: string;
  ogTitle: string;
  ogDescription: string;
  canonicalPath: string;
  structuredData?: Record<string, any> | Record<string, any>[];
  /** Optional H1 override — if set, static HTML renders this instead of ogTitle (H.6 SEO). */
  h1?: string;
}
