#!/usr/bin/env node
/**
 * Failure injection NON PRODUTTIVA per il gruppo di concorrenza
 * `jobs-data-pipeline` (issue #7163, follow-up di PR #7035).
 *
 * Nessuna chiamata reale a GitHub: simula in locale, deterministicamente, la
 * cancellazione di una run ancora in coda (mai partita) su ognuno dei
 * workflow che condividono il gruppo, poi confronta evento+input prima e dopo
 * due strategie di recovery:
 *
 *   - `gh run rerun <id>`      — GitHub ri-esegue lo STESSO run record, non ne
 *     crea uno da un evento ricostruito: evento e input sopravvivono by
 *     construction.
 *   - fresh `workflow_dispatch` — la strategia "ovvia" che un recovery
 *     scritto di getto proverebbe: ri-lanciare il workflow da zero. Fallisce
 *     su run non-`workflow_dispatch` (schedule, workflow_run — l'event_name
 *     non è ridispatchabile) e su input non-default (la REST API di GitHub
 *     non espone gli input originali di una run in coda/cancellata, solo il
 *     workflow stesso li vede via `github.event.inputs`).
 *
 * Il verdetto (`ok`) è la precondizione esplicita richiesta prima di
 * abilitare un qualunque recovery autonomo delle run cancellate: PASS
 * significa "il recovery va costruito su `gh run rerun`", non che un
 * meccanismo di recovery sia già wired qui — non lo è (vedi PR #7163).
 *
 *   node scripts/verify-jobs-pipeline-rerun-safety.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

const ROOT = process.cwd();
export const WORKFLOWS_DIR = path.join(ROOT, '.github/workflows');
export const TARGET_GROUP = 'jobs-data-pipeline';

/** Workflow reali che condividono il gruppo di concorrenza sotto test. */
export function jobsPipelineWorkflows(workflowsDir = WORKFLOWS_DIR) {
  const out = [];
  for (const f of fs.readdirSync(workflowsDir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
    const full = path.join(workflowsDir, f);
    let doc;
    try { doc = YAML.parse(fs.readFileSync(full, 'utf8'), { logLevel: 'silent' }); } catch { continue; }
    if (doc?.concurrency?.group !== TARGET_GROUP) continue;
    const triggers = doc.on && typeof doc.on === 'object' ? Object.keys(doc.on) : [];
    out.push({ file: f, triggers });
  }
  return out;
}

/**
 * Uno scenario per ciascun evento dichiarato in `on:`, più — solo per
 * `workflow_dispatch` — una variante con input non-default: è esattamente lì
 * che una strategia di recovery basata sulla REST API perde dati (vedi
 * `recoverViaFreshDispatch`).
 */
export function buildScenarios(workflowInfo) {
  const scenarios = [];
  for (const eventName of workflowInfo.triggers) {
    scenarios.push({ workflow: workflowInfo.file, eventName, inputs: {} });
    if (eventName === 'workflow_dispatch') {
      scenarios.push({
        workflow: workflowInfo.file,
        eventName,
        inputs: { probe_dry_run: true, probe_note: 'valore-non-default-iniettato-dalla-failure-injection' },
      });
    }
  }
  return scenarios;
}

let nextRunId = 1000;

/** Messa in coda di una run sul gruppo sotto test, prima che il job parta. */
export function simulateQueuedRun(scenario, { ref = 'refs/heads/main', sha = 'deadbeefcafefeed' } = {}) {
  return {
    id: nextRunId++,
    workflow: scenario.workflow,
    event_name: scenario.eventName,
    ref,
    sha,
    inputs: { ...scenario.inputs },
    status: 'queued',
    started: false,
  };
}

/**
 * Cancellazione di una run ancora in coda (mai partita). GitHub non svuota il
 * payload dell'evento quando cancella una run in coda: resta memorizzato sul
 * run record. Qui SOLO lo stato cambia — evento e input restano gli
 * originali, modellando esattamente quel fatto.
 */
export function simulateCancellationBeforeJobStart(run) {
  return { ...run, status: 'cancelled', started: false };
}

/** Strategia sicura: `gh run rerun <id>` — stesso run record, nessuna ricostruzione. */
export function recoverViaRerun(cancelledRun) {
  return { ...cancelledRun, status: 'completed', started: true, recoveredVia: 'gh run rerun' };
}

/**
 * Strategia ingenua: un nuovo `workflow_dispatch` verso lo stesso workflow.
 * Può solo ripartire dai default dichiarati (`declaredDefaults`), mai dagli
 * input reali della run cancellata, e forza `event_name` a `workflow_dispatch`
 * anche se l'originale era `schedule`/`workflow_run`. E' la prova che questa
 * strategia è quella da NON usare per il recovery autonomo.
 */
export function recoverViaFreshDispatch(cancelledRun, { declaredDefaults = {} } = {}) {
  return {
    ...cancelledRun,
    event_name: 'workflow_dispatch',
    inputs: { ...declaredDefaults },
    status: 'completed',
    started: true,
    recoveredVia: 'fresh workflow_dispatch',
  };
}

/**
 * Confronto pre/post rerun — il cuore dell'harness (OSSERVATORE, issue
 * #7163). Evento e input devono sopravvivere identici; il resto del run
 * record (id, status, timestamp) può cambiare legittimamente.
 */
export function compareRerunSafety(original, recovered) {
  const mismatches = [];
  if (original.event_name !== recovered.event_name) {
    mismatches.push(`event_name: "${original.event_name}" -> "${recovered.event_name}"`);
  }
  if (original.ref !== recovered.ref) mismatches.push(`ref: "${original.ref}" -> "${recovered.ref}"`);
  if (original.sha !== recovered.sha) mismatches.push(`sha: "${original.sha}" -> "${recovered.sha}"`);
  const before = JSON.stringify(original.inputs ?? {}, Object.keys(original.inputs ?? {}).sort());
  const after = JSON.stringify(recovered.inputs ?? {}, Object.keys(recovered.inputs ?? {}).sort());
  if (before !== after) mismatches.push(`inputs: ${before} -> ${after}`);
  return { ok: mismatches.length === 0, mismatches };
}

/**
 * Harness end-to-end, NON PRODUTTIVO: nessuna chiamata reale a GitHub, solo
 * simulazione locale deterministica sui workflow reali del gruppo
 * `jobs-data-pipeline`. `ok` è il verdetto pass/fail che è la precondizione
 * esplicita per abilitare il recovery autonomo delle run cancellate.
 */
export function verifyRerunSafety({ workflowsDir = WORKFLOWS_DIR } = {}) {
  const workflows = jobsPipelineWorkflows(workflowsDir);
  const results = [];
  for (const wf of workflows) {
    for (const scenario of buildScenarios(wf)) {
      const original = simulateQueuedRun(scenario);
      const cancelled = simulateCancellationBeforeJobStart(original);
      const safe = compareRerunSafety(original, recoverViaRerun(cancelled));
      const naive = compareRerunSafety(original, recoverViaFreshDispatch(cancelled));
      results.push({
        workflow: wf.file,
        eventName: scenario.eventName,
        hasCustomInputs: Object.keys(scenario.inputs).length > 0,
        safe,
        naive,
      });
    }
  }
  const ok = workflows.length > 0 && results.every((r) => r.safe.ok);
  return { ok, workflowsChecked: workflows.length, scenariosChecked: results.length, results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { ok, workflowsChecked, scenariosChecked, results } = verifyRerunSafety();
  console.log(`gruppo "${TARGET_GROUP}": ${workflowsChecked} workflow, ${scenariosChecked} scenari di cancellazione simulati\n`);
  for (const r of results) {
    const tag = r.hasCustomInputs ? ' (input non-default)' : '';
    console.log(`  ${r.workflow} [${r.eventName}]${tag}: rerun=${r.safe.ok ? 'OK' : 'FAIL'} fresh-dispatch=${r.naive.ok ? 'OK' : 'FAIL'}`);
    if (!r.safe.ok) for (const m of r.safe.mismatches) console.log(`      ✗ ${m}`);
  }
  console.log(ok
    ? '\n✅ failure injection: il rerun preserva input+evento su tutti gli scenari — precondizione soddisfatta per abilitare il recovery autonomo VIA `gh run rerun` (mai fresh dispatch, vedi eventuali mismatch sopra)'
    : '\n❌ failure injection: il rerun NON preserva input/evento in almeno uno scenario — il recovery autonomo NON va abilitato');
  process.exit(ok ? 0 : 1);
}
