/**
 * organizationLd — canonical site Organization entity (`#organization`).
 *
 * Single source of truth for the Organization node referenced across the
 * site's JSON-LD as `{"@id": "https://frontaliereticino.ch/#organization"}`
 * (Article publisher/author, WebSite publisher, Person worksFor, …).
 *
 * The rich Knowledge-Panel definition lives in `index.html` (FRO-307), so
 * the SPA document always resolves the reference. Static SSG pages are
 * standalone documents that only carry the bare `@id` pointer: page-local
 * structured-data parsers (search/AI crawlers) cannot resolve the entity
 * there unless the page graph defines it too (audit #3524). Emitters that
 * reference `#organization` in static HTML must therefore inline this
 * compact node (or append `ORGANIZATION_LD_JSON` to the page's JSON-LD).
 *
 * Keep `name`/`url`/`logo` in sync with the index.html Organization block.
 */

import { imageObjectLd, SITE_ORGANIZATION_ID } from './imageObjectLd';

export const ORGANIZATION_ID = SITE_ORGANIZATION_ID;

const SITE = 'https://frontaliereticino.ch';
export const SITE_URL = `${SITE}/`;

const SITE_ORGANIZATION_NAME = 'Frontaliere Ticino';
const ORGANIZATION_ID_PREFIX = `${SITE}/#organization-`;

/**
 * Return a URL-safe, deterministic key for an organization name.
 *
 * Name-only organizations are common in nested ImageObject and ItemList
 * nodes. Their exact display name is the only fact shared by those nodes, so
 * keeping the key derived from that name makes the identity stable across
 * locales and builds without inventing a page URL for the external entity.
 */
function organizationNameHash(name: string): string {
  // Two independent 32-bit lanes provide a compact 64-bit suffix without
  // requiring a platform crypto API. Hash the complete original name so two
  // names with the same readable prefix cannot share the fallback identity.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ (code + index), 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`;
}

function organizationNameKey(name: string): string {
  const normalized = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const readable = normalized.slice(0, 96);
  return normalized.length > 96 ? `${readable}-${organizationNameHash(name)}` : readable;
}

function httpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function firstSameAsUrl(value: unknown): string | undefined {
  const candidates = Array.isArray(value) ? value : [value];
  return candidates.map(httpUrl).find((candidate): candidate is string => Boolean(candidate));
}

export interface OrganizationIdentityInput {
  '@id'?: unknown;
  name?: unknown;
  url?: unknown;
  sameAs?: unknown;
  '@type'?: unknown;
}

/**
 * Resolve the stable identifier for a JSON-LD Organization node.
 *
 * Explicit IDs always win, except for the site's own stale IDs when a
 * first-party URL proves the canonical `#organization` identity. Official URLs
 * are the next strongest identity. A deterministic site-scoped fragment is the
 * fallback for named, name-only organizations that recur in nested schema.
 * The site name without a URL is deliberately left anonymous: a same-name
 * newsroom supplied by an external source must not be merged into the site.
 */
export function stableOrganizationId(record: OrganizationIdentityInput): string | undefined {
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const url = httpUrl(record.url);
  const siteOwnedUrl = Boolean(url && url.startsWith(SITE_URL));

  // Locale paths and other first-party pages still identify the one site
  // publisher; do not mint a different graph node for each translated URL.
  if (name === SITE_ORGANIZATION_NAME && siteOwnedUrl) return ORGANIZATION_ID;

  if (typeof record['@id'] === 'string' && record['@id'].trim()) {
    return record['@id'].trim();
  }
  if (url) return url;

  const sameAsUrl = firstSameAsUrl(record.sameAs);
  if (sameAsUrl) return sameAsUrl;

  // Unknown-author is a placeholder, not an entity that a crawler can merge.
  if (!name || name.toLowerCase() === 'unknown author') return undefined;
  if (name === SITE_ORGANIZATION_NAME) return undefined;

  const key = organizationNameKey(name);
  return key ? `${ORGANIZATION_ID_PREFIX}${key}` : undefined;
}

