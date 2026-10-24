/**
 * Internationalization Service (i18n)
 * Supports: IT (default), EN, DE, FR
 * Italian translations are inline; other locales load on demand.
 */

export type Locale = 'it' | 'en' | 'de' | 'fr';
import type { ArticleSection, HistoricalArticleSection } from './articleSections';
import { articlesApiBase } from './articlesApiBase';
import { isArticleBodyPlaceholder } from './articleBodyRecovery';
import type { ArticleBodyApiLocale, ArticleBodyApiResult } from './articleBodyApi';

type TranslationKey = string;
type Translations = Record<TranslationKey, string>;

// ─── Current Locale ──────────────────────────────────────────

let currentLocale: Locale = 'it';
const listeners: Array<(locale: Locale) => void> = [];

// Depth > 0 while listeners are being told that translation DATA arrived (a
// chunk, an article document, an overlay), as opposed to the visitor switching
// locale. useLocale() applies the first kind inside startTransition: that
// re-render touches every component that called t(), and as a default-lane
// update React renders it in one non-interruptible task — measured up to
// 1.2-1.8 s on a mid-range phone profile on the article template, right in the
// window where the visitor's first taps land (field INP p75 327 ms).
let translationDataNotifyDepth = 0;

/** Bump the tick and tell subscribers that new translation data is available. */
function notifyTranslationsLoaded(): void {
 localeTick++;
 translationDataNotifyDepth++;
 try {
  listeners.forEach(fn => fn(currentLocale));
 } finally {
  translationDataNotifyDepth--;
 }
}

/** True only inside a {@link notifyTranslationsLoaded} dispatch. */
export function isTranslationDataNotification(): boolean {
 return translationDataNotifyDepth > 0;
}

// Loaded locale data — IT critical keys are available synchronously, others load on demand
const loadedLocales: Partial<Record<Locale, Translations>> = {};
const localeLoading: Partial<Record<Locale, Promise<void>>> = {};

// ─── Per-page chunk loaders for EN/DE/FR (same split as Italian) ─

type ChunkLoader = () => Promise<{ default: Translations }>;

// Above-the-fold critical keys for non-IT locales (tiny ~4KB, loaded first)
const localeCriticalLoaders: Partial<Record<Locale, ChunkLoader>> = {
 en: () => import('./locales/en-critical'),
};

const localeChunkLoaders: Record<string, Record<string, ChunkLoader>> = {
 en: {
 core: () => import('./locales/en-core'),
 calculator: () => import('./locales/en-calculator'),
 comparatori: () => import('./locales/en-comparatori'),
 fisco: () => import('./locales/en-fisco'),
 guide: () => import('./locales/en-guide'),
 vita: () => import('./locales/en-vita'),
 stats: () => import('./locales/en-stats'),
 'seo-links': () => import('./locales/en-seo-links'),
 },
 de: {
 core: () => import('./locales/de-core'),
 calculator: () => import('./locales/de-calculator'),
 comparatori: () => import('./locales/de-comparatori'),
 fisco: () => import('./locales/de-fisco'),
 guide: () => import('./locales/de-guide'),
 vita: () => import('./locales/de-vita'),
 stats: () => import('./locales/de-stats'),
 'seo-links': () => import('./locales/de-seo-links'),
 },
 fr: {
 core: () => import('./locales/fr-core'),
 calculator: () => import('./locales/fr-calculator'),
 comparatori: () => import('./locales/fr-comparatori'),
 fisco: () => import('./locales/fr-fisco'),
 guide: () => import('./locales/fr-guide'),
 vita: () => import('./locales/fr-vita'),
 stats: () => import('./locales/fr-stats'),
 'seo-links': () => import('./locales/fr-seo-links'),
 },
};

const loadedLocaleChunks: Record<string, Set<string>> = { en: new Set(), de: new Set(), fr: new Set() };

function mergeLocaleTranslations(locale: Locale, translations: Translations): void {
 if (loadedLocales[locale]) {
 Object.assign(loadedLocales[locale]!, translations);
 } else {
 loadedLocales[locale] = { ...translations };
 }
}

/**
 * Merge article title/excerpt keys published OUT OF BAND, at runtime.
 *
 * The blog list is rendered from data compiled into this bundle, so an article
 * generated after the last deploy had no title here and could not be listed —
 * which is what kept new articles invisible on the site until a redeploy
 * (issue #4974 item 3). `services/articlesOverlay.ts` fetches the index the
 * articles repo publishes and hands the keys here.
 *
 * Deliberately does NOT overwrite: a key already present came from this
 * build's own chunk and is authoritative. The overlay only fills gaps, so a
 * stale or malformed index can never change an existing title.
 *
 * Bumps the locale tick and notifies subscribers, so components already
 * mounted re-render with the new keys instead of waiting for the next locale
 * change.
 */
export function mergeArticleMetaOverlay(locale: Locale, translations: Translations): number {
  const target = loadedLocales[locale];
  let added = 0;
  if (!target) {
    loadedLocales[locale] = { ...translations };
    added = Object.keys(translations).length;
  } else {
    for (const [k, v] of Object.entries(translations)) {
      if (target[k] === undefined) { target[k] = v; added++; }
    }
  }
  if (added > 0) {
    notifyTranslationsLoaded();
  }
  return added;
}

