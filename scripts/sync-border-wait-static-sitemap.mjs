#!/usr/bin/env node
/**
 * sync-border-wait-static-sitemap.mjs — regenerates the `/guida-frontaliere/
 * tempi-attesa-dogana/{crossing}/` block of the committed, static
 * `public/sitemap-pages.xml` from `BORDER_WAIT_CROSSINGS`
 * (build-plugins/borderWaitData.ts), the single registry that also drives
 * `services/router.ts`'s `ALL_BORDER_CROSSING_IDS` and the dynamic
 * `dist/sitemap-border-wait.xml` (build-plugins/borderWaitPagesPlugin.ts).
 *
 * WHY THIS SCRIPT EXISTS (#4952 root cause): `public/sitemap-pages.xml` is
 * NOT rebuilt by Vite — `build-plugins/sitemapAliasPlugin.ts` documents that
 * it and its sibling `sitemap-*.xml` files are "seeded by public/ and copied
 * into dist/ by Vite", i.e. a plain static file. Historically the per-crossing
 * `<url>` blocks for the `/guida-frontaliere/tempi-attesa-dogana/{id}/` SPA
 * deep link (services/router.ts guida/border sub-tab) were hand-edited into
 * this file one crossing at a time (see commit cc9fafd3, "Add the two SPA
 * valico/ URLs to the committed public/sitemap-pages.xml."). Issue #4889
 * expanded BORDER_WAIT_CROSSINGS from 26 to 93 (German corridor) but nobody
 * hand-edited this file for the other 67 — a duplicated-list drift exactly
 * like the ones AGENTS.md #6 warns about. This script makes the block
 * *derived*, not hand-maintained, so the next corridor (e.g. Austria) only
 * needs `BORDER_WAIT_CROSSINGS` updated + this script re-run — never a
 * second manual copy of the crossing list.
 *
 * URL construction reuses `SLUG_TABLES` from `services/routeSlugs.data.ts`
 * (the project's documented side-effect-free, Node-script-safe mirror of
 * services/router.ts's per-locale slug table, #4315) — NOT a re-typed copy
 * of the locale path segments. The regenerated URLs are therefore
 * byte-identical to what `buildPath({activeTab:'guida', guidaSubTab:'border',
 * borderCrossing:id}, locale)` produces (verified by
 * tests/seo-completeness.test.ts's "Sitemap URLs match router buildPath"
 * suite).
 *
 * Only the contiguous run of per-crossing `<url>` blocks right after the
 * `/guida-frontaliere/tempi-attesa-dogana/` hub block is touched. The hub
 * block itself and every other page in the file are left byte-identical.
 * Existing crossings keep their original <lastmod> (no manufactured churn);
 * newly-added crossings get today's date (or TODAY_ISO override, for
 * deterministic re-runs/tests).
 *
 * MUST run under tsx (imports .ts modules) — same constraint as
 * scripts/generate-border-wait-ranking-article.mjs.
 *
 * Usage:
 *   npx tsx scripts/sync-border-wait-static-sitemap.mjs             # write
 *   DRY_RUN=1 npx tsx scripts/sync-border-wait-static-sitemap.mjs    # report only
 *   TODAY_ISO=2027-01-01 npx tsx scripts/sync-border-wait-static-sitemap.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BORDER_WAIT_CROSSINGS } from '../build-plugins/borderWaitData.ts';
import { SLUG_TABLES } from '../services/routeSlugs.data.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const SITEMAP_PATH = path.join(REPO_ROOT, 'public', 'sitemap-pages.xml');
const BASE_URL = 'https://frontaliereticino.ch';
const LOCALES = ['it', 'en', 'de', 'fr'];
const TODAY = process.env.TODAY_ISO || new Date().toISOString().slice(0, 10);
const DRY_RUN = process.env.DRY_RUN === '1';

/** `/` for it, `/{locale}` otherwise — mirrors services/router.ts's localePrefix(). */
function localePrefix(locale) {
  return locale === 'it' ? '' : `/${locale}`;
}

/** Canonical path for a crossing's guida/border deep link, one locale. */
function crossingPath(locale, crossingId) {
  const table = SLUG_TABLES[locale];
  return `${localePrefix(locale)}/${table.guida}/${table.border}/${crossingId}/`;
}

