/**
 * Schema.org types that officially accept an `inLanguage` property.
 *
 * Single source of truth — consumed by:
 *   1. services/seo/inlanguage-whitelist.ts (runtime + tests)
 *   2. scripts/validate-structured-data-completeness.mjs (CI dist gate)
 *
 * Per https://schema.org/inLanguage:
 *   CreativeWork (+ all subclasses), Event, LinkRole, WriteAction
 *
 * Google's rich-results validator additionally accepts inLanguage on
 * JobPosting and Product.
 *
 * Anything outside this set is rejected by both the runtime emit path
 * (services/seo/schema-normalizers.ts) and the post-build dist scan.
 *
 * Plain `.mjs` so the Node-only validator script can import without a TS
 * transformer. The TS whitelist re-exports this as a ReadonlySet.
 */

export const TYPES_ACCEPT_IN_LANGUAGE_LIST = Object.freeze([
  // CreativeWork itself
  'CreativeWork',
  // WebPage subtree
  'WebPage',
  'CollectionPage',
  'AboutPage',
  'ContactPage',
  'FAQPage',
  'QAPage',
  'WebSite',
  // Article subtree
  'Article',
  'NewsArticle',
  'BlogPosting',
  'ScholarlyArticle',
  'TechArticle',
  'OpinionNewsArticle',
  'ReportageNewsArticle',
  // Software application subtree (extends CreativeWork)
  'SoftwareApplication',
  'WebApplication',
  'MobileApplication',
  // DigitalDocument subtree (CreativeWork descendant — guides PDF landings)
  'DigitalDocument',
  'TextDigitalDocument',
  'PresentationDigitalDocument',
  'SpreadsheetDigitalDocument',
  'NoteDigitalDocument',
  // Other CreativeWork descendants
  'Dataset',
  'HowTo',
  'Recipe',
  'Course',
  'Book',
  'Map',
  'Message',
  'Review',
  'ClaimReview',
  'VideoObject',
  'ImageObject',
  'AudioObject',
  'MediaObject',
  // schema.org explicitly lists these as accepting inLanguage
  'Event',
  'LinkRole',
  'WriteAction',
  // Google rich-results validator also accepts inLanguage here
  'JobPosting',
  'Product',
]);