/** Recover absent/placeholder body keys only; valid prose and metadata stay authoritative. */
export function mergeRecoveredArticleBody(locale: Locale, id: string, parts: readonly string[]): number {
  const target = loadedLocales[locale] ?? (loadedLocales[locale] = {});
  const prefix = `blog.article.${id}.body`;
  const existing = Object.keys(target).filter((key) => key.startsWith(prefix) && /^\d+$/.test(key.slice(prefix.length)));
  // Static recovery returns an array, not named fields. A compacted or partial
  // body must not be assigned to different existing bodyN positions.
  if (existing.length > 0 && (existing.length !== parts.length
    || parts.some((_, index) => !existing.includes(`${prefix}${index + 1}`)))) return 0;
  let changed = 0;
  parts.forEach((part, index) => {
    const key = `${prefix}${index + 1}`;
    if (!isArticleBodyPlaceholder(part) && (target[key] === undefined || isArticleBodyPlaceholder(target[key]))) {
      target[key] = part;
      changed++;
    }
  });
  if (changed > 0) {
    notifyTranslationsLoaded();
  }
  return changed;
}

// Background preloads can be interrupted during test worker teardown.
// We intentionally swallow those rejections to avoid unhandled promise noise.
function swallowBackgroundLoadError(_err: unknown): void {
 // no-op by design
}

// ─── Blog Translations (2-tier: meta + per-article body) ─────

// Tier 1: Blog meta (titles, excerpts, imageAlt) — per article section
type ArticleSectionName = ArticleSection;

// Keep this leaf predicate local. i18n is imported by a few Vite build-plugin
// type graphs; pulling the runtime registry into that graph would make the
// build config try to resolve browser-only aliases before Vite is configured.
function isCantonSection(section: ArticleSectionName): boolean {
 return section.startsWith('canton-');
}

const blogMetaLoaders: Record<HistoricalArticleSection, Record<Locale, () => Promise<{ default: Translations }>>> = {
 frontaliere: {
 it: () => import('./locales/blog-meta-it'),
 en: () => import('./locales/blog-meta-en'),
 de: () => import('./locales/blog-meta-de'),
 fr: () => import('./locales/blog-meta-fr'),
 },
 svizzera: {
 it: () => import('./locales/blog-meta-ch-it'),
 en: () => import('./locales/blog-meta-ch-en'),
 de: () => import('./locales/blog-meta-ch-de'),
 fr: () => import('./locales/blog-meta-ch-fr'),
 },
};

// "section:locale" markers for meta chunks already merged in.
const blogMetaLoaded = new Set<string>();
const blogMetaLoadingPromises = new Map<string, Promise<void>>();

const cantonMetaPromises = new Map<Locale, Promise<Translations>>();

async function loadCantonMeta(locale: Locale): Promise<Translations> {
 const cached = cantonMetaPromises.get(locale);
 if (cached) return cached;
 const promise = fetch(`${articlesApiBase()}/meta-canton-${locale}.json`)
   .then(async response => {
    if (!response.ok) return {};
    const raw = await response.json() as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw as Record<string, unknown>)
        .filter(([, value]) => typeof value === 'string'),
    ) as Translations;
   })
   .catch(() => ({} as Translations));
 cantonMetaPromises.set(locale, promise);
 return promise;
}

// Tier 2: Per-article body (bodyN) — loaded on demand
const loadedArticleBodies = new Set<string>(); // "locale:articleId"
const articleBodyPromises = new Map<string, Promise<void>>();
// Published article documents are authoritative per locale/article. `null`
// records a declared missing document; an available document is an exact
// namespace and never inherits omitted fields from another locale.
const apiArticleTranslations = new Map<Locale, Map<string, Translations | null>>();
let articleBodyRequestSequence = 0;
const latestArticleBodyRequest = new Map<string, number>();

function articleBodyDocumentKey(section: ArticleSectionName, locale: ArticleBodyApiLocale, id: string): string {
 return `${section}:${locale}:${id}`;
}

function beginArticleBodyRequest(
 section: ArticleSectionName,
 id: string,
 locales: readonly ArticleBodyApiLocale[],
): ReadonlyMap<ArticleBodyApiLocale, number> {
 const generation = ++articleBodyRequestSequence;
 const generations = new Map<ArticleBodyApiLocale, number>();
 for (const locale of locales) {
  latestArticleBodyRequest.set(articleBodyDocumentKey(section, locale, id), generation);
  generations.set(locale, generation);
 }
 return generations;
}

function mergeAuthoritativeArticleApiDocuments(
 result: Extract<ArticleBodyApiResult, { status: 'loaded' | 'missing' }>,
 section: ArticleSectionName,
 requestGenerations: ReadonlyMap<ArticleBodyApiLocale, number>,
): void {
 let changed = false;
 for (const document of result.documents) {
  const documentKey = articleBodyDocumentKey(section, document.locale, document.id);
  const requestGeneration = requestGenerations.get(document.locale);
  if (requestGeneration === undefined || latestArticleBodyRequest.get(documentKey) !== requestGeneration) continue;
  const locale = document.locale as Locale;
  const byArticle = apiArticleTranslations.get(locale) ?? new Map<string, Translations | null>();
  const translations: Translations = {};
  if (document.status === 'available') {
   const prefix = `blog.article.${document.payload.id}.`;
   translations[`${prefix}title`] = document.payload.meta.title;
   translations[`${prefix}excerpt`] = document.payload.meta.excerpt;
   translations[`${prefix}imageAlt`] = document.payload.meta.imageAlt ?? '';
   for (const [field, value] of Object.entries(document.payload.translations)) {
    translations[`${prefix}${field}`] = value;
   }
  }
  byArticle.set(document.id, document.status === 'available' ? translations : null);
  apiArticleTranslations.set(locale, byArticle);
  changed = true;
 }
 if (changed) {
  notifyTranslationsLoaded();
 }
}

