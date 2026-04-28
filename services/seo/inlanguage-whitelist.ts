/**
 * Schema.org types that officially accept an `inLanguage` property.
 *
 * Per https://schema.org/inLanguage the property is defined on:
 *   - CreativeWork (and ALL of its subclasses)
 *   - Event
 *   - LinkRole
 *   - WriteAction
 *
 * The CreativeWork hierarchy covers most real types we emit: Article and
 * its subclasses (NewsArticle, BlogPosting, ScholarlyArticle, …), WebPage
 * and its subclasses (CollectionPage, AboutPage, ContactPage, FAQPage,
 * QAPage, …), WebSite, Dataset, HowTo (and Recipe), Course, Book,
 * MediaObject (VideoObject, ImageObject, AudioObject), Review/ClaimReview,
 * Message, and SoftwareApplication (and its WebApplication and
 * MobileApplication subclasses). All of these accept `inLanguage`.
 *
 * Types that do NOT accept `inLanguage` (Thing/Intangible/Place subtree):
 *   BreadcrumbList, ItemList, Place, Organization (incl. LocalBusiness),
 *   Offer, Person, PostalAddress, GeoCoordinates, AdministrativeArea,
 *   Country, City, GovernmentService, LegislationObject, …
 * Putting `inLanguage` on these makes Semrush + Google structured-data
 * testing emit "property not recognized".
 *
 * JobPosting and Product are listed as expected types for `inLanguage`
 * by Google's rich-results validator (even though both extend Intangible /
 * Thing rather than CreativeWork).
 *
 * Lives in its own module so test files that mock `@/services/seoService`
 * (see tests/setup.tsx) don't accidentally hide this whitelist from
 * non-mocked consumers like services/seo/schema-normalizers.ts.
 */
export const TYPES_ACCEPT_IN_LANGUAGE: ReadonlySet<string> = new Set([
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
 // Other CreativeWork descendants
 'Dataset',
 'HowTo',
 'Recipe',
 'Course',
 'Book',
 'Message',
 'Review',
 'ClaimReview',
 'VideoObject',
 'ImageObject',
 'AudioObject',
 'MediaObject',
 // Explicitly listed by schema.org as accepting inLanguage
 'Event',
 'LinkRole',
 'WriteAction',
 // Listed by Google rich-results validator as supporting inLanguage
 'JobPosting',
 'Product',
]);
