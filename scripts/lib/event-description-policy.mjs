import crypto from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const EVENT_DESCRIPTION_LOCALES = Object.freeze(['it', 'en', 'de', 'fr']);
export const EVENT_DESCRIPTION_REWRITE_MODEL = 'gpt-5.6-luna';
export const EVENT_DESCRIPTION_PROMPT_VERSION = 'event-description-rewrite-v2';
export const EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION = 1;
export const EVENT_DESCRIPTION_MIN_SHARED_NGRAM = 8;
export const EVENT_DESCRIPTION_MIN_CHARS = 30;
const ACCEPTED_CACHE_PROMPT_VERSIONS = new Set([
  'event-description-rewrite-v1',
  EVENT_DESCRIPTION_PROMPT_VERSION,
]);
const MODULE_REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

export function isValidSourceDescriptionHash(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

const DESCRIPTION_FIELDS = Object.freeze({
  fallback: 'description',
  byLocale: 'descriptionByLocale',
});

const SOURCE_DESCRIPTION_FIELDS = Object.freeze({
  fallback: 'sourceDescription',
  byLocale: 'sourceDescriptionByLocale',
});

const FACT_FIELDS = Object.freeze([
  'id',
  'title',
  'titleByLocale',
  'startDate',
  'endDate',
  'startTime',
  'category',
  'region',
  'venue',
  'address',
  'comune',
  'comuneMatch',
  'canton',
  'url',
  'price',
  'performer',
  'organizer',
  'sourceKey',
  'sourceName',
  'eventStatus',
  'recurring',
  'crawledAt',
]);

const PROMOTIONAL_WORDS = new Set([
  'imperdibile',
  'imperdibili',
  'unico',
  'unica',
  'unici',
  'uniche',
  'straordinario',
  'straordinaria',
  'straordinari',
  'straordinarie',
  'incredibile',
  'incredibili',
  'fantastico',
  'fantastica',
  'fantastici',
  'fantastiche',
  'amazing',
  'unmissable',
  'unique',
  'extraordinary',
  'incredible',
  'fantastic',
  'unvergesslich',
  'einzigartig',
  'aussergewohnlich',
  'außergewöhnlich',
  'incroyable',
  'incontournable',
  'unique',
]);

const CAPITALIZED_NAME_STOPWORDS = new Set([
  'Al', 'Alla', 'Allo', 'Con', 'Da', 'Dal', 'Dalla', 'De', 'Del', 'Della', 'Di', 'E', 'Il', 'In', 'La', 'Le', 'Lo', 'Nel', 'Nella', 'Per', 'Su', 'Un', 'Una',
  'A', 'And', 'At', 'From', 'In', 'Of', 'On', 'The', 'To', 'With',
  'Der', 'Die', 'Das', 'Ein', 'Eine', 'Im', 'In', 'Mit', 'Von', 'Zu', 'Zum', 'Zur',
  'Au', 'Avec', 'Dans', 'De', 'Des', 'Du', 'En', 'Et', 'La', 'Le', 'Les', 'Pour', 'Un', 'Une',
]);

const MONTH_NUMBERS = new Map([
  ['january', 1], ['janvier', 1], ['januar', 1], ['gennaio', 1],
  ['february', 2], ['fevrier', 2], ['februar', 2], ['febbraio', 2],
  ['march', 3], ['mars', 3], ['marz', 3], ['marzo', 3],
  ['april', 4], ['avril', 4], ['aprile', 4],
  ['may', 5], ['mai', 5], ['maggio', 5],
  ['june', 6], ['juin', 6], ['juni', 6], ['giugno', 6],
  ['july', 7], ['juillet', 7], ['juli', 7], ['luglio', 7],
  ['august', 8], ['aout', 8], ['augusto', 8], ['agosto', 8],
  ['september', 9], ['septembre', 9], ['sept', 9], ['settembre', 9],
  ['october', 10], ['octobre', 10], ['oktober', 10], ['ottobre', 10],
  ['november', 11], ['novembre', 11],
  ['december', 12], ['decembre', 12], ['dezember', 12], ['dicembre', 12],
]);

const WEEKDAY_NUMBERS = new Map([
  ['sunday', 0], ['dimanche', 0], ['sonntag', 0], ['domenica', 0],
  ['monday', 1], ['lundi', 1], ['montag', 1], ['lunedi', 1],
  ['tuesday', 2], ['mardi', 2], ['dienstag', 2], ['martedi', 2],
  ['wednesday', 3], ['mercredi', 3], ['mittwoch', 3], ['mercoledi', 3],
  ['thursday', 4], ['jeudi', 4], ['donnerstag', 4], ['giovedi', 4],
  ['friday', 5], ['vendredi', 5], ['freitag', 5], ['venerdi', 5],
  ['saturday', 6], ['samedi', 6], ['samstag', 6], ['sabato', 6],
]);

const CURRENCY_PATTERNS = Object.freeze([
  ['CHF', /\b(?:chf|sfr\.?|swiss\s+francs?|franchi\s+svizzeri?|francs?\s+suisses?|schweizer\s+franken)\b/giu],
  ['EUR', /\b(?:eur|euros?|euro)\b/giu],
  ['USD', /\b(?:usd|us\s+dollars?|dollars?)\b/giu],
  ['GBP', /\b(?:gbp|pounds?|sterline?|livres?\s+sterling)\b/giu],
]);

const CURRENCY_NAME_WORDS = new Set([
  'chf', 'sfr', 'swiss', 'franc', 'francs', 'franchi', 'svizzeri', 'suisse', 'suisses', 'schweizer', 'franken',
  'eur', 'euro', 'euros', 'usd', 'dollar', 'dollars', 'gbp', 'pound', 'pounds', 'sterlina', 'sterline', 'livre', 'sterling',
]);

const PLACE_ALIASES = Object.freeze({
  ti: ['Ticino', 'Tessin'],
  ticino: ['TI', 'Tessin'],
  tessin: ['TI', 'Ticino'],
  gr: ['Graubünden', 'Grisons', 'Grigioni'],
  graubunden: ['GR', 'Grisons', 'Grigioni'],
  grisons: ['GR', 'Graubünden', 'Grigioni'],
  grigioni: ['GR', 'Graubünden', 'Grisons'],
  vs: ['Valais', 'Wallis', 'Vallese'],
  valais: ['VS', 'Wallis', 'Vallese'],
  wallis: ['VS', 'Valais', 'Vallese'],
  vallese: ['VS', 'Valais', 'Wallis'],
  ge: ['Genève', 'Geneva', 'Genf', 'Ginevra'],
  vd: ['Vaud'],
  ne: ['Neuchâtel', 'Neuenburg'],
  fr: ['Fribourg', 'Freiburg', 'Friborgo'],
  lu: ['Luzern', 'Lucerne', 'Lucerna'],
  be: ['Bern', 'Berna'],
  bs: ['Basel', 'Basilea'],
  bl: ['Basel-Landschaft'],
  sg: ['St. Gallen', 'San Gallo', 'Sankt Gallen'],
  ag: ['Aargau', 'Argovia'],
  so: ['Solothurn', 'Soletta'],
  sh: ['Schaffhausen', 'Sciaffusa'],
  sz: ['Schwyz', 'Svitto'],
  zg: ['Zug', 'Zugo'],
  tg: ['Thurgau', 'Turgovia'],
  ur: ['Uri'],
  ow: ['Obwalden'],
  nw: ['Nidwalden'],
  gl: ['Glarus'],
  ai: ['Appenzell Innerrhoden'],
  ar: ['Appenzell Ausserrhoden'],
  ju: ['Jura'],
  zh: ['Zürich', 'Zurich', 'Zurigo'],
  zurich: ['ZH', 'Zürich', 'Zurigo'],
  zurigo: ['ZH', 'Zürich', 'Zurich'],
  geneve: ['Ginevra', 'Geneva', 'Genf'],
  ginevra: ['Genève', 'Geneva', 'Genf'],
  geneva: ['Genève', 'Ginevra', 'Genf'],
  genf: ['Genève', 'Ginevra', 'Geneva'],
  lausanne: ['Losanna'],
  losanna: ['Lausanne'],
  bern: ['Berna'],
  berna: ['Bern'],
  basel: ['Basilea'],
  basilea: ['Basel'],
  chur: ['Coira'],
  coira: ['Chur'],
  lucerne: ['Luzern', 'Lucerna'],
  luzern: ['Lucerne', 'Lucerna'],
  lucerna: ['Lucerne', 'Luzern'],
  biel: ['Bienne'],
  bienne: ['Biel'],
  sion: ['Sitten'],
  sitten: ['Sion'],
  neuchatel: ['Neuenburg'],
  neuenburg: ['Neuchâtel'],
  fribourg: ['Freiburg', 'Friborgo'],
  freiburg: ['Fribourg', 'Friborgo'],
  friborgo: ['Fribourg', 'Freiburg'],
  'st gallen': ['San Gallo', 'Sankt Gallen'],
  'san gallo': ['St. Gallen', 'Sankt Gallen'],
  'sankt gallen': ['St. Gallen', 'San Gallo'],
  aargau: ['Argovia'],
  argovia: ['Aargau'],
  solothurn: ['Soletta'],
  soletta: ['Solothurn'],
  schaffhausen: ['Sciaffusa'],
  sciaffusa: ['Schaffhausen'],
  schwyz: ['Svitto'],
  svitto: ['Schwyz'],
  zug: ['Zugo'],
  zugo: ['Zug'],
  thurgau: ['Turgovia'],
  turgovia: ['Thurgau'],
});

const COMMON_NAME_TRANSLATIONS = Object.freeze({
  museo: ['museum', 'musée'],
  museum: ['museo', 'musée'],
  musee: ['museo', 'museum'],
  civico: ['civic', 'civique', 'städtisch'],
  civic: ['civico', 'civique', 'städtisch'],
  civique: ['civico', 'civic', 'städtisch'],
  stadtisch: ['civico', 'civic', 'civique'],
  teatro: ['theatre', 'theater', 'théâtre'],
  theater: ['teatro', 'theatre', 'théâtre'],
  theatre: ['teatro', 'theater', 'théâtre'],
  comunale: ['municipal', 'communal', 'kommunal'],
  comune: ['municipality', 'commune', 'gemeinde'],
  municipality: ['comune', 'commune', 'gemeinde'],
  commune: ['comune', 'municipality', 'gemeinde'],
  gemeinde: ['comune', 'municipality', 'commune'],
  municipal: ['comunale', 'communal', 'kommunal'],
  communal: ['comunale', 'municipal', 'kommunal'],
  kommunal: ['comunale', 'municipal', 'communal'],
  cantone: ['canton', 'canton', 'kanton'],
  canton: ['cantone', 'kanton'],
  kanton: ['cantone', 'canton'],
  citta: ['city', 'ville', 'stadt'],
  city: ['citta', 'ville', 'stadt'],
  ville: ['citta', 'city', 'stadt'],
  stadt: ['citta', 'city', 'ville'],
  piazza: ['square', 'platz', 'place'],
  square: ['piazza', 'platz', 'place'],
  platz: ['piazza', 'square', 'place'],
  place: ['piazza', 'square', 'platz'],
  chiesa: ['church', 'kirche', 'église'],
  church: ['chiesa', 'kirche', 'église'],
  kirche: ['chiesa', 'church', 'église'],
  eglise: ['chiesa', 'church', 'kirche'],
  sala: ['hall', 'saal', 'salle'],
  hall: ['sala', 'saal', 'salle'],
  saal: ['sala', 'hall', 'salle'],
  salle: ['sala', 'hall', 'saal'],
  centro: ['center', 'centre', 'zentrum'],
  center: ['centro', 'centre', 'zentrum'],
  centre: ['centro', 'center', 'zentrum'],
  zentrum: ['centro', 'center', 'centre'],
  castello: ['castle', 'schloss', 'château'],
  castle: ['castello', 'schloss', 'château'],
  schloss: ['castello', 'castle', 'château'],
  chateau: ['castello', 'castle', 'schloss'],
  stazione: ['station', 'bahnhof', 'gare'],
  station: ['stazione', 'bahnhof', 'gare'],
  bahnhof: ['stazione', 'station', 'gare'],
  gare: ['stazione', 'station', 'bahnhof'],
  scuola: ['school', 'schule', 'école'],
  school: ['scuola', 'schule', 'école'],
  schule: ['scuola', 'school', 'école'],
  ecole: ['scuola', 'school', 'schule'],
  biblioteca: ['library', 'bibliothek', 'bibliothèque'],
  library: ['biblioteca', 'bibliothek', 'bibliothèque'],
  bibliothek: ['biblioteca', 'library', 'bibliothèque'],
  bibliotheque: ['biblioteca', 'library', 'bibliothek'],
  parco: ['park', 'parc'],
  park: ['parco', 'parc'],
  parc: ['parco', 'park'],
});

function usableText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Keep source hashes stable across harmless whitespace/Unicode presentation changes. */
export function normalizeDescriptionText(value) {
  return usableText(value) ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
}

function readDescriptionFields(event, fields) {
  const byLocale = {};
  const rawByLocale = event?.[fields.byLocale];
  for (const locale of EVENT_DESCRIPTION_LOCALES) {
    const text = normalizeDescriptionText(rawByLocale?.[locale]);
    if (text) byLocale[locale] = text;
  }
  const fallback = normalizeDescriptionText(event?.[fields.fallback]);
  return { byLocale, fallback };
}

function canonicalDescriptionPayload({ byLocale, fallback }) {
  return Object.fromEntries([
    ...EVENT_DESCRIPTION_LOCALES.filter((locale) => byLocale[locale]).map((locale) => [locale, byLocale[locale]]),
    ...(fallback ? [['_fallback', fallback]] : []),
  ]);
}

export function sourceDescriptionHash(event) {
  const fields = readDescriptionFields(event, DESCRIPTION_FIELDS);
  if (!fields.fallback && Object.keys(fields.byLocale).length === 0) return null;
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalDescriptionPayload(fields)))
    .digest('hex');
}

