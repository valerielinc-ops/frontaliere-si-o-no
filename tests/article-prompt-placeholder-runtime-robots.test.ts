// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildPath, preloadBlogData, type AppRoute } from '../services/router';
import { loadAllLocaleChunks, loadBlogMeta, mergeArticleMetaOverlay, setLocale, type Locale } from '../services/i18n';
import miazzinaFrenchBody from './fixtures/miazzina-french-body';
import { stashStaticArticleFallback, __resetStaticArticleFallback } from '../services/staticArticleFallback';
import { t } from '../services/i18n';
import { resetArticleBodyApiForTests } from '../services/articleBodyApi';

const { updateMetaTags } = await vi.importActual<typeof import('../services/seoService')>('../services/seoService');

const PLACEHOLDER_ARTICLE = 'runtime-localized-placeholder-robots';
const HEALTHY_ARTICLE = 'como-fai-giornate-autunno';
const BODY4_PLACEHOLDER_ARTICLE = 'runtime-body4-placeholder-test';

beforeEach(() => {
 __resetStaticArticleFallback();
 resetArticleBodyApiForTests();
 document.body.innerHTML = '';
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => '' }));
 document.head.innerHTML = '<title>Previous page</title><meta name="robots" content="index, follow">';
 document.documentElement.lang = 'it';
 window.history.replaceState({}, '', '/');
});
afterEach(() => { vi.unstubAllGlobals(); });

function useLegacyArticleBodyApi(): void {
 resetArticleBodyApiForTests();
 vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
  if (String(input).endsWith('/manifest.json')) {
   return { ok: true, status: 200, text: async () => JSON.stringify({ commit: 'legacy-test' }) };
  }
  return { ok: false, status: 404, text: async () => '' };
 }));
}

async function updateArticleRobots(locale: Locale): Promise<string> {
 useLegacyArticleBodyApi();
 await preloadBlogData();
 await loadAllLocaleChunks(locale);
 setLocale(locale);
 await loadBlogMeta('frontaliere');
 const placeholderKey = `blog.article.${PLACEHOLDER_ARTICLE}.`;
 mergeArticleMetaOverlay(locale, {
  [`${placeholderKey}title`]: 'Localized placeholder test article',
  [`${placeholderKey}excerpt`]: 'Stable fixture for placeholder robots coverage.',
  [`${placeholderKey}imageAlt`]: 'Placeholder test fixture',
  [`${placeholderKey}body1`]: '...',
 });
 const route: AppRoute = {
 activeTab: 'blog',
 blogArticle: PLACEHOLDER_ARTICLE,
 };
 window.history.replaceState({}, '', buildPath(route, locale));
 await updateMetaTags(`blog-${PLACEHOLDER_ARTICLE}`);
 return document.querySelector('meta[name="robots"]')?.getAttribute('content') || '';
}

