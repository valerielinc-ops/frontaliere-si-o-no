import { TYPES_ACCEPT_IN_LANGUAGE } from './inlanguage-whitelist';
import {
 ORGANIZATION_ID,
 ORGANIZATION_LD,
 SITE_URL,
 TICINO_CUSTOMS_DEPARTMENT_ID,
 TICINO_CUSTOMS_DEPARTMENT_NAME,
 stableOrganizationId,
 WEBSITE_ID,
} from './organizationLd';
import { isSiteOrganizationCreator } from './imageObjectLd';

const ARTICLE_SCHEMA_TYPES = new Set(['Article', 'NewsArticle', 'BlogPosting']);
const DEFAULT_ARTICLE_IMAGE = 'https://frontaliereticino.ch/og-image.png';
const DEFAULT_ARTICLE_AUTHOR = {
 '@type': 'Organization',
 '@id': ORGANIZATION_ID,
 name: ORGANIZATION_LD.name,
 url: ORGANIZATION_LD.url,
} as const;

/** Schema types whose URL/@id identify the page or page-like entity itself. */
export const PAGE_IDENTITY_TYPES: ReadonlySet<string> = new Set([
 'WebPage',
 'AboutPage',
 'CollectionPage',
 'ContactPage',
 'FAQPage',
 'ItemPage',
 'MedicalWebPage',
 'ProfilePage',
 'QAPage',
 'SearchResultsPage',
 'DefinedTermSet',
 'DefinedTerm',
]);

export interface SchemaEntityConflict {
 key: string;
 fields: string[];
 paths: string[];
 values: Record<string, string[]>;
}

export interface SchemaNormalizationOptions {
 /** Keep name-only Organization identities when the source has no URL or @id. */
 readonly allowNameOnlyOrganizationIds?: boolean;
 /** Throw after normalization if two definitions still disagree on identity fields. */
 readonly rejectConflicts?: boolean;
}

export interface SchemaNormalizationResult<T> {
 readonly normalized: T;
 readonly schemaEntityConflicts: readonly SchemaEntityConflict[];
}

/** Conflicts from the most recent normalization pass, for build/audit telemetry. */
export const schemaEntityConflicts: SchemaEntityConflict[] = [];

export function clearSchemaEntityConflicts(): void {
 schemaEntityConflicts.length = 0;
}

interface SchemaEntityObservation {
 readonly path: string;
 readonly values: Record<string, string>;
}

interface SchemaNormalizationContext {
 readonly options: SchemaNormalizationOptions;
 readonly entities: Map<string, SchemaEntityObservation[]>;
 readonly conflicts: SchemaEntityConflict[];
 readonly conflictBySignature: Map<string, SchemaEntityConflict>;
}

