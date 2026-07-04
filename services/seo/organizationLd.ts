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

export const ORGANIZATION_ID = 'https://frontaliereticino.ch/#organization';

/** Compact Organization node — embeddable as publisher/author value. */
export const ORGANIZATION_LD = {
  '@type': 'Organization',
  '@id': ORGANIZATION_ID,
  name: 'Frontaliere Ticino',
  url: 'https://frontaliereticino.ch/',
  logo: {
    '@type': 'ImageObject',
    url: 'https://frontaliereticino.ch/icons/icon-512x512.png',
    width: 512,
    height: 512,
  },
} as const;

/** Standalone top-level node (with `@context`) for a page's JSON-LD graph. */
export const ORGANIZATION_LD_DOCUMENT = {
  '@context': 'https://schema.org',
  ...ORGANIZATION_LD,
} as const;

/**
 * Pre-serialized `ORGANIZATION_LD_DOCUMENT`. Contains no `<` characters, so
 * it is safe to interpolate raw inside `<script type="application/ld+json">`.
 * Also used as an idempotency marker: emitters check `includes()` before
 * appending so re-running a build step never duplicates the node.
 */
export const ORGANIZATION_LD_JSON = JSON.stringify(ORGANIZATION_LD_DOCUMENT);
