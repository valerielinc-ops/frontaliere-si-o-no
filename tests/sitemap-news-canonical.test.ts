/**
 * Google News compliance — task A4.
 *
 * The ONLY canonical news sitemap is `sitemap-news.xml` (dash-separated).
 * The legacy underscore variant `sitemap_news.xml` is deprecated and must
 * not be emitted by any build plugin, script, or runtime helper.
 *
 * This test is a tripwire: it guards against a future regression where a
 * developer or AI assistant resurrects the underscore form. If this test
 * fails, do NOT add the underscore back — fix the offending source file
 * to use the dash form (or remove the reference entirely).
 *
 * Allowed exceptions (kept as defensive guards / historical comments):
 *   - `build-plugins/sitemapAliasPlugin.ts` keeps the underscore name in
 *     `EXCLUDED_SITEMAP_FILES` so a stray legacy file never leaks into the
 *     sitemap index.
 *   - `scripts/audit-sitemap-canonicals.mjs` and
 *     `scripts/validate-sitemap-pages.mjs` keep the underscore name in
 *     their skip filters (defensive — a stray file never reaches the
 *     audit URL set even if it appears).
 *   - This test file itself references the underscore form.
 *
 * Any OTHER reference (writeFileSync, copyFileSync, fetch URL, sitemap
 * index entry, robots.txt entry, etc.) is a regression.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

const SEARCH_ROOTS = [
  'build-plugins',
  'scripts',
  'public',
  'services',
  'components',
  'tests',
];
const SEARCH_FILES = ['vite.config.ts', 'package.json', 'tsconfig.json'];
const SEARCH_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.xml',
  '.txt',
  '.md',
  '.yml',
  '.yaml',
  '.html',
]);

function collectMatches(needle: string): { file: string; line: number; text: string }[] {
  const matches: { file: string; line: number; text: string }[] = [];
  const visit = (absPath: string, relPath: string) => {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absPath);
    } catch {
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absPath)) {
        if (entry === 'node_modules' || entry.startsWith('.')) continue;
        visit(path.join(absPath, entry), path.posix.join(relPath, entry));
      }
      return;
    }
    if (!stat.isFile()) return;
    if (!SEARCH_EXTENSIONS.has(path.extname(absPath))) return;
    const content = fs.readFileSync(absPath, 'utf-8');
    if (!content.includes(needle)) return;
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].includes(needle)) {
        matches.push({ file: relPath, line: i + 1, text: lines[i].trim() });
      }
    }
  };
  for (const dir of SEARCH_ROOTS) {
    visit(path.join(ROOT, dir), dir);
  }
  for (const file of SEARCH_FILES) {
    visit(path.join(ROOT, file), file);
  }
  return matches;
}

/**
 * Files where the underscore form may legitimately appear (defensive guards
 * and historical comments). Paths are repo-relative.
 */
const ALLOWED_REFERENCES = new Set<string>([
  'build-plugins/sitemapAliasPlugin.ts',
  'scripts/audit-sitemap-canonicals.mjs',
  'scripts/validate-sitemap-pages.mjs',
  'tests/sitemap-auto-index.test.ts',
  'tests/sitemap-news-canonical.test.ts',
  // AdminPanel checks for legacy filename existence as a health-check diagnostic
  'components/pages/AdminPanel.tsx',
  // thin-content-guard excludes legacy sitemap_news.xml from content-gap checks
  'tests/post-build/thin-content-guard.test.ts',
]);

describe('sitemap-news canonical filename — A4 Google News compliance', () => {
  it('no source file emits the legacy underscore variant `sitemap_news.xml`', () => {
    const offenders = collectMatches('sitemap_news').filter(
      (m) => !ALLOWED_REFERENCES.has(m.file),
    );

    if (offenders.length > 0) {
      const summary = offenders
        .map((o) => `  ${o.file}:${o.line} → ${o.text}`)
        .join('\n');
      throw new Error(
        `Found ${offenders.length} reference(s) to the deprecated ` +
          `\`sitemap_news.xml\` filename. Use \`sitemap-news.xml\` (dash) ` +
          `instead, or add the file to ALLOWED_REFERENCES if it is a ` +
          `defensive guard:\n${summary}`,
      );
    }

    expect(offenders).toEqual([]);
  });

  it('public/sitemap.xml index references only the dash-separated news sitemap', () => {
    const indexPath = path.join(ROOT, 'public', 'sitemap.xml');
    const xml = fs.readFileSync(indexPath, 'utf-8');

    expect(xml).toContain('sitemap-news.xml');
    expect(xml).not.toContain('sitemap_news.xml');
  });

  it('public/robots.txt advertises only the dash-separated news sitemap', () => {
    const robotsPath = path.join(ROOT, 'public', 'robots.txt');
    const txt = fs.readFileSync(robotsPath, 'utf-8');

    expect(txt).toContain('sitemap-news.xml');
    expect(txt).not.toContain('sitemap_news.xml');
  });

  it('submit-google-indexing.js references only the dash-separated form', () => {
    const file = path.join(ROOT, 'scripts', 'submit-google-indexing.js');
    const src = fs.readFileSync(file, 'utf-8');

    expect(src).toContain('sitemap-news.xml');
    expect(src).not.toContain('sitemap_news.xml');
  });

  it('submit-indexnow.js references only the dash-separated form', () => {
    const file = path.join(ROOT, 'scripts', 'submit-indexnow.js');
    const src = fs.readFileSync(file, 'utf-8');

    expect(src).toContain('sitemap-news.xml');
    expect(src).not.toContain('sitemap_news.xml');
  });

  it('cleanup-news-sitemap.mjs references only the dash-separated form', () => {
    const file = path.join(ROOT, 'scripts', 'cleanup-news-sitemap.mjs');
    const src = fs.readFileSync(file, 'utf-8');

    expect(src).toContain('sitemap-news.xml');
    expect(src).not.toContain('sitemap_news.xml');
  });

  it('create-article.mjs writes only the dash-separated news sitemap', () => {
    const file = path.join(ROOT, 'scripts', 'create-article.mjs');
    const src = fs.readFileSync(file, 'utf-8');

    expect(src).toContain('public/sitemap-news.xml');
    expect(src).not.toContain('public/sitemap_news.xml');
    expect(src).not.toContain('sitemap_news.xml');
  });
});
