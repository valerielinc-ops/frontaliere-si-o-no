/**
 * Browser origin of the corpus JSON API.
 *
 * Keep this as a leaf module: i18n and the runtime article resolver both need
 * the corpus origin, while the resolver itself imports i18n. Having the
 * fallback here avoids a cycle and keeps the site/corpus boundary HTTP-only.
 */

declare global {
  interface Window {
    /** Test/dev override for the published corpus origin. */
    __ARTICLES_API_BASE__?: string;
  }
}

export function articlesApiBase(): string {
  if (typeof window !== 'undefined') {
    const injected = window.__ARTICLES_API_BASE__;
    if (typeof injected === 'string' && injected) return injected.replace(/\/$/, '');
  }
  return 'https://nanakokyobashi-rgb.github.io/frontaliere-articles';
}