function buildCrossingUrlBlock(crossingId, lastmod) {
  const itPath = crossingPath('it', crossingId);
  const lines = [];
  lines.push('  <url>');
  lines.push(`    <loc>${BASE_URL}${itPath}</loc>`);
  for (const locale of LOCALES) {
    lines.push(
      `    <xhtml:link rel="alternate" hreflang="${locale}" href="${BASE_URL}${crossingPath(locale, crossingId)}" />`,
    );
  }
  lines.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE_URL}${itPath}" />`);
  lines.push(`    <lastmod>${lastmod}</lastmod>`);
  lines.push('    <changefreq>weekly</changefreq>');
  lines.push('    <priority>0.7</priority>');
  lines.push('  </url>');
  return lines.join('\n');
}

function main() {
  const xml = readFileSync(SITEMAP_PATH, 'utf-8');
  // Blocks are 2-space-indented `<url>` entries, one per line-start.
  const blocks = xml.split(/(?=  <url>\n)/);

  const isCrossingBlock = (block) =>
    /<loc>https:\/\/frontaliereticino\.ch\/guida-frontaliere\/tempi-attesa-dogana\/[a-z0-9-]+\/<\/loc>/.test(
      block,
    );
  const hubIdx = blocks.findIndex((block) =>
    block.includes(
      '<loc>https://frontaliereticino.ch/guida-frontaliere/tempi-attesa-dogana/</loc>',
    ),
  );
  if (hubIdx === -1) {
    throw new Error(
      'sync-border-wait-static-sitemap: could not find the /guida-frontaliere/tempi-attesa-dogana/ hub block in public/sitemap-pages.xml — refusing to guess an insertion point.',
    );
  }

  // Existing crossing lastmod values, preserved for unchanged crossings.
  const existingLastmod = new Map();
  let firstCrossingIdx = -1;
  let lastCrossingIdx = -1;
  for (let i = hubIdx + 1; i < blocks.length; i++) {
    if (!isCrossingBlock(blocks[i])) {
      if (firstCrossingIdx !== -1) break; // contiguous run ended
      continue;
    }
    if (firstCrossingIdx === -1) firstCrossingIdx = i;
    lastCrossingIdx = i;
    const slugMatch = blocks[i].match(
      /<loc>https:\/\/frontaliereticino\.ch\/guida-frontaliere\/tempi-attesa-dogana\/([a-z0-9-]+)\/<\/loc>/,
    );
    const lastmodMatch = blocks[i].match(/<lastmod>([^<]+)<\/lastmod>/);
    if (slugMatch && lastmodMatch) existingLastmod.set(slugMatch[1], lastmodMatch[1]);
  }
  if (firstCrossingIdx === -1) {
    throw new Error(
      'sync-border-wait-static-sitemap: hub block found but no per-crossing block immediately follows it — refusing to guess an insertion point.',
    );
  }

  const regenerated = BORDER_WAIT_CROSSINGS.map((id) =>
    buildCrossingUrlBlock(id, existingLastmod.get(id) || TODAY),
  );

  const before = blocks.slice(0, firstCrossingIdx).join('');
  const after = blocks.slice(lastCrossingIdx + 1).join('');
  // Blocks (except the very first, which carries the XML preamble) start
  // with '  <url>\n' and DON'T end with '\n' themselves — the trailing
  // newline lives at the start of the NEXT block. Re-join accordingly.
  const nextXml = `${before}${regenerated.join('\n')}\n${after}`;

  const added = BORDER_WAIT_CROSSINGS.filter((id) => !existingLastmod.has(id));
  const removed = [...existingLastmod.keys()].filter(
    (id) => !BORDER_WAIT_CROSSINGS.includes(id),
  );

  console.log(
    `[sync-border-wait-static-sitemap] ${existingLastmod.size} crossing(s) previously in sitemap-pages.xml, ${BORDER_WAIT_CROSSINGS.length} in BORDER_WAIT_CROSSINGS.`,
  );
  console.log(`[sync-border-wait-static-sitemap] adding ${added.length}: ${added.join(', ') || '(none)'}`);
  if (removed.length > 0) {
    console.log(
      `[sync-border-wait-static-sitemap] removing ${removed.length} (no longer in registry): ${removed.join(', ')}`,
    );
  }

  if (DRY_RUN) {
    console.log('[sync-border-wait-static-sitemap] DRY_RUN=1 — not writing.');
    return;
  }
  if (nextXml === xml) {
    console.log('[sync-border-wait-static-sitemap] already in sync — no write needed.');
    return;
  }
  writeFileSync(SITEMAP_PATH, nextXml, 'utf-8');
  console.log(`[sync-border-wait-static-sitemap] wrote ${SITEMAP_PATH}.`);
}

main();
