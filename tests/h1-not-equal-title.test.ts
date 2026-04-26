/**
 * Phase 3A — H1 ≠ Title guard for the 6 SEO landing plugins refactored
 * for Semrush W3 (issue 105: 458 pages where H1 was identical to title).
 *
 * Scope is narrow on purpose — only the plugins Phase 3A touched. The test
 * no-ops when `dist/` doesn't exist.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(__dirname, '..', 'dist');

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

function extractText(html: string, tag: 'title' | 'h1'): string | null {
  const re =
    tag === 'title'
      ? /<title>([\s\S]*?)<\/title>/i
      : /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
  const m = html.match(re);
  if (!m) return null;
  return m[1]
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function stripBrand(s: string): string {
  // Title typically has " | Frontaliere Ticino" (or locale-specific brand);
  // strip it before comparing so we don't reward suffix-equality games.
  return s
    .replace(/\s*\|\s*Frontaliere Ticino\s*$/i, '')
    .replace(/\s*\|\s*Cross-border Workers Ticino\s*$/i, '')
    .replace(/\s*\|\s*Grenzgänger Tessin\s*$/i, '')
    .replace(/\s*\|\s*Frontaliers Tessin\s*$/i, '')
    .trim();
}

const distExists = fs.existsSync(DIST_DIR);

describe('SEO landing pages — H1 ≠ <title> (Semrush W3)', () => {
  if (!distExists) {
    it.skip('dist/ missing — skipping (run `npx vite build` first)', () => {});
    return;
  }

  // Same narrow scope as title-length.test.ts — only Phase 3A plugins.
  const JOB_SECTOR_SLUGS = ['infermieri', 'case-anziani', 'educatori'];
  const JOB_SECTOR_SLUGS_EN = ['nurses', 'elderly-care', 'educators'];
  const JOB_SECTOR_SLUGS_DE = ['pflegepersonal', 'altenpflege', 'erzieher'];
  const JOB_SECTOR_SLUGS_FR = ['infirmiers', 'maisons-retraite', 'educateurs'];

  const candidateRoots: string[] = [];
  const tryAdd = (...segs: string[]) => {
    const p = path.join(DIST_DIR, ...segs);
    if (fs.existsSync(p)) candidateRoots.push(p);
  };

  for (const s of JOB_SECTOR_SLUGS) tryAdd('cerca-lavoro-ticino', s);
  for (const s of JOB_SECTOR_SLUGS_EN) tryAdd('en', 'find-jobs-ticino', s);
  for (const s of JOB_SECTOR_SLUGS_DE) tryAdd('de', 'jobs-im-tessin', s);
  for (const s of JOB_SECTOR_SLUGS_FR) tryAdd('fr', 'trouver-emploi-tessin', s);
  tryAdd('aziende-che-assumono');
  tryAdd('en', 'companies-hiring');
  tryAdd('de', 'unternehmen-die-einstellen');
  tryAdd('fr', 'entreprises-qui-recrutent');
  tryAdd('mercato-lavoro-ticino');
  tryAdd('en', 'ticino-job-market');
  tryAdd('de', 'arbeitsmarkt-tessin');
  tryAdd('fr', 'marche-emploi-tessin');
  tryAdd('cassa-malati');
  tryAdd('en', 'health-insurance');
  tryAdd('de', 'krankenkasse');
  tryAdd('fr', 'assurance-maladie');
  tryAdd('ricerca');
  tryAdd('en', 'search');
  tryAdd('de', 'suche');
  tryAdd('fr', 'recherche');
  for (const s of ['prezzo-benzina', 'prezzo-diesel']) tryAdd(s);
  for (const s of ['gasoline-price', 'diesel-price']) tryAdd('en', s);
  for (const s of ['benzinpreis', 'dieselpreis']) tryAdd('de', s);
  for (const s of ['prix-essence', 'prix-diesel']) tryAdd('fr', s);

  const files: string[] = [];
  for (const root of candidateRoots) walkHtml(root, files);
  // Pre-existing legacy redirect bridge pages whose body is just "Pagina spostata".
  // Title and H1 intentionally match (it's a stub, both fields point to the same
  // human-readable label). Tracked separately; not introduced by Phase 3A.
  const exclude = new Set<string>([
    path.join(DIST_DIR, 'fr', 'prix-diesel', 'aujourd-hui', 'index.html'),
    path.join(DIST_DIR, 'fr', 'prix-diesel', 'aujourdhui', 'index.html'),
  ]);

  it('finds at least one HTML file in dist/', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('every page has H1 textually different from <title>', () => {
    const violations: Array<{ file: string; title: string; h1: string }> = [];
    for (const file of files) {
      if (exclude.has(file)) continue;
      let html: string;
      try {
        html = fs.readFileSync(file, 'utf-8');
      } catch {
        continue;
      }
      const title = extractText(html, 'title');
      const h1 = extractText(html, 'h1');
      if (!title || !h1) continue;
      const titleNorm = stripBrand(title).toLowerCase();
      const h1Norm = h1.toLowerCase();
      if (titleNorm === h1Norm) {
        violations.push({
          file: path.relative(DIST_DIR, file),
          title,
          h1,
        });
      }
    }
    if (violations.length > 0) {
      const sample = violations
        .slice(0, 10)
        .map((v) => `  ${v.file}\n    title: ${v.title}\n    h1:    ${v.h1}`)
        .join('\n');
      throw new Error(
        `Found ${violations.length} page(s) where H1 equals <title>:\n${sample}${
          violations.length > 10 ? `\n  ...and ${violations.length - 10} more` : ''
        }`,
      );
    }
    expect(violations.length).toBe(0);
  });
});
