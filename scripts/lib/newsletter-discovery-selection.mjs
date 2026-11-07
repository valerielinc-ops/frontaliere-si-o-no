/**
 * Validated discovery-article feed and stable newsletter selection.
 *
 * The feed crosses the site/corpus boundary over HTTP. Keep its public shape
 * narrow here as well as at the publisher: no trend query, source URL, or
 * internal attribution is accepted by the consumer. The selected localized
 * copy is frozen in Firestore once per weekly campaign and locale, so a later
 * API refresh cannot change the article midway through a resumed send.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARTICLES_API_BASE } from './articles-api-base.mjs';
import { parseAttributes } from './meta-description-extract.mjs';

export const DISCOVERY_ARTICLES_ARTIFACT = 'data/discovery-articles.json';
export const DISCOVERY_ARTICLES_DESTINATION = 'data/discovery-articles.json';
export const DISCOVERY_ARTICLES_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
export const DISCOVERY_ARTICLES_FUTURE_SKEW_MS = 5 * 60 * 1000;

const LOCALES = new Set(['it', 'en', 'de', 'fr']);
const NEWSLETTER_PROVIDERS = new Set(['google_trends', 'google_news']);
// `other` remains parseable so a manifest-pinned legacy index can be read, but
// it is deliberately never newsletter-eligible: old publisher versions also
// collapsed Reddit attribution into this value.
const KNOWN_INDEX_PROVIDERS = new Set([...NEWSLETTER_PROVIDERS, 'reddit', 'other']);
const SITE_ORIGIN = 'https://frontaliereticino.ch';
const MAX_RECENT_ARTICLE_AGE_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_ROTATION_POOL = 12;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DEFAULT_FEED_PATH = path.join(ROOT, 'public', DISCOVERY_ARTICLES_DESTINATION);
// The pull workflow stores this compact manifest snapshot beside the optional
// local index. Neither file is trusted alone when the live API is unavailable.
const DEFAULT_LAST_KNOWN_GOOD_MANIFEST_PATH = path.join(
  ROOT,
  'public',
  'data',
  'discovery-articles-manifest.json',
);
const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_HTTP_RETRIES = 2;
const MAX_HTTP_RETRIES = 5;
const DEFAULT_ROUTE_RETRIES = 1;
const ROUTE_CHECK_USER_AGENT = 'FrontaliereTicinoMetaWait/1.0 (+https://frontaliereticino.ch)';
const MIN_ARTICLE_BODY_TEXT_LENGTH = 80;

/**
 * @typedef {{ok:boolean,status:number,url?:string,headers?:{get?:(name:string)=>string|null},text:()=>Promise<string>}} DiscoveryFetchResponse
 * @typedef {(input:string|URL,init?:{signal?:AbortSignal,headers?:Record<string,string>,redirect?:string})=>Promise<DiscoveryFetchResponse>} DiscoveryFetch
 */

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, expected) => {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
};
const isSafeText = (value) => typeof value === 'string'
  && value.trim().length > 0
  && !/[\u0000-\u001f\u007f]/u.test(value);

function sameLocaleMap(left, right) {
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftLocales = Object.keys(left).sort();
  const rightLocales = Object.keys(right).sort();
  return leftLocales.length === rightLocales.length
    && leftLocales.every((locale, index) => locale === rightLocales[index]
      && left[locale] === right[locale]);
}

function isCanonicalArticleUrl(value) {
  if (typeof value !== 'string' || value.trim() !== value || !value) return false;
  let parsed;
  try {
    parsed = new URL(value, SITE_ORIGIN);
  } catch {
    return false;
  }
  return parsed.origin === SITE_ORIGIN
    && !parsed.username
    && !parsed.password
    && !parsed.search
    && !parsed.hash
    && parsed.pathname.endsWith('/')
    && !parsed.pathname.startsWith('//');
}

