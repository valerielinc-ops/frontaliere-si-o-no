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
import {
  loadCandidates,
  saveCandidates,
  setStatus,
  byStatus,
  isSynthesisRetryDue,
  scheduleSynthesisRetry,
  statusCounts,
  resolveCandidateKey,
  startLedgerPhase,
  finishLedgerPhase,
  recordCandidateAttempt,
  requeueLegacyNoVacancyCandidates,
  requeueMiskeyedCandidate,
} from './lib/prospector/candidate-store.mjs';
import {
  synthesizeSpec,
  isExpectedSynthesisError,
  disambiguateCrawlerKey,
  findMiskeyedCandidates,
} from './lib/prospector/synthesize.mjs';
import { PROSPECTOR_DIR, ROOT } from './lib/prospector/config.mjs';
import { loadCoverage } from './lib/prospector/coverage.mjs';
import { assertKnownFlags } from './lib/prospector/cli-flags.mjs';
import { parseSynthesisLimit, prioritizeSynthesisCandidates } from './lib/prospector/synthesis-schedule.mjs';

const argv = process.argv.slice(2);
// `--dry-run` e' riconosciuto letteralmente: un refuso (`--dryrun`, `-n`) non
// e' un flag diverso, e' nessun flag, e la corsa scrive davvero.
assertKnownFlags(argv, { booleans: ['dry-run'], valued: ['key', 'limit'] });
const arg = (n, d) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : d; };
const flag = (n) => argv.includes(`--${n}`);

const limit = parseSynthesisLimit(arg('limit', 25));
const onlyKey = arg('key', '');
const dryRun = flag('dry-run');
startLedgerPhase('synthesize', { dryRun });
const SPEC_DIR = path.join(PROSPECTOR_DIR, 'crawlers');

const store = loadCandidates();
const synthesisLimit = limit;

// Ogni chiave crawler e' il nome di un file spec, e un parser in produzione
// rilegge la SUA spec da quel file a ogni giro: chi la sovrascrive cambia il
// datore che quel crawler pubblica. Le chiavi prese sono quindi quelle dei
// crawler in produzione (`scripts/update-<key>-jobs.mjs`) e quelle dei
// candidati vivi che hanno gia' una spec.
const productionKeys = loadCoverage(ROOT).keys;
const keyOwners = new Map();
const TERMINAL = new Set(['rejected', 'dead']);
const addKeyOwner = (key, candidateKey) => {
  const owners = keyOwners.get(key) || new Set();
  owners.add(candidateKey);
  keyOwners.set(key, owners);
};
const removeKeyOwner = (key, candidateKey) => {
  const owners = keyOwners.get(key);
  if (!owners) return;
  owners.delete(candidateKey);
  if (!owners.size) keyOwners.delete(key);
};
const hasOtherKeyOwner = (key, candidateKey) => {
  const owners = keyOwners.get(key);
  return Boolean(owners?.size && [...owners].some((owner) => owner !== candidateKey));
};
for (const candidate of Object.values(store.candidates)) {
  if (candidate?.crawlerKey && !TERMINAL.has(candidate.status)) addKeyOwner(candidate.crawlerKey, candidate.key);
}
const readSpec = (key) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(SPEC_DIR, `${key}.json`), 'utf8'));
  } catch (error) {
    // A missing production spec is the only case that proves the key is free.
    // Malformed or unreadable specs must stop rekeying: treating them as absent
    // could emit a second crawler while the live key still owns the employer.
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
};

