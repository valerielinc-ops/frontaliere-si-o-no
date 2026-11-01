// "Di Marco Ferrari" read as a person. The note next to the name must say it is a
// newsroom signature and that the text is AI-generated, on the static article and
// on the hydrated one. No person is invented: only a real author is left unlabelled.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARTICLE_BYLINE, resolveArticleBylineNote } from '../packages/articles/engine/shared/aiDisclosure';

const LOCALES = ['it', 'en', 'de', 'fr'] as const;
const MARCO = { slug: 'marco-ferrari', kind: 'editorial-profile' } as const;
const REDAZIONE = { slug: 'redazione', kind: 'editorial-profile' } as const;
const VALENTE = { slug: 'samuele-valente', kind: 'real-author' } as const;

describe('article byline note', () => {
  it.each(LOCALES)('%s pseudonymous byline declares signature and AI', (locale) => {
    const note = resolveArticleBylineNote(locale, MARCO, true);
    expect(note).toContain(ARTICLE_BYLINE[locale].editorialSignature);
    expect(note).toContain(ARTICLE_BYLINE[locale].aiGenerated);
  });

  it.each(LOCALES)('%s newsroom byline declares only AI', (locale) => {
    expect(resolveArticleBylineNote(locale, REDAZIONE, true)).toBe(ARTICLE_BYLINE[locale].aiGenerated);
    expect(resolveArticleBylineNote(locale, undefined, true)).toBe(ARTICLE_BYLINE[locale].aiGenerated);
  });

  it.each(LOCALES)('%s a real author is never labelled a signature', (locale) => {
    expect(resolveArticleBylineNote(locale, VALENTE, false)).toBe('');
    expect(resolveArticleBylineNote(locale, VALENTE, true)).toBe(ARTICLE_BYLINE[locale].aiGenerated);
  });

  it('static and hydrated article both use the shared note', () => {
    for (const file of ['packages/articles/engine/ogPagesPlugin.ts', 'components/community/BlogArticles.tsx']) {
      expect(readFileSync(resolve(__dirname, '..', file), 'utf8'), file).toContain('resolveArticleBylineNote(');
    }
  });
});
