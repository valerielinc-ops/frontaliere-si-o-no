#!/usr/bin/env node
/**
 * Retro-audit: runs the deterministic factuality gates over every published
 * article body and reports what would have been blocked.
 *
 * Added with the gates themselves (2026-07-28, incident on
 * `frontalieri-altre-tasse-2026`). The gates stop NEW defects at generation
 * time; this script finds the ones already live.
 *
 * The source page of a published article is not retained, so the two
 * source-relative gates (fidelity, freshness) cannot run here. Everything
 * decidable from the text alone does: arithmetic, tax plausibility,
 * cross-section contradictions, invented institutions, contradictory norm
 * dates and truncation.
 *
 * Usage:
 *   node scripts/audit-article-factuality.mjs              # human report
 *   node scripts/audit-article-factuality.mjs --json       # machine-readable
 *   node scripts/audit-article-factuality.mjs --critical   # blocking only
 *   node scripts/audit-article-factuality.mjs --limit 20   # cap output
 *
 * Exits 0 always — this is a report, not a gate. Nothing is modified, and no
 * page is ever unpublished: that is an owner decision.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runFactualityGates, SEVERITY } from './lib/article-factuality-gates.mjs';

const BODY_DIRS = ['services/locales/blog-body', 'services/locales/blog-body-ch'];
const AS_JSON = process.argv.includes('--json');
const CRITICAL_ONLY = process.argv.includes('--critical');
const LIMIT = (() => {
  const i = process.argv.indexOf('--limit');
  return i !== -1 ? Number(process.argv[i + 1]) || Infinity : Infinity;
})();

/** Same extraction the repair scripts use (scripts/repair-repetitive-articles.mjs). */
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

const findings = [];
let scanned = 0;

for (const bodyDir of BODY_DIRS) {
  const itDir = join(bodyDir, 'it');
  if (!existsSync(itDir)) continue;

  for (const file of readdirSync(itDir).filter((f) => f.endsWith('.ts'))) {
    const id = file.replace('.ts', '');
    const sections = extractBodies(readFileSync(join(itDir, file), 'utf-8'), id);
    if (!Object.keys(sections).length) continue;
    scanned++;

    // No sourceText / sourceDate: those gates are skipped by construction.
    const { issues, blocking } = runFactualityGates({ sections });
    const relevant = CRITICAL_ONLY ? blocking : issues;
    if (!relevant.length) continue;

    findings.push({
      id,
      dir: bodyDir,
      criticalCount: blocking.length,
      issueCount: issues.length,
      worst: Math.max(...issues.map((i) => SEVERITY[i.severity] || 0)),
      issues: relevant,
    });
  }
}

findings.sort((a, b) => b.criticalCount - a.criticalCount || b.worst - a.worst || b.issueCount - a.issueCount);
const shown = findings.slice(0, LIMIT);

if (AS_JSON) {
  console.log(JSON.stringify({ scanned, flagged: findings.length, findings: shown }, null, 2));
} else {
  const icon = { critical: '🚨', major: '⚠️', minor: 'ℹ️' };
  console.log(`\n📊 Audit factuality — ${scanned} articoli analizzati, ${findings.length} con problemi\n`);
  const withCritical = findings.filter((f) => f.criticalCount > 0).length;
  console.log(`   🚨 con problemi BLOCCANTI: ${withCritical}`);
  console.log(`   ⚠️  solo warning:          ${findings.length - withCritical}\n`);

  // Which defect classes are most common across the corpus.
  const byCode = new Map();
  for (const f of findings) {
    for (const i of f.issues) byCode.set(i.code, (byCode.get(i.code) || 0) + 1);
  }
  console.log('   Classi di difetto per frequenza:');
  for (const [code, n] of [...byCode].sort((a, b) => b[1] - a[1])) {
    console.log(`     ${String(n).padStart(4)}×  ${code}`);
  }
  console.log('');

  for (const f of shown) {
    console.log(`\n─── ${f.id}  (${f.criticalCount} bloccanti / ${f.issueCount} totali)`);
    for (const i of f.issues) {
      console.log(`  ${icon[i.severity] || '•'} [${i.code}] ${i.message}`);
      if (i.evidence) console.log(`       ↳ ${i.evidence.slice(0, 160)}`);
    }
  }
  if (findings.length > shown.length) {
    console.log(`\n   … altri ${findings.length - shown.length} articoli non mostrati (usa --limit).`);
  }
  console.log('');
}
