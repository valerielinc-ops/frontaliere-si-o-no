/**
 * Which editorial sitemap groups a build may advertise (Issue 18 invariant:
 * never advertise a URL whose static HTML was not emitted).
 *
 * The decision depends on which locales the build renders (`BUILD_LOCALE`):
 *
 *  - A build that emits IT (the monolithic build and the IT leg) gates the
 *    whole group on the IT page: it is the x-default/canonical fallback, and it
 *    cannot probe sibling-locale files, which belong to other legs.
 *  - A build that does NOT emit IT (`BUILD_LOCALE=de|en|fr`) never writes the IT
 *    file, so probing it hid every editorial entry from that locale's sitemap and
 *    page manifest while the live IT-built sitemap still advertised the URL
 *    (publisher fast gate, class 2). Such a build can only vouch for the locales
 *    it renders: it advertises the group of an owned locale only when that
 *    locale's own page was emitted, and it publishes nothing when none was.
 *
 * Pure on purpose: the filesystem probe and the locale ownership are injected,
 * so the contract is testable without a build.
 */
export interface EditorialSitemapEmitGateInput<TLocale extends string> {
  /** Locales whose pages are indexable for this entry (already decided by the caller). */
  readonly sitemapLocales: readonly TLocale[];
  /** Absolute site path (with trailing slash) of the entry in each locale. */
  readonly localePaths: ReadonlyMap<TLocale, string>;
  /** `shouldEmitLocale`: does THIS build render the locale. */
  readonly emitsLocale: (locale: TLocale) => boolean;
  /** Ground truth for "this build wrote the HTML for that path". */
  readonly pageEmitted: (path: string) => boolean;
}

export interface EditorialSitemapEmitGate<TLocale extends string> {
  /** Whether the group whose `<loc>` is in `locale` may be advertised. */
  advertises(locale: TLocale): boolean;
}

/** `null` when the entry must not be advertised at all by this build. */
export function editorialSitemapEmitGate<TLocale extends string>(
  input: EditorialSitemapEmitGateInput<TLocale>,
  itLocale: TLocale = 'it' as TLocale,
): EditorialSitemapEmitGate<TLocale> | null {
  const { sitemapLocales, localePaths, emitsLocale, pageEmitted } = input;
  if (!sitemapLocales.includes(itLocale)) return null;
  const pathOf = (locale: TLocale): string | undefined => localePaths.get(locale);
  const emitted = (locale: TLocale): boolean => {
    const path = pathOf(locale);
    return path !== undefined && pageEmitted(path);
  };

  if (emitsLocale(itLocale)) {
    return emitted(itLocale) ? { advertises: () => true } : null;
  }
  const ownedEmitted = sitemapLocales.some((locale) => emitsLocale(locale) && emitted(locale));
  if (!ownedEmitted) return null;
  return {
    advertises: (locale) => !emitsLocale(locale) || emitted(locale),
  };
}