function validateLocaleMaps(article, label) {
  const maps = ['title', 'excerpt', 'url'];
  for (const key of maps) {
    if (!isRecord(article[key])) throw new Error(`${label}.${key} must be an object`);
    for (const [locale, value] of Object.entries(article[key])) {
      if (!LOCALES.has(locale)) throw new Error(`${label}.${key} has unsupported locale ${locale}`);
      const valid = key === 'url' ? isCanonicalArticleUrl(value) : isSafeText(value);
      if (!valid) throw new Error(`${label}.${key}.${locale} is invalid`);
    }
  }
  const locales = Object.keys(article.title);
  if (locales.length === 0) throw new Error(`${label} has no localized title`);
  for (const locale of locales) {
    if (!Object.hasOwn(article.excerpt, locale) || !Object.hasOwn(article.url, locale)) {
      throw new Error(`${label} has incomplete ${locale} localization`);
    }
  }
  for (const locale of [...Object.keys(article.excerpt), ...Object.keys(article.url)]) {
    if (!Object.hasOwn(article.title, locale)) {
      throw new Error(`${label} has a ${locale} excerpt or URL without a title`);
    }
  }
}

/**
 * Parse and validate the public discovery index against its HTTP manifest.
 * `expectedBytes` and `expectedCount` are the manifest's file and count gates.
 *
 * @param {string} raw
 * @param {{expectedBytes:number, expectedCount:number, expectedCommit:string, now?:Date|number}} options
 * @returns {{schema:1,commit:string,generatedAt:string,count:number,articles:Array<object>}}
 */
