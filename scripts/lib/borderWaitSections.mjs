/**
 * Shared border-wait route classifier.
 * ─────────────────────────────────────────────────────────────────────────
 * Border-wait pages are data records (live minutes, regional/crossing scope,
 * or a month archive), not editorial pages.  The build plugin and the dist
 * audits must therefore agree on the route family before either one reasons
 * about page prose.
 *
 * This module is deliberately Node-compatible: the post-deploy audits cannot
 * import the TypeScript build-plugin graph.  `build-plugins/borderWaitData.ts`
 * delegates its runtime matcher here and supplies its exact crossing/region
 * registries; the audit uses the same route grammar for emitted HTML, where
 * the registry has already been materialised by the build.
 */

/** Current section slug per locale, mirrored by the build plugin. */
export const BORDER_WAIT_SECTION_BY_LOCALE = Object.freeze({
  it: 'traffico-dogane',
  en: 'border-wait',
  de: 'wartezeit-grenze',
  fr: 'temps-attente-douane',
});

/** Current "today" slug per locale, mirrored by the build plugin. */
export const BORDER_WAIT_TODAY_BY_LOCALE = Object.freeze({
  it: 'oggi',
  en: 'today',
  de: 'heute',
  fr: 'aujourd-hui',
});

/** Canonical section roots paired with their locale. */
export const BORDER_WAIT_CURRENT_SECTION_BASES_BY_LOCALE = Object.freeze({
  it: BORDER_WAIT_SECTION_BY_LOCALE.it,
  en: `en/${BORDER_WAIT_SECTION_BY_LOCALE.en}`,
  de: `de/${BORDER_WAIT_SECTION_BY_LOCALE.de}`,
  fr: `fr/${BORDER_WAIT_SECTION_BY_LOCALE.fr}`,
});

/** Canonical section roots as they appear in a pathname without a leading /. */
export const BORDER_WAIT_CURRENT_SECTION_BASES = Object.freeze(
  Object.values(BORDER_WAIT_CURRENT_SECTION_BASES_BY_LOCALE),
);

/**
 * Legacy section roots still emitted by the evergreen guide pages and by
 * historical alias builds.  Keep the localized guide prefixes explicit:
 * matching only the final slug would make an English/German/French page look
 * like an Italian route and would also swallow unrelated pages with the same
 * word in a deeper segment.
 */
export const BORDER_WAIT_LEGACY_SECTION_BASES = Object.freeze([
  'guida-frontaliere/tempi-attesa-dogana',
  'en/cross-border-guide/border-waiting-times',
  'de/grenzgaenger-ratgeber/wartezeiten-grenze',
  'fr/guide-frontalier/temps-attente-douane',
  // Older section aliases retained in the dist corpus and compatibility
  // redirects.  The locale-prefixed forms are listed as well because old
  // locale pages were emitted under their translated guide roots.
  'tempi-attesa-frontiera',
  'border-wait-times',
  'grenzwartezeiten',
  'temps-attente-frontiere',
  'en/border-wait-times',
  'de/grenzwartezeiten',
  'fr/temps-attente-frontiere',
  'en/cross-border-guide/border-wait-times',
  'de/grenzgaenger-ratgeber/grenzwartezeiten',
  'fr/guide-frontalier/temps-attente-frontiere',
  'tempi-attesa-confine',
]);

const MONTH_PATH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const CROSSING_SEGMENT_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_REGION_SEGMENTS = new Set([
  'ticino-como',
  'ticino-varese',
  'ticino-verbano',
  'basilea-germania',
  'argovia-germania',
  'zurigo-germania',
  'sciaffusa-germania',
  'turgovia-germania',
  'san-gallo-austria',
  'grigioni-austria',
  'san-gallo-liechtenstein',
  'grigioni-liechtenstein',
  'geneve-francia',
  'vaud-francia',
  'neuchatel-francia',
  'giura-francia',
  'vallese-francia',
  'grigioni-italia',
  'vallese-italia',
]);
const DEFAULT_TODAY_SEGMENTS = new Set(Object.values(BORDER_WAIT_TODAY_BY_LOCALE));