function authoritativeArticleTranslation(key: string): { handled: boolean; value?: string } {
 const match = /^blog\.article\.([a-z0-9][a-z0-9-]*)\./u.exec(key);
 if (!match) return { handled: false };
 const id = match[1];
 const currentArticles = apiArticleTranslations.get(currentLocale);
 const italianArticles = apiArticleTranslations.get('it');
 if (currentArticles?.has(id)) {
  const currentDocument = currentArticles.get(id);
  if (currentDocument) return { handled: true, value: currentDocument[key] };
  if (currentLocale !== 'it' && italianArticles?.has(id)) {
   return { handled: true, value: italianArticles.get(id)?.[key] };
  }
  return { handled: true };
 }
 if (currentLocale !== 'it' && italianArticles?.has(id)) {
  return { handled: true, value: italianArticles.get(id)?.[key] };
 }
 return { handled: false };
}

/**
 * Lazily loads blog META translations (titles, excerpts) for the current locale + IT fallback.
 * This is ~85% smaller than the old monolithic blog load.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function loadBlogMeta(section: ArticleSectionName = 'frontaliere'): Promise<void> {
 if (isCantonSection(section)) {
  const key = `${section}:${currentLocale}`;
  if (blogMetaLoaded.has(key)) return;
  const existing = blogMetaLoadingPromises.get(key);
  if (existing) {
   await existing;
   return;
  }
  const promise = (async () => {
   const itMeta = await loadCantonMeta('it');
   mergeLocaleTranslations('it', itMeta);
   blogMetaLoaded.add(`${section}:it`);
   if (currentLocale !== 'it') {
    const localeMeta = await loadCantonMeta(currentLocale);
    mergeLocaleTranslations(currentLocale, localeMeta);
    blogMetaLoaded.add(key);
   }
   notifyTranslationsLoaded();
  })();
  blogMetaLoadingPromises.set(key, promise);
  await promise;
  return;
 }
 const loaders = blogMetaLoaders[section as HistoricalArticleSection];
 if (!loaders) return;
 const key = `${section}:${currentLocale}`;
 if (blogMetaLoaded.has(key)) return;
 const existing = blogMetaLoadingPromises.get(key);
 if (existing) {
 await existing;
 return;
 }
 const promise = (async () => {
 const itMeta = await loaders.it();
 loadedLocales['it'] = { ...loadedLocales['it'], ...itMeta.default };

 if (currentLocale !== 'it') {
 const localeMeta = await loaders[currentLocale]();
 loadedLocales[currentLocale] = { ...loadedLocales[currentLocale], ...localeMeta.default };
 }
 blogMetaLoaded.add(`${section}:it`);
 blogMetaLoaded.add(key);
 notifyTranslationsLoaded();
 })();
 blogMetaLoadingPromises.set(key, promise);
 await promise;
}

/**
 * Lazily loads BODY translations (body1, body2, body3) for a single article.
 * Called when the user opens a specific article. ~3-7 KB per article.
 */
export type ArticleBodyLoadResult =
 | { status: 'legacy' }
 | { status: 'loaded' | 'missing' }
 | { status: 'error'; reason: 'network' | 'invalid' | 'revision'; authoritative: boolean };

export async function loadArticleBody(
 articleId: string,
 section: ArticleSectionName = 'frontaliere',
): Promise<ArticleBodyLoadResult> {
 const locale = currentLocale;
 const apiLocales: ArticleBodyApiLocale[] = locale === 'it' ? ['it'] : ['it', locale];
 const requestGenerations = beginArticleBodyRequest(section, articleId, apiLocales);
 const { loadArticleBodyApi } = await import('./articleBodyApi');
 const apiResult = await loadArticleBodyApi(section, articleId, apiLocales);
 if (apiResult.status === 'error') {
  if (apiResult.authoritative) {
   mergeAuthoritativeArticleApiDocuments({
    status: 'missing',
    documents: apiResult.locales.map((apiLocale) => ({ locale: apiLocale, id: articleId, status: 'missing' })),
   }, section, requestGenerations);
  }
  // A valid legacy manifest returns `legacy` above. Network, revision, and
  // malformed-manifest failures stay visible as retryable errors even before
  // this tab has observed the capability; otherwise an outage on first visit
  // would silently show compiled content with an unknown revision.
  return { status: 'error', reason: apiResult.reason, authoritative: apiResult.authoritative };
 }
 if (apiResult.status === 'loaded' || apiResult.status === 'missing') {
  mergeAuthoritativeArticleApiDocuments(apiResult, section, requestGenerations);
  return { status: apiResult.status };
 }

 if (isCantonSection(section)) {
  // Before the body API is published, canton bodies are recovered from the
  // corpus-owned static article HTML by runtimeArticleResolution. They are not
  // bundled in the site, so importing a guessed Vite chunk would be a false
  // empty body.
  return { status: 'legacy' };
 }
 const key = `${section}:${locale}:${articleId}`;
 const itKey = `${section}:it:${articleId}`;

 // Load IT fallback body if not loaded
 if (!loadedArticleBodies.has(itKey) && !articleBodyPromises.has(itKey)) {
 articleBodyPromises.set(itKey, (async () => {
 const { loadBlogBodyChunk } = await import('./blogBodyLoader');
 const data = await loadBlogBodyChunk('it', articleId, section);
 if (data) {
 mergeLocaleTranslations('it', data);
 loadedArticleBodies.add(itKey);
 }
 })());
 }

 // Load current locale body if not IT and not loaded
 if (locale !== 'it' && !loadedArticleBodies.has(key) && !articleBodyPromises.has(key)) {
 articleBodyPromises.set(key, (async () => {
 const { loadBlogBodyChunk } = await import('./blogBodyLoader');
 const data = await loadBlogBodyChunk(locale, articleId, section);
 if (data) {
 mergeLocaleTranslations(locale, data);
 loadedArticleBodies.add(key);
 }
 })());
 }

 await Promise.all([
 articleBodyPromises.get(itKey),
 locale !== 'it' ? articleBodyPromises.get(key) : undefined,
 ]);

 notifyTranslationsLoaded();
 return { status: 'legacy' };
}

