import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ARTICLE_INDEX_DEMAND_KEEPS_FILENAME,
  ARTICLE_INDEX_EXCLUSIONS_FILES,
  articleIndexExclusionKey,
  loadArticleIndexExclusions,
  parseArticleIndexDemandKeeps,
  parseArticleIndexExclusions,
} from '../packages/articles/engine/shared/articleIndexExclusions.mjs';
import {
  dropArticleIndexExcludedSitemapUrlBlocks,
  indexExcludedArticleIds,
} from '../scripts/lib/article-canonical-overrides.mjs';

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

  it('drops the full sitemap block only for an exact ledger-excluded Italian loc', () => {
    const excludedLoc = 'https://frontaliereticino.ch/articoli-frontaliere/ritirato/';
    const retainedBlock = '  <url><loc>https://frontaliereticino.ch/articoli-frontaliere/rilevante/</loc>'
      + '<xhtml:link rel="alternate" hreflang="en" href="https://frontaliereticino.ch/en/cross-border-articles/relevant/" /></url>';
    const excludedBlock = `  <url><loc> ${excludedLoc} </loc>`
      + '<xhtml:link rel="alternate" hreflang="en" href="https://frontaliereticino.ch/en/cross-border-articles/withdrawn/" /></url>';
    const xml = `<urlset>\n${retainedBlock}\n${excludedBlock}\n</urlset>`;

    expect(dropArticleIndexExcludedSitemapUrlBlocks(xml, new Set([excludedLoc]))).toEqual({
      xml: `<urlset>\n${retainedBlock}\n</urlset>`,
      dropped: [excludedLoc],
    });
    expect(dropArticleIndexExcludedSitemapUrlBlocks(xml, new Set())).toEqual({
      xml,
      dropped: [],
    });
  });

  it('lets a click-backed article out of the ledger in both layouts, for every consumer of the loader', () => {
    const ledger = JSON.stringify({
      excluded: [
        { section: 'frontaliere', id: 'gare-ciclismo-varese-ottobre' },
        { section: 'frontaliere', id: 'senza-clic' },
      ],
    });
    const keeps = JSON.stringify({ keeps: [{ section: 'frontaliere', id: 'gare-ciclismo-varese-ottobre', clicks: 5 }] });
    const layouts: Array<[string, string]> = [
      [SITE_LEDGER, `packages/articles/engine/shared/${ARTICLE_INDEX_DEMAND_KEEPS_FILENAME}`],
      [CORPUS_LEDGER, `engine/shared/${ARTICLE_INDEX_DEMAND_KEEPS_FILENAME}`],
    ];
    for (const [ledgerRel, keepsRel] of layouts) {
      const root = tempRoot();
      writeLedger(root, ledgerRel, ledger);
      writeLedger(root, keepsRel, keeps);
      const candidates = ARTICLE_INDEX_EXCLUSIONS_FILES.map((candidate) => path.join(root, candidate));
      expect([...loadArticleIndexExclusions(fs, candidates)]).toEqual(['frontaliere|senza-clic']);
    }
  });

  it('keeps the ledger intact when no keeps file exists, and refuses an unreadable one', () => {
    const root = tempRoot();
    writeLedger(root, SITE_LEDGER, JSON.stringify({ excluded: [{ section: 'frontaliere', id: 'a' }] }));
    const candidates = ARTICLE_INDEX_EXCLUSIONS_FILES.map((candidate) => path.join(root, candidate));
    expect([...loadArticleIndexExclusions(fs, candidates)]).toEqual(['frontaliere|a']);
    writeLedger(root, `packages/articles/engine/shared/${ARTICLE_INDEX_DEMAND_KEEPS_FILENAME}`, '{"keeps":[');
    expect(() => loadArticleIndexExclusions(fs, candidates)).toThrow();
    expect(() => parseArticleIndexDemandKeeps('{"keeps":{}}')).toThrow(/keeps/);
    expect(() => parseArticleIndexDemandKeeps('{"keeps":[{"section":"canton-ti","id":"x"}]}')).toThrow(/sezione/);
  });

  it('ships a well-formed demand-keeps file: unique rows, real clicks, ids known to the slug registry', () => {
    const file = path.resolve(__dirname, '../packages/articles/engine/shared', ARTICLE_INDEX_DEMAND_KEEPS_FILENAME);
    const raw = fs.readFileSync(file, 'utf-8');
    const rows = JSON.parse(raw).keeps as Array<{ section: string; id: string; clicks: number; window: string }>;
    expect(parseArticleIndexDemandKeeps(raw).size).toBe(rows.length);
    for (const row of rows) {
      expect(row.clicks, `${row.id} needs real GSC clicks`).toBeGreaterThan(0);
      expect(row.window).toMatch(/^\d{4}-\d{2}-\d{2}\.\.\d{4}-\d{2}-\d{2}$/);
    }
    const slugFiles: Record<string, string> = {
      frontaliere: '../packages/articles/content/routerBlogData.ts',
      svizzera: '../packages/articles/content/routerSwissData.ts',
    };
    for (const row of rows) {
      const slugFile = path.resolve(__dirname, slugFiles[row.section]);
      // Sparse checkouts may not carry the corpus content: skip, CI has it.
      if (!fs.existsSync(slugFile)) continue;
      expect(fs.readFileSync(slugFile, 'utf-8'), `${row.id} is not in ${row.section} registry`).toContain(`'${row.id}':`);
    }
  });

  it('wires the renderer to the ledger on both the robots value and the validator marker', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../packages/articles/engine/ogPagesPlugin.ts'), 'utf-8');
    expect(source).toContain('articleIndexExclusions.has(articleIndexExclusionKey(SECTION.name, en.articleId))');
    expect(source).toContain("content=\"${articleWithheldFromIndex ? 'noindex,follow' : ARTICLE_ROBOTS_INDEX_ENHANCED}\"");
    expect(source).toContain('${articleWithheldFromIndex ? `\\n ${ARTICLE_NOINDEX_TARGET_MARKER}` : \'\'}');
  });
});
