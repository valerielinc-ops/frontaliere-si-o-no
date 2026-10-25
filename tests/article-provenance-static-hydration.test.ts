import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveArticleProvenance,
  resolveArticleTransparencyStatement,
  shouldRenderHumanDisclosure,
} from '../packages/articles/engine/shared/articleProvenance';
import { ARTICLE_TRANSPARENCY, disclosureLocale } from '../packages/articles/engine/shared/aiDisclosure';

const ROOT = join(__dirname, '..');

describe('article provenance static-to-SPA contract', () => {
  it('keeps explicit declarations authoritative over the author default', () => {
    expect(resolveArticleProvenance({ aiAssisted: true }, { uid: 'guest' }))
      .toEqual({ aiAssisted: true, basis: 'declared' });
    expect(resolveArticleProvenance({ aiAssisted: false }, {}))
      .toEqual({ aiAssisted: false, basis: 'declared' });
  });

  it('anchors legacy fallback provenance to the canonical author, not a CSR byline override', () => {
    const canonicalAuthor = {};
    const runtimeBylineOverride = { uid: 'runtime-byline-only' };

    expect(resolveArticleProvenance({}, canonicalAuthor))
      .toEqual({ aiAssisted: true, basis: 'inferred-from-uid' });
    expect(resolveArticleProvenance({}, runtimeBylineOverride))
      .toEqual({ aiAssisted: false, basis: 'inferred-from-uid' });

    const spaSrc = readFileSync(join(ROOT, 'components/community/BlogArticles.tsx'), 'utf-8');
    expect(spaSrc).toMatch(/const canonicalAuthor = .*getAuthorBySlug\(article\.authorSlug\)/);
    expect(spaSrc).toMatch(/provenance:\s*resolveArticleProvenance\(article,\s*canonicalAuthor\)/);
    expect(spaSrc).not.toMatch(/provenance:\s*resolveArticleProvenance\(article,\s*bylineAuthor\)/);
  });

  it('keeps an explicit non-AI declaration human even without a usable name', () => {
    expect(shouldRenderHumanDisclosure({ aiAssisted: false, basis: 'declared' }, 'Ada')).toBe(true);
    expect(shouldRenderHumanDisclosure({ aiAssisted: false, basis: 'declared' }, '   ')).toBe(false);
    expect(shouldRenderHumanDisclosure({ aiAssisted: false, basis: 'declared' }, undefined)).toBe(false);
    expect(shouldRenderHumanDisclosure({ aiAssisted: true, basis: 'declared' }, 'Ada')).toBe(false);
    for (const copy of Object.values(ARTICLE_TRANSPARENCY)) {
      expect(copy.humanWithoutName.length).toBeGreaterThan(0);
    }
  });

  it('returns the same localized statement for static and hydrated consumers', () => {
    const locales = ['it', 'en', 'de', 'fr'];
    const cases = [
      { provenance: { aiAssisted: true, basis: 'declared' as const }, authorName: 'Ada' },
      { provenance: { aiAssisted: false, basis: 'declared' as const }, authorName: ' Ada ' },
      { provenance: { aiAssisted: false, basis: 'declared' as const }, authorName: '   ' },
      { provenance: { aiAssisted: false, basis: 'declared' as const }, authorName: undefined },
    ];

    for (const locale of locales) {
      for (const { provenance, authorName } of cases) {
        const statement = resolveArticleTransparencyStatement(locale, provenance, authorName);
        const copy = ARTICLE_TRANSPARENCY[disclosureLocale(locale)];
        const normalizedAuthorName = authorName?.trim();
        const expected = provenance.aiAssisted
          ? copy.aiAssisted
          : normalizedAuthorName
            ? copy.human(normalizedAuthorName)
            : copy.humanWithoutName;
        expect(statement).toBe(expected);
      }
    }
  });

  it('propagates one provenance payload into both disclosure emitters', () => {
    const staticSrc = readFileSync(join(ROOT, 'packages/articles/engine/ogPagesPlugin.ts'), 'utf-8');
    const spaSrc = readFileSync(join(ROOT, 'components/community/BlogArticles.tsx'), 'utf-8');
    const overlaySrc = readFileSync(join(ROOT, 'services/articlesOverlay.ts'), 'utf-8');

    expect(staticSrc).toMatch(/resolveArticleProvenance\(\{ aiAssisted: en\.aiAssisted \}, authorProfile\)/);
    expect(staticSrc).toMatch(/const articleProvenance = resolvedAuthor\s+\?\s+resolvedAuthor\.provenance/);
    expect(staticSrc).toMatch(/const articleTransparencyAuthorName = en\.authorName\.trim\(\) \|\| resolvedAuthor\?\.name/);
    expect(staticSrc).toMatch(/buildArticleTransparencyAside\(locale, articleTransparencyAuthorName, articleProvenance\)/);
    expect(staticSrc).toMatch(/resolveArticleTransparencyStatement\(locale, provenance, authorName\)/);
    expect(overlaySrc).toMatch(/typeof entry\.aiAssisted === 'boolean' \? \{ aiAssisted: entry\.aiAssisted \}/);
    expect(overlaySrc).toMatch(/typeof entry\.authorName === 'string' \? entry\.authorName\.trim\(\) : ''/);
    expect(overlaySrc).toMatch(/authorSlug \? getAuthorBySlug\(authorSlug\)\?\.name/);
    expect(spaSrc).toMatch(/provenance:\s*resolveArticleProvenance\(article,\s*canonicalAuthor\)/);
    expect(spaSrc).toMatch(/resolveArticleTransparencyStatement\(\s*locale,\s*resolvedAuthor\.provenance,\s*effectiveAuthorName,/);
  });
});
