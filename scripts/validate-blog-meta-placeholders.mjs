#!/usr/bin/env node

/**
 * Pipeline validation: ensures no blog-meta or seo-blog entry contains
 * literal placeholder template strings from create-article.mjs.
 *
 * Background:
 *  When the blog article generator (scripts/create-article.mjs) calls the LLM
 *  with a JSON skeleton template, the model occasionally returns the skeleton
 *  verbatim instead of filling it in. The result was that articles like
 *  fronteria-ticino-scarpata-airogno shipped to production with titles like
 *  "Titolo giornalistico con keyword (max 60 chars)" — visible to real users.
 *
 *  This validator scans services/locales/blog-meta-*.ts and
 *  services/seo/seo-blog.ts for any literal placeholder strings and exits 1
 *  if any are found, blocking the build.
 *
 *  Run from npm scripts and from .githooks/pre-push.
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Literal placeholder strings from the LLM JSON template in create-article.mjs.
// If any of these appear in a meta or seo-blog file, the LLM returned the
// template verbatim and we must block the build.
const PLACEHOLDER_PATTERNS = [
  'Titolo giornalistico con keyword',
  'Sottotitolo con dati concreti',
  'max 60 chars',
  'max 160 chars',
  'OG title (',
  'OG desc (',
  'Headline JSON-LD',
  'Meta description 150-160 chars',
  'SEO Title | Frontaliere Ticino',
  '6-8 keywords IT',
  'Breadcrumb 2-3 parole',
  'Lead giornalistico: FATTI',
  'Analisi tecnica: normative',
  'Azione pratica: procedura step-by-step',
];

const FILES_TO_SCAN = [];

// Add all blog-meta-{lang}.ts files
const localesDir = 'services/locales';
for (const file of readdirSync(localesDir)) {
  if (/^blog-meta-[a-z]{2}\.ts$/.test(file)) {
    FILES_TO_SCAN.push(join(localesDir, file));
  }
}

// Add seo-blog.ts
FILES_TO_SCAN.push('services/seo/seo-blog.ts');

// Add all blog body files
const blogBodyRoot = 'services/locales/blog-body';
try {
  const langEntries = readdirSync(blogBodyRoot).filter((name) => {
    try {
      return statSync(join(blogBodyRoot, name)).isDirectory();
    } catch {
      return false;
    }
  });
  for (const lang of langEntries) {
    const langDir = join(blogBodyRoot, lang);
    for (const file of readdirSync(langDir)) {
      if (file.endsWith('.ts')) {
        FILES_TO_SCAN.push(join(langDir, file));
      }
    }
  }
} catch (err) {
  // blog-body directory may not exist in some checkouts; that's fine
}

const violations = [];

for (const filePath of FILES_TO_SCAN) {
  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    console.error(`[validate-blog-meta-placeholders] cannot read ${filePath}: ${err.message}`);
    process.exit(2);
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (line.includes(pattern)) {
        violations.push({
          file: filePath,
          line: i + 1,
          pattern,
          context: line.trim().slice(0, 200),
        });
      }
    }
  }
}

if (violations.length === 0) {
  console.log(`[validate-blog-meta-placeholders] OK — scanned ${FILES_TO_SCAN.length} files, no LLM template placeholders found.`);
  process.exit(0);
}

console.error('');
console.error('❌ BLOG META PLACEHOLDER VALIDATION FAILED');
console.error('');
console.error(`Found ${violations.length} literal placeholder string(s) from create-article.mjs JSON template.`);
console.error('This means the LLM returned the skeleton verbatim instead of filling it in.');
console.error('');
console.error('Violations:');
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`);
  console.error(`    pattern: ${JSON.stringify(v.pattern)}`);
  console.error(`    line:    ${v.context}`);
}
console.error('');
console.error('Fix: rewrite the affected entries with real content matching the article body.');
console.error('See CLAUDE.md "Never accept thin content" + "Fix root cause".');
process.exit(1);