/**
 * Return every bodyN translation currently available to the active locale.
 *
 * The article loader merges arbitrary bodyN fields into the locale stores, so
 * callers that need the complete article body must enumerate those stores
 * instead of assuming the historical body1/body2/body3 shape. The merge order
 * mirrors t(): the active locale wins, then the Italian fallback is used.
 */
export function getLoadedArticleBody(articleId: string): Readonly<Record<string, string>> {
 const prefix = `blog.article.${articleId}.`;
 const bodyKey = /^body\d+$/;
 const result: Record<string, string> = {};
 const currentArticles = apiArticleTranslations.get(currentLocale);
 const italianArticles = apiArticleTranslations.get('it');
 let apiDocument: Translations | null | undefined;
 let apiOwnsArticle = false;
 if (currentArticles?.has(articleId)) {
  apiOwnsArticle = true;
  apiDocument = currentArticles.get(articleId);
  if (apiDocument === null && currentLocale !== 'it' && italianArticles?.has(articleId)) {
   apiDocument = italianArticles.get(articleId);
  }
 } else if (currentLocale !== 'it' && italianArticles?.has(articleId)) {
  apiOwnsArticle = true;
  apiDocument = italianArticles.get(articleId);
 }
 if (apiOwnsArticle) {
  for (const [key, value] of Object.entries(apiDocument ?? {})) {
   if (!key.startsWith(prefix)) continue;
   const field = key.slice(prefix.length);
   if (bodyKey.test(field) && value) result[field] = value;
  }
  return result;
 }
 const merge = (translations?: Translations): void => {
  for (const [key, value] of Object.entries(translations ?? {})) {
   if (!key.startsWith(prefix)) continue;
   const field = key.slice(prefix.length);
   if (bodyKey.test(field) && value) result[field] = value;
  }
 };

 merge(loadedLocales.it);
 merge(itTranslations);
 if (currentLocale !== 'it') merge(loadedLocales[currentLocale]);
 return result;
}

/** @deprecated Use loadBlogMeta() + loadArticleBody(id) instead */
export async function loadBlogTranslations(): Promise<void> {
 await loadBlogMeta();
}

async function refreshLoadedBlogSections(): Promise<void> {
 const sections = new Set<ArticleSection>();
 for (const marker of blogMetaLoaded) {
  const section = marker.split(':')[0] as ArticleSection;
  sections.add(section);
 }
 await Promise.all([...sections].map(section => loadBlogMeta(section)));
}

export async function ensureLocaleLoaded(locale: Locale): Promise<void> {
 if (locale === 'it') {
 // IT translations are loaded eagerly via itReady; wait for them
 await itReady;
 if (blogMetaLoaded.size > 0) await refreshLoadedBlogSections();
 return;
 }

 // Per-chunk loading for EN/DE/FR (same split as Italian)
 const chunks = localeChunkLoaders[locale];
 if (!chunks) return;

 // If core+calculator already loaded, just wait for any in-flight loading
 if (loadedLocaleChunks[locale].has('core')) {
 if (blogMetaLoaded.size > 0) await refreshLoadedBlogSections();
 return;
 }

 if (localeLoading[locale]) {
 await localeLoading[locale];
 return;
 }

 // Load critical above-the-fold keys first (tiny ~4KB, renders instantly),
 // then core + calculator in parallel. Critical keys reduce flash-of-IT on EN pages.
 const criticalLoader = localeCriticalLoaders[locale];
 localeLoading[locale] = (async () => {
 if (criticalLoader) {
 const critical = await criticalLoader();
 mergeLocaleTranslations(locale, critical.default);
 notifyTranslationsLoaded();
 }
 const [core, calc, seoLinks] = await Promise.all([
 chunks.core(),
 chunks.calculator(),
 chunks['seo-links'] ? chunks['seo-links']() : Promise.resolve({ default: {} as Translations }),
 ]);
 mergeLocaleTranslations(locale, core.default);
 mergeLocaleTranslations(locale, calc.default);
 mergeLocaleTranslations(locale, seoLinks.default);
 loadedLocaleChunks[locale].add('core');
 loadedLocaleChunks[locale].add('calculator');
 loadedLocaleChunks[locale].add('seo-links');

 // If blog meta was already loaded, merge meta keys for this locale too
 if (blogMetaLoaded.size > 0) await refreshLoadedBlogSections();

 // Background-load remaining page chunks — one notification for the
 // batch, same reason as the Italian loader below.
 const loadRemaining = () => {
 const pending = Object.entries(chunks)
 .filter(([page]) => page !== 'core' && page !== 'calculator' && !loadedLocaleChunks[locale].has(page))
 .map(([page, loader]) => loader()
 .then(m => {
 mergeLocaleTranslations(locale, m.default);
 loadedLocaleChunks[locale].add(page);
 return true;
 })
 .catch((err: unknown) => {
 swallowBackgroundLoadError(err);
 return false;
 }));
 if (pending.length === 0) return;
 void Promise.all(pending).then(results => {
 if (results.some(Boolean)) notifyTranslationsLoaded();
 });
 };
 if (typeof requestIdleCallback === 'function') {
 requestIdleCallback(loadRemaining);
 } else {
 setTimeout(loadRemaining, 100);
 }
 })();
 await localeLoading[locale];
}