export function sourceDescriptionTexts(event) {
  const fields = readDescriptionFields(event, DESCRIPTION_FIELDS);
  return [...Object.values(fields.byLocale), fields.fallback].filter(Boolean);
}

export function sourceDescriptionRecord(event) {
  const fields = readDescriptionFields(event, DESCRIPTION_FIELDS);
  if (!fields.fallback && Object.keys(fields.byLocale).length === 0) return null;
  const facts = Object.fromEntries(FACT_FIELDS.filter((field) => event?.[field] !== undefined).map((field) => [field, event[field]]));
  return {
    id: event.id,
    sourceKey: event.sourceKey,
    sourceName: event.sourceName,
    sourceDescriptionHash: sourceDescriptionHash(event),
    ...(fields.fallback ? { sourceDescription: fields.fallback } : {}),
    ...(Object.keys(fields.byLocale).length ? { sourceDescriptionByLocale: fields.byLocale } : {}),
    facts,
  };
}

/**
 * Append the crawler's private input to a JSONL file outside the checkout.
 * The caller opts in with EVENT_DESCRIPTION_SOURCE_EXPORT_PATH; no crawler
 * writes source prose unless that path is explicitly supplied.
 */
export function appendPrivateEventDescriptionSources(events, targetPath = process.env.EVENT_DESCRIPTION_SOURCE_EXPORT_PATH) {
  if (!targetPath) return 0;
  const absoluteTarget = path.resolve(targetPath);
  const checkout = MODULE_REPO_ROOT;
  if (absoluteTarget === checkout || absoluteTarget.startsWith(`${checkout}${path.sep}`)) {
    throw new Error('EVENT_DESCRIPTION_SOURCE_EXPORT_PATH must be outside the checkout');
  }
  const records = events.map(sourceDescriptionRecord).filter(Boolean);
  if (!records.length) return 0;
  mkdirSync(path.dirname(absoluteTarget), { recursive: true, mode: 0o700 });
  appendFileSync(absoluteTarget, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, { mode: 0o600 });
  chmodSync(absoluteTarget, 0o600);
  return records.length;
}

