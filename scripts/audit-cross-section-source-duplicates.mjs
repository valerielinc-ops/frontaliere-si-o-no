#!/usr/bin/env node
/**
 * One-time measurement of cross-section source-URL duplicates already
 * published on the site (follow-up #5849, item 1).
 *
 * PR #5800 added a gate (`isSourceUrlAlreadyUsed` → `findCrossSectionSourceDuplicate`)
 * that stops a source document from producing an article in BOTH the
 * `frontaliere` and `svizzera` sections going forward. That gate never
 * measured how many such duplicates already existed in the ledgers from
 * before it shipped — this script does, using the already-tested
 * `listCrossSectionDuplicates` (scripts/lib/cross-section-dedup.mjs).
 *
 * Not every URL scheme in the ledgers is a "same source document reused"
 * case worth remediating: `discovery://` keys mark a discovered entity name
 * (not a fetched document — reusing the entity across sections is by
 * design), and relative-path keys are internal references, not external
 * news. Both are reported separately from genuine external http(s) news
 * source reuse, which is the actual duplicate-content signal.
 *
 * Usage: node scripts/audit-cross-section-source-duplicates.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { listCrossSectionDuplicates } from './lib/cross-section-dedup.mjs';

const LEDGERS = {
  frontaliere: 'data/article-source-urls.json',
  svizzera: 'data/swiss-article-source-urls.json',
};

/**
 * Splits raw duplicate candidates by URL scheme: only `external` is a real
 * "same source document reused across sections" case (see file docblock).
 */
export function bucketCrossSectionDuplicates(dups) {
  const buckets = { empty: [], discovery: [], relative: [], external: [] };
  for (const dup of dups) {
    if (dup.url === '') buckets.empty.push(dup);
    else if (dup.url.startsWith('discovery://')) buckets.discovery.push(dup);
    else if (dup.url.startsWith('http')) buckets.external.push(dup);
    else buckets.relative.push(dup);
  }
  return buckets;
}

function loadLedger(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function main() {
  const ledgersBySection = Object.fromEntries(
    Object.entries(LEDGERS).map(([section, path]) => [section, loadLedger(path)])
  );

  const totalEntries = Object.values(ledgersBySection)
    .reduce((n, ledger) => n + Object.keys(ledger).length, 0);

  const dups = listCrossSectionDuplicates(ledgersBySection);
  const buckets = bucketCrossSectionDuplicates(dups);

  console.log(`Cross-section source URL duplicates: ${dups.length} raw candidates (of ${totalEntries} ledger entries across ${Object.keys(ledgersBySection).length} sections)`);
  console.log(`  empty-key artifact (not a real source doc): ${buckets.empty.length}`);
  console.log(`  discovery:// pseudo-URL (entity marker, reuse by design): ${buckets.discovery.length}`);
  console.log(`  relative-path source (internal reference, not external news): ${buckets.relative.length}`);
  console.log(`  external http(s) news source reused across sections: ${buckets.external.length}  <- genuine duplicate-content candidates`);
  console.log('');

  for (const dup of buckets.external) {
    console.log(dup.url);
    for (const s of dup.sections) console.log(`  ${s.section}: ${s.articleId}`);
  }
}

const invokedPath = process.argv[1] ? process.argv[1] : '';
const thisPath = fileURLToPath(import.meta.url);
if (invokedPath === thisPath) main();
