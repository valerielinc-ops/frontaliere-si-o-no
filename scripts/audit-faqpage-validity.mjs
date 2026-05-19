#!/usr/bin/env node
/**
 * audit-faqpage-validity.mjs
 *
 * Post-build gate that fails on three FAQPage JSON-LD defects flagged by
 * Google Search Console as invalid structured-data and therefore ineligible
 * for FAQ rich results:
 *
 *   1. Duplicate FAQPage on one page (`Campo duplicato "FAQPage"`).
 *   2. Missing `name` on a `mainEntity` Question.
 *   3. Missing `text` on a Question's `acceptedAnswer`.
 *
 * Two execution modes:
 *   1. Standalone CLI:  node scripts/audit-faqpage-validity.mjs [...]
 *   2. Unified runner:  imported by scripts/audit-all.mjs via factory().
 */

import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';
import { writeAuditReport } from './lib/auditReport.mjs';

const JSONLD_RE = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

function findFaqPages(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findFaqPages(child, out);
    return out;
  }
  if (node['@type'] === 'FAQPage') out.push(node);
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
    if (!isNonEmptyString(q.name)) errors.push({ code: 'missing-name', index: i });
    const answer = q.acceptedAnswer;
    if (!answer || typeof answer !== 'object') {
      errors.push({ code: 'missing-accepted-answer', index: i });
      return;
    }
    if (!isNonEmptyString(answer.text)) errors.push({ code: 'missing-text', index: i });
  });
  return errors;
}

export function createAuditor(opts = {}) {
  const limit = opts.limit ?? 20;
  const offenders = [];
  const filesByDefect = {
    'duplicate-faqpage': new Set(),
    'missing-name': new Set(),
    'missing-text': new Set(),
    'empty-main-entity': new Set(),
    'missing-accepted-answer': new Set(),
    'invalid-question': new Set(),
  };

  return {
    name: 'faqpage-validity',
    collect(file, html) {
      // Cheap pre-filter: skip files that don't carry the keyword.
      if (!html.includes('FAQPage')) return;
      JSONLD_RE.lastIndex = 0;
      const blocks = [];
      let m;
      while ((m = JSONLD_RE.exec(html)) !== null) blocks.push(m[1]);
      const faqPages = [];
      for (const body of blocks) {
        let parsed;
        try { parsed = JSON.parse(body); } catch { continue; }
        findFaqPages(parsed, faqPages);
      }
      if (faqPages.length === 0) return;
      const rel = relative(ROOT, file);
      if (faqPages.length > 1) {
        offenders.push({ path: rel, file: rel, defect: 'duplicate-faqpage', count: faqPages.length, metric: faqPages.length });
        filesByDefect['duplicate-faqpage'].add(rel);
      }
      faqPages.forEach((faq, fi) => {
        const issues = validateFaqPage(faq);
        for (const iss of issues) {
          offenders.push({ path: rel, file: rel, defect: iss.code, faqIndex: fi, questionIndex: iss.index, metric: 1 });
          if (filesByDefect[iss.code]) filesByDefect[iss.code].add(rel);
        }
      });
    },
    report() {
      const summary = {
        totalOffenders: offenders.length,
        duplicateFaqpageFiles: filesByDefect['duplicate-faqpage'].size,
        missingNameFiles: filesByDefect['missing-name'].size,
        missingTextFiles: filesByDefect['missing-text'].size,
        emptyMainEntityFiles: filesByDefect['empty-main-entity'].size,
        missingAcceptedAnswerFiles: filesByDefect['missing-accepted-answer'].size,
        invalidQuestionFiles: filesByDefect['invalid-question'].size,
      };
      const passed = offenders.length === 0;
      return {
        passed,
        offendersTotal: offenders.length,
        offenders,
        threshold: { metric: 'count', value: 0, comparator: '<=' },
        extra: { summary, limit },
        humanSummary: passed
          ? 'FAQPage validity gate: 0 offenders'
          : `${offenders.length} defect(s) (${summary.duplicateFaqpageFiles} dup / ${summary.missingNameFiles} missing-name / ${summary.missingTextFiles} missing-text)`,
      };
    },
  };
}

export const factory = createAuditor;
export const auditor = factory();

// ─── Standalone CLI ──────────────────────────────────────────────────────────

async function standalone() {
  const args = process.argv.slice(2);
  const getArg = (name) => {
    const eq = args.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const idx = args.indexOf(name);
    return idx === -1 ? undefined : args[idx + 1];
  };
  const limit = Number(getArg('--limit') ?? 20);
  const JSON_OUT = args.includes('--json');

  const s = await stat(DEFAULT_DIST).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.error(`[audit-faqpage-validity] ${DEFAULT_DIST} not found — run \`npm run build\` first.`);
    process.exit(2);
  }

  const a = createAuditor({ limit });
  const files = await walkHtmlFiles(DEFAULT_DIST);
  for (const file of files) {
    let html;
    try { html = await readFile(file, 'utf8'); }
    catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    a.collect(file, html);
  }
  const result = await a.report();
  await writeAuditReport({
    audit: a.name,
    passed: result.passed,
    threshold: result.threshold,
    offenders: result.offenders.slice(0, 100),
  });

  if (JSON_OUT) {
    console.log(JSON.stringify({ ...result.extra.summary, offenders: result.offenders.slice(0, limit) }, null, 2));
  } else if (result.passed) {
    console.log('✅ FAQPage validity gate: 0 offenders.');
  } else {
    const s = result.extra.summary;
    console.error(`❌ FAQPage validity gate: ${result.offendersTotal} defect(s) found.`);
    console.error(`   duplicate FAQPage: ${s.duplicateFaqpageFiles} file(s)`);
    console.error(`   missing name:      ${s.missingNameFiles} file(s)`);
    console.error(`   missing text:      ${s.missingTextFiles} file(s)`);
    if (s.emptyMainEntityFiles) console.error(`   empty mainEntity:  ${s.emptyMainEntityFiles} file(s)`);
    if (s.missingAcceptedAnswerFiles) console.error(`   no acceptedAnswer: ${s.missingAcceptedAnswerFiles} file(s)`);
    console.error('');
    console.error(`Top ${Math.min(limit, result.offenders.length)} offenders:`);
    for (const o of result.offenders.slice(0, limit)) {
      const loc = o.questionIndex !== undefined
        ? ` (faq#${o.faqIndex}.question#${o.questionIndex})`
        : (o.count ? ` (${o.count} FAQPage scripts)` : '');
      console.error(`  - ${o.file} — ${o.defect}${loc}`);
    }
    console.error('');
    console.error('Fix: emit a single FAQPage per page with non-empty name + text on every Question/Answer.');
    console.error('See build-plugins/relatedSearchClustersPlugin.ts buildJsonLd() for the canonical merge pattern.');
  }
  process.exit(result.passed ? 0 : 1);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('[audit-faqpage-validity] fatal', err);
    process.exit(2);
  });
}