/** Remove every acquired description before a slice or dataset can be written. */
export function sanitizeEventForPublication(event) {
  if (!event || typeof event !== 'object') return event;
  // A dataset event may already carry our rewritten prose. In that case the
  // stored hash is the source hash and must win; hashing the rewritten prose
  // again would make a later assembly miss the cache and erase the rewrite.
  const hash = isValidSourceDescriptionHash(event.sourceDescriptionHash)
    ? event.sourceDescriptionHash
    : sourceDescriptionHash(event);
  const {
    description: _description,
    descriptionByLocale: _descriptionByLocale,
    descriptionRewriteValidated: _descriptionRewriteValidated,
    sourceDescription: _sourceDescription,
    sourceDescriptionByLocale: _sourceDescriptionByLocale,
    ...withoutSourceText
  } = event;
  return hash ? { ...withoutSourceText, sourceDescriptionHash: hash } : withoutSourceText;
}

export function rewriteCacheKey(id, sourceHash) {
  return `${String(id)}::${String(sourceHash)}`;
}

export function loadEventDescriptionRewriteCache(filePath) {
  if (!existsSync(filePath)) return { schemaVersion: EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION, entries: {} };
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : { schemaVersion: EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION, entries: {} };
  } catch {
    return { schemaVersion: EVENT_DESCRIPTION_CACHE_SCHEMA_VERSION, entries: {} };
  }
}

