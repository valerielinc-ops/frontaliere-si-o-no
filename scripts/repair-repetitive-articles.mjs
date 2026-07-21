#!/usr/bin/env node
/**
 * repair-repetitive-articles.mjs — Deduplicate paragraphs in articles with AI loop content.
 * 
 * Scans all blog body files, detects repeated paragraphs/sentences,
 * and strips duplicates in-place across all 4 locales.
 *
 * Usage:
 *   node scripts/repair-repetitive-articles.mjs              # preview (dry-run)
 *   node scripts/repair-repetitive-articles.mjs --fix        # apply fixes
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { detectBodyRepetition, dedupeRepeatedParagraphs } from './lib/article-body-repetition.mjs';

const LOCALES = ['it', 'en', 'de', 'fr'];
const BODY_DIR = 'services/locales/blog-body';
const FIX = process.argv.includes('--fix');

function extractBodies(content, id) {
  const bodies = {};
  for (let i = 1; i <= 3; i++) {
    const key = `blog.article.${id}.body${i}`;
    const pattern = new RegExp(`'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*'((?:[^'\\\\]|\\\\.)*)'`, 's');
    const m = content.match(pattern);
    if (m) {
      bodies[`body${i}`] = m[1].replace(/\\'/g, "'").replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
    }
  }
  return bodies;
}

function escapeForTS(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '');
}

// Thin adapters over the shared detection/cleanup module (2026-07-21): this
// script used to carry its own copy of both, which had already drifted
// ahead of scripts/create-article.mjs's copy (this one already had the
// cross-paragraph sentence-strip that create-article.mjs's was missing —
// see article-body-repetition.mjs's doc comment for the incident that
// surfaced the gap). Single source of truth now.
function detectRepetition(bodies) {
  const { hasRepetition, reason } = detectBodyRepetition(bodies);
  return hasRepetition ? [reason] : [];
}

// Main
const itDir = join(BODY_DIR, 'it');
const files = readdirSync(itDir).filter(f => f.endsWith('.ts'));

let totalFixed = 0;
const fixedArticles = [];

for (const file of files) {
  const id = file.replace('.ts', '');
  const itContent = readFileSync(join(itDir, file), 'utf-8');
  const bodies = extractBodies(itContent, id);
  const issues = detectRepetition(bodies);
  
  if (issues.length === 0) continue;
  
  console.log(`\n❌ ${id}: ${issues.join('; ')}`);
  
  if (!FIX) continue;

  // Fix all 4 locales
  for (const locale of LOCALES) {
    const filePath = join(BODY_DIR, locale, file);
    let content;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch { continue; }

    const localeBodies = extractBodies(content, id);
    // Pass a shallow copy — dedupeRepeatedParagraphs mutates its argument,
    // and localeBodies is compared against the result below per field.
    const dedupedBodies = dedupeRepeatedParagraphs({ ...localeBodies });
    let changed = false;

    for (const field of ['body1', 'body2', 'body3']) {
      if (!localeBodies[field] || !dedupedBodies[field]) continue;
      if (dedupedBodies[field] !== localeBodies[field]) {
        const key = `blog.article.${id}.${field}`;
        const oldPattern = new RegExp(`('${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*')(?:[^'\\\\]|\\\\.)*'`, 's');
        const newVal = escapeForTS(dedupedBodies[field]);
        // Replacer FUNCTION — newVal is real article body text and a literal
        // "$" + digit inside it (e.g. a dollar amount) would otherwise be
        // re-expanded as a $1 capture-group backreference by
        // String.prototype.replace() (docs/AGENTS-HISTORY.md#blog-meta-replace-backref).
        content = content.replace(oldPattern, (_m, g1) => `${g1}${newVal}'`);
        changed = true;
      }
    }

    if (changed) {
      writeFileSync(filePath, content, 'utf-8');
      console.log(`  ✅ Fixed ${locale}/${file}`);
    }
  }

  totalFixed++;
  fixedArticles.push(id);
}

console.log(`\n${'='.repeat(60)}`);
console.log(`Scanned: ${files.length} articles`);
console.log(`Issues found: ${totalFixed > 0 || !FIX ? 'see above' : 'none'}`);
if (FIX) {
  console.log(`Fixed: ${totalFixed} articles across ${LOCALES.length} locales`);
  console.log(`Articles: ${fixedArticles.join(', ')}`);
} else {
  console.log(`\nRun with --fix to apply changes`);
}
