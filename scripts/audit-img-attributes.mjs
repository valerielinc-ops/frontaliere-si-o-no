#!/usr/bin/env node
/**
 * Validate layout and loading attributes on every <img> in dist HTML.
 *
 * Standalone CLI: node scripts/audit-img-attributes.mjs
 * Unified runner: imported by scripts/audit-all.mjs via factory().
 */

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { writeAuditReport } from './lib/auditReport.mjs';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';

export function findImgIssues(html) {
  const issues = [];
  const imgRe = /<img\b([^>]*)>/gi;
  let m;
  while ((m = imgRe.exec(html)) !== null) {
    const attrs = m[1];
    const missing = [];
    if (!/\bwidth\s*=/.test(attrs)) missing.push('width');
    if (!/\bheight\s*=/.test(attrs)) missing.push('height');
    const hasLoading = /\bloading\s*=/.test(attrs);
    const hasFetchPri = /\bfetchpriority\s*=\s*["']?high/i.test(attrs);
    if (!hasLoading && !hasFetchPri) missing.push('loading|fetchpriority');
    if (missing.length > 0) issues.push({ tag: m[0].slice(0, 160), missing });
  }
  return issues;
}

export function createAuditor() {
  let scannedCount = 0;
  const imgIssuesByFile = [];

  return {
    name: 'img-attributes',
    collect(file, html) {
      scannedCount++;
      const issues = findImgIssues(html);
      if (issues.length > 0) {
        imgIssuesByFile.push({ file: relative(ROOT, file), issues });
      }
    },
    report() {
      const offenders = imgIssuesByFile.map(({ file, issues }) => ({
        path: file,
        feature: 'img-attributes',
        kind: 'img-attrs',
        imgIssues: issues.slice(0, 3),
      }));
      const hasIssues = offenders.length > 0;
      const topPaths = offenders.slice(0, 3).map((offender) => offender.path).join(', ');

      return {
        passed: !hasIssues,
        offendersTotal: offenders.length,
        offenders,
        byFeature: hasIssues ? { 'img-attributes': offenders.length } : {},
        extra: { scanned: scannedCount, imgIssuesCount: imgIssuesByFile.length },
        humanSummary: hasIssues
          ? `${imgIssuesByFile.length} page(s) with <img> attribute issues: ${topPaths}${offenders.length > 3 ? ', …' : ''}`
          : `all ${scannedCount} pages have valid <img> attributes`,
      };
    },
  };
}

export const factory = createAuditor;
export const auditor = factory();

function parseArgs(args) {
  const options = { dist: DEFAULT_DIST, summary: false, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--summary') {
      options.summary = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--dist') {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) throw new Error('--dist requires a directory path');
      options.dist = resolve(value);
      i++;
    } else if (arg.startsWith('--dist=')) {
      const value = arg.slice('--dist='.length);
      if (!value) throw new Error('--dist requires a directory path');
      options.dist = resolve(value);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

async function standalone() {
  const options = parseArgs(process.argv.slice(2));
  const distStat = await stat(options.dist).catch(() => null);
  if (!distStat || !distStat.isDirectory()) {
    console.error(`audit-img-attributes: dist directory not found at ${options.dist}. Run a build first.`);
    process.exit(2);
  }

  const auditor = createAuditor();
  const files = await walkHtmlFiles(options.dist);
  for (const file of files) {
    const html = await readFile(file, 'utf8');
    auditor.collect(file, html);
  }
  const result = auditor.report();
  await writeAuditReport({
    audit: auditor.name,
    passed: result.passed,
    offenders: result.offenders,
    byFeature: result.byFeature,
  });

  if (options.json) {
    console.log(JSON.stringify({
      total: result.extra.scanned,
      imgIssuesCount: result.extra.imgIssuesCount,
      offenders: result.offenders.slice(0, 100),
    }, null, 2));
    process.exit(result.passed ? 0 : 1);
  }

  console.log(`audit-img-attributes: scanned ${result.extra.scanned} HTML files in dist/`);
  if (!result.passed) {
    console.error(`\nFAIL: ${result.extra.imgIssuesCount} page(s) have <img> tags missing required attributes:`);
    const show = options.summary ? result.offenders : result.offenders.slice(0, 5);
    for (const offender of show) {
      const issues = offender.imgIssues ?? [];
      console.error(`  - ${offender.path} (${issues.length} tag(s))`);
      for (const issue of issues.slice(0, 2)) {
        console.error(`      missing=[${issue.missing.join(',')}]  ${issue.tag}`);
      }
    }
    if (!options.summary && result.offenders.length > 5) {
      console.error(`  ... and ${result.offenders.length - 5} more (rerun with --summary)`);
    }
    process.exit(1);
  }

  console.log(`OK: all ${result.extra.scanned} pages have valid <img> attributes.`);
  process.exit(0);
}

const invokedDirectly = (() => {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('audit-img-attributes crashed:', err);
    process.exit(2);
  });
}