function cacheEntryDescriptions(entry) {
  const byLocale = entry?.descriptionByLocale;
  if (!byLocale || typeof byLocale !== 'object') return null;
  const normalized = {};
  for (const locale of EVENT_DESCRIPTION_LOCALES) {
    const text = normalizeDescriptionText(byLocale[locale]);
    if (!text) return null;
    normalized[locale] = text;
  }
  return normalized;
}

export function isValidRewriteCacheEntry(entry, { id, sourceHash } = {}) {
  if (!entry || entry.id !== id || !isValidSourceDescriptionHash(sourceHash) || entry.sourceDescriptionHash !== sourceHash) return false;
  // Prompt v2 changes generation and retry guidance, not the source hash or
  // either safety invariant. Keep already-published v1 entries usable until
  // their source changes; new entries are written with the current version.
  if (entry.model !== EVENT_DESCRIPTION_REWRITE_MODEL || !ACCEPTED_CACHE_PROMPT_VERSIONS.has(entry.promptVersion)) return false;
  if (!usableText(entry.rewrittenAt) || Number.isNaN(Date.parse(entry.rewrittenAt))) return false;
  const descriptions = cacheEntryDescriptions(entry);
  if (!descriptions || normalizeDescriptionText(entry.description) !== descriptions.it) return false;
  // The publication gate has no private source export to compare against.
  // Reuse the candidate as factual context only for structural checks (length,
  // markup and promotional language); source-overlap and new-fact checks run
  // at generation time while the private input is still available.
  return EVENT_DESCRIPTION_LOCALES.every((locale) => validateRewriteDescription(descriptions[locale], {
    factTexts: [descriptions[locale]],
  }).ok);
}

/** Apply only an exact id+source-hash cache hit. A miss is deliberately factual-only. */
export function applyDescriptionRewrite(event, cache) {
  const factual = sanitizeEventForPublication(event);
  const hash = factual?.sourceDescriptionHash;
  if (!factual?.id || !hash) return factual;
  const entries = cache?.entries || cache;
  const entry = entries?.[rewriteCacheKey(factual.id, hash)];
  if (!isValidRewriteCacheEntry(entry, { id: factual.id, sourceHash: hash })) return factual;
  const descriptionByLocale = cacheEntryDescriptions(entry);
  return {
    ...factual,
    description: descriptionByLocale.it,
    descriptionByLocale,
    descriptionRewriteValidated: true,
  };
}

/** Remove legacy/raw description translation entries before a crawler persists its cache. */
export function stripDescriptionTranslationCache(cache) {
  if (!cache || typeof cache !== 'object') return 0;
  let removed = 0;
  for (const key of Object.keys(cache)) {
    if (key.startsWith('description::')) {
      delete cache[key];
      removed += 1;
    }
  }
  return removed;
}

