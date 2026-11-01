import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARTICLE_INDEX_EXCLUSIONS_FILES,
  articleIndexExclusionKey,
  loadArticleIndexExclusions,
  parseArticleIndexExclusions,
} from '../packages/articles/engine/shared/articleIndexExclusions.mjs';
import { indexExcludedArticleIds } from '../scripts/lib/article-canonical-overrides.mjs';

const [SITE_LEDGER, CORPUS_LEDGER] = ARTICLE_INDEX_EXCLUSIONS_FILES;

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'article-index-exclusions-'));
}

function writeLedger(root: string, relative: string, body: string): void {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

describe('article index exclusions ledger', () => {
  it('keys a row by section and id, not by id alone', () => {
    const keys = parseArticleIndexExclusions(JSON.stringify({
      excluded: [{ section: 'frontaliere', id: 'como-napoli-pareggio-2026' }],
    }));
    expect(keys.has(articleIndexExclusionKey('frontaliere', 'como-napoli-pareggio-2026'))).toBe(true);
    expect(keys.has(articleIndexExclusionKey('svizzera', 'como-napoli-pareggio-2026'))).toBe(false);
  });

  it('treats a missing file as an empty set: a checkout may not have received it yet', () => {
    const root = tempRoot();
    const candidates = ARTICLE_INDEX_EXCLUSIONS_FILES.map((candidate) => path.join(root, candidate));
    expect(loadArticleIndexExclusions(fs, candidates).size).toBe(0);
  });

  it('refuses an unreadable file: an empty set would silently re-index every excluded article', () => {
    const root = tempRoot();
    writeLedger(root, CORPUS_LEDGER, '{"excluded":[{"section":"frontaliere"');
    const candidates = ARTICLE_INDEX_EXCLUSIONS_FILES.map((candidate) => path.join(root, candidate));
    expect(() => loadArticleIndexExclusions(fs, candidates)).toThrow();

    expect(() => parseArticleIndexExclusions('{"excluded":{}}')).toThrow(/excluded/);
    expect(() => parseArticleIndexExclusions('{"excluded":[{"id":"x"}]}')).toThrow(/section/);
  });

  it('resolves both repo layouts, site first', () => {
    const root = tempRoot();
    writeLedger(root, CORPUS_LEDGER, JSON.stringify({
      excluded: [{ section: 'frontaliere', id: 'corpus-layout' }],
    }));
    const candidates = ARTICLE_INDEX_EXCLUSIONS_FILES.map((candidate) => path.join(root, candidate));
    expect([...loadArticleIndexExclusions(fs, candidates)]).toEqual(['frontaliere|corpus-layout']);

    writeLedger(root, SITE_LEDGER, JSON.stringify({
      excluded: [{ section: 'frontaliere', id: 'site-layout' }],
    }));
    expect([...loadArticleIndexExclusions(fs, candidates)]).toEqual(['frontaliere|site-layout']);
  });

  it('exempts from the sitemap sync gate only the ids of the section that withdrew them', () => {
    const root = tempRoot();
    writeLedger(root, SITE_LEDGER, JSON.stringify({
      excluded: [
        { section: 'frontaliere', id: 'burraco-solidale-buguggiate' },
        { section: 'svizzera', id: 'muro-big-bend' },
      ],
    }));
    const slugs = {
      'burraco-solidale-buguggiate': { it: 'burraco-solidale-buguggiate' },
      'muro-big-bend': { it: 'muro-big-bend' },
      'frontalieri-ticino': { it: 'frontalieri-ticino' },
    };
    expect([...indexExcludedArticleIds(root, 'frontaliere', slugs)]).toEqual(['burraco-solidale-buguggiate']);
    expect([...indexExcludedArticleIds(root, 'svizzera', slugs)]).toEqual(['muro-big-bend']);
  });

  it('wires the renderer to the ledger on both the robots value and the validator marker', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../packages/articles/engine/ogPagesPlugin.ts'), 'utf-8');
    expect(source).toContain('articleIndexExclusions.has(articleIndexExclusionKey(SECTION.name, en.articleId))');
    expect(source).toContain("content=\"${articleWithheldFromIndex ? 'noindex,follow' : ARTICLE_ROBOTS_INDEX_ENHANCED}\"");
    expect(source).toContain('${articleWithheldFromIndex ? `\\n ${ARTICLE_NOINDEX_TARGET_MARKER}` : \'\'}');
  });
});
