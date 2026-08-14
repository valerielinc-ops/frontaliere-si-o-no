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
 * exist locally so `npm test` continues to work without a build.
 *
 * NOTE (2026-08-11): the opt-in switch below is `RUN_DIST_GATES=1`, and
 * grepping `.github/workflows/**` + `package.json` for it returns ZERO
 * hits — no job builds dist before vitest either (tests.yml has only
 * `typecheck` and `vitest (unit + integration)`, neither of which emits
 * dist). So this gate does not currently run anywhere; the description
 * reader below is kept correct so that enabling it is a one-line change
 * and not a debugging session. Wiring it is tracked separately.
 *
 * TODO(seo): once the fallback descriptions are parameterised in the
 * emit plugins (staticPagesPlugin, ogPagesPlugin, jobsSeoPagesPlugin),
 * tighten `MAX_DUPLICATE_PAGES_PER_DESCRIPTION` from 2 toward 1.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SCAN_TEST_TIMEOUT_MS,
  assertScanCompleted,
  scanDistHtml,
} from './helpers/distHtmlScan';
import { extractMetaDescriptionRaw } from '../scripts/lib/meta-description-extract.mjs';

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

/**
 * Shared quote-agnostic reader. The local pair of regexes this replaces
 * claimed to be "tolerant of attribute order and quote style" but required
 * literal quotes around `description`, which `removeAttributeQuotes`
 * (PR #478) strips on every minified page: the gate saw NOTHING on the whole
 * job funnel and could not have flagged a duplicate there. Measured on 200
 * production job pages: old readers 200/200 "missing", shared reader 0/200.
 */
function extractMetaDescription(html: string): string | null {
 return extractMetaDescriptionRaw(html);
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

 it(`no description appears on more than ${MAX_DUPLICATE_PAGES_PER_DESCRIPTION} pages`, { timeout: SCAN_TEST_TIMEOUT_MS }, () => {
 const byDescription = new Map<string, string[]>();

 const scan = scanDistHtml(DIST_DIR, (relPath, html) => {
 const desc = extractMetaDescription(html);
 if (!desc) return;
 if (ALLOWLIST_PREFIXES.some((p) => desc.startsWith(p))) return;
 const existing = byDescription.get(desc) ?? [];
 existing.push(relPath);
 byDescription.set(desc, existing);
 });
 assertScanCompleted(scan, 'duplicate meta description');

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
