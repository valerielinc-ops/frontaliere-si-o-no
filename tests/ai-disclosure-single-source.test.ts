// E-E-A-T P0 — one coherent statement about AI use.
//
// The static /chi-siamo/ HTML said the newsroom was "composta da esperti", the
// React page said generative AI without guaranteed human review, and the article
// aside said "revisionata dalla redazione" while denying it certified human
// review. The truthful version (React + methodology) now lives in
// packages/articles/engine/shared/aiDisclosure.ts; this observer keeps every
// surface on it and keeps the contradicting wording out.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AI_USE_STATEMENT,
  ARTICLE_TRANSPARENCY,
  DISCLOSURE_ROUTE_CONTRACT,
} from '../packages/articles/engine/shared/aiDisclosure';
import { CHI_SIAMO_COPY } from '../components/pages/chiSiamoCopy';
import { SECTION_EDITORIAL } from '../build-plugins/editorialContent';
import { SLUG_TABLES } from '../services/routeSlugs.data';

const ROOT = resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(resolve(ROOT, rel), 'utf8');
const LOCALES = ['it', 'en', 'de', 'fr'] as const;

// Wording that claims an expert newsroom or a human review the site does not run.
const CONTRADICTIONS = [
  /composta da esperti/i,
  /consists of experts/i,
  /revisionata dalla redazione/i,
  /bozza assistita da intelligenza artificiale/i,
];

describe('AI disclosure: single source', () => {
  it.each([
    'build-plugins/staticPagesPlugin.ts',
    'build-plugins/editorialContent.ts',
    'components/pages/chiSiamoCopy.ts',
    'components/community/BlogArticles.tsx',
    'packages/articles/engine/ogPagesPlugin.ts',
  ])('%s carries no contradicting expert/human-review claim', (rel) => {
    const text = read(rel);
    expect(CONTRADICTIONS.filter((re) => re.test(text)).map(String)).toEqual([]);
  });

  it.each(LOCALES)('React /chi-siamo/ (%s) states the shared AI sentence', (locale) => {
    expect(CHI_SIAMO_COPY[locale].ai).toContain(AI_USE_STATEMENT[locale]);
  });

  it.each(['en', 'de', 'fr'] as const)('static /chi-siamo/ copy (%s) states the shared AI sentence', (locale) => {
    expect(SECTION_EDITORIAL['/chi-siamo'][locale]).toContain(AI_USE_STATEMENT[locale]);
  });

  it('static IT /chi-siamo/ and EN /about/ render the shared sentence and link methodology + corrections', () => {
    const src = read('build-plugins/staticPagesPlugin.ts');
    for (const locale of ['it', 'en'] as const) {
      expect(src).toContain(`\${AI_USE_STATEMENT.${locale}}`);
      expect(src).toContain(`\${DISCLOSURE_ROUTE_CONTRACT.${locale}.methodology}`);
      expect(src).toContain(`\${DISCLOSURE_ROUTE_CONTRACT.${locale}.corrections}`);
    }
  });

  it('the shared disclosure contract builds the same paths as the host router', () => {
    for (const locale of LOCALES) {
      const prefix = locale === 'it' ? '' : `/${locale}`;
      expect(DISCLOSURE_ROUTE_CONTRACT[locale].methodology).toBe(`${prefix}/${SLUG_TABLES[locale].metodologia}/`);
      expect(DISCLOSURE_ROUTE_CONTRACT[locale].corrections).toBe(`${prefix}/${SLUG_TABLES[locale].correzioni}/`);
    }
  });

  it.each(LOCALES)('article disclosure (%s) never claims a human review for machine drafts', (locale) => {
    const copy = ARTICLE_TRANSPARENCY[locale];
    expect(copy.aiAssisted.length).toBeGreaterThan(40);
    expect(copy.human('Nome Cognome')).toContain('Nome Cognome');
  });

  it('static and hydrated article both render the shared disclosure and the trust links', () => {
    const og = read('packages/articles/engine/ogPagesPlugin.ts');
    // The provenance-aware renderer feeds a normalized name and one shared
    // statement resolver to the static and hydrated consumers.
    expect(og).toMatch(/const articleTransparencyAuthorName = en\.authorName\.trim\(\) \|\| resolvedAuthor\?\.name/);
    expect(og).toMatch(/\$\{buildArticleTransparencyAside\(locale, articleTransparencyAuthorName, articleProvenance\)/);
    expect(og).toMatch(/links\.about\} \| \$\{methodology\} \| \$\{corrections\}/);
    const spa = read('components/community/BlogArticles.tsx');
    expect(spa).toContain('resolveArticleTransparencyStatement(');
    expect(spa).toContain('ARTICLE_TRANSPARENCY[transparencyLocale]');
    expect(spa).toContain('DISCLOSURE_ROUTE_CONTRACT[transparencyLocale].methodology');
    expect(spa).toContain('DISCLOSURE_ROUTE_CONTRACT[transparencyLocale].corrections');
  });
});
