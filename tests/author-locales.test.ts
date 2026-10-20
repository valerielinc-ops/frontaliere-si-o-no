import { describe, expect, it } from 'vitest';
import { AUTHORS, isEditorialProfile, isRealAuthor } from '../data/authors';
import { EDITORIAL_PROFILE_DISCLOSURE, localizeAuthor } from '../data/authorLocales';
import { buildAuthorSeo } from '../services/seo/seo-authors';
import { resolveAuthorProfileMetadata } from '../services/seo/authorProfileMetadata';
import { renderAuthorEditorial, resolveAuthorStaticSeo } from '../build-plugins/shared/authorEditorial';

describe('author profile locale parity', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('keeps visible HTML and schema aligned: %s', (locale) => {
    for (const source of AUTHORS) {
      const author = localizeAuthor(source, locale);
      const seo = buildAuthorSeo(source, locale);
      const runtimeMetadata = resolveAuthorProfileMetadata(`autore-${source.slug}`, locale)!;
      const staticMetadata = resolveAuthorStaticSeo(new URL(seo.canonical).pathname, locale, '\n')!;
      const staticSchema = staticMetadata.sd.split('\n').map((part) => JSON.parse(part));
      const expectedType = isRealAuthor(source) ? 'Person' : 'Organization';
      const runtimeSchema = runtimeMetadata.structuredData.find((item) => item['@type'] === expectedType);
      const staticAuthorSchema = staticSchema.find((item) => item['@type'] === expectedType);

      expect(runtimeMetadata.title).toBe(staticMetadata.title);
      expect(runtimeMetadata.description).toBe(staticMetadata.desc);
      expect(runtimeSchema?.description).toBe(author.bio);
      expect(staticAuthorSchema?.description).toBe(author.bio);
      expect(staticAuthorSchema?.[isRealAuthor(source) ? 'jobTitle' : 'disambiguatingDescription']).toBe(
        isRealAuthor(source) ? author.role : EDITORIAL_PROFILE_DISCLOSURE[locale],
      );
      expect(seo.jsonLd.description).toBe(author.bio);
      expect(seo.canonical).toContain(locale === 'it' ? '/autori/' : `/${locale}/`);

      const blocks = renderAuthorEditorial(`/autori/${source.slug}/`, locale)!;
      expect(blocks).not.toBeNull();
      expect(blocks.join('')).toContain(author.bio.replaceAll('&', '&amp;').replaceAll("'", '&#39;'));

      if (isEditorialProfile(source)) {
        expect(seo.jsonLd['@type']).toBe('Organization');
        expect(staticAuthorSchema?.disambiguatingDescription).toBe(EDITORIAL_PROFILE_DISCLOSURE[locale]);
        expect(blocks.join('')).toContain(EDITORIAL_PROFILE_DISCLOSURE[locale]);
        expect(runtimeMetadata.structuredData.find((item) => item['@type'] === 'Person')).toBeUndefined();
      } else {
        expect(seo.jsonLd['@type']).toBe('Person');
        expect(seo.jsonLd.sameAs).toEqual([source.social.linkedin]);
        expect(staticAuthorSchema?.disambiguatingDescription).toBeUndefined();
        expect(blocks.join('')).not.toContain(EDITORIAL_PROFILE_DISCLOSURE[locale]);
        expect(blocks.join('')).toContain(source.social.linkedin!);
        expect(blocks.join('')).toContain(source.cvPath!);
        expect(blocks.join('')).not.toContain('profilo editoriale');
        expect(runtimeMetadata.structuredData.find(item => item['@type'] === 'ProfilePage')?.mainEntity).toEqual({
          '@id': `${seo.canonical}#person`,
        });
      }
    }
  });

  it('preserves independently edited public fields and identity kind', () => {
    const original = AUTHORS.find(isEditorialProfile)!;
    const patched = { ...original, bio: 'Descrizione aggiornata dalla redazione.', photoPath: '/images/custom.jpg' };
    const result = localizeAuthor(patched, 'de');
    expect(result.kind).toBe('editorial-profile');
    expect(result.bio).toBe(patched.bio);
    expect(result.photoPath).toBe(patched.photoPath);
    expect(result.role).not.toBe(original.role);
  });

  it('does not fabricate profiles for unknown authors', () => {
    expect(renderAuthorEditorial('/autori/unknown-person/', 'fr')).toBeNull();
  });
});
