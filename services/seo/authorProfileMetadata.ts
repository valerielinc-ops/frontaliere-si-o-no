import { AUTHORS, getAuthorBySlug } from '../../data/authors';
import { localizeAuthor, type AuthorLocale } from '../../data/authorLocales';
import { buildAuthorSeo, buildAuthorsHubSeo } from './seo-authors';

const AUTHORS_HUB_PATH_RE = /^\/(?:autori|en\/authors|de\/autoren|fr\/auteurs)\/?$/;

/** Metadata of the `/autori/` hub; `autore` is the section key of the route without a slug. */
function resolveAuthorsHubMetadata(locale: AuthorLocale) {
  const seo = buildAuthorsHubSeo(locale);
  return {
    title: seo.title, description: seo.description, keywords: AUTHORS.map(author => author.name).join(', '),
    ogTitle: seo.title, ogDescription: seo.description, ogImage: seo.ogImage,
    canonicalPath: new URL(seo.canonical).pathname,
    structuredData: [seo.jsonLd],
  };
}

/** Shared override for both metadata consumers; author literals are never localized as generic sections. */
export function resolveAuthorProfileMetadata(sectionOrPath: string, locale: AuthorLocale) {
  if (sectionOrPath === 'autore' || AUTHORS_HUB_PATH_RE.test(sectionOrPath)) return resolveAuthorsHubMetadata(locale);
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
        inLanguage: locale, mainEntity: { '@id': String(seo.jsonLd['@id']) } },
      seo.jsonLd,
    ],
  };
}

/**
 * Page-table entries (`autore-{slug}`) for every registered author, derived from
 * the registry. `services/seo/seo-pages.ts` spreads these instead of carrying
 * hand-written copies, which kept the superseded expertise text after the
 * registry itself was corrected (PR 11327).
 */
export function authorSeoPageEntries(locale: AuthorLocale = 'it') {
  return {
    autore: resolveAuthorProfileMetadata('autore', locale)!,
    ...Object.fromEntries(AUTHORS.map(author =>
      [`autore-${author.slug}`, resolveAuthorProfileMetadata(`autore-${author.slug}`, locale)!])),
  };
}