function isOrganizationRecord(record: Record<string, unknown>): boolean {
  const type = record['@type'];
  return type === 'Organization'
    || (Array.isArray(type) && type.includes('Organization'));
}

/**
 * Add stable IDs to Organization nodes in a JSON-LD value without mutating
 * the caller's object. This focused pass is safe for the shared JSON script
 * serializer, including article-engine emitters that cannot import the site's
 * larger schema normalizer because of the package boundary.
 */
export function normalizeOrganizationIdentities<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeOrganizationIdentities(item)) as T;
  }
  if (!value || typeof value !== 'object') return value;

  const cloned: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    cloned[key] = normalizeOrganizationIdentities(nested);
  }
  if (isOrganizationRecord(cloned) && !stableOrganizationId(cloned)) {
    // `stableOrganizationId` returns the explicit ID for identified nodes, so
    // this branch only handles empty/invalid records and keeps them as-is.
    return cloned as T;
  }
  if (isOrganizationRecord(cloned)) {
    const id = stableOrganizationId(cloned);
    if (id) cloned['@id'] = id;
  }
  return cloned as T;
}

/** Stable graph identity for the site-level WebSite entity. */
export const WEBSITE_ID = `${SITE}/#website`;

/**
 * Stable identity for the editorial team named in article bylines.
 *
 * The team is an authoring organization, while `#organization` identifies
 * the Frontaliere Ticino publisher. Reusing the publisher id for both makes
 * a graph merge two different names and URLs into one entity.
 */
export const EDITORIAL_TEAM_ID = `${SITE}/chi-siamo/#team`;

/** Stable source identity for the Ticino customs webcam attribution. */
export const TICINO_CUSTOMS_DEPARTMENT_ID = 'https://www.ti.ch/webcam';
export const TICINO_CUSTOMS_DEPARTMENT_NAME = 'Dipartimento del territorio – Canton Ticino';

/**
 * Profiles that anchor this entity to the same real-world organization
 * elsewhere. `sameAs` is how a knowledge graph decides two nodes are one
 * thing, so it belongs on the node every page carries — not only on the
 * homepage's hand-written block, which is where it used to live alone.
 */
export const ORGANIZATION_SAME_AS = [
  'https://www.facebook.com/profile.php?id=61588174947294',
  'https://www.facebook.com/frontaliereticino',
  'https://www.linkedin.com/company/frontaliere-ticino',
  'https://github.com/valerielinc-ops/frontaliere-si-o-no',
] as const;

/**
 * The publisher-transparency URLs Google's news surfaces read
 * (`developers.google.com/search/docs/appearance/structured-data/article`
 * and Publisher Center's transparency guidance).
 *
 * Every one of these MUST resolve to a page that returns 200 and actually
 * contains the section it names — `tests/organization-entity-consolidation.test.ts`
 * pins the anchors against the components that render them. The previous
 * `verificationFactCheckingPolicy` pointed at `/metodologia/#fact-checking`
 * and `components/pages/Metodologia.tsx` had no `id` attributes at all, so
 * the fragment resolved to nothing.
 */
export const ORGANIZATION_POLICIES = {
  correctionsPolicy: `${SITE}/correzioni/`,
  ethicsPolicy: `${SITE}/chi-siamo/#standard-giornalistici`,
  ownershipFundingInfo: `${SITE}/chi-siamo/#finanziamento`,
  masthead: `${SITE}/chi-siamo/#team`,
  verificationFactCheckingPolicy: `${SITE}/metodologia/#fact-checking`,
  /**
   * Both were absent everywhere in the codebase before this. They are the two
   * remaining properties Google lists for publisher transparency, and the
   * pages they point at already exist and already carry the content — only the
   * declaration was missing.
   */
  publishingPrinciples: `${SITE}/metodologia/`,
  actionableFeedbackPolicy: `${SITE}/contattaci/`,
} as const;

