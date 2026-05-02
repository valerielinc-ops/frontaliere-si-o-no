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

/**
 * Recursively collect candidate source files under one or more roots.
 * Skips node_modules, dist, .git, coverage, and build caches.
 */
function collectSources(roots: readonly string[]): string[] {
  const SKIP_DIRS = new Set([
    'node_modules',
    'dist',
    '.git',
    'coverage',
    '.vite',
    '.turbo',
    '.cache',
  ]);
  const SOURCE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|xml|txt|md|yml|yaml|html)$/i;

  const out: string[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.name !== '.github') continue;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(fullPath);
      } else if (entry.isFile() && SOURCE_EXT.test(entry.name)) {
        out.push(fullPath);
      }
    }
  }

  for (const root of roots) walk(path.join(ROOT, root));
  return out;
}

describe('sitemap-news canonical filename — A4 Google News compliance', () => {
  it('no source file emits the legacy underscore variant `sitemap_news.xml`', () => {
    const sources = collectSources([
      'build-plugins',
      'scripts',
      'public',
      'services',
      'components',
      'tests',
    ]);

    // Also include top-level config files
    const topLevel = ['vite.config.ts', 'package.json', 'tsconfig.json'];
    for (const f of topLevel) {
      const p = path.join(ROOT, f);
      if (fs.existsSync(p)) sources.push(p);
    }

    const offenders: { file: string; line: number; text: string }[] = [];

    for (const file of sources) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (ALLOWED_REFERENCES.has(rel)) continue;

      let content: string;
      try {
        content = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      if (!content.includes('sitemap_news')) continue;

      content.split('\n').forEach((line, idx) => {
        if (line.includes('sitemap_news')) {
          offenders.push({ file: rel, line: idx + 1, text: line.trim() });
        }
      });
    }

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
