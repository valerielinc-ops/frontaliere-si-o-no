import { TYPES_ACCEPT_IN_LANGUAGE } from './inlanguage-whitelist';
import { ORGANIZATION_ID, ORGANIZATION_LD } from './organizationLd';

const ARTICLE_SCHEMA_TYPES = new Set(['Article', 'NewsArticle', 'BlogPosting']);
const DEFAULT_ARTICLE_IMAGE = 'https://frontaliereticino.ch/og-image.png';

const DEFAULT_ARTICLE_AUTHOR = {
 '@type': 'Organization',
 '@id': ORGANIZATION_ID,
 name: ORGANIZATION_LD.name,
 url: ORGANIZATION_LD.url,
} as const;

function isRecord(value: unknown): value is Record<string, any> {
 return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isArticleSchema(record: Record<string, any>): boolean {
 const typeValue = record['@type'];
 return typeof typeValue === 'string'
  ? ARTICLE_SCHEMA_TYPES.has(typeValue)
  : Array.isArray(typeValue) && typeValue.some((type) => ARTICLE_SCHEMA_TYPES.has(type));
}

function normalizeArticleEntity(
 value: unknown,
 fallback: Record<string, any>,
): Record<string, any> {
 if (!isRecord(value)) return { ...fallback };

 const out = { ...fallback, ...value };
 if (!out.name) out.name = fallback.name;
 if (!out.url) out.url = fallback.url;
 return out;
}

function normalizeArticleNode(record: Record<string, any>): Record<string, any> {
 if (!isArticleSchema(record)) return record;

 // Static SEO pages are standalone documents. A bare #organization pointer is
 // resolvable in the SPA graph but not by a page-local crawler, so expand it to
 // the same named entities used by the rest of the site.
 record.author = normalizeArticleEntity(record.author, DEFAULT_ARTICLE_AUTHOR);
 record.publisher = normalizeArticleEntity(record.publisher, ORGANIZATION_LD);

 // Keep the source's specific image (and its dimensions/license metadata), but
 // make legacy ImageObjects self-contained and provide the safe site fallback
 // for older Article entries that had no image at all.
 if (!record.image) {
  record.image = DEFAULT_ARTICLE_IMAGE;
 } else if (isRecord(record.image) && record.image['@type'] === 'ImageObject') {
  const imageUrl = record.image.contentUrl ?? record.image.url;
  if (imageUrl) {
   record.image.contentUrl ??= imageUrl;
   record.image.url ??= imageUrl;
  }
 }

 return record;
}

const DEFAULT_DATASET_LICENSE = 'https://creativecommons.org/licenses/by-nc/4.0/';
const DEFAULT_APP_CATEGORY = 'FinanceApplication';
const DEFAULT_OPERATING_SYSTEM = 'Web';
const DEFAULT_OFFER = {
 '@type': 'Offer',
 price: '0',
 priceCurrency: 'CHF',
} as const;

function normalizeOffer(value: unknown): Record<string, any> {
 if (!value || typeof value !== 'object' || Array.isArray(value)) {
  return { ...DEFAULT_OFFER };
 }

 const offer = { ...(value as Record<string, any>) };
 if (!offer['@type']) offer['@type'] = 'Offer';
 if (offer.price === undefined || offer.price === null || offer.price === '') {
  offer.price = DEFAULT_OFFER.price;
 }
 if (!offer.priceCurrency) {
  offer.priceCurrency = DEFAULT_OFFER.priceCurrency;
 }
 return offer;
}

function isSchemaType(record: Record<string, any>, expected: string): boolean {
 const typeValue = record['@type'];
 if (typeValue === expected) return true;
 return Array.isArray(typeValue) && typeValue.includes(expected);
}

function isAppSchema(record: Record<string, any>): boolean {
 return isSchemaType(record, 'WebApplication') || isSchemaType(record, 'SoftwareApplication');
}

function normalizeSchemaObject(record: Record<string, any>): Record<string, any> {
 if (isSchemaType(record, 'Dataset') && !record.license) {
  record.license = DEFAULT_DATASET_LICENSE;
 }

 if (isAppSchema(record)) {
  if (!record.applicationCategory) {
   record.applicationCategory = DEFAULT_APP_CATEGORY;
  }
  if (
   !record.operatingSystem ||
   record.operatingSystem === 'Web Browser' ||
   record.operatingSystem === 'All'
  ) {
   record.operatingSystem = DEFAULT_OPERATING_SYSTEM;
  }
  record.offers = normalizeOffer(record.offers);
  if (record.isAccessibleForFree === undefined && String(record.offers.price) === '0') {
   record.isAccessibleForFree = true;
  }
  if ('speakable' in record) {
   delete record.speakable;
  }
  // Note: aggregateRating is NOT auto-injected. Faking review data violates
  // Google's structured-data guidelines (manual-action risk). Pages that
  // genuinely qualify as a SoftwareApplication should declare their own
  // ratings explicitly; SEO landing pages without real reviews must instead
  // use a non-app @type (WebPage / CollectionPage / Article).
 }

 if (record.inLanguage !== undefined) {
  const typeValue = record['@type'];
  const primaryType = Array.isArray(typeValue) ? typeValue[0] : typeValue;
  if (typeof primaryType === 'string' && !TYPES_ACCEPT_IN_LANGUAGE.has(primaryType)) {
   delete record.inLanguage;
  }
 }

 return record;
}

export function normalizeStructuredData<T>(value: T): T {
 if (Array.isArray(value)) {
  return value.map((item) => normalizeStructuredData(item)) as T;
 }
 if (!value || typeof value !== 'object') {
  return value;
 }

 const cloned: Record<string, any> = {};
 for (const [key, nested] of Object.entries(value as Record<string, any>)) {
  cloned[key] = normalizeStructuredData(nested);
 }
 return normalizeSchemaObject(cloned) as T;
}

/**
 * Completes Article-like nodes emitted by the legacy static SEO registry.
 *
 * Newer emitters construct these fields explicitly; this pass is the safety
 * net for older hand-authored entries and for translated locale variants.
 * It is intentionally separate from the generic schema normalizer so a
 * missing Article field cannot silently be invented in unrelated schema types.
 */
export function normalizeArticleStructuredData<T>(value: T): T {
 if (Array.isArray(value)) {
  return value.map((item) => normalizeArticleStructuredData(item)) as T;
 }
 if (!isRecord(value)) return value;

 const cloned: Record<string, any> = {};
 for (const [key, nested] of Object.entries(value)) {
  cloned[key] = normalizeArticleStructuredData(nested);
 }
 return normalizeArticleNode(cloned) as T;
}
