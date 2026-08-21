#!/usr/bin/env node
/**
 * Prospector stage 5 — VALIDATE.
 *
 * Re-runs each synthesised spec and grades what it produced against the
 * employer's OWN page, field by field. This is the gate that decides whether a
 * discovered employer enters production, and it is deliberately harsher than
 * the crawler-health monitor: health asks "did rows come back", quality asks
 * "are the rows true".
 *
 * A run writes `data/prospector/validation.json` — the report a human or a
 * follow-up workflow reads — and moves each candidate to `promoted`
 * (good), `validated` (weak, kept for a retry) or `rejected` (bad).
 *
 * Usage:
 *   node scripts/prospect-validate.mjs
 *   node scripts/prospect-validate.mjs --key=<crawler key> --sample=6
 *   node scripts/prospect-validate.mjs --limit=15 --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadCandidates, saveCandidates, setStatus, byStatus, statusCounts } from './lib/prospector/candidate-store.mjs';
import { runSpec } from './lib/prospector/synthesize.mjs';
import { gradeExtraction } from './lib/prospector/validate.mjs';
import { PROSPECTOR_DIR, VALIDATION_PATH } from './lib/prospector/config.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const flag = (n) => argv.includes(`--${n}`);

const limit = Number(arg('limit', 40));
const onlyKey = arg('key', '');
const sampleSize = Number(arg('sample', 4));
const dryRun = flag('dry-run');
const SPEC_DIR = path.join(PROSPECTOR_DIR, 'crawlers');

const store = loadCandidates();
/** @type {Map<string, any>} candidate key by crawler key */
const byCrawlerKey = new Map();
for (const c of byStatus(store, ['synthesized', 'validated'])) if (c.crawlerKey) byCrawlerKey.set(c.crawlerKey, c);

let specs = [];
try {
  specs = fs.readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(SPEC_DIR, f), 'utf8')));
} catch {
  console.log('Nessuna spec da validare: serve prima uno stadio SYNTHESIZE.');
  process.exit(0);
}
if (onlyKey) specs = specs.filter((s) => s.companyKey === onlyKey);
specs = specs.slice(0, limit);

console.log('═══ Prospector · VALIDATE ═══');
console.log(`spec da validare: ${specs.length}   campione per spec: ${sampleSize} annunci\n`);

const reports = [];
const tally = { good: 0, weak: 0, bad: 0, insufficient: 0 };

for (const spec of specs) {
  const { vacancies, errors } = await runSpec(spec);
  const report = await gradeExtraction(spec, vacancies, { sampleSize });
  report.companyName = spec.companyName;
  report.companyHost = spec.companyHost;
  report.platform = spec.platform || null;
  report.mode = spec.mode;
  report.runErrors = errors;
  reports.push(report);
  tally[report.verdict]++;

  const mark = { good: '✓', weak: '~', bad: '✗', insufficient: '?' }[report.verdict];
  console.log(`  ${mark} ${String(spec.companyName).slice(0, 30).padEnd(32)} score ${report.score.toFixed(2)}  ${String(report.vacancyCount).padStart(3)} ann  url ${(report.reachableRate * 100).toFixed(0)}%  titoli ${(report.titleMatchRate * 100).toFixed(0)}%  ${report.problems[0] || ''}`);

  const candidate = byCrawlerKey.get(spec.companyKey);
  if (candidate) {
    const next = report.verdict === 'good' ? 'promoted' : (report.verdict === 'bad' ? 'rejected' : 'validated');
    setStatus(store, candidate.key, next, {
      qualityScore: report.score,
      qualityVerdict: report.verdict,
      qualityProblems: report.problems,
      vacancyCount: report.vacancyCount,
    });
  }
}

const promotedVacancies = reports.filter((r) => r.verdict === 'good').reduce((a, r) => a + r.vacancyCount, 0);
console.log(`\nesito: ${tally.good} promossi · ${tally.weak} deboli · ${tally.bad} respinti · ${tally.insufficient} campione insufficiente`);
console.log(`annunci coperti dai crawler promossi: ${promotedVacancies}`);
console.log(`coda: ${JSON.stringify(statusCounts(store))}`);

if (dryRun) { console.log('\n--dry-run: niente scritto.'); }
else {
  fs.mkdirSync(path.dirname(VALIDATION_PATH), { recursive: true });
  fs.writeFileSync(VALIDATION_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), tally, promotedVacancies, reports }, null, 2)}\n`);
  saveCandidates(store);
  console.log(`\nreport in ${path.relative(process.cwd(), VALIDATION_PATH)}`);
}