export function parseDiscoveryArticleIndex(raw, {
  expectedBytes,
  expectedCount,
  expectedCommit,
  now = Date.now(),
} = {}) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') !== expectedBytes) {
    throw new Error(`${DISCOVERY_ARTICLES_ARTIFACT} byte count differs from manifest`);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${DISCOVERY_ARTICLES_ARTIFACT} is not valid JSON: ${error.message}`);
  }
  if (!hasExactKeys(payload, ['schema', 'commit', 'generatedAt', 'count', 'articles'])
    || payload.schema !== 1
    || typeof payload.commit !== 'string'
    || !payload.commit
    || typeof payload.generatedAt !== 'string'
    || !Number.isSafeInteger(payload.count)
    || payload.count < 0
    || !Array.isArray(payload.articles)) {
    throw new Error(`${DISCOVERY_ARTICLES_ARTIFACT} has an invalid JSON contract`);
  }
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0 || payload.count !== expectedCount) {
    throw new Error(`${DISCOVERY_ARTICLES_ARTIFACT} count differs from manifest`);
  }
  if (payload.articles.length !== payload.count) {
    throw new Error(`${DISCOVERY_ARTICLES_ARTIFACT} count does not match articles`);
  }
  if (payload.commit !== expectedCommit) {
    throw new Error(`${DISCOVERY_ARTICLES_ARTIFACT} does not match manifest commit ${expectedCommit}`);
  }

  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const generatedAtMs = Date.parse(payload.generatedAt);
  if (!Number.isFinite(generatedAtMs)
    || !Number.isFinite(nowMs)
    || generatedAtMs > nowMs + DISCOVERY_ARTICLES_FUTURE_SKEW_MS
    || nowMs - generatedAtMs > DISCOVERY_ARTICLES_MAX_AGE_MS) {
    throw new Error(`${DISCOVERY_ARTICLES_ARTIFACT} generatedAt is stale or in the future`);
  }

  const seenIds = new Set();
  payload.articles.forEach((article, index) => {
    const label = `${DISCOVERY_ARTICLES_ARTIFACT}.articles[${index}]`;
    if (!hasExactKeys(article, ['id', 'publishedAt', 'provider', 'title', 'excerpt', 'url'])
      || typeof article.id !== 'string'
      || !/^[a-z0-9][a-z0-9_-]{0,199}$/iu.test(article.id)
      || seenIds.has(article.id)
      || typeof article.publishedAt !== 'string'
      || !Number.isFinite(Date.parse(article.publishedAt))
      || !KNOWN_INDEX_PROVIDERS.has(article.provider)) {
      throw new Error(`${label} has an invalid article contract`);
    }
    seenIds.add(article.id);
    validateLocaleMaps(article, label);
  });

  return payload;
}

export function parseDiscoveryManifest(raw) {
  if (typeof raw !== 'string') throw new Error('manifest.json is not text');
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new Error('manifest.json is not valid JSON');
  }
  if (!isRecord(manifest)
    || manifest.schema !== 1
    || typeof manifest.commit !== 'string'
    || !manifest.commit
    || !isRecord(manifest.files)
    || !isRecord(manifest.counts)) {
    throw new Error('manifest.json has an invalid API contract');
  }

  const expectedBytes = manifest.files[DISCOVERY_ARTICLES_ARTIFACT];
  const expectedCount = manifest.counts.discoveryArticles;
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes <= 0
    || !Number.isSafeInteger(expectedCount) || expectedCount < 0) {
    throw new Error('manifest.json does not declare a valid discovery index');
  }
  return { manifest, expectedBytes, expectedCount, expectedCommit: manifest.commit };
}

/**
 * Pull one coherent API release for the site snapshot writer. Unlike the
 * newsletter's optional reader this never falls back to a local copy: a
 * writer must pin manifest → index → manifest and skip if the release moves.
 *
 * @param {{apiBase?:string,fetchImpl?:DiscoveryFetch,now?:Date|number,timeoutMs?:number,
 *   retries?:number,retryDelayMs?:number,sleepImpl?:(ms:number)=>Promise<void>}} options
 * @returns {Promise<{index:object,rawIndex:string,compactManifest:object}>}
 */
export async function loadDiscoveryArticleSnapshotFromHttp({
  apiBase = ARTICLES_API_BASE,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  retries = DEFAULT_HTTP_RETRIES,
  retryDelayMs = 250,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (typeof apiBase !== 'string' || !apiBase.trim()) throw new TypeError('apiBase is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError('timeoutMs must be an integer between 1 and 60000');
  }
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > MAX_HTTP_RETRIES) {
    throw new RangeError(`retries must be an integer between 0 and ${MAX_HTTP_RETRIES}`);
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10_000) {
    throw new RangeError('retryDelayMs must be an integer between 0 and 10000');
  }
  if (typeof sleepImpl !== 'function') throw new TypeError('sleepImpl must be a function');

  const base = apiBase.replace(/\/+$/u, '');
  const manifestUrl = new URL(`${base}/manifest.json`);
  const discoveryUrl = new URL(`${base}/${DISCOVERY_ARTICLES_ARTIFACT}`);
  if (!['http:', 'https:'].includes(manifestUrl.protocol)
    || !['http:', 'https:'].includes(discoveryUrl.protocol)) {
    throw new TypeError('apiBase must use HTTP or HTTPS');
  }

  let lastFailure = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const manifestRaw = await fetchText(fetchImpl, manifestUrl, timeoutMs);
      const first = parseDiscoveryManifest(manifestRaw);
      const rawIndex = await fetchText(fetchImpl, discoveryUrl, timeoutMs);
      const index = parseDiscoveryArticleIndex(rawIndex, {
        expectedBytes: first.expectedBytes,
        expectedCount: first.expectedCount,
        expectedCommit: first.expectedCommit,
        now,
      });
      const manifestAfterRaw = await fetchText(fetchImpl, manifestUrl, timeoutMs);
      const after = parseDiscoveryManifest(manifestAfterRaw);
      if (after.expectedCommit !== first.expectedCommit
        || after.expectedBytes !== first.expectedBytes
        || after.expectedCount !== first.expectedCount) {
        throw new Error('manifest moved while the discovery index was being pulled');
      }
      return {
        index,
        rawIndex,
        compactManifest: {
          schema: 1,
          commit: first.expectedCommit,
          files: { [DISCOVERY_ARTICLES_ARTIFACT]: first.expectedBytes },
          counts: { discoveryArticles: first.expectedCount },
        },
      };
    } catch (error) {
      lastFailure = error instanceof Error ? error : new Error(String(error));
      if (attempt < retries) await sleepImpl(retryDelayMs * (attempt + 1));
    }
  }
  throw new Error(`discovery snapshot API pull failed after ${retries + 1} attempts: ${lastFailure?.message || 'unknown error'}`);
}

function readLocalLastKnownGood({ manifestFilePath, indexFilePath, now }) {
  let manifestRaw;
  let indexRaw;
  try {
    manifestRaw = fs.readFileSync(manifestFilePath, 'utf8');
    indexRaw = fs.readFileSync(indexFilePath, 'utf8');
  } catch {
    return null;
  }

  try {
    const { expectedBytes, expectedCount, expectedCommit } = parseDiscoveryManifest(manifestRaw);
    return parseDiscoveryArticleIndex(indexRaw, {
      expectedBytes,
      expectedCount,
      expectedCommit,
      now,
    });
  } catch {
    return null;
  }
}

/** @param {DiscoveryFetch} fetchImpl @param {URL} url @param {number} timeoutMs */
function fetchText(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('request timed out'));
    }, timeoutMs);
  });
  const request = Promise.resolve().then(async () => {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response?.ok) throw new Error(`HTTP ${Number(response?.status) || 0}`);
    return response.text();
  });
  return Promise.race([
    request,
    timeout,
  ]).finally(() => clearTimeout(timer));
}

/**
 * Fetch the live discovery index against the manifest that announces it.
 * A valid empty index is returned as an index with count zero. Transport,
 * schema, freshness, byte-count, count, or commit failures throw after bounded
 * retries and an optional manifest-pinned local last-known-good check.
 *
 * @param {{apiBase?:string,fetchImpl?:DiscoveryFetch,now?:Date|number,timeoutMs?:number,
 *   retries?:number,retryDelayMs?:number,sleepImpl?:(ms:number)=>Promise<void>,
 *   manifestFilePath?:string,indexFilePath?:string}} options
 */
export async function loadDiscoveryArticleIndexFromHttp({
  apiBase = ARTICLES_API_BASE,
  fetchImpl = globalThis.fetch,
  now = Date.now(),
  timeoutMs = DEFAULT_HTTP_TIMEOUT_MS,
  retries = DEFAULT_HTTP_RETRIES,
  retryDelayMs = 250,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  manifestFilePath = DEFAULT_LAST_KNOWN_GOOD_MANIFEST_PATH,
  indexFilePath = DEFAULT_FEED_PATH,
} = {}) {
  if (typeof apiBase !== 'string' || !apiBase.trim()) throw new TypeError('apiBase is required');
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError('timeoutMs must be an integer between 1 and 60000');
  }
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > MAX_HTTP_RETRIES) {
    throw new RangeError(`retries must be an integer between 0 and ${MAX_HTTP_RETRIES}`);
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10_000) {
    throw new RangeError('retryDelayMs must be an integer between 0 and 10000');
  }
  if (typeof sleepImpl !== 'function') throw new TypeError('sleepImpl must be a function');

  const base = apiBase.replace(/\/+$/u, '');
  const manifestUrl = new URL(`${base}/manifest.json`);
  const discoveryUrl = new URL(`${base}/${DISCOVERY_ARTICLES_ARTIFACT}`);
  if (!['http:', 'https:'].includes(manifestUrl.protocol)
    || !['http:', 'https:'].includes(discoveryUrl.protocol)) {
    throw new TypeError('apiBase must use HTTP or HTTPS');
  }

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const manifestRaw = await fetchText(fetchImpl, manifestUrl, timeoutMs);
      const { expectedBytes, expectedCount, expectedCommit } = parseDiscoveryManifest(manifestRaw);
      const indexRaw = await fetchText(fetchImpl, discoveryUrl, timeoutMs);
      return parseDiscoveryArticleIndex(indexRaw, {
        expectedBytes,
        expectedCount,
        expectedCommit,
        now,
      });
    } catch {
      if (attempt < retries) await sleepImpl(retryDelayMs * (attempt + 1));
    }
  }

  const lastKnownGood = readLocalLastKnownGood({ manifestFilePath, indexFilePath, now });
  if (lastKnownGood) return lastKnownGood;
  throw new Error(`live discovery index unavailable or invalid after ${retries + 1} attempts`);
}

/**
 * Discovery is an optional newsletter card. A failed live preflight must leave
 * the regular digest sendable; callers freeze the returned null for the
 * campaign so a later resume cannot add a card only to its unsent recipients.
 */
export async function loadOptionalDiscoveryArticleIndexFromHttp(options = {}) {
  try {
    return await loadDiscoveryArticleIndexFromHttp(options);
  } catch {
    return null;
  }
}

function normalizePageText(value) {
  return String(value || '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39|rsquo|lsquo|ndash|mdash);/giu, (entity) => {
      const normalized = entity.toLowerCase();
      switch (normalized) {
        case '&amp;': return '&';
        case '&lt;': return '<';
        case '&gt;': return '>';
        case '&quot;': return '"';
        case '&apos;':
        case '&#39;': return "'";
        case '&rsquo;': return '’';
        case '&lsquo;': return '‘';
        case '&nbsp;': return ' ';
        case '&ndash;': return '–';
        case '&mdash;': return '—';
        default: return entity;
      }
    })
    .normalize('NFKC')
    .replace(/\u00a0/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function findArticlePageValue(html, tagName, predicate, attributeName) {
  const tagRx = new RegExp(`<${tagName}\\b((?:[^>"']|"[^"]*"|'[^']*')*)>`, 'giu');
  let match;
  while ((match = tagRx.exec(html))) {
    const attrs = parseAttributes(match[1]);
    if (predicate(attrs)) return attrs[String(attributeName || '').toLowerCase()] || '';
  }
  return '';
}

function pageTitleMatches(html, expectedTitle) {
  const ogTitle = findArticlePageValue(
    html,
    'meta',
    (attrs) => attrs.property === 'og:title',
    'content',
  );
  const title = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/iu)?.[1] || '';
  const expected = normalizePageText(expectedTitle);
  const candidates = [normalizePageText(ogTitle), normalizePageText(title)].filter(Boolean);
  return candidates.some((candidate) => {
    if (candidate === expected) return true;
    if (candidate.includes('|')) {
      return normalizePageText(candidate.split('|').slice(0, -1).join('|')) === expected;
    }
    return false;
  });
}

function articlePageHasBody(html) {
  const articleRx = /<article\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/article\s*>/giu;
  let match;
  while ((match = articleRx.exec(html))) {
    const attrs = parseAttributes(match[1]);
    const classes = String(attrs.class || '').split(/\s+/u);
    if (!classes.includes('ft-blog-article')) continue;
    const text = match[2]
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, ' ')
      .replace(/<!--([\s\S]*?)-->/gu, ' ')
      .replace(/<[^>]*>/gu, ' ');
    return normalizePageText(text).length >= MIN_ARTICLE_BODY_TEXT_LENGTH;
  }
  return false;
}

