#!/usr/bin/env node
/**
 * audit-image-object-license.mjs
 *
 * Post-build gate that fails on any `ImageObject` JSON-LD in `dist/` missing
 * one of the five GSC licensable-image fields:
 *   - acquireLicensePage
 *   - copyrightNotice
 *   - license
 *   - creator
 *   - creditText
 *
 * Two execution modes:
 *   1. Standalone CLI:  node scripts/audit-image-object-license.mjs [...]
 *   2. Unified runner:  imported by scripts/audit-all.mjs via factory().
 */

import { readFile, stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { walkHtmlFiles, ROOT, DEFAULT_DIST } from './lib/audit-runner.mjs';
import { writeAuditReport } from './lib/auditReport.mjs';

const REQUIRED_FIELDS = ['acquireLicensePage', 'copyrightNotice', 'license', 'creator', 'creditText'];
const JSONLD_RE = /<script\s+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

function walkImageObjects(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkImageObjects(child, visit);
    return;
  }
  if (node['@type'] === 'ImageObject') visit(node);
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') walkImageObjects(v, visit);
  }
}

export function createAuditor(opts = {}) {
  const limit = opts.limit ?? 20;
  const offenders = [];
  const fileSet = new Set();

  return {
    name: 'image-object-license',
    collect(file, html) {
      // Cheap pre-filter — most pages don't carry ImageObject markup.
      if (!html.includes('"ImageObject"')) return;
      JSONLD_RE.lastIndex = 0;
      let m;
      while ((m = JSONLD_RE.exec(html)) !== null) {
        let parsed;
        try { parsed = JSON.parse(m[1]); } catch { continue; }
        walkImageObjects(parsed, (img) => {
          const missing = REQUIRED_FIELDS.filter((f) => !(f in img));
          if (missing.length > 0) {
            const rel = relative(ROOT, file);
            offenders.push({ path: rel, file: rel, missing, keys: Object.keys(img), metric: missing.length });
            fileSet.add(rel);
          }
        });
      }
    },
    report() {
      const passed = offenders.length === 0;
      const humanSummary = passed
        ? 'ImageObject license-fields gate: 0 offenders'
        : `${offenders.length} ImageObject(s) missing license fields across ${fileSet.size} page(s)`;
      return {
        passed,
        offendersTotal: offenders.length,
        offenders,
        threshold: { metric: 'count', value: 0, comparator: '<=' },
        extra: { files: fileSet.size, limit, requiredFields: REQUIRED_FIELDS },
        humanSummary,
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
    console.error(`[audit-image-object-license] ${DEFAULT_DIST} not found — run \`npm run build\` first.`);
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
    offenders: result.offenders.map((o) => ({
      path: o.file,
      feature: 'image-object',
      metric: o.missing.length,
      ratio: null,
      missing: o.missing,
      keys: o.keys,
    })),
  });

  if (JSON_OUT) {
    console.log(JSON.stringify({
      total: result.offendersTotal,
      files: result.extra.files,
      offenders: result.offenders.slice(0, limit),
    }, null, 2));
  } else if (result.passed) {
    console.log('✅ ImageObject license-fields gate: 0 offenders.');
  } else {
    console.error(`❌ ImageObject license-fields gate: ${result.offendersTotal} offending ImageObject(s) across ${result.extra.files} page(s).`);
    console.error(`Required fields: ${REQUIRED_FIELDS.join(', ')}\n`);
    console.error(`Full offender list (${result.offendersTotal} entries):`);
    for (const o of result.offenders) {
      console.error(`  - ${o.file}`);
      console.error(`      missing: ${o.missing.join(', ')}`);
      console.error(`      keys:    ${o.keys.join(', ')}`);
    }
    console.error(`\nFix: route the ImageObject through services/seo/imageObjectLd.ts (or the create-article.mjs generator for blog content).`);
  }

  process.exit(result.passed ? 0 : 1);
}

const invokedDirectly = (() => {
  try { return import.meta.url === `file://${process.argv[1]}` || import.meta.url.endsWith(process.argv[1]); }
  catch { return false; }
})();

if (invokedDirectly) {
  standalone().catch((err) => {
    console.error('[audit-image-object-license] fatal', err);
    process.exit(2);
  });
}
