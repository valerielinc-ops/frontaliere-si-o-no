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
import { refreshBodyFiles, bumpUpdatedAt, bumpDateModified, bumpSitemapLastmod } from '../scripts/generate-events-digest-article.mjs';
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

  it('bumpUpdatedAt skips a same-day bump that would precede the timestamped `date` (registration-day refresh)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'digest-bump-sameday-'));
    mkdirSync(path.join(root, 'data'), { recursive: true });
    const file = path.join(root, 'data', 'blog-articles-data.ts');
    writeFileSync(
      file,
      [
        'const RAW_ARTICLES = [',
        '  {',
        "    id: 'eventi-weekend-ticino',",
        "    category: 'novita',",
        "    date: '2027-01-09T11:13:04.641Z',", // registered later today
        "    image: '/x.webp',",
        '    hasCalculator: false,',
        '  },',
        '];',
        '',
      ].join('\n'),
    );

    // A date-only updatedAt anchored at midnight would parse as *before*
    // the 11:13 registration timestamp — an incoherent freshness signal
    // (google-news-compliance.test.ts). Must be skipped, not written.
    expect(bumpUpdatedAt('eventi-weekend-ticino', '2027-01-09', root)).toBe(true);
    expect(readFileSync(file, 'utf-8')).not.toContain('updatedAt:');
  });

  it('bumpUpdatedAt is a no-op for an unknown id', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'digest-bump-none-'));
    mkdirSync(path.join(root, 'data'), { recursive: true });
    writeFileSync(path.join(root, 'data', 'blog-articles-data.ts'), 'const RAW_ARTICLES = [];\n');
    expect(bumpUpdatedAt('does-not-exist', '2027-01-09', root)).toBe(false);
  });

  it('bumpDateModified updates only the target article entry, not its siblings', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'digest-dm-'));
    mkdirSync(path.join(root, 'services', 'seo'), { recursive: true });
    const file = path.join(root, 'services', 'seo', 'seo-blog-5.ts');
    writeFileSync(
      file,
      [
        "  'blog-other': {",
        '    structuredData: {',
        '      "datePublished": "2026-01-01T00:00:00+02:00",',
        '      "dateModified": "2026-01-01T00:00:00+02:00",',
        '    },',
        '  },',
        "  'blog-eventi-weekend-ticino': {",
        '    structuredData: {',
        '      "datePublished": "2026-06-29T19:07:39+02:00",',
        '      "dateModified": "2026-06-29T19:07:39+02:00",',
        '    },',
        '  },',
        '',
      ].join('\n'),
    );
    expect(bumpDateModified('eventi-weekend-ticino', '2027-01-09T00:00:00+02:00', root)).toBe(true);
    const src = readFileSync(file, 'utf-8');
    expect(src).toContain('"dateModified": "2027-01-09T00:00:00+02:00"');
    // the sibling article and the datePublished must be untouched
    expect(src).toContain("'blog-other'");
    expect((src.match(/2026-01-01T00:00:00\+02:00/g) || []).length).toBe(2);
    expect(src).toContain('"datePublished": "2026-06-29T19:07:39+02:00"');
  });

  it('bumpDateModified clamps up to datePublished, never regressing earlier (same-day refresh)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'digest-dm-clamp-'));
    mkdirSync(path.join(root, 'services', 'seo'), { recursive: true });
    const file = path.join(root, 'services', 'seo', 'seo-blog-5.ts');
    writeFileSync(
      file,
      [
        "  'blog-eventi-weekend-ticino': {",
        '    structuredData: {',
        '      "datePublished": "2026-06-29T19:07:39+02:00",',
        '      "dateModified": "2026-06-29T19:07:39+02:00",',
        '    },',
        '  },',
        '',
      ].join('\n'),
    );
    // The daily refresh hands a fixed-midnight stamp that, on the publish day,
    // precedes the publish time — it must clamp up, not invert the freshness signal.
    expect(bumpDateModified('eventi-weekend-ticino', '2026-06-29T00:00:00+02:00', root)).toBe(true);
    const src = readFileSync(file, 'utf-8');
    expect(src).toContain('"dateModified": "2026-06-29T19:07:39+02:00"');
    expect(src).not.toContain('"dateModified": "2026-06-29T00:00:00+02:00"');
  });

  it('bumpSitemapLastmod rewrites only the target url block lastmod', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'digest-sm-'));
    mkdirSync(path.join(root, 'public'), { recursive: true });
    const file = path.join(root, 'public', 'sitemap-blog.xml');
    writeFileSync(
      file,
      [
        '<urlset>',
        '  <url>',
        '    <loc>https://x/articoli-frontaliere/altro-articolo/</loc>',
        '    <lastmod>2026-01-01</lastmod>',
        '  </url>',
        '  <url>',
        '    <loc>https://x/articoli-frontaliere/eventi-weekend-ticino/</loc>',
        '    <image:image><image:loc>x</image:loc></image:image>',
        '    <lastmod>2026-06-29</lastmod>',
        '  </url>',
        '</urlset>',
        '',
      ].join('\n'),
    );
    expect(bumpSitemapLastmod('eventi-weekend-ticino', '2027-01-09', root)).toBe(true);
    const src = readFileSync(file, 'utf-8');
    expect(src).toContain('<lastmod>2027-01-09</lastmod>');
    expect(src).toContain('<lastmod>2026-01-01</lastmod>'); // sibling untouched
    expect(src).not.toContain('<lastmod>2026-06-29</lastmod>');
  });
});
