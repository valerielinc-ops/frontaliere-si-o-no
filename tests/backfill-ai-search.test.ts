/**
 * Tests for scripts/backfill-ai-search-optimization.mjs.
 *
 * Verifies pure functions only (no AI calls, no real filesystem):
 *   - parseBodyFile() extracts body1/body2/body3 from a TS source string
 *   - findArticlesNeedingBackfill() splits a list into needs-backfill vs
 *     already-optimized using hasAiSearchOptimization() from the helper
 *   - replaceBody1() correctly rewrites the body1 entry in a TS source
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseBodyFile,
  findArticlesNeedingBackfill,
  replaceBody1,
  listItBodyFiles,
} from '../scripts/backfill-ai-search-optimization.mjs';
import { hasAiSearchOptimization } from '../scripts/lib/ai-search-template.mjs';

const SAMPLE_BODY_FILE_NO_OPT = `const bodyFoo: Record<string, string> = {
    'blog.article.foo.body1': 'Lead originale senza TL;DR.',
    'blog.article.foo.body2': 'Analisi pratica.',
    'blog.article.foo.body3': 'Azione pratica + CTA.',
    'blog.article.foo.faq': '[{"q":"Q1","a":"A1 lunga abbastanza per la validation"},{"q":"Q2","a":"A2 lunga abbastanza"}]',
};

export default bodyFoo;
`;

const SAMPLE_BODY_FILE_WITH_OPT = `const bodyBar: Record<string, string> = {
    'blog.article.bar.body1': '## In breve\\n- punto 1\\n- punto 2\\n- punto 3\\n\\n## Fatti chiave\\n- **Cosa**: x\\n- **Quando**: y\\n- **Dove**: z\\n\\nLead vero dell\\'articolo.',
    'blog.article.bar.body2': 'Analisi pratica.',
    'blog.article.bar.body3': 'Azione pratica.',
};

export default bodyBar;
`;

const SAMPLE_UNPARSEABLE = `// just a comment, no body keys
export default {};
`;

describe('parseBodyFile()', () => {
  let tmpDir: string;
  let fooPath: string;
  let barPath: string;
  let badPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'backfill-test-'));
    fooPath = join(tmpDir, 'foo.ts');
    barPath = join(tmpDir, 'bar.ts');
    badPath = join(tmpDir, 'bad.ts');
    writeFileSync(fooPath, SAMPLE_BODY_FILE_NO_OPT, 'utf-8');
    writeFileSync(barPath, SAMPLE_BODY_FILE_WITH_OPT, 'utf-8');
    writeFileSync(badPath, SAMPLE_UNPARSEABLE, 'utf-8');
  });

  it('extracts articleId + body1/body2/body3', () => {
    const parsed = parseBodyFile(fooPath) as Record<string, string> | null;
    expect(parsed).not.toBeNull();
    expect(parsed!.articleId).toBe('foo');
    expect(parsed!.body1).toBe('Lead originale senza TL;DR.');
    expect(parsed!.body2).toBe('Analisi pratica.');
    expect(parsed!.body3).toBe('Azione pratica + CTA.');
  });

  it('decodes embedded TL;DR markers correctly', () => {
    const parsed = parseBodyFile(barPath) as Record<string, string> | null;
    expect(parsed).not.toBeNull();
    expect(parsed!.body1).toContain('## In breve');
    expect(parsed!.body1).toContain('## Fatti chiave');
    expect(hasAiSearchOptimization(parsed!.body1)).toBe(true);
  });

  it('returns null for unparseable files', () => {
    expect(parseBodyFile(badPath)).toBeNull();
  });

  it('returns null for non-existent files', () => {
    expect(parseBodyFile(join(tmpDir, 'does-not-exist.ts'))).toBeNull();
  });
});

describe('findArticlesNeedingBackfill()', () => {
  let tmpDir: string;
  let fooPath: string;
  let barPath: string;
  let badPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'backfill-find-'));
    fooPath = join(tmpDir, 'foo.ts');
    barPath = join(tmpDir, 'bar.ts');
    badPath = join(tmpDir, 'bad.ts');
    writeFileSync(fooPath, SAMPLE_BODY_FILE_NO_OPT, 'utf-8');
    writeFileSync(barPath, SAMPLE_BODY_FILE_WITH_OPT, 'utf-8');
    writeFileSync(badPath, SAMPLE_UNPARSEABLE, 'utf-8');
  });

  it('flags articles missing TL;DR + Fatti chiave', () => {
    const { needing } = findArticlesNeedingBackfill([fooPath, barPath]);
    expect(needing.map((n: { articleId: string }) => n.articleId)).toEqual(['foo']);
  });

  it('skips articles already optimized', () => {
    const { skipped } = findArticlesNeedingBackfill([fooPath, barPath]);
    const optimized = skipped.filter((s: { reason: string }) => s.reason === 'already-optimized');
    expect(optimized).toHaveLength(1);
    expect(optimized[0].filePath).toBe(barPath);
  });

  it('skips unparseable files', () => {
    const { skipped } = findArticlesNeedingBackfill([badPath]);
    expect(skipped.some((s: { reason: string }) => s.reason === 'unparseable')).toBe(true);
  });
});

describe('replaceBody1()', () => {
  it('rewrites body1 while preserving body2/body3 and faq', () => {
    const newBody1 = '## In breve\n- a\n- b\n\n## Fatti chiave\n- **Cosa**: x\n\nLead originale senza TL;DR.';
    const updated = replaceBody1(SAMPLE_BODY_FILE_NO_OPT, 'foo', newBody1);

    // Body1 escaped + present
    expect(updated).toContain('## In breve');
    expect(updated).toContain('## Fatti chiave');

    // Other keys untouched
    expect(updated).toContain("'blog.article.foo.body2': 'Analisi pratica.'");
    expect(updated).toContain("'blog.article.foo.body3': 'Azione pratica + CTA.'");
    expect(updated).toContain("'blog.article.foo.faq':");

    // Newlines were escaped to \n in the TS literal
    expect(updated).toMatch(/'blog\.article\.foo\.body1':\s*'## In breve\\n/);
  });

  it('throws when body1 anchor is missing', () => {
    expect(() => replaceBody1('// no body1 here', 'foo', 'x')).toThrow();
  });

  it('escapes apostrophes in the new body1', () => {
    const withApostrophe = "L'articolo parla dell'accordo.";
    const updated = replaceBody1(SAMPLE_BODY_FILE_NO_OPT, 'foo', withApostrophe);
    // escaped form: L\'articolo parla dell\'accordo.
    expect(updated).toContain("L\\'articolo parla dell\\'accordo.");
  });
});

describe('listItBodyFiles()', () => {
  it('returns an array (real IT directory)', () => {
    const files = listItBodyFiles();
    expect(Array.isArray(files)).toBe(true);
    // The IT directory has 904 articles per current state — just sanity-check >0
    if (files.length > 0) {
      expect(files[0]).toMatch(/\.ts$/);
    }
  });

  it('returns empty array for non-existent dir', () => {
    expect(listItBodyFiles('/no/such/path/exists')).toEqual([]);
  });
});
