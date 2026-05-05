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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
 it('no UNIQUE_TYPES @type appears in two separate JSON-LD scripts on the same page', { timeout: 60_000 }, () => {
 const files = walkHtml(DIST_DIR);
 const offenders: { file: string; type: string; count: number }[] = [];

 for (const file of files) {
 const html = readFileSync(file, 'utf-8');
 const blocks = extractLdJsonBlocks(html);
 if (blocks.length < 2) continue;

 const counts = new Map<string, number>();
 for (const body of blocks) {
 for (const t of topLevelTypes(body)) {
 if (!UNIQUE_TYPES.has(t)) continue;
 counts.set(t, (counts.get(t) ?? 0) + 1);
 }
 }
 for (const [type, count] of counts) {
 if (count > 1) {
 offenders.push({ file: file.replace(DIST_DIR, ''), type, count });
 }
 }
 }

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
