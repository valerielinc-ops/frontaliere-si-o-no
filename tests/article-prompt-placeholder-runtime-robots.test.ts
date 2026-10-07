// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildPath, preloadBlogData, type AppRoute } from '../services/router';
import { loadAllLocaleChunks, loadBlogMeta, mergeArticleMetaOverlay, setLocale, type Locale } from '../services/i18n';

const { updateMetaTags } = await vi.importActual<typeof import('../services/seoService')>('../services/seoService');

const PLACEHOLDER_ARTICLE = 'como-fai-giornate-autunno';
const BODY4_PLACEHOLDER_ARTICLE = 'runtime-body4-placeholder-test';

beforeEach(() => {
 document.head.innerHTML = '<title>Previous page</title><meta name="robots" content="index, follow">';
 document.documentElement.lang = 'it';
 window.history.replaceState({}, '', '/');
});

async function updateArticleRobots(locale: Locale): Promise<string> {
 await preloadBlogData();
 await loadAllLocaleChunks(locale);
 setLocale(locale);
 await loadBlogMeta('frontaliere');
 const route: AppRoute = {
 activeTab: 'blog',
 blogArticle: PLACEHOLDER_ARTICLE,
 };
 window.history.replaceState({}, '', buildPath(route, locale));
 await updateMetaTags(`blog-${PLACEHOLDER_ARTICLE}`);
 return document.querySelector('meta[name="robots"]')?.getAttribute('content') || '';
}

describe('article prompt-placeholder robots protection after SEO hydration', () => {
 it.each(['en', 'de', 'fr'] as const)('keeps the placeholder article noindex in %s', async (locale) => {
 expect(await updateArticleRobots(locale)).toBe('noindex, follow');
 });

 it('keeps a healthy Italian article indexable', async () => {
 await loadAllLocaleChunks('it');
 setLocale('it');
 await loadBlogMeta('frontaliere');
 const route: AppRoute = { activeTab: 'blog', blogArticle: 'como-fai-giornate-autunno' };
 window.history.replaceState({}, '', buildPath(route, 'it'));
 await updateMetaTags(`blog-${PLACEHOLDER_ARTICLE}`);

 const robots = document.querySelector('meta[name="robots"]')?.getAttribute('content') || '';
 expect(robots).toContain('index');
 expect(robots).not.toContain('noindex');
 });

 it('keeps an article with a body4 placeholder noindex', async () => {
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
});
