#!/usr/bin/env node
/**
 * Backfill script — assigns `authorSlug`/`authorName` to every article entry
 * in `data/blog-articles-data.ts` that doesn't already have one. Authors are
 * spread round-robin across the registry (marco-ferrari, laura-bianchi,
 * redazione, repeat) so legacy articles get a real Person byline for the
 * NewsArticle JSON-LD upgrade in A2.
 *
 * Idempotent: re-running the script only touches entries still missing the
 * fields, so it's safe to run after partial backfills.
 *
 * Spec: docs/GOOGLE-NEWS-COMPLIANCE-PLAN.md §4 — FASE 1, A2.
 *
 * Usage:
 *   node scripts/backfill-article-authors.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_FILE = path.join(PROJECT_ROOT, 'data/blog-articles-data.ts');

// Registry mirror — keep in sync with data/authors.ts.
const AUTHORS = [
  { slug: 'marco-ferrari', name: 'Marco Ferrari' },
  { slug: 'laura-bianchi', name: 'Laura Bianchi' },
  { slug: 'redazione', name: 'Redazione Frontaliere Ticino' },
];

function escapeForSingleQuoteTS(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function backfill() {
  let src = readFileSync(DATA_FILE, 'utf8');
  // Some legacy entries are written tight (`},{` or `}, {` on a single line).
  // Normalise them to one entry per block so the entry regex below matches
  // uniformly. The trailing `,\n` is preserved, and we add a newline before
  // `{`.
  src = src.replace(/\},\s*\{/g, '},\n  {');

  // Match each entry `{ ... }` inside the ARTICLES array (multi-line).
  // We anchor on the opening `{\n id: '...',` and close at the matching `},`.
  // Strategy: split by entry boundaries using a regex that captures full entries.
  // Each entry starts on a line with only `{` (after possibly some indent) and
  // ends at `},` on its own line.
  const entryRe = /(^[ \t]*\{\n(?:.*\n)*?[ \t]*\},\n)/gm;

  let updated = 0;
  let entryIndex = 0;
  const newSrc = src.replace(entryRe, (entry) => {
    // Skip the array opener block (no `id:` on the first line).
    if (!/\n\s*id:\s*['"]/.test(entry)) return entry;

    if (/\bauthorSlug:\s*['"]/.test(entry)) {
      // Already backfilled — leave it. Still advance the round-robin pointer
      // so previously-backfilled entries don't perturb future assignments.
      entryIndex += 1;
      return entry;
    }

    const author = AUTHORS[entryIndex % AUTHORS.length];
    entryIndex += 1;

    // Detect indent of property lines (e.g., ` `, ` `, or 2-space).
    const propMatch = entry.match(/\n([ \t]+)id:\s*['"]/);
    const propIndent = propMatch ? propMatch[1] : ' ';

    // Insert authorSlug/authorName before the closing `},`.
    const insertion =
      `${propIndent}authorSlug: '${escapeForSingleQuoteTS(author.slug)}',\n` +
      `${propIndent}authorName: '${escapeForSingleQuoteTS(author.name)}',\n`;

    const closingRe = /(\n)([ \t]*\},\n)$/;
    if (!closingRe.test(entry)) return entry;
    updated += 1;
    return entry.replace(closingRe, `$1${insertion}$2`);
  });

  if (newSrc === src) {
    console.log('No entries needed backfill — every article already has authorSlug.');
    return 0;
  }

  writeFileSync(DATA_FILE, newSrc, 'utf8');
  console.log(`Backfilled ${updated} article(s) with authorSlug/authorName.`);
  console.log(`Author distribution: round-robin across ${AUTHORS.map((a) => a.slug).join(', ')}.`);
  return updated;
}

const updated = backfill();
process.exit(updated >= 0 ? 0 : 1);
