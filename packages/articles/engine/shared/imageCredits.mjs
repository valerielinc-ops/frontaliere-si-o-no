/**
 * Credits for the Wikimedia Commons cover photos of the articles (P14).
 *
 * Owner decision, 2026-10-03: «recuperiamo autore e licenza, corregendo i dati
 * strutturati. se dobbiamo mostrare un testo facciamo lo vedere in fondo
 * all'articolo». Until this module, every article ImageObject declared the
 * cover as «© Frontaliere Ticino. Tutti i diritti riservati», created by the
 * site, even when the cover is a CC BY-SA photo by somebody else — which also
 * contradicts the terms page (services/legal/terms.ts: third-party images
 * «restano soggette alle loro licenze»).
 *
 * ONE module, no dependencies, for every surface that shows a cover: the static
 * article page (ogPagesPlugin.ts), the RSS feeds (rssFeeds.mjs), the SPA (it
 * imports `imageCreditParts`) and the corpus generator, which validates the
 * records it writes with `validateImageCreditRecord`. A second copy of the
 * wording or of the licence rules would drift silently (AGENTS.md #6), so the
 * copy lives here and nowhere else. Browser-safe on purpose: no `node:` import,
 * the reader takes `fs` as a parameter.
 *
 * ── The data ──────────────────────────────────────────────────────────────
 * One JSON record per cover FILE, `image-credits/blog/<cover-basename>.json`,
 * written by the corpus generator (`content/image-credits/…` in the corpus,
 * `packages/articles/content/image-credits/…` once pulled into the site). The
 * key is the hero path the renderers already resolve, so a cover reused by
 * another article inherits its credit and an `/og-image.png` fallback gets
 * none. A cover with no record renders exactly as before: the site defaults
 * of `imageObjectLd` and no visible line.
 *
 * ── An unknown author ─────────────────────────────────────────────────────
 * `author.name === null`. Allowed only for CC0, public domain and Flickr
 * «no known restrictions», where attribution is not required. The visible line
 * then says «autore sconosciuto» and the ImageObject creator is
 * `UNKNOWN_AUTHOR_NAME`: `imageObjectLd` falls back to the SITE as creator when
 * no creator is passed, which is the false claim this module removes, and the
 * Commons uploader or Commons itself are never the author. When curation knows
 * the responsible institution it sets it as `author.name` (type Organization)
 * instead, and the line names it.
 */

export const IMAGE_CREDIT_SCHEMA_VERSION = 1;

/** The only source in schema 1. */
export const IMAGE_CREDIT_SOURCE = 'wikimedia-commons';

/** Licence families a record may carry. Anything else is rejected. */
export const IMAGE_CREDIT_LICENCE_FAMILIES = Object.freeze([
  'cc-by',
  'cc-by-sa',
  'cc0',
  'pd',
  'no-known-restrictions',
  'fal',
  'other-attribution',
]);

/** Families whose licence does not require attribution: the credit is a courtesy. */
const COURTESY_FAMILIES = new Set(['cc0', 'pd', 'no-known-restrictions']);

/** Families whose licence must be linked by its own URL (CC 3.0 §4(a), 4.0 §3(a)(1)(C), FAL). */
const LICENCE_URL_REQUIRED = new Set(['cc-by', 'cc-by-sa', 'fal']);

/** Licence URL used when a record of that family carries none. */
const FAMILY_DEFAULT_LICENCE_URL = Object.freeze({
  cc0: 'https://creativecommons.org/publicdomain/zero/1.0/',
  'no-known-restrictions': 'https://www.flickr.com/commons/usage/',
});

/** Copyright notice of the families that have no copyright holder to name. */
const FAMILY_COPYRIGHT_NOTICE = Object.freeze({
  cc0: 'CC0',
  pd: 'Public domain',
  'no-known-restrictions': 'No known copyright restrictions',
});

/** ImageObject creator name when the author is unknown (see the module header). */
export const UNKNOWN_AUTHOR_NAME = 'Unknown author';

const COMMONS_FILE_PAGE_PREFIX = 'https://commons.wikimedia.org/wiki/File:';

/** Display-length guards: a value longer than this is a description, not a name. */
const MAX_LENGTH = Object.freeze({ authorName: 150, attribution: 200, title: 255, licenceName: 80 });

