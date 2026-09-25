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

import { imageObjectLd } from './imageObjectLd';

export const ORGANIZATION_ID = 'https://frontaliereticino.ch/#organization';

const SITE = 'https://frontaliereticino.ch';

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
 * it does now carry that it did not is `@type: NewsMediaOrganization` and
 * `sameAs`: those are what let a page-local parser resolve this to the same
 * real-world publisher the homepage describes, which is the entire point of
 * a shared `@id`.
 */
export const ORGANIZATION_LD = {
  // NewsMediaOrganization, not Organization. It is the type Google's news and
  // Preferred-Sources surfaces expect from a publisher, and it is a strict
  // subtype — every consumer that accepted Organization accepts this.
  // It was already used on /chi-siamo/ and in the SPA's home entry, so the
  // site was asserting two different @types for one @id.
  '@type': 'NewsMediaOrganization',
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
