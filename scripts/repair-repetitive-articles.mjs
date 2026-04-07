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

function detectRepetition(bodies) {
  const issues = [];
  const allBodies = ['body1', 'body2', 'body3'].map(k => bodies[k] || '');

  // Check repeated paragraphs
  for (const [idx, body] of allBodies.entries()) {
    const paragraphs = body.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 60);
    const seen = new Map();
    let dupeCount = 0;
    for (const p of paragraphs) {
      const norm = p.replace(/[.!?,;:\s]+$/g, '').toLowerCase().replace(/\s+/g, ' ');
      seen.set(norm, (seen.get(norm) || 0) + 1);
      if (seen.get(norm) > 1) dupeCount++;
    }
    if (dupeCount >= 3) issues.push(`body${idx + 1}: ${dupeCount} repeated paragraphs`);
  }

  // Check repeated sentences
  const allText = allBodies.join('\n\n');
  const sentences = allText.split(/[.!?]\s+/).map(s => s.trim().toLowerCase().replace(/\s+/g, ' ')).filter(s => s.length > 40);
  const sentCounts = new Map();
  for (const s of sentences) sentCounts.set(s, (sentCounts.get(s) || 0) + 1);
  const heavy = [...sentCounts.entries()].filter(([, c]) => c >= 4);
  if (heavy.length > 0) issues.push(`${heavy.length} sentences 4+ times (worst: ${heavy[0][1]}x)`);

  return issues;
}

function deduplicateBodies(bodies) {
  // First pass: cross-body sentence frequency
  const globalSentCounts = new Map();
  for (const field of ['body1', 'body2', 'body3']) {
    const text = bodies[field] || '';
    const sentences = text.split(/(?<=[.!?])\s+/).map(s => s.trim().toLowerCase().replace(/\s+/g, ' ')).filter(s => s.length > 30);
    for (const s of sentences) globalSentCounts.set(s, (globalSentCounts.get(s) || 0) + 1);
  }
  
  const result = {};
  const globalSeen = new Map(); // track cross-body sentence usage
  
  for (const field of ['body1', 'body2', 'body3']) {
    const text = bodies[field] || '';
    if (!text) continue;
    
    // Step 1: Deduplicate whole paragraphs
    const paragraphs = text.split(/\n\n+/);
    const seenParas = new Set();
    const unique = [];
    for (const p of paragraphs) {
      const norm = p.trim().replace(/[.!?,;:\s]+$/g, '').toLowerCase().replace(/\s+/g, ' ');
      if (norm.length < 60 || !seenParas.has(norm)) {
        seenParas.add(norm);
        unique.push(p);
      }
    }
    
    // Step 2: Within each paragraph, remove sentences repeated 3+ times globally
    const cleaned = unique.map(para => {
      const sentences = para.split(/(?<=[.!?])\s+/);
      if (sentences.length < 2) return para;
      const filtered = sentences.filter(s => {
        const norm = s.trim().toLowerCase().replace(/\s+/g, ' ');
        if (norm.length <= 30) return true;
        const globalCount = globalSentCounts.get(norm) || 1;
        if (globalCount < 3) return true;
        // Allow max 1 occurrence of heavily repeated sentences across all bodies
        const soFar = (globalSeen.get(norm) || 0) + 1;
        globalSeen.set(norm, soFar);
        return soFar <= 1;
      });
      return filtered.join(' ');
    }).filter(p => p.trim().length > 10);
    
    result[field] = cleaned.join('\n\n');
  }
  
  return result;
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
    const dedupedBodies = deduplicateBodies(localeBodies);
    let changed = false;

    for (const field of ['body1', 'body2', 'body3']) {
      if (!localeBodies[field] || !dedupedBodies[field]) continue;
      if (dedupedBodies[field] !== localeBodies[field]) {
        const key = `blog.article.${id}.${field}`;
        const oldPattern = new RegExp(`('${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':\\s*')(?:[^'\\\\]|\\\\.)*'`, 's');
        const newVal = escapeForTS(dedupedBodies[field]);
        content = content.replace(oldPattern, `$1${newVal}'`);
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
