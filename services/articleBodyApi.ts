import type { ArticleSection } from './articleSections';
import { articlesApiBase } from './articlesApiBase';

export type ArticleBodyApiPayload = {
  schemaVersion: 1;
  section: string;
  locale: ArticleBodyApiLocale;
  id: string;
  revision: string;
  meta: {
    title: string;
    excerpt: string;
    imageAlt: string;
  };
  translations: Record<string, string>;
};

export type ArticleBodyApiLocale = 'it' | 'en' | 'de' | 'fr';

export type ArticleBodyApiDocument =
  | { locale: ArticleBodyApiLocale; id: string; status: 'available'; payload: ArticleBodyApiPayload }
  | { locale: ArticleBodyApiLocale; id: string; status: 'missing' };

export type ArticleBodyApiResult =
  | { status: 'legacy' }
  | { status: 'loaded' | 'missing'; documents: ArticleBodyApiDocument[] }
  | {
    status: 'error';
    reason: 'network' | 'invalid' | 'revision';
    authoritative: boolean;
    locales: ArticleBodyApiLocale[];
  };

type ArticleBodyCapability = {
  schemaVersion: 1;
  revisionAlgorithm: 'sha256-json-v1';
  revisionCanonicalFields: string[];
  revisionTextEncoding: 'UTF-8';
  revisionUnicodeNormalization: 'none';
  indexPattern: 'bodies/{section}/{locale}/index.json';
  payloadPattern: 'bodies/{section}/{locale}/{id}.json';
  sections: Record<string, {
    status: 'public' | 'inactive';
    locales: Record<ArticleBodyApiLocale, { index: string; expected: number; available: number; missing: number }>;
  }>;
};

type ArticleBodyIndexEntry = { status: 'missing' } | {
  status: 'available';
  path: string;
  expectedHash: string;
};

type ArticleBodyIndex = {
  schemaVersion: 1;
  section: string;
  locale: ArticleBodyApiLocale;
  status: 'public' | 'inactive';
  expectedCount: number;
  availableCount: number;
  missingCount: number;
  entries: Record<string, ArticleBodyIndexEntry>;
};

type CachedManifest = { capability: ArticleBodyCapability | null; expiresAt: number };
type ApiFailureKind = 'network' | 'invalid' | 'revision';

const API_LOCALES: readonly ArticleBodyApiLocale[] = ['it', 'en', 'de', 'fr'];
const ARTICLE_ID_RE = /^[a-z0-9][a-z0-9-]*$/u;
const SECTION_RE = /^[a-z0-9][a-z0-9-]*$/u;
const REVISION_RE = /^[a-f0-9]{64}$/u;
const TIMEOUT_MS = 8000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MANIFEST_TTL_MS = 30_000;
const PAYLOAD_CACHE_LIMIT = 64;
const API_ACTIVE_SESSION_KEY = 'frontaliere-article-body-api-active';

let cachedManifest: CachedManifest | null = null;
let manifestInFlight: Promise<ArticleBodyCapability | null> | null = null;
let capabilityWasActive = false;
const indexInFlight = new Map<string, Promise<ArticleBodyIndex>>();
const payloadInFlight = new Map<string, Promise<ArticleBodyApiPayload>>();
const payloadCache = new Map<string, ArticleBodyApiPayload>();

class ArticleBodyApiError extends Error {
  constructor(readonly kind: ApiFailureKind, message: string) {
    super(message);
    this.name = 'ArticleBodyApiError';
  }
}

