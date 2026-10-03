import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * I contratti di processo alla radice (`AGENTS.md`, `REVIEW.md`, `ISSUES.md`,
 * `FOLLOWUP.md`, …) non si importano: i test che ne congelano le frasi li
 * aprono per path letterale. Prima di questo indice una PR che toccava soltanto
 * uno di quei file faceva stampare al runner «No existing source/test files in
 * the diff» e non eseguiva niente, né sulla PR né su `main`.
 *
 * Come in `run-related-tests-github-assets.test.ts`, il caso interroga il
 * runner VERO in sottoprocesso e legge la selezione che stampa: il runner ha
 * effetti collaterali al top level e non va importato.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNNER = path.join(ROOT, 'scripts/ci/run-related-tests.mjs');
const sharedGraphDir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-doc-contracts-'));

afterAll(() => fs.rmSync(sharedGraphDir, { recursive: true, force: true }));

function selectionOutputFor(changedPaths: string[]) {
  const changedFile = path.join(sharedGraphDir, 'changed-paths.txt');
  fs.writeFileSync(changedFile, `${changedPaths.join('\n')}\n`);
  fs.writeFileSync(path.join(sharedGraphDir, 'status.txt'), 'complete\n');
  return execFileSync(process.execPath, [RUNNER], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      CHANGED_PATHS_FILE: changedFile,
      CHANGED_PATHS_STATUS_FILE: path.join(sharedGraphDir, 'status.txt'),
      VITEST_RELATED_GRAPH: path.join(sharedGraphDir, 'graph.json'),
      VITEST_SKIP_CORPUS_WIDE: 'true',
      VITEST_RELATED_DRY_RUN: 'true',
      // Stesso motivo del gemello sugli asset `.github`: il seam di dry-run è
      // disarmato sotto GitHub Actions, e questo sottoprocesso è nostro.
      GITHUB_ACTIONS: '',
      GITHUB_BASE_REF: '',
    },
  });
}

function selectionFor(changedPaths: string[]) {
  return selectionOutputFor(changedPaths)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /\.test\.[cm]?[jt]sx?$/i.test(line));
}

describe('run-related-tests — un diff di soli contratti di radice seleziona chi li legge', () => {
  it('ogni contratto seleziona i test che lo aprono per path', () => {
    const expectations: Array<[string, string[]]> = [
      ['AGENTS.md', ['tests/issue-fix-agents-contract.test.ts', 'tests/agents-related-tests-recipe.test.ts']],
      ['REVIEW.md', ['tests/review-gate-body-truth.test.ts', 'tests/pr-redflag-fixer-declared-state.test.ts']],
      ['ISSUES.md', ['tests/issue-fix-app-token-wiring.test.ts']],
      ['FOLLOWUP.md', ['tests/followup-acceptance-condition.test.ts']],
      ['DECISIONS.md', ['tests/issue-fix-decision-registry.test.ts']],
      ['VISION.md', ['tests/seo-gates-improvement-report.test.ts']],
    ];
    for (const [doc, readers] of expectations) {
      expect(fs.existsSync(path.join(ROOT, doc)), doc).toBe(true);
      const output = selectionOutputFor([doc]);
      expect(output, doc).toContain('+ 1 root doc contract(s)');
      const selected = output.split('\n').map((line) => line.trim());
      for (const reader of readers) expect(selected, `${doc} → ${reader}`).toContain(reader);
    }
  }, 300_000);

  it('un modulo sorgente che cita il contratto non trascina i suoi importatori', () => {
    // Misurato il 2026-10-02: con gli archi anche dai sorgenti, `AGENTS.md`
    // selezionava 344 file di test, quasi tutti importatori di moduli che lo
    // citano in un prompt o in un messaggio d'errore. Questo test del drainer
    // ne era uno: non nomina il contratto e non lo legge.
    const selected = selectionFor(['AGENTS.md']);
    expect(selected).not.toContain('tests/followup-drainer-parent-close-budget.test.ts');
    expect(selected.length).toBeLessThan(100);
  }, 300_000);

  it('un markdown fuori elenco non diventa una selezione', () => {
    // `README.md` è il nome di fixture più comune nei test che costruiscono un
    // repo temporaneo: indicizzarlo selezionerebbe test estranei.
    // L'unico test che entra è il gate dei segreti hardcoded, che scandisce
    // anche il Markdown: nessun test scelto per il NOME del file.
    expect(selectionFor(['README.md'])).toEqual(['tests/no-hardcoded-secrets.test.ts']);
  }, 300_000);
});
