/**
 * Phase 3A — Title length guard for the 6 SEO landing plugins refactored
 * for Semrush W2 (issue 102).
 *
 * Scope is intentionally narrow: only directories owned by the plugins
 * touched in Phase 3A are scanned. Pages outside this set (blog articles,
 * city editorials, legacy hubs) are tracked by other tests and have their
 * own title-length budgets handled by the article-seo helpers.
 *
 * The test gracefully no-ops when `dist/` doesn't exist.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');
const MAX_TITLE_LEN = 60;

function walkHtml(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkHtml(full, out);
    else if (e.isFile() && e.name.endsWith('.html')) out.push(full);
  }
  return out;
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title>([\s\S]*?)<\/title>/i);
  if (!m) return null;
  return m[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

const distExists = fs.existsSync(DIST_DIR);

describe('SEO landing pages — <title> ≤60 chars (Semrush W2)', () => {
  if (!distExists) {
    it.skip('dist/ missing — skipping (run `npx vite build` first)', () => {});
    return;
  }

  // Only scan paths emitted by the 6 Phase 3A plugins. Other dist/ subtrees
  // (job-detail pages, city categories, blog articles) have separate budgets
  // and tests. Each entry is a sector/segment slug rooted at its locale prefix.
  const JOB_SECTOR_SLUGS = ['infermieri', 'case-anziani', 'educatori'];
  const JOB_SECTOR_SLUGS_EN = ['nurses', 'elderly-care', 'educators'];
  const JOB_SECTOR_SLUGS_DE = ['pflegepersonal', 'altenpflege', 'erzieher'];
  const JOB_SECTOR_SLUGS_FR = ['infirmiers', 'maisons-retraite', 'educateurs'];

  const candidateRoots: string[] = [];
  const tryAdd = (...segs: string[]) => {
    const p = path.join(DIST_DIR, ...segs);
    if (fs.existsSync(p)) candidateRoots.push(p);
  };

  // jobSectorLanding (3 sectors × 4 locales = 12 pages)
  for (const s of JOB_SECTOR_SLUGS) tryAdd('cerca-lavoro-ticino', s);
  for (const s of JOB_SECTOR_SLUGS_EN) tryAdd('en', 'find-jobs-ticino', s);
  for (const s of JOB_SECTOR_SLUGS_DE) tryAdd('de', 'jobs-im-tessin', s);
  for (const s of JOB_SECTOR_SLUGS_FR) tryAdd('fr', 'trouver-emploi-tessin', s);

  // weeklyEmployers (entire tree)
  tryAdd('aziende-che-assumono');
  tryAdd('en', 'companies-hiring');
  tryAdd('de', 'unternehmen-die-einstellen');
  tryAdd('fr', 'entreprises-qui-recrutent');

  // jobMarketSnapshot (entire tree)
  tryAdd('mercato-lavoro-ticino');
  tryAdd('en', 'ticino-job-market');
  tryAdd('de', 'arbeitsmarkt-tessin');
  tryAdd('fr', 'marche-emploi-tessin');

  // healthPremiums (entire tree)
  tryAdd('cassa-malati');
  tryAdd('en', 'health-insurance');
  tryAdd('de', 'krankenkasse');
  tryAdd('fr', 'assurance-maladie');

  // orphanQuery landings
  tryAdd('ricerca');
  tryAdd('en', 'search');
  tryAdd('de', 'suche');
  tryAdd('fr', 'recherche');

  // fuelDaily (entire tree)
  for (const s of ['prezzo-benzina', 'prezzo-diesel']) tryAdd(s);
  for (const s of ['gasoline-price', 'diesel-price']) tryAdd('en', s);
  for (const s of ['benzinpreis', 'dieselpreis']) tryAdd('de', s);
  for (const s of ['prix-essence', 'prix-diesel']) tryAdd('fr', s);

  const files: string[] = [];
  for (const root of candidateRoots) walkHtml(root, files);
  const exclude = new Set<string>();

  it('finds at least one HTML file in dist/', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every <title> in dist/ is ≤60 chars', () => {
    const violations: Array<{ file: string; len: number; title: string }> = [];
    for (const file of files) {
      if (exclude.has(file)) continue;
      let html: string;
      try {
        html = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      const title = extractTitle(html);
      if (!title) continue;
      if (title.length > MAX_TITLE_LEN) {
        violations.push({
          file: path.relative(DIST_DIR, file),
          len: title.length,
          title,
        });
      }
    }
    if (violations.length > 0) {
      const sample = violations
        .slice(0, 10)
        .map((v) => `  ${v.file} (${v.len}): ${v.title}`)
        .join('\n');
      throw new Error(
        `Found ${violations.length} title(s) longer than ${MAX_TITLE_LEN} chars:\n${sample}${
          violations.length > 10 ? `\n  ...and ${violations.length - 10} more` : ''
        }`,
      );
    }
    expect(violations.length).toBe(0);
  });
});
