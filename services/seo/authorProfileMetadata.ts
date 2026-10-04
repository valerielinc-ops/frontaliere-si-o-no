import { getAuthorBySlug } from '../../data/authors';
import { localizeAuthor, type AuthorLocale } from '../../data/authorLocales';
import { buildAuthorSeo } from './seo-authors';

/** Shared override for both metadata consumers; author literals are never localized as generic sections. */
export function resolveAuthorProfileMetadata(sectionOrPath: string, locale: AuthorLocale) {
  const slug = sectionOrPath.startsWith('autore-') ? sectionOrPath.slice(7)
    : /^\/(?:autori|(?:en\/authors|de\/autoren|fr\/auteurs))\/([^/]+)\/?$/.exec(sectionOrPath)?.[1];
  const original = slug ? getAuthorBySlug(slug) : undefined;
  if (!original) return null;
  const author = localizeAuthor(original, locale);
  const seo = buildAuthorSeo(original, locale);
  return {
    title: seo.title, description: seo.description, keywords: [author.name, ...author.expertise].join(', '),
    ogTitle: seo.title, ogDescription: seo.description, ogImage: seo.ogImage,
    canonicalPath: new URL(seo.canonical).pathname,
    structuredData: [
      { '@context': 'https://schema.org', '@type': 'ProfilePage', name: seo.title, url: seo.canonical,
        inLanguage: locale, mainEntity: { '@id': `${seo.canonical}#person` } },
      seo.jsonLd,
    ],
  };
}
