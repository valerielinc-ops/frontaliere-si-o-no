/**
 * Runtime-neutral health-premium route table.
 *
 * The static generator/router table lives in
 * `build-plugins/shared/healthPremiumsPaths.ts`, which is TypeScript and
 * cannot be imported by the standalone Node audits. Keep the route data here
 * so the browser/build path facade and the information-gain audit consume the
 * same canonical root, canton, and age-bracket definitions.
 *
 * This module deliberately has no Node-only imports: Vite can bundle it for
 * the route facade, while the audit can load it directly in Node.
 */

export const HEALTH_PREMIUM_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);

export const HEALTH_PREMIUM_CANTONS = Object.freeze([
  'ticino',
  'grigioni',
  'uri',
  'vallese',
  'zurigo',
  'argovia',
  'appenzello-interno',
  'appenzello-esterno',
  'berna',
  'basilea-campagna',
  'basilea-citta',
  'friborgo',
  'ginevra',
  'glarona',
  'giura',
  'lucerna',
  'neuchatel',
  'nidvaldo',
  'obvaldo',
  'san-gallo',
  'sciaffusa',
  'soletta',
  'svitto',
  'turgovia',
  'vaud',
  'zugo',
]);

export const HEALTH_PREMIUM_AGE_BRACKETS = Object.freeze([
  { id: '0-18', min: 0, max: 18 },
  { id: '19-25', min: 19, max: 25 },
  { id: '26-30', min: 26, max: 30 },
  { id: '31-45', min: 31, max: 45 },
  { id: '46-55', min: 46, max: 55 },
  { id: '56-plus', min: 56, max: null },
]);

export const HEALTH_PREMIUM_CANTON_SLUG = Object.freeze({
  it: {
    ticino: 'ticino',
    grigioni: 'grigioni',
    uri: 'uri',
    vallese: 'vallese',
    zurigo: 'zurigo',
    argovia: 'argovia',
    'appenzello-interno': 'appenzello-interno',
    'appenzello-esterno': 'appenzello-esterno',
    berna: 'berna',
    'basilea-campagna': 'basilea-campagna',
    'basilea-citta': 'basilea-citta',
    friborgo: 'friborgo',
    ginevra: 'ginevra',
    glarona: 'glarona',
    giura: 'giura',
    lucerna: 'lucerna',
    neuchatel: 'neuchatel',
    nidvaldo: 'nidvaldo',
    obvaldo: 'obvaldo',
    'san-gallo': 'san-gallo',
    sciaffusa: 'sciaffusa',
    soletta: 'soletta',
    svitto: 'svitto',
    turgovia: 'turgovia',
    vaud: 'vaud',
    zugo: 'zugo',
  },
  en: {
    ticino: 'ticino',
    grigioni: 'graubunden',
    uri: 'uri',
    vallese: 'valais',
    zurigo: 'zurich',
    argovia: 'aargau',
    'appenzello-interno': 'appenzell-innerrhoden',
    'appenzello-esterno': 'appenzell-ausserrhoden',
    berna: 'bern',
    'basilea-campagna': 'basel-landschaft',
    'basilea-citta': 'basel-stadt',
    friborgo: 'fribourg',
    ginevra: 'geneva',
    glarona: 'glarus',
    giura: 'jura',
    lucerna: 'lucerne',
    neuchatel: 'neuchatel',
    nidvaldo: 'nidwalden',
    obvaldo: 'obwalden',
    'san-gallo': 'st-gallen',
    sciaffusa: 'schaffhausen',
    soletta: 'solothurn',
    svitto: 'schwyz',
    turgovia: 'thurgau',
    vaud: 'vaud',
    zugo: 'zug',
  },
  de: {
    ticino: 'tessin',
    grigioni: 'graubuenden',
    uri: 'uri',
    vallese: 'wallis',
    zurigo: 'zuerich',
    argovia: 'aargau',
    'appenzello-interno': 'appenzell-innerrhoden',
    'appenzello-esterno': 'appenzell-ausserrhoden',
    berna: 'bern',
    'basilea-campagna': 'basel-landschaft',
    'basilea-citta': 'basel-stadt',
    friborgo: 'freiburg',
    ginevra: 'genf',
    glarona: 'glarus',
    giura: 'jura',
    lucerna: 'luzern',
    neuchatel: 'neuenburg',
    nidvaldo: 'nidwalden',
    obvaldo: 'obwalden',
    'san-gallo': 'st-gallen',
    sciaffusa: 'schaffhausen',
    soletta: 'solothurn',
    svitto: 'schwyz',
    turgovia: 'thurgau',
    vaud: 'waadt',
    zugo: 'zug',
  },
  fr: {
    ticino: 'tessin',
    grigioni: 'grisons',
    uri: 'uri',
    vallese: 'valais',
    zurigo: 'zurich',
    argovia: 'argovie',
    'appenzello-interno': 'appenzell-rhodes-interieures',
    'appenzello-esterno': 'appenzell-rhodes-exterieures',
    berna: 'berne',
    'basilea-campagna': 'bale-campagne',
    'basilea-citta': 'bale-ville',
    friborgo: 'fribourg',
    ginevra: 'geneve',
    glarona: 'glaris',
    giura: 'jura',
    lucerna: 'lucerne',
    neuchatel: 'neuchatel',
    nidvaldo: 'nidwald',
    obvaldo: 'obwald',
    'san-gallo': 'saint-gall',
    sciaffusa: 'schaffhouse',
    soletta: 'soleure',
    svitto: 'schwytz',
    turgovia: 'thurgovie',
    vaud: 'vaud',
    zugo: 'zoug',
  },
});

