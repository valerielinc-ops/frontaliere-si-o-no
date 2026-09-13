import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, it, expect } from 'vitest';

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
const REMOVED_GITHUB_ASSET = '.github/workflows/removed-for-related-selection.yml';
const REMOVED_TEST_FIXTURE = 'tests/fixtures/removed-for-related-selection.json';
const sharedGraphDir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-github-shared-'));

afterAll(() => fs.rmSync(sharedGraphDir, { recursive: true, force: true }));

function selectionFor(changedPaths: string[], reuseDir = sharedGraphDir) {
  const dir = reuseDir;
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
      // Il seam è disarmato sotto GitHub Actions, così una variabile trapelata
      // nel job bloccante non può renderlo verde senza eseguire test. Qui il
      // sottoprocesso è nostro e lo vogliamo in dry-run anche quando la suite
      // gira in CI, quindi la togliamo esplicitamente per questo figlio.
      GITHUB_ACTIONS: '',
    },
  });
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line.endsWith('.test.ts'));
}

function runRunnerWithEnv(
  changedPaths: string[],
  env: Record<string, string>,
  args: string[] = [],
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-runner-'));
  const changedFile = path.join(dir, 'changed-paths.txt');
  fs.writeFileSync(changedFile, `${changedPaths.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'status.txt'), 'complete\n');
  try {
    return spawnSync(process.execPath, [RUNNER, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        CHANGED_PATHS_FILE: changedFile,
        CHANGED_PATHS_STATUS_FILE: path.join(dir, 'status.txt'),
        VITEST_RELATED_GRAPH: path.join(dir, 'graph.json'),
        VITEST_SKIP_CORPUS_WIDE: 'true',
        ...env,
      },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function createRenameFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-rename-fixture-'));
  fs.mkdirSync(path.join(dir, '.github/workflows'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.github/workflows/old.yml'), 'name: old\n');
  fs.writeFileSync(
    path.join(dir, 'tests/consumer.test.ts'),
    "export const workflowDir = '.github/workflows';\n",
  );
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'related-assets-test'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'base'], { cwd: dir });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', base], { cwd: dir });
  fs.renameSync(
    path.join(dir, '.github/workflows/old.yml'),
    path.join(dir, '.github/workflows/new.yml'),
  );
  fs.appendFileSync(path.join(dir, 'tests/consumer.test.ts'), '\n');
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'rename workflow'], { cwd: dir });
  const child = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
  // A hostile base ref that points at HEAD makes the inherited GITHUB_BASE_REF
  // path produce an empty diff. The runner helper must clear it and use the
  // fixture's origin/main, matching the PR job's local selection contract.
  execFileSync('git', ['update-ref', 'refs/remotes/origin/ci-base', child], { cwd: dir });
  return dir;
}

function createRunnerVariant(source: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-rename-runner-'));
  const ciDir = path.join(dir, 'scripts/ci');
  const libDir = path.join(ciDir, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.writeFileSync(path.join(ciDir, 'run-related-tests.mjs'), source);
  for (const file of [
    'corpus-wide-tests.mjs',
    'dataset-dependent-tests.mjs',
  ]) {
    fs.symlinkSync(path.join(ROOT, 'scripts/ci', file), path.join(ciDir, file));
  }
  for (const file of [
    'orphan-fallback.mjs',
    'select-max-workers.mjs',
    'related-graph-scope.mjs',
  ]) {
    fs.symlinkSync(path.join(ROOT, 'scripts/ci/lib', file), path.join(libDir, file));
  }
  return dir;
}

function createStatusStreamGitWrapper() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-status-stream-git-'));
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const wrapper = path.join(dir, 'git');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = "diff" ]; then
  case " $* " in
    *" --name-status "*)
      printf 'R100\\000.github/workflows/old-for-parser.yml\\000A\\000.github/workflows/brand-new-for-parser.yml\\000'
      exit 0
      ;;
  esac
fi
exec "$RELATED_TESTS_REAL_GIT" "$@"
`);
  fs.chmodSync(wrapper, 0o755);
  return { dir, realGit };
}