export function getLocale(): Locale {
 return currentLocale;
}

// Monotonic tick: incremented after async locale data finishes loading.
// useLocale() watches this so React always re-renders with fresh translations.
let localeTick = 0;
export function getLocaleTick(): number { return localeTick; }

export function setLocale(locale: Locale): void {
 currentLocale = locale;
 localStorage.setItem('frontaliere_locale', locale);
 document.documentElement.lang = locale;
 // Load locale data if needed, then re-notify to trigger re-render with translations
 if (locale !== 'it' && !loadedLocales[locale]) {
 ensureLocaleLoaded(locale)
 .then(() => {
 // Bump tick so useLocale state changes even though the locale string is the same
 notifyTranslationsLoaded();
 })
 .catch(swallowBackgroundLoadError);
 }
 listeners.forEach(fn => fn(locale));
}

export function onLocaleChange(fn: (locale: Locale) => void): () => void {
 listeners.push(fn);
 return () => {
 const idx = listeners.indexOf(fn);
 if (idx >= 0) listeners.splice(idx, 1);
 };
}

export function initLocale(): void {
 const validLocales = ['it', 'en', 'de', 'fr'];

 // 1. Check URL path prefix (/en/..., /de/..., /fr/...)
 const pathParts = window.location.pathname.split('/').filter(Boolean);
 if (pathParts.length > 0 && validLocales.includes(pathParts[0])) {
 setLocale(pathParts[0] as Locale);
 return;
 }

 // 2. Check URL ?lang= parameter (legacy hreflang links)
 const urlParams = new URLSearchParams(window.location.search);
 const urlLang = urlParams.get('lang') as Locale | null;
 if (urlLang && validLocales.includes(urlLang)) {
 setLocale(urlLang);
 return;
 }

 // 3. Non-prefixed deep links are canonical Italian URLs.
 // Respect the visited route instead of overriding it with a stored locale.
 if (pathParts.length > 0) {
 setLocale('it');
 return;
 }

 // 4. Check localStorage (user's previous choice) on the locale root only
 const stored = localStorage.getItem('frontaliere_locale') as Locale | null;
 if (stored && validLocales.includes(stored)) {
 setLocale(stored);
 return;
 }

 // 5. Default to Italian
 setLocale('it');
}

// ─── Translation Function ────────────────────────────────────

export function t(key: string, fallback?: string): string;
export function t(key: string, params: Record<string, string | number>): string;
export function t(key: string, paramsOrFallback?: string | Record<string, string | number>): string {
 const fallback = typeof paramsOrFallback === 'string' ? paramsOrFallback : undefined;
 const params = typeof paramsOrFallback === 'object' ? paramsOrFallback : undefined;
 let translation: string | undefined;
 const authoritative = authoritativeArticleTranslation(key);
 if (authoritative.handled) {
 translation = authoritative.value ?? fallback ?? key;
 } else if (currentLocale === 'it') {
 translation = itTranslations[key] || loadedLocales['it']?.[key];
 } else {
 translation = loadedLocales[currentLocale]?.[key] || itTranslations[key] || loadedLocales['it']?.[key];
 }
 if (!authoritative.handled && !translation) translation = fallback ?? key;
 if (typeof translation !== 'string') translation = fallback ?? key;
 if (!params) return translation;
 return Object.entries(params).reduce(
 (str, [k, v]) => str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
 translation
 );
}

// ─── React Hook ──────────────────────────────────────────────

import { useState, useEffect, startTransition } from 'react';

export function useLocale(): [Locale, (l: Locale) => void] {
 const [, setTick] = useState(0);
 const [locale, setL] = useState<Locale>(currentLocale);
 useEffect(() => {
 // Listen for locale changes — always bump tick to guarantee re-render
 // even when the locale string is the same (async load completed)
 return onLocaleChange((l) => {
 const apply = () => {
 setL(l);
 setTick(getLocaleTick());
 };
 // Translation data arriving in the background is not something the
 // visitor did: render it as a transition, so React can interrupt it for a
 // tap or a keystroke instead of holding the main thread for the whole
 // tree. A locale switch stays urgent.
 if (isTranslationDataNotification()) startTransition(apply);
 else apply();
 });
 }, []);
 return [locale, setLocale];
}

