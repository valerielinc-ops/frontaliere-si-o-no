// `/autori/` answered 404 while its four profiles sat in the sitemap. The hub
// must exist in every locale and keep real people apart from editorial bylines.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AUTHORS, isEditorialProfile, isRealAuthor } from '../data/authors';
import { renderAuthorEditorial, resolveAuthorStaticSeo } from '../build-plugins/shared/authorEditorial';
import { AUTHOR_PAGE_COPY } from '../services/authorPageCopy';
import { buildPath, parsePath } from '../services/router';
import { buildAuthorsHubSeo } from '../services/seo/seo-authors';
import { resolveAuthorProfileMetadata } from '../services/seo/authorProfileMetadata';

const HUBS = { it: '/autori/', en: '/en/authors/', de: '/de/autoren/', fr: '/fr/auteurs/' } as const;
const LOCALES = Object.keys(HUBS) as Array<keyof typeof HUBS>;

describe('authors hub', () => {
  it.each(LOCALES)('%s resolves on the router, with a slash', (locale) => {
    expect(buildPath({ activeTab: 'autore' }, locale)).toBe(HUBS[locale]);
    const { route } = parsePath(HUBS[locale]);
    expect(route.activeTab).toBe('autore');
    expect(route.author).toBeUndefined();
  });

  it.each(LOCALES)('%s renders both lists from the registry, separately', (locale) => {
    const html = renderAuthorEditorial(HUBS[locale], locale)!.join('');
    const [people, signatures] = html.split(AUTHOR_PAGE_COPY[locale].hubSignatures);
    for (const author of AUTHORS.filter(isRealAuthor)) {
      expect(people).toContain(author.name);
      expect(signatures).not.toContain(author.name);
    }
    for (const author of AUTHORS.filter(isEditorialProfile)) expect(signatures).toContain(author.name);
  });

  it.each(LOCALES)('%s has its own metadata and only real authors are Person', (locale) => {
    const seo = buildAuthorsHubSeo(locale);
    expect(new URL(seo.canonical).pathname).toBe(HUBS[locale]);
    expect(resolveAuthorProfileMetadata('autore', locale)?.title).toBe(seo.title);
    expect(resolveAuthorStaticSeo(HUBS[locale], locale, '\n')?.title).toBe(seo.title);
    const items = (seo.jsonLd.mainEntity as { itemListElement: Array<{ item: { '@type': string; name: string } }> }).itemListElement;
    expect(items).toHaveLength(AUTHORS.length);
    expect(items.filter(({ item }) => item['@type'] === 'Person').map(({ item }) => item.name))
      .toEqual(AUTHORS.filter(isRealAuthor).map((author) => author.name));
  });

  it('is in the sitemap with all its alternates', () => {
    const sitemap = readFileSync(resolve(__dirname, '../public/sitemap-pages.xml'), 'utf8');
    expect(sitemap).toContain('<loc>https://frontaliereticino.ch/autori/</loc>');
    for (const locale of LOCALES) {
      expect(sitemap).toContain(`hreflang="${locale}" href="https://frontaliereticino.ch${HUBS[locale]}"`);
    }
  });

  it('an author page links the hub', () => {
    expect(renderAuthorEditorial('/autori/marco-ferrari/', 'it')!.join('')).toContain('href="/autori/"');
  });
});
