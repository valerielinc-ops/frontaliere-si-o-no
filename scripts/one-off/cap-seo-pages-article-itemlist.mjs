#!/usr/bin/env node
/**
 * Trim the "Articoli Frontaliere" ItemList in services/seo/seo-pages.ts to the
 * first 100 entries — the only ones that ever reach a page.
 *
 * `staticPagesPlugin.ts` already caps this list at emission
 * (`ITEM_LIST_CAP = 100`), with a comment that spells out why: the list "grows
 * by ~1 entry per published article and now exceeds 900 items — that single
 * inline JSON-LD weighs ~170 KB and pushes the section index page over the
 * 200 KB Semrush page-weight budget. Google only needs the first ~100 items."
 *
 * It is now 3619 entries. Everything past the hundredth is parsed, bundled and
 * shipped to clients — `assets/seo-pages.js` is 1.13 MB — and then discarded at
 * render time. Trimming the source to exactly what emission keeps leaves the
 * served HTML byte-identical and takes ~630 KB out of that chunk.
 *
 * `numberOfItems` is deliberately NOT changed: it states how many items the
 * collection has, not how many are listed, and the emission cap already relies
 * on that distinction ("keep numberOfItems accurate (reflects total list
 * size)"). `appendArticleListItem` keeps incrementing it once this runs — it
 * just stops appending list entries past the cap.
 *
 * Usage:
 *   node scripts/one-off/cap-seo-pages-article-itemlist.mjs          # dry-run
 *   node scripts/one-off/cap-seo-pages-article-itemlist.mjs --apply  # write
 */
import fs from 'node:fs';
import path from 'node:path';
import { locateItemListBlock, ARTICLE_ITEM_LIST_CAP } from '../lib/seo-pages-article-list.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const PAGES_FILE = path.join(ROOT, 'services', 'seo', 'seo-pages.ts');
const APPLY = process.argv.includes('--apply');

const src = fs.readFileSync(PAGES_FILE, 'utf-8');
const block = locateItemListBlock(src);
if (!block) {
  console.error('::error::ItemList "Articoli Frontaliere" non trovata — nessuna modifica');
  process.exit(1);
}

const blockSrc = src.slice(block.blockStart, block.blockEnd);
const items = [...blockSrc.matchAll(/^[ \t]*\{ "@type": "ListItem".*\}[,]?$/gm)];
console.log(`ListItem trovati: ${items.length}`);

if (items.length <= ARTICLE_ITEM_LIST_CAP) {
  console.log(`già entro il cap (${ARTICLE_ITEM_LIST_CAP}) — nessuna modifica`);
  process.exit(0);
}

// Keep the first N verbatim; the cut starts at the end of item N.
const lastKept = items[ARTICLE_ITEM_LIST_CAP - 1];
const cutFrom = lastKept.index + lastKept[0].length;
const kept = blockSrc.slice(0, cutFrom).replace(/,\s*$/, '');
const tail = blockSrc.slice(cutFrom);
// Everything after the last kept item, up to the array close, goes away.
const closeIdx = tail.search(/\n[ \t]*\][,;]?/);
if (closeIdx < 0) {
  console.error('::error::chiusura array non trovata — nessuna modifica');
  process.exit(1);
}
const newBlockSrc = `${kept}${tail.slice(closeIdx)}`;
const next = src.slice(0, block.blockStart) + newBlockSrc + src.slice(block.blockEnd);

const removed = items.length - ARTICLE_ITEM_LIST_CAP;
const savedKb = ((src.length - next.length) / 1024).toFixed(0);
console.log(`rimossi: ${removed} ListItem (position ${ARTICLE_ITEM_LIST_CAP + 1}…${items.length})`);
console.log(`file: ${(src.length / 1024).toFixed(0)} KB → ${(next.length / 1024).toFixed(0)} KB (-${savedKb} KB)`);

const keptCount = [...newBlockSrc.matchAll(/\{ "@type": "ListItem"/g)].length;
if (keptCount !== ARTICLE_ITEM_LIST_CAP) {
  console.error(`::error::attesi ${ARTICLE_ITEM_LIST_CAP} ListItem dopo il taglio, trovati ${keptCount}`);
  process.exit(1);
}

if (APPLY) {
  fs.writeFileSync(PAGES_FILE, next);
  console.log('✅ scritto');
} else {
  console.log('ℹ️  dry-run — nessuna scrittura (usa --apply)');
}
