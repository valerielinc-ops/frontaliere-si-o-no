import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AUTHORS,
  getAuthorBySlug,
  getAuthorByUid,
  getAllAuthors,
  isEditorialProfile,
  isRealAuthor,
  pickAuthorForTopic,
} from '@/data/authors';
import { buildAuthorSeo } from '@/services/seo/seo-authors';

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

describe('authors registry (Google News A1)', () => {
  it('has editorial profiles and real authors as distinct kinds', () => {
    expect(AUTHORS.filter(isEditorialProfile).map((author) => author.slug)).toEqual([
      'marco-ferrari', 'laura-bianchi', 'redazione',
    ]);
    expect(AUTHORS.filter(isRealAuthor).map((author) => author.slug)).toEqual(['samuele-valente']);
  });

  it('every author has a unique kebab-case slug', () => {
    const slugs = AUTHORS.map((author) => author.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('every author has a photo file that exists in public/', () => {
    for (const author of AUTHORS) {
      expect(author.photoPath.startsWith('/images/authors/')).toBe(true);
      expect(fs.existsSync(path.join(PUBLIC_DIR, author.photoPath.replace(/^\//, '')))).toBe(true);
    }
  });

  it('real authors retain their public identity and CV fields', () => {
    const samuele = getAuthorBySlug('samuele-valente');
    expect(samuele && isRealAuthor(samuele)).toBe(true);
    if (!samuele || !isRealAuthor(samuele)) return;
    expect(samuele.uid).toBe('rAaDN0AvhkUjvRxN2TJijgYodm22');
    expect(samuele.cvPath).toBe('/documents/authors/samuele-valente-cv.pdf');
    expect(samuele.social.linkedin).toBe('https://www.linkedin.com/in/samuele-valente-9b8a4335b/');
    expect(fs.existsSync(path.join(PUBLIC_DIR, samuele.cvPath!.replace(/^\//, '')))).toBe(true);
    expect(getAuthorByUid(samuele.uid)).toBe(samuele);
  });

  it('editorial profiles have no personal identity fields and Redazione keeps its company link', () => {
    for (const author of AUTHORS.filter(isEditorialProfile)) {
      expect(Object.prototype.hasOwnProperty.call(author, 'uid')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(author, 'cvPath')).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(author, 'social')).toBe(false);
    }
    expect(getAuthorBySlug('marco-ferrari')?.linkedin).toBeUndefined();
    expect(getAuthorBySlug('laura-bianchi')?.linkedin).toBeUndefined();
    expect(getAuthorBySlug('redazione')?.linkedin).toBe('https://www.linkedin.com/company/frontaliere-ticino/');
  });

  it('every author has non-empty expertise and a non-trivial Italian description', () => {
    for (const author of AUTHORS) {
      expect(author.expertise.length).toBeGreaterThan(0);
      expect(author.bio.trim().split(/\s+/).length).toBeGreaterThanOrEqual(40);
    }
  });

  it('getAuthorBySlug and getAllAuthors expose the frozen registry', () => {
    expect(getAuthorBySlug('marco-ferrari')?.name).toBe('Marco Ferrari');
    expect(getAuthorBySlug('does-not-exist')).toBeUndefined();
    expect(getAllAuthors().length).toBe(AUTHORS.length);
  });

  it('pickAuthorForTopic preserves topical attribution for Samuele', () => {
    expect(pickAuthorForTopic(['730', 'imposta alla fonte']).slug).toBe('marco-ferrari');
    expect(pickAuthorForTopic(['AVS', 'LPP']).slug).toBe('laura-bianchi');
    expect(pickAuthorForTopic(['interpelli Agenzia delle Entrate']).slug).toBe('samuele-valente');
  });

  it('pickAuthorForTopic falls back to round-robin on no match', () => {
    const first = pickAuthorForTopic(['unrelated-topic-xyz']);
    const second = pickAuthorForTopic(['another-unrelated-topic']);
    expect(first.slug).not.toBe(second.slug);
  });
});

describe('buildAuthorSeo', () => {
  it('emits Organization JSON-LD only for editorial profiles', () => {
    for (const author of AUTHORS.filter(isEditorialProfile)) {
      const seo = buildAuthorSeo(author.slug, 'it');
      expect(seo.jsonLd['@type']).toBe('Organization');
      expect(seo.jsonLd['@id']).toBe(`${seo.canonical}#profile`);
      expect(seo.jsonLd.disambiguatingDescription).toBeTruthy();
      expect(seo.jsonLd.sameAs).toEqual(author.linkedin ? [author.linkedin] : undefined);
    }
  });

  it('emits Samuele as a Person with sameAs and worksFor', () => {
    const seo = buildAuthorSeo('samuele-valente', 'it');
    expect(seo.jsonLd['@type']).toBe('Person');
    expect(seo.jsonLd['@id']).toBe(`${seo.canonical}#person`);
    expect(seo.jsonLd.sameAs).toEqual(['https://www.linkedin.com/in/samuele-valente-9b8a4335b/']);
    expect((seo.jsonLd.worksFor as { '@id': string })['@id']).toBe('https://frontaliereticino.ch/#organization');
    expect(seo.jsonLd.disambiguatingDescription).toBeUndefined();
  });

  it('builds locale-prefixed canonicals for non-IT locales', () => {
    expect(buildAuthorSeo('marco-ferrari', 'en').canonical).toBe('https://frontaliereticino.ch/en/authors/marco-ferrari/');
    expect(buildAuthorSeo('marco-ferrari', 'de').canonical).toBe('https://frontaliereticino.ch/de/autoren/marco-ferrari/');
    expect(buildAuthorSeo('marco-ferrari', 'fr').canonical).toBe('https://frontaliereticino.ch/fr/auteurs/marco-ferrari/');
  });

  it('accepts a resolved author object and reflects patched public fields', () => {
    const staticAuthor = getAuthorBySlug('samuele-valente')!;
    const merged = { ...staticAuthor, name: 'Samuele Valente Patched' };
    expect(buildAuthorSeo(merged, 'it').jsonLd.name).toBe('Samuele Valente Patched');
  });

  it('throws on unknown slug', () => {
    expect(() => buildAuthorSeo('does-not-exist', 'it')).toThrow();
  });
});