function runRunnerInFixture(
  fixtureDir: string,
  runnerDir: string,
  suffix: string,
  extraEnv: Record<string, string> = {},
) {
  const changedFile = path.join(fixtureDir, `changed-${suffix}.txt`);
  const graphFile = path.join(fixtureDir, `graph-${suffix}.json`);
  fs.writeFileSync(changedFile, 'tests/consumer.test.ts\n');
  fs.writeFileSync(path.join(fixtureDir, `status-${suffix}.txt`), 'complete\n');
  const result = spawnSync(
    process.execPath,
    [path.join(runnerDir, 'scripts/ci/run-related-tests.mjs')],
    {
      cwd: fixtureDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        CHANGED_PATHS_FILE: changedFile,
        CHANGED_PATHS_STATUS_FILE: path.join(fixtureDir, `status-${suffix}.txt`),
        VITEST_RELATED_GRAPH: graphFile,
        VITEST_SKIP_CORPUS_WIDE: 'true',
        VITEST_RELATED_DRY_RUN: 'true',
        GITHUB_ACTIONS: '',
        // The helper resolves the fixture against origin/main. Do not let a
        // real CI GITHUB_BASE_REF select a different (or unavailable) ref.
        GITHUB_BASE_REF: '',
        ...extraEnv,
      },
    },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(fs.readFileSync(graphFile, 'utf8'));
}

