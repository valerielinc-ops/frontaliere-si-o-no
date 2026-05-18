/**
 * Regression gate: every staticOverlay `/calcola-stipendio/*` page emitted by
 * `staticPagesPlugin.ts` MUST include `<div id="footer-root"></div>` as a
 * sibling of `<main class="seo-static-content">`. App.tsx (line 2387) reads
 * `document.getElementById('footer-root')` to portal the footer below the SEO
 * content in lite-shell mode. When the portal target is missing, React falls
 * back to inline render INSIDE `#root` — painting the entire footer chrome
 * (~1500 px tall) ABOVE the static content and burying the actual page.
 *
 * Background: PR #215 refactored the salary-landing body via
 * `renderSalaryLandingShell` but `staticPagesPlugin.ts:4128-4134` kept its own
 * hand-rolled HTML wrapper that diverged from the canonical
 * `buildSeoPageHtml` (build-plugins/shared/seoPageShell.ts:188-193). Live curl
 * on 2026-05-18 showed `#footer-root` missing on 10 IT salary URLs.
 *
 * Dist-driven: skips silently when `dist/` is absent (so `npm test` works
 * without a build). CI runs `npm run build:ci` before tests, enforcing the
 * gate end-to-end.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIST_DIR = resolve(__dirname, '..', 'dist');

/** Locale-prefixed roots that route through `buildSalaryLandingBody`. */
const SALARY_ROOTS: readonly string[] = [
  'calcola-stipendio',
  'calculate-salary',
  'gehalt-berechnen',
  'calculer-salaire',
];

function walkHtml(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walkHtml(full, out);
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

function collectSalaryPages(): string[] {
  if (!existsSync(DIST_DIR)) return [];
  const all: string[] = [];
  for (const root of SALARY_ROOTS) {
    // IT lives at /calcola-stipendio/, others at /<locale>/<root>/
    const direct = join(DIST_DIR, root);
    if (existsSync(direct)) walkHtml(direct, all);
    for (const locale of ['en', 'de', 'fr']) {
      const localized = join(DIST_DIR, locale, root);
      if (existsSync(localized)) walkHtml(localized, all);
    }
  }
  return all;
}

describe('staticOverlay salary-hub pages emit the footer portal target', () => {
  const pages = collectSalaryPages();

  if (pages.length === 0) {
    it.skip('dist/ not populated — run `npm run build` to enforce', () => {
      // no-op
    });
    return;
  }

  it('every /calcola-stipendio/* page contains <div id="footer-root">', () => {
    const offenders: string[] = [];

    for (const file of pages) {
      const html = readFileSync(file, 'utf-8');

      // Only check pages that use the lite-shell staticOverlay pattern
      // (these have <main class="seo-static-content">). Pure SPA-bundle
      // pages without that marker handle the footer inline inside #root.
      if (!html.includes('class="seo-static-content"')) continue;

      if (!html.includes('<div id="footer-root">')) {
        offenders.push(file.replace(`${DIST_DIR}/`, ''));
      }
    }

    expect(
      offenders,
      `Missing <div id="footer-root"></div> in ${offenders.length} salary-hub page(s). ` +
        `Without the portal target, App.tsx renders the footer above the static content ` +
        `(burying the page under ~1500 px of chrome). Sample: ${offenders.slice(0, 5).join(', ')}`,
    ).toEqual([]);
  });

  it('footer-root sibling comes AFTER main.seo-static-content in DOM order', () => {
    const offenders: string[] = [];

    for (const file of pages) {
      const html = readFileSync(file, 'utf-8');
      if (!html.includes('class="seo-static-content"')) continue;

      const mainIdx = html.indexOf('class="seo-static-content"');
      const footerIdx = html.indexOf('<div id="footer-root">');
      if (footerIdx === -1) continue; // covered by the previous test

      if (footerIdx < mainIdx) {
        offenders.push(file.replace(`${DIST_DIR}/`, ''));
      }
    }

    expect(
      offenders,
      `<div id="footer-root"> appears BEFORE <main class="seo-static-content"> in ${offenders.length} page(s). ` +
        `App.tsx portals the footer into #footer-root; if it sits above the main, the footer paints above the content.`,
    ).toEqual([]);
  });
});