/**
 * Verify that one localized canonical URL resolves to the expected article,
 * rather than a challenge page, shell, or soft 404. The allowlisted User-Agent
 * is the one used by the site's existing live article metadata probe.
 *
 * @param {{title?:string|Record<string,string>,url?:string|Record<string,string>}} article
 * @param {'it'|'en'|'de'|'fr'} locale
 * @param {{fetchImpl?:DiscoveryFetch,timeoutMs?:number,retries?:number,retryDelayMs?:number,
 *   sleepImpl?:(ms:number)=>Promise<void>,now?:Date|number}} options
 * @returns {Promise<{ready:boolean,reason:string}>}
 */
export async function checkDiscoveryArticleRoute(article, locale, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 8_000,
  retries = DEFAULT_ROUTE_RETRIES,
  retryDelayMs = 250,
  sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = Date.now(),
} = {}) {
  const url = typeof article?.url === 'string' ? article.url : article?.url?.[locale];
  const title = typeof article?.title === 'string' ? article.title : article?.title?.[locale];
  if (!LOCALES.has(locale) || !isCanonicalArticleUrl(url) || !isSafeText(title)) {
    return { ready: false, reason: 'localized title or canonical URL is invalid' };
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new RangeError('timeoutMs must be an integer between 1 and 60000');
  }
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > MAX_HTTP_RETRIES) {
    throw new RangeError(`retries must be an integer between 0 and ${MAX_HTTP_RETRIES}`);
  }
  if (!Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 10_000) {
    throw new RangeError('retryDelayMs must be an integer between 0 and 10000');
  }
  if (typeof sleepImpl !== 'function') throw new TypeError('sleepImpl must be a function');

  const expected = new URL(url, SITE_ORIGIN);
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  let lastReason = 'request failed';
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let retryableFailure = true;
    const requestUrl = new URL(expected.href);
    const cacheBust = Number.isFinite(nowMs) ? nowMs + attempt : Date.now() + attempt;
    requestUrl.searchParams.set('_discovery_check', cacheBust.toString(36));
    const controller = new AbortController();
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('request timed out'));
        }, timeoutMs);
      });
      const responsePromise = Promise.resolve().then(() => fetchImpl(requestUrl, {
        redirect: 'follow',
        headers: {
          'User-Agent': ROUTE_CHECK_USER_AGENT,
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
        signal: controller.signal,
      })).then(async (response) => ({ response, html: await response.text() }));
      const { response, html } = await Promise.race([responsePromise, timeout]);
      if (response.status !== 200) {
        const status = Number(response.status) || 0;
        if (status === 403) {
          let cfRay = '';
          try { cfRay = response.headers?.get?.('cf-ray') || ''; } catch { /* optional diagnostic */ }
          const safeCfRay = /^[A-Za-z0-9-]{1,80}$/u.test(cfRay) ? ` (cf-ray ${cfRay})` : '';
          lastReason = `indeterminate_waf: HTTP 403${safeCfRay}`;
          retryableFailure = false;
        } else {
          lastReason = `HTTP ${status}`;
          retryableFailure = status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
        }
      } else {
        const canonical = findArticlePageValue(
          html,
          'link',
          (attrs) => String(attrs.rel || '').toLowerCase().split(/\s+/u).includes('canonical'),
          'href',
        );
        let canonicalUrl;
        let finalUrl;
        try {
          canonicalUrl = new URL(canonical, SITE_ORIGIN);
          finalUrl = new URL(response.url || requestUrl.href, SITE_ORIGIN);
        } catch {
          canonicalUrl = null;
          finalUrl = null;
        }
        const sameCanonicalPath = canonicalUrl
          && canonicalUrl.origin === expected.origin
          && canonicalUrl.pathname === expected.pathname
          && !canonicalUrl.search
          && !canonicalUrl.hash;
        const sameServedPath = finalUrl
          && finalUrl.origin === expected.origin
          && finalUrl.pathname === expected.pathname;
        if (!sameCanonicalPath || !sameServedPath) {
          lastReason = 'canonical or final URL does not match the requested article';
        } else if (!pageTitleMatches(html, title)) {
          lastReason = 'served page title does not match the localized index';
        } else if (!articlePageHasBody(html)) {
          lastReason = 'served page has no article body';
        } else {
          return { ready: true, reason: 'article route, title, canonical, and body verified' };
        }
      }
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    if (!retryableFailure || attempt >= retries) break;
    await sleepImpl(retryDelayMs * (attempt + 1));
  }
  return { ready: false, reason: lastReason };
}