function comparisonTokens(value) {
  return normalizeDescriptionText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ßẞ]/gu, 'ss')
    .toLocaleLowerCase('und')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizeWordPhrase(value) {
  return comparisonTokens(value).join(' ');
}

function italianNumberUnder100(value) {
  const units = ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove', 'dieci', 'undici', 'dodici', 'tredici', 'quattordici', 'quindici', 'sedici', 'diciassette', 'diciotto', 'diciannove'];
  const tens = ['', '', 'venti', 'trenta', 'quaranta', 'cinquanta', 'sessanta', 'settanta', 'ottanta', 'novanta'];
  if (value < 20) return units[value];
  const ten = tens[Math.floor(value / 10)];
  const unit = value % 10;
  if (!unit) return ten;
  const stem = unit === 1 || unit === 8 ? ten.slice(0, -1) : ten;
  return `${stem}${units[unit]}`;
}

function italianNumber(value) {
  if (value < 100) return italianNumberUnder100(value);
  if (value < 1000) {
    const hundreds = Math.floor(value / 100);
    const remainder = value % 100;
    const prefix = hundreds === 1 ? 'cento' : `${italianNumberUnder100(hundreds)}cento`;
    const adjusted = remainder >= 80 && hundreds === 1 ? prefix.slice(0, -1) : prefix;
    return `${adjusted}${remainder ? italianNumberUnder100(remainder) : ''}`;
  }
  const thousands = Math.floor(value / 1000);
  const remainder = value % 1000;
  const prefix = thousands === 1 ? 'mille' : `${italianNumber(thousands)}mila`;
  return `${prefix}${remainder ? italianNumber(remainder) : ''}`;
}

function englishNumber(value) {
  const units = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  if (value < 20) return units[value];
  if (value < 100) return `${tens[Math.floor(value / 10)]}${value % 10 ? ` ${units[value % 10]}` : ''}`;
  if (value < 1000) return `${units[Math.floor(value / 100)]} hundred${value % 100 ? ` ${englishNumber(value % 100)}` : ''}`;
  return `${englishNumber(Math.floor(value / 1000))} thousand${value % 1000 ? ` ${englishNumber(value % 1000)}` : ''}`;
}

