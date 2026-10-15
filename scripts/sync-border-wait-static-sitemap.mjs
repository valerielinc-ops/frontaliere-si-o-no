#!/usr/bin/env node
/**
 * Remove the retired guide-root border-wait URLs from the committed seed
 * sitemap. The live data-driven routes are emitted by
 * `borderWaitPagesPlugin.ts` into `sitemap-border-wait.xml`; this script is
 * retained as the explicit migration command for the static seed file.
 *
 * Usage:
 *   npx tsx scripts/sync-border-wait-static-sitemap.mjs
 *   DRY_RUN=1 npx tsx scripts/sync-border-wait-static-sitemap.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BORDER_WAIT_LEGACY_REDIRECTS } from '../build-plugins/shared/borderWaitLegacyRedirects.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const SITEMAP_PATH = path.join(REPO_ROOT, 'public', 'sitemap-pages.xml');
const DRY_RUN = process.env.DRY_RUN === '1';

function locPathname(loc) {
  try {
    return new URL(loc).pathname;
  } catch {
    return loc.startsWith('/') ? loc : null;
  }
}

function pruneLegacyBorderBlocks(xml) {
  const legacyPaths = new Set(BORDER_WAIT_LEGACY_REDIRECTS.keys());
  const dropped = [];
  const out = xml.replace(/[ \t]*<url>[\s\S]*?<\/url>\n?/g, (block) => {
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1]?.trim();
    const pathname = loc ? locPathname(loc) : null;
    const normalized = pathname ? `${pathname.replace(/\/+$/, '')}/` : null;
    if (!normalized || !legacyPaths.has(normalized)) return block;
    dropped.push(normalized);
    return '';
  });
  return { xml: out, dropped };
}

function main() {
  const xml = readFileSync(SITEMAP_PATH, 'utf-8');
  const { xml: nextXml, dropped } = pruneLegacyBorderBlocks(xml);
  console.log(`[sync-border-wait-static-sitemap] ${dropped.length} retired border-wait URL(s) found in public/sitemap-pages.xml.`);
  if (DRY_RUN || nextXml === xml) return;
  writeFileSync(SITEMAP_PATH, nextXml, 'utf-8');
  console.log(`[sync-border-wait-static-sitemap] removed ${dropped.length} URL block(s).`);
}

main();