import { getCantonLabel, type CantonLocale } from './cantonList';
// Il sentinel viveva anche qui come letterale: stessa stringa, due
// definizioni. Ora che `services/jobBoardSlugs.ts` e' un modulo foglia
// (niente dipendenze SPA, quindi importabile da qui senza ciclo) c'e' una
// definizione sola — AGENTS.md #6.
import { JOB_BOARD_CANTON_AGGREGATE } from './jobBoardSlugs';

// Switzerland-wide aggregator label (`/cerca-lavoro-svizzera/`) per locale.
const AGGREGATE_CANTON_LABEL: Record<Locale, string> = {
 it: 'Svizzera', en: 'Switzerland', de: 'Schweiz', fr: 'Suisse',
};
const AGGREGATE_CANTON_PREP: Record<Locale, string> = {
 it: 'in Svizzera', en: 'in Switzerland', de: 'in der Schweiz', fr: 'en Suisse',
};

// Curated prepositional phrases where the article/idiom is irregular and a
// generic "im Kanton X" / "dans le canton de X" would read unnaturally. Every
// other canton falls back to {@link defaultCantonPrep}, which is always
// grammatically correct (just less idiomatic than these hand-tuned forms).
const CANTON_PREP_OVERRIDES: Record<string, Partial<Record<Locale, string>>> = {
 TI: { it: 'in Ticino', en: 'in Ticino', de: 'im Tessin', fr: 'au Tessin' },
 GR: { it: 'in Grigioni', en: 'in Graubünden', de: 'in Graubünden', fr: 'aux Grisons' },
 VS: { it: 'in Vallese', en: 'in Valais', de: 'im Wallis', fr: 'en Valais' },
};

function defaultCantonPrep(label: string, locale: Locale): string {
 switch (locale) {
 case 'de': return `im Kanton ${label}`;
 case 'fr': return `dans le canton de ${label}`;
 case 'en': return `in ${label}`;
 case 'it':
 default: return `in ${label}`;
 }
}

/**
 * Returns {canton, cantonPrep} interpolation params for locale-aware strings.
 *
 * `cantonCode` accepts any BFS code (`TI`, `ZH`, `BS`…), the URL group keys
 * (`BASILEA` → "Basilea", `APPENZELLO` → "Appenzello"), or the aggregator
 * sentinel `_AGGREGATE_` ("Svizzera"). Defaults to `TI` so the dozens of
 * existing call sites that pass nothing keep rendering the Ticino label
 * unchanged. Canton-scoped pages (per-canton job board) pass their real code
 * so the H1/subtitle/CTA reflect the canton the user actually landed on
 * instead of always saying "Ticino".
 */
export function getCantonI18nParams(cantonCode: string = 'TI'): Record<string, string> {
 const locale = getLocale();
 const upper = String(cantonCode || 'TI').toUpperCase();

 if (upper === JOB_BOARD_CANTON_AGGREGATE) {
 return {
 canton: AGGREGATE_CANTON_LABEL[locale],
 cantonPrep: AGGREGATE_CANTON_PREP[locale],
 };
 }

 const label = getCantonLabel(upper, locale as CantonLocale);
 const prep = CANTON_PREP_OVERRIDES[upper]?.[locale] || defaultCantonPrep(label, locale);
 return { canton: label, cantonPrep: prep };
}

export function useTranslation() {
 const [locale] = useLocale();
 return { t, locale, setLocale };
}

// ─── Locale Labels ───────────────────────────────────────────

export const LOCALE_LABELS: Record<Locale, { flag: string; name: string; nativeName: string }> = {
 it: { flag: '🇮🇹', name: 'Italian', nativeName: 'Italiano' },
 en: { flag: '🇬🇧', name: 'English', nativeName: 'English' },
 de: { flag: '🇩🇪', name: 'German', nativeName: 'Deutsch' },
 fr: { flag: '🇫🇷', name: 'French', nativeName: 'Français' },
};

// ─── Italian Translations (per-page code-split) ─────────────
// Core chrome + calculator keys load first (the landing page critical path).
// Other page chunks load in the background after first render.

// Critical above-the-fold translations loaded synchronously (FRO-310).
// This tiny (~4KB) module is bundled into the main chunk, so t() returns
// real strings on first render — no skeleton, no 3s timeout, no CLS.
import itCritical from './locales/it-critical';

let itTranslations: Translations = { ...itCritical };
let _itReady = true; // Critical keys are already available synchronously

// Page chunk loaders — loaded on demand per tab
const itPageLoaders: Record<string, () => Promise<{ default: Translations }>> = {
 guide: () => import('./locales/it-guide'),
 comparatori: () => import('./locales/it-comparatori'),
 fisco: () => import('./locales/it-fisco'),
 vita: () => import('./locales/it-vita'),
 stats: () => import('./locales/it-stats'),
 'seo-links': () => import('./locales/it-seo-links'),
};
const loadedItPages = new Set<string>();

function mergeItTranslations(translations: Translations): void {
 Object.assign(itTranslations, translations);
 if (loadedLocales['it']) {
 Object.assign(loadedLocales['it'], translations);
 } else {
 loadedLocales['it'] = { ...translations };
 }
}

