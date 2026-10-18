/**
 * Cross-locale hreflang alternate block — ONE builder for page families whose
 * locale eligibility must be all-or-nothing.
 *
 * Why this module exists
 * ---------------------
 * Issue #5114: `audit:hreflang` reported 22 `missingTarget` offenders — IT
 * search landings declaring de/en/fr alternates whose target HTML was never
 * written (`/de/jobs-im-tessin/suche-addetto-alle-pulizie-ticino/` and
 * friends — note the untranslated Italian query, the signature of a
 * prefix-templated URL rather than a real per-locale page).
 *
 * The emitters built the four-locale block by templating each locale's
 * prefix onto the IT slug, UNCONDITIONALLY, while the decision to emit a
 * locale's page ran later and per-locale (a job-count floor evaluated
 * against that locale's own translations). Locales are visited IT-first, so
 * by the time DE was found ineligible the IT page had already been written —
 * advertising a DE URL that nothing would ever write.
 *
 * A broken hreflang is a hard error for Google; a MISSING hreflang is
 * tolerated. So the rule this module enforces is all-or-nothing:
 *
 *   - every required locale eligible → emit the full block (4 + x-default)
 *   - any required locale missing    → emit NOTHING
 *
 * Partial blocks are not an option: `scripts/audit-hreflang.mjs` fails any
 * page carrying 1..4 entries as `[tooFew]` ("need 4 locales + x-default")
 * and skips pages carrying zero. Thinning a set only trades `missingTarget`
 * for `tooFew`.
 *
 * The by-construction guarantee
 * -----------------------------
 * Callers pass the set of locales the build has ACTUALLY decided to emit, so
 * the alternate set and the emission decision derive from one source: a
 * locale cannot be advertised unless it was planned. The dist-existence
 * filter in `./hreflangGuard.ts` and the plan-based repair in
 * `packages/articles/engine/hreflangPostprocess.ts` stay as safety nets, NOT
 * as the primary mechanism — both are deliberately blind on a `BUILD_LOCALE`
 * shard (an absent sibling locale is by-design there), which is exactly how
 * these offenders reached the rehydrated dist the audit walks.
 */

/** The four locales every all-or-nothing page family must cover to carry hreflang. */
export const ALTERNATE_LOCALES = ['it', 'en', 'de', 'fr'] as const;

export type AlternateLocale = (typeof ALTERNATE_LOCALES)[number];

/**
 * Normalise a locale page path to the key used by the build's path-claim
 * registries. Tracking data may contain either URL shape, while those
 * registries store relative paths without a leading or trailing slash.
 */
