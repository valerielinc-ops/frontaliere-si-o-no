/**
 * Deploy-boundary copy of the public canton coverage registry.
 *
 * Cloud Functions cannot import the site's `data/` tree after Firebase has
 * isolated `functions/` for deployment. A parity test in the site compares
 * this allow-list with `data/plate-auction-sources-registry.json`; the runtime
 * copy exists only so the HTTP API still documents all 26 cantons after the
 * live Firestore source rows have been created for the first connectors.
 */
const DEFAULTS = {
  accessMethod: 'manual',
  fetchFrequency: 'P1D',
  timezone: 'Europe/Zurich',
  parserVersion: 'discovery-1.0.0',
  availableFields: [],
  rateLimit: 'da definire dopo la verifica della fonte',
  termsOfUse: "da verificare prima dell'attivazione",
  owner: 'platform',
  status: 'not-discovered',
};

const RAW = {
  ag: ['Argovia', 'AG', 'https://www.ag.ch/de/verwaltung/dvi/strassenverkehr/kontrollschilder'],
  ai: ['Appenzello Interno', 'AI', 'https://www.ai.ch/themen/mobilitaet/strassenverkehr/kontrollschilder'],
  ar: ['Appenzello Esterno', 'AR', 'https://www.ar.ch/verwaltung/departement-inneres-und-sicherheit/strassenverkehrsamt/kontrollschilder/'],
  be: ['Berna', 'BE', 'https://www.svsa.sid.be.ch/de/start.html'],
  bl: ['Basilea Campagna', 'BL', 'https://www.baselland.ch/politik-und-behorden/direktionen/sicherheitsdirektion/mfk'],
  bs: ['Basilea Città', 'BS', 'https://www.bs.ch/themen/mobilitaet-und-verkehr/strassenverkehr'],
  fr: ['Friburgo', 'FR', 'https://www.fr.ch/de/mobilitaet-und-verkehr'],
  ge: ['Ginevra', 'GE', 'https://www.ge.ch/demander-plaques-immatriculation'],
  gl: ['Glarona', 'GL', 'https://www.gl.ch/verwaltung/volkswirtschaft-und-inneres/strassenverkehrsamt.html'],
  gr: ['Grigioni', 'GR', 'https://eauktion.gr.ch/', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '2.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'minimumIncrementChf', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'no separate terms page found; review manually before increasing frequency', status: 'active' }],
  ju: ['Giura', 'JU', 'https://www.jura.ch/DFI/SPOP/Office-des-vehicules/Office-des-vehicules.html'],
  lu: ['Lucerna', 'LU', 'https://strassenverkehrsamt.lu.ch/'],
  ne: ['Neuchâtel', 'NE', 'https://www.ne.ch/autorites/DDTE/SCA/Pages/accueil.aspx'],
  nw: ['Nidvaldo', 'NW', 'https://www.nw.ch/stva'],
  ow: ['Obvaldo', 'OW', 'https://www.ow.ch/de/verwaltung/direktionen/sicherheitsdirektion/strassenverkehrsamt'],
  sg: ['San Gallo', 'SG', 'https://www.sg.ch/verkehr/strassenverkehr/kontrollschilder.html'],
  sh: ['Sciaffusa', 'SH', 'https://sh.ch/CMS/Webseite-Kanton-Schaffhausen/Beh%C3%B6rde/Verwaltung/Volkswirtschaftsdepartement/Strassenverkehrsamt.htm'],
  so: ['Soletta', 'SO', 'https://so.ch/verwaltung/departement-des-innern/amt-fuer-strassenverkehr-und-schifffahrt/'],
  sz: ['Svitto', 'SZ', 'https://www.sz.ch/verwaltung/sicherheitsdepartement/strassenverkehrsamt.html/72-512-489-483-481'],
  tg: ['Turgovia', 'TG', 'https://strassenverkehrsamt.tg.ch/'],
  ti: ['Ticino', 'TI', 'https://www4.ti.ch/di/sc/veicoli/asta-targhe', { parserVersion: 'discovery-1.1.0', rateLimit: 'da verificare dopo il ripristino della piattaforma', status: 'blocked' }],
  ur: ['Uri', 'UR', 'https://www.ur.ch/strassenverkehrsamt'],
  vd: ['Vaud', 'VD', 'https://www.vd.ch/themes/mobilite/automobile/plaques-dimmatriculation'],
  vs: ['Vallese', 'VS', 'https://ecari.vs.ch/ecari-auction/', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '2.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'startingPriceChf', 'minimumIncrementChf', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'no separate terms page found; review manually before increasing frequency', status: 'active' }],
  zg: ['Zugo', 'ZG', 'https://www.zg.ch/behoerden/sicherheitsdirektion/strassenverkehrsamt/kontrollschilder'],
  zh: ['Zurigo', 'ZH', 'https://www.auktion.stva.zh.ch/de/?plate_sub_type=&plate_type=car', { accessMethod: 'html-scrape', fetchFrequency: 'PT6H', parserVersion: '1.0.0', availableFields: ['sourceRecordId', 'plateNumber', 'listingType', 'vehicleType', 'currentBidChf', 'bidCount', 'endsAt', 'officialDetailUrl'], rateLimit: 'unpublished — collector capped at four fetches/day', termsOfUse: 'platform AGB/help must be reviewed before increasing frequency', status: 'active' }],
};

export const PUBLIC_PLATE_AUCTION_SOURCE_REGISTRY = Object.fromEntries(
  Object.entries(RAW).map(([key, [canton, plateCode, officialUrl, overrides = {}]]) => [
    key,
    { ...DEFAULTS, canton, plateCode, officialUrl, ...overrides },
  ]),
);
