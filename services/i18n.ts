/**
 * Internationalization Service (i18n)
 * Supports: IT (default), EN, DE, FR
 * Italian translations are inline; other locales load on demand.
 */

export type Locale = 'it' | 'en' | 'de' | 'fr';

type TranslationKey = string;
type Translations = Record<TranslationKey, string>;

// ─── Current Locale ──────────────────────────────────────────

let currentLocale: Locale = 'it';
const listeners: Array<(locale: Locale) => void> = [];

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
    core:        () => import('./locales/en-core'),
    calculator:  () => import('./locales/en-calculator'),
    comparatori: () => import('./locales/en-comparatori'),
    fisco:       () => import('./locales/en-fisco'),
    guide:       () => import('./locales/en-guide'),
    vita:        () => import('./locales/en-vita'),
    stats:       () => import('./locales/en-stats'),
  },
  de: {
    core:        () => import('./locales/de-core'),
    calculator:  () => import('./locales/de-calculator'),
    comparatori: () => import('./locales/de-comparatori'),
    fisco:       () => import('./locales/de-fisco'),
    guide:       () => import('./locales/de-guide'),
    vita:        () => import('./locales/de-vita'),
    stats:       () => import('./locales/de-stats'),
  },
  fr: {
    core:        () => import('./locales/fr-core'),
    calculator:  () => import('./locales/fr-calculator'),
    comparatori: () => import('./locales/fr-comparatori'),
    fisco:       () => import('./locales/fr-fisco'),
    guide:       () => import('./locales/fr-guide'),
    vita:        () => import('./locales/fr-vita'),
    stats:       () => import('./locales/fr-stats'),
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

// Background preloads can be interrupted during test worker teardown.
// We intentionally swallow those rejections to avoid unhandled promise noise.
function swallowBackgroundLoadError(_err: unknown): void {
  // no-op by design
}

// ─── Blog Translations (2-tier: meta + per-article body) ─────

// Tier 1: Blog meta (titles, excerpts, imageAlt)
const blogMetaLoaders: Record<Locale, () => Promise<{ default: Translations }>> = {
  it: () => import('./locales/blog-meta-it'),
  en: () => import('./locales/blog-meta-en'),
  de: () => import('./locales/blog-meta-de'),
  fr: () => import('./locales/blog-meta-fr'),
};

let blogMetaLoaded = false;
let blogMetaLoadingPromise: Promise<void> | null = null;

// Tier 2: Per-article body (body1, body2, body3) — loaded on demand
const loadedArticleBodies = new Set<string>(); // "locale:articleId"
const articleBodyPromises = new Map<string, Promise<void>>();

/**
 * Lazily loads blog META translations (titles, excerpts) for the current locale + IT fallback.
 * This is ~85% smaller than the old monolithic blog load.
 * Safe to call multiple times — subsequent calls are no-ops.
 */
export async function loadBlogMeta(): Promise<void> {
  if (blogMetaLoaded) return;
  if (blogMetaLoadingPromise) {
    await blogMetaLoadingPromise;
    return;
  }
  blogMetaLoadingPromise = (async () => {
    const itMeta = await blogMetaLoaders.it();
    loadedLocales['it'] = { ...loadedLocales['it'], ...itMeta.default };

    if (currentLocale !== 'it') {
      const localeMeta = await blogMetaLoaders[currentLocale]();
      loadedLocales[currentLocale] = { ...loadedLocales[currentLocale], ...localeMeta.default };
    }
    blogMetaLoaded = true;
    localeTick++;
    listeners.forEach(fn => fn(currentLocale));
  })();
  await blogMetaLoadingPromise;
}

/**
 * Lazily loads BODY translations (body1, body2, body3) for a single article.
 * Called when the user opens a specific article. ~3-7 KB per article.
 */
export async function loadArticleBody(articleId: string): Promise<void> {
  const locale = currentLocale;
  const key = `${locale}:${articleId}`;
  const itKey = `it:${articleId}`;

  // Load IT fallback body if not loaded
  if (!loadedArticleBodies.has(itKey) && !articleBodyPromises.has(itKey)) {
    articleBodyPromises.set(itKey, (async () => {
      try {
        const mod = await import(`./locales/blog-body/it/${articleId}.ts`);
        mergeLocaleTranslations('it', mod.default);
        loadedArticleBodies.add(itKey);
      } catch { /* article body file may not exist yet */ }
    })());
  }

  // Load current locale body if not IT and not loaded
  if (locale !== 'it' && !loadedArticleBodies.has(key) && !articleBodyPromises.has(key)) {
    articleBodyPromises.set(key, (async () => {
      try {
        const mod = await import(`./locales/blog-body/${locale}/${articleId}.ts`);
        mergeLocaleTranslations(locale, mod.default);
        loadedArticleBodies.add(key);
      } catch { /* fallback to IT */ }
    })());
  }

  await Promise.all([
    articleBodyPromises.get(itKey),
    locale !== 'it' ? articleBodyPromises.get(key) : undefined,
  ]);

  localeTick++;
  listeners.forEach(fn => fn(currentLocale));
}

/** @deprecated Use loadBlogMeta() + loadArticleBody(id) instead */
export async function loadBlogTranslations(): Promise<void> {
  await loadBlogMeta();
}

export async function ensureLocaleLoaded(locale: Locale): Promise<void> {
  if (locale === 'it') {
    // IT translations are loaded eagerly via itReady; wait for them
    await itReady;
    if (blogMetaLoaded && !loadedLocales['it']?.['blog.article.stipendio-netto-2026.title']) {
      const itMeta = await blogMetaLoaders['it']();
      loadedLocales['it'] = { ...loadedLocales['it'], ...itMeta.default };
    }
    return;
  }

  // Per-chunk loading for EN/DE/FR (same split as Italian)
  const chunks = localeChunkLoaders[locale];
  if (!chunks) return;

  // If core+calculator already loaded, just wait for any in-flight loading
  if (loadedLocaleChunks[locale].has('core')) {
    if (blogMetaLoaded && !loadedLocales[locale]?.['blog.article.stipendio-netto-2026.title']) {
      const localeMeta = await blogMetaLoaders[locale]();
      mergeLocaleTranslations(locale, localeMeta.default);
    }
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
      localeTick++;
      listeners.forEach(fn => fn(currentLocale));
    }
    const [core, calc] = await Promise.all([chunks.core(), chunks.calculator()]);
    mergeLocaleTranslations(locale, core.default);
    mergeLocaleTranslations(locale, calc.default);
    loadedLocaleChunks[locale].add('core');
    loadedLocaleChunks[locale].add('calculator');

    // If blog meta was already loaded, merge meta keys for this locale too
    if (blogMetaLoaded) {
      const localeMeta = await blogMetaLoaders[locale]();
      mergeLocaleTranslations(locale, localeMeta.default);
    }

    // Background-load remaining page chunks
    const loadRemaining = () => {
      for (const [page, loader] of Object.entries(chunks)) {
        if (page === 'core' || page === 'calculator') continue;
        if (loadedLocaleChunks[locale].has(page)) continue;
        loader()
          .then(m => {
            mergeLocaleTranslations(locale, m.default);
            loadedLocaleChunks[locale].add(page);
            localeTick++;
            listeners.forEach(fn => fn(currentLocale));
          })
          .catch(swallowBackgroundLoadError);
      }
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
        localeTick++;
        listeners.forEach(fn => fn(locale));
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

export function t(key: string, params?: Record<string, string | number>): string {
  let translation: string | undefined;
  if (currentLocale === 'it') {
    // Check inline IT translations first, then loadedLocales (lazy blog keys)
    translation = itTranslations[key] || loadedLocales['it']?.[key];
  } else {
    translation = loadedLocales[currentLocale]?.[key] || itTranslations[key] || loadedLocales['it']?.[key];
  }
  if (!translation) translation = key;
  if (!params) return translation;
  return Object.entries(params).reduce(
    (str, [k, v]) => str.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v)),
    translation
  );
}

// ─── React Hook ──────────────────────────────────────────────

import { useState, useEffect } from 'react';

export function useLocale(): [Locale, (l: Locale) => void] {
  const [, setTick] = useState(0);
  const [locale, setL] = useState<Locale>(currentLocale);
  useEffect(() => {
    // Listen for locale changes — always bump tick to guarantee re-render
    // even when the locale string is the same (async load completed)
    return onLocaleChange((l) => {
      setL(l);
      setTick(getLocaleTick());
    });
  }, []);
  return [locale, setLocale];
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

/** Promise that resolves once core + calculator IT translations are loaded. */
export const itReady: Promise<void> = Promise.all([
  import('./locales/it-core'),
  import('./locales/it-calculator'),
]).then(([core, calc]) => {
  mergeItTranslations(core.default);
  mergeItTranslations(calc.default);
  _itReady = true;
  // Background-load remaining page chunks after first render
  const loadRemaining = () => {
    for (const [page, loader] of Object.entries(itPageLoaders)) {
      if (!loadedItPages.has(page)) {
        loader()
          .then(m => {
            mergeItTranslations(m.default);
            loadedItPages.add(page);
            localeTick++;
            listeners.forEach(fn => fn(currentLocale));
          })
          .catch(swallowBackgroundLoadError);
      }
    }
  };
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(loadRemaining);
  } else {
    setTimeout(loadRemaining, 100);
  }
});

/** Load translations for a specific tab — no-op if already loaded. */
export async function loadTabTranslations(tab: string): Promise<void> {
  if (loadedItPages.has(tab)) return;
  const loader = itPageLoaders[tab];
  if (!loader) return;
  const m = await loader();
  mergeItTranslations(m.default);
  loadedItPages.add(tab);
  localeTick++;
  listeners.forEach(fn => fn(currentLocale));
}

/** Load ALL translation chunks (IT + current locale). Used by site search. */
export async function loadAllTranslations(): Promise<void> {
  await itReady;
  const promises: Promise<void>[] = [];
  for (const [page, loader] of Object.entries(itPageLoaders)) {
    if (!loadedItPages.has(page)) {
      promises.push(loader().then(m => {
        mergeItTranslations(m.default);
        loadedItPages.add(page);
      }));
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
          }));
        }
      }
    }
  }
  if (promises.length > 0) {
    await Promise.all(promises);
    localeTick++;
    listeners.forEach(fn => fn(currentLocale));
  }
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