/**
 * Keep a new newsletter selection on the same corpus release the site pulled.
 * The local discovery index is paired with its manifest snapshot by the pull
 * workflow; matching only IDs would allow a newer HTTP release to introduce a
 * link whose localized copy has not reached the site yet.
 *
 * @param {object|null} index Valid live or manifest-pinned HTTP index.
 * @param {{manifestFilePath?:string,indexFilePath?:string,now?:Date|number}} options
 * @returns {object|null} The localized intersection, or null when releases disagree.
 */
export function alignDiscoveryIndexWithSitePull(index, {
  manifestFilePath = DEFAULT_LAST_KNOWN_GOOD_MANIFEST_PATH,
  indexFilePath = DEFAULT_FEED_PATH,
  now = Date.now(),
} = {}) {
  if (!isRecord(index) || typeof index.commit !== 'string' || !Array.isArray(index.articles)) return null;
  const pulled = readLocalLastKnownGood({ manifestFilePath, indexFilePath, now });
  if (!pulled || pulled.commit !== index.commit) return null;

  const pulledById = new Map(pulled.articles.map((article) => [article.id, article]));
  const articles = index.articles.filter((article) => {
    const siteArticle = pulledById.get(article?.id);
    return siteArticle
      && article.provider === siteArticle.provider
      && article.publishedAt === siteArticle.publishedAt
      && sameLocaleMap(article.title, siteArticle.title)
      && sameLocaleMap(article.excerpt, siteArticle.excerpt)
      && sameLocaleMap(article.url, siteArticle.url);
  });
  return { ...index, count: articles.length, articles };
}

