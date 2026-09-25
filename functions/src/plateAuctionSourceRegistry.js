/**
 * Deploy-boundary copy of the public canton coverage registry.
 *
 * Cloud Functions cannot import the site's `data/` tree after Firebase has
 * isolated `functions/` for deployment. A parity test in the site compares
 * this allow-list with `data/plate-auction-sources-registry.json`; the runtime
 * copy exists so the HTTP API keeps the complete 26-canton health matrix even
 * when a source has no public catalogue or uses a blocked portal.
 */
const DEFAULTS = {
  accessMethod: 'manual',
  fetchFrequency: 'P1D',
  timezone: 'Europe/Zurich',
  parserVersion: 'registry-2026.09.14',
  availableFields: [],
  rateLimit: 'manual review required before automation',
  termsOfUse: 'source platform terms not automated',
  owner: 'platform',
  status: 'blocked',
};

const ACTIVE_ECARI = {
  accessMethod: 'html-scrape',
  fetchFrequency: 'PT6H',
  parserVersion: '2.0.0',
  availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'minimumIncrementChf', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'],
  rateLimit: 'unpublished — collector capped at four fetches/day',
  termsOfUse: 'review source terms before increasing frequency',
  status: 'active',
};

const ACTIVE_CARDS = {
  accessMethod: 'html-scrape',
  fetchFrequency: 'PT6H',
  parserVersion: '1.1.0',
  availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'],
  rateLimit: 'unpublished — collector capped at four fetches/day',
  termsOfUse: 'review source terms before increasing frequency',
  status: 'active',
};