export function localePathClaimKey(path: string): string {
  return String(path ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * Resolve whether every locale path is still available to one cluster and
 * retain the individually unclaimed paths for a collision-safe sitemap.
 *
 * Sharded builds render one locale at a time, but the winner of a colliding
 * tracking path must be identical on every shard. Callers therefore claim
 * all four paths before applying their BUILD_LOCALE write filter and use this
 * decision to void the whole block when an earlier slug already won one
 * member of the cluster.
 */
export interface LocaleClusterClaimDecision {
  /** Whether the cluster can advertise the complete cross-locale set. */
  readonly hasUnclaimedCluster: boolean;
  /** Paths this cluster may still own, even when the full set is incomplete. */
  readonly unclaimedLocales: ReadonlySet<AlternateLocale>;
}

/**
 * Resolve cluster ownership once so HTML and sitemap emitters cannot make
 * different decisions about the same active/expired path collision.
 */
export function resolveLocaleClusterClaim(
  paths: Readonly<Partial<Record<AlternateLocale, string>>>,
  claimedPaths: ReadonlySet<string>,
): LocaleClusterClaimDecision {
  const normalizedKeys = new Set<string>();
  const unclaimedLocales = new Set<AlternateLocale>();
  let hasUnclaimedCluster = true;

  for (const locale of ALTERNATE_LOCALES) {
    const path = paths[locale];
    if (!path) {
      hasUnclaimedCluster = false;
      continue;
    }

    const normalizedKey = localePathClaimKey(path);
    if (normalizedKeys.has(normalizedKey)) {
      hasUnclaimedCluster = false;
      continue;
    }
    normalizedKeys.add(normalizedKey);

    if (claimedPaths.has(normalizedKey)) {
      hasUnclaimedCluster = false;
      continue;
    }
    unclaimedLocales.add(locale);
  }

  return { hasUnclaimedCluster, unclaimedLocales };
}

/** Return true when every locale path is still available to one cluster. */
export function hasUnclaimedLocaleCluster(
  paths: Readonly<Partial<Record<AlternateLocale, string>>>,
  claimedPaths: ReadonlySet<string>,
): boolean {
  return resolveLocaleClusterClaim(paths, claimedPaths).hasUnclaimedCluster;
}

export interface LocaleAlternateBlockOptions {
  /**
   * Locales the build has decided to emit for this slug. Anything not in
   * here is treated as "no page will exist", which voids the whole block.
   */
  readonly eligibleLocales: Iterable<string>;
  /** Absolute URL of this slug's page in `locale`. */
  readonly hrefFor: (locale: AlternateLocale) => string;
  /** Leading whitespace per line. Defaults to a single space. */
  readonly indent?: string;
}

/**
 * Render the `<link rel="alternate" hreflang>` block, or `''` when the
 * cross-locale set is incomplete.
 *
 * `x-default` always mirrors the IT href — `audit-hreflang` flags any
 * divergence as `xDefaultMismatch`. Since the block is only emitted when
 * every required locale (IT included) is eligible, that href is always a
 * page the build writes.
 */
export function buildLocaleAlternateBlock(opts: LocaleAlternateBlockOptions): string {
  const entries = buildLocaleAlternateEntries(opts);
  if (entries.length === 0) return '';

  const indent = opts.indent ?? ' ';
  return entries
    .map((e) => `${indent}<link rel="alternate" hreflang="${e.hreflang}" href="${e.href}">`)
    .join('\n');
}

/**
 * Render a complete alternate block only when every locale path is still
 * available to this cluster. Active pages and expired soft-landings can share
 * the same path registry, so a collision voids the block instead of making a
 * page advertise another job's localized URL.
 */
export function buildLocaleAlternateBlockForUnclaimedCluster(
  paths: Readonly<Partial<Record<AlternateLocale, string>>>,
  claimedPaths: ReadonlySet<string>,
  opts: Pick<LocaleAlternateBlockOptions, 'hrefFor' | 'indent'>,
): string {
  if (!hasUnclaimedLocaleCluster(paths, claimedPaths)) return '';
  return buildLocaleAlternateBlock({
    eligibleLocales: ALTERNATE_LOCALES,
    ...opts,
  });
}

/** One `hreflang`/`href` pair of the alternate set. */
export interface LocaleAlternateEntry {
  readonly hreflang: string;
  readonly href: string;
}

/**
 * The same alternate set as {@link buildLocaleAlternateBlock}, as DATA rather
 * than as an HTML string — for callers that hand the set to a page builder
 * which renders the tags itself (`buildCanonicalBridgePage`'s
 * `hreflangEntries` in build-plugins/constants.ts).
 *
 * Exists so the all-or-nothing rule has ONE implementation to migrate TO. The
 * renderer above is now a formatter over this function's output, so those two
 * can no longer disagree about WHEN a page carries alternates.
 *
 * NOT YET MIGRATED — five call sites still hand-roll the 4-locale +
 * x-default array, and none of them applies the all-or-nothing rule (they
 * template every locale unconditionally, which is the #5114 shape):
 *
 *   build-plugins/professionCityLandings.ts     (~272)
 *   build-plugins/fuelDailyPagesPlugin.ts       (~194)
 *   build-plugins/shared/salaryStatsBridge.ts   (~50)
 *   build-plugins/shared/guideHubBridge.ts      (~76)
 *   build-plugins/jobsSeoPagesPlugin.ts         (~4656, brand alias)
 *
 * Each needs its own before/after count of `audit:hreflang` offenders before
 * being switched — an all-or-nothing rule REMOVES alternates from pages that
 * carry a partial set today, so it is a content change, not a refactor.
 *
 * Returns `[]` — never a partial set — when any required locale is missing.
 */
export function buildLocaleAlternateEntries(
  opts: LocaleAlternateBlockOptions,
): LocaleAlternateEntry[] {
  const eligible = new Set(opts.eligibleLocales);
  // All-or-nothing: an incomplete set is a `tooFew` failure, not a partial win.
  if (!ALTERNATE_LOCALES.every((locale) => eligible.has(locale))) return [];

  const entries: LocaleAlternateEntry[] = ALTERNATE_LOCALES.map((locale) => ({
    hreflang: locale as string,
    href: opts.hrefFor(locale),
  }));
  entries.push({ hreflang: 'x-default', href: opts.hrefFor('it') });
  return entries;
}

/**
 * Sitemap counterpart: `<xhtml:link>` alternates for a `<url>` entry.
 *
 * Sitemaps have no `tooFew` rule — reciprocity only requires that every
 * advertised alternate is itself a `<loc>` the site publishes — so this one
 * FILTERS to the eligible set instead of voiding the block. Advertising a
 * locale that no shard writes would point the crawler at a 404 just as the
 * HTML block did.
 */
export function buildSitemapAlternateBlock(opts: {
  readonly eligibleLocales: Iterable<string>;
  readonly hrefFor: (locale: AlternateLocale) => string;
  readonly indent?: string;
}): string {
  const eligible = new Set(opts.eligibleLocales);
  const indent = opts.indent ?? '    ';
  return ALTERNATE_LOCALES.filter((locale) => eligible.has(locale))
    .map(
      (locale) =>
        `${indent}<xhtml:link rel="alternate" hreflang="${locale}" href="${opts.hrefFor(locale)}" />`,
    )
    .join('\n');
}

/**
 * Render the expired-job `<url>` entries from one already-resolved cluster.
 * `eligibleLocales` contains only pages confirmed to exist on disk; the
 * claim decision additionally removes active or earlier-expired collisions.
 * A partial/collided cluster keeps its own expired `<loc>` pages, but emits
 * no sitemap alternates because the HTML pages carry no hreflang block.
 */
export function buildExpiredSitemapClusterEntries(
  paths: Readonly<Partial<Record<AlternateLocale, string>>>,
  claim: LocaleClusterClaimDecision,
  opts: {
    readonly eligibleLocales: Iterable<AlternateLocale>;
    readonly emitAlternates: boolean;
    readonly hrefFor: (locale: AlternateLocale) => string;
    readonly locFor: (locale: AlternateLocale) => string;
    readonly lastmod: string;
  },
): string[] {
  const eligibleLocales = new Set(opts.eligibleLocales);
  const sitemapLocales = ALTERNATE_LOCALES.filter((locale) => {
    return Boolean(paths[locale])
      && claim.unclaimedLocales.has(locale)
      && eligibleLocales.has(locale);
  });
  const emitAlternates = opts.emitAlternates && claim.hasUnclaimedCluster;
  const altLinks = emitAlternates
    ? buildSitemapAlternateBlock({
      eligibleLocales: sitemapLocales,
      hrefFor: opts.hrefFor,
      indent: ' ',
    })
    : '';
  const xDefault = emitAlternates && sitemapLocales.includes('it')
    ? ` <xhtml:link rel="alternate" hreflang="x-default" href="${opts.hrefFor('it')}" />`
    : '';
  const alternateLines = [altLinks, xDefault].filter(Boolean).join('\n');

  return sitemapLocales.map((locale) => {
    return ` <url>\n <loc>${opts.locFor(locale)}</loc>\n${alternateLines ? `${alternateLines}\n` : ''} ${opts.lastmod}\n <changefreq>monthly</changefreq>\n <priority>0.3</priority>\n </url>`;
  });
}