/**
 * @typedef {'cc-by' | 'cc-by-sa' | 'cc0' | 'pd' | 'no-known-restrictions' | 'fal' | 'other-attribution'} ImageCreditLicenceFamily
 * @typedef {'it' | 'en' | 'de' | 'fr'} ImageCreditLocale
 * @typedef {{
 *   title: string,
 *   pageUrl: string,
 *   pageId?: number,
 *   width?: number,
 *   height?: number,
 *   revision?: string,
 *   aliases?: string[],
 * }} ImageCreditCommons
 * @typedef {{
 *   text: string | null,
 *   name: string | null,
 *   url: string | null,
 *   type: 'Person' | 'Organization',
 * }} ImageCreditAuthor
 * @typedef {{
 *   name: string,
 *   url: string | null,
 *   family: ImageCreditLicenceFamily,
 *   attributionRequired: boolean,
 * }} ImageCreditLicence
 * @typedef {{ by: string, at: string, note: string }} ImageCreditCuration
 * @typedef {{
 *   schema: 1,
 *   cover: string,
 *   source: 'wikimedia-commons',
 *   commons: ImageCreditCommons,
 *   author: ImageCreditAuthor,
 *   attribution: string | null,
 *   licence: ImageCreditLicence,
 *   restrictions: string[],
 *   modified: 'cropped' | 'resized',
 *   fetchedAt: string,
 *   status: 'ok' | 'review',
 *   curation: ImageCreditCuration | null,
 * }} ImageCreditRecord
 * @typedef {{
 *   creator: { '@type': 'Person' | 'Organization', name: string, url?: string },
 *   creditText: string,
 *   copyrightNotice: string,
 *   license: string,
 *   acquireLicensePage: string,
 *   isBasedOn: string,
 * }} ImageCreditImageObjectFields
 * @typedef {{
 *   kind: 'text' | 'title' | 'author' | 'licence',
 *   text: string,
 *   href: string | null,
 *   isolate: boolean,
 *   open: string,
 *   close: string,
 * }} ImageCreditSegment
 * @typedef {{ locale: ImageCreditLocale, segments: ImageCreditSegment[], text: string }} ImageCreditParts
 * @typedef {{ valid: boolean, errors: string[] }} ImageCreditValidation
 * @typedef {{
 *   readFileSync: (path: string, encoding: 'utf-8') => string,
 *   existsSync?: (path: string) => boolean,
 * }} ImageCreditFs
 * @typedef {{ get: (cover: string | null | undefined) => ImageCreditRecord | null }} ImageCreditReader
 */

/**
 * The visible line, per locale. Licence names stay as published («CC BY-SA
 * 4.0», «CC0», «GODL-India») except public domain and Flickr Commons, which are
 * descriptions rather than names and are therefore translated.
 */
export const IMAGE_CREDIT_COPY = Object.freeze({
  it: Object.freeze({
    label: 'Immagine di copertina',
    labelSeparator: ': ',
    quoteOpen: '«',
    quoteClose: '»',
    by: ' di ',
    unknownAuthor: 'autore sconosciuto',
    via: 'tramite Wikimedia Commons',
    modified: Object.freeze({ cropped: 'ritagliata e ridimensionata', resized: 'ridimensionata' }),
    licenceNames: Object.freeze({
      pd: 'pubblico dominio',
      'no-known-restrictions': 'nessuna restrizione di copyright nota',
    }),
  }),
  en: Object.freeze({
    label: 'Cover image',
    labelSeparator: ': ',
    quoteOpen: '“',
    quoteClose: '”',
    by: ' by ',
    unknownAuthor: 'author unknown',
    via: 'via Wikimedia Commons',
    modified: Object.freeze({ cropped: 'cropped and resized', resized: 'resized' }),
    licenceNames: Object.freeze({
      pd: 'public domain',
      'no-known-restrictions': 'no known copyright restrictions',
    }),
  }),
  de: Object.freeze({
    label: 'Titelbild',
    labelSeparator: ': ',
    quoteOpen: '„',
    quoteClose: '“',
    by: ' von ',
    unknownAuthor: 'Urheber unbekannt',
    via: 'via Wikimedia Commons',
    modified: Object.freeze({ cropped: 'zugeschnitten und skaliert', resized: 'skaliert' }),
    licenceNames: Object.freeze({
      pd: 'gemeinfrei',
      'no-known-restrictions': 'keine bekannten urheberrechtlichen Beschränkungen',
    }),
  }),
  // French typography: no-break space (U+00A0) before the colon and inside the
  // guillemets. The literal character, not `&nbsp;`, because the same strings
  // also land in RSS XML, where `&nbsp;` is not a defined entity.
  fr: Object.freeze({
    label: 'Image de couverture',
    labelSeparator: ' : ',
    quoteOpen: '« ',
    quoteClose: ' »',
    by: ' par ',
    unknownAuthor: 'auteur inconnu',
    via: 'via Wikimedia Commons',
    modified: Object.freeze({ cropped: 'recadrée et redimensionnée', resized: 'redimensionnée' }),
    licenceNames: Object.freeze({
      pd: 'domaine public',
      'no-known-restrictions': 'aucune restriction de droit d’auteur connue',
    }),
  }),
});

