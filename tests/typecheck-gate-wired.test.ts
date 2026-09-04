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
 * Guarda anche il rischio opposto: il job del typecheck deve restare SEPARATO
 * da quello di vitest, e il check `vitest (unit + integration)` deve continuare
 * a chiamarsi esattamente così — auto-merge-on-lgtm, auto-merge-eval gate 3,
 * pr-autorebase e stale-pr-rescuer ci fanno `select` sopra, quindi rinominarlo
 * (o assorbire il typecheck dentro di lui) romperebbe l'auto-merge senza che
 * nessun test dei tipi se ne accorga.
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

// Il gate gira sotto il sampler di memoria (follow-up #6573,
// `scripts/ci/sample-mem-during.sh -- npm run typecheck:gate`): il prefisso
// e' opzionale nella regex cosi' il contratto resta vero sia con sia senza il
// wrapper, ma continua a pretendere che `npm run typecheck:gate` sia
// realmente invocato.
const GATE_RUN_RE = /run:\s+(?:bash scripts\/ci\/sample-mem-during\.sh -- )?npm run typecheck:gate/;

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const workflow = fs.readFileSync(WORKFLOW_PATH, 'utf8');

/** Nomi dei job di primo livello: righe a 2 spazi d'indentazione sotto `jobs:`. */
function topLevelJobKeys(yml: string): string[] {
  const afterJobs = yml.slice(yml.indexOf('\njobs:'));
  return [...afterJobs.matchAll(/^ {2}([A-Za-z0-9_-]+):$/gm)].map((m) => m[1]);
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
  it('tests.yml ha UN SOLO job, ed e\' quello del check-run gating', () => {
    const jobs = topLevelJobKeys(workflow);
    expect(
      jobs,
      'contratto aggiornato il 2026-08-26. `contract` e `typecheck` DEVONO ' +
        "restare nel job che produce il check-run gating (e' la fusione a " +
        'renderli bloccanti, issue #5552). Il detector di collisioni invece e\' ' +
        'uscito del tutto da questo workflow: e\' uno sweeper repo-wide, vive su ' +
        'cron in pr-collision-detector.yml, e tenerlo qui significava o un lock ' +
        'globale che accodava la suite di ogni PR dietro quella di tutte le ' +
        'altre, o una ✗ falsa da run sfrattato. Non aggiungere job qui senza la ' +
        'stessa analisi.',
    ).toEqual(['vitest']);
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
    // Con un job solo, `npm run typecheck:gate` non ha più un checkout+npm ci
    // propri: dipende da quelli condivisi in testa al job. Se qualcuno togliesse
    // la fase comune il gate morirebbe con un errore d'ambiente (nessun
    // node_modules), che è un rosso ma non quello che il gate deve dire.
    const jobsBody = workflow.slice(workflow.indexOf('\njobs:'));
    const vitestBody = jobsBody.slice(jobsBody.indexOf('  vitest:'));
    const checkoutAt = vitestBody.indexOf('uses: actions/checkout@v5');
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
