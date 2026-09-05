#!/usr/bin/env node
/**
 * explain-job-verdict.mjs — scrive nello Step Summary della run DI CHE COSA è
 * fatto il rosso del check richiesto.
 *
 * Il check che il ruleset richiede su `main` si chiama `vitest (unit +
 * integration)`, ma il job che lo produce porta l'intero cancello: contratto
 * del body della PR, source guard, lint, `tsc`, i test e in fondo il verdetto
 * della Claude review. Un rosso qualunque fra quei ~43 step si presenta al
 * lettore come «vitest», e cinque lettori diversi in un giorno solo ne hanno
 * concluso che fossero rotti i test mentre i test erano verdi.
 *
 * Questo step non cambia il nome del check e non cambia il verdetto: aggiunge
 * una riga leggibile in due secondi sulla pagina della run, che è il primo
 * posto dove si clicca dopo aver visto il rosso.
 *
 * ── FAIL-SOFT, PER COSTRUZIONE ───────────────────────────────────────────
 * Un segnalatore che fallisce non deve aggiungere un fallimento. Qui la
 * garanzia è doppia e deliberata: lo step nel workflow porta
 * `continue-on-error: true` (copre anche un crash del processo, un OOM, un
 * `gh` assente), e questo file non esce mai non-zero — ogni errore diventa una
 * riga di log e nient'altro. Se questo script si rompe, il verdetto del job
 * resta esattamente quello che sarebbe stato senza di lui.
 *
 * ── PERCHÉ L'API E NON `steps.<id>.outcome` ──────────────────────────────
 * Leggere gli esiti via espressione richiederebbe un `id:` su ogni step di cui
 * si vuole parlare: la classificazione conoscerebbe solo gli step che qualcuno
 * si è ricordato di marcare, e uno step rosso non marcato produrrebbe un
 * summary che non nomina nulla — un'altra bugia, in un meccanismo che esiste
 * per smettere di dirne. La jobs API restituisce TUTTI gli step con il loro
 * esito, quindi il rosso viene sempre nominato per nome anche quando cade
 * fuori dalle categorie note. Costa `actions: read` (sola lettura) e una
 * chiamata API.
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { VITEST_CHECK_NAME } from './lib/constants.mjs';
import { classifyJobFailure, formatJobFailureSummary } from './lib/jobFailureCategory.mjs';

/**
 * Gli step del job corrente, dalla jobs API dell'attempt in corso.
 * Il job in esecuzione è già presente nella risposta: gli step conclusi
 * portano la loro `conclusion`, questo step è `in_progress`.
 *
 * @returns {Array<{name?: string, conclusion?: string}>}
 */
function currentJobSteps() {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT || '1';
  if (!repo || !runId) throw new Error('GITHUB_REPOSITORY/GITHUB_RUN_ID assenti');
  const raw = execFileSync(
    'gh',
    [
      'api',
      '--paginate',
      '--slurp',
      `repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`,
    ],
    { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const jobs = JSON.parse(raw).flatMap((page) => page.jobs || []);
  const job = jobs.find((j) => j && j.name === VITEST_CHECK_NAME);
  if (!job) throw new Error(`job "${VITEST_CHECK_NAME}" non trovato nell'attempt ${attempt}`);
  return Array.isArray(job.steps) ? job.steps : [];
}

function main() {
  // `job.status` del job in corso, passato dal workflow. Sette step di questo
  // job sono `continue-on-error: true`: il loro rosso non tinge il job, e
  // scrivere un ❌ in cima alla pagina di una run verde sarebbe la stessa
  // bugia che questo step esiste per chiudere. Su una run cancellata non c'è
  // niente da spiegare e nemmeno un verde da dichiarare: si tace.
  const jobStatus = process.env.JOB_STATUS || '';
  if (jobStatus && jobStatus !== 'failure' && jobStatus !== 'success') {
    console.log(`JOB_VERDICT category=none job_status=${jobStatus} (nessun summary)`);
    return;
  }
  const verdict = classifyJobFailure(currentJobSteps(), { jobStatus });
  console.log(
    verdict
      ? `JOB_VERDICT category=${verdict.category} tests=${verdict.testsVerdict} failed_steps=${JSON.stringify(verdict.failedSteps)}`
      : `JOB_VERDICT category=none job_status=${jobStatus || 'n/d'}`,
  );
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) fs.appendFileSync(summary, `${formatJobFailureSummary(verdict, VITEST_CHECK_NAME)}\n`);
}

try {
  main();
} catch (error) {
  // Mai un secondo rosso: la diagnosi mancata si logga e basta.
  console.log(`::notice::Step Summary del verdetto non prodotto: ${error?.message || error}`);
}