describe('run-related-tests — un diff sotto .github/ seleziona i suoi guardiani', () => {
  it('il portable di translate-pending seleziona il test che ne congela il contratto', () => {
    // L'asserzione che #7355 ha rotto vive qui dentro
    // (`expect(finalize.index + 1).toBe(upload.index)`). Se questa selezione
    // torna vuota, quel contratto è di nuovo cieco su ogni PR.
    const selected = selectionFor(['.github/corpus-workflows/translate-pending.yml']);
    expect(selected).toContain('tests/crawler-generation-dispatch-workflow.test.ts');
  }, 120_000);

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
  }, 120_000);

  it('una rimozione di asset .github conserva il path precedente nel grafo', () => {
    expect(fs.existsSync(path.join(ROOT, REMOVED_GITHUB_ASSET))).toBe(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-deleted-github-'));
    try {
      const selected = selectionFor([REMOVED_GITHUB_ASSET], dir);
      expect(selected).toContain('tests/run-related-tests-github-assets.test.ts');
      const graph = JSON.parse(fs.readFileSync(path.join(dir, 'graph.json'), 'utf8'));
      expect(graph.files['tests/run-related-tests-github-assets.test.ts'].deps)
        .toContain(REMOVED_GITHUB_ASSET);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('un fixture JSON sotto tests seleziona il test che lo legge per path', () => {
    expect(fs.existsSync(path.join(ROOT, REMOVED_TEST_FIXTURE))).toBe(false);
    expect(selectionFor([REMOVED_TEST_FIXTURE]))
      .toContain('tests/run-related-tests-github-assets.test.ts');
  }, 120_000);

  it('rifiuta il dry-run quando il processo gira in GitHub Actions', () => {
    const result = runRunnerWithEnv(
      ['tests/run-related-tests-github-assets.test.ts'],
      { GITHUB_ACTIONS: 'true', VITEST_RELATED_DRY_RUN: 'true' },
      ['--definitely-invalid-related-runner-option'],
    );
    // In the full CI checkout the explicit dry-run guard rejects this with 1;
    // in a sparse local checkout the full-checkout guard runs first and rejects
    // it with 2. Both paths must fail: only local dry-run is an inspection seam.
    expect([1, 2]).toContain(result.status);
    expect(result.stderr).toMatch(/VITEST_RELATED_DRY_RUN|BLOCKED: related-test verdict requires a full checkout/);
  }, 120_000);

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

  it('una cache costruita su un altro insieme di asset non viene riusata', () => {
    // Il caso reale: si AGGIUNGE un workflow. I sorgenti che lo nominano per
    // directory non cambiano firma, quindi senza l'insieme degli asset nella
    // chiave di validità la loro entry in cache verrebbe riusata senza l'arco
    // verso il file nuovo — e la cache sopravvive fra le run di CI. Qui la
    // simulo al contrario, che è equivalente e non richiede di creare file
    // tracciati: un grafo v6 con `assets` di un altro insieme e deps vuote per
    // il sorgente che porta gli archi. Se il runner si fidasse della cache, la
    // selezione sarebbe vuota.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-cache-'));
    const target = '.github/corpus-workflows/translate-pending.yml';
    // Prima corsa: scalda la cache col runner stesso, così le firme dei
    // sorgenti sono quelle vere — nessuna copia dell'algoritmo di hash qui.
    expect(selectionFor([target], dir)).toContain('tests/crawler-generation-dispatch-workflow.test.ts');
    const graphPath = path.join(dir, 'graph.json');
    const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
    // Poi la si riscrive com'era PRIMA che quell'asset esistesse: stesse firme
    // dei sorgenti (che infatti non cambiano quando nasce un workflow), archi
    // verso `.github/**` assenti, digest degli asset di un altro insieme.
    let stripped = 0;
    for (const entry of Object.values(graph.files) as any[]) {
      const kept = entry.deps.filter((dep: string) => !dep.startsWith('.github/'));
      if (kept.length !== entry.deps.length) { entry.deps = kept; stripped++; }
    }
    expect(stripped, 'la prima corsa deve aver prodotto archi verso .github/**').toBeGreaterThan(0);
    graph.assets = 'insieme-di-asset-di-un-altro-momento';
    fs.writeFileSync(graphPath, JSON.stringify(graph));
    // Se il runner si fidasse della cache — firme identiche — riuserebbe le
    // entry senza archi e la selezione tornerebbe vuota.
    expect(selectionFor([target], dir)).toContain('tests/crawler-generation-dispatch-workflow.test.ts');
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it('un rename rende lo stesso insieme di asset con o senza rename detection', () => {
    const runnerSource = fs.readFileSync(RUNNER, 'utf8');
    expect(runnerSource).toContain("'--no-renames'");
    expect(runnerSource).not.toContain("'--find-renames'");
    const fixtureDir = createRenameFixture();
    const previousRunnerDir = createRunnerVariant(
      runnerSource.replace("'--no-renames'", "'--find-renames'"),
    );
    const currentRunnerDir = createRunnerVariant(runnerSource);
    const previousBaseRef = process.env.GITHUB_BASE_REF;
    process.env.GITHUB_BASE_REF = 'ci-base';
    try {
      // If runRunnerInFixture() stops clearing GITHUB_BASE_REF, both runners
      // diff HEAD against itself and this assertion fails instead of masking
      // the regression with a green rename-only fixture.
      const previous = runRunnerInFixture(fixtureDir, previousRunnerDir, 'previous');
      const current = runRunnerInFixture(fixtureDir, currentRunnerDir, 'current');
      const previousDeps = previous.files['tests/consumer.test.ts'].deps;
      const currentDeps = current.files['tests/consumer.test.ts'].deps;
      expect(current.assets).toBe(previous.assets);
      expect(currentDeps).toEqual(previousDeps);
      expect(currentDeps).toEqual([
        '.github/workflows/new.yml',
        '.github/workflows/old.yml',
      ]);
    } finally {
      if (previousBaseRef === undefined) delete process.env.GITHUB_BASE_REF;
      else process.env.GITHUB_BASE_REF = previousBaseRef;
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fs.rmSync(previousRunnerDir, { recursive: true, force: true });
      fs.rmSync(currentRunnerDir, { recursive: true, force: true });
    }
  }, 120_000);

  it('non disallinea il flusso quando un rename espone un solo path', () => {
    const runnerSource = fs.readFileSync(RUNNER, 'utf8');
    const fixtureDir = createRenameFixture();
    const runnerDir = createRunnerVariant(runnerSource);
    const gitWrapper = createStatusStreamGitWrapper();
    try {
      const graph = runRunnerInFixture(fixtureDir, runnerDir, 'single-path-rename', {
        PATH: `${gitWrapper.dir}:${process.env.PATH || ''}`,
        RELATED_TESTS_REAL_GIT: gitWrapper.realGit,
      });
      expect(graph.files['tests/consumer.test.ts'].deps)
        .toContain('.github/workflows/brand-new-for-parser.yml');
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fs.rmSync(runnerDir, { recursive: true, force: true });
      fs.rmSync(gitWrapper.dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('un workflow non fa mai ricadere sulla suite intera', () => {
    // Il fallback conservativo resta deciso sui soli candidati SORGENTE: la
    // politica related-only di `tests.yml` non deve diventare la suite intera
    // per una PR di soli workflow. Il bound è relativo al numero reale di test
    // del repo, non una costante che invecchia.
    //
    // Nota su cosa NON è questo caso: un workflow che nessun test nomina per
    // esteso seleziona comunque decine di file, e va bene — sono gli scanner
    // di directory (`check-workflows-scope`, `apply-checkout-profiles`,
    // `check-workflow-permissions-parity`) che leggono davvero ogni workflow
    // della cartella. Sono dipendenze vere, non rumore.
    const orphan = '.github/workflows/analytics.yml';
    expect(fs.existsSync(path.join(ROOT, orphan)), `${orphan}: il caso vale solo su un workflow che esiste`).toBe(true);
    const total = execFileSync('git', ['ls-files', 'tests/*.test.ts'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n').filter(Boolean).length;
    expect(total).toBeGreaterThan(100);
    expect(selectionFor([orphan]).length).toBeLessThan(total / 4);
  }, 120_000);
});
