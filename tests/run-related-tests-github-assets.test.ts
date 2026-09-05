import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

/**
 * `scripts/ci/run-related-tests.mjs` è l'unico invocatore di Vitest nel job PR
 * di `tests.yml`. Il suo grafo è fatto di import statici fra sorgenti JS/TS, e
 * i file sotto `.github/` non ne fanno parte: non si importano, si aprono per
 * path letterale. Finché non erano nemmeno candidati, un diff di soli workflow
 * selezionava ZERO test — e siccome `tests.yml` gira solo su `pull_request`,
 * un contratto rotto su un workflow non aveva nessun gate né sulla PR né su
 * `main`. È la strada da cui #7355 ha spezzato l'adiacenza della terna shadow
 * in `.github/corpus-workflows/translate-pending.yml` (#7514, #7580).
 *
 * Il caso interroga il runner VERO in sottoprocesso e legge la selezione che
 * stampa: nessuna copia della regex o della lista di path da queste parti, così
 * non può restare verde mentre il sorgente diverge — il runner ha effetti
 * collaterali al top level e non va importato.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'scripts/ci/run-related-tests.mjs');

function selectionFor(changedPaths: string[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-github-'));
  const changedFile = path.join(dir, 'changed-paths.txt');
  fs.writeFileSync(changedFile, `${changedPaths.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'status.txt'), 'complete\n');
  const stdout = execFileSync(process.execPath, [RUNNER], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      CHANGED_PATHS_FILE: changedFile,
      CHANGED_PATHS_STATUS_FILE: path.join(dir, 'status.txt'),
      VITEST_RELATED_GRAPH: path.join(dir, 'graph.json'),
      VITEST_SKIP_CORPUS_WIDE: 'true',
      VITEST_RELATED_DRY_RUN: 'true',
    },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line.endsWith('.test.ts'));
}

describe('run-related-tests — un diff sotto .github/ seleziona i suoi guardiani', () => {
  it('il portable di translate-pending seleziona il test che ne congela il contratto', () => {
    // L'asserzione che #7355 ha rotto vive qui dentro
    // (`expect(finalize.index + 1).toBe(upload.index)`). Se questa selezione
    // torna vuota, quel contratto è di nuovo cieco su ogni PR.
    const selected = selectionFor(['.github/corpus-workflows/translate-pending.yml']);
    expect(selected).toContain('tests/crawler-generation-dispatch-workflow.test.ts');
  });

  it('il diff storico di #7355 avrebbe selezionato il test che era rosso', () => {
    // I sei file del merge 80e07838ac3, presi come li elenca `git show
    // --name-only`. Prima della fix la selezione ne vedeva 3 su 6 e non
    // conteneva nessuno dei tre guardiani: la PR è passata verde e il rosso è
    // atterrato su `main`.
    const selected = selectionFor([
      '.github/corpus-workflows/contract.json',
      '.github/corpus-workflows/translate-pending.yml',
      '.github/workflows/translate-pending-logic.yml',
      'scripts/lib/thinking-ab.mjs',
      'scripts/relocalize-pending-jobs.mjs',
      'tests/thinking-ab.test.ts',
    ]);
    expect(selected).toContain('tests/crawler-generation-dispatch-workflow.test.ts');
    expect(selected).toContain('tests/crawler-generation-barrier-workflows.test.ts');
    expect(selected).toContain('tests/generate-crawler-group-workflows.test.ts');
  });

  it('il portable di quel commit violava davvero l\'adiacenza che il test pretende', () => {
    // La prova che la selezione mancata è costata un rosso vero, non ipotetico:
    // al commit di #7355 uno step estraneo separava finalize da upload.
    const portable = execFileSync('git', [
      'show', '80e07838ac3:.github/corpus-workflows/translate-pending.yml',
    ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const names = [...portable.matchAll(/^ {6}- name: (.+)$/gm)]
      .map(([, name]) => name.trim().replace(/^["']|["']$/g, ''));
    const finalize = names.indexOf('Finalize translation shadow preflight v2 observation');
    const upload = names.indexOf('Upload translation shadow preflight v2 artifacts');
    expect(finalize).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(-1);
    expect(upload).not.toBe(finalize + 1);
    expect(names[finalize + 1]).toBe('Upload thinking A/B rows');
  });

  it('un workflow che nessun test nomina non fa ricadere sulla suite intera', () => {
    // Il fallback conservativo resta deciso sui soli candidati SORGENTE: la
    // politica related-only di `tests.yml` — un diff senza candidati costa zero
    // test invece della suite — non deve diventare ~1900 file per una PR di
    // soli workflow.
    const orphan = '.github/workflows/analytics.yml';
    expect(fs.existsSync(path.join(ROOT, orphan)), `${orphan}: il caso vale solo su un workflow che esiste`).toBe(true);
    expect(selectionFor([orphan]).length).toBeLessThan(100);
  });
});
