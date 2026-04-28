/**
 * Schema.org types that officially accept an `inLanguage` property.
 *
 * Any other @type (BreadcrumbList, ItemList, SoftwareApplication,
 * WebApplication, Organization, Place, Offer, LocalBusiness, Event, ...)
 * must NOT receive `inLanguage` — Semrush + Google structured-data testing
 * flag it as an error.
 *
 * Source: schema.org/CreativeWork#inLanguage (only CreativeWork + subclasses
 * define this property). ListItem inherits via CreativeWork variants in a
 * handful of cases, but BreadcrumbList/ItemList themselves do not.
 *
 * Lives in its own module so test files that mock `@/services/seoService`
 * (see tests/setup.tsx) don't accidentally hide this whitelist from
 * non-mocked consumers like services/seo/schema-normalizers.ts.
 */
export const TYPES_ACCEPT_IN_LANGUAGE: ReadonlySet<string> = new Set([
 'Article',
 'NewsArticle',
 'BlogPosting',
 'WebPage',
 'CollectionPage',
 'AboutPage',
 'ContactPage',
 'FAQPage',
 'QAPage',
 'JobPosting',
 'Dataset',
 'CreativeWork',
 'HowTo',
 'Product',
 'Review',
 'VideoObject',
 'ImageObject',
 'AudioObject',
 'Book',
 'Course',
 'Recipe',
 'Message',
]);
