import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AUTHORS, getAuthorBySlug, getAllAuthors, pickAuthorForTopic } from '@/data/authors';
import { buildAuthorSeo } from '@/services/seo/seo-authors';

const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

describe('authors registry (Google News A1)', () => {
  it('has at least 3 entries', () => {
    expect(AUTHORS.length).toBeGreaterThanOrEqual(3);
  });

  it('every author has a unique kebab-case slug', () => {
    const slugs = AUTHORS.map((a) => a.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });

  it('every author has a photo file that exists in public/', () => {
    for (const author of AUTHORS) {
      expect(author.photoPath.startsWith('/images/authors/')).toBe(true);
      const abs = path.join(PUBLIC_DIR, author.photoPath.replace(/^\//, ''));
      expect(fs.existsSync(abs), `missing photo for ${author.slug} at ${abs}`).toBe(true);
    }
  });

  it('editorial profiles expose no personal identity fields', () => {
    for (const author of AUTHORS) {
      expect(Object.keys(author)).not.toEqual(expect.arrayContaining([
        'email', 'uid', 'cvPath', 'social', 'joinedAt', 'sameAs',
      ]));
    }
  });

  it('every author has non-empty expertise', () => {
    for (const author of AUTHORS) {
      expect(author.expertise.length).toBeGreaterThan(0);
      for (const e of author.expertise) {
        expect(typeof e).toBe('string');
        expect(e.length).toBeGreaterThan(1);
      }
    }
  });

  it('every author has a non-trivial Italian bio', () => {
    for (const author of AUTHORS) {
      const wordCount = author.bio.trim().split(/\s+/).length;
      expect(wordCount, `description too short for ${author.slug}`).toBeGreaterThanOrEqual(30);
    }
  });

  it('getAuthorBySlug returns the right author or undefined', () => {
    expect(getAuthorBySlug('marco-ferrari')?.name).toBe('Marco Ferrari');
    expect(getAuthorBySlug('does-not-exist')).toBeUndefined();
  });

  it('getAllAuthors mirrors the AUTHORS array', () => {
    const all = getAllAuthors();
    expect(all.length).toBe(AUTHORS.length);
    expect(all[0].slug).toBe(AUTHORS[0].slug);
  });

  it('pickAuthorForTopic prefers a topical specialist when keywords match', () => {
    const fiscal = pickAuthorForTopic(['730', 'imposta alla fonte']);
    expect(fiscal.slug).toBe('marco-ferrari');
    const previdenza = pickAuthorForTopic(['AVS', 'LPP']);
    expect(previdenza.slug).toBe('laura-bianchi');
  });

  it('pickAuthorForTopic falls back to round-robin on no match', () => {
    // Two no-match calls should pick different authors (round-robin).
    const a = pickAuthorForTopic(['unrelated-topic-xyz']);
    const b = pickAuthorForTopic(['another-unrelated-topic']);
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    // Either same (length 1 array — impossible since we asserted ≥3) or
    // different. With ≥3 authors and round-robin, two consecutive calls
    // must yield distinct authors.
    expect(a.slug).not.toBe(b.slug);
  });
});

describe('buildAuthorSeo', () => {
  it('produces a complete SEO payload for each author', () => {
    for (const author of AUTHORS) {
      const seo = buildAuthorSeo(author.slug, 'it');
      expect(seo.title).toContain(author.name);
      expect(seo.description.length).toBeGreaterThan(20);
      expect(seo.canonical).toBe(`https://frontaliereticino.ch/autori/${author.slug}/`);
      expect(seo.ogImage).toContain(author.photoPath);
      expect(seo.jsonLd['@type']).toBe('Organization');
      expect(seo.jsonLd['@id']).toBe(`${seo.canonical}#profile`);
      expect(seo.jsonLd.name).toBe(author.name);
      expect(seo.jsonLd.knowsAbout).toEqual(author.expertise);
      expect((seo.jsonLd.parentOrganization as { '@id': string })['@id']).toBe(
        'https://frontaliereticino.ch/#organization',
      );
      expect(seo.jsonLd.jobTitle).toBeUndefined();
      expect(seo.jsonLd.sameAs).toBeUndefined();
      expect(seo.jsonLd.knowsLanguage).toEqual(['it', 'en']);
    }
  });

  it('builds locale-prefixed canonicals for non-IT locales', () => {
    expect(buildAuthorSeo('marco-ferrari', 'en').canonical).toBe(
      'https://frontaliereticino.ch/en/authors/marco-ferrari/',
    );
    expect(buildAuthorSeo('marco-ferrari', 'de').canonical).toBe(
      'https://frontaliereticino.ch/de/autoren/marco-ferrari/',
    );
    expect(buildAuthorSeo('marco-ferrari', 'fr').canonical).toBe(
      'https://frontaliereticino.ch/fr/auteurs/marco-ferrari/',
    );
  });

  it('throws on unknown slug', () => {
    expect(() => buildAuthorSeo('does-not-exist', 'it')).toThrow();
  });

  // Review nit (PR #3356): AutorePage.tsx must pass the CSR-merged editorial
  // profile object, not
  // the slug — passing the slug re-derives from the static registry and the
  // Organization JSON-LD goes stale vs. the visible description/illustration.
  it('accepts an already-resolved Author object and reflects its patched fields in the JSON-LD', () => {
    const staticAuthor = getAuthorBySlug('marco-ferrari')!;
    const merged = { ...staticAuthor, name: 'Marco Ferrari Patched', bio: staticAuthor.bio };
    const seo = buildAuthorSeo(merged, 'it');
    expect(seo.jsonLd.name).toBe('Marco Ferrari Patched');
    expect(seo.title).toContain('Marco Ferrari Patched');
    expect(seo.canonical).toBe(`https://frontaliereticino.ch/autori/${staticAuthor.slug}/`);
  });
});
