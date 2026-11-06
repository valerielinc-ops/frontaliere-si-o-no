#!/usr/bin/env node
/**
 * cls-delta.mjs — quick before/after CLS comparison.
 *
 * Reads two JSON reports produced by `audit-cls-live.mjs --json` (or the
 * file it auto-writes to reports/cls-YYYY-MM-DD.json) and prints a per-URL
 * delta table. Useful when iterating on a CLS fix and you want to know if
 * the latest change actually moved the needle without staring at two huge
 * JSON blobs.
 *
 * Usage:
 *   node scripts/cls-delta.mjs <before.json> <after.json>
 *   node scripts/cls-delta.mjs reports/cls-2026-05-08.json reports/cls-2026-05-09.json
 *
 * Output:
 *   per-URL row: before / after / Δ / verdict (improved / regressed / flat)
 *   summary    : count of improved / regressed / flat URLs + average Δ
 *
 * Exit code:
 *   0  — at least one URL improved AND no URL regressed (>0.05 abs)
 *   1  — at least one URL regressed (>0.05 abs)
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('usage: cls-delta.mjs <before.json> <after.json>');
  process.exit(2);
}
const [BEFORE, AFTER] = args;

function load(path) {
  const j = JSON.parse(readFileSync(path, 'utf-8'));
  // Accept either the audit-cls-live --json shape ({ results: [...] })
  // or the saved reports/cls-{date}.json shape (same).
  const arr = Array.isArray(j.results) ? j.results : j;
  const map = new Map();
  for (const r of arr) {
    if (r?.key && typeof r.effective === 'number') {
      map.set(r.key, { cls: r.effective, source: r.source, url: r.url });
    }
  }
  return map;
}

const before = load(BEFORE);
const after = load(AFTER);

const keys = new Set([...before.keys(), ...after.keys()]);
const sorted = [...keys].sort();

function fmt(n) { return n == null || Number.isNaN(n) ? '   n/a' : n.toFixed(3).padStart(6); }

const rows = [];
let improved = 0, regressed = 0, flat = 0, totalDelta = 0, counted = 0;

for (const k of sorted) {
  const b = before.get(k);
  const a = after.get(k);
  const bv = b?.cls ?? null;
  const av = a?.cls ?? null;
  const delta = bv != null && av != null ? av - bv : null;
  let tag = '·';
  if (delta != null) {
    if (delta <= -0.05) { tag = '✅ improved'; improved++; }
    else if (delta >= 0.05) { tag = '🔴 regressed'; regressed++; }
    else { tag = '   flat    '; flat++; }
    totalDelta += delta;
    counted++;
  } else if (bv == null) tag = '🆕 new     ';
  else tag = '❓ removed ';
  rows.push({ key: k, bv, av, delta, tag });
}

console.log(`CLS delta — ${BEFORE} → ${AFTER}`);
console.log('─'.repeat(80));
console.log('key'.padEnd(40) + ' before  after  Δ        verdict');
console.log('─'.repeat(80));
for (const r of rows) {
  const dlt = r.delta != null ? (r.delta >= 0 ? '+' : '') + r.delta.toFixed(3) : '   n/a';
  console.log(`${r.key.padEnd(40)}${fmt(r.bv)}  ${fmt(r.av)}  ${dlt.padStart(7)}  ${r.tag}`);
}
console.log('─'.repeat(80));
console.log(`improved ${improved}  ·  regressed ${regressed}  ·  flat ${flat}  ·  avg Δ ${counted ? (totalDelta / counted).toFixed(4) : 'n/a'}`);

process.exit(regressed > 0 ? 1 : 0);
