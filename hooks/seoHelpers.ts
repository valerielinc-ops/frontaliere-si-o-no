/**
 * SEO helper functions shared across hooks.
 *
 * These were previously module-level in App.tsx. They are lazy-loaded
 * and gated behind `runtimeSeoEnabled` to avoid SEO updates during
 * Lighthouse's observation window.
 */
import { parsePath } from '@/services/router';
import { setLocale } from '@/services/i18n';
import { reportCaughtError } from '@/services/errorReporter';

let runtimeSeoEnabled = false;

/** Enable runtime SEO updates. Called on first user interaction or navigation. */
export const enableRuntimeSeo = () => { runtimeSeoEnabled = true; };

/** Check if runtime SEO is enabled. */
export const isRuntimeSeoEnabled = () => runtimeSeoEnabled;

/**
 * Update meta tags for a given SEO section key.
 * Lazy-loads seoService. For blog pages, ensures blog-meta translations
 * are loaded first.
 */
export const updateMetaTags = (section: string) => {
 if (!runtimeSeoEnabled) return;
 const { locale: pathLocale } = parsePath(window.location.pathname);
 setLocale(pathLocale);
 const runUpdate = () => import('@/services/seoService').then(m => m.updateMetaTags(section)).catch(err => reportCaughtError(err, 'seo.updateMetaTags'));
 if (section === 'blog' || section.startsWith('blog-')) {
 import('@/services/i18n')
 .then(m => m.loadBlogMeta())
 .catch(err => reportCaughtError(err, 'seo.loadBlogMeta'))
 .finally(runUpdate);
 return;
 }
 runUpdate();
};

/**
 * Track a section view for analytics purposes (lazy-loaded).
 */
export const trackSectionView = (section: string) => {
 if (!runtimeSeoEnabled) return;
 import('@/services/seoService').then(m => m.trackSectionView(section)).catch(err => reportCaughtError(err, 'seo.trackSectionView'));
};
