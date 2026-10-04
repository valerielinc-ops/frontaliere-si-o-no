import { describe, expect, it } from 'vitest';
import { AUTHORS } from '../data/authors';
import { localizeAuthor } from '../data/authorLocales';
import { buildAuthorSeo } from '../services/seo/seo-authors';
import { resolveAuthorProfileMetadata } from '../services/seo/authorProfileMetadata';
import { renderAuthorEditorial, resolveAuthorStaticSeo } from '../build-plugins/shared/authorEditorial';

describe('author profile locale parity', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('uses the same registered biography in visible HTML and schema: %s', locale => {
    for (const source of AUTHORS) {
      const author = localizeAuthor(source, locale);
      const seo = buildAuthorSeo(source, locale);
      const runtimeMetadata = resolveAuthorProfileMetadata(`autore-${source.slug}`, locale)!;
      const staticMetadata = resolveAuthorStaticSeo(new URL(seo.canonical).pathname, locale, '\n')!;
      const staticPerson = staticMetadata.sd.split('\n').map(part => JSON.parse(part)).find(item => item['@type'] === 'Person');
      expect(runtimeMetadata.title).toBe(staticMetadata.title);
      expect(runtimeMetadata.description).toBe(staticMetadata.desc);
      expect(runtimeMetadata.structuredData.find(item => item['@type'] === 'Person')?.description).toBe(author.bio);
      expect(staticPerson.description).toBe(author.bio);
      expect(staticPerson.jobTitle).toBe(author.role);
      expect(staticPerson.knowsAbout).toEqual(author.expertise);
      const blocks = renderAuthorEditorial(`/autori/${source.slug}/`, locale)!;
      expect(blocks).not.toBeNull();
      expect(seo.jsonLd.description).toBe(author.bio);
      expect(seo.jsonLd.jobTitle).toBe(author.role);
      expect(blocks.join('')).toContain(author.bio.replaceAll('&', '&amp;').replaceAll("'", '&#39;'));
      expect(seo.canonical).toContain(locale === 'it' ? '/autori/' : `/${locale}/`);
      expect(author.name).toBe(source.name);
      expect(author.social).toBe(source.social);
      expect(author.email).toBe(source.email);
      expect(author.uid).toBe(source.uid);
      if (locale !== 'it') {
        expect(author.bio).not.toBe(source.bio);
        expect(blocks.join('')).not.toContain('Aree di competenza');
        expect(blocks.join('')).not.toContain('href="/autori/');
      }
    }
  });
  it('preserves independently edited admin fields and still localizes unchanged fields', () => {
    const original = AUTHORS[0];
    const patched = { ...original, bio: 'Biografia aggiornata dalla redazione.', photoPath: '/images/custom.jpg', social: { linkedin: 'https://example.test/profile' } };
    const result = localizeAuthor(patched, 'de');
    expect(result.bio).toBe(patched.bio);
    expect(result.photoPath).toBe(patched.photoPath);
    expect(result.social).toBe(patched.social);
    expect(result.role).not.toBe(original.role);
    expect(buildAuthorSeo(patched, 'de').jsonLd.description).toBe(patched.bio);
  });
  it('does not fabricate profiles for unknown authors', () => {
    expect(renderAuthorEditorial('/autori/unknown-person/', 'fr')).toBeNull();
  });
});