describe('article prompt-placeholder robots protection after SEO hydration', () => {
 it.each(['missing', 'ellipsis', 'missing-first'] as const)('preserves static noindex when recovery fails for a %s body', async (shape) => {
 await preloadBlogData();
 await loadAllLocaleChunks('it');
 setLocale('it');
 const id = `runtime-failed-recovery-${shape}`;
 if (shape === 'ellipsis') mergeArticleMetaOverlay('it', { [`blog.article.${id}.body1`]: '...' });
 if (shape === 'missing-first') mergeArticleMetaOverlay('it', { [`blog.article.${id}.body3`]: 'Terzo paragrafo senza primo corpo.' });
 const route: AppRoute = { activeTab: 'blog', blogArticle: id as AppRoute['blogArticle'] };
 window.history.replaceState({}, '', buildPath(route, 'it'));
 document.head.innerHTML = '<title>Quarantined article</title><meta name="robots" content="noindex,follow">';
 await updateMetaTags(`blog-${id}`);
 expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex, follow');
 });

 it('awaits the published body repair before deciding robots, even without the article component', async () => {
 useLegacyArticleBodyApi();
 await preloadBlogData();
 await loadAllLocaleChunks('it');
 setLocale('it');
 const id = 'runtime-seo-repaired-placeholder';
 mergeArticleMetaOverlay('it', {
 [`blog.article.${id}.body1`]: '...',
 [`blog.article.${id}.body2`]: 'Secondo testo valido.',
 });
 const route: AppRoute = { activeTab: 'blog', blogArticle: id as AppRoute['blogArticle'] };
 const path = buildPath(route, 'it');
 window.history.replaceState({}, '', path);
 document.body.innerHTML = '<main class="seo-static-content"><article class="ft-blog-article"><section><p>Primo testo riparato.</p></section><section><p>Secondo testo valido.</p></section></article></main>';
 stashStaticArticleFallback(document.querySelector('main')!, path);
 document.body.innerHTML = '<div id="root"></div>';
 await updateMetaTags(`blog-${id}`);
 expect(t(`blog.article.${id}.body1`)).toBe('Primo testo riparato.');
 expect(t(`blog.article.${id}.body2`)).toBe('Secondo testo valido.');
 expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).not.toContain('noindex');
 });

 it('does not recover unverified static HTML after the body API fails', async () => {
 await preloadBlogData();
 await loadAllLocaleChunks('it');
 setLocale('it');
 await loadBlogMeta('frontaliere');
 const id = 'runtime-api-failure-does-not-recover-html';
 mergeArticleMetaOverlay('it', {
  [`blog.article.${id}.title`]: 'API failure fixture',
  [`blog.article.${id}.excerpt`]: 'API failure fixture for stale HTML recovery.',
 });
 const route: AppRoute = { activeTab: 'blog', blogArticle: id as AppRoute['blogArticle'] };
 const path = buildPath(route, 'it');
 window.history.replaceState({}, '', path);
 document.body.innerHTML = '<main class="seo-static-content"><article class="ft-blog-article"><section><p>Unverified old HTML body.</p></section></article></main>';
 stashStaticArticleFallback(document.querySelector('main')!, path);
 document.body.innerHTML = '<div id="root"></div>';
 vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' }));

 await updateMetaTags(`blog-${id}`);

 expect(t(`blog.article.${id}.body1`)).toBe(`blog.article.${id}.body1`);
 expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex, follow');
 });

 it.each(['en', 'de', 'fr'] as const)('keeps a localized placeholder noindex in %s', async (locale) => {
 expect(await updateArticleRobots(locale)).toBe('noindex, follow');
 });

 it('keeps a healthy Italian article indexable', async () => {
 useLegacyArticleBodyApi();
 await loadAllLocaleChunks('it');
 setLocale('it');
 await loadBlogMeta('frontaliere');
 const route: AppRoute = { activeTab: 'blog', blogArticle: HEALTHY_ARTICLE };
 window.history.replaceState({}, '', buildPath(route, 'it'));
 await updateMetaTags(`blog-${HEALTHY_ARTICLE}`);

 const robots = document.querySelector('meta[name="robots"]')?.getAttribute('content') || '';
 expect(robots).toContain('index');
 expect(robots).not.toContain('noindex');
 });

 it('keeps an article with a body4 placeholder noindex', async () => {
 useLegacyArticleBodyApi();
 await loadAllLocaleChunks('en');
 setLocale('en');
 await loadBlogMeta('frontaliere');
 mergeArticleMetaOverlay('en', {
 [`blog.article.${BODY4_PLACEHOLDER_ARTICLE}.body1`]: 'Healthy body one.',
 [`blog.article.${BODY4_PLACEHOLDER_ARTICLE}.body2`]: 'Healthy body two.',
 [`blog.article.${BODY4_PLACEHOLDER_ARTICLE}.body3`]: 'Healthy body three.',
 [`blog.article.${BODY4_PLACEHOLDER_ARTICLE}.body4`]: '...',
 });
 const route: AppRoute = {
 activeTab: 'blog',
 blogArticle: BODY4_PLACEHOLDER_ARTICLE as AppRoute['blogArticle'],
 };
 window.history.replaceState({}, '', buildPath(route, 'en'));
 await updateMetaTags(`blog-${BODY4_PLACEHOLDER_ARTICLE}`);

 expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex, follow');
 });

 it('keeps the corrected Miazzina French article indexable after SEO hydration', async () => {
 useLegacyArticleBodyApi();
 await preloadBlogData();
 await loadAllLocaleChunks('fr');
 setLocale('fr');
 await loadBlogMeta('frontaliere');
 mergeArticleMetaOverlay('fr', miazzinaFrenchBody);
 const route: AppRoute = {
 activeTab: 'blog',
 blogArticle: 'miazzina-pendolare-fisco-ticino' as AppRoute['blogArticle'],
 };
 window.history.replaceState({}, '', buildPath(route, 'fr'));
 await updateMetaTags('blog-miazzina-pendolare-fisco-ticino');

 const robots = document.querySelector('meta[name="robots"]')?.getAttribute('content') || '';
 expect(robots).toContain('index');
 expect(robots).not.toContain('noindex');
 });
});
