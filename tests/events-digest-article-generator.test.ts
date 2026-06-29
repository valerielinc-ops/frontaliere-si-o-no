/**
 * Guard the evergreen weekend-digest article generator (chained on #2963):
 * the body-only weekly refresh writes valid per-locale TS files, and the
 * updatedAt bump is idempotent (insert once, then update in place — never
 * duplicates, which would corrupt the ARTICLES entry).
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshBodyFiles, bumpUpdatedAt } from '../scripts/generate-events-digest-article.mjs';
import { buildWeekendDigestArticle } from '../scripts/lib/events-digest-content.mjs';

const article = buildWeekendDigestArticle({
  events: [{ id: 'a', title: 'Concerto al LAC', comune: 'Lugano', startDate: '2027-01-02' }],
  todayIso: '2027-01-01',
});
const data = { id: article.id, content: article.content };

describe('events digest article generator', () => {
  it('refreshBodyFiles writes a valid body file for every locale', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'digest-gen-'));
    refreshBodyFiles(data, root, () => {});
    for (const loc of ['it', 'en', 'de', 'fr']) {
      const f = path.join(root, 'services/locales/blog-body', loc, 'eventi-weekend-ticino.ts');
      expect(existsSync(f)).toBe(true);
      const src = readFileSync(f, 'utf-8');
      expect(src).toContain('export default');
      expect(src).toContain('blog.article.eventi-weekend-ticino.body1');
    }
  });

  it('bumpUpdatedAt inserts updatedAt then updates it in place (idempotent, never duplicates)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'digest-bump-'));
    mkdirSync(path.join(root, 'data'), { recursive: true });
    const file = path.join(root, 'data', 'blog-articles-data.ts');
    writeFileSync(
      file,
      [
        'const RAW_ARTICLES = [',
        '  {',
        "    id: 'eventi-weekend-ticino',",
        "    category: 'novita',",
        "    date: '2026-07-04T00:00:00.000Z',",
        "    image: '/x.webp',",
        '    hasCalculator: false,',
        '  },',
        '];',
        '',
      ].join('\n'),
    );

    expect(bumpUpdatedAt('eventi-weekend-ticino', '2027-01-09', root)).toBe(true);
    expect(readFileSync(file, 'utf-8')).toContain("updatedAt: '2027-01-09'");

    bumpUpdatedAt('eventi-weekend-ticino', '2027-01-16', root);
    const src = readFileSync(file, 'utf-8');
    expect((src.match(/updatedAt:/g) || []).length).toBe(1); // updated in place, not appended
    expect(src).toContain("updatedAt: '2027-01-16'");
  });

  it('bumpUpdatedAt is a no-op for an unknown id', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'digest-bump-none-'));
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'blog-articles-data.ts'), 'const RAW_ARTICLES = [];\n');
    expect(bumpUpdatedAt('does-not-exist', '2027-01-09', root)).toBe(false);
  });
});