function hasActiveCapability(): boolean {
  if (capabilityWasActive) return true;
  try {
    return typeof sessionStorage !== 'undefined' && sessionStorage.getItem(API_ACTIVE_SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function rememberActiveCapability(): void {
  capabilityWasActive = true;
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(API_ACTIVE_SESSION_KEY, '1');
  } catch { /* private browsing may disable session storage */ }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLocale(value: unknown): value is ArticleBodyApiLocale {
  return typeof value === 'string' && API_LOCALES.includes(value as ArticleBodyApiLocale);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isExpectedCanonicalFields(value: unknown): value is string[] {
  const expected = [
    'schemaVersion', 'section', 'locale', 'id',
    'meta.title', 'meta.excerpt', 'meta.imageAlt',
    'translations.body1..body20 (present keys, numeric order)',
    'translations.faq (if present, last)',
  ];
  return Array.isArray(value) && value.length === expected.length
    && value.every((field, index) => field === expected[index]);
}

function parseCapability(value: unknown): ArticleBodyCapability {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.revisionAlgorithm !== 'sha256-json-v1'
    || value.revisionTextEncoding !== 'UTF-8'
    || value.revisionUnicodeNormalization !== 'none'
    || value.indexPattern !== 'bodies/{section}/{locale}/index.json'
    || value.payloadPattern !== 'bodies/{section}/{locale}/{id}.json'
    || !isExpectedCanonicalFields(value.revisionCanonicalFields)
    || !isRecord(value.sections)) {
    throw new ArticleBodyApiError('invalid', 'Manifest articolo non compatibile.');
  }

  const sections: ArticleBodyCapability['sections'] = {};
  for (const [section, rawSection] of Object.entries(value.sections)) {
    if (!SECTION_RE.test(section) || !isRecord(rawSection)
      || (rawSection.status !== 'public' && rawSection.status !== 'inactive')
      || !isRecord(rawSection.locales)) {
      throw new ArticleBodyApiError('invalid', 'Indice delle sezioni articolo non valido.');
    }

    const locales = {} as ArticleBodyCapability['sections'][string]['locales'];
    for (const locale of API_LOCALES) {
      const rawLocale = rawSection.locales[locale];
      const expectedIndex = `bodies/${section}/${locale}/index.json`;
      if (!isRecord(rawLocale)
        || rawLocale.index !== expectedIndex
        || !isCount(rawLocale.expected)
        || !isCount(rawLocale.available)
        || !isCount(rawLocale.missing)
        || rawLocale.available + rawLocale.missing !== rawLocale.expected) {
        throw new ArticleBodyApiError('invalid', `Riepilogo articoli non valido (${section}/${locale}).`);
      }
      locales[locale] = {
        index: expectedIndex,
        expected: rawLocale.expected,
        available: rawLocale.available,
        missing: rawLocale.missing,
      };
    }
    sections[section] = { status: rawSection.status, locales };
  }

  return {
    schemaVersion: 1,
    revisionAlgorithm: 'sha256-json-v1',
    revisionCanonicalFields: value.revisionCanonicalFields,
    revisionTextEncoding: 'UTF-8',
    revisionUnicodeNormalization: 'none',
    indexPattern: 'bodies/{section}/{locale}/index.json',
    payloadPattern: 'bodies/{section}/{locale}/{id}.json',
    sections,
  };
}

async function fetchJson(url: string, cache: RequestCache): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, { cache, signal: controller.signal });
    if (!response.ok) throw new ArticleBodyApiError('network', `Richiesta articoli non riuscita (${response.status}).`);
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_JSON_BYTES) {
      throw new ArticleBodyApiError('invalid', 'Risposta articoli troppo grande.');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ArticleBodyApiError('invalid', 'Risposta articoli JSON non valida.');
    }
  } catch (error) {
    if (error instanceof ArticleBodyApiError) throw error;
    throw new ArticleBodyApiError('network', 'Servizio articoli non raggiungibile.');
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchManifest(force: boolean): Promise<ArticleBodyCapability | null> {
  const now = Date.now();
  if (!force && cachedManifest && cachedManifest.expiresAt > now) return cachedManifest.capability;
  if (!force && manifestInFlight) return manifestInFlight;

  const promise = (async () => {
    const raw = await fetchJson(`${articlesApiBase()}/manifest.json`, 'no-store');
    if (!isRecord(raw)) throw new ArticleBodyApiError('invalid', 'Manifest articoli non valido.');
    const capabilities = raw.capabilities;
    if (!isRecord(capabilities) || !Object.prototype.hasOwnProperty.call(capabilities, 'articleBodies')) {
      if (hasActiveCapability()) throw new ArticleBodyApiError('revision', 'La capability articoli è temporaneamente assente.');
      cachedManifest = { capability: null, expiresAt: Date.now() + MANIFEST_TTL_MS };
      return null;
    }
    rememberActiveCapability();
    // Presence of the capability is an explicit publisher opt-in. Treat an
    // incompatible/malformed capability as an authoritative failure too, so
    // callers cannot fall back to compiled article text after seeing it.
    const capability = parseCapability(capabilities.articleBodies);
    cachedManifest = { capability, expiresAt: Date.now() + MANIFEST_TTL_MS };
    return capability;
  })();

  if (!force) manifestInFlight = promise;
  try {
    return await promise;
  } finally {
    if (manifestInFlight === promise) manifestInFlight = null;
  }
}

function articleIndexPath(capability: ArticleBodyCapability, section: string, locale: ArticleBodyApiLocale): string {
  const descriptor = capability.sections[section];
  if (!descriptor) throw new ArticleBodyApiError('invalid', `Sezione articolo sconosciuta: ${section}.`);
  if (descriptor.status === 'inactive') return '';
  const localeDescriptor = descriptor.locales[locale];
  if (!localeDescriptor) throw new ArticleBodyApiError('invalid', `Lingua articolo non dichiarata: ${locale}.`);
  return localeDescriptor.index;
}

function absoluteApiUrl(relativePath: string, query?: Record<string, string>): string {
  const base = `${articlesApiBase()}/`;
  const url = new URL(relativePath.split('/').map(encodeURIComponent).join('/'), base);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  return url.toString();
}

function parseIndex(value: unknown, section: string, locale: ArticleBodyApiLocale): ArticleBodyIndex {
  if (!isRecord(value)
    || value.schemaVersion !== 1
    || value.section !== section
    || value.locale !== locale
    || (value.status !== 'public' && value.status !== 'inactive')
    || !isCount(value.expectedCount)
    || !isCount(value.availableCount)
    || !isCount(value.missingCount)
    || value.availableCount + value.missingCount !== value.expectedCount
    || !isRecord(value.entries)) {
    throw new ArticleBodyApiError('invalid', `Indice articoli non valido (${section}/${locale}).`);
  }

  const entries: Record<string, ArticleBodyIndexEntry> = {};
  let available = 0;
  let missing = 0;
  for (const [id, rawEntry] of Object.entries(value.entries)) {
    if (!ARTICLE_ID_RE.test(id) || !isRecord(rawEntry)) {
      throw new ArticleBodyApiError('invalid', 'Voce dell’indice articoli non valida.');
    }
    if (rawEntry.status === 'missing' && Object.keys(rawEntry).length === 1) {
      entries[id] = { status: 'missing' };
      missing += 1;
    } else if (rawEntry.status === 'available'
      && rawEntry.path === `bodies/${section}/${locale}/${id}.json`
      && typeof rawEntry.expectedHash === 'string'
      && REVISION_RE.test(rawEntry.expectedHash)
      && Object.keys(rawEntry).length === 3) {
      entries[id] = { status: 'available', path: rawEntry.path, expectedHash: rawEntry.expectedHash };
      available += 1;
    } else {
      throw new ArticleBodyApiError('invalid', `Voce dell’indice non valida (${section}/${locale}/${id}).`);
    }
  }
  if (Object.keys(entries).length !== value.expectedCount
    || available !== value.availableCount
    || missing !== value.missingCount) {
    throw new ArticleBodyApiError('invalid', `Conteggi dell’indice non coerenti (${section}/${locale}).`);
  }
  return {
    schemaVersion: 1,
    section,
    locale,
    status: value.status,
    expectedCount: value.expectedCount,
    availableCount: value.availableCount,
    missingCount: value.missingCount,
    entries,
  };
}

async function fetchIndex(
  capability: ArticleBodyCapability,
  section: string,
  locale: ArticleBodyApiLocale,
): Promise<ArticleBodyIndex | null> {
  const relativePath = articleIndexPath(capability, section, locale);
  if (!relativePath) return null;
  const key = `${articlesApiBase()}:${relativePath}`;
  const inFlight = indexInFlight.get(key);
  if (inFlight) return inFlight;
  const promise = fetchJson(absoluteApiUrl(relativePath), 'no-store')
    .then((value) => {
      const index = parseIndex(value, section, locale);
      const descriptor = capability.sections[section].locales[locale];
      if (index.expectedCount !== descriptor.expected
        || index.availableCount !== descriptor.available
        || index.missingCount !== descriptor.missing) {
        throw new ArticleBodyApiError('revision', `Riepilogo indice cambiato (${section}/${locale}).`);
      }
      return index;
    });
  indexInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (indexInFlight.get(key) === promise) indexInFlight.delete(key);
  }
}

