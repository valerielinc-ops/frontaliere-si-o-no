#!/usr/bin/env node
/**
 * audit-image-layout.mjs
 *
 * Walks dist/**\/*.html and rejects rendered images that do not reserve their
 * layout space and loading priority in the markup. This is deliberately a
 * separate audit: it protects the CLS invariant without imposing any HTML
 * byte budget on a page.
 *
 * Every image must declare width and height, plus either loading or the
 * explicit high fetch priority used by the critical image path.
 *
 * Two execution modes:
 *   1. Standalone CLI: node scripts/audit-image-layout.mjs
 *   2. Unified runner: imported by scripts/audit-all.mjs via factory().
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { writeAuditReport } from './lib/auditReport.mjs';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';

/**
 * Return the missing layout attributes for every rendered image in `html`.
 *
 * @param {string} html
 * @returns {Array<{ tag: string, missing: string[] }>}
 */
export function findImageLayoutIssues(html) {
  const issues = [];
  const imageRe = /<img\b([^>]*)>/gi;
  let match;
  while ((match = imageRe.exec(html)) !== null) {
    const attrs = match[1];
    const missing = [];
    const hasAttribute = (name) => new RegExp(`(?:^|\\s)${name}\\s*=`, 'i').test(attrs);
    if (!hasAttribute('width')) missing.push('width');
    if (!hasAttribute('height')) missing.push('height');
    const hasLoading = hasAttribute('loading');
    const hasHighPriority = /(?:^|\s)fetchpriority\s*=\s*["']?high/i.test(attrs);
    if (!hasLoading && !hasHighPriority) missing.push('loading|fetchpriority=high');
    if (missing.length > 0) issues.push({ tag: match[0].slice(0, 160), missing });
  }
  return issues;
}

export function createAuditor() {
  let scanned = 0;
  const offenders = [];

  return {
    name: 'image-layout',
    collect(file, html) {
      scanned += 1;
      const issues = findImageLayoutIssues(html);
      if (issues.length === 0) return;
      offenders.push({
        path: relative(ROOT, file),
        feature: 'image-layout',
        metric: issues.length,
        issues: issues.slice(0, 3),
      });
    },
    report() {
      return {
        passed: offenders.length === 0,
        offendersTotal: offenders.length,
        offenders,
        threshold: { metric: 'offending-pages', value: 0, comparator: '<=' },
        extra: { scanned, imageCount: offenders.reduce((total, page) => total + page.metric, 0) },
        humanSummary: offenders.length === 0
          ? `all ${scanned} pages have width/height and loading layout attributes`
          : `${offenders.length} page(s) contain image(s) missing width/height/loading layout attributes`,
      };
    },
  };
}

export const factory = createAuditor;
export const auditor = factory();

async function standalone() {
  const args = new Map();
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('--')) continue;
    const [key, value] = arg.slice(2).split('=');
    args.set(key, value ?? true);
  }
  const dist = typeof args.get('dist') === 'string'
    ? resolve(ROOT, args.get('dist'))
    : DEFAULT_DIST;

  const stats = await stat(dist).catch(() => null);
  if (!stats || !stats.isDirectory()) {
    console.error(`audit-image-layout: dist/ not found at ${dist}. Run a build first.`);
    process.exit(2);
  }

  const audit = createAuditor();
  const files = await walkHtmlFiles(dist);
  for (const file of files) {
    let html;
    try {
      html = await readFile(file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    audit.collect(file, html);
  }

  const result = audit.report();
  await writeAuditReport({
    audit: audit.name,
    passed: result.passed,
    threshold: result.threshold,
    offenders: result.offenders,
    byFeature: { 'image-layout': result.offendersTotal },
    extra: result.extra,
  });

  console.log(`audit-image-layout: scanned ${result.extra.scanned} HTML files in ${dist}`);
  if (result.passed) {
    console.log('OK: every <img> declares width, height, and loading or fetchpriority="high".');
    process.exit(0);
  }

  console.error(`FAIL: ${result.offendersTotal} page(s) contain images with missing layout attributes:`);
  for (const offender of result.offenders.slice(0, 20)) {
    console.error(`  - ${offender.path} (${offender.metric} image(s))`);
    for (const issue of offender.issues) {
      console.error(`      missing=[${issue.missing.join(',')}] ${issue.tag}`);
    }
  }
  if (result.offendersTotal > 20) {
    console.error(`  ... and ${result.offendersTotal - 20} more page(s)`);
  }
  process.exit(1);
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((error) => {
    console.error('audit-image-layout crashed:', error);
    process.exit(2);
  });
}
