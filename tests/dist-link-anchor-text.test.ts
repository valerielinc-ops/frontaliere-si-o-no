/**
 * Phase 4C — Semrush A3 / Issue 216 (links without anchor text) and
 * A11 / Issue 217 (non-descriptive anchor text) gate.
 *
 * Scans every emitted `dist/**\/*.html` page and counts `<a>` tags that
 * provide no accessible name to assistive tech / search crawlers, as
 * well as known non-descriptive anchor strings ("qui", "here",
 * "click here", "leggi tutto", "read more", …).
 *
 * An anchor is considered to have an accessible name when ANY of the
 * following holds:
 *   - it has non-empty visible text (after stripping nested tags)
 *   - it has a non-empty `aria-label` or `aria-labelledby`
 *   - it has a non-empty `title`
 *   - it wraps an `<img>` with a non-empty `alt`
 *   - it wraps an `<svg>` with `role="img"` + `<title>` (or `aria-label`)
 *
 * The audit reports 888 offending links (+23 new); this gate caps the
 * count at the current observed budget so the regression cannot grow.
 * Lower the cap as the underlying components are fixed.
 *
 * The test is dist-driven: it skips silently when `dist/` does not
 * exist locally.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST_DIR = resolve(__dirname, '..', 'dist');

/**
 * Cap on the total number of `<a>` tags lacking an accessible name
 * across all emitted dist pages. The Semrush audit reports ~888 today;
 * we set the budget at 1100 so the gate fires on regressions but does
 * not block the current shipping state. As components are migrated to
 * always include anchor text / aria-label, decrement this number.
 */
const MAX_LINKS_WITHOUT_ANCHOR_TEXT = 1100;

/**
 * Anchor strings (case-insensitive, after trim) that are flagged as
 * non-descriptive. Matches Semrush A11 / Issue 217 catalog.
 */
const NON_DESCRIPTIVE_ANCHOR_TEXT = new Set<string>([
 'qui',
 'here',
 'click here',
 'clicca qui',
 'leggi',
 'leggi tutto',
 'leggi di più',
 'read more',
 'scopri',
 'scopri di più',
 'continua',
 'continue',
 'vedi',
 'vedi tutto',
 'more',
 'di più',
 'mehr',
 'plus',
 'en savoir plus',
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
 * Returns true when the anchor's outer markup provides any accessible
 * name to assistive tech. Heuristic — does not parse the DOM.
 */
function hasAccessibleName(outer: string, inner: string): boolean {
 // 1. Non-empty visible text (after stripping nested tags + whitespace).
 const visible = inner.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
 if (visible.length > 0) return true;

 // 2. ARIA / title attributes on the anchor itself.
 if (/\saria-label\s*=\s*["'][^"']+["']/i.test(outer)) return true;
 if (/\saria-labelledby\s*=\s*["'][^"']+["']/i.test(outer)) return true;
 if (/\stitle\s*=\s*["'][^"']+["']/i.test(outer)) return true;

 // 3. Nested <img> with non-empty alt.
 const imgMatch = inner.match(/<img\b[^>]*\salt\s*=\s*["']([^"']*)["'][^>]*>/i);
 if (imgMatch && imgMatch[1].trim().length > 0) return true;

 // 4. Nested <svg> with title or aria-label.
 if (/<svg\b[^>]*\saria-label\s*=\s*["'][^"']+["'][^>]*>/i.test(inner)) return true;
 if (/<svg[\s\S]*?<title>[^<]+<\/title>/i.test(inner)) return true;

 return false;
}

interface AnchorInfo {
 readonly outer: string;
 readonly inner: string;
}

/**
 * Walks the HTML and yields anchor blocks (open tag + inner HTML) one
 * at a time. Naive — does not handle nested `<a>`, but the spec
 * forbids those. Skips anchors inside `<script>` / `<style>` / `<template>`.
 */
function* extractAnchors(html: string): IterableIterator<AnchorInfo> {
 const stripped = html
 .replace(/<script[\s\S]*?<\/script>/gi, '')
 .replace(/<style[\s\S]*?<\/style>/gi, '')
 .replace(/<template[\s\S]*?<\/template>/gi, '')
 .replace(/<!--[\s\S]*?-->/g, '');

 const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
 let m: RegExpExecArray | null;
 // eslint-disable-next-line no-cond-assign
 while ((m = re.exec(stripped)) !== null) {
 yield { outer: `<a${m[1]}>`, inner: m[2] };
 }
}

describe('dist HTML — link anchor text gate (Semrush A3 + A11)', () => {
 // Opt-in: only run against a freshly rebuilt dist. See sibling test
 // `dist-duplicate-meta-description.test.ts` for the rationale.
 if (process.env.RUN_DIST_GATES !== '1' || !existsSync(DIST_DIR)) {
 it.skip('set RUN_DIST_GATES=1 after `npx vite build` to enable this gate', () => {});
 return;
 }

 it(`fewer than ${MAX_LINKS_WITHOUT_ANCHOR_TEXT} anchors lack an accessible name`, () => {
 const files = walkHtml(DIST_DIR);
 let offending = 0;
 const sample: string[] = [];

 for (const file of files) {
 const html = readFileSync(file, 'utf-8');
 for (const a of extractAnchors(html)) {
 if (!hasAccessibleName(a.outer, a.inner)) {
 offending += 1;
 if (sample.length < 5) {
 sample.push(`${file.replace(DIST_DIR, '')} :: ${a.outer.slice(0, 120)}`);
 }
 }
 }
 }

 if (offending > MAX_LINKS_WITHOUT_ANCHOR_TEXT) {
 throw new Error(
 `Found ${offending} <a> tags without an accessible name (cap: ${MAX_LINKS_WITHOUT_ANCHOR_TEXT}). Sample:\n${sample.map((s) => `  - ${s}`).join('\n')}\n\nFix: add anchor text, aria-label, title, or alt-bearing nested <img> on the offending links.`,
 );
 }
 expect(offending).toBeLessThanOrEqual(MAX_LINKS_WITHOUT_ANCHOR_TEXT);
 });

 it('no anchor uses non-descriptive text ("qui", "click here", "leggi tutto", …)', () => {
 const files = walkHtml(DIST_DIR);
 const offenders: { path: string; text: string }[] = [];

 for (const file of files) {
 const html = readFileSync(file, 'utf-8');
 for (const a of extractAnchors(html)) {
 const visible = a.inner.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
 if (NON_DESCRIPTIVE_ANCHOR_TEXT.has(visible)) {
 offenders.push({ path: file.replace(DIST_DIR, ''), text: visible });
 }
 }
 }

 if (offenders.length > 0) {
 const report = offenders
 .slice(0, 20)
 .map((o) => `  - ${o.path} :: "${o.text}"`)
 .join('\n');
 throw new Error(
 `Found ${offenders.length} anchor(s) with non-descriptive text:\n${report}\n\nFix: replace with a descriptive phrase that names the destination (e.g. "Confronta i salari in Ticino" instead of "leggi tutto").`,
 );
 }
 expect(offenders.length).toBe(0);
 });
});
