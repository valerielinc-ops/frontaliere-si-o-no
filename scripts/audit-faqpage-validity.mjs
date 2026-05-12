#!/usr/bin/env node
/**
 * audit-faqpage-validity.mjs
 *
 * Post-build gate that fails on three FAQPage JSON-LD defects flagged by
 * Google Search Console as invalid structured-data and therefore ineligible
 * for FAQ rich results:
 *
 *   1. Duplicate FAQPage on one page (`Campo duplicato "FAQPage"`).
 *      GSC merges multiple FAQPage scripts but reports each instance as
 *      invalid.
 *   2. Missing `name` on a `mainEntity` Question (`Campo mancante "name"
 *      (in "mainEntity")`).
 *   3. Missing `text` on a Question's `acceptedAnswer` (`Campo mancante
 *      "text" (in "mainEntity.acceptedAnswer")`).
 *
 * Mirrors the vitest gate at tests/seo/faqpage-validity.test.ts; exposed as
 * a standalone script so post-build-tasks can run it in the same parallel
 * pool as the other dist audits.
 *
 * Exit codes:
 *   0 — no offenders
 *   1 — at least one offender (CI-blocking)
 *   2 — dist/ missing (gate cannot run; treated as fatal in CI)
 *
 * Usage:
 *   node scripts/audit-faqpage-validity.mjs               # fail on regressions
 *   node scripts/audit-faqpage-validity.mjs --limit=20    # show top-N examples
 *   node scripts/audit-faqpage-validity.mjs --json        # JSON report
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(__filename, '..', '..');
const DIST_DIR = resolve(ROOT, 'dist');

const args = process.argv.slice(2);
const getArg = (name) => {
  const eq = args.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = args.indexOf(name);
  return idx === -1 ? undefined : args[idx + 1];
};
const LIMIT = Number(getArg('--limit') ?? 20);
const JSON_OUT = args.includes('--json');

function walkHtml(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkHtml(full, out);
    else if (entry.endsWith('.html')) out.push(full);
  }
  return out;
}

function extractLdJsonBlocks(html) {
  const blocks = [];
  const re = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  return blocks;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function findFaqPages(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findFaqPages(child, out);
    return out;
  }
  if (node['@type'] === 'FAQPage') out.push(node);
  // Don't recurse inside an FAQPage — its mainEntity Questions are not
  // themselves nested FAQPages.
  if (node['@type'] !== 'FAQPage') {
    for (const v of Object.values(node)) {
      if (v && typeof v === 'object') findFaqPages(v, out);
    }
  }
  return out;
}

function validateFaqPage(faq) {
  const errors = [];
  const mainEntity = Array.isArray(faq.mainEntity)
    ? faq.mainEntity
    : (faq.mainEntity ? [faq.mainEntity] : []);
  if (mainEntity.length === 0) {
    errors.push({ code: 'empty-main-entity' });
    return errors;
  }
  mainEntity.forEach((q, i) => {
    if (!q || typeof q !== 'object') {
      errors.push({ code: 'invalid-question', index: i });
      return;
    }
    if (!isNonEmptyString(q.name)) {
      errors.push({ code: 'missing-name', index: i });
    }
    const answer = q.acceptedAnswer;
    if (!answer || typeof answer !== 'object') {
      errors.push({ code: 'missing-accepted-answer', index: i });
      return;
    }
    if (!isNonEmptyString(answer.text)) {
      errors.push({ code: 'missing-text', index: i });
    }
  });
  return errors;
}

if (!existsSync(DIST_DIR)) {
  console.error(`[audit-faqpage-validity] ${DIST_DIR} not found — run \`npm run build\` first.`);
  process.exit(2);
}

const files = walkHtml(DIST_DIR);

const offenders = [];
const filesByDefect = {
  'duplicate-faqpage': new Set(),
  'missing-name': new Set(),
  'missing-text': new Set(),
  'empty-main-entity': new Set(),
  'missing-accepted-answer': new Set(),
  'invalid-question': new Set(),
};

for (const file of files) {
  let html;
  try {
    html = readFileSync(file, 'utf-8');
  } catch {
    continue;
  }
  if (!html.includes('FAQPage')) continue;
  const blocks = extractLdJsonBlocks(html);
  const faqPages = [];
  for (const body of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    findFaqPages(parsed, faqPages);
  }

  if (faqPages.length === 0) continue;

  const rel = file.replace(DIST_DIR, '');

  if (faqPages.length > 1) {
    offenders.push({ file: rel, defect: 'duplicate-faqpage', count: faqPages.length });
    filesByDefect['duplicate-faqpage'].add(rel);
  }

  faqPages.forEach((faq, fi) => {
    const issues = validateFaqPage(faq);
    for (const iss of issues) {
      offenders.push({ file: rel, defect: iss.code, faqIndex: fi, questionIndex: iss.index });
      if (filesByDefect[iss.code]) filesByDefect[iss.code].add(rel);
    }
  });
}

const summary = {
  totalOffenders: offenders.length,
  duplicateFaqpageFiles: filesByDefect['duplicate-faqpage'].size,
  missingNameFiles: filesByDefect['missing-name'].size,
  missingTextFiles: filesByDefect['missing-text'].size,
  emptyMainEntityFiles: filesByDefect['empty-main-entity'].size,
  missingAcceptedAnswerFiles: filesByDefect['missing-accepted-answer'].size,
  invalidQuestionFiles: filesByDefect['invalid-question'].size,
};

if (JSON_OUT) {
  console.log(JSON.stringify({ ...summary, offenders: offenders.slice(0, LIMIT) }, null, 2));
} else if (offenders.length === 0) {
  console.log('✅ FAQPage validity gate: 0 offenders.');
} else {
  console.error(`❌ FAQPage validity gate: ${offenders.length} defect(s) found.`);
  console.error(`   duplicate FAQPage: ${summary.duplicateFaqpageFiles} file(s)`);
  console.error(`   missing name:      ${summary.missingNameFiles} file(s)`);
  console.error(`   missing text:      ${summary.missingTextFiles} file(s)`);
  if (summary.emptyMainEntityFiles) {
    console.error(`   empty mainEntity:  ${summary.emptyMainEntityFiles} file(s)`);
  }
  if (summary.missingAcceptedAnswerFiles) {
    console.error(`   no acceptedAnswer: ${summary.missingAcceptedAnswerFiles} file(s)`);
  }
  console.error('');
  console.error(`Top ${Math.min(LIMIT, offenders.length)} offenders:`);
  for (const o of offenders.slice(0, LIMIT)) {
    const loc = o.questionIndex !== undefined
      ? ` (faq#${o.faqIndex}.question#${o.questionIndex})`
      : (o.count ? ` (${o.count} FAQPage scripts)` : '');
    console.error(`  - ${o.file} — ${o.defect}${loc}`);
  }
  console.error('');
  console.error('Fix: emit a single FAQPage per page with non-empty name + text on every Question/Answer.');
  console.error('See build-plugins/relatedSearchClustersPlugin.ts buildJsonLd() for the canonical merge pattern.');
}

process.exit(offenders.length === 0 ? 0 : 1);