function sortedTranslations(value: Record<string, string>): Record<string, string> {
  const translations: Record<string, string> = {};
  for (let index = 1; index <= 20; index += 1) {
    const key = `body${index}`;
    if (Object.prototype.hasOwnProperty.call(value, key)) translations[key] = value[key];
  }
  if (Object.prototype.hasOwnProperty.call(value, 'faq')) translations.faq = value.faq;
  return translations;
}

async function expectedRevision(payload: Omit<ArticleBodyApiPayload, 'revision'>): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new ArticleBodyApiError('invalid', 'Verifica crittografica non disponibile.');
  const canonical = {
    schemaVersion: 1,
    section: payload.section,
    locale: payload.locale,
    id: payload.id,
    meta: {
      title: payload.meta.title,
      excerpt: payload.meta.excerpt,
      imageAlt: payload.meta.imageAlt,
    },
    translations: sortedTranslations(payload.translations),
  };
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(canonical)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function parsePayload(
  value: unknown,
  section: string,
  locale: ArticleBodyApiLocale,
  id: string,
  expectedHash: string,
): Promise<ArticleBodyApiPayload> {
  const payloadKeys = ['schemaVersion', 'section', 'locale', 'id', 'revision', 'meta', 'translations'];
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== [...payloadKeys].sort().join(',')
    || value.schemaVersion !== 1
    || value.section !== section
    || value.locale !== locale
    || value.id !== id
    || typeof value.revision !== 'string'
    || !REVISION_RE.test(value.revision)
    || !isRecord(value.meta)
    || Object.keys(value.meta).sort().join(',') !== ['excerpt', 'imageAlt', 'title'].sort().join(',')
    || !isRecord(value.translations)) {
    throw new ArticleBodyApiError('invalid', 'Documento articolo non valido.');
  }
  const meta: ArticleBodyApiPayload['meta'] = {
    title: typeof value.meta.title === 'string' ? value.meta.title : '',
    excerpt: typeof value.meta.excerpt === 'string' ? value.meta.excerpt : '',
    imageAlt: typeof value.meta.imageAlt === 'string' ? value.meta.imageAlt : '',
  };
  if (Object.values(meta).some((text) => typeof text !== 'string' || !text.trim())) {
    throw new ArticleBodyApiError('invalid', 'Metadati articolo incompleti.');
  }

  const rawTranslations: Record<string, string> = {};
  for (const [key, text] of Object.entries(value.translations)) {
    if ((!/^body(?:[1-9]|1[0-9]|20)$/u.test(key) && key !== 'faq')
      || typeof text !== 'string'
      || !text.trim()) {
      throw new ArticleBodyApiError('invalid', 'Testo articolo non valido.');
    }
    rawTranslations[key] = text;
  }
  for (const required of ['body1', 'body2', 'body3']) {
    if (!Object.prototype.hasOwnProperty.call(rawTranslations, required)) {
      throw new ArticleBodyApiError('invalid', 'Testo articolo incompleto.');
    }
  }
  if (Object.prototype.hasOwnProperty.call(rawTranslations, 'faq')) {
    try {
      if (!Array.isArray(JSON.parse(rawTranslations.faq))) throw new Error('faq');
    } catch {
      throw new ArticleBodyApiError('invalid', 'FAQ articolo non valide.');
    }
  }

  const unsigned = {
    schemaVersion: 1 as const,
    section,
    locale,
    id,
    meta,
    translations: sortedTranslations(rawTranslations),
  };
  const computedHash = await expectedRevision(unsigned);
  if (value.revision !== expectedHash || computedHash !== expectedHash) {
    throw new ArticleBodyApiError('revision', 'La revisione del testo articolo non corrisponde.');
  }
  return { ...unsigned, revision: computedHash };
}

