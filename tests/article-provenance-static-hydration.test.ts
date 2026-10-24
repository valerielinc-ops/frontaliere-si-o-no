import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveArticleProvenance, shouldRenderHumanDisclosure } from '../packages/articles/engine/shared/articleProvenance';
import { ARTICLE_TRANSPARENCY } from '../packages/articles/engine/shared/aiDisclosure';

const ROOT = join(__dirname, '..');

describe('article provenance static-to-SPA contract', () => {
  it('keeps explicit declarations authoritative over the author default', () => {
    expect(resolveArticleProvenance({ aiAssisted: true }, { uid: 'guest' }))
      .toEqual({ aiAssisted: true, basis: 'declared' });
    expect(resolveArticleProvenance({ aiAssisted: false }, {}))
      .toEqual({ aiAssisted: false, basis: 'declared' });
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

  it('propagates one provenance payload into both disclosure emitters', () => {
    const staticSrc = readFileSync(join(ROOT, 'packages/articles/engine/ogPagesPlugin.ts'), 'utf-8');
    const spaSrc = readFileSync(join(ROOT, 'components/community/BlogArticles.tsx'), 'utf-8');
    const overlaySrc = readFileSync(join(ROOT, 'services/articlesOverlay.ts'), 'utf-8');

    expect(staticSrc).toMatch(/resolveArticleProvenance\(\{ aiAssisted: en\.aiAssisted \}, authorProfile\)/);
    expect(staticSrc).toMatch(/const articleProvenance = resolvedAuthor\s+\?\s+resolvedAuthor\.provenance/);
    expect(staticSrc).toMatch(/buildArticleTransparencyAside\(locale, en\.authorName \|\| resolvedAuthor\?\.name, articleProvenance\)/);
    expect(overlaySrc).toMatch(/typeof entry\.aiAssisted === 'boolean' \? \{ aiAssisted: entry\.aiAssisted \}/);
    expect(overlaySrc).toMatch(/typeof entry\.authorName === 'string' \? entry\.authorName\.trim\(\) : ''/);
    expect(overlaySrc).toMatch(/authorSlug \? getAuthorBySlug\(authorSlug\)\?\.name/);
    expect(spaSrc).toMatch(/provenance: resolveArticleProvenance\(article, bylineAuthor\)/);
    expect(spaSrc).toMatch(/shouldRenderHumanDisclosure\(resolvedAuthor\.provenance, normalizedAuthorName\)/);
    expect(staticSrc).toMatch(/shouldRenderHumanDisclosure\(provenance, normalizedAuthorName\)/);
    expect(staticSrc).toMatch(/tr\.humanWithoutName/);
    expect(spaSrc).toMatch(/transparencyCopy\.humanWithoutName/);
  });
});
