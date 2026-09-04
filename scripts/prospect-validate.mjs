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
import { loadCandidates, saveCandidates, setStatus, statusCounts } from './lib/prospector/candidate-store.mjs';
import { runSpec } from './lib/prospector/synthesize.mjs';
import { gradeExtraction } from './lib/prospector/validate.mjs';
import { probeCompanyLogo } from './lib/prospector/logo-probe.mjs';
import { PROSPECTOR_DIR, VALIDATION_PATH, ROOT } from './lib/prospector/config.mjs';
import { loadSourceHostOwnership, matchExistingCrawler } from './lib/crawler-source-hosts.mjs';

const argv = process.argv.slice(2);
const arg = (n, d) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const flag = (n) => argv.includes(`--${n}`);

const limit = Number(arg('limit', 40));
const onlyKey = arg('key', '');
const sampleSize = Number(arg('sample', 4));
const dryRun = flag('dry-run');
const SPEC_DIR = path.join(PROSPECTOR_DIR, 'crawlers');

const store = loadCandidates();
/** @type {Map<string, any>} candidate key by crawler key, ogni stato */
const byCrawlerKey = new Map();
for (const c of Object.values(store.candidates)) if (c.crawlerKey) byCrawlerKey.set(c.crawlerKey, c);

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

// Il budget giornaliero e' fisso (`limit`, 40 nel workflow) e la selezione e'
// l'ordine alfabetico di `readdir`: senza questo filtro i candidati gia'
// `production`/`promoting` (che non possono piu' avanzare: `setStatus` e'
// forward-only, vedi candidate-store.mjs) e i `rejected`/`dead` (terminali)
// restano nel file indefinitamente e occupano ogni giorno gli slot
// alfabeticamente precoci — misurato su #6303: nel run del 2026-08-29,
// 24 dei 40 slot andavano a candidati che non potevano piu' beneficiare di
// una rivalidazione, mentre 43 spec restavano fuori dal giro per sempre,
// alcuni bloccati per giorni a "1 giorno su 2" di stabilita' o senza
// logo/jobLike mai misurati. Chi non puo' piu' avanzare non deve competere
// per lo slot con chi puo'.
const DONE_STATUSES = new Set(['production', 'promoting', 'rejected', 'dead']);
specs = specs.filter((s) => {
  const c = byCrawlerKey.get(s.companyKey);
  return !c || !DONE_STATUSES.has(c.status);
});

specs = specs.slice(0, limit);

console.log('═══ Prospector · VALIDATE ═══');
console.log(`spec da validare: ${specs.length}   campione per spec: ${sampleSize} annunci\n`);

const reports = [];
const tally = { good: 0, weak: 0, bad: 0, insufficient: 0 };
let duplicates = 0;

// What we already crawl, keyed by the individual vacancy URL. Read once: the
// slices are large and the answer cannot change during a run.
const ownership = loadSourceHostOwnership(ROOT, { urls: true });