/**
 * Read the committed HTTP snapshot for newsletter use. Missing, malformed, or
 * stale data is optional content and therefore degrades to the existing email.
 */
export function loadDiscoveryArticleIndex({ filePath = DEFAULT_FEED_PATH, now = Date.now() } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`[newsletter] discovery feed unavailable: ${error.message}`);
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(raw);
    return parseDiscoveryArticleIndex(raw, {
      expectedBytes: Buffer.byteLength(raw, 'utf8'),
      expectedCount: payload?.count,
      expectedCommit: payload?.commit,
      now,
    });
  } catch (error) {
    console.warn(`[newsletter] discovery feed ignored: ${error.message}`);
    return null;
  }
}

function fnv1a32(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function canonicalArticleUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value, SITE_ORIGIN);
    if (parsed.origin !== SITE_ORIGIN || parsed.username || parsed.password) return null;
    const pathname = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
    return `${SITE_ORIGIN}${pathname}`;
  } catch {
    return null;
  }
}

/**
 * Drop the optional discovery card when the personalized selector already
 * chose the same article. The returned null is also what the delivery ledger
 * must record for that recipient.
 */
export function omitDuplicateDiscoveryArticle(selection, personalizedArticle) {
  if (!selection || !personalizedArticle) return selection || null;
  const discoveryArticle = selection.article || selection;
  const discoveryId = selection.articleId || discoveryArticle.id || null;
  const personalizedId = personalizedArticle.id || null;
  if (discoveryId && personalizedId && discoveryId === personalizedId) return null;
  const discoveryUrl = canonicalArticleUrl(discoveryArticle.url);
  const personalizedUrl = canonicalArticleUrl(personalizedArticle.url);
  if (discoveryUrl && personalizedUrl && discoveryUrl === personalizedUrl) return null;
  return selection;
}

