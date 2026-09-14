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

const RAW = {
  ag: ['Argovia', 'AG', 'https://www.auktion-ag.ch'],
  ai: ['Appenzello Interno', 'AI', 'https://www.ai.ch/themen/mobilitaet/strassenverkehr/kontrollschilder', { status: 'no-public-auction', rateLimit: 'not applicable', termsOfUse: 'not applicable', notes: 'Official mobility information page; no public auction catalogue is published in the verified source index.' }],
  ar: ['Appenzello Esterno', 'AR', 'https://eauktion.ar.ch'],
  be: ['Berna', 'BE', 'https://www.auktion-be.ch'],
  bl: ['Basilea Campagna', 'BL', 'https://eauktion.bl.ch/ecari-auction'],
  bs: ['Basilea Città', 'BS', 'https://appls.ocn.ch/ecari-auction?locale=de_ch'],
  fr: ['Friburgo', 'FR', 'https://www.fr.ch/de/mobilitaet-und-verkehr', { status: 'no-public-auction', rateLimit: 'not applicable', termsOfUse: 'not applicable', notes: 'Official mobility information page; no public auction catalogue is published in the verified source index.' }],
  ge: ['Ginevra', 'GE', 'https://www.ricardo.ch/online-shop/encheres-plaques-ge/?SortingType=5&SellerNickName=ENCHERES-PLAQUES-GE&SeeComments=True', { termsOfUse: 'Ricardo terms and anti-bot controls apply' }],
  gl: ['Glarona', 'GL', 'https://www.gl.ch/verwaltung/volkswirtschaft-und-inneres/strassenverkehrsamt.html', { status: 'no-public-auction', rateLimit: 'not applicable', termsOfUse: 'not applicable', notes: 'Official office page exposes direct plate services rather than a public auction catalogue.' }],
  gr: ['Grigioni', 'GR', 'https://eauktion.gr.ch/', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '2.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'minimumIncrementChf', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'no separate terms page found; review manually before increasing frequency', status: 'active' }],
  ju: ['Giura', 'JU', 'https://www.ricardo.ch/fr/shop/OVJ', { termsOfUse: 'Ricardo terms and anti-bot controls apply' }],
  lu: ['Lucerna', 'LU', 'https://strassenverkehrsamt.lu.ch/', { status: 'no-public-auction', rateLimit: 'not applicable', termsOfUse: 'not applicable', notes: 'Official office page exposes a free Wunschkontrollschild service, not a public auction catalogue.' }],
  ne: ['Neuchâtel', 'NE', 'https://www.ricardo.ch/de/shop/ENCHERES-PLAQUES-NE/offers/', { termsOfUse: 'Ricardo terms and anti-bot controls apply' }],
  nw: ['Nidvaldo', 'NW', 'https://ecarinwprod.ilz.info/ecari-auction/'],
  ow: ['Obvaldo', 'OW', 'https://ecariowprod.ilz.info/ecari-auction/'],
  sg: ['San Gallo', 'SG', 'https://egov.stva.sg.ch/ecari-auction/ui/app/init', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '2.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'minimumIncrementChf', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'review source terms before increasing frequency', status: 'active', notes: 'Verified public eCari catalogue; bidder identity fields are discarded.' }],
  sh: ['Sciaffusa', 'SH', 'https://www.auktion-stva.sh.ch/', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '1.1.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'review source terms before increasing frequency', status: 'active', notes: 'Verified public card catalogue; the parser keeps only public bid counts and deadlines.' }],
  so: ['Soletta', 'SO', 'https://eauktion.so.ch/ecari-auction'],
  sz: ['Svitto', 'SZ', 'https://cariegov.sz.ch/ecari-auction/ui/app/init?locale=de_ch', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '2.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'minimumIncrementChf', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'review source terms before increasing frequency', status: 'active', notes: 'Verified public eCari catalogue; bidder identity fields are discarded.' }],
  tg: ['Turgovia', 'TG', 'https://www.auktion.tg.ch/de/', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '1.1.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'review source terms before increasing frequency', status: 'active', notes: 'Verified public card catalogue; the parser keeps only public bid counts and deadlines.' }],
  ti: ['Ticino', 'TI', 'https://www.ti.ch/sportello/targhe', { termsOfUse: 'official page confirms the service; the former catalogue endpoint is unavailable', notes: 'The official service page still advertises plate auctions, but the former eCari endpoint returns a 404 page. Existing rows remain historical and are not republished as live.' }],
  ur: ['Uri', 'UR', 'https://www.ur.ch/strassenverkehrsamt', { status: 'no-public-auction', rateLimit: 'not applicable', termsOfUse: 'not applicable', notes: 'Official office page exposes plate services without a public auction catalogue.' }],
  vd: ['Vaud', 'VD', 'https://www.encheres-vd.ch'],
  vs: ['Vallese', 'VS', 'https://ecari.vs.ch/ecari-auction/', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '2.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'minimumIncrementChf', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'no separate terms page found; review manually before increasing frequency', status: 'active' }],
  zg: ['Zugo', 'ZG', 'https://zg.ch/de/mobilitaet-reisen/strassenverkehr/fahrzeuge-und-kontrollschilder/kontrollschilder', { status: 'no-public-auction', rateLimit: 'not applicable', termsOfUse: 'not applicable', notes: 'Official office page exposes plate services without a public auction catalogue.' }],
  zh: ['Zurigo', 'ZH', 'https://www.auktion.stva.zh.ch/de/?plate_sub_type=&plate_type=car', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '1.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'platform AGB/help must be reviewed before increasing frequency', status: 'active' }],
};

export const PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY = Object.fromEntries(
  Object.entries(RAW).map(([key, [canton, plateCode, officialUrl, overrides = {}]]) => [
    key,
    { ...DEFAULTS, canton, plateCode, officialUrl, ...overrides },
  ]),
);