// Candidati la cui chiave e' un'etichetta del vendor (`my`, `jobportal`,
// `link`): tornano a SYNTHESIZE con una chiave propria, davanti alla coda.
const rekeyed = onlyKey ? [] : findMiskeyedCandidates(Object.values(store.candidates), {
  productionKeys,
  specFor: readSpec,
}).slice(0, synthesisLimit).filter(({ candidate, from, to }) => {
  if (!requeueMiskeyedCandidate(store, candidate.key, { from, to }, dryRun ? null : undefined)) return false;
  removeKeyOwner(from, candidate.key);
  return true;
});
const rekeyedKeys = new Set(rekeyed.map(({ candidate }) => candidate.key));
// La spec della vecchia chiave resta solo se qualcuno la legge ancora: un
// crawler in produzione o un candidato vivo. Orfana, VALIDATE la giudicherebbe
// ogni giorno senza un candidato a cui attribuire l'esito.
for (const from of new Set(rekeyed.map((item) => item.from))) {
  if (dryRun || productionKeys.has(from) || keyOwners.has(from)) continue;
  fs.rmSync(path.join(SPEC_DIR, `${from}.json`), { force: true });
}
const legacyRecoveryLimit = onlyKey ? 0 : Math.min(synthesisLimit, Math.ceil(synthesisLimit * 0.25));
const legacyRecovery = legacyRecoveryLimit
  ? requeueLegacyNoVacancyCandidates(store, legacyRecoveryLimit)
  : [];
const legacyRecoveryKeys = new Set(legacyRecovery.map((candidate) => candidate.key));
const tracedQueue = onlyKey
  ? []
  : byStatus(store, 'traced').filter((candidate) => isSynthesisRetryDue(candidate)
    && !legacyRecoveryKeys.has(candidate.key)
    && !rekeyedKeys.has(candidate.key));
const rekeyedQueue = rekeyed.map(({ candidate }) => store.candidates[candidate.key])
  .filter(Boolean);
const queue = onlyKey
  ? [store.candidates[resolveCandidateKey(store, onlyKey)]].filter(Boolean)
  : [
    ...rekeyedQueue,
    ...legacyRecovery,
    ...prioritizeSynthesisCandidates(
      tracedQueue,
      Math.max(0, synthesisLimit - rekeyedQueue.length - legacyRecovery.length),
    ),
  ];

console.log('═══ Prospector · SYNTHESIZE ═══');
if (rekeyed.length) {
  console.log(`chiavi crawler da etichetta del vendor: ${rekeyed.length} candidati tornano in sintesi`);
  for (const { candidate, from, to } of rekeyed) console.log(`  ↺ ${candidate.key}: ${from} → ${to}`);
}
if (legacyRecovery.length) console.log(`recupero seed senza annunci: ${legacyRecovery.length} candidati legacy in coda`);
console.log(`da sintetizzare: ${queue.length} candidati tracciati\n`);

let written = 0;
let refused = 0;
let vacancies = 0;
let retried = 0;

