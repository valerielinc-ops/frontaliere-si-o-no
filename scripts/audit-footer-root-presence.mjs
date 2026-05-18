#!/usr/bin/env node
/**
 * audit-footer-root-presence
 *
 * Guarantees every static HTML page that ships the staticOverlay shell
 * (`<main class="seo-static-content">`) also ships the `<div id="footer-root">`
 * portal target App.tsx reads via `document.getElementById('footer-root')`.
 *
 * Without that div, the footer falls back to inline render INSIDE `#root` and
 * paints ABOVE the static body — burying the page content under the entire
 * footer chrome (~1500 px on mobile). PR #243 fixed this for `/calcola-stipendio/*`
 * via build-plugins/staticPagesPlugin.ts; this audit prevents the regression
 * on any other plugin that emits the staticOverlay shell.
 *
 * Zero-tolerance: any page with `seo-static-content` but no `footer-root`
 * fails the deploy.
 *
 * Usage:
 *   node scripts/audit-footer-root-presence.mjs
 *   node scripts/audit-footer-root-presence.mjs --limit=20
 */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');

const args = process.argv.slice(2);
const LIMIT = (() => {
  const a = args.find((s) => s.startsWith('--limit='));
  return a ? Math.max(1, parseInt(a.split('=')[1], 10) || 30) : 30;
})();

const SEO_STATIC_RE = /<main\b[^>]*class=["'][^"']*\bseo-static-content\b/i;
const FOOTER_ROOT_RE = /<div\b[^>]*\bid=["']footer-root["']/i;

async function walk(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && p.endsWith('.html')) out.push(p);
    }
  }
  return out;
}

async function main() {
  const s = await stat(DIST).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.error(`audit-footer-root-presence: dist/ not found at ${DIST}. Run a build first.`);
    process.exit(2);
  }
  const files = await walk(DIST);
  const offenders = [];
  let scanned = 0;
  for (const file of files) {
    let html;
    try {
      html = await readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    if (!html || !SEO_STATIC_RE.test(html)) continue;
    scanned++;
    if (!FOOTER_ROOT_RE.test(html)) {
      offenders.push(relative(ROOT, file));
    }
  }
  console.log(
    `audit-footer-root-presence: scanned ${scanned} page(s) with <main class="seo-static-content">`,
  );
  if (offenders.length === 0) {
    console.log('PASS: every staticOverlay page also ships <div id="footer-root">.');
    process.exit(0);
  }
  console.error(`\nFAIL: ${offenders.length} page(s) ship <main class="seo-static-content"> WITHOUT a matching <div id="footer-root">.`);
  console.error(`The SPA footer will paint INSIDE #root, above the static body, burying the page content.`);
  console.error(`\nFirst ${Math.min(LIMIT, offenders.length)} offenders:`);
  for (const f of offenders.slice(0, LIMIT)) console.error(`  ${f}`);
  if (offenders.length > LIMIT) console.error(`  ... and ${offenders.length - LIMIT} more`);
  console.error(`\nHow to fix`);
  console.error(`----------`);
  console.error(`Emit <div id="footer-root"></div> as a sibling AFTER <main class="seo-static-content">`);
  console.error(`in the plugin that produced these pages. Reference implementation:`);
  console.error(`  build-plugins/staticPagesPlugin.ts:4271-4279 (PR #243)`);
  console.error(`  build-plugins/shared/seoPageShell.ts:188-193 (canonical helper)`);
  process.exit(1);
}

main().catch((err) => {
  console.error('audit-footer-root-presence: fatal', err);
  process.exit(2);
});