for (const spec of specs) {
  // Stessa ragione dello stadio di sintesi: qui si rende di nuovo il DOM di
  // siti arbitrari, e perdere il giudizio di tutte le spec per colpa di una
  // significherebbe anche non far avanzare lo STORICO su cui il gate di
  // promozione decide — cioe' rimandare ogni promozione di un giorno.
  let vacancies;
  let errors;
  try {
    ({ vacancies, errors } = await runSpec(spec));
  } catch (err) {
    console.log(`  ! ${String(spec.companyName).slice(0, 30).padEnd(32)} errore in esecuzione: ${(err instanceof Error ? err.message : String(err)).slice(0, 60)}`);
    continue;
  }
  // Does this "new employer" simply re-publish vacancies we already carry?
  // Grading cannot tell: a duplicate tenant parses beautifully and scores
  // `good`, which is precisely how `eoc-candidati-posizioni` was promoted
  // alongside the EOC crawler that had been reading the same Umantis tenant for
  // months. The question is not "does it parse" but "is it someone new", and
  // only the vacancies themselves answer it.
  // `exclude` is not optional here: this stage re-grades candidates that are
  // already `promoted`/`production`, and a live crawler matches its OWN slice at
  // 100% — without it, every established crawler would reject itself.
  const twin = matchExistingCrawler(
    (vacancies || []).map((v) => v?.url || ''),
    ownership,
    { exclude: spec.companyKey },
  );
  if (twin) {
    duplicates++;
    console.log(`  ⊘ ${String(spec.companyName).slice(0, 30).padEnd(32)} duplicato di ${twin.key} — ${twin.shared}/${twin.total} annunci gia' coperti`);
    const candidate = byCrawlerKey.get(spec.companyKey);
    if (candidate) {
      setStatus(store, candidate.key, 'rejected', {
        qualityVerdict: 'duplicate',
        qualityProblems: [`duplica ${twin.key}: ${twin.shared}/${twin.total} annunci gia' presenti in data/jobs/by-crawler/${twin.key}.json`],
        duplicateOf: twin.key,
      });
    }
    continue;
  }

  let report;
  try {
    report = await gradeExtraction(spec, vacancies, { sampleSize });
  } catch (err) {
    console.log(`  ! ${String(spec.companyName).slice(0, 30).padEnd(32)} errore nel giudizio: ${(err instanceof Error ? err.message : String(err)).slice(0, 60)}`);
    continue;
  }
  report.companyName = spec.companyName;
  report.companyHost = spec.companyHost;
  report.platform = spec.platform || null;
  report.mode = spec.mode;
  report.runErrors = errors;

  // Logo obbligatorio quanto jobLike: un candidato la cui azienda non ha un
  // logo verificabile non entra in produzione (vedi promotion-gate.mjs). La
  // probe non fa fallire la spec — un errore di rete qui si traduce solo in
  // `logoFound: false`, che il gate tratta come "non ancora dimostrato" e che
  // si autoripara alla prossima validazione (stessa filosofia del resto del
  // gate: nessuna misura non fatta vale come "passata").
  const logo = await probeCompanyLogo(spec.companyHost).catch(() => ({ found: false, reason: 'errore probe' }));
  report.logoFound = logo.found;

  reports.push(report);
  tally[report.verdict]++;

  const mark = { good: '✓', weak: '~', bad: '✗', insufficient: '?' }[report.verdict];
  console.log(`  ${mark} ${String(spec.companyName).slice(0, 30).padEnd(32)} score ${report.score.toFixed(2)}  ${String(report.vacancyCount).padStart(3)} ann  url ${(report.reachableRate * 100).toFixed(0)}%  titoli ${(report.titleMatchRate * 100).toFixed(0)}%  localita' ${(report.locationSourceRate * 100).toFixed(0)}%  logo ${logo.found ? '✓' : '✗'}  ${report.problems[0] || ''}`);

  const candidate = byCrawlerKey.get(spec.companyKey);
  if (candidate) {
    const next = report.verdict === 'good' ? 'promoted' : (report.verdict === 'bad' ? 'rejected' : 'validated');
    // Keep a short grading history. A single good grade proves the page parsed
    // ONCE; autonomous promotion needs proof it parses the same way on a
    // different day, because the dominant failure of a synthesised crawler is a
    // listing that renders differently between visits (A/B markup, a cookie
    // wall, an empty week). The promotion gate reads this, nothing else does.
    const history = Array.isArray(candidate.validationHistory) ? candidate.validationHistory : [];
    history.push({
      at: new Date().toISOString(),
      score: report.score,
      verdict: report.verdict,
      vacancyCount: report.vacancyCount,
      sampled: report.sampled,
      reachableRate: report.reachableRate,
      titleMatchRate: report.titleMatchRate,
      contentfulRate: report.contentfulRate,
      locationSourceRate: report.locationSourceRate,
      distinctRate: report.distinctRate,
      // The promotion gate reads this key and treats ABSENT as "never
      // measured" (blocking) while `null` means "measured, unreadable bytes"
      // (not blocking) — so it must be written on every entry, including null.
      jobLikeRate: report.jobLikeRate ?? null,
      logoFound: report.logoFound,
    });
    setStatus(store, candidate.key, next, {
      detailEnrichment: spec.detailEnrichment === true,
      qualityScore: report.score,
      qualityVerdict: report.verdict,
      qualityProblems: report.problems,
      vacancyCount: report.vacancyCount,
      validationHistory: history.slice(-8),
    });
  }
}

const promotedVacancies = reports.filter((r) => r.verdict === 'good').reduce((a, r) => a + r.vacancyCount, 0);
console.log(`\nesito: ${tally.good} promossi · ${tally.weak} deboli · ${tally.bad} respinti · ${tally.insufficient} campione insufficiente · ${duplicates} duplicati di crawler esistenti`);
console.log(`annunci coperti dai crawler promossi: ${promotedVacancies}`);
console.log(`coda: ${JSON.stringify(statusCounts(store))}`);

if (dryRun) { console.log('\n--dry-run: niente scritto.'); }
else {
  fs.mkdirSync(path.dirname(VALIDATION_PATH), { recursive: true });
  fs.writeFileSync(VALIDATION_PATH, `${JSON.stringify({ generatedAt: new Date().toISOString(), tally, promotedVacancies, reports }, null, 2)}\n`);
  saveCandidates(store);
  console.log(`\nreport in ${path.relative(process.cwd(), VALIDATION_PATH)}`);
}
