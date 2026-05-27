/**
 * Phase 4C — Semrush E6 / Issue 6 gate (duplicate meta-descriptions).
 *
 * Scans every emitted `dist/**\/*.html` page and asserts that no
 * `<meta name="description">` content string appears on more than two
 * URLs. The audit recurringly flags 14+ pages sharing the same fallback
 * description ("Calcolatore stipendio…" and similar). Until the
 * underlying plugin fallbacks are parameterised with path-specific
 * keywords, this test acts as a CI gate so the count cannot grow.
 *
 * The test is dist-driven: it skips silently when `dist/` does not
 * exist locally so `npm test` continues to work without a build. CI
 * builds dist before running tests, so the gate is enforced in CI.
 *
 * TODO(seo): once the fallback descriptions are parameterised in the
 * emit plugins (staticPagesPlugin, ogPagesPlugin, jobsSeoPagesPlugin),
 * tighten `MAX_DUPLICATE_PAGES_PER_DESCRIPTION` from 2 toward 1.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST_DIR = resolve(__dirname, '..', 'dist');
const MAX_DUPLICATE_PAGES_PER_DESCRIPTION = 2;

/**
 * Description prefixes that are known to be duplicated by design
 * (boilerplate landing pages, error pages, hub stubs). Excluded from
 * the gate so the test only flags accidental duplication.
 */
const ALLOWLIST_PREFIXES: readonly string[] = [
 // 404 / soft-404 stubs share the same noindex description by design.
 'Pagina non trovata',
 'Page not found',
 'Seite nicht gefunden',
 'Page introuvable',
];

function walkHtml(dir: string, out: string[] = []): string[] {
 if (!existsSync(dir)) return out;
 for (const entry of readdirSync(dir)) {
 const full = join(dir, entry);
 const st = statSync(full);
 if (st.isDirectory()) walkHtml(full, out);
 else if (entry.endsWith('.html')) out.push(full);
 }
 return out;
}

function extractMetaDescription(html: string): string | null {
 // Tolerant of attribute order and quote style.
 const match = html.match(
 /<meta\s+(?:[^>]*\s)?name=["']description["'][^>]*\scontent=["']([^"']*)["'][^>]*>/i,
 );
 if (match) return match[1];
 const reverse = html.match(
 /<meta\s+(?:[^>]*\s)?content=["']([^"']*)["'][^>]*\sname=["']description["'][^>]*>/i,
 );
 return reverse ? reverse[1] : null;
}

describe('dist HTML — duplicate meta description gate (Semrush E6)', () => {
 // Opt-in: only run against a freshly rebuilt dist. Local development and the
 // default `npx vitest run` do NOT rebuild dist between runs, so the gate
 // would otherwise flag stale output that the source has already fixed. CI
 // sets RUN_DIST_GATES=1 after `npx vite build` so the gate is enforced
 // against the just-emitted HTML.
 if (process.env.RUN_DIST_GATES !== '1' || !existsSync(DIST_DIR)) {
 it.skip('set RUN_DIST_GATES=1 after `npx vite build` to enable this gate', () => {});
 return;
 }

 it(`no description appears on more than ${MAX_DUPLICATE_PAGES_PER_DESCRIPTION} pages`, () => {
 const files = walkHtml(DIST_DIR);
 const byDescription = new Map<string, string[]>();

 for (const file of files) {
 const html = readFileSync(file, 'utf-8');
 const desc = extractMetaDescription(html);
 if (!desc) continue;
 if (ALLOWLIST_PREFIXES.some((p) => desc.startsWith(p))) continue;
 const existing = byDescription.get(desc) ?? [];
 existing.push(file.replace(DIST_DIR, ''));
 byDescription.set(desc, existing);
 }

 const offenders: { description: string; pages: string[] }[] = [];
 for (const [desc, pages] of byDescription) {
 if (pages.length > MAX_DUPLICATE_PAGES_PER_DESCRIPTION) {
 offenders.push({ description: desc.slice(0, 100), pages });
 }
 }

 if (offenders.length > 0) {
 const report = offenders
 .map(
 (o) =>
 `  - "${o.description}…" on ${o.pages.length} pages: ${o.pages.slice(0, 5).join(', ')}${o.pages.length > 5 ? ', …' : ''}`,
 )
 .join('\n');
 throw new Error(
 `Found ${offenders.length} description(s) duplicated on more than ${MAX_DUPLICATE_PAGES_PER_DESCRIPTION} pages:\n${report}\n\nFix: parameterise the plugin fallback with path-specific keywords (see Phase 4C TODO in this test).`,
 );
 }
 expect(offenders.length).toBe(0);
 });
});
