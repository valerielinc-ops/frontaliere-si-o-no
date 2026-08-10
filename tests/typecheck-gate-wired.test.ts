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

  it('tests.yml ha un job typecheck che lancia il gate', () => {
    expect(workflow).toContain(`name: ${TYPECHECK_JOB_NAME}`);
    expect(workflow).toMatch(/run:\s+npm run typecheck:gate/);
  });

  it('il job typecheck è un job a sé, non uno step dentro vitest', () => {
    const jobs = topLevelJobKeys(workflow);
    expect(jobs).toContain('typecheck');
    expect(jobs).toContain('vitest');
    expect(jobs.length).toBeGreaterThanOrEqual(2);
  });

  it('il nome load-bearing del check vitest è intatto', () => {
    // Se questo fallisce NON adeguare l'atteso: aggiornare il nome qui senza
    // aggiornare scripts/ci/lib/constants.mjs e i quattro workflow che ci fanno
    // select sopra lascia l'auto-merge cieco su un check che non esiste più.
    expect(workflow).toContain(`name: ${VITEST_JOB_NAME}`);
    const constants = fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'lib', 'constants.mjs'), 'utf8');
    expect(constants).toContain(VITEST_JOB_NAME);
  });

  it('il typecheck non è stato infilato dentro il job vitest', () => {
    const jobsBody = workflow.slice(workflow.indexOf('\njobs:'));
    const vitestBody = jobsBody.slice(jobsBody.indexOf('  vitest:'));
    expect(vitestBody).not.toMatch(/npm run typecheck/);
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
