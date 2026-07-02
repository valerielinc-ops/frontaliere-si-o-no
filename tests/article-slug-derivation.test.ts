/**
 * Guard for issue #3209 item 1: `registerArticleFiles()` (scripts/create-article.mjs)
 * must expose the final per-locale slugs it derives so callers (e.g.
 * scripts/publish-journalist-article.mjs, the journalist publish pipeline)
 * consume a single source of truth instead of re-implementing the same
 * derivation — a duplicate copy would drift as this one evolves, producing
 * wrong canonicals / 404s for journalist-authored articles.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { deriveAndSanitizeArticleSlugs } from '../scripts/create-article.mjs';

const ROOT = resolve(__dirname, '..');

describe('deriveAndSanitizeArticleSlugs', () => {
  it('locks the IT slug to data.id and derives missing en/de/fr slugs from translated titles', () => {
    const data = {
      id: 'nuova-legge-frontalieri',
      slugs: {},
      content: {
        it: { title: 'Nuova legge frontalieri' },
        en: { title: 'New cross-border law' },
        de: { title: 'Neues Grenzgängergesetz' },
        fr: { title: 'Nouvelle loi frontalière' },
      },
    };

    const result = deriveAndSanitizeArticleSlugs(data);

    expect(result.it).toBe('nuova-legge-frontalieri');
    expect(result.en).toBe('new-cross-border-law');
    expect(result.de).toBe('neues-grenzgangergesetz');
    expect(result.fr).toBe('nouvelle-loi-frontaliere');
  });

  it('returns the SAME object it mutated, exposing the final value by reference (issue #3209 item 1)', () => {
    const data = {
      id: 'articolo-test',
      slugs: { it: 'articolo-test' },
      content: { it: { title: 'Articolo test' } },
    };

    const result = deriveAndSanitizeArticleSlugs(data);

    expect(result).toBe(data.slugs);
  });

  it('falls back to the IT slug when a translated title is missing', () => {
    const data = {
      id: 'articolo-senza-traduzioni',
      slugs: {},
      content: { it: { title: 'Articolo senza traduzioni' } },
    };

    const result = deriveAndSanitizeArticleSlugs(data);

    expect(result.en).toBe('articolo-senza-traduzioni');
    expect(result.de).toBe('articolo-senza-traduzioni');
    expect(result.fr).toBe('articolo-senza-traduzioni');
  });

  it('sanitizes an already-set locale slug (diacritics/non-ASCII stripped) instead of trusting it as-is', () => {
    const data = {
      id: 'estate-a-ginevra',
      slugs: { en: 'summer-in-geneva', fr: 'été-à-genève-la-loi-évolue' },
      content: {
        it: { title: 'Estate a Ginevra' },
        fr: { title: 'Été à Genève' },
      },
    };

    const result = deriveAndSanitizeArticleSlugs(data);

    // Already-ASCII-safe slug (mirrors a hand-picked slug, e.g. the events
    // digest generator's DIGEST_ARTICLE_SLUGS) is preserved untouched.
    expect(result.en).toBe('summer-in-geneva');
    // Accented pre-set slug gets sanitized the same way a fallback-derived
    // one would, so router/sitemap URLs never see raw diacritics regardless
    // of whether the caller supplied the slug or left it for derivation.
    expect(result.fr).toBe('ete-a-geneve-la-loi-evolue');
  });

  it('is idempotent: calling it twice on an already-finalized data object is a no-op', () => {
    const data = {
      id: 'articolo-idempotente',
      slugs: {},
      content: {
        it: { title: 'Articolo idempotente' },
        en: { title: 'Idempotent article' },
      },
    };

    deriveAndSanitizeArticleSlugs(data);
    const firstPass = { ...data.slugs };
    deriveAndSanitizeArticleSlugs(data);

    expect(data.slugs).toEqual(firstPass);
  });
});

describe('publish-journalist-article.mjs slug handling (issue #3209 item 1)', () => {
  const src = readFileSync(resolve(ROOT, 'scripts/publish-journalist-article.mjs'), 'utf8');

  it('does not re-implement its own locale-slug derivation anymore', () => {
    // Regression guard: this duplicate (`function deriveLocaleSlugs`) used to
    // re-derive en/de/fr slugs independently of registerArticleFiles(),
    // risking drift. It must now consume registerArticleFiles()'s returned
    // slugs instead.
    expect(src).not.toMatch(/function\s+deriveLocaleSlugs/);
  });

  it('consumes the slugs returned by registerArticleFiles() rather than data.slugs set beforehand', () => {
    expect(src).toMatch(/const\s*\{\s*slugs\s*\}\s*=\s*await registerArticleFiles\(data\)/);
  });
});
