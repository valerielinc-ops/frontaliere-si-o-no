#!/usr/bin/env node
/**
 * Prospector stage 4 — SYNTHESIZE.
 *
 * Turns traced candidates into runnable crawler specs, by crawling their
 * careers page for real and recording what the extraction cascade actually
 * found. A spec that yields no vacancy is never written: an empty crawler is
 * worse than none, because the health monitor then carries it as broken for
 * ever and someone has to triage it.
 *
 * Specs land in `data/prospector/crawlers/<key>.json` and stay there until the
 * validator grades them. Only a graded, passing spec is promoted into the
 * production crawler set — which is what keeps a run that discovered 6'000
 * employers from dumping 6'000 untested crawlers into the repo.
 *
 * Usage:
 *   node scripts/prospect-synthesize.mjs --limit=25
 *   node scripts/prospect-synthesize.mjs --key=<candidate key>
 *   node scripts/prospect-synthesize.mjs --limit=10 --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadCandidates, saveCandidates, setStatus, byStatus, statusCounts } from './lib/prospector/candidate-store.mjs';
import { synthesizeSpec } from './lib/prospector/synthesize.mjs';
import { PROSPECTOR_DIR } from './lib/prospector/config.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const flag = (n) => argv.includes(`--${n}`);

const limit = Number(arg('limit', 25));
const onlyKey = arg('key', '');
const dryRun = flag('dry-run');
const SPEC_DIR = path.join(PROSPECTOR_DIR, 'crawlers');

const store = loadCandidates();
const queue = onlyKey
  ? [store.candidates[onlyKey]].filter(Boolean)
  : byStatus(store, 'traced')
    // Most vacancies first: the point of a new crawler is the ads it adds.
    .sort((a, b) => (b.vacancyCount || 0) - (a.vacancyCount || 0))
    .slice(0, limit);

console.log('═══ Prospector · SYNTHESIZE ═══');
console.log(`da sintetizzare: ${queue.length} candidati tracciati\n`);

let written = 0;
let refused = 0;
let vacancies = 0;

for (const c of queue) {
  const { spec, reason, vacancies: found } = await synthesizeSpec(c);
  if (!spec) {
    refused++;
    setStatus(store, c.key, 'rejected', { reason: `sintesi fallita: ${reason}` });
    console.log(`  ✗ ${String(c.name).slice(0, 34).padEnd(36)} ${reason}`);
    continue;
  }
  written++;
  vacancies += found.length;
  if (!dryRun) {
    fs.mkdirSync(SPEC_DIR, { recursive: true });
    fs.writeFileSync(path.join(SPEC_DIR, `${spec.companyKey}.json`), `${JSON.stringify(spec, null, 2)}\n`);
  }
  setStatus(store, c.key, 'synthesized', {
    crawlerKey: spec.companyKey,
    mode: spec.mode,
    vacancyCount: found.length,
    sourceLang: spec.sourceLang,
  });
  console.log(`  ✓ ${String(spec.companyName).slice(0, 34).padEnd(36)} ${spec.mode.padEnd(10)} ${String(found.length).padStart(3)} annunci  ${spec.companyHost}`);
}

console.log(`\nspec scritte: ${written}   rifiutate: ${refused}   annunci coperti: ${vacancies}`);
console.log(`coda: ${JSON.stringify(statusCounts(store))}`);
if (dryRun) console.log('\n--dry-run: niente scritto.');
else { saveCandidates(store); console.log(`\nspec in ${path.relative(process.cwd(), SPEC_DIR)}/`); }