/**
 * Compact node — the value embedded wherever another entity REFERENCES this
 * one (Article publisher, Person worksFor, WebSite publisher).
 *
 * Deliberately not the full entity: this is inlined into every one of ~12k
 * article pages as `publisher`, so the transparency block would be paid for
 * per page for no gain — a referencing node needs identity, not policy. What
 * it does now carry that it did not is `@type: Organization` and
 * `sameAs`: those are what let a page-local parser resolve this to the same
 * real-world publisher the homepage describes, which is the entire point of
 * a shared `@id`.
 */
export const ORGANIZATION_LD = {
  // Google reports NewsMediaOrganization as an invalid creator/publisher
  // in Dataset and Image Metadata (URL Inspection, 2026-10-03). Use its
  // explicitly supported base type everywhere this identity is referenced.
  '@type': 'Organization',
  '@id': ORGANIZATION_ID,
  name: 'Frontaliere Ticino',
  url: 'https://frontaliereticino.ch/',
  sameAs: [...ORGANIZATION_SAME_AS],
  // GSC licensable-image quintet (acquireLicensePage/copyrightNotice/license/
  // creator/creditText) via the shared builder — a hand-rolled ImageObject
  // here was missing all five, and every consumer (SCHEMA_PUBLISHER,
  // staticPagesPlugin's #organization fallback, seo-correzioni, Correzioni.tsx,
  // Metodologia.tsx) inherited the gap (audit:image-object-license, 336 pages).
  logo: imageObjectLd({
    contentUrl: 'https://frontaliereticino.ch/icons/icon-512x512.png',
    width: 512,
    height: 512,
  }),
} as const;

/**
 * Founding year. ONE value, because there were two: `index.html` said 2023 and
 * `services/seo/seo-pages.ts` said 2024, both under the same `@id`. A graph
 * cannot hold both, and a consumer that sees them disagree has no reason to
 * trust either. 2023 wins because it is the value actually served on the
 * homepage today, i.e. the one already crawled.
 */
export const ORGANIZATION_FOUNDING_DATE = '2023';

/**
 * The FULL entity — identity plus the publisher-transparency block.
 *
 * Belongs on pages that DESCRIBE the organization rather than merely
 * reference it: the homepage, /chi-siamo/, and any standalone graph node.
 * Before this existed the same `@id` had four disjoint definitions
 * (index.html, two in seo-pages.ts, and the compact node above): different
 * `@type`, different `foundingDate`, `sameAs` present in one and absent in
 * two, the policy block present in two and absent in two. Consolidating them
 * is the point — a knowledge graph resolves `@id` collisions by picking, and
 * we were giving it four things to pick between.
 */
export const ORGANIZATION_LD_FULL = {
  ...ORGANIZATION_LD,
  additionalType: 'https://schema.org/NewsMediaOrganization',
  foundingDate: ORGANIZATION_FOUNDING_DATE,
  description:
    'Piattaforma informativa per frontalieri italiani in Svizzera: tassazione, permessi, lavoro, sanità e aggiornamenti normativi.',
  contactPoint: {
    '@type': 'ContactPoint',
    contactType: 'customer support',
    url: 'https://frontaliereticino.ch/contattaci/',
    availableLanguage: ['Italian', 'English', 'German', 'French'],
  },
  areaServed: [
    { '@type': 'Country', name: 'Switzerland' },
    { '@type': 'Country', name: 'Italy' },
  ],
  ...ORGANIZATION_POLICIES,
} as const;

/** Standalone top-level node (with `@context`) for a page's JSON-LD graph. */
export const ORGANIZATION_LD_DOCUMENT = {
  '@context': 'https://schema.org',
  ...ORGANIZATION_LD_FULL,
} as const;

/**
 * Pre-serialized `ORGANIZATION_LD_DOCUMENT`. Contains no `<` characters, so
 * it is safe to interpolate raw inside `<script type="application/ld+json">`.
 * Also used as an idempotency marker: emitters check `includes()` before
 * appending so re-running a build step never duplicates the node.
 */
export const ORGANIZATION_LD_JSON = JSON.stringify(ORGANIZATION_LD_DOCUMENT);
