#!/usr/bin/env node
/**
 * measure-l2-distribution.mjs
 *
 * Apply the L2 minifier to a sample of production dist files and report
 * the byte-reduction distribution. Useful for predicting CI-wide impact
 * before the next deploy lands the minifier in production.
 *
 * Usage:
 *   node scripts/measure-l2-distribution.mjs --dist=download/artifact --sample=1000
 *   node scripts/measure-l2-distribution.mjs --dist=download/artifact --sample=1000 --by-feature
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { minifyHtml } from '../build-plugins/shared/htmlMinify.ts';

function parseArgs() {
  const args = new Map();
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      args.set(k, v ?? true);
    }
  }
  return args;
}

async function walk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try { entries = await readdir(cur, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && p.endsWith('.html')) out.push(p);
    }
  }
  return out;
}

function sampleRandom(arr, n) {
  if (arr.length <= n) return [...arr];
  const out = new Set();
  while (out.size < n) out.add(arr[Math.floor(Math.random() * arr.length)]);
  return [...out];
}

function featureOf(absPath) {
  const p = absPath.replace(/^.*\/dist\//, '').replace(/^.*\/artifact\//, '');
  if (p.startsWith('cerca-lavoro-') || p.startsWith('en/find-jobs') || p.startsWith('de/jobs-im') || p.startsWith('fr/trouver-emploi')) return 'job-board';
  if (p.startsWith('aziende-che-assumono') || p.includes('companies-hiring')) return 'weekly-employers';
  if (p.startsWith('prezzi-benzina') || p.startsWith('prezzi-diesel') || p.includes('fuel-prices')) return 'fuel-daily';
  if (p.startsWith('articoli-frontaliere') || p.startsWith('en/cross-border-articles')) return 'blog';
  if (p.startsWith('en/') || p.startsWith('de/') || p.startsWith('fr/')) return 'spa-locale';
  if (p.startsWith('calcola-stipendio')) return 'salary-hub';
  return 'spa-other';
}

function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function p90(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
}

async function main() {
  const args = parseArgs();
  const dist = args.get('dist');
  const sampleN = Number(args.get('sample') ?? 1000);
  const byFeature = args.has('by-feature');
  if (!dist) {
    console.error('Usage: measure-l2-distribution.mjs --dist=<path> [--sample=N] [--by-feature]');
    process.exit(2);
  }
  const s = await stat(dist).catch(() => null);
  if (!s || !s.isDirectory()) { console.error(`missing dist: ${dist}`); process.exit(2); }

  console.log(`[measure-l2] walking ${dist}…`);
  const all = await walk(dist);
  console.log(`[measure-l2] found ${all.length} files; sampling ${sampleN}…`);
  const sample = sampleRandom(all, sampleN);

  const records = [];
  let scanned = 0;
  for (const file of sample) {
    const html = await readFile(file, 'utf8');
    const minified = minifyHtml(html);
    const orig = Buffer.byteLength(html, 'utf8');
    const min = Buffer.byteLength(minified, 'utf8');
    records.push({
      path: relative(dist, file),
      feature: featureOf(file),
      orig,
      min,
      reduction: orig - min,
      pct: orig > 0 ? ((orig - min) / orig) * 100 : 0,
    });
    scanned++;
  }

  const totalOrig = records.reduce((s, r) => s + r.orig, 0);
  const totalMin = records.reduce((s, r) => s + r.min, 0);
  const totalSaved = totalOrig - totalMin;
  const pcts = records.map((r) => r.pct);

  console.log('');
  console.log('══════════════════════════════════════════════════════════════════════');
  console.log(`[measure-l2] sampled:          ${scanned} files`);
  console.log(`[measure-l2] total original:   ${(totalOrig / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[measure-l2] total minified:   ${(totalMin / 1024 / 1024).toFixed(1)} MB`);
  console.log(`[measure-l2] total saved:      ${(totalSaved / 1024).toFixed(0)} KB (${((totalSaved / totalOrig) * 100).toFixed(2)}%)`);
  console.log(`[measure-l2] median reduction: ${median(pcts).toFixed(2)}%`);
  console.log(`[measure-l2] p90 reduction:    ${p90(pcts).toFixed(2)}%`);
  console.log(`[measure-l2] max reduction:    ${Math.max(...pcts).toFixed(2)}%`);
  console.log(`[measure-l2] min reduction:    ${Math.min(...pcts).toFixed(2)}%`);
  console.log('══════════════════════════════════════════════════════════════════════');

  if (byFeature) {
    const byFeat = new Map();
    for (const r of records) {
      if (!byFeat.has(r.feature)) byFeat.set(r.feature, []);
      byFeat.get(r.feature).push(r);
    }
    console.log('\nPer feature:');
    const rows = [...byFeat.entries()].sort((a, b) => b[1].length - a[1].length);
    for (const [feat, rs] of rows) {
      const o = rs.reduce((s, r) => s + r.orig, 0);
      const m = rs.reduce((s, r) => s + r.min, 0);
      const pct = o > 0 ? ((o - m) / o) * 100 : 0;
      console.log(`  ${feat.padEnd(20)} files=${String(rs.length).padStart(5)}  saved=${pct.toFixed(2)}%  (${((o - m) / 1024).toFixed(0)} KB of ${(o / 1024 / 1024).toFixed(1)} MB)`);
    }
  }

  // Extrapolation: if local sample is representative, total dist would save:
  const avgSavedPerFile = totalSaved / scanned;
  const projectedTotalFiles = all.length;
  const projectedSaving = avgSavedPerFile * projectedTotalFiles;
  console.log(`\n[measure-l2] EXTRAPOLATION (if sample is representative of all ${projectedTotalFiles} files):`);
  console.log(`  projected total saved: ${(projectedSaving / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  projected pct overall: ${((totalSaved / totalOrig) * 100).toFixed(2)}%`);
}

main().catch((err) => {
  console.error('measure-l2-distribution: fatal', err);
  process.exit(2);
});