/** Promise that resolves once core + calculator + seo-links IT translations are loaded. */
export const itReady: Promise<void> = Promise.all([
 import('./locales/it-core'),
 import('./locales/it-calculator'),
 import('./locales/it-seo-links'),
]).then(([core, calc, seoLinks]) => {
 mergeItTranslations(core.default);
 mergeItTranslations(calc.default);
 mergeItTranslations(seoLinks.default);
 loadedItPages.add('seo-links');
 _itReady = true;
 // Background-load remaining page chunks after first render. One
 // notification for the whole batch, not one per chunk: each notification
 // re-renders every t() consumer, and the five chunks used to land within a
 // few ms of each other as five back-to-back full-tree renders.
 const loadRemaining = () => {
 const pending = Object.entries(itPageLoaders)
 .filter(([page]) => !loadedItPages.has(page))
 .map(([page, loader]) => loader()
 .then(m => {
 mergeItTranslations(m.default);
 loadedItPages.add(page);
 return true;
 })
 .catch((err: unknown) => {
 swallowBackgroundLoadError(err);
 return false;
 }));
 if (pending.length === 0) return;
 void Promise.all(pending).then(results => {
 if (results.some(Boolean)) notifyTranslationsLoaded();
 });
 };
 if (typeof requestIdleCallback === 'function') {
 requestIdleCallback(loadRemaining);
 } else {
 setTimeout(loadRemaining, 100);
 }
});
// Module-level promise: a chunk failure here must not escape as an unhandled
// rejection when no caller awaits it. Callers still see the rejection.
itReady.catch(swallowBackgroundLoadError);

/** Load translations for a specific tab — no-op if already loaded. */
export async function loadTabTranslations(tab: string): Promise<void> {
 if (loadedItPages.has(tab)) return;
 const loader = itPageLoaders[tab];
 if (!loader) return;
 const m = await loader();
 mergeItTranslations(m.default);
 loadedItPages.add(tab);
 notifyTranslationsLoaded();
}

/**
 * Load ALL translation chunks (IT + current locale). Used by site search.
 * Never rejects: a chunk that fails to load stays unmarked, so t() falls back
 * to Italian for its keys and the next call retries it.
 */
export async function loadAllTranslations(): Promise<void> {
 await itReady.catch(swallowBackgroundLoadError);
 const promises: Promise<void>[] = [];
 for (const [page, loader] of Object.entries(itPageLoaders)) {
 if (!loadedItPages.has(page)) {
 promises.push(loader().then(m => {
 mergeItTranslations(m.default);
 loadedItPages.add(page);
 }).catch(swallowBackgroundLoadError));
 }
 }
 if (currentLocale !== 'it') {
 const chunks = localeChunkLoaders[currentLocale];
 if (chunks) {
 for (const [page, loader] of Object.entries(chunks)) {
 if (!loadedLocaleChunks[currentLocale].has(page)) {
 promises.push(loader().then(m => {
 mergeLocaleTranslations(currentLocale, m.default);
 loadedLocaleChunks[currentLocale].add(page);
 }).catch(swallowBackgroundLoadError));
 }
 }
 }
 }
 if (promises.length > 0) {
 await Promise.all(promises);
 notifyTranslationsLoaded();
 }
}

/**
 * Load ONE page chunk of an EN/DE/FR locale now, instead of waiting for the
 * idle background loader, and return that chunk's own strings.
 *
 * The chunk is merged and announced exactly like the background loader does
 * (so a component that rendered with the Italian fallback re-renders, and the
 * background loader then skips it). The return value is the chunk itself, not
 * `t()`: a caller that needs the LOCALE string — the SPA head of a glossary
 * term, `services/seoService.ts` — must not get the Italian fallback `t()`
 * hands out for a missing key. Never rejects: IT, an unknown chunk or a failed
 * load return null and the caller keeps its own fallback.
 */
export async function loadLocalePageChunk(locale: Locale, page: string): Promise<Readonly<Translations> | null> {
 if (locale === 'it') return null;
 const loader = localeChunkLoaders[locale]?.[page];
 if (!loader) return null;
 try {
 const m = await loader();
 if (!loadedLocaleChunks[locale].has(page)) {
 mergeLocaleTranslations(locale, m.default);
 loadedLocaleChunks[locale].add(page);
 notifyTranslationsLoaded();
 }
 return m.default;
 } catch (err) {
 swallowBackgroundLoadError(err);
 return null;
 }
}

// ─── On-demand namespaces ───────────────────────────────────
// Keys that a single lazy surface reads, kept OUT of the core chunks every
// route waits for. The surface loads its namespace when it actually renders
// (see useTranslationNamespace below); nothing preloads it in the background.
// Italian is always merged too, because t() falls back to Italian for a key a
// non-IT chunk lacks.
//
// Two shapes: the What's New release notes (`<locale>-whatsnew.ts`, explicit
// loaders below) and every key family split out of core afterwards, which is
// just a set of files `services/locales/<locale>-ns-<name>.ts` picked up by the
// glob — adding a namespace never touches this file, so one PR per family can
// land in parallel. The flat `<locale>-ns-<name>` basename is deliberate: the
// build keeps stable chunk names, and per-namespace directories of `it.ts`
// files would collide into counter-suffixed chunk names.
// tests/i18n-namespaces.test.ts keeps each family out of the core chunks.
export type TranslationNamespace = 'whatsnew' | (string & {});

