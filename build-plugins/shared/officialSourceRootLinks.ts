type StaticSourceLocale = 'it' | 'en' | 'de' | 'fr';

interface StaticSourceRootRewrite {
  paths: Partial<Record<StaticSourceLocale, string>>;
  hostname?: string;
}

// The audit found these bare official-source roots redirecting to landing
// pages. Rewrite only exact root anchors after rendering; curated deep links
// and links with query parameters stay untouched.
const STATIC_SOURCE_ROOT_REWRITES: Readonly<Record<string, StaticSourceRootRewrite>> = {
  'agenziaentrate.gov.it': { paths: { it: '/portale/', en: '/portale/', de: '/portale/', fr: '/portale/' } },
  'arcobaleno.ch': { hostname: 'arcobaleno.ch', paths: { it: '/home', en: '/home', de: '/home', fr: '/home' } },
  'arbeit.swiss': { paths: { it: '/it', en: '/en', de: '/de', fr: '/fr' } },
  'bag.admin.ch': { paths: { it: '/it', en: '/en', de: '/de', fr: '/fr' } },
  'bazg.admin.ch': { paths: { it: '/it', en: '/en', de: '/de', fr: '/fr' } },
  'bfs.admin.ch': { paths: { it: '/bfs/it/home.html', en: '/bfs/en/home.html', de: '/bfs/de/home.html', fr: '/bfs/fr/home.html' } },
  'bns.ch': { hostname: 'www.snb.ch', paths: { it: '/it/', en: '/en/', de: '/de/', fr: '/fr/' } },
  'bsv.admin.ch': { paths: { it: '/it', en: '/en', de: '/de', fr: '/fr' } },
  'edoeb.admin.ch': { paths: { it: '/it', en: '/en', de: '/de', fr: '/fr' } },
  'estv.admin.ch': { paths: { it: '/it', en: '/en', de: '/de', fr: '/fr' } },
  'finanze.gov.it': { paths: { it: '/it/', en: '/it/', de: '/it/', fr: '/it/' } },
  'gdf.gov.it': { paths: { it: '/it', en: '/it', de: '/it', fr: '/it' } },
  'mobility.ch': { hostname: 'mobility.ch', paths: { it: '/it', en: '/en', de: '/en', fr: '/fr' } },
  'miur.gov.it': { hostname: 'www.mim.gov.it', paths: { it: '/', en: '/', de: '/', fr: '/' } },
  'priminfo.admin.ch': { paths: { it: '/it/praemien', en: '/de/praemien', de: '/de/praemien', fr: '/fr/praemien' } },
  'seco.admin.ch': { paths: { it: '/it', en: '/en', de: '/de', fr: '/fr' } },
  'snb.ch': { hostname: 'www.snb.ch', paths: { it: '/it/', en: '/en/', de: '/de/', fr: '/fr/' } },
  // TCS /en/ redirects to its camping microsite, so English source pages use
  // the direct Italian club homepage while German and French remain localized.
  'tcs.ch': { paths: { it: '/it/', en: '/it/', de: '/de/', fr: '/fr/' } },
  'zas.admin.ch': { paths: { it: '/it', en: '/en', de: '/de', fr: '/fr' } },
};

/**
 * Replace only exact-root official-source anchors with their final landing.
 * This is shared by the full static-page renderer and the shard landing
 * refresher, which preserves an existing shell instead of rebuilding it.
 */
export function localizeOfficialSourceRootLinks(html: string, locale: string): string {
  const sourceLocale: StaticSourceLocale = locale === 'en' || locale === 'de' || locale === 'fr' ? locale : 'it';
  return html.replace(/(<a\b[^>]*\bhref\s*=\s*)(["'])([^"']*)\2/gi, (match, prefix: string, quote: string, href: string) => {
    try {
      const url = new URL(href);
      if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.pathname !== '/' || url.search || url.hash) return match;

      const host = url.hostname.replace(/^www\./i, '').toLowerCase();
      const rewrite = STATIC_SOURCE_ROOT_REWRITES[host];
      const path = rewrite?.paths[sourceLocale];
      if (!rewrite || !path) return match;

      url.hostname = rewrite.hostname ?? `www.${host}`;
      url.pathname = path;
      return `${prefix}${quote}${url.toString()}${quote}`;
    } catch {
      return match;
    }
  });
}
