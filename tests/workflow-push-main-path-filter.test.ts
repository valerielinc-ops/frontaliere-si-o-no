/**
 * Contratto di coda: un workflow che parte su OGNI push verso `main` paga uno
 * slot runner per ogni commit, anche quando il commit non tocca codice.
 *
 * Misura del 2026-09-19 su 24 h di questo repo (5.268 run):
 *  - il tetto dell'account è 20-22 job in esecuzione insieme (plateau piatto
 *    per 76 minuti consecutivi fra le 18:30 e le 19:45Z, mai superato);
 *  - a tetto saturo l'attesa in coda di `tests` su una PR passa da 258 s medi
 *    (meno di 50 run vive) a 985 s (50 o più), con una punta di 2.733 s;
 *  - `main` ha ricevuto 317 commit, 201 dei quali toccano solo `data/`,
 *    `public/data/`, `docs/` o `*.md`.
 *
 * 28 dei 29 workflow con `push` su `main` dichiarano già un filtro di path:
 * questo file trasforma quella convenzione in un invariante verificabile e
 * tiene la deroga di `tests.yml` scritta e contabilizzata invece che implicita.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  branchPatternCoversMain,
  validatePushMainPathFilter,
  PUSH_MAIN_PATH_FILTER_EXEMPTIONS,
} from '../scripts/ci/validate-modified-workflows.mjs';

const WORKFLOWS_DIR = '.github/workflows';

const reasons = (file: string, text: string) =>
  validatePushMainPathFilter(file, text).map((offender: { reason: string }) => offender.reason);

describe('validatePushMainPathFilter — un push su main senza filtro è un reperto', () => {
  it('segnala push su main senza paths né paths-ignore', () => {
    const text = ['name: demo', 'on:', '  push:', '    branches: [main]', 'jobs: {}'].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toHaveLength(1);
  });

  it('segnala `push:` nudo, che parte su ogni branch', () => {
    const text = ['name: demo', 'on:', '  push:', '  workflow_dispatch:', 'jobs: {}'].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)[0]).toContain('ogni branch');
  });

  it('segnala la forma inline `on: [push, ...]`, che non può portare un filtro', () => {
    const text = ['name: demo', 'on: [push, workflow_dispatch]', 'jobs: {}'].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)[0]).toContain('inline');
  });

  it('accetta paths-ignore in forma a lista', () => {
    const text = [
      'name: demo', 'on:', '  push:', '    branches:', '      - main',
      '    paths-ignore:', "      - 'data/loop-fleet/**'", 'jobs: {}',
    ].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toEqual([]);
  });

  it('accetta paths in forma flow', () => {
    const text = [
      'name: demo', 'on:', '  push:', '    branches: [main]',
      "    paths: ['scripts/**']", 'jobs: {}',
    ].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toEqual([]);
  });

  it('ignora un workflow che non parte su main', () => {
    const text = ['name: demo', 'on:', '  push:', '    branches: [release/*]', 'jobs: {}'].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toEqual([]);
  });

  it('ignora un workflow che esclude main con branches-ignore', () => {
    const text = ['name: demo', 'on:', '  push:', '    branches-ignore: [main]', 'jobs: {}'].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toEqual([]);
  });

  it('ignora un trigger di soli tag', () => {
    const text = ['name: demo', 'on:', '  push:', "    tags: ['v*']", 'jobs: {}'].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toEqual([]);
  });

  it('ignora un workflow senza push', () => {
    const text = ['name: demo', 'on:', '  pull_request:', '    branches: [main]', 'jobs: {}'].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toEqual([]);
  });

  it('non si lascia ingannare da un commento che nomina paths-ignore', () => {
    const text = [
      'name: demo', 'on:', '  push:', '    branches: [main]',
      '    # paths-ignore: qui ci andrebbe, ma non c’è', 'jobs: {}',
    ].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toHaveLength(1);
  });

  // Reperto 🟡 della review di PR #9326, riprodotto: `on:` come sequenza a
  // blocchi e `on:`/`push:` come flow map sono YAML validi che producono lo
  // stesso workflow della forma a blocchi, e passavano il gate intatti.
  it('segnala `on:` come sequenza a blocchi che contiene push', () => {
    const text = ['name: demo', 'on:', '  - push', '  - workflow_dispatch', 'jobs: {}'].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)[0]).toContain('sequenza di eventi');
  });

  it('ignora `on:` come sequenza a blocchi senza push', () => {
    const text = ['name: demo', 'on:', '  - pull_request', 'jobs: {}'].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toEqual([]);
  });

  it('segnala `on:` come flow map con push senza filtro', () => {
    const text = ['name: demo', 'on: {push: {branches: [main]}}', 'jobs: {}'].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toHaveLength(1);
  });

  it('accetta `on:` come flow map con push filtrato', () => {
    const text = ['name: demo', "on: {push: {branches: [main], paths: ['scripts/**']}}", 'jobs: {}'].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toEqual([]);
  });

  it('ignora `on:` come flow map senza push', () => {
    const text = ['name: demo', 'on: {pull_request: {branches: [main]}}', 'jobs: {}'].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toEqual([]);
  });

  it('segnala `push:` come flow map inline senza filtro', () => {
    const text = ['name: demo', 'on:', '  push: {branches: [main]}', 'jobs: {}'].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toHaveLength(1);
  });

  it('accetta `push:` come flow map inline con paths', () => {
    const text = ['name: demo', 'on:', "  push: {branches: [main], paths: ['scripts/**']}", 'jobs: {}'].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toEqual([]);
  });

  it('accetta `push:` come flow map inline di soli tag', () => {
    const text = ['name: demo', 'on:', "  push: {tags: ['v*']}", 'jobs: {}'].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toEqual([]);
  });

  it('non spezza una flow map sulle virgole annidate', () => {
    const text = [
      'name: demo', 'on:',
      "  push: {branches: [main, release/*], paths-ignore: ['docs/**', '*.md']}",
      'jobs: {}',
    ].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toEqual([]);
  });

  it('non guarda i paths di un altro evento', () => {
    const text = [
      'name: demo', 'on:', '  pull_request:', "    paths: ['scripts/**']",
      '  push:', '    branches: [main]', 'jobs: {}',
    ].join('\n');
    expect(reasons(`${WORKFLOWS_DIR}/demo.yml`, text)).toHaveLength(1);
  });
});

describe('branchPatternCoversMain', () => {
  it.each([
    ['main', true],
    ['ma*', true],
    ['**', true],
    ['*', true],
    ['!main', true],
    ['release/*', false],
    ['feature/**', false],
    ['', false],
  ])('%s → %s', (pattern, covered) => {
    expect(branchPatternCoversMain(pattern)).toBe(covered);
  });
});

describe('inventario del repository', () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((name) => /\.ya?ml$/u.test(name)).sort();

  it('nessun workflow parte su ogni push verso main senza filtro', () => {
    const offenders = files.flatMap((name) => {
      const path = join(WORKFLOWS_DIR, name);
      return validatePushMainPathFilter(path, readFileSync(path, 'utf8'));
    });
    expect(offenders.map((offender: { file: string }) => offender.file)).toEqual([]);
  });

  it('ogni deroga esiste ancora ed è ancora necessaria', () => {
    for (const [path, reason] of Object.entries(PUSH_MAIN_PATH_FILTER_EXEMPTIONS)) {
      expect(files, `deroga per un file inesistente: ${path}`)
        .toContain(path.slice(`${WORKFLOWS_DIR}/`.length));
      expect(String(reason).length, `deroga senza motivo scritto: ${path}`).toBeGreaterThan(40);
      // Il giorno in cui il filtro arriva, la deroga va tolta: senza questo
      // controllo resterebbe a coprire un workflow che non ne ha più bisogno.
      const masked = validatePushMainPathFilter(
        join(WORKFLOWS_DIR, `probe-${path.slice(`${WORKFLOWS_DIR}/`.length)}`),
        readFileSync(path, 'utf8'),
      );
      expect(masked, `deroga superflua, il filtro c’è già: ${path}`).toHaveLength(1);
    }
  });
});
