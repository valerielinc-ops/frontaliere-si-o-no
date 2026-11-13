/**
 * Locale eligibility for pages that must be reflected in a shared sitemap.
 *
 * The set is computed from the same data-backed decision used by the page
 * emitter. It is independent of BUILD_LOCALE and of the current dist contents:
 * split builds intentionally do not write sibling-locale HTML into this dist.
 */
export function indexableLocalePageSet<TLocale extends string>(
  locales: readonly TLocale[],
  isIndexable: (locale: TLocale) => boolean,
): ReadonlySet<TLocale> {
  return new Set(locales.filter(isIndexable));
}

export function isIndexableLocalePage<TLocale extends string>(
  locale: TLocale,
  indexableLocales: ReadonlySet<TLocale>,
): boolean {
  return indexableLocales.has(locale);
}

export interface ReciprocalSitemapLocaleGroup<TLocale extends string> {
  locale: TLocale;
  href: string;
  alternates: Array<{ locale: TLocale; href: string }>;
}

/**
 * Build sitemap loc/alternate groups from the exact set of locales whose page
 * emitter decision is indexable. No filesystem probe is valid here: this
 * sitemap may be built by IT while sibling-locale pages are in other shards.
 */
export function reciprocalSitemapLocaleGroups<TLocale extends string>(
  locales: readonly TLocale[],
  indexableLocales: ReadonlySet<TLocale>,
  hrefFor: (locale: TLocale) => string,
): Array<ReciprocalSitemapLocaleGroup<TLocale>> {
  const eligible = locales.filter((locale) => isIndexableLocalePage(locale, indexableLocales));
  const alternates = eligible.map((locale) => ({ locale, href: hrefFor(locale) }));
  return eligible.map((locale) => ({
    locale,
    href: hrefFor(locale),
    alternates,
  }));
}

/**
 * Track deterministic page ownership by locale and exact route. Split builds
 * use this for pages emitted by earlier phases: an absent sibling file in the
 * current dist is not evidence that the route is available to another writer.
 */
export function createLocalePagePathClaims<TLocale extends string>(
  locales: readonly TLocale[],
) {
  const claims = new Map<TLocale, Set<string>>(
    locales.map((locale) => [locale, new Set<string>()]),
  );
  const normalize = (path: string): string => String(path).replace(/^\/+|\/+$/g, '');

  return {
    claim(locale: TLocale, path: string): void {
      claims.get(locale)?.add(normalize(path));
    },
    has(locale: TLocale, path: string): boolean {
      return claims.get(locale)?.has(normalize(path)) ?? false;
    },
  };
}
