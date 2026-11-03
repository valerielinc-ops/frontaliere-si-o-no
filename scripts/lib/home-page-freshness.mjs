import { APEX_HOST, shardOriginForApexUrl } from './cf-worker-routes.mjs';

export const SITE_ORIGIN = `https://${APEX_HOST}`;

export const HOME_PAGE_PATH_BY_LOCALE = Object.freeze({
  it: '/',
  en: '/en/',
  de: '/de/',
  fr: '/fr/',
});

export const HOME_PAGE_LOCALES = Object.freeze(Object.keys(HOME_PAGE_PATH_BY_LOCALE));

const BUILD_ID_PATTERN = /^\d{10,20}$/;

function attributeValues(tag, wantedName) {
  const values = [];
  for (const match of tag.matchAll(/\b([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
    if (match[1].toLowerCase() !== wantedName) continue;
    values.push(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return values;
}

/** Return a single well-formed ft-build-id meta value; missing/ambiguous is unknown. */
export function extractBuildIdFromHtml(html) {
  if (typeof html !== 'string') return null;
  const heads = [...html.matchAll(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/gi)];
  if (heads.length !== 1) return null;
  const head = heads[0][1]
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  const markers = [];
  for (const tag of head.matchAll(/<meta\b[^>]*>/gi)) {
    const names = attributeValues(tag[0], 'name');
    if (!names.some((name) => name.toLowerCase() === 'ft-build-id')) continue;
    const contents = attributeValues(tag[0], 'content');
    if (names.length !== 1 || contents.length !== 1 || !BUILD_ID_PATTERN.test(contents[0].trim())) {
      return null;
    }
    markers.push(contents[0].trim());
  }
  return markers.length === 1 ? markers[0] : null;
}

/** Exact cache keys for one locale home, including cached bare-path redirects. */
export function homePagePurgeUrls(locales = HOME_PAGE_LOCALES) {
  if (!Array.isArray(locales)) throw new TypeError('home page locales must be an array');
  const urls = [];
  const seenLocales = new Set();
  for (const locale of locales) {
    if (!Object.hasOwn(HOME_PAGE_PATH_BY_LOCALE, locale)) {
      throw new Error(`unsupported home page locale '${locale}'`);
    }
    if (seenLocales.has(locale)) continue;
    seenLocales.add(locale);

    const canonicalPath = HOME_PAGE_PATH_BY_LOCALE[locale];
    const paths = locale === 'it' ? [canonicalPath] : [`/${locale}`, canonicalPath];
    for (const pathname of paths) {
      const apexUrl = new URL(pathname, SITE_ORIGIN);
      urls.push(apexUrl.href);
      const shardOrigin = shardOriginForApexUrl(apexUrl);
      if (shardOrigin) urls.push(`https://${shardOrigin}${pathname}`);
    }
  }
  return urls;
}

/** Compare normal, user-facing HTML responses with the fresh site build marker. */
export function evaluateHomePageFreshness(siteBuildId, observations = []) {
  const expectedBuildId = typeof siteBuildId === 'string' && BUILD_ID_PATTERN.test(siteBuildId)
    ? siteBuildId
    : null;
  const byLocale = new Map();
  const ambiguousLocales = new Set();
  for (const observation of Array.isArray(observations) ? observations : []) {
    const locale = observation?.locale;
    if (!Object.hasOwn(HOME_PAGE_PATH_BY_LOCALE, locale)) continue;
    if (byLocale.has(locale)) ambiguousLocales.add(locale);
    else byLocale.set(locale, observation);
  }

  const pages = HOME_PAGE_LOCALES.map((locale) => {
    const path = HOME_PAGE_PATH_BY_LOCALE[locale];
    const expectedUrl = new URL(path, SITE_ORIGIN).href;
    const observation = byLocale.get(locale);
    const responseMatchesPage = observation?.url === undefined || observation.url === expectedUrl;
    const responseIsSuccessful = Number(observation?.status) >= 200 && Number(observation?.status) < 300;
    const buildId = !ambiguousLocales.has(locale) && responseMatchesPage && responseIsSuccessful && observation?.ok
      ? extractBuildIdFromHtml(observation.body)
      : null;
    const state = !expectedBuildId || !buildId
      ? 'unavailable'
      : buildId === expectedBuildId ? 'healthy' : 'stale';
    return {
      locale,
      path,
      url: observation?.url || expectedUrl,
      status: observation?.status || 0,
      buildId,
      state,
    };
  });
  const staleLocales = pages.filter((page) => page.state === 'stale').map((page) => page.locale);
  const purgeUrls = homePagePurgeUrls(staleLocales);
  return {
    ok: Boolean(expectedBuildId) && pages.every((page) => page.state === 'healthy'),
    expectedBuildId,
    pages,
    purgeUrls,
  };
}