type NamespaceModuleLoader = () => Promise<{ default: Translations }>;
// This module is imported both by the browser bundle and by Node-side Vite
// build plugins. Vite expands `import.meta.glob` in the browser graph, but the
// Node config bundle does not provide that transform. Keep the call itself so
// Vite can still expand it, and handle the untransformed Node import locally.
const splitNamespaceModules = (() => {
 try {
  return import.meta.glob<{ default: Translations }>('./locales/*-ns-*.ts');
 } catch (error) {
  if (error instanceof TypeError) return {};
  throw error;
 }
})();

const namespaceLoaders: Record<string, Partial<Record<Locale, NamespaceModuleLoader>>> = {
 whatsnew: {
 it: () => import('./locales/it-whatsnew'),
 en: () => import('./locales/en-whatsnew'),
 de: () => import('./locales/de-whatsnew'),
 fr: () => import('./locales/fr-whatsnew'),
 },
};
for (const [file, loader] of Object.entries(splitNamespaceModules)) {
 const match = /\/(it|en|de|fr)-ns-([a-z0-9-]+)\.ts$/.exec(file);
 if (!match) continue;
 const [, locale, namespace] = match;
 (namespaceLoaders[namespace] ??= {})[locale as Locale] = loader;
}
const loadedNamespaces = new Set<string>(); // "namespace:locale"
const namespacePromises = new Map<string, Promise<boolean>>();
const namespaceRetryDelayMs = 1_000;

function loadNamespaceLocale(namespace: TranslationNamespace, locale: Locale): Promise<boolean> {
 const key = `${namespace}:${locale}`;
 if (loadedNamespaces.has(key)) return Promise.resolve(true);
 const existing = namespacePromises.get(key);
 if (existing) return existing;
 const loader = namespaceLoaders[namespace]?.[locale];
 if (!loader) {
 if (locale === 'it') return Promise.resolve(false);
 // No file for this locale: t() falls back to the Italian strings.
 loadedNamespaces.add(key);
 return Promise.resolve(true);
 }
 const promise = loader()
 .then(m => {
 if (locale === 'it') mergeItTranslations(m.default);
 else mergeLocaleTranslations(locale, m.default);
 loadedNamespaces.add(key);
 return true;
 })
 .catch((err: unknown) => {
 swallowBackgroundLoadError(err);
 return false;
 })
 .finally(() => namespacePromises.delete(key));
 namespacePromises.set(key, promise);
 return promise;
}

/** Whether `namespace` is merged for the current locale (and its IT fallback). */
export function isNamespaceLoaded(namespace: TranslationNamespace): boolean {
 return loadedNamespaces.has(`${namespace}:it`)
 && (currentLocale === 'it' || loadedNamespaces.has(`${namespace}:${currentLocale}`));
}

/**
 * Load one on-demand namespace for the current locale plus the Italian
 * fallback. Never rejects: on a failed chunk the keys stay missing, t() keeps
 * returning its fallback, and the next call retries.
 */
export async function loadNamespaceTranslations(namespace: TranslationNamespace): Promise<boolean> {
 const locale = currentLocale;
 const alreadyLoaded = isNamespaceLoaded(namespace);
 const results = await Promise.all([
 loadNamespaceLocale(namespace, 'it'),
 locale !== 'it' ? loadNamespaceLocale(namespace, locale) : Promise.resolve(true),
 ]);
 const ok = results.every(Boolean);
 if (!alreadyLoaded && results.some(Boolean)) notifyTranslationsLoaded();
 return ok;
}

/**
 * React side of {@link loadNamespaceTranslations}: returns true once the
 * namespace is available for the rendered locale. `enabled=false` defers the
 * load (e.g. a modal that is closed).
 */
export function useTranslationNamespace(namespace: TranslationNamespace, enabled = true): boolean {
 const [locale] = useLocale();
 const [ready, setReady] = useState(() => isNamespaceLoaded(namespace));
 const [retryToken, setRetryToken] = useState(0);
 useEffect(() => {
 if (!enabled) return;
 if (isNamespaceLoaded(namespace)) {
 setReady(true);
 return;
 }
 setReady(false);
 let cancelled = false;
 let retryTimer: ReturnType<typeof setTimeout> | undefined;
 const scheduleRetry = () => {
  retryTimer = setTimeout(() => {
   if (!cancelled) setRetryToken(token => token + 1);
  }, namespaceRetryDelayMs);
 };
 loadNamespaceTranslations(namespace).then(() => {
 if (cancelled) return;
 const loaded = isNamespaceLoaded(namespace);
 setReady(loaded);
 if (!loaded) scheduleRetry();
 }).catch(() => {
 if (!cancelled) scheduleRetry();
 });
 return () => {
 cancelled = true;
 if (retryTimer) clearTimeout(retryTimer);
 };
 }, [namespace, enabled, locale, retryToken]);
 return ready;
}

/** Whether Italian core translations are loaded and t() returns real strings. */
export function isTranslationsReady(): boolean {
 return _itReady;
}

/** Eagerly load ALL chunks for a non-IT locale. Used by tests. */
export async function loadAllLocaleChunks(locale: Locale): Promise<void> {
 if (locale === 'it') { await itReady; return; }
 const chunks = localeChunkLoaders[locale];
 if (!chunks) return;
 const mods = await Promise.all(Object.entries(chunks).map(async ([page, loader]) => {
 const m = await loader();
 return { page, translations: m.default };
 }));
 for (const { page, translations } of mods) {
 mergeLocaleTranslations(locale, translations);
 loadedLocaleChunks[locale].add(page);
 }
}
