const PLATE_AUCTION_HOST_ALIASES = Object.freeze({
  'www.auktion.tg.ch': 'auktion.tg.ch',
});

const AI_BASE_PATH = '/themen/mobilitaet-und-verkehr/strassenverkehr';
const AI_AUTO_PDF_PATH = `${AI_BASE_PATH}/kontrollschilder/liste-freie-kontrollschilder/liste-freie-auto-kontrollschilder/@@download/file/Freie%20Auto-Kontrollschilder.pdf`;
const AI_MOTORCYCLE_PDF_PATH = `${AI_BASE_PATH}/kontrollschilder/liste-freie-kontrollschilder/liste-freier-motorrad-kontrollschilder.pdf/@@download/file/Freie%20Motorrad-Kontrollschilder.pdf`;
const ECARI_ROOTS = Object.freeze({
  'eauktion.gr.ch': { root: '/ecari-auction/ui/app/init', locale: 'de_CH' },
  'ecarinwprod.ilz.info': { root: '/ecari-auction/ui/app/init', locale: 'de_CH' },
  'ecariowprod.ilz.info': { root: '/ecari-auction/ui/app/init', locale: 'de_CH' },
  'eauktion.so.ch': { root: '/ecari-auction/ui/app/init', locale: 'de_CH' },
  'ecari.vs.ch': { root: '/ecari-auction/ui/app/init', locale: 'fr_CH' },
});

function rewriteKnownPlateAuctionUrl(url) {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (host === 'www.auktion-ag.ch' && path === '/') {
    url.pathname = '/de/';
    return url;
  }

  if (host === 'ai.ch') {
    if (path === `${AI_BASE_PATH}/kontrollschilder/liste-freie-kontrollschilder`) {
      url.pathname = `${AI_BASE_PATH}/kontrollschilder`;
      url.search = '';
      url.hash = 'liste-freie-kontrollschilder';
      return url;
    }
    if (path === `${AI_BASE_PATH}/kontrollschilder/liste-freie-kontrollschilder/liste-freie-auto-kontrollschilder/download`
      || path === `${AI_BASE_PATH}/kontrollschilder/liste-freie-kontrollschilder/liste-freie-auto-kontrollschilder`) {
      url.pathname = AI_AUTO_PDF_PATH;
      url.search = '';
      url.hash = '';
      return url;
    }
    if (path === `${AI_BASE_PATH}/kontrollschilder/liste-freie-kontrollschilder/liste-freier-motorrad-kontrollschilder.pdf/download`
      || path === `${AI_BASE_PATH}/kontrollschilder/liste-freie-kontrollschilder/liste-freier-motorrad-kontrollschilder.pdf`) {
      url.pathname = AI_MOTORCYCLE_PDF_PATH;
      url.search = '';
      url.hash = '';
      return url;
    }
  }

  const ecari = Object.hasOwn(ECARI_ROOTS, host) ? ECARI_ROOTS[host] : undefined;
  if (ecari) {
    const isCatalogueRoot = path === '/' || path === '/ecari-auction' || path === '/ecari-auction/ui/app/init';
    if (isCatalogueRoot) {
      url.pathname = ecari.root;
      url.search = '';
      url.searchParams.set('locale', ecari.locale);
      return url;
    }
    if (path === '/ecari-auction/ui/app/details/app' && url.searchParams.has('locale')) {
      url.searchParams.set('locale', ecari.locale);
      return url;
    }
  }

  if (host === 'www.ricardo.ch' && path === '/fr/shop/OVJ') {
    url.pathname = '/fr/shop/OVJ/';
    return url;
  }

  return url;
}

/**
 * Source portals can move between equivalent host aliases without changing
 * the logical catalogue. Keep that migration out of identity comparisons and
 * public detail links while leaving unrelated source URLs untouched.
 */
function normalizeUrl(value, { aliases = true } = {}) {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    const beforeHref = url.toString();
    if (aliases) {
      const canonicalHostname = PLATE_AUCTION_HOST_ALIASES[url.hostname.toLowerCase()];
      if (canonicalHostname) url.hostname = canonicalHostname;
    }
    const normalized = rewriteKnownPlateAuctionUrl(url).toString();
    return normalized === beforeHref ? value : normalized;
  } catch {
    return value;
  }
}

export function normalizePlateAuctionUrl(value) {
  return normalizeUrl(value);
}

/** Normalize only links known to answer with a redirect; preserve host aliases
 * in historical rows whose target is already a direct page. */
export function normalizePlateAuctionRedirectUrl(value) {
  return normalizeUrl(value, { aliases: false });
}