// ── Small helpers ──────────────────────────────────────────────────────────

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** @param {unknown} value */
function isPositiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

/**
 * HTML and XML text/attribute escaping. `&#39;` rather than `&apos;` so the
 * same output is valid in both an HTML attribute and an XML element.
 * @param {string} value
 */
function escapeMarkup(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The value only when it is an absolute https URL; links in the visible credit
 * are emitted from this and nothing else.
 * @param {unknown} value
 * @returns {string | null}
 */
function httpsUrlOrNull(value) {
  if (typeof value !== 'string') return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** @param {unknown} locale @returns {ImageCreditLocale} */
function resolveLocale(locale) {
  return locale === 'en' || locale === 'de' || locale === 'fr' ? locale : 'it';
}

// ── Keys and URLs ──────────────────────────────────────────────────────────

const COVER_PATH_RX =
  /^(?:https?:\/\/[^/?#]+(?:\/[^?#]*)?)?\/images\/blog\/([^/?#]+)\.(?:webp|png|jpe?g|avif)(?:[?#].*)?$/i;
const COVER_KEY_RX = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The record key of a cover: the basename of `/images/blog/<key>.<ext>`.
 *
 * Accepts the site-relative path the renderer resolves (`/images/blog/x.webp`)
 * and the absolute forms the registry carries (CDN or raw GitHub URL, which
 * still end in `/images/blog/x.webp`). Anything else — `/og-image.png`,
 * `/images/places/…`, a thumbnail sub-folder — has no credit record by
 * construction and yields `null`.
 *
 * @param {unknown} pathOrUrl
 * @returns {string | null}
 */
export function coverKey(pathOrUrl) {
  if (typeof pathOrUrl !== 'string') return null;
  const match = pathOrUrl.trim().match(COVER_PATH_RX);
  if (!match) return null;
  const key = match[1];
  return COVER_KEY_RX.test(key) && !key.includes('..') ? key : null;
}

/**
 * Canonical form of a licence URL: https, and for Creative Commons the deed
 * root with a trailing slash (no `deed.xx`, no `legalcode`). `null` for
 * anything that is not an http(s) URL.
 *
 *   http://creativecommons.org/publicdomain/zero/1.0/deed.en
 *     → https://creativecommons.org/publicdomain/zero/1.0/
 *   https://creativecommons.org/licenses/by-sa/4.0
 *     → https://creativecommons.org/licenses/by-sa/4.0/
 *
 * @param {unknown} url
 * @returns {string | null}
 */
export function normaliseLicenceUrl(url) {
  if (typeof url !== 'string') return null;
  let candidate = url.trim();
  if (!candidate) return null;
  if (candidate.startsWith('//')) candidate = `https:${candidate}`;
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  parsed.protocol = 'https:';
  const host = parsed.hostname.toLowerCase();
  if (host === 'creativecommons.org' || host === 'www.creativecommons.org') {
    parsed.hostname = 'creativecommons.org';
    let pathname = parsed.pathname.replace(/\/(?:deed|legalcode)(?:\.[A-Za-z-]+)?\/?$/i, '/');
    if (!pathname.endsWith('/')) pathname += '/';
    parsed.pathname = pathname;
    parsed.search = '';
    parsed.hash = '';
  }
  return parsed.href;
}

/**
 * Whether an author URL may be linked: a Commons user page, a Wikipedia user
 * page or article, a Wikidata item, or a Flickr profile — https, no query, no
 * redlink, no special page. Every other external URL stays unlinked, so the
 * page never links somewhere a Commons uploader chose.
 *
 * @param {unknown} url
 * @returns {boolean}
 */
export function isAllowedAuthorUrl(url) {
  if (typeof url !== 'string') return false;
  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return false;
  if (parsed.search || parsed.hash) return false;
  /** @type {string} */
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return false;
  }
  // Special pages (e.g. Special:EmailUser), canonical and in the site's locales.
  if (/(?:^|\/)(?:Special|Speciale|Spezial|Spécial):/i.test(pathname)) return false;
  const host = parsed.hostname.toLowerCase();
  if (host === 'commons.wikimedia.org') return /^\/wiki\/User:[^/]+$/.test(pathname);
  if (/^(?:[a-z0-9-]+\.)?(?:m\.)?wikipedia\.org$/.test(host)) return /^\/wiki\/[^/].*$/.test(pathname);
  if (host === 'www.wikidata.org' || host === 'wikidata.org' || host === 'm.wikidata.org') {
    return /^\/wiki\/Q[1-9][0-9]*$/.test(pathname);
  }
  if (host === 'www.flickr.com' || host === 'flickr.com') return /^\/(?:people|photos)\/[^/]+\/?$/.test(pathname);
  return false;
}

// ── Validation ─────────────────────────────────────────────────────────────

const TOP_LEVEL_KEYS = new Set([
  'schema', 'cover', 'source', 'commons', 'author', 'attribution', 'licence',
  'restrictions', 'modified', 'fetchedAt', 'status', 'curation',
]);
const COMMONS_KEYS = new Set(['title', 'pageUrl', 'pageId', 'width', 'height', 'revision', 'aliases']);
const AUTHOR_KEYS = new Set(['text', 'name', 'url', 'type']);
const LICENCE_KEYS = new Set(['name', 'url', 'family', 'attributionRequired']);
const CURATION_KEYS = new Set(['by', 'at', 'note']);

/** C0/C1 controls and bidi overrides/isolates: the generator strips them; a record must not carry them. */
const CONTROL_OR_BIDI_RX = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const EMAIL_RX = /[^\s@<>()[\]]+@[^\s@<>()[\]]+\.[A-Za-z]{2,}/;
const OBFUSCATED_EMAIL_RX = /[([]\s*(?:at|@)\s*[)\]]/i;
/** Fields holding text written by people, where an e-mail address must never be published. */
const PERSON_TEXT_FIELDS = new Set(['author.text', 'author.name', 'attribution', 'curation.by', 'curation.note']);
const COVER_FIELD_RX = /^\/images\/blog\/[A-Za-z0-9][A-Za-z0-9._-]*\.(?:webp|png|jpe?g|avif)$/;

/**
 * @param {Record<string, unknown>} object
 * @param {Set<string>} allowed
 * @param {string} where
 * @param {string[]} errors
 */
function rejectUnknownKeys(object, allowed, where, errors) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) errors.push(`${where}: unknown field "${key}"`);
  }
}