/** @param {unknown} value */
function normalizePath(value) {
  let path = String(value ?? '').trim();
  if (!path) return '/';

  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    return '/';
  }

  path = path.split(/[?#]/, 1)[0].replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  path = path.replace(/^\/?dist\//i, '/');
  if (!path.startsWith('/')) path = `/${path}`;
  path = path.replace(/\/index\.html$/i, '/').replace(/\/+$/, '');
  return path || '/';
}

/** @param {string} value */
function withoutLeadingSlash(value) {
  return value.replace(/^\/+/, '');
}

/** @param {string} path @param {string} base */
function pathUnderBase(path, base) {
  return path === base || path.startsWith(`${base}/`);
}

/** @param {unknown} values */
function asSet(values) {
  if (!values) return null;
  return values instanceof Set ? values : new Set(values);
}

/**
 * Classify canonical and legacy border-wait routes.
 *
 * @param {string} pathname URL pathname, absolute URL, or dist-relative path
 * @param {{
 *   currentSectionBases?: readonly string[],
 *   legacySectionBases?: readonly string[],
 *   regionSlugs?: Iterable<string>|null,
 *   crossingSlugs?: Iterable<string>|null,
 *   todaySlugs?: Iterable<string>|null,
 *   todaySlugsByLocale?: Record<string, string>|null,
 *   includeLegacy?: boolean,
 * }} [options]
 */
export function isBorderWaitPath(pathname, options = {}) {
  const normalized = normalizePath(pathname);
  if (normalized === '/') return false;
  const path = withoutLeadingSlash(normalized);

  const legacyBases = options.legacySectionBases ?? BORDER_WAIT_LEGACY_SECTION_BASES;
  if (options.includeLegacy !== false && legacyBases.some((base) => pathUnderBase(path, base))) {
    // Legacy guide pages are root + crossing records.  Compatibility aliases
    // may carry a deeper archive/today suffix, so descendants stay in the
    // same data vertical without inventing a second alias grammar here.
    return true;
  }

  const currentBases = options.currentSectionBases ?? BORDER_WAIT_CURRENT_SECTION_BASES;
  const currentBase = currentBases.find((base) => pathUnderBase(path, base));
  if (!currentBase) return false;

  const currentLocale = Object.entries(BORDER_WAIT_CURRENT_SECTION_BASES_BY_LOCALE)
    .find(([, base]) => base === currentBase)?.[0];

  const tail = path.slice(currentBase.length).split('/').filter(Boolean);
  if (tail.length === 0) return true; // root hub
  if (tail.length === 1) {
    // A one-segment child is a regional hub.  The exact registry is supplied
    // by borderWaitData.ts; the audit fallback uses the same frozen region set
    // because it cannot import that TypeScript graph.
    const regions = asSet(options.regionSlugs) ?? DEFAULT_REGION_SEGMENTS;
    return regions.has(tail[0]);
  }
  if (tail.length !== 2) return false;

  const [crossing, suffix] = tail;
  const crossings = asSet(options.crossingSlugs);
  // The audit sees only emitted paths and uses the route shape as its
  // Node-only boundary.  The runtime matcher passes the exact crossing Set,
  // preserving the router's reject-unknown-crossing behaviour.
  if (crossings ? !crossings.has(crossing) : !CROSSING_SEGMENT_RE.test(crossing)) return false;

  const localeToday = currentLocale
    ? options.todaySlugsByLocale?.[currentLocale] ?? BORDER_WAIT_TODAY_BY_LOCALE[currentLocale]
    : null;
  const today = localeToday
    ? new Set([localeToday])
    : asSet(options.todaySlugs) ?? DEFAULT_TODAY_SEGMENTS;
  return today.has(suffix) || MONTH_PATH_RE.test(suffix);
}

export { normalizePath as normalizeBorderWaitPath };