const RAW = {
  ag: ['Argovia', 'AG', 'https://www.auktion-ag.ch', { ...ACTIVE_CARDS, notes: 'Verified public auction-card catalogue; bidder identity fields are discarded.' }],
  ai: ['Appenzello Interno', 'AI', 'https://ai.ch/themen/mobilitaet-und-verkehr/strassenverkehr/kontrollschilder/liste-freie-kontrollschilder', { accessMethod: 'pdf', fetchFrequency: 'P1D', parserVersion: 'fixed-price-1.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'officialDetailUrl'], rateLimit: 'official list refreshed by the canton', termsOfUse: 'official canton catalogue; reservation rules apply', status: 'active', notes: 'Official free-plate PDF; published price groups are represented as fixed-price listings, never as bids.' }],
  ar: ['Appenzello Esterno', 'AR', 'https://eauktion.ar.ch/ecari-auction/ui/app/init', { ...ACTIVE_ECARI, notes: 'Verified public eCari catalogue; bidder identity fields are discarded.' }],
  be: ['Berna', 'BE', 'https://www.auktion-be.ch/de/', { ...ACTIVE_CARDS, notes: 'Verified public auction-card catalogue; bidder identity fields are discarded.' }],
  bl: ['Basilea Campagna', 'BL', 'https://eauktion.bl.ch/ecari-auction/ui/app/init', { ...ACTIVE_ECARI, notes: 'Verified public eCari catalogue; bidder identity fields are discarded.' }],
  bs: ['Basilea Città', 'BS', 'https://www.bs.ch/themen/mobilitaet/kontrollschilder/wunschkontrollschilder', { accessMethod: 'pdf', fetchFrequency: 'P1D', parserVersion: 'fixed-price-1.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'officialDetailUrl'], rateLimit: 'official list refreshed weekly', termsOfUse: 'official canton catalogue; order and stock notes apply', status: 'active', notes: 'Official weekly Wunschkontrollschilder PDF; in-stock and orderable rows are kept as fixed-price listings.' }],
  fr: ['Friburgo', 'FR', 'https://appls.ocn.ch/ecari-auction/ui/app/init?locale=fr_ch', { ...ACTIVE_ECARI, termsOfUse: 'official OCN auction portal; review source terms before increasing frequency', notes: 'Geo-fenced to Swiss IPs, measured 2026-09-25: Swiss probes (check-host.net ch1/ch2, Globalping Zurich AS31898 and Geneva AS29222) receive the live eCari app ("Plaques aux enchères", eCari 432.10.68, auction ending 2026-09-28), while every non-Swiss probe (AT, DE, FR, IT, NL, UK, US and GitHub Actions) gets a TCP timeout on 443 (check-host.net 4d59a063k807 and 4d59a35fkf59; Globalping 2EhaFhiPWhN12u3jS00021CP9 and 2GOkXORX7IhoX9zjD00021CP9). The server omits the SwissSign intermediate, which both collectors supply. Collected by the Cloud Function refreshPlateAuctions in europe-west6 (Zurich); the static collector reads it through the getPlateAuctions API relay when its direct fetch is geo-blocked. Bidder identity fields are discarded.' }],
  ge: ['Ginevra', 'GE', 'https://www.ricardo.ch/online-shop/encheres-plaques-ge/?SortingType=5&SellerNickName=ENCHERES-PLAQUES-GE&SeeComments=True', { termsOfUse: 'Ricardo terms and anti-bot controls apply', notes: 'Blocked, no connector by design: bids run only on Ricardo, which on 2026-09-25 answered every page (shop, home page, sitemap) with HTTP 403 and cf-mitigated: challenge (Cloudflare captcha). Collecting it would mean solving that challenge; robots.txt also disallows this legacy /online-shop/ path, and the Ricardo AGB (3.2, 3.7) forbid disruptive scripts and limit reuse of offer data. The official OCV list https://www.ge.ch/document/15062/telecharger is a plain PDF without prices or bids and still describes the closed 3-13 November 2025 session; ge.ch announces the next sale for autumn 2026. Next check: when the OCV replaces that list, or when the OCV provides an official list or feed of the running auction.' }],
  gl: ['Glarona', 'GL', 'https://www.gl.ch/verwaltung/sicherheit-und-justiz/justiz/strassenverkehrsamt/strassenverkehr/kontrollschilder/wunschkontrollschilder.html/450', { accessMethod: 'json-api', fetchFrequency: 'PT6H', parserVersion: 'fixed-price-1.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'officialDetailUrl'], rateLimit: 'public API; collector capped at four fetches/day', termsOfUse: 'official canton API; SVG artwork is discarded', status: 'active', notes: 'Official eSchild JSON inventory; available fixed-price plates are published without auction bids.' }],
  gr: ['Grigioni', 'GR', 'https://eauktion.gr.ch/', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '2.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'minimumIncrementChf', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'no separate terms page found; review manually before increasing frequency', status: 'active' }],
  ju: ['Giura', 'JU', 'https://www.ricardo.ch/fr/shop/OVJ', { termsOfUse: 'Ricardo terms and anti-bot controls apply', notes: 'Blocked, no connector by design: auctions run on the OVJ Ricardo shop, which on 2026-09-25 answered every page with HTTP 403 and cf-mitigated: challenge (Cloudflare captcha), and the Ricardo AGB (3.2, 3.7) forbid disruptive scripts and limit reuse of offer data. The canton plate search on guichet.jura.ch (PlaquesService ListPlaques) requires a reCAPTCHA token, so neither source can be read without solving a challenge. Next step: an official list or feed from the OVJ.' }],
  lu: ['Lucerna', 'LU', 'https://strassenverkehrsamt.lu.ch/strassenverkehr/fahrzeug/kontrollschilderboerse_wunschkontrollschild', { accessMethod: 'pdf', fetchFrequency: 'P1D', parserVersion: 'fixed-price-1.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'officialDetailUrl'], rateLimit: 'official list updated daily', termsOfUse: 'official canton catalogue; reservation rules apply', status: 'active', notes: 'Official daily Wunschkontrollschilder PDF; motorwagen and motorcycle price columns are parsed as fixed-price listings.' }],
  ne: ['Neuchâtel', 'NE', 'https://www.ricardo.ch/de/shop/ENCHERES-PLAQUES-NE/offers/', { termsOfUse: 'Ricardo terms and anti-bot controls apply', notes: 'Blocked, no connector by design: auctions run on the SCAN Ricardo shop, which on 2026-09-25 answered every page with HTTP 403 and cf-mitigated: challenge (Cloudflare captcha), and the Ricardo AGB (3.2, 3.7) forbid disruptive scripts and limit reuse of offer data. The canton plate search on guichetunique.ch (RecherchePlaqueAVendre) requires an image captcha, so neither source can be read without solving a challenge. Next step: an official list or feed from the SCAN.' }],
  nw: ['Nidvaldo', 'NW', 'https://ecarinwprod.ilz.info/ecari-auction/', { ...ACTIVE_ECARI, notes: 'Verified public eCari catalogue; bidder identity fields are discarded.' }],
  ow: ['Obvaldo', 'OW', 'https://ecariowprod.ilz.info/ecari-auction/', { ...ACTIVE_ECARI, notes: 'Verified public eCari catalogue; bidder identity fields are discarded.' }],
  sg: ['San Gallo', 'SG', 'https://egov.stva.sg.ch/ecari-auction/ui/app/init', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '2.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'minimumIncrementChf', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'review source terms before increasing frequency', status: 'active', notes: 'Verified public eCari catalogue; bidder identity fields are discarded.' }],
  sh: ['Sciaffusa', 'SH', 'https://www.auktion-stva.sh.ch/', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '1.1.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'review source terms before increasing frequency', status: 'active', notes: 'Verified public card catalogue; the parser keeps only public bid counts and deadlines.' }],
  so: ['Soletta', 'SO', 'https://eauktion.so.ch/ecari-auction', { ...ACTIVE_ECARI, notes: 'Verified public eAuction/eCari catalogue; bidder identity fields are discarded.' }],
  sz: ['Svitto', 'SZ', 'https://cariegov.sz.ch/ecari-auction/ui/app/init', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '2.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'minimumIncrementChf', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'review source terms before increasing frequency', status: 'active', notes: 'Verified public eCari catalogue; bidder identity fields are discarded.' }],
  tg: ['Turgovia', 'TG', 'https://www.auktion.tg.ch/de/', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '1.1.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'review source terms before increasing frequency', status: 'active', notes: 'Verified public card catalogue; the parser keeps only public bid counts and deadlines.' }],
  ti: ['Ticino', 'TI', 'https://www.carieauktion.ti.ch/ecari-auktion/', { ...ACTIVE_ECARI, termsOfUse: 'official Ticino eCari catalogue; review source terms before increasing frequency', notes: 'Geo-fenced to Swiss IPs, measured 2026-09-25: Swiss probes (check-host.net ch1/ch2, Globalping Zurich AS31898 and Geneva AS29222) receive the live eCari app ("Asta targhe", eCari 432.10.83, F5 pool www.carieauktion_prod00, auction ending 2026-10-04; this URL redirects through /bootstrap and props?locale=it_CH to ui/app/init), while every non-Swiss probe (AT, DE, FR, IT, NL, UK, US and GitHub Actions) gets the 6,967-byte "Pagina non disponibile" F5 page (check-host.net 4d59a178k728 and 4d59a485kf26; Globalping 2FU18iKjyJUc4Urap00021CP9, 2XNZi25Xieb76VYWq00021CP9 and 2PC0TDQSHF4T7OySI00021CPL). Collected by the Cloud Function refreshPlateAuctions in europe-west6 (Zurich); the static collector reads it through the getPlateAuctions API relay when its direct fetch is geo-blocked. Bidder identity fields are discarded.' }],
  ur: ['Uri', 'UR', 'https://www.ur.ch/dienstleistungen/4046', { accessMethod: 'pdf', fetchFrequency: 'P1D', parserVersion: 'fixed-price-1.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'officialDetailUrl'], rateLimit: 'official list refreshed by the canton', termsOfUse: 'official canton catalogue; sale-date notes apply', status: 'active', notes: 'Official motor-vehicle sales-list PDF; the published fixed prices and release notes are kept without auction semantics.' }],
  vd: ['Vaud', 'VD', 'https://www.encheres-vd.ch/de/', { ...ACTIVE_CARDS, notes: 'Verified public auction-card catalogue after the official portal migration; bidder identity fields are discarded.' }],
  vs: ['Vallese', 'VS', 'https://ecari.vs.ch/ecari-auction/', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '2.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'minimumIncrementChf', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'no separate terms page found; review manually before increasing frequency', status: 'active' }],
  zg: ['Zugo', 'ZG', 'https://zg.ch/de/mobilitaet-reisen/strassenverkehr/fahrzeuge-und-kontrollschilder/kontrollschilder', { parserVersion: 'registry-2026.09.15', rateLimit: 'not applicable', termsOfUse: 'not applicable', status: 'no-public-auction', notes: 'The canton states that plate auctions are suspended until further notice (Kantonsrat decision of 24 November 2022; re-verified on this page 2026-09-25); no public inventory is exposed to collect.' }],
  zh: ['Zurigo', 'ZH', 'https://www.auktion.stva.zh.ch/de/?plate_sub_type=&plate_type=car', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '1.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'platform AGB/help must be reviewed before increasing frequency', status: 'active' }],
};

export const PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY = Object.fromEntries(
  Object.entries(RAW).map(([key, [canton, plateCode, officialUrl, overrides = {}]]) => [
    key,
    { ...DEFAULTS, canton, plateCode, officialUrl, ...overrides },
  ]),
);