export const HEALTH_PREMIUM_AGE_SLUG = Object.freeze({
  it: {
    '0-18': 'bambini-0-18',
    '19-25': 'giovani-adulti-19-25',
    '26-30': 'adulto-26-30',
    '31-45': 'adulto-31-45',
    '46-55': 'adulto-46-55',
    '56-plus': 'adulto-56-piu',
  },
  en: {
    '0-18': 'children-0-18',
    '19-25': 'young-adults-19-25',
    '26-30': 'adult-26-30',
    '31-45': 'adult-31-45',
    '46-55': 'adult-46-55',
    '56-plus': 'adult-56-plus',
  },
  de: {
    '0-18': 'kinder-0-18',
    '19-25': 'junge-erwachsene-19-25',
    '26-30': 'erwachsene-26-30',
    '31-45': 'erwachsene-31-45',
    '46-55': 'erwachsene-46-55',
    '56-plus': 'erwachsene-56-plus',
  },
  fr: {
    '0-18': 'enfants-0-18',
    '19-25': 'jeunes-adultes-19-25',
    '26-30': 'adulte-26-30',
    '31-45': 'adulte-31-45',
    '46-55': 'adulte-46-55',
    '56-plus': 'adulte-56-plus',
  },
});

export const HEALTH_PREMIUM_LOCALE_PREFIX = Object.freeze({
  it: '',
  en: '/en',
  de: '/de',
  fr: '/fr',
});

export const HEALTH_PREMIUM_SECTION_SLUG = Object.freeze({
  it: 'premi-cassa-malati',
  en: 'health-insurance-premiums',
  de: 'krankenkassenpraemien',
  fr: 'primes-assurance-maladie',
});

function joinPath(parts) {
  const clean = parts
    .map((part) => String(part).replace(/^\/+|\/+$/g, ''))
    .filter((part) => part.length > 0);
  return `/${clean.join('/')}/`;
}

export function buildHealthPremiumsRootPath(locale) {
  return joinPath([HEALTH_PREMIUM_LOCALE_PREFIX[locale], HEALTH_PREMIUM_SECTION_SLUG[locale]]);
}

export function buildHealthPremiumsCantonPath(locale, canton) {
  return joinPath([
    HEALTH_PREMIUM_LOCALE_PREFIX[locale],
    HEALTH_PREMIUM_SECTION_SLUG[locale],
    HEALTH_PREMIUM_CANTON_SLUG[locale][canton],
  ]);
}

export function buildHealthPremiumsLeafPath(locale, canton, age) {
  return joinPath([
    HEALTH_PREMIUM_LOCALE_PREFIX[locale],
    HEALTH_PREMIUM_SECTION_SLUG[locale],
    HEALTH_PREMIUM_CANTON_SLUG[locale][canton],
    HEALTH_PREMIUM_AGE_SLUG[locale][age],
  ]);
}

export function listHealthPremiumsPaths() {
  const paths = [];
  for (const locale of HEALTH_PREMIUM_LOCALES) {
    paths.push({ locale, kind: 'root', path: buildHealthPremiumsRootPath(locale) });
    for (const canton of HEALTH_PREMIUM_CANTONS) {
      paths.push({ locale, kind: 'canton', canton, path: buildHealthPremiumsCantonPath(locale, canton) });
      for (const age of HEALTH_PREMIUM_AGE_BRACKETS) {
        paths.push({
          locale,
          kind: 'leaf',
          canton,
          age: age.id,
          path: buildHealthPremiumsLeafPath(locale, canton, age.id),
        });
      }
    }
  }
  return paths;
}

export const HEALTH_PREMIUMS_ROUTES = Object.freeze(listHealthPremiumsPaths().map(({ path }) => path));
const HEALTH_PREMIUMS_ROUTE_SET = new Set(HEALTH_PREMIUMS_ROUTES);

/**
 * Match a canonical URL path or a dist-relative `index.html` path.
 *
 * The audit receives paths relative to `dist`, while router callers pass URL
 * paths. Normalising both forms here keeps the route set exact without making
 * the audit duplicate the TS route table or accept lookalike slugs.
 */
function normalisePathname(pathname) {
  let value = String(pathname || '').replace(/\\/g, '/').split(/[?#]/, 1)[0];
  value = value.replace(/^\/+/, '');
  if (value.startsWith('dist/')) value = value.slice('dist/'.length);
  if (value.endsWith('/index.html')) value = value.slice(0, -'index.html'.length);
  else if (value.endsWith('.html')) value = value.slice(0, -'.html'.length);
  return `/${value.replace(/\/+$/, '')}/`;
}

export function isHealthPremiumsPath(pathname) {
  return HEALTH_PREMIUMS_ROUTE_SET.has(normalisePathname(pathname));
}
