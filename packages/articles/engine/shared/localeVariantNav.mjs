const LOCALE_CODES = ['it', 'en', 'de', 'fr'];

const LOCALE_LABELS = {
  it: 'Italiano',
  en: 'English',
  de: 'Deutsch',
  fr: 'Français',
};

const LOCALE_ARIA_LABELS = {
  it: 'Versioni linguistiche',
  en: 'Language versions',
  de: 'Sprachversionen',
  fr: 'Versions linguistiques',
};

function withTrailingSlash(path) {
  if (!path) return path;
  return path.endsWith('/') ? path : `${path}/`;
}

/**
 * Render the body counterpart of an article page's head-only hreflang group.
 * The article engine cannot import the site's build-plugin shell, so this
 * small helper keeps the crawlable navigation at the package boundary while
 * using the same four-locale contract as the host.
 */
export function renderArticleLocaleVariantNavHtml({ baseUrl, paths, currentLocale }) {
  const entries = LOCALE_CODES
    .filter((locale) => typeof paths?.[locale] === 'string' && paths[locale].length > 0)
    .map((locale) => {
      const rawPath = paths[locale];
      const href = /^https?:\/\//i.test(rawPath)
        ? withTrailingSlash(rawPath)
        : `${baseUrl}${withTrailingSlash(rawPath)}`;
      return `<a href="${href}">${LOCALE_LABELS[locale]}</a>`;
    });
  if (entries.length < 2) return '';
  const aria = LOCALE_ARIA_LABELS[currentLocale] ?? LOCALE_ARIA_LABELS.it;
  return `<nav class="seo-locale-variants" aria-label="${aria}">${entries.join(' · ')}</nav>`;
}