/**
 * Choose a recently published, localized item deterministically for previews.
 * Send mode persists this result before sending and reuses it on every resume.
 */
export function chooseDiscoveryArticle(index, campaignId, locale, { now = Date.now() } = {}) {
  const candidates = getDiscoveryArticleCandidates(index, locale, { now });
  if (!candidates.length) return null;
  const picked = candidates[fnv1a32(`${campaignId}\u0000${locale}`) % candidates.length];
  return {
    articleId: picked.id,
    provider: picked.provider,
    article: {
      id: picked.id,
      provider: picked.provider,
      title: picked.title[locale],
      excerpt: picked.excerpt[locale],
      url: picked.url[locale],
    },
  };
}

/**
 * Return the exact bounded pool used by the weekly selector. Snapshot
 * readiness checks use this to avoid making a stale, non-eligible row block a
 * current newsletter candidate.
 */
export function getDiscoveryArticleCandidates(index, locale, { now = Date.now() } = {}) {
  if (!index || !Array.isArray(index.articles) || !LOCALES.has(locale)) return [];
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  return index.articles
    .filter((article) => {
      // Reddit and legacy `other` rows can be valid in the public feed, but
      // newsletter eligibility is a separate editorial policy. Filter per row
      // so one disallowed record cannot discard eligible Google discoveries.
      if (!NEWSLETTER_PROVIDERS.has(article?.provider)) return false;
      const publishedAt = Date.parse(article?.publishedAt || '');
      return Number.isFinite(publishedAt)
        && publishedAt <= nowMs + DISCOVERY_ARTICLES_FUTURE_SKEW_MS
        && nowMs - publishedAt <= MAX_RECENT_ARTICLE_AGE_MS
        && isSafeText(article?.title?.[locale])
        && isSafeText(article?.excerpt?.[locale])
        && isCanonicalArticleUrl(article?.url?.[locale]);
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || a.id.localeCompare(b.id))
    .slice(0, MAX_ROTATION_POOL);
}

function validateStoredSelection(value, locale) {
  if (value === null) return null;
  if (isRecord(value)
    && Object.hasOwn(value, 'sourceCommit')
    && (typeof value.sourceCommit !== 'string' || !value.sourceCommit.trim())) {
    throw new Error(`frozen newsletter discovery source commit is invalid for ${locale}`);
  }
  if (isRecord(value) && typeof value.provider === 'string' && !NEWSLETTER_PROVIDERS.has(value.provider)) {
    return null;
  }
  if (!isRecord(value)
    || typeof value.articleId !== 'string'
    || !NEWSLETTER_PROVIDERS.has(value.provider)
    || !isRecord(value.article)
    || value.article.id !== value.articleId
    || value.article.provider !== value.provider
    || !isSafeText(value.article.title)
    || !isSafeText(value.article.excerpt)
    || !isCanonicalArticleUrl(value.article.url)) {
    throw new Error(`frozen newsletter discovery selection is invalid for ${locale}`);
  }
  return value;
}

/**
 * Freeze one selection in `newsletter_subscribers/_meta_/campaign_discovery`
 * using the same weekly campaign key as the recipient resume ledger. A stored
 * null is meaningful: the campaign started without an eligible discovery item.
 */
export async function freezeCampaignDiscoverySelection(db, campaignId, locale, index, {
  now = new Date(),
  allowNewSelection = true,
} = {}) {
  if (!db?.collection || typeof db.runTransaction !== 'function') {
    throw new TypeError('Firestore is required to freeze newsletter discovery content');
  }
  if (typeof campaignId !== 'string' || !campaignId || !LOCALES.has(locale)) {
    throw new TypeError('campaignId and a supported locale are required');
  }
  const reference = db.collection('newsletter_subscribers')
    .doc('_meta_')
    .collection('campaign_discovery')
    .doc(campaignId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(reference);
    const existing = snapshot.exists ? snapshot.data() : {};
    const selections = isRecord(existing?.selections) ? existing.selections : {};
    if (Object.hasOwn(selections, locale)) {
      const stored = validateStoredSelection(selections[locale], locale);
      if (stored !== null || selections[locale] === null) return stored;

      // A provider removed from the public allowlist must not break an older
      // campaign resume. Freeze the disallowed slot as null instead of choosing
      // a different article halfway through that campaign.
      const timestamp = now instanceof Date ? now : new Date(now);
      transaction.set(reference, {
        updated_at: timestamp,
        selections: { [locale]: null },
      }, { merge: true });
      return null;
    }

    const selection = allowNewSelection
      ? chooseDiscoveryArticle(index, campaignId, locale, { now })
      : null;
    const value = selection
      ? {
          articleId: selection.articleId,
          provider: selection.provider,
          sourceCommit: index.commit,
          // Store the small public localized copy too. If the API index later
          // advances or is briefly absent, resumes still render the same item.
          article: selection.article,
        }
      : null;
    const timestamp = now instanceof Date ? now : new Date(now);
    transaction.set(reference, {
      campaign_id: campaignId,
      ...(snapshot.exists ? {} : { created_at: timestamp }),
      updated_at: timestamp,
      selections: { [locale]: value },
    }, { merge: true });
    return value;
  });
}

/** Preview/test selection is deterministic but never writes campaign state. */
export function nonPersistedDiscoverySelection(index, campaignId, locale, options) {
  return chooseDiscoveryArticle(index, campaignId, locale, options);
}