function germanNumberUnder100(value) {
  const units = ['', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf', 'zwölf', 'dreizehn', 'vierzehn', 'fünfzehn', 'sechzehn', 'siebzehn', 'achtzehn', 'neunzehn'];
  const tens = ['', '', 'zwanzig', 'dreißig', 'vierzig', 'fünfzig', 'sechzig', 'siebzig', 'achtzig', 'neunzig'];
  if (value < 20) return units[value];
  const unit = value % 10;
  if (!unit) return tens[Math.floor(value / 10)];
  return `${unit === 1 ? 'ein' : units[unit]}und${tens[Math.floor(value / 10)]}`;
}

function germanNumber(value) {
  if (value < 100) return germanNumberUnder100(value);
  if (value < 1000) return `${value / 100 < 1 ? '' : (Math.floor(value / 100) === 1 ? 'ein' : germanNumberUnder100(Math.floor(value / 100)))}hundert${value % 100 ? germanNumberUnder100(value % 100) : ''}`;
  const thousands = Math.floor(value / 1000);
  return `${thousands === 1 ? 'ein' : germanNumber(thousands)}tausend${value % 1000 ? germanNumber(value % 1000) : ''}`;
}

function frenchNumberUnder100(value) {
  const small = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze', 'treize', 'quatorze', 'quinze', 'seize'];
  const tens = ['', '', 'vingt', 'trente', 'quarante', 'cinquante', 'soixante'];
  if (value < 17) return small[value];
  if (value < 20) return `dix-${small[value - 10]}`;
  if (value < 70) {
    const ten = tens[Math.floor(value / 10)];
    const unit = value % 10;
    return `${ten}${unit ? (unit === 1 ? ' et un' : `-${small[unit]}`) : ''}`;
  }
  if (value < 80) return value === 71 ? 'soixante et onze' : `soixante-${frenchNumberUnder100(value - 60)}`;
  if (value < 100) return value === 80 ? 'quatre-vingts' : `quatre-vingt-${frenchNumberUnder100(value - 80)}`;
  return '';
}

function frenchNumber(value) {
  if (value < 100) return frenchNumberUnder100(value);
  if (value < 1000) {
    const hundreds = Math.floor(value / 100);
    const prefix = hundreds === 1 ? 'cent' : `${frenchNumberUnder100(hundreds)} cent`;
    return `${prefix}${value % 100 ? ` ${frenchNumberUnder100(value % 100)}` : hundreds > 1 ? 's' : ''}`;
  }
  const thousands = Math.floor(value / 1000);
  return `${thousands === 1 ? 'mille' : `${frenchNumber(thousands)} mille`}${value % 1000 ? ` ${frenchNumber(value % 1000)}` : ''}`;
}

function buildNumberWordValues() {
  const values = new Map();
  const add = (value, form) => {
    const phrase = normalizeWordPhrase(form);
    if (!phrase) return;
    // These forms are also common articles, not reliable numeric evidence.
    if (new Set(['un', 'une', 'uno', 'una', 'ein', 'eine']).has(phrase)) return;
    values.set(phrase, String(value));
  };
  for (let value = 0; value <= 9999; value += 1) {
    add(value, englishNumber(value));
    add(value, italianNumber(value));
    add(value, germanNumber(value));
    add(value, frenchNumber(value));
  }
  return values;
}

const NUMBER_WORD_VALUES = buildNumberWordValues();

export function findSharedSourceNgram(candidate, sourceTexts, minWords = EVENT_DESCRIPTION_MIN_SHARED_NGRAM) {
  const candidateTokens = comparisonTokens(candidate);
  if (candidateTokens.length < minWords) return false;
  const sourceWindows = new Set();
  for (const source of sourceTexts || []) {
    const tokens = comparisonTokens(source);
    for (let i = 0; i <= tokens.length - minWords; i += 1) {
      sourceWindows.add(tokens.slice(i, i + minWords).join(' '));
    }
  }
  for (let i = 0; i <= candidateTokens.length - minWords; i += 1) {
    if (sourceWindows.has(candidateTokens.slice(i, i + minWords).join(' '))) return true;
  }
  return false;
}

function numericTokens(value) {
  return [...normalizeDescriptionText(value).matchAll(/\b\d+(?:[.,]\d+)*\b/g)].map((match) => {
    const normalized = match[0].replace(',', '.');
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? String(numeric) : normalized;
  });
}

function monthNumbers(value) {
  return [...new Set(comparisonTokens(value).flatMap((token) => (MONTH_NUMBERS.has(token) ? [String(MONTH_NUMBERS.get(token))] : [])))];
}

function weekdayNumbers(value) {
  return [...new Set(comparisonTokens(value).flatMap((token) => (WEEKDAY_NUMBERS.has(token) ? [WEEKDAY_NUMBERS.get(token)] : [])))];
}

function numericValues(value) {
  // Time expressions are checked separately by structuredFactSignatures. Do
  // not compare their surface hour as a standalone number (`6:30 pm` vs
  // `18:30`), or an equivalent 12/24-hour rendering becomes a false new fact.
  const withoutTimes = normalizeDescriptionText(value)
    .replace(/\b\d{1,2}[:.]\d{2}\s*(?:am|pm)\b/giu, ' ')
    .replace(/\b\d{1,2}\s*(?:h|uhr)\s*\d{2}\b/giu, ' ')
    .replace(/\b\d{1,2}[:.]\d{2}\b/gu, ' ');
  return new Set([...numericTokens(withoutTimes), ...monthNumbers(value), ...numberWordValues(value)]);
}

function numberWordValues(value) {
  const tokens = comparisonTokens(value);
  const values = new Set();
  for (let start = 0; start < tokens.length; start += 1) {
    for (let width = 1; width <= Math.min(6, tokens.length - start); width += 1) {
      const phrase = tokens.slice(start, start + width).join(' ');
      const numeric = NUMBER_WORD_VALUES.get(phrase);
      if (numeric !== undefined) values.add(numeric);
    }
  }
  return values;
}

function canonicalDate(year, month, day) {
  const fullYear = year < 100 ? 2000 + year : year;
  const date = new Date(Date.UTC(fullYear, month - 1, day));
  if (
    date.getUTCFullYear() !== fullYear
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return `${String(fullYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function structuredFactSignatures(value) {
  const text = normalizeDescriptionText(value);
  const signatures = new Set();
  for (const match of text.matchAll(/\b(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\b/gu)) {
    const date = canonicalDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) {
      signatures.add(`date:${date}`);
      signatures.add(`month:${Number(match[2])}`);
      signatures.add(`weekday:${new Date(`${date}T00:00:00Z`).getUTCDay()}`);
    }
  }
  for (const match of text.matchAll(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/gu)) {
    const date = canonicalDate(Number(match[3]), Number(match[2]), Number(match[1]));
    if (date) {
      signatures.add(`date:${date}`);
      signatures.add(`month:${Number(match[2])}`);
      signatures.add(`weekday:${new Date(`${date}T00:00:00Z`).getUTCDay()}`);
    }
  }
  for (const match of text.matchAll(/\b(\d{1,2})[:.](\d{2})\b(?!\s*(?:am|pm)\b)/giu)) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour < 24 && minute < 60) signatures.add(`time:${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  }
  for (const match of text.matchAll(/\b(\d{1,2})\s*(?:h|uhr)\s*(\d{2})?\b/giu)) {
    const hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    if (hour < 24 && minute < 60) signatures.add(`time:${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  }
  for (const match of text.matchAll(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)\b/giu)) {
    const rawHour = Number(match[1]);
    const minute = Number(match[2] || 0);
    if (rawHour >= 1 && rawHour <= 12 && minute < 60) {
      const hour = match[3].toLowerCase() === 'pm' ? (rawHour === 12 ? 12 : rawHour + 12) : (rawHour === 12 ? 0 : rawHour);
      signatures.add(`time:${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
    }
  }
  for (const month of monthNumbers(text)) signatures.add(`month:${month}`);
  for (const weekday of weekdayNumbers(text)) signatures.add(`weekday:${weekday}`);

  const currency = (value) => {
    const normalized = String(value).toUpperCase().replace(/\.$/u, '');
    if (normalized === 'SFR') return 'CHF';
    return normalized;
  };
  const amount = (value) => {
    const numeric = Number(String(value).replace(',', '.'));
    return Number.isFinite(numeric) ? String(numeric) : null;
  };
  const addPrice = (rawAmount, rawCurrency) => {
    const normalizedAmount = amount(rawAmount);
    const normalizedCurrency = currency(rawCurrency);
    if (normalizedAmount && ['CHF', 'EUR', 'USD', 'GBP'].includes(normalizedCurrency)) {
      signatures.add(`price:${normalizedAmount}:${normalizedCurrency}`);
    }
  };
  // Facts are often passed as JSON (`amount` + `currency`) rather than as a
  // human-formatted price. Accept either representation while still binding
  // the amount to the currency.
  for (const match of text.matchAll(/(?:["']?(?:amount|lowPrice|highPrice)["']?\s*:\s*)(\d+(?:[.,]\d+)?)\s*,\s*["']?currency["']?\s*:\s*["']?(CHF|SFr\.?|EUR|USD|GBP)/giu)) {
    addPrice(match[1], match[2]);
  }
  for (const match of text.matchAll(/\b(CHF|SFr\.?|EUR|USD|GBP)\s*(\d+(?:[.,]\d+)?)\b/giu)) {
    addPrice(match[2], match[1]);
  }
  for (const match of text.matchAll(/\b(\d+(?:[.,]\d+)?)\s*(CHF|SFr\.?|EUR|USD|GBP)\b/giu)) {
    addPrice(match[1], match[2]);
  }
  for (const match of text.matchAll(/([€$£])\s*(\d+(?:[.,]\d+)?)/gu)) {
    addPrice(match[2], { '€': 'EUR', '$': 'USD', '£': 'GBP' }[match[1]]);
  }
  for (const match of text.matchAll(/\b(\d+(?:[.,]\d+)?)\s*([€$£])/gu)) {
    addPrice(match[1], { '€': 'EUR', '$': 'USD', '£': 'GBP' }[match[2]]);
  }
  for (const [code, pattern] of CURRENCY_PATTERNS) {
    const before = new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*${pattern.source}\\b`, 'giu');
    const after = new RegExp(`\\b${pattern.source}\\s*(\\d+(?:[.,]\\d+)?)\\b`, 'giu');
    for (const match of text.matchAll(before)) addPrice(match[1], code);
    for (const match of text.matchAll(after)) addPrice(match[1], code);
  }
  return signatures;
}

function currencySignatures(value) {
  const text = normalizeDescriptionText(value);
  const signatures = new Set([...text.matchAll(/\b(CHF|SFr\.?|EUR|USD|GBP)\b/giu)].map((match) => {
    const normalized = match[1].toUpperCase().replace(/\.$/u, '');
    return normalized === 'SFR' ? 'CHF' : normalized;
  }));
  for (const [code, pattern] of CURRENCY_PATTERNS) {
    if (pattern.test(text)) signatures.add(code);
    pattern.lastIndex = 0;
  }
  return signatures;
}

function capitalizedNameRuns(value) {
  const runs = [];
  for (const sentence of normalizeDescriptionText(value).split(/[.!?…]+/u)) {
    const tokens = sentence.split(/\s+/);
    let current = [];
    const flush = () => {
      const normalized = comparisonTokens(current.join(' '));
      const currencyRun = normalized.length >= 2 && normalized.every((token) => CURRENCY_NAME_WORDS.has(token));
      if (current.length >= 2 && !CAPITALIZED_NAME_STOPWORDS.has(current[0]) && !currencyRun) runs.push(current.join(' '));
      current = [];
    };
    for (const rawToken of tokens) {
      const token = rawToken.replace(/^[^\p{L}]+|[^\p{L}'’\-]+$/gu, '');
      if (/^\p{Lu}[\p{L}'’\-]+$/u.test(token)) current.push(token);
      else flush();
      // A comma, pipe, slash or similar punctuation separates two factual
      // names even when both sides are capitalised (for example a venue and
      // its street). Do not turn those adjacent, independently-known names
      // into a fabricated multi-word proper name.
      if (/[,:;|/()[\]{}]/u.test(rawToken)) flush();
    }
    flush();
  }
  return runs;
}

function expandStructuredFactTexts(values) {
  const expanded = [];
  const visit = (value) => {
    if (typeof value === 'string') {
      expanded.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  for (const value of values || []) {
    if (typeof value === 'string' && /^[\[{]/u.test(value.trim())) {
      try {
        visit(JSON.parse(value));
        continue;
      } catch {
        // Keep the original text when a fact is only JSON-like prose.
      }
    }
    visit(value);
  }
  return expanded;
}

function addCommonNameAliases(phrases, phrase) {
  const tokens = comparisonTokens(phrase);
  if (!tokens.length || tokens.length > 6) return;
  const alternatives = tokens.map((token) => [token, ...(COMMON_NAME_TRANSLATIONS[token] || [])]);
  const variants = new Set();
  const visit = (index, current) => {
    if (variants.size >= 64) return;
    if (index === alternatives.length) {
      variants.add(current.join(' '));
      if (current.length >= 2 && current.length <= 3) variants.add([...current].reverse().join(' '));
      return;
    }
    for (const option of alternatives[index]) visit(index + 1, [...current, ...comparisonTokens(option)]);
  };
  visit(0, []);
  for (const variant of variants) phrases.add(variant);
}

function addPlaceAliases(phrases, phrase) {
  const normalized = normalizeWordPhrase(phrase);
  if (!normalized) return;
  const aliases = PLACE_ALIASES[normalized];
  if (!aliases) return;
  phrases.add(normalized);
  for (const alias of aliases) phrases.add(normalizeWordPhrase(alias));
  if (normalized.length <= 3 || normalized === 'ticino' || normalized === 'tessin') {
    for (const prefix of ['canton', 'canton de', 'canton of', 'kanton', 'canton du']) {
      for (const alias of [normalized, ...aliases]) phrases.add(`${prefix} ${normalizeWordPhrase(alias)}`);
    }
  }
}

function allowedNamePhrases(sourceTexts, factTexts) {
  const phrases = new Set();
  for (const value of expandStructuredFactTexts([...(sourceTexts || []), ...(factTexts || [])])) {
    for (const run of capitalizedNameRuns(value)) {
      const normalized = normalizeWordPhrase(run);
      if (normalized) {
        phrases.add(normalized);
        addCommonNameAliases(phrases, run);
        addPlaceAliases(phrases, run);
      }
    }
    const normalized = normalizeWordPhrase(value);
    if (normalized && normalized.split(' ').length <= 6) {
      phrases.add(normalized);
      addCommonNameAliases(phrases, value);
      addPlaceAliases(phrases, value);
    }
  }
  return phrases;
}

function containsAllowedNamePhrase(run, phrases) {
  const normalized = normalizeWordPhrase(run);
  return Boolean(normalized && phrases.has(normalized));
}

function containsPromotionalLanguage(candidate) {
  return comparisonTokens(candidate).some((token) => PROMOTIONAL_WORDS.has(token));
}

function sentenceCount(text) {
  return (normalizeDescriptionText(text).match(/[.!?…]+(?=\s|$)/g) || []).length;
}

/**
 * Validate one generated locale without ever returning source prose in the
 * diagnostic. Error codes are safe for logs and retry prompts.
 */
export function validateRewriteDescription(candidate, { sourceTexts = [], factTexts = [] } = {}) {
  const text = normalizeDescriptionText(candidate);
  if (!text) return { ok: false, code: 'empty' };
  if (text.length < EVENT_DESCRIPTION_MIN_CHARS) return { ok: false, code: 'too-short' };
  const sentences = sentenceCount(text);
  if (sentences < 2 || sentences > 3) return { ok: false, code: 'sentence-count' };
  if (findSharedSourceNgram(text, sourceTexts)) return { ok: false, code: 'source-ngram-8' };
  if (containsPromotionalLanguage(text)) return { ok: false, code: 'promotional-language' };

  const allowedContext = [...sourceTexts, ...factTexts].join(' ');
  const allowedNumbers = numericValues(allowedContext);
  if ([...numericValues(text)].some((number) => !allowedNumbers.has(number))) return { ok: false, code: 'new-number' };
  const allowedStructuredFacts = structuredFactSignatures(allowedContext);
  if ([...structuredFactSignatures(text)].some((signature) => !allowedStructuredFacts.has(signature))) {
    return { ok: false, code: 'new-date-or-price' };
  }
  const allowedCurrencies = currencySignatures(allowedContext);
  if ([...currencySignatures(text)].some((currency) => !allowedCurrencies.has(currency))) {
    return { ok: false, code: 'new-date-or-price' };
  }

  const names = allowedNamePhrases(sourceTexts, factTexts);
  if (capitalizedNameRuns(text).some((run) => !containsAllowedNamePhrase(run, names))) {
    return { ok: false, code: 'new-name' };
  }
  if (/[*_`#<>]/.test(text)) return { ok: false, code: 'markup' };
  return { ok: true };
}

export function validateRewriteBundle(descriptions, { sourceTexts = [], factTexts = [] } = {}) {
  if (!descriptions || typeof descriptions !== 'object') return { ok: false, errors: { bundle: 'missing' } };
  const errors = {};
  for (const locale of EVENT_DESCRIPTION_LOCALES) {
    const result = validateRewriteDescription(descriptions[locale], { sourceTexts, factTexts });
    if (!result.ok) errors[locale] = result.code;
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

export function factsForPrompt(event) {
  const factual = sanitizeEventForPublication(event);
  return Object.fromEntries(FACT_FIELDS.filter((field) => factual?.[field] !== undefined).map((field) => [field, factual[field]]));
}
