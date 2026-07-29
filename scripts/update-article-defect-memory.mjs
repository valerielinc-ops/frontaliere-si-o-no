#!/usr/bin/env node
/**
 * Folds a run's (or the corpus's) institution observations into the cross-run
 * defect memory, applies the promotion policy, and reports what changed.
 *
 * This is the write side of the learning loop described in
 * docs/ARTICLE-LEARNING-LOOP.md. It runs as a step of generate-article.yml
 * after generation, so the signal that today dies in an ephemeral CI log
 * survives into `data/article-defect-memory.json` and defends the next run.
 *
 * WHY IT IS A SEPARATE SCRIPT and not a few lines inside create-article.mjs:
 * the gate must not mutate the state it is judging against. A gate that wrote
 * to the memory as it evaluated would learn from drafts that never shipped and
 * would be reading a store it was concurrently editing across six retries.
 * create-article.mjs only COLLECTS observations into its run report; the
 * verdict is folded in here, once, after the run's outcome is known.
 *
 * Zero model calls. Everything is comparison over strings we already hold.
 *
 * Usage:
 *   node scripts/update-article-defect-memory.mjs --from-run <report.json> --apply
 *   node scripts/update-article-defect-memory.mjs --from-corpus            # prevalence only
 *   node scripts/update-article-defect-memory.mjs --review [--limit 25]    # human queue
 *   node scripts/update-article-defect-memory.mjs --confirm UFI  --reason "..." --apply
 *   node scripts/update-article-defect-memory.mjs --clear   UFAM --reason "..." --apply
 *   node scripts/update-article-defect-memory.mjs --health [--strict]
 *
 * Without --apply nothing is written: every mode is a dry run by default,
 * because the output of this script is a list of things that will start
 * BLOCKING article publication.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MEMORY_FILE,
  loadDefectMemory,
  saveDefectMemory,
  recordObservations,
  applyPromotionPolicy,
  formatPolicyOutcome,
  reviewQueue,
  memoryHealth,
  learnedDenylist,
  learnedSuspects,
  ENTITY_STATUS,
  SUPPORT,
} from './lib/article-defect-memory.mjs';
import { collectInstitutionAcronyms } from './lib/article-factuality-gates.mjs';
import { BODY_DIRS, extractBodies } from './lib/blog-body-io.mjs';
import { stableStringify } from './lib/stable-stringify.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const APPLY = flag('--apply');
const STRICT = flag('--strict');
const MEMORY_FILE = value('--memory', process.env.ARTICLE_DEFECT_MEMORY_FILE || DEFAULT_MEMORY_FILE);
const RUN_REPORT = value('--from-run');
const FROM_CORPUS = flag('--from-corpus');
const REVIEW = flag('--review');
const HEALTH = flag('--health');
const LIMIT = Number(value('--limit', '25')) || 25;
const CONFIRM = value('--confirm');
const CLEAR = value('--clear');
const REASON = value('--reason', '');
const NOW = new Date().toISOString();

const { memory, degraded } = loadDefectMemory(MEMORY_FILE);
// Snapshot to decide later whether the write is worth a commit. This runs every
// 30 minutes: rewriting the file on every idle run would put ~48 no-op diffs a
// day into `main` and drown the ones that actually changed a verdict.
const BEFORE = stableStringify(memory.entities || {});
if (degraded) {
  // Never fail open in silence. Proceeding on an empty store would quietly
  // rebuild the memory from scratch and drop every confirmation ever learned.
  console.error(`🚨 Memoria dei difetti degradata (${MEMORY_FILE}): ${degraded}`);
  console.error('   Le difese apprese NON sono attive. Ripristina il file prima di applicare aggiornamenti:');
  console.error('   scrivere ora sovrascriverebbe la memoria con uno store vuoto.');
  if (APPLY) process.exit(1);
}

let ingested = 0;

// ── Human verdicts ────────────────────────────────────────────────────
// The escape hatch that makes the whole design safe to run unattended: a
// person can always overrule the learner in either direction, and the learner
// never overrules a person (evaluateEntity short-circuits on statusSource).
for (const [acronym, status] of [[CONFIRM, ENTITY_STATUS.CONFIRMED], [CLEAR, ENTITY_STATUS.CLEARED]]) {
  if (!acronym) continue;
  const key = acronym.toUpperCase();
  const entry = memory.entities[key] || (memory.entities[key] = {
    status, statusSource: 'human', statusAt: NOW, firstSeen: NOW, lastSeen: NOW,
    seen: 0, unsupportedSightings: 0, unsupportedRuns: [], supportedSightings: 0,
    names: [], recentKeys: [], evidence: [],
  });
  entry.status = status;
  entry.statusSource = 'human';
  entry.statusAt = NOW;
  if (REASON) entry.note = REASON;
  console.log(`👤 Verdetto umano: ${key} → ${status}${REASON ? ` — ${REASON}` : ''}`);
  if (!REASON) console.log('   ⚠️  Nessun --reason: la prossima revisione non saprà perché.');
}

// ── Ingest: a single generation run ───────────────────────────────────
if (RUN_REPORT) {
  if (!existsSync(RUN_REPORT)) {
    console.error(`⚠️  Run report assente: ${RUN_REPORT} — nessuna osservazione ingerita.`);
  } else {
    let report;
    try {
      report = JSON.parse(readFileSync(RUN_REPORT, 'utf-8'));
    } catch (e) {
      console.error(`⚠️  Run report illeggibile (${e.message}) — nessuna osservazione ingerita.`);
    }
    const observations = report?.factuality?.institutionObservations || [];
    if (!observations.length) {
      console.log('ℹ️  Nessuna osservazione di enti in questo run (nessun acronimo introdotto, o run senza generazione).');
    }
    // Group by the article the observation came from: evidence is counted once
    // per (run, article), and the run report carries one entry per attempt.
    for (const obs of observations) {
      const { recorded } = recordObservations(memory, [obs], {
        runId: report?.runId || process.env.GITHUB_RUN_ID || 'local',
        articleId: obs.articleId || report?.article?.id || 'unknown',
        now: NOW,
      });
      ingested += recorded;
    }
    console.log(`📥 Ingerite ${ingested} osservazioni dal run report.`);
  }
}

// ── Ingest: the published corpus ──────────────────────────────────────
if (FROM_CORPUS) {
  // The source page of a published article is not retained, so these
  // observations carry SUPPORT.UNKNOWN and can only ever raise prevalence.
  // A corpus scan is structurally incapable of promoting anything to blocking
  // — which is the point: judging the generator's output by the generator's
  // other output is exactly the self-referential loop that degenerated on
  // 2026-07-28. Prevalence still earns an entity a place in the review queue.
  let scanned = 0;
  for (const bodyDir of BODY_DIRS) {
    const itDir = join(bodyDir, 'it');
    if (!existsSync(itDir)) continue;
    for (const file of readdirSync(itDir).filter((f) => f.endsWith('.ts'))) {
      const id = file.replace('.ts', '');
      const sections = extractBodies(readFileSync(join(itDir, file), 'utf-8'), id);
      if (!Object.keys(sections).length) continue;
      scanned++;
      const text = Object.values(sections).filter((v) => typeof v === 'string').join('\n\n');
      const observations = collectInstitutionAcronyms(text, { sourceText: '' })
        .map((o) => ({ ...o, support: SUPPORT.UNKNOWN }));
      if (!observations.length) continue;
      const { recorded } = recordObservations(memory, observations, { runId: 'corpus-scan', articleId: id, now: NOW });
      ingested += recorded;
    }
  }
  console.log(`📚 Corpus: ${scanned} articoli analizzati, ${ingested} osservazioni (solo prevalenza, mai bloccanti).`);
}

// ── Policy ────────────────────────────────────────────────────────────
const outcome = applyPromotionPolicy(memory, { now: NOW });
const changed = outcome.promoted.length + outcome.cleared.length + outcome.demoted.length + outcome.evicted.length;
if (changed) {
  console.log(`\n🔁 Politica di promozione applicata (${changed} cambiamenti):`);
  console.log(formatPolicyOutcome(outcome));
} else {
  console.log('\n🔁 Politica applicata: nessun cambiamento di stato.');
}

const health = memoryHealth(memory);
console.log(`\n📊 Memoria: ${health.total} entità — ${health.byStatus.confirmed || 0} confermate `
  + `(${health.autoConfirmed} automatiche, ${health.humanPinned} con verdetto umano), `
  + `${health.byStatus.suspect || 0} sospette, ${health.byStatus.cleared || 0} scagionate.`);
console.log(`   Denylist appresa attiva: ${[...learnedDenylist(memory)].sort().join(', ') || '(vuota)'}`);
console.log(`   Sorveglianza (non bloccante): ${learnedSuspects(memory).size} acronimi`);

if (REVIEW) {
  const queue = reviewQueue(memory, { limit: LIMIT });
  console.log(`\n🧑‍⚖️  Coda di revisione umana (${queue.length}), evidenza decrescente:\n`);
  for (const r of queue) {
    console.log(`  ${r.acronym.padEnd(8)} ${r.unsupportedSightings} avvistamenti senza riscontro / `
      + `${r.unsupportedRuns} run · ${r.seen} emissioni totali · ultimo ${String(r.lastSeen).slice(0, 10)}`);
    if (r.names.length) console.log(`           nomi: ${r.names.slice(0, 3).join(' | ')}`);
    const sample = r.evidence[0];
    if (sample) console.log(`           es.: run ${sample.runId} · articolo ${sample.articleId} · fonte=${sample.support}`);
  }
  console.log('\n  Conferma:  node scripts/update-article-defect-memory.mjs --confirm <ACR> --reason "..." --apply');
  console.log('  Scagiona:  node scripts/update-article-defect-memory.mjs --clear   <ACR> --reason "..." --apply');
}

// ── Health gate ───────────────────────────────────────────────────────
// Saturation and near-capacity are reported ALWAYS and exit non-zero only
// under --strict. The article pipeline must not stop shipping because the
// learner filled up: a saturated learner still applies every curated list and
// every confirmation it already holds, it just stops adding new ones. --strict
// is for a separate health check that can go red without taking content down.
let unhealthy = false;
for (const w of outcome.warnings) {
  console.error(`\n🚨 ${w}`);
  unhealthy = true;
}
if (health.nearCapacity) {
  console.error(`\n⚠️  Memoria vicina al cap di popolazione (${health.total}) — le voci sospette meno frequenti verranno dimenticate.`);
  unhealthy = true;
}

if (!APPLY) {
  console.log('\n🔍 Dry run — niente scritto. Aggiungi --apply per persistere.');
} else if (stableStringify(memory.entities || {}) === BEFORE) {
  console.log('\n💤 Nessun cambiamento sostanziale — file non riscritto (niente commit a vuoto).');
} else {
  saveDefectMemory(memory, MEMORY_FILE, NOW);
  console.log(`\n💾 Scritto ${MEMORY_FILE}`);
}

if (HEALTH && STRICT && unhealthy) process.exit(1);
