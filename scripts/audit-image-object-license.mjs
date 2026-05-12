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
 * Mirrors the vitest gate at tests/seo/image-object-license-fields.test.ts;
 * exposed as a standalone script so post-deploy-validation can run it under
 * the same `spawn_capped` capped-parallel pool as the other dist audits.
 *
 * Exit codes:
 *   0  — no offenders
 *   1  — at least one offender (CI-blocking)
 *   2  — dist/ does not exist (gate cannot run; treated as fatal in CI)
 *
 * Usage:
 *   node scripts/audit-image-object-license.mjs               # fail on regressions
 *   node scripts/audit-image-object-license.mjs --limit=20    # show top-N examples
 *   node scripts/audit-image-object-license.mjs --json        # JSON report
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAuditReport } from './lib/auditReport.mjs';

const __filename = fileURLToPath(import.meta.url);
const ROOT = resolve(__filename, '..', '..');
const DIST_DIR = resolve(ROOT, 'dist');

const REQUIRED_FIELDS = ['acquireLicensePage', 'copyrightNotice', 'license', 'creator', 'creditText'];

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
    // Skip dot-prefixed dirs (debug artifacts, not deployed pages).
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

if (!existsSync(DIST_DIR)) {
  console.error(`[audit-image-object-license] ${DIST_DIR} not found — run \`npm run build\` first.`);
  process.exit(2);
}

const files = walkHtml(DIST_DIR);
const offenders = [];
const fileSet = new Set();

for (const file of files) {
  const html = readFileSync(file, 'utf-8');
  const blocks = extractLdJsonBlocks(html);
  for (const body of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      continue;
    }
    walkImageObjects(parsed, (img) => {
      const missing = REQUIRED_FIELDS.filter((f) => !(f in img));
      if (missing.length > 0) {
        const rel = file.replace(DIST_DIR, '');
        offenders.push({ file: rel, missing, keys: Object.keys(img) });
        fileSet.add(rel);
      }
    });
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ total: offenders.length, files: fileSet.size, offenders: offenders.slice(0, LIMIT) }, null, 2));
} else if (offenders.length === 0) {
  console.log('✅ ImageObject license-fields gate: 0 offenders.');
} else {
  console.error(
    `❌ ImageObject license-fields gate: ${offenders.length} offending ImageObject(s) across ${fileSet.size} page(s).`,
  );
  console.error(`Required fields: ${REQUIRED_FIELDS.join(', ')}\n`);
  // Dump the FULL offender list so the CI log alone is enough to diagnose
  // without downloading the dist artifact (which can exceed 1 GB).
  console.error(`Full offender list (${offenders.length} entries):`);
  for (const o of offenders) {
    console.error(`  - ${o.file}`);
    console.error(`      missing: ${o.missing.join(', ')}`);
    console.error(`      keys:    ${o.keys.join(', ')}`);
  }
  console.error(
    `\nFix: route the ImageObject through services/seo/imageObjectLd.ts (or the create-article.mjs generator for blog content).`,
  );
}

// Structured JSON report (always written, pass or fail).
await writeAuditReport({
  audit: 'image-object-license',
  passed: offenders.length === 0,
  threshold: { metric: 'count', value: 0, comparator: '<=' },
  offenders: offenders.map((o) => ({
    path: o.file,
    feature: 'image-object',
    metric: o.missing.length,
    ratio: null,
    missing: o.missing,
    keys: o.keys,
  })),
});

process.exit(offenders.length === 0 ? 0 : 1);