function isRecord(value: unknown): value is Record<string, any> {
 return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isArticleSchema(record: Record<string, any>): boolean {
 const typeValue = record['@type'];
 return typeof typeValue === 'string'
  ? ARTICLE_SCHEMA_TYPES.has(typeValue)
  : Array.isArray(typeValue) && typeValue.some((type) => ARTICLE_SCHEMA_TYPES.has(type));
}

function applyCanonicalSiteOrganizationIdentity(record: Record<string, any>): void {
 // The explicit site @id is the authoritative identity. Leaving stale name or
 // URL fields beside it creates contradictory definitions of the same node.
 record['@type'] = ORGANIZATION_LD['@type'];
 record['@id'] = ORGANIZATION_ID;
 record.name = ORGANIZATION_LD.name;
 record.url = ORGANIZATION_LD.url;
}

function normalizeArticleEntity(
 value: unknown,
 fallback: Record<string, any>,
): Record<string, any> {
 if (!isRecord(value)) return { ...fallback };

 // Only explicit site identities can inherit the publisher's fields.
 // A shared name (with or without an external ID) is not proof of identity.
 if (value['@id'] !== ORGANIZATION_ID && !isSiteOrganizationCreator(value)) return { ...value };
 const out = { ...fallback, ...value };
 applyCanonicalSiteOrganizationIdentity(out);
 return out;
}

function normalizeArticleNode(record: Record<string, any>): Record<string, any> {
 if (!isArticleSchema(record)) return record;

 // A page is an Article only when its publication is editorially documented.
 // Generated landing pages used to claim Article/NewsArticle while omitting
 // datePublished because their data refresh or build time is not a publication
 // event. Keep the factual fields below, but describe those evergreen pages as
 // WebPage rather than inventing a date.
 const hasEditorialPublicationDate = typeof record.datePublished === 'string'
  && record.datePublished.trim().length > 0;
 if (!hasEditorialPublicationDate) record['@type'] = 'WebPage';

 // The type conversion above happens after the generic pass, so run the
 // WebPage identity completion once more for legacy evergreen Article nodes.
 normalizeWebPageIdentity(record);

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
 if (isRecord(record.image)) normalizeImageObjectCredit(record.image);

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

/**
 * Return a usable page URL from a schema reference.  A few legacy emitters
 * identify the page only through `mainEntityOfPage` or an `@id` ending in a
 * fragment (`#article`, `#page`, ...).  Schema validators inspect nested
 * WebPage nodes as well as the top-level node, so keeping the canonical URL
 * on the node itself avoids a validator having to resolve those references.
 */
function schemaReferenceUrl(value: unknown): string | undefined {
 const candidate = typeof value === 'string'
  ? value
  : isRecord(value)
    ? (typeof value.url === 'string' ? value.url : value['@id'])
    : undefined;
 if (typeof candidate !== 'string' || !candidate.trim()) return undefined;
 const withoutFragment = candidate.split('#', 1)[0];
 return withoutFragment || undefined;
}

/**
 * Complete the two required identity fields for WebPage nodes when the
 * emitter already supplied an equivalent page identity.  This is deliberately
 * conservative: a page with no headline and no resolvable URL remains
 * unchanged rather than receiving fabricated metadata.
 */
function normalizeWebPageIdentity(record: Record<string, any>): void {
 if (!isSchemaType(record, 'WebPage')) return;
 if (!record.name) {
  const fallbackName = typeof record.headline === 'string'
    ? record.headline
    : typeof record.title === 'string'
      ? record.title
      : undefined;
  if (fallbackName) record.name = fallbackName;
 }
 if (!record.url) {
  const referenceUrl = schemaReferenceUrl(record.mainEntityOfPage)
    ?? schemaReferenceUrl(record['@id']);
  if (referenceUrl) record.url = referenceUrl;
 }
}

function schemaEntityReference(value: unknown): string | undefined {
 if (typeof value !== 'string' || !value.trim()) return undefined;
 return value.trim();
}

function schemaTypeSignature(record: Record<string, any>): string | undefined {
 const rawType = record['@type'];
 const types = (Array.isArray(rawType) ? rawType : [rawType])
  .filter((type): type is string => typeof type === 'string' && type.trim().length > 0)
  .map((type) => type.trim());
 if (types.length === 0) return undefined;
 return [...new Set(types)].sort().join('|');
}

function comparableSchemaValue(field: string, value: unknown): string | undefined {
 if (field === '@type') return typeof value === 'string' && value.trim() ? value.trim() : undefined;
 if (typeof value !== 'string' || !value.trim()) return undefined;
 const normalized = value.normalize('NFC').replace(/\s+/g, ' ').trim();
 if (!normalized) return undefined;
 if (field === 'url' || field === 'creator') {
  return schemaReferenceUrl(normalized) ?? normalized;
 }
 return normalized;
}

function creatorIdentity(value: unknown): string | undefined {
 if (isRecord(value)) {
  return schemaEntityReference(value['@id'])
   ?? schemaReferenceUrl(value.url)
   ?? comparableSchemaValue('name', value.name);
 }
 if (Array.isArray(value)) {
  const identities = value.map(creatorIdentity);
  const [firstIdentity] = identities;
  if (firstIdentity === undefined || identities.some((identity) => identity === undefined)) {
   return undefined;
  }
  return identities.every((identity) => identity === firstIdentity) ? firstIdentity : undefined;
 }
 return comparableSchemaValue('creator', value);
}

function creatorName(value: unknown): string | undefined {
 if (isRecord(value)) return comparableSchemaValue('name', value.name);
 if (Array.isArray(value)) {
  const names = value.map(creatorName);
  const [firstName] = names;
  if (firstName === undefined || names.some((name) => name === undefined)) {
   return undefined;
  }
  return names.every((name) => name === firstName) ? firstName : undefined;
 }
 return undefined;
}

function schemaEntityKey(record: Record<string, any>): string | undefined {
 const explicitId = schemaEntityReference(record['@id']);
 if (explicitId) return `@id:${explicitId}`;

 const types = new Set(
  (Array.isArray(record['@type']) ? record['@type'] : [record['@type']])
   .filter((type): type is string => typeof type === 'string'),
 );
 if ([...types].some((type) => PAGE_IDENTITY_TYPES.has(type))) {
  const pageUrl = schemaReferenceUrl(record.url);
  if (pageUrl) return `url:${pageUrl}`;
 }
 if (types.has('ImageObject')) {
  const imageUrl = schemaReferenceUrl(record.contentUrl ?? record.url);
  if (imageUrl) return `image:${imageUrl}`;
 }
 return undefined;
}

function schemaEntityValues(record: Record<string, any>): Record<string, string> {
 const values: Record<string, string> = {};
 const typeSignature = schemaTypeSignature(record);
 if (typeSignature) values['@type'] = typeSignature;

 const types = new Set(
  (Array.isArray(record['@type']) ? record['@type'] : [record['@type']])
   .filter((type): type is string => typeof type === 'string'),
 );
 const isPage = [...types].some((type) => PAGE_IDENTITY_TYPES.has(type));
 const isOrganization = types.has('Organization') || types.has('NewsMediaOrganization');
 if (isPage || isOrganization) {
  const name = comparableSchemaValue('name', record.name);
  if (name) values.name = name;
 }
 if (isOrganization) {
  const url = comparableSchemaValue('url', record.url);
  if (url) values.url = url;
 }
 if (types.has('ImageObject')) {
  const creator = creatorIdentity(record.creator);
  if (creator) values.creator = creator;
  const creditText = comparableSchemaValue('creditText', record.creditText);
  if (creditText) values.creditText = creditText;
 }
 return values;
}

function mergeConflict(
 conflict: SchemaEntityConflict,
 previous: SchemaEntityObservation,
 current: SchemaEntityObservation,
 fields: readonly string[],
): void {
 const paths = new Set([...conflict.paths, previous.path, current.path]);
 const values: Record<string, string[]> = {};
 for (const field of fields) {
  values[field] = [...new Set([
   ...(conflict.values[field] ?? []),
   previous.values[field],
   current.values[field],
  ].filter((value): value is string => Boolean(value)))];
 }
 conflict.paths = [...paths];
 conflict.fields = [...new Set([...conflict.fields, ...fields])];
 conflict.values = values;
}

function registerSchemaEntity(
 record: Record<string, any>,
 path: string,
 context: SchemaNormalizationContext,
): void {
 const key = schemaEntityKey(record);
 if (!key) return;
 const current: SchemaEntityObservation = { path, values: schemaEntityValues(record) };
 const previous = context.entities.get(key) ?? [];
 for (const prior of previous) {
  const fields = Object.keys(current.values).filter((field) => {
   const before = prior.values[field];
   const after = current.values[field];
   return Boolean(before && after && before !== after);
  });
  if (fields.length === 0) continue;

  const signature = `${key}\u0000${[...fields].sort().join(',')}`;
  const existing = context.conflictBySignature.get(signature);
  if (existing) {
   mergeConflict(existing, prior, current, fields);
   continue;
  }

  const conflict: SchemaEntityConflict = {
   key,
   fields,
   paths: [prior.path, current.path],
   values: Object.fromEntries(fields.map((field) => [field, [prior.values[field], current.values[field]]])),
  };
  context.conflictBySignature.set(signature, conflict);
  context.conflicts.push(conflict);
 }
 previous.push(current);
 context.entities.set(key, previous);
}

function normalizeImageObjectCredit(record: Record<string, any>): void {
 if (
  !isSchemaType(record, 'ImageObject')
  || (typeof record.creditText === 'string' && record.creditText.trim())
 ) return;
 const name = creatorName(record.creator);
 if (name) record.creditText = name;
}

function isSiteWebSite(record: Record<string, any>): boolean {
 return isSchemaType(record, 'WebSite')
  && (record['@id'] === WEBSITE_ID
   || (record.name === 'Frontaliere Ticino'
    && (record.url === SITE_URL || record.url === SITE_URL.slice(0, -1))));
}

function isAppSchema(record: Record<string, any>): boolean {
 return isSchemaType(record, 'WebApplication') || isSchemaType(record, 'SoftwareApplication');
}

function normalizeSchemaObject(
 record: Record<string, any>,
 options: SchemaNormalizationOptions,
): Record<string, any> {
 normalizeWebPageIdentity(record);

 // Every static SEO generator describes the same site WebSite. Give it one
 // graph identity so crawlers do not retain thousands of anonymous copies.
 if (isSiteWebSite(record)) record['@id'] = WEBSITE_ID;

 // Webcam attribution names the Ticino Department of Territory. The source
 // URL is its stable identity; keep it distinct from the publisher entity.
 if (
  isSchemaType(record, 'Organization')
  && record.name === TICINO_CUSTOMS_DEPARTMENT_NAME
  && (!record['@id'] || record['@id'] === TICINO_CUSTOMS_DEPARTMENT_ID)
 ) {
  record['@id'] = TICINO_CUSTOMS_DEPARTMENT_ID;
  record.url = TICINO_CUSTOMS_DEPARTMENT_ID;
 }

 // Legacy records include both anonymous Organization nodes and the
 // NewsMediaOrganization subtype Google rejects in creator/publisher fields.
 // Reattach site records to the canonical identity and name while emitting the
 // base type. Some corpus rows use the hostname as the display name even though
 // their @id already points at this site Organization.
 if (isSiteOrganizationCreator(record)) {
  applyCanonicalSiteOrganizationIdentity(record);
 }

 // Repeated external organizations (for example image credits and nursing
 // employer lists) often have only a name. Give those nodes one deterministic
 // identity while preserving every explicit foreign @id above.
 if (isSchemaType(record, 'Organization')) {
  const stableId = stableOrganizationId(record, {
   allowNameOnlyFallback: options.allowNameOnlyOrganizationIds !== false,
  });
  if (stableId) record['@id'] = stableId;
 }

 normalizeImageObjectCredit(record);

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

function createNormalizationContext(options: SchemaNormalizationOptions): SchemaNormalizationContext {
 return {
  options,
  entities: new Map(),
  conflicts: [],
  conflictBySignature: new Map(),
 };
}

function normalizeStructuredDataValue(
 value: unknown,
 context: SchemaNormalizationContext,
 path: string,
): unknown {
 if (Array.isArray(value)) {
  return value.map((item, index) => normalizeStructuredDataValue(item, context, `${path}[${index}]`));
 }
 if (!value || typeof value !== 'object') return value;

 const cloned: Record<string, any> = {};
 for (const [key, nested] of Object.entries(value as Record<string, any>)) {
  cloned[key] = normalizeStructuredDataValue(nested, context, `${path}.${key}`);
 }
 const normalized = normalizeSchemaObject(cloned, context.options);
 registerSchemaEntity(normalized, path, context);
 return normalized;
}

function cloneConflicts(conflicts: readonly SchemaEntityConflict[]): SchemaEntityConflict[] {
 return conflicts.map((conflict) => ({
  key: conflict.key,
  fields: [...conflict.fields],
  paths: [...conflict.paths],
  values: Object.fromEntries(
   Object.entries(conflict.values).map(([field, values]) => [field, [...values]]),
  ),
 }));
}

function publishConflicts(conflicts: readonly SchemaEntityConflict[]): SchemaEntityConflict[] {
 const published = cloneConflicts(conflicts);
 schemaEntityConflicts.splice(0, schemaEntityConflicts.length, ...published);
 return published;
}

function assertNoSchemaEntityConflicts(conflicts: readonly SchemaEntityConflict[]): void {
 if (conflicts.length === 0) return;
 const summary = conflicts
  .map(({ key, fields }) => `${key} [${fields.join(', ')}]`)
  .join('; ');
 throw new Error(`Schema entity conflicts remain after normalization: ${summary}`);
}

export function normalizeStructuredDataWithDiagnostics<T>(
 value: T,
 options: SchemaNormalizationOptions = {},
): SchemaNormalizationResult<T> {
 const context = createNormalizationContext(options);
 const normalized = normalizeStructuredDataValue(value, context, '$') as T;
 const conflicts = publishConflicts(context.conflicts);
 if (options.rejectConflicts) assertNoSchemaEntityConflicts(conflicts);
 return { normalized, schemaEntityConflicts: conflicts };
}

export function normalizeStructuredData<T>(
 value: T,
 options: SchemaNormalizationOptions = {},
): T {
 return normalizeStructuredDataWithDiagnostics(value, options).normalized;
}

/**
 * Completes Article-like nodes emitted by the legacy static SEO registry.
 *
 * Newer emitters construct these fields explicitly; this pass is the safety
 * net for older hand-authored entries and for translated locale variants.
 * It is intentionally separate from the generic schema normalizer so a
 * missing Article field cannot silently be invented in unrelated schema types.
 */
function normalizeArticleStructuredDataValue(
 value: unknown,
 context: SchemaNormalizationContext,
 path: string,
): unknown {
 if (Array.isArray(value)) {
  return value.map((item, index) => normalizeArticleStructuredDataValue(item, context, `${path}[${index}]`));
 }
 if (!isRecord(value)) return value;

 const cloned: Record<string, any> = {};
 for (const [key, nested] of Object.entries(value)) {
  cloned[key] = normalizeArticleStructuredDataValue(nested, context, `${path}.${key}`);
 }
 const normalized = normalizeArticleNode(cloned);
 registerSchemaEntity(normalized, path, context);
 for (const [key, nested] of Object.entries(normalized)) {
  if (isRecord(nested)) registerSchemaEntity(nested, `${path}.${key}`, context);
 }
 return normalized;
}

export function normalizeArticleStructuredData<T>(
 value: T,
 options: SchemaNormalizationOptions = {},
): T {
 const context = createNormalizationContext(options);
 const normalized = normalizeArticleStructuredDataValue(value, context, '$') as T;
 const conflicts = publishConflicts(context.conflicts);
 if (options.rejectConflicts) assertNoSchemaEntityConflicts(conflicts);
 return normalized;
}