for (const c of queue) {
  // Un datore rotto non deve affondare lo stadio. Il loop visita migliaia di
  // siti di sconosciuti e uno malformato ci sara' sempre: in produzione e'
  // bastato un `%E9` Latin-1 in un link perche' `URIError: URI malformed`
  // uccidesse l'intera sintesi, buttando via anche i candidati gia' riusciti.
  let synth;
  try {
    synth = await synthesizeSpec(c);
  } catch (err) {
    refused++;
    // Un URIError/parse su input malformato e' rumore atteso del loop (vedi
    // commento sopra) e va isolato in silenzio. Qualunque altro errore e' un
    // possibile bug di programmazione: lo isoliamo comunque (un datore rotto
    // non deve affondare lo stadio) ma con severita' maggiore, cosi' una
    // regressione in synthesizeSpec resta visibile invece di sparire dietro
    // "candidato rifiutato".
    const expected = isExpectedSynthesisError(err);
    // `err.message` senza guard esplode su `throw null`: sarebbe un'eccezione
    // DENTRO il catch, che abortisce lo stadio invece di isolare il candidato —
    // esattamente cio' che questo catch esiste per impedire.
    const message = String(err?.message ?? err ?? 'errore senza messaggio');
    // La distinzione va anche nello STORE, non solo nel canale di log: senza,
    // una regressione genuina finisce `rejected` identica al rumore atteso e
    // viene ri-scartata allo stesso ritmo, invisibile a `prospect-report.mjs`.
    setStatus(store, c.key, 'rejected', {
      reason: `sintesi in errore: ${message.slice(0, 120)}`,
      errorClass: expected ? 'expected' : 'unexpected',
    });
    recordCandidateAttempt(c.key, { outcome: 'error', reasonCode: expected ? 'expected_input_error' : 'unexpected_error' }, dryRun ? null : undefined);
    if (expected) {
      console.log(`  ✗ ${String(c.name).slice(0, 34).padEnd(36)} errore: ${message.slice(0, 70)}`);
    } else {
      console.error(`  ✗ ${String(c.name).slice(0, 34).padEnd(36)} errore INATTESO: ${err?.stack || message}`);
    }
    continue;
  }
  const { spec, reason, vacancies: found, retryable } = synth;
  if (!spec) {
    refused++;
    const failureReason = `sintesi fallita: ${reason}`;
    const retry = retryable ? scheduleSynthesisRetry(c, failureReason) : null;
    if (retry?.synthesisRetryable) {
      retried++;
      // The outcome describes this latest attempt. A legacy requeue's durable
      // provenance remains in synthesisRecoveryQueuedAt for conflict merges.
      setStatus(store, c.key, 'traced', {
        ...retry,
        synthesisOutcome: synth.reasonCode || 'retryable_failure',
        synthesisDiagnostics: synth.diagnostics || null,
        synthesisCommoncrawlCollection: c.commoncrawlCollection || null,
      });
      recordCandidateAttempt(c.key, {
        outcome: 'retryable_failure', reasonCode: synth.reasonCode || 'retryable_failure', reason,
      }, dryRun ? null : undefined);
      console.log(`  ↻ ${String(c.name).slice(0, 34).padEnd(36)} ${reason} — riprovo dopo ${retry.synthesisRetryAt}`);
    } else {
      setStatus(store, c.key, 'rejected', {
        reason: failureReason,
        synthesisRetryable: false,
        synthesisRetryAt: null,
        synthesisCommoncrawlCollection: c.commoncrawlCollection || null,
        ...(retry || {}),
      });
      recordCandidateAttempt(c.key, {
        outcome: 'rejected',
        reasonCode: retry?.synthesisRetryExhausted ? 'retry_limit_reached' : (synth.reasonCode || 'permanent_failure'),
        reason,
      }, dryRun ? null : undefined);
      console.log(`  ✗ ${String(c.name).slice(0, 34).padEnd(36)} ${reason}${retry?.synthesisRetryExhausted ? ' — retry esauriti' : ''}`);
    }
    continue;
  }
  const ownKey = spec.companyKey;
  spec.companyKey = disambiguateCrawlerKey(ownKey, c, (key) => (
    productionKeys.has(key) || hasOtherKeyOwner(key, c.key)
  ));
  if (spec.companyKey !== ownKey) console.log(`  · ${ownKey} e' gia' di un altro crawler: uso ${spec.companyKey}`);
  spec.candidateKey = c.key;
  addKeyOwner(spec.companyKey, c.key);
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
    synthesisRetryable: false,
    synthesisAttempts: 0,
    synthesisLastAttemptAt: null,
    synthesisRetryAt: null,
  });
  recordCandidateAttempt(c.key, { outcome: 'succeeded', reasonCode: 'verified_vacancies', reason: `${found.length} vacancies` }, dryRun ? null : undefined);
  console.log(`  ✓ ${String(spec.companyName).slice(0, 34).padEnd(36)} ${spec.mode.padEnd(10)} ${String(found.length).padStart(3)} annunci  ${spec.companyHost}`);
}

console.log(`\nspec scritte: ${written}   rifiutate: ${refused}   annunci coperti: ${vacancies}`);
console.log(`coda: ${JSON.stringify(statusCounts(store))}`);
if (dryRun) console.log('\n--dry-run: niente scritto.');
else { saveCandidates(store); console.log(`\nspec in ${path.relative(process.cwd(), SPEC_DIR)}/`); }
finishLedgerPhase(dryRun ? 'dry_run' : 'complete', { inputCount: queue.length, successCount: written, retryCount: retried });
