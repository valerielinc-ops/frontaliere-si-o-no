/**
 * GSC rich-results gate (FAQPage / structured data duplicates).
 *
 * Scans every emitted `dist/**\/*.html` page and asserts that no
 * `application/ld+json` block @type appears more than once on the
 * same page for types that Google requires to be unique.
 *
 * Google Rich Results validation flags as INVALID any page with two
 * `FAQPage` JSON-LD scripts — the rich result is then disqualified for
 * that URL (Search Console reports "Campo duplicato 'FAQPage'").
 *
 * Same constraint applies to other top-level page-scoped types
 * (`WebPage`, `CollectionPage`, `Article`, `NewsArticle`, `JobPosting`,
 * `BreadcrumbList`). Multiple `Organization` blocks are tolerated
 * because a curated employer brand may legitimately overlay the
 * generic site-wide Organization (Google merges them).
 *
 * Dist-driven: skips silently when `dist/` does not exist OR
 * `RUN_DIST_GATES=1` is not set, so `npx vitest run` continues to
 * work without a build. CI builds dist first and sets the env var.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SCAN_TEST_TIMEOUT_MS,
  assertScanCompleted,
  scanDistHtml,
} from './helpers/distHtmlScan';

const DIST_DIR = resolve(__dirname, '..', 'dist');

/**
 * Top-level @type values that MUST appear at most once per page in
 * separate JSON-LD scripts. Listed by Google's Rich Results validator
 * as page-scoped entities. Multiple instances of these types break
 * rich-result eligibility.
 *
 * Currently scoped to FAQPage only (the type GSC actively flags via
 * "Campo duplicato 'FAQPage'" in the Search Console enhancement
 * report). Other page-scoped types (WebPage, CollectionPage, Article,
 * NewsArticle, JobPosting, BreadcrumbList) have pre-existing
 * duplicate offenders in the current dist that will be addressed in a
 * follow-up; widening the gate here would block deploy without
 * fixing an actively-flagged GSC issue.
 */
const UNIQUE_TYPES: ReadonlySet<string> = new Set([
 'FAQPage',
]);

/**
 * Extract every `<script type="application/ld+json">…</script>` body
 * from the page. Returns the raw inner JSON strings.
 */
function extractLdJsonBlocks(html: string): string[] {
 const blocks: string[] = [];
 const re = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
 let m: RegExpExecArray | null;
 while ((m = re.exec(html)) !== null) blocks.push(m[1]);
 return blocks;
}

/**
 * Extract the top-level `@type` value(s) from a JSON-LD block. Handles
 * both string `"@type": "FAQPage"` and array `"@type": ["WebPage",
 * "CollectionPage"]` forms. Robust to malformed JSON (returns empty).
 */
function topLevelTypes(jsonBody: string): string[] {
 try {
 const parsed = JSON.parse(jsonBody);
 if (!parsed || typeof parsed !== 'object') return [];
 const t = (parsed as Record<string, unknown>)['@type'];
 if (typeof t === 'string') return [t];
 if (Array.isArray(t)) return t.filter((v): v is string => typeof v === 'string');
 return [];
 } catch {
 return [];
 }
}

describe('dist HTML — duplicate structured data gate (GSC rich-results)', () => {
 if (process.env.RUN_DIST_GATES !== '1' || !existsSync(DIST_DIR)) {
 it.skip('set RUN_DIST_GATES=1 after `npx vite build` to enable this gate', () => {});
 return;
 }

 // Scanning ~50k dist HTML files + JSON parsing each ld+json block is slow.
 // 60s ceiling matches dist-duplicate-meta-description's footprint.
 it('no UNIQUE_TYPES @type appears in two separate JSON-LD scripts on the same page', { timeout: SCAN_TEST_TIMEOUT_MS }, () => {
 const offenders: { file: string; type: string; count: number }[] = [];

 const scan = scanDistHtml(DIST_DIR, (relPath, html) => {
 const blocks = extractLdJsonBlocks(html);
 if (blocks.length < 2) return;

 const counts = new Map<string, number>();
 for (const body of blocks) {
 for (const t of topLevelTypes(body)) {
 if (!UNIQUE_TYPES.has(t)) continue;
 counts.set(t, (counts.get(t) ?? 0) + 1);
 }
 }
 for (const [type, count] of counts) {
 if (count > 1) {
 offenders.push({ file: relPath, type, count });
 }
 }
 });
 assertScanCompleted(
 scan,
 'duplicate structured data',
 offenders.map((o) => `${o.file}: ${o.type}×${o.count}`),
 );
 const scanElapsedMs = scan.elapsedMs;

 /**
  * OBSERVER for #5729: a bare "Test timed out in 60000ms" names no cause —
  * it took a manual bisection to find the per-entry `statSync` above. Half
  * of the hard 60s ceiling is the budget, so a corpus that keeps growing
  * turns red HERE, with the file count and elapsed time in the message,
  * one deploy before it silently trips the opaque vitest timeout again.
  * Widening this budget needs the same justification a raised timeout
  * would: a measured reason dist/ got bigger, not a shrug.
  */
 const SOFT_BUDGET_MS = 30_000;
 expect(
 scanElapsedMs,
 `dist scan+parse took ${scanElapsedMs}ms across ${scan.filesScanned} HTML files ` +
 `(soft budget ${SOFT_BUDGET_MS}ms, scan budget ${scan.budgetMs}ms). If dist/ grew, ` +
 `reduce the work — sample via AUDIT_SAMPLE_RATE, or register this invariant as an ` +
 `auditor in scripts/audit-all.mjs so it rides the single shared walk. Do NOT just ` +
 `raise the budget (#5729 is exactly that mistake, one corpus-size increase away ` +
 `from recurring).`,
 ).toBeLessThan(SOFT_BUDGET_MS);

 if (offenders.length > 0) {
 const grouped = new Map<string, { type: string; count: number }[]>();
 for (const o of offenders) {
 const arr = grouped.get(o.file) ?? [];
 arr.push({ type: o.type, count: o.count });
 grouped.set(o.file, arr);
 }
 const report = [...grouped.entries()]
 .slice(0, 20)
 .map(
 ([file, items]) =>
 ` - ${file}: ${items.map((i) => `${i.type}×${i.count}`).join(', ')}`,
 )
 .join('\n');
 const total = offenders.length;
 throw new Error(
 `Found ${total} duplicate-type structured-data violation(s) (GSC rich-results invalid).\nFirst ${Math.min(20, grouped.size)} pages:\n${report}\n\nGoogle requires page-scoped @types (FAQPage, WebPage, CollectionPage, Article, NewsArticle, JobPosting, BreadcrumbList) to appear at most once per page.\nFix: identify the build plugin emitting the duplicate and consolidate to a single JSON-LD script.`,
 );
 }
 expect(offenders.length).toBe(0);
 });
});
