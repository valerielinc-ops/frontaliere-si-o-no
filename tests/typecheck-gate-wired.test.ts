/**
 * Il gate `tsc --noEmit` è cablato, e il nome load-bearing non è cambiato (#5540).
 *
 * Prima di #5540 questo repo non aveva typecheck: zero dei 285 script di
 * `package.json` invocava `tsc`, e `tests.yml` non nominava né `tsc` né
 * `typecheck`. Non se ne accorgeva nessuno perché nemmeno il build fallisce —
 * Vite compila con esbuild, che le annotazioni di tipo le RIMUOVE senza
 * verificarle. Questo test è il guard che impedisce di tornare in quello stato
 * cancellando lo script o il job (una regressione che, per costruzione, non
 * produrrebbe nessun altro segnale rosso).
 *
 * Il typecheck deve restare nello stesso job che governa l'auto-merge, ma la
 * sua fase ad alta memoria deve partire dopo Vitest e tutti i gate detached. Il
 * check `vitest (unit + integration)` è load-bearing: auto-merge-on-lgtm,
 * auto-merge-eval, pr-autorebase e stale-pr-rescuer lo selezionano per nome.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW_PATH = path.join(ROOT, '.github', 'workflows', 'tests.yml');
const GATE_SCRIPT = path.join('scripts', 'ci', 'check-typecheck-baseline.mjs');
const BASELINE_PATH = path.join(ROOT, 'data', 'typecheck-baseline.json');

const VITEST_JOB_NAME = 'vitest (unit + integration)';
const TYPECHECK_JOB_NAME = 'typecheck (tsc --noEmit)';

// Il gate gira sotto il sampler di memoria (follow-up #6573), in modo
// sincrono dopo che «Collect independent source gates» ha atteso gli altri
// processi. Questa regex identifica l'unico comando TSC eseguito dal workflow.
const GATE_RUN_RE =
  /env NODE_OPTIONS=--max-old-space-size=10240\s+\\\s*bash scripts\/ci\/sample-mem-during\.sh -- npm run typecheck:gate/;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

/** Nomi dei job di primo livello: righe a 2 spazi d'indentazione sotto `jobs:`. */
function topLevelJobKeys(yml: string): string[] {
  const afterJobs = yml.slice(yml.indexOf('\njobs:'));
  return [...afterJobs.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((m) => m[1]);
}

function namedStepBlock(yml: string, name: string): string {
  const start = yml.indexOf(`      - name: ${name}\n`);
  if (start < 0) return '';
  const end = yml.indexOf('\n      - ', start + 1);
  return yml.slice(start, end < 0 ? undefined : end);
}

describe('typecheck gate wiring (#5540)', () => {
  it('espone uno script npm `typecheck` che invoca davvero tsc in --noEmit', () => {
    const script = pkg.scripts.typecheck;
    expect(script, 'manca lo script `typecheck` in package.json').toBeTruthy();
    expect(script).toMatch(/\btsc\b/);
    expect(script).toMatch(/--noEmit\b/);
  });

  it('espone il gate con baseline e i suoi due comandi di servizio', () => {
    expect(pkg.scripts['typecheck:gate']).toContain(GATE_SCRIPT.split(path.sep).join('/'));
    expect(pkg.scripts['typecheck:baseline']).toContain('--write-baseline');
    expect(pkg.scripts['typecheck:list']).toContain('--list');
  });

  it('lo script del gate esiste ed è eseguibile da node', () => {
    expect(fs.existsSync(path.join(ROOT, GATE_SCRIPT))).toBe(true);
  });

  it('tests.yml lancia davvero il gate', () => {
    // Il check-run `typecheck (tsc --noEmit)` NON esiste più: con la fusione il
    // typecheck è uno step del job `vitest (unit + integration)`. Ciò che va
    // guardato è che il gate sia INVOCATO — che è anche l'unica cosa che il
    // vecchio `toContain(name:)` provava davvero.
    expect(workflow).not.toContain(`name: ${TYPECHECK_JOB_NAME}`);
    expect(workflow).toMatch(GATE_RUN_RE);
  });

  // Contratto ROVESCIATO con la fusione dei quattro job di tests.yml.
  //
  // Prima: «il typecheck deve stare in un job a sé, non dentro vitest» —
  // perché infilarlo nel job che produce il check-run load-bearing avrebbe
  // fatto dipendere l'auto-merge da un secondo attrezzo (#5540).
  //
  // Ora quella dipendenza è VOLUTA, su decisione esplicita del proprietario: è
  // esattamente ciò che rende il typecheck BLOCCANTE. Prima della fusione
  // `typecheck (tsc --noEmit)` era un check-run distinto che nessuno gattava —
  // misura in scripts/ci/lib/checkRunObservation.mjs (issue #5552), con PR
  // #5590 mergiata con `contract` = failure. Il guard resta, ma fissa
  // l'invariante nuova, che è più forte: il gate deve stare DENTRO l'unico
  // check-run che governa il merge.
  it('tests.yml espone solo il job che esegue tutti i cancelli', () => {
    // `post-review` gira dopo il required (autorebase + opt-in auto-merge) e
    // non esegue nessun cancello.
    expect(topLevelJobKeys(workflow)).toEqual(['vitest', 'post-review']);
    expect(workflow.slice(workflow.indexOf('\n  post-review:'))).not.toMatch(/typecheck:gate|run-related-tests/);
    expect(workflow).toContain(`name: ${VITEST_JOB_NAME}`);
  });

  it('il gate typecheck gira DENTRO il job del check-run gating', () => {
    const jobsBody = workflow.slice(workflow.indexOf('\njobs:'));
    const vitestBody = jobsBody.slice(jobsBody.indexOf('  vitest:'));
    expect(
      GATE_RUN_RE.test(vitestBody),
      'il gate `npm run typecheck:gate` non è più dentro il job `vitest` → un ' +
        'errore di tipo non fa più rosso il check che governa l’auto-merge.',
    ).toBe(true);
  });

  it('esegue TSC dopo tutti i gate detached, con heap dedicato da 10 GB', () => {
    const startGates = namedStepBlock(workflow, 'Start independent source gates');
    const collectGates = namedStepBlock(workflow, 'Collect independent source gates');
    expect(startGates, 'manca il lancio dei gate indipendenti').not.toBe('');
    expect(collectGates, 'manca la raccolta dei gate indipendenti').not.toBe('');
    expect(startGates).not.toMatch(/RUN_TSC|start_gate\s+tsc/);
    const waitForAll = collectGates.indexOf('done < "$expected_file"');
    const runTsc = collectGates.indexOf('sample-mem-during.sh -- npm run typecheck:gate');
    expect(waitForAll, 'TSC deve attendere tutti i gate detached').toBeGreaterThan(-1);
    expect(runTsc, 'TSC deve essere lanciato dopo la raccolta').toBeGreaterThan(waitForAll);
    expect(collectGates).toContain('RUN_TSC: ${{ !cancelled() && steps.body_contract.outcome != \'failure\' }}');
    expect(collectGates).toContain('NODE_OPTIONS=--max-old-space-size=10240');
    expect(workflow).not.toContain('Typecheck after related Vitest');
  });

  it('termina e verifica ogni process group detached prima di avviare TSC', () => {
    const collectGates = namedStepBlock(workflow, 'Collect independent source gates');
    const cleanup = collectGates.indexOf(
      'node scripts/ci/wait-for-detached-gate.mjs "$gate_pid" "$gate_pgid" "$collector_pgid" "$cleanup_mode"',
    );
    const runTsc = collectGates.indexOf('sample-mem-during.sh -- npm run typecheck:gate');
    expect(cleanup, 'manca l attesa/terminazione del process group detached').toBeGreaterThan(-1);
    expect(runTsc).toBeGreaterThan(cleanup);
    expect(collectGates).toContain('gate_timed_out=true');
    expect(collectGates).toContain('cleanup_mode=terminate-now');
    expect(collectGates).toContain('tsc_safe_to_start=false');
    expect(collectGates).toContain('[ "$tsc_safe_to_start" = "true" ]');
  });

  it('contract gira nel job gating; il detector non e\' piu\' qui', () => {
    const jobsBody = workflow.slice(workflow.indexOf('\njobs:'));
    const vitestBody = jobsBody.slice(jobsBody.indexOf('  vitest:'));
    // `contract` resta bloccante: se uscisse dal job fuso tornerebbe advisory
    // senza che nessun altro segnale lo dica (issue #5552).
    expect(vitestBody).toMatch(/PR-body completeness \+ multi-issue Closes/);
    // E il detector non deve rientrare: si riporterebbe dietro il lock globale.
    expect(vitestBody).not.toMatch(/scripts\/ci\/pr-collision-detector\.mjs/);
  });

  it('il nome load-bearing del check vitest è intatto', () => {
    // Se questo fallisce NON adeguare l'atteso: aggiornare il nome qui senza
    // aggiornare scripts/ci/lib/constants.mjs e i quattro workflow che ci fanno
    // select sopra lascia l'auto-merge cieco su un check che non esiste più.
    expect(workflow).toContain(`name: ${VITEST_JOB_NAME}`);
    const constants = fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'lib', 'constants.mjs'), 'utf8');
    expect(constants).toContain(VITEST_JOB_NAME);
  });

  it('il gate typecheck non gira senza checkout condiviso a monte', () => {
    // Nel job pesante, `npm run typecheck:gate` non ha un checkout+npm ci
    // propri: dipende da quelli condivisi in testa al job. Se qualcuno
    // togliesse la fase comune il gate morirebbe con un errore d'ambiente
    // (nessun node_modules), che è un rosso ma non quello che il gate deve dire.
    const jobsBody = workflow.slice(workflow.indexOf('\njobs:'));
    const vitestBody = jobsBody.slice(jobsBody.indexOf('  vitest:'));
    const checkoutAt = vitestBody.indexOf('uses: actions/checkout@v7');
    const setupAt = vitestBody.indexOf('uses: ./.github/actions/ci-npm-setup');
    const gateAt = vitestBody.search(GATE_RUN_RE);
    expect(checkoutAt, 'nessun checkout nel job fuso').toBeGreaterThan(-1);
    expect(setupAt, 'nessun ci-npm-setup nel job fuso').toBeGreaterThan(-1);
    expect(checkoutAt).toBeLessThan(setupAt);
    expect(setupAt).toBeLessThan(gateAt);
  });

  // La baseline vive sotto `data/`, che in un worktree sparse non è
  // materializzata (CLAUDE.md, «Stato macchina»). Assente = ambiente, non
  // regressione: in CI il checkout è pieno e queste asserzioni girano.
  const hasBaseline = fs.existsSync(BASELINE_PATH);
  it.runIf(hasBaseline)('la baseline è ben formata e non registra file di tests/ come bloccanti', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as {
      total: number;
      advisoryTotal: number;
      blockingTotal: number;
      blocking: Record<string, number>;
    };
    expect(Number.isInteger(baseline.total)).toBe(true);
    expect(Number.isInteger(baseline.advisoryTotal)).toBe(true);
    // La parte bloccante è per definizione ciò che NON sta sotto tests/.
    for (const file of Object.keys(baseline.blocking)) {
      expect(file.startsWith('tests/'), `${file} non può stare fra i bloccanti`).toBe(false);
    }
    const sum = Object.values(baseline.blocking).reduce((a, b) => a + b, 0);
    expect(sum).toBe(baseline.blockingTotal);
    expect(baseline.blockingTotal + baseline.advisoryTotal).toBe(baseline.total);
  });
});
