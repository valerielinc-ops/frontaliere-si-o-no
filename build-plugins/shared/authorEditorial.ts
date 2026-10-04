import { inlineScriptJson } from './inlineJsonScript';
import { resolveAuthorProfileMetadata } from '../../services/seo/authorProfileMetadata';
import { AUTHORS, getAuthorBySlug } from '../../data/authors';
import { localizeAuthor, type AuthorLocale } from '../../data/authorLocales';
import { AUTHOR_PAGE_COPY } from '../../services/authorPageCopy';
import { buildAuthorSeo } from '../../services/seo/seo-authors';
import { buildPath } from '../../services/router';

const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Registered author pages bypass the generic translated section fallback. */
export function renderAuthorEditorial(sourcePath: string, locale: AuthorLocale): string[] | null {
  const match = /^\/(?:autori|(?:en\/authors|de\/autoren|fr\/auteurs))\/([^/]+)\/?$/.exec(sourcePath);
  if (!match) return null;
  const original = getAuthorBySlug(match[1]);
  if (!original) return null;
  const author = localizeAuthor(original, locale);
  const copy = AUTHOR_PAGE_COPY[locale];
  const peers = AUTHORS.filter(peer => peer.slug !== author.slug).map(peer => {
    const translated = localizeAuthor(peer, locale);
    return `<li><a href="${escape(buildAuthorSeo(peer, locale).canonical)}" rel="author">${escape(peer.name)}</a> — ${escape(translated.role)}</li>`;
  }).join('');
  const social = author.social.linkedin ? `<a href="${escape(author.social.linkedin)}" rel="noopener me" target="_blank">LinkedIn</a>` : '';
  return [
    `<h2>${escape(author.name)} — ${escape(author.role)}</h2>`,
    `<p>${escape(author.bio)}</p>`,
    `<h2>${escape(copy.expertise)}</h2><ul>${author.expertise.map(topic => `<li>${escape(topic)}</li>`).join('')}</ul>`,
    `<h2>${escape(copy.publicProfile)}</h2><p>${social}${author.email ? ` <a href="mailto:${escape(author.email)}">${escape(author.email)}</a>` : ''}</p>`,
    `<h2>${escape(copy.otherAuthors)}</h2><ul>${peers}</ul>`,
    `<p><a href="${buildPath({ activeTab: 'chi-siamo' }, locale)}">${escape(copy.about)}</a> · <a href="${buildPath({ activeTab: 'correzioni' }, locale)}">${escape(copy.corrections)}</a></p>`,
  ];
}

/**
 * Static roster of every registered author (the /chi-siamo/ "firme" list):
 * name, role and expertise come from the registry, never from a hand-copied
 * list that misses new authors and keeps text the registry has corrected.
 */
export function renderAuthorRosterItems(locale: AuthorLocale, itemClass: string, linkClass: string): string {
  return AUTHORS.map(source => {
    const author = localizeAuthor(source, locale);
    const href = new URL(buildAuthorSeo(source, locale).canonical).pathname;
    return `<li class="${itemClass}"><a class="${linkClass}" href="${escape(href)}" rel="author">${escape(author.name)}</a> — ${escape(author.role)} (${escape(author.expertise.join(', '))}).</li>`;
  }).join('');
}

export function resolveAuthorStaticSeo(path: string, locale: AuthorLocale, scriptSeparator: string) {
  const metadata = resolveAuthorProfileMetadata(path, locale);
  return metadata ? { title: metadata.title, desc: metadata.description, ogT: metadata.ogTitle,
    ogD: metadata.ogDescription, sd: metadata.structuredData.map(entry => inlineScriptJson(entry)).join(scriptSeparator) } : null;
}