/**
 * Every string leaf of a value, with its path.
 * @param {unknown} value
 * @param {string} path
 * @param {Array<[string, string]>} out
 */
function collectStrings(value, path, out) {
  if (typeof value === 'string') {
    out.push([path, value]);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectStrings(item, `${path}[${index}]`, out));
  } else if (isPlainObject(value)) {
    for (const [key, item] of Object.entries(value)) collectStrings(item, path ? `${path}.${key}` : key, out);
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {string} where
 * @param {number} max
 * @param {string[]} errors
 */
function checkDisplayString(value, where, max, errors) {
  if (!isNonEmptyString(value)) {
    errors.push(`${where} must be a non-empty string`);
    return;
  }
  if (value !== value.trim()) errors.push(`${where} has leading or trailing whitespace`);
  if (value.length > max) errors.push(`${where} is longer than ${max} characters`);
}

/**
 * Validates a schema-1 credit record. Never throws.
 *
 * The rules are the ones the visible line and the ImageObject depend on: a
 * known licence family, https links only (the author link only on the
 * allowlisted hosts), the licence linked by its own URL where the licence
 * demands it, a name wherever attribution is required, and no value that the
 * page must not publish (an e-mail address, a control or bidi-override
 * character, or `/images/`, which the engine would mistake for the hero path).
 *
 * @param {unknown} record
 * @returns {ImageCreditValidation}
 */
export function validateImageCreditRecord(record) {
  /** @type {string[]} */
  const errors = [];
  if (!isPlainObject(record)) return { valid: false, errors: ['record must be an object'] };
  rejectUnknownKeys(record, TOP_LEVEL_KEYS, 'record', errors);

  if (record.schema !== IMAGE_CREDIT_SCHEMA_VERSION) errors.push(`schema must be ${IMAGE_CREDIT_SCHEMA_VERSION}`);
  if (typeof record.cover !== 'string' || !COVER_FIELD_RX.test(record.cover) || coverKey(record.cover) === null) {
    errors.push('cover must be a site path /images/blog/<file>');
  }
  if (record.source !== IMAGE_CREDIT_SOURCE) errors.push(`source must be "${IMAGE_CREDIT_SOURCE}"`);

  const commons = record.commons;
  if (!isPlainObject(commons)) {
    errors.push('commons must be an object');
  } else {
    rejectUnknownKeys(commons, COMMONS_KEYS, 'commons', errors);
    checkDisplayString(commons.title, 'commons.title', MAX_LENGTH.title, errors);
    if (typeof commons.title === 'string' && /^file:/i.test(commons.title)) {
      errors.push('commons.title must not carry the "File:" prefix');
    }
    if (typeof commons.pageUrl !== 'string' || !commons.pageUrl.startsWith(COMMONS_FILE_PAGE_PREFIX)) {
      errors.push(`commons.pageUrl must start with ${COMMONS_FILE_PAGE_PREFIX}`);
    } else if (typeof commons.title === 'string') {
      // The file page must be the page of THIS file: a record whose link and
      // title disagree would credit one photo and link the licence of another.
      let pageTitle = null;
      try {
        const parsed = new URL(commons.pageUrl);
        if (!parsed.search && !parsed.hash) {
          pageTitle = decodeURIComponent(parsed.pathname.slice('/wiki/File:'.length)).replace(/_/g, ' ');
        }
      } catch {
        pageTitle = null;
      }
      if (pageTitle !== commons.title) errors.push('commons.pageUrl is not the file page of commons.title');
    }
    for (const field of ['pageId', 'width', 'height']) {
      if (commons[field] !== undefined && !isPositiveInteger(commons[field])) {
        errors.push(`commons.${field} must be a positive integer`);
      }
    }
    if (commons.revision !== undefined && !isNonEmptyString(commons.revision)) {
      errors.push('commons.revision must be a non-empty string');
    }
    if (commons.aliases !== undefined
      && (!Array.isArray(commons.aliases) || !commons.aliases.every(isNonEmptyString))) {
      errors.push('commons.aliases must be an array of non-empty strings');
    }
  }

  const author = record.author;
  const licence = record.licence;
  if (!isPlainObject(author)) {
    errors.push('author must be an object');
  } else {
    rejectUnknownKeys(author, AUTHOR_KEYS, 'author', errors);
    if (author.text !== null && !isNonEmptyString(author.text)) errors.push('author.text must be a string or null');
    if (author.name !== null) checkDisplayString(author.name, 'author.name', MAX_LENGTH.authorName, errors);
    if (author.url !== null && !isAllowedAuthorUrl(author.url)) {
      errors.push('author.url must be null or an https Commons/Wikipedia/Wikidata/Flickr profile URL');
    }
    if (author.name === null && author.url !== null) errors.push('author.url without author.name');
    if (author.type !== 'Person' && author.type !== 'Organization') {
      errors.push('author.type must be "Person" or "Organization"');
    }
  }

  if (record.attribution !== null) {
    checkDisplayString(record.attribution, 'attribution', MAX_LENGTH.attribution, errors);
  }

  if (!isPlainObject(licence)) {
    errors.push('licence must be an object');
  } else {
    rejectUnknownKeys(licence, LICENCE_KEYS, 'licence', errors);
    checkDisplayString(licence.name, 'licence.name', MAX_LENGTH.licenceName, errors);
    const family = licence.family;
    const knownFamily = typeof family === 'string' && IMAGE_CREDIT_LICENCE_FAMILIES.includes(family);
    if (!knownFamily) errors.push(`licence.family must be one of ${IMAGE_CREDIT_LICENCE_FAMILIES.join(', ')}`);
    if (typeof licence.attributionRequired !== 'boolean') errors.push('licence.attributionRequired must be a boolean');
    if (licence.url !== null) {
      const normalised = normaliseLicenceUrl(licence.url);
      if (normalised === null || httpsUrlOrNull(licence.url) === null) {
        errors.push('licence.url must be null or an https URL');
      } else if (normalised !== licence.url) {
        errors.push(`licence.url must be normalised (${normalised})`);
      }
    }
    if (knownFamily && LICENCE_URL_REQUIRED.has(String(family)) && licence.url === null) {
      errors.push(`licence.url is required for ${family}`);
    }
    if ((family === 'cc-by' || family === 'cc-by-sa')
      && typeof licence.url === 'string' && !licence.url.startsWith('https://creativecommons.org/licenses/')) {
      errors.push(`licence.url of ${family} must be a creativecommons.org licence`);
    }
    // A name is required wherever the licence requires attribution. An
    // unknown author is a courtesy-only case (see the module header).
    const requiresAttribution = !COURTESY_FAMILIES.has(String(family)) || licence.attributionRequired === true;
    if (requiresAttribution && isPlainObject(author) && author.name === null) {
      errors.push('author.name is required when the licence requires attribution');
    }
  }

  if (!Array.isArray(record.restrictions) || !record.restrictions.every(isNonEmptyString)) {
    errors.push('restrictions must be an array of non-empty strings');
  }
  if (record.modified !== 'cropped' && record.modified !== 'resized') {
    errors.push('modified must be "cropped" or "resized"');
  }
  if (typeof record.fetchedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.fetchedAt)) {
    errors.push('fetchedAt must be a YYYY-MM-DD date');
  }
  if (record.status !== 'ok' && record.status !== 'review') errors.push('status must be "ok" or "review"');
  if (record.curation !== null) {
    if (!isPlainObject(record.curation)) {
      errors.push('curation must be null or an object');
    } else {
      rejectUnknownKeys(record.curation, CURATION_KEYS, 'curation', errors);
      for (const field of ['by', 'at', 'note']) {
        if (!isNonEmptyString(record.curation[field])) errors.push(`curation.${field} must be a non-empty string`);
      }
    }
  }

  for (const [path, value] of collectStrings(record, '', [])) {
    if (CONTROL_OR_BIDI_RX.test(value)) errors.push(`${path} contains a control or bidi-override character`);
    if (path !== 'cover' && value.includes('/images/')) errors.push(`${path} contains "/images/"`);
    // People's text only: a file title such as «Logo@2x.png» is not an address.
    if (PERSON_TEXT_FIELDS.has(path) && (EMAIL_RX.test(value) || OBFUSCATED_EMAIL_RX.test(value))) {
      errors.push(`${path} contains an e-mail address`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Reader ─────────────────────────────────────────────────────────────────

/** @param {unknown} error */
function isMissingFileError(error) {
  const code = isPlainObject(error) ? error.code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @template T @param {T} value @returns {T} */
function deepFreeze(value) {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/**
 * Reads credit records by cover, from the first candidate directory that has
 * the file (`<dir>/blog/<cover-key>.json`). Candidates, not one path, for the
 * same two-repo reason as `loadArticleReviewOverrides`: the corpus keeps the
 * records under `content/image-credits`, the site pulls them under
 * `packages/articles/content/image-credits`.
 *
 * Lazy and cached per key. `get` returns `null` — never throws — for a cover
 * that is not `/images/blog/…`, for a missing record, and for a record that is
 * unreadable, invalid, keyed to another cover or not publishable
 * (`status: "review"`); those last cases also warn, once per key, because a
 * record that exists and is dropped means the page silently keeps the site
 * defaults.
 *
 * Uses only `existsSync` and `readFileSync`, so a minimal in-memory `fs` works.
 *
 * @param {ImageCreditFs} fs
 * @param {string | readonly string[]} candidateDirs
 * @param {{ warn?: (message: string) => void }} [options]
 * @returns {ImageCreditReader}
 */
export function createImageCreditReader(fs, candidateDirs, options = {}) {
  const dirs = (typeof candidateDirs === 'string' ? [candidateDirs] : [...candidateDirs])
    .filter(isNonEmptyString)
    .map((dir) => dir.replace(/[\\/]+$/, ''));
  const warn = typeof options.warn === 'function'
    ? options.warn
    : (/** @type {string} */ message) => console.warn(message);
  /** @type {Map<string, ImageCreditRecord | null>} */
  const cache = new Map();

  /** @param {string} key @returns {ImageCreditRecord | null} */
  const load = (key) => {
    for (const dir of dirs) {
      const file = `${dir}/blog/${key}.json`;
      /** @type {string} */
      let raw;
      try {
        if (typeof fs.existsSync === 'function' && !fs.existsSync(file)) continue;
        raw = String(fs.readFileSync(file, 'utf-8'));
      } catch (error) {
        if (isMissingFileError(error)) continue;
        warn(`[image-credits] ${file}: unreadable (${errorMessage(error)}) — cover rendered without credit`);
        return null;
      }
      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        warn(`[image-credits] ${file}: not JSON (${errorMessage(error)}) — cover rendered without credit`);
        return null;
      }
      const { valid, errors } = validateImageCreditRecord(parsed);
      if (!valid) {
        warn(`[image-credits] ${file}: invalid record (${errors.join('; ')}) — cover rendered without credit`);
        return null;
      }
      const record = /** @type {ImageCreditRecord} */ (parsed);
      if (coverKey(record.cover) !== key) {
        warn(`[image-credits] ${file}: cover ${record.cover} does not match the file name — cover rendered without credit`);
        return null;
      }
      if (record.status !== 'ok') {
        warn(`[image-credits] ${file}: status "${record.status}" is not publishable — cover rendered without credit`);
        return null;
      }
      return deepFreeze(record);
    }
    return null;
  };

  return {
    get(cover) {
      try {
        const key = coverKey(cover);
        if (!key) return null;
        if (!cache.has(key)) cache.set(key, load(key));
        return cache.get(key) ?? null;
      } catch (error) {
        warn(`[image-credits] ${String(cover)}: ${errorMessage(error)} — cover rendered without credit`);
        return null;
      }
    },
  };
}

// ── Projections ────────────────────────────────────────────────────────────

/**
 * The URL the licence links to: the licence's own URL, the canonical URL of
 * its family, or — when Commons gives none (public domain, Swisstopo,
 * Copernicus) — the Commons file page, which states the terms.
 * @param {ImageCreditRecord} record
 */
function licenceHref(record) {
  const family = record.licence.family;
  return record.licence.url
    ?? (family === 'cc0' || family === 'no-known-restrictions' ? FAMILY_DEFAULT_LICENCE_URL[family] : null)
    ?? record.commons.pageUrl;
}

/** @param {ImageCreditRecord} record @param {ImageCreditLocale} locale */
function licenceLabel(record, locale) {
  const family = record.licence.family;
  if (family === 'pd' || family === 'no-known-restrictions') return IMAGE_CREDIT_COPY[locale].licenceNames[family];
  return record.licence.name;
}

/** Whom the credit names: the requested attribution, else the author. @param {ImageCreditRecord} record */
function creditedName(record) {
  return record.attribution ?? record.author.name;
}

/**
 * The ImageObject fields of a credited cover, to spread into `imageObjectLd`
 * after `url`, in place of the site defaults it would otherwise fill in.
 * The five fields Google's image-licence metadata documents, plus `isBasedOn`
 * (the Commons file page: the cover is a cropped/resized derivative).
 *
 *   creator           Person/Organization from the record, never the site,
 *                     Commons or the uploader
 *   creditText        «{attribution ?? author} / Wikimedia Commons»
 *   copyrightNotice   the attribution when it is a «©» line, else «© {author}»;
 *                     CC0 / Public domain / No known copyright restrictions
 *   license           licence URL (file page when Commons gives none)
 *   acquireLicensePage the Commons file page
 *
 * @param {ImageCreditRecord} record
 * @returns {ImageCreditImageObjectFields}
 */
export function imageObjectCreditFields(record) {
  const pageUrl = record.commons.pageUrl;
  const authorName = record.author.name;
  const credited = creditedName(record) ?? UNKNOWN_AUTHOR_NAME;
  const family = record.licence.family;
  const fixedNotice = family === 'cc0' || family === 'pd' || family === 'no-known-restrictions'
    ? FAMILY_COPYRIGHT_NOTICE[family]
    : null;
  const attribution = record.attribution;
  const copyrightNotice = fixedNotice
    ?? (attribution && attribution.startsWith('©') ? attribution : `© ${authorName ?? credited}`);
  return {
    creator: {
      '@type': record.author.type,
      name: authorName ?? UNKNOWN_AUTHOR_NAME,
      ...(authorName && record.author.url ? { url: record.author.url } : {}),
    },
    // An attribution the licensor already wrote as «… / Wikimedia Commons»
    // is not suffixed a second time.
    creditText: /wikimedia commons/i.test(credited) ? credited : `${credited} / Wikimedia Commons`,
    copyrightNotice,
    license: licenceHref(record),
    acquireLicensePage: pageUrl,
    isBasedOn: pageUrl,
  };
}

/**
 * Commons file title as a work title: without the file extension.
 * @param {string} title
 */
function workTitle(title) {
  return title.replace(/\.[A-Za-z0-9]{2,5}$/, '') || title;
}

/**
 * @param {ImageCreditSegment['kind']} kind
 * @param {string} text
 * @param {{ href?: string | null, isolate?: boolean, open?: string, close?: string }} [extra]
 * @returns {ImageCreditSegment}
 */
function segment(kind, text, extra = {}) {
  return {
    kind,
    text,
    href: extra.href ?? null,
    isolate: extra.isolate ?? false,
    open: extra.open ?? '',
    close: extra.close ?? '',
  };
}

/**
 * The visible credit as ordered segments, for any renderer (static HTML, RSS,
 * React). `title` and `author` segments are names in any script and are meant
 * to be isolated (`<bdi>`); every `href` is an https URL.
 *
 *   it  Immagine di copertina: «{title}» di {author}, {licence}, tramite Wikimedia Commons ({ritagliata e ridimensionata | ridimensionata}).
 *   en  Cover image: “{title}” by {author}, {licence}, via Wikimedia Commons ({cropped and resized | resized}).
 *   de  Titelbild: „{title}“ von {author}, {licence}, via Wikimedia Commons ({zugeschnitten und skaliert | skaliert}).
 *   fr  Image de couverture : « {title} » par {author}, {licence}, via Wikimedia Commons ({recadrée et redimensionnée | redimensionnée}).
 *
 * With an attribution « di {author}» becomes «, {attribution}»; with an
 * unknown author it becomes «, autore sconosciuto». `null` when the record
 * lacks what the line needs (title, https file page, licence name).
 *
 * @param {ImageCreditRecord} record
 * @param {string} locale
 * @returns {ImageCreditParts | null}
 */
export function imageCreditParts(record, locale) {
  const loc = resolveLocale(locale);
  const copy = IMAGE_CREDIT_COPY[loc];
  const pageUrl = httpsUrlOrNull(record?.commons?.pageUrl);
  const title = record?.commons?.title;
  if (!pageUrl || !isNonEmptyString(title) || !isNonEmptyString(record?.licence?.name)) return null;

  const credited = creditedName(record);
  const authorHref = record.author.name ? httpsUrlOrNull(record.author.url) : null;
  const modifiedNote = copy.modified[record.modified === 'cropped' ? 'cropped' : 'resized'];

  /** @type {ImageCreditSegment[]} */
  const raw = [
    segment('text', `${copy.label}${copy.labelSeparator}`),
    segment('title', workTitle(title), { href: pageUrl, isolate: true, open: copy.quoteOpen, close: copy.quoteClose }),
  ];
  if (record.attribution) {
    raw.push(segment('text', ', '), segment('author', record.attribution, { href: authorHref, isolate: true }));
  } else if (credited) {
    raw.push(segment('text', copy.by), segment('author', credited, { href: authorHref, isolate: true }));
  } else {
    raw.push(segment('text', `, ${copy.unknownAuthor}`));
  }
  raw.push(
    segment('text', ', '),
    segment('licence', licenceLabel(record, loc), { href: httpsUrlOrNull(licenceHref(record)) ?? pageUrl }),
    segment('text', `, ${copy.via} (${modifiedNote}).`),
  );

  // Adjacent plain-text segments merged, so a renderer never has to.
  /** @type {ImageCreditSegment[]} */
  const segments = [];
  for (const part of raw) {
    const previous = segments[segments.length - 1];
    if (part.kind === 'text' && previous && previous.kind === 'text') {
      segments[segments.length - 1] = { ...previous, text: previous.text + part.text };
    } else {
      segments.push(part);
    }
  }
  const text = segments.map((part) => `${part.open}${part.text}${part.close}`).join('');
  return { locale: loc, segments, text };
}

const LINK_ATTRIBUTES = 'target="_blank" rel="noopener" class="underline underline-offset-2"';

/**
 * The visible credit for static HTML (article page, RSS `content:encoded`): a
 * `<footer>` placed at the end of the article. A `<footer>`, not a `<p>` or a
 * `<section>`: the speakable selector reads `article p`, the SPA recovers only
 * unclassed `<section>`s as body, the dist text audit strips `<footer>`, and
 * the contextual-link injector never writes inside it.
 *
 * Links open the Commons file page, the author profile and the licence with
 * `rel="noopener"` only — never `rel="license"` (it would put the PAGE under
 * the photo's licence) or `rel="author"` (the byline owns it). Names sit in
 * `<bdi>`, every value is escaped. Semantic colour tokens only.
 * Returns `''` when the record cannot produce a line.
 *
 * @param {ImageCreditRecord} record
 * @param {string} locale
 * @returns {string}
 */
export function renderImageCreditHtml(record, locale) {
  const parts = imageCreditParts(record, locale);
  if (!parts) return '';
  const inner = parts.segments.map((part) => {
    if (part.kind === 'text') return escapeMarkup(part.text);
    const label = part.isolate ? `<bdi>${escapeMarkup(part.text)}</bdi>` : escapeMarkup(part.text);
    const body = `${escapeMarkup(part.open)}${label}${escapeMarkup(part.close)}`;
    return part.href ? `<a href="${escapeMarkup(part.href)}" ${LINK_ATTRIBUTES}>${body}</a>` : body;
  }).join('');
  return `<footer class="ft-image-credit mt-8 text-sm text-subtle" data-image-credit="${escapeMarkup(record.source)}"><small>${inner}</small></footer>`;
}

/**
 * Media RSS children of an item's `<media:content>`: who to credit and under
 * which licence, because a feed reader shows the image away from the page that
 * carries the visible credit. `<media:credit>` is omitted for an unknown
 * author. Both elements are valid inside `<media:content>`
 * (https://www.rssboard.org/media-rss).
 *
 * @param {ImageCreditRecord} record
 * @param {string} locale
 * @returns {string}
 */
export function mediaRssCreditXml(record, locale) {
  const loc = resolveLocale(locale);
  const credited = creditedName(record);
  const credit = credited
    ? `<media:credit role="author" scheme="urn:ebu">${escapeMarkup(credited)}</media:credit>`
    : '';
  return `${credit}<media:license type="text/html" href="${escapeMarkup(licenceHref(record))}">${escapeMarkup(licenceLabel(record, loc))}</media:license>`;
}
