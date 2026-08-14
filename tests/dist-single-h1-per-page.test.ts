/**
 * Phase 4C — Semrush W6 / Issue 104 gate (multiple H1 tags per page).
 *
 * Scans every emitted `dist/**\/*.html` page and asserts that each
 * page contains at most one `<h1>` element in the static / pre-hydration
 * HTML. Crawlers and Lighthouse score multi-H1 pages down because the
 * primary topic of the page becomes ambiguous.
 *
 * The audit currently flags 8 multi-H1 pages. The most common pattern
 * is mobile-vs-desktop conditional rendering inside an SPA component
 * that outputs both variants; the fix is to demote one to `<h2>` or
 * to use `class="visually-hidden"` so only one H1 is in the rendered
 * tree at any breakpoint. Until the source pattern is identified and
 * fixed, this test acts as a CI gate so the count cannot grow.
 *
 * The test is dist-driven: it skips silently when `dist/` does not
 * exist locally so `npm test` continues to work without a build.
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
 * Pages where a multi-H1 emit pattern is intentional and a single-H1
 * fix would require reworking shared chrome (e.g. a static-overlay hub
 * page that wraps editorial content). Add a path here only with a
 * GitHub issue reference explaining why.
 */
const ALLOWLIST_PATHS: readonly string[] = [];

/**
 * Counts `<h1>` opening tags in the static HTML, ignoring tags that
 * appear inside `<template>` blocks, JSON-LD scripts, or HTML comments.
 * The implementation strips those zones first, then counts a permissive
 * regex (`<h1[ \t\n>]`) that matches both bare `<h1>` and `<h1 class="…">`
 * but not, e.g., `<h10>` (no such tag) or stray `&lt;h1&gt;` text.
 */
function countH1Tags(html: string): number {
 const stripped = html
 .replace(/<!--[\s\S]*?-->/g, '')
 .replace(/<template[\s\S]*?<\/template>/gi, '')
 .replace(/<script[\s\S]*?<\/script>/gi, '')
 .replace(/<style[\s\S]*?<\/style>/gi, '');
 const matches = stripped.match(/<h1[\s>]/gi);
 return matches ? matches.length : 0;
}

describe('dist HTML — single H1 per page gate (Semrush W6)', () => {
 // Opt-in: only run against a freshly rebuilt dist. See sibling test
 // `dist-duplicate-meta-description.test.ts` for the rationale.
 if (process.env.RUN_DIST_GATES !== '1' || !existsSync(DIST_DIR)) {
 it.skip('set RUN_DIST_GATES=1 after `npx vite build` to enable this gate', () => {});
 return;
 }

 it('every emitted page has at most one <h1>', { timeout: SCAN_TEST_TIMEOUT_MS }, () => {
 const offenders: { path: string; count: number }[] = [];

 const scan = scanDistHtml(DIST_DIR, (path, html) => {
 if (ALLOWLIST_PATHS.includes(path)) return;
 const count = countH1Tags(html);
 if (count > 1) offenders.push({ path, count });
 });
 assertScanCompleted(
 scan,
 'single H1 per page',
 offenders.map((o) => `${o.path} → ${o.count} <h1> tags`),
 );

 if (offenders.length > 0) {
 const report = offenders
 .slice(0, 25)
 .map((o) => `  - ${o.path} → ${o.count} <h1> tags`)
 .join('\n');
 throw new Error(
 `Found ${offenders.length} page(s) with multiple <h1> tags:\n${report}\n\nFix: in the responsible component or plugin, demote the duplicate H1 to <h2>, or render only one variant at a time.`,
 );
 }
 expect(offenders.length).toBe(0);
 });
});