function cachePayload(key: string, payload: ArticleBodyApiPayload): void {
  payloadCache.delete(key);
  payloadCache.set(key, payload);
  while (payloadCache.size > PAYLOAD_CACHE_LIMIT) {
    const oldest = payloadCache.keys().next().value;
    if (oldest === undefined) break;
    payloadCache.delete(oldest);
  }
}

async function fetchPayload(
  section: string,
  locale: ArticleBodyApiLocale,
  id: string,
  expectedHash: string,
  cache: RequestCache,
): Promise<ArticleBodyApiPayload> {
  const cacheKey = `${section}:${locale}:${id}:${expectedHash}`;
  const cached = payloadCache.get(cacheKey);
  if (cached) {
    payloadCache.delete(cacheKey);
    payloadCache.set(cacheKey, cached);
    return cached;
  }
  const existing = payloadInFlight.get(cacheKey);
  if (existing) return existing;
  const relativePath = `bodies/${section}/${locale}/${id}.json`;
  const promise = fetchJson(absoluteApiUrl(relativePath, { revision: expectedHash }), cache)
    .then((value) => parsePayload(value, section, locale, id, expectedHash))
    .then((payload) => {
      cachePayload(cacheKey, payload);
      return payload;
    });
  payloadInFlight.set(cacheKey, promise);
  try {
    return await promise;
  } finally {
    if (payloadInFlight.get(cacheKey) === promise) payloadInFlight.delete(cacheKey);
  }
}

