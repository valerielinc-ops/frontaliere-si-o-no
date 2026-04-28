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
 * Message, DigitalDocument (and its Text/Presentation/Spreadsheet/Note
 * subtypes), and SoftwareApplication (and its WebApplication and
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
 * Single source of truth lives in `inlanguage-whitelist.data.mjs` so the
 * Node-only validator script (`scripts/validate-structured-data-completeness.mjs`)
 * can import it without a TypeScript transformer.
 */

import { TYPES_ACCEPT_IN_LANGUAGE_LIST } from './inlanguage-whitelist.data.mjs';

export const TYPES_ACCEPT_IN_LANGUAGE: ReadonlySet<string> = new Set(
 TYPES_ACCEPT_IN_LANGUAGE_LIST as readonly string[],
);