async function loadLocaleDocument(
  capability: ArticleBodyCapability,
  section: string,
  locale: ArticleBodyApiLocale,
  id: string,
  forcePayloadRefresh: boolean,
): Promise<ArticleBodyApiDocument> {
  const descriptor = capability.sections[section];
  if (!descriptor) throw new ArticleBodyApiError('invalid', `Sezione articolo sconosciuta: ${section}.`);
  if (descriptor.status === 'inactive') return { locale, id, status: 'missing' };
  const index = await fetchIndex(capability, section, locale);
  if (!index || index.status === 'inactive') return { locale, id, status: 'missing' };
  const entry = index.entries[id];
  if (!entry) throw new ArticleBodyApiError('invalid', `Articolo assente dall’indice (${section}/${locale}/${id}).`);
  if (entry.status === 'missing') return { locale, id, status: 'missing' };
  const payload = await fetchPayload(section, locale, id, entry.expectedHash, forcePayloadRefresh ? 'reload' : 'default');
  return { locale, id, status: 'available', payload };
}

/**
 * Resolve the published body surface. Only verified payloads are memoized;
 * missing entries and failures are deliberately requested again later.
 */
export async function loadArticleBodyApi(
  section: ArticleSection,
  id: string,
  locales: readonly ArticleBodyApiLocale[],
): Promise<ArticleBodyApiResult> {
  if (!SECTION_RE.test(section) || !ARTICLE_ID_RE.test(id)
    || locales.length === 0 || locales.some((locale) => !isLocale(locale))) {
    return { status: 'error', reason: 'invalid', authoritative: hasActiveCapability(), locales: [] };
  }
  const uniqueLocales = [...new Set(locales)];
  let lastError: ArticleBodyApiError | undefined;

  // A revision mismatch or transient network failure gets one bounded refresh.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const capability = await fetchManifest(attempt > 0);
      if (!capability) return { status: 'legacy' };
      const documents = await Promise.all(uniqueLocales.map((locale) => (
        loadLocaleDocument(capability, section, locale, id, attempt > 0)
      )));
      return {
        status: documents.some((document) => document.status === 'available') ? 'loaded' : 'missing',
        documents,
      };
    } catch (error) {
      lastError = error instanceof ArticleBodyApiError
        ? error
        : new ArticleBodyApiError('network', 'Servizio articoli non raggiungibile.');
      if (attempt === 0) {
        cachedManifest = null;
        continue;
      }
    }
  }

  return {
    status: 'error',
    reason: lastError?.kind ?? 'network',
    authoritative: hasActiveCapability(),
    locales: uniqueLocales,
  };
}

/** Test-only cache reset; no caller uses this in application code. */
export function resetArticleBodyApiForTests(): void {
  cachedManifest = null;
  manifestInFlight = null;
  indexInFlight.clear();
  payloadInFlight.clear();
  payloadCache.clear();
  capabilityWasActive = false;
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(API_ACTIVE_SESSION_KEY);
  } catch { /* no session storage in this environment */ }
}
