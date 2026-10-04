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

function selectionOutputFor(
  changedPaths: string[],
  reuseDir = sharedGraphDir,
  args: string[] = [],
  extraEnv: Record<string, string> = {},
) {
  const dir = reuseDir;
  const changedFile = path.join(dir, 'changed-paths.txt');
  fs.writeFileSync(changedFile, `${changedPaths.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'status.txt'), 'complete\n');
  return execFileSync(process.execPath, [RUNNER, ...args], {
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
      ...extraEnv,
    },
  });
}

function selectionFor(changedPaths: string[], reuseDir = sharedGraphDir) {
  const stdout = selectionOutputFor(changedPaths, reuseDir);
  return stdout.split('\n').map((line) => line.trim()).filter((line) => /\.test\.[cm]?[jt]sx?$/i.test(line));
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
    'scan-site-hardcoded-secrets.mjs',
    'corpus-ahead-check.mjs',
  ]) {
    fs.symlinkSync(path.join(ROOT, 'scripts/ci', file), path.join(ciDir, file));
  }
  for (const file of new Set([
    'orphan-fallback.mjs',
    'select-max-workers.mjs',
    'typecheck-sparse.mjs',
    'related-graph-scope.mjs',
    'typecheck-sparse.mjs',
  ])) {
    const target = path.join(libDir, file);
    // The base branch historically carried this dependency twice. Keep the
    // fixture safe across that merge state and across a retry in the same
    // temp directory: the dependency roster is a set and each link is replaced
    // atomically from the fixture's point of view.
    fs.rmSync(target, { force: true });
    fs.symlinkSync(path.join(ROOT, 'scripts/ci/lib', file), target);
  }
  // Il perimetro del lint del generatore crawler e' l'elenco condiviso con il
  // generatore, fuori da scripts/ci.
  const runtimePathsTarget = path.join(dir, 'scripts/lib/crawler-generation-runtime-paths.mjs');
  fs.mkdirSync(path.dirname(runtimePathsTarget), { recursive: true });
  fs.rmSync(runtimePathsTarget, { force: true });
  fs.symlinkSync(path.join(ROOT, 'scripts/lib/crawler-generation-runtime-paths.mjs'), runtimePathsTarget);
  return dir;
}

function createCompleteSelectionFixture(source: string, trackedPaths: string[]) {
  const dir = createRunnerVariant(source);
  try {
    for (const file of trackedPaths) {
      const target = path.join(dir, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(path.join(ROOT, file), target);
    }
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'related-selection-test'], { cwd: dir });
    execFileSync('git', ['add', '.'], { cwd: dir });
    execFileSync('git', ['commit', '-qm', 'complete selection fixture'], { cwd: dir });
    const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', base], { cwd: dir });
    return dir;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function runSelectionInFixture(
  fixtureDir: string,
  runnerDir: string,
  changedPaths: string[],
  suffix: string,
) {
  const changedFile = path.join(fixtureDir, `changed-${suffix}.txt`);
  const statusFile = path.join(fixtureDir, `status-${suffix}.txt`);
  const graphFile = path.join(fixtureDir, `graph-${suffix}.json`);
  const outputFile = path.join(fixtureDir, `output-${suffix}.txt`);
  fs.writeFileSync(changedFile, `${changedPaths.join('\n')}\n`);
  fs.writeFileSync(statusFile, 'complete\n');
  fs.writeFileSync(outputFile, '');
  const result = spawnSync(
    process.execPath,
    [path.join(runnerDir, 'scripts/ci/run-related-tests.mjs'), '--select-only'],
    {
      cwd: fixtureDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        CHANGED_PATHS_FILE: changedFile,
        CHANGED_PATHS_STATUS_FILE: statusFile,
        VITEST_RELATED_GRAPH: graphFile,
        VITEST_SKIP_CORPUS_WIDE: 'true',
        VITEST_RELATED_DRY_RUN: 'true',
        GITHUB_ACTIONS: '',
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_BASE_REF: '',
        GITHUB_OUTPUT: outputFile,
      },
    },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return {
    stdout: result.stdout,
    githubOutput: fs.readFileSync(outputFile, 'utf8'),
  };
}

function createStatusStreamGitWrapper({ failFirstDiff = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-status-stream-git-'));
  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const firstDiff = path.join(dir, 'first-diff');
  const wrapper = path.join(dir, 'git');
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = "diff" ]; then
  if [ "${failFirstDiff ? 'true' : 'false'}" = "true" ] && [ ! -e "${firstDiff}" ]; then
    : > "${firstDiff}"
    exit 128
  fi
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

  it('non trascina il generatore crawler per un workflow o action estraneo', () => {
    const unrelatedAssets = [
      '.github/workflows/codex-auth-recovery.yml',
      '.github/actions/claude-codex-fallback/action.yml',
    ];
    for (const [index, asset] of unrelatedAssets.entries()) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `related-unrelated-crawler-${index}-`));
      try {
        const selected = selectionFor([asset], dir);
        expect(selected).not.toContain('tests/generate-crawler-group-workflows.test.ts');
        for (const crawlerTest of [
          'tests/crawler-generation-dispatch.test.ts',
          'tests/crawler-generation-observer-workflow.test.ts',
          'tests/crawler-group-generation-finalizer.test.ts',
          'tests/workflows/crawler-workflows-corpus-sync.test.ts',
        ]) {
          expect(selected).not.toContain(crawlerTest);
        }
        expect(selected).not.toContain('tests/app-smoke.test.tsx');
        expect(selected).not.toContain('tests/regression/footer-on-seo-pages.test.tsx');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 120_000);

  it('mantiene il generatore crawler per un suo workflow generato', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-crawler-generated-'));
    try {
      expect(selectionFor(['.github/workflows/crawler-group-01.yml'], dir))
        .toContain('tests/generate-crawler-group-workflows.test.ts');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

  it('un diff del runner esegue la sua suite di regressione esplicita', () => {
    const selected = selectionFor(['scripts/ci/run-related-tests.mjs']);
    expect(selected).toEqual(expect.arrayContaining([
      'tests/run-related-tests-github-assets.test.ts',
      'tests/run-related-tests-sparse.test.ts',
      'tests/ci-vitest-check-name.test.ts',
      'tests/agents-related-tests-recipe.test.ts',
    ]));
    expect(selected).not.toContain('tests/checkout-sparse-profiles.test.ts');
    expect(selected).not.toContain('tests/faq-readability-gate.test.ts');
    expect(selected).not.toContain('tests/firestore-rules-consent-write.test.ts');
    expect(selected.length).toBeLessThan(20);
  }, 120_000);

  it('un test cambiato trascina i lint dell\'albero dei test, che nessuno importa', () => {
    // #9743: il lint dei conteggi letterali sui file del cron scandisce tutti
    // i test per directory. Senza questa regola il grafo inverso non lo
    // sceglierebbe mai sulla PR che aggiunge il test da bocciare.
    const changedTest = 'tests/pharmacy-italy-duty.test.ts';
    expect(fs.existsSync(path.join(ROOT, changedTest))).toBe(true);
    expect(selectionFor([changedTest])).toContain('tests/check-cron-count-literals.test.ts');
    // Un diff senza test non paga la scansione dell'albero.
    expect(selectionFor(['services/pharmacies/italyDuty.ts'])).not.toContain('tests/check-cron-count-literals.test.ts');
  }, 120_000);

  it('un workflow o uno script cambiato trascina i lint dell\'albero dei sorgenti', () => {
    // PR 9959: `--paginate --slurp --jq` nei due fixer, che il gh reale
    // rifiuta. Il guard scandisce `.github`, `scripts` e `bin` per directory,
    // quindi né il grafo né l'indice dei letterali lo sceglievano.
    const guard = 'tests/gh-slurp-jq-guard.test.ts';
    expect(selectionFor(['.github/workflows/pr-redflag-fixer.yml'])).toContain(guard);
    expect(selectionFor(['scripts/ci/review-gate.mjs'])).toContain(guard);
    expect(selectionFor(['services/pharmacies/italyDuty.ts'])).not.toContain(guard);
    // Stesso perimetro per il lint degli elenchi di run per `branch` senza
    // finestra `created`.
    const runListing = 'tests/run-listing-created-window.test.ts';
    expect(selectionFor(['.github/actions/fetch-pages-artifact/action.yml'])).toContain(runListing);
    expect(selectionFor(['scripts/ci/rearm-deploy-build.mjs'])).toContain(runListing);
    expect(selectionFor(['services/pharmacies/italyDuty.ts'])).not.toContain(runListing);

    // Corpus 1926: un import nuovo fuori dalla lista sparse di housekeeping
    // nasce in uno script o nell'engine condiviso, non nel workflow.
    const housekeeping = 'tests/housekeeping-sparse-paths.test.ts';
    expect(selectionFor(['scripts/lib/dedicated-crawler-common.mjs'])).toContain(housekeeping);
    expect(selectionFor(['packages/articles/engine/shared/htmlMarkup.mjs'])).toContain(housekeeping);
    expect(selectionFor(['.github/workflows/housekeeping-jobs-logic.yml'])).toContain(housekeeping);
    // `build-plugins/` non e' nella lista ne' nella chiusura: non lo seleziona.
    expect(selectionFor(['build-plugins/shared/seoPageShell.ts'])).not.toContain(housekeeping);
    expect(selectionFor(['services/pharmacies/italyDuty.ts'])).not.toContain(housekeeping);

    // PR 10973 -> 11299: `build-plugins/borderWaitData.ts` e' nel manifest del
    // transport e ha preso un import non consegnato. Il test di chiusura legge
    // il manifest da disco, quindi solo il perimetro del manifest lo seleziona.
    const closure = 'tests/mirror-transport-import-closure.test.ts';
    expect(selectionFor(['build-plugins/borderWaitData.ts'])).toContain(closure);
    expect(selectionFor(['.github/transport/nanako-generator-manifest.txt'])).toContain(closure);
    // Glob `scripts/lib/discovery/**` espanso contro l'albero, come nel guard.
    expect(selectionFor(['scripts/lib/discovery/discoveryScore.mjs'])).toContain(closure);
    expect(selectionFor(['services/pharmacies/italyDuty.ts'])).not.toContain(closure);

    // PR 11001 -> issue 11178: un diff del solo registry dei loop ha cambiato
    // i sourceRefs di L5 e reso illeggibile il ledger durevole. Registry e
    // ledger sono dati: solo il perimetro `data/loop-fleet/` (piu' il
    // validatore) seleziona il replay che li rilegge.
    const replay = 'tests/loop-fleet-registry-ledger-replay.test.ts';
    expect(selectionFor(['data/loop-fleet/loop-registry.json'])).toContain(replay);
    expect(selectionFor(['data/loop-fleet/ledger/lifecycle-events.jsonl'])).toContain(replay);
    expect(selectionFor(['scripts/lib/loop-fleet-contract.mjs'])).toContain(replay);
    expect(selectionFor(['data/crawler-group-assignments.json'])).not.toContain(replay);

    // PR 10941: l'import nuovo era in `scripts/lib/jobBoardSections.mjs`, fuori
    // dall'allow-list sparse dei job `tree-*` di bing-seo-loop.yml. Un file
    // sotto ciascuna radice del perimetro (le stesse di SELECTION_ROOTS nel
    // test, che verifica che la chiusura dei job ci stia dentro).
    const bingSparse = 'tests/seo/bing-seo-loop-sparse-closure.test.ts';
    expect(selectionFor(['scripts/lib/jobBoardSections.mjs'])).toContain(bingSparse);
    expect(selectionFor(['scripts/seo/bing-site-explorer-crawl.mjs'])).toContain(bingSparse);
    expect(selectionFor(['scripts/load-rc-env.mjs'])).toContain(bingSparse);
    expect(selectionFor(['build-plugins/shared/cantonResolvers.mjs'])).toContain(bingSparse);
    expect(selectionFor(['packages/articles/engine/shared/htmlMarkup.mjs'])).toContain(bingSparse);
    expect(selectionFor(['.github/workflows/bing-seo-loop.yml'])).toContain(bingSparse);
    expect(selectionFor(['services/pharmacies/italyDuty.ts'])).not.toContain(bingSparse);
  }, 120_000);

  it('un modulo della chiusura del finalizer crawler seleziona il test del generatore', () => {
    // PR 11262: un import nuovo in crawler-grace-policy.mjs ha allargato la
    // chiusura del finalizer, ma il test che la confronta con l'elenco
    // dichiarato dal generatore non e' girato e main e' rimasto rosso in
    // latenza. Il perimetro e' l'elenco stesso
    // (scripts/lib/crawler-generation-runtime-paths.mjs).
    const generatorTest = 'tests/generate-crawler-group-workflows.test.ts';
    expect(selectionFor(['scripts/lib/crawler-grace-policy.mjs'])).toContain(generatorTest);
    expect(selectionFor(['scripts/lib/detail-failure-reuse-policy.mjs'])).toContain(generatorTest);
    expect(selectionFor(['scripts/crawler-group-generation-finalizer.mjs'])).toContain(generatorTest);
    expect(selectionFor(['scripts/lib/crawler-generation-runtime-paths.mjs'])).toContain(generatorTest);
    // Fuori dall'elenco il test, che costa minuti, non viene trascinato.
    expect(selectionFor(['services/pharmacies/italyDuty.ts'])).not.toContain(generatorTest);
  }, 120_000);

  it('un modulo nuovo sotto scripts/lib seleziona i gate che eleggono la famiglia da disco', () => {
    // PR 11308: `scripts/lib/crawler-empty-ok-registry.mjs`, nuovo, era eletto
    // dal gate di famiglia j2w, che legge `scripts/lib/` per directory e non
    // importa il modulo. Il diff non lo selezionava e il rosso e' emerso sulla
    // 11346, che toccava per caso un import del test. Il path qui non esiste:
    // e' proprio il modulo che nessun grafo conosce ancora.
    const j2wFamily = 'tests/successfactors-parser-quality.test.ts';
    const flat = selectionFor(['scripts/lib/future-j2w-tenant-job-parser.mjs']);
    expect(flat).toContain(j2wFamily);
    expect(flat).toContain('tests/successfactors-jobs2web-widget-guard.test.ts');
    expect(flat).toContain('tests/prospective-ch-shared-parser-contract.test.ts');
    expect(flat).toContain('tests/sanitize-control-chars.test.ts');
    expect(flat).toContain('tests/score-ledger-persistence.test.ts');
    expect(flat).toContain('tests/crawler-brand-domain-pairing.test.ts');
    expect(flat).toContain('tests/listing-url-fallback-audit.test.ts');
    expect(flat).toContain('tests/bespoke-crawler-slug-boundary.test.ts');
    expect(flat).toContain('tests/undici-dispatcher-fetch-pairing.test.ts');
    expect(flat).toContain('tests/is-invoked-directly.test.ts');
    expect(flat).toContain('tests/translation-protected-tokens.test.ts');
    expect(flat).toContain('tests/slug-write-encapsulation.test.ts');
    // Gli scan che leggono anche fuori da scripts/lib.
    expect(selectionFor(['scripts/update-future-jobs.mjs'])).toContain('tests/bespoke-crawler-slug-boundary.test.ts');
    // Il ratchet a due lati dei runner senza contatori deve girare sulla PR
    // che cambia il conteggio, non su quella dopo.
    const zeroPath = 'tests/crawler-zero-path-contract.test.ts';
    expect(selectionFor(['scripts/update-future-jobs.mjs'])).toContain(zeroPath);
    expect(selectionFor(['scripts/lib/crawler-template.mjs'])).toContain(zeroPath);
    expect(selectionFor(['scripts/lib/future-j2w-tenant-job-parser.mjs'])).not.toContain(zeroPath);
    expect(selectionFor(['scripts/publish-article-fast.mjs'])).toContain('tests/sanitize-control-chars.test.ts');
    // Lo scan j2w e' ricorsivo: un parser in una sottocartella non sfugge.
    expect(selectionFor(['scripts/lib/tenants/future-job-parser.mjs'])).toContain(j2wFamily);
    expect(selectionFor(['scripts/lib/future-driver.sh'])).toContain('tests/bounded-parallel.test.ts');
    expect(selectionFor(['services/pharmacies/italyDuty.ts'])).not.toContain(j2wFamily);
  }, 120_000);

  it('un file scandito dal gate dei segreti lo seleziona, anche se il grafo non lo conosce', () => {
    // PR 10336: una chiave Google Maps di terzi dentro una fixture HTML di
    // `tests/fixtures/`. Il gate la riconosceva, ma un `.html` non è né un
    // sorgente né un asset indicizzato: il diff usciva prima della selezione
    // con zero test, e il gate non girava proprio sul diff che lo violava.
    const gate = 'tests/no-hardcoded-secrets.test.ts';
    expect(selectionFor(['tests/fixtures/kanton-aargau/detail.html'])).toEqual([gate]);
    expect(selectionFor(['services/pharmacies/italyDuty.ts'])).toContain(gate);
    // Il perimetro è quello dello scanner (`isScanned`), non una copia: ciò
    // che lo scanner esclude non paga la scansione dell'albero.
    expect(selectionFor(['public/x.svg'])).toEqual([]);
    expect(selectionFor(['package-lock.json'])).toEqual([]);
  }, 120_000);

  it('un modulo della chiusura dell\'observer crawler seleziona il test del suo workflow', () => {
    // PR 11262: un import nuovo in crawler-grace-policy.mjs e' uscito dalla
    // lista sparse dell'observer delle generazioni crawler, ma il test che la
    // confronta con la chiusura reale non e' girato e main e' rimasto rosso.
    const observerWorkflow = 'tests/crawler-generation-observer-workflow.test.ts';
    expect(selectionFor(['scripts/lib/crawler-grace-policy.mjs'])).toContain(observerWorkflow);
    expect(selectionFor(['functions/src/githubApiHeaders.js'])).toContain(observerWorkflow);
    expect(selectionFor(['build-plugins/shared/seoPageShell.ts'])).not.toContain(observerWorkflow);
    expect(selectionFor(['services/pharmacies/italyDuty.ts'])).not.toContain(observerWorkflow);
  }, 120_000);

  it('un closer nuovo sotto scripts/ o functions/ seleziona il ratchet sulle chiusure per titolo', () => {
    // Il 2026-10-04 tre closer (PR 11317, 11358, 11355) decidevano su un numero
    // e chiudevano per titolo. Il ratchet legge i sorgenti da disco: un closer
    // nuovo non lo importa, e il path qui non esiste apposta.
    const ratchet = 'tests/resolve-issue-by-title-ratchet.test.ts';
    expect(selectionFor(['scripts/ci/future-issue-closer.mjs'])).toContain(ratchet);
    expect(selectionFor(['functions/src/futureIssueCloser.js'])).toContain(ratchet);
    expect(selectionFor(['services/pharmacies/italyDuty.ts'])).not.toContain(ratchet);
  }, 120_000);

  it('uno script shell cambiato non scavalca i lint con l\'uscita anticipata', () => {
    // Un `.sh` non è un candidato del grafo: prima l'uscita «nessun sorgente
    // nel diff» precedeva i lint dell'albero dei sorgenti e li saltava.
    // `toContain` e non l'elenco esatto: ogni lint nuovo con `scripts/` nel
    // perimetro entra legittimamente in questa selezione.
    const selected = selectionFor(['scripts/dev/fast-worktree.sh']);
    expect(selected).toContain('tests/gh-slurp-jq-guard.test.ts');
    expect(selected).toContain('tests/no-hardcoded-secrets.test.ts');
  }, 120_000);

  it('il gate dei segreti non spegne il fallback alla suite intera per un sorgente senza test', () => {
    // Il perimetro del gate copre quasi ogni sorgente. Se entrasse nella
    // selezione prima della decisione sul fallback, un sorgente importato da
    // qualcuno ma non raggiunto da nessun test selezionerebbe il solo gate
    // invece della suite intera. La fixture è costruita qui: un file reale del
    // repo potrebbe ricevere un test domani e il caso smetterebbe di provare.
    const gate = 'tests/no-hardcoded-secrets.test.ts';
    const dir = createRunnerVariant(fs.readFileSync(RUNNER, 'utf8'));
    try {
      const files: Record<string, string> = {
        'services/untested-leaf.ts': 'export const leaf = 1;\n',
        'services/untested-importer.ts': "import { leaf } from './untested-leaf';\nexport const twice = leaf * 2;\n",
        'services/standalone.ts': 'export const alone = 1;\n',
        'tests/unrelated.test.ts': 'export {};\n',
        [gate]: 'export {};\n',
      };
      for (const [file, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), content);
      }
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'test@example.invalid'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'related-selection-test'], { cwd: dir });
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-qm', 'fallback fixture'], { cwd: dir });
      const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      execFileSync('git', ['update-ref', 'refs/remotes/origin/main', base], { cwd: dir });

      const imported = runSelectionInFixture(dir, dir, ['services/untested-leaf.ts'], 'imported');
      expect(imported.stdout).toContain('No static related edge found → running all tracked tests conservatively.');
      expect(imported.stdout).toContain('tests/unrelated.test.ts');
      expect(imported.stdout).toContain(gate);

      // Una foglia vera (nessun importatore) non paga la suite intera, ma il
      // gate dei segreti la giudica comunque.
      const standalone = runSelectionInFixture(dir, dir, ['services/standalone.ts'], 'standalone');
      expect(standalone.stdout).toContain('every changed file has zero importers');
      expect(standalone.stdout).not.toContain('tests/unrelated.test.ts');
      expect(standalone.stdout).toContain(gate);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('una modifica a vitest.config.ts seleziona la suite globale senza le esclusioni deliberate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-vitest-config-'));
    try {
      const selected = selectionFor(['vitest.config.ts'], dir);
      // È un test volutamente non adiacente al runner: se il config globale
      // tornasse a essere un candidato orfano, il runner produrrebbe zero.
      expect(selected).toContain('tests/a-plus-plus-job-parser.test.ts');
      expect(selected.length).toBeGreaterThan(100);
      expect(selected).not.toContain('tests/checkout-sparse-profiles.test.ts');
      expect(selected).not.toContain('tests/faq-readability-gate.test.ts');
      expect(selected).not.toContain('tests/firestore-rules-consent-write.test.ts');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('un config globale seleziona un test dataset-dependent e richiede l\'assembly', () => {
    const runnerSource = fs.readFileSync(RUNNER, 'utf8');
    const dir = createCompleteSelectionFixture(runnerSource, [
      'vitest.config.ts',
      'tests/job-locale-completeness.test.ts',
      'tests/run-related-tests-github-assets.test.ts',
    ]);
    try {
      const result = runSelectionInFixture(
        dir,
        dir,
        ['vitest.config.ts'],
        'global-config',
      );
      expect(result.stdout).toContain('tests/job-locale-completeness.test.ts');
      expect(result.stdout).toContain(
        'Assemble + migrate: required (related selection includes a dataset-dependent test)',
      );
      expect(result.stdout).not.toContain('tracked file(s) unreadable');
      expect(result.githubOutput).toBe('required=true\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('un diff del runner usa la suite esplicita senza richiedere l\'assembly', () => {
    const runnerSource = fs.readFileSync(RUNNER, 'utf8');
    const dir = createCompleteSelectionFixture(runnerSource, [
      'tests/run-related-tests-github-assets.test.ts',
      'tests/run-related-tests-sparse.test.ts',
      'tests/ci-vitest-check-name.test.ts',
      'tests/agents-related-tests-recipe.test.ts',
    ]);
    try {
      const result = runSelectionInFixture(
        dir,
        dir,
        ['scripts/ci/run-related-tests.mjs'],
        'runner-only',
      );
      expect(result.stdout).toContain('tests/run-related-tests-sparse.test.ts');
      expect(result.stdout).toContain(
        'Assemble + migrate: not required (related selection is dataset-independent)',
      );
      expect(result.stdout).not.toContain('tracked file(s) unreadable');
      expect(result.githubOutput).toBe('required=false\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('tsconfig.json non diventa una scorciatoia per la suite intera', () => {
    // Resta il solo gate dei segreti, che scandisce ogni file tracciato fuori
    // dalle sue esclusioni: nessun test del grafo, nessuna suite intera.
    expect(selectionFor(['tsconfig.json'])).toEqual(['tests/no-hardcoded-secrets.test.ts']);
  });

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

  it('rifiuta il dry-run CI anche quando la diff non produce candidati', () => {
    const result = runRunnerWithEnv(
      ['README.md'],
      { GITHUB_ACTIONS: 'true', VITEST_RELATED_DRY_RUN: 'true' },
      ['--select-only'],
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('VITEST_RELATED_DRY_RUN non è consentito in GitHub Actions');
    expect(result.stdout).not.toContain('No existing source/test files in the diff');
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

  it('prova il ref successivo se il diff del primo ref fallisce', () => {
    const runnerSource = fs.readFileSync(RUNNER, 'utf8');
    const fixtureDir = createRenameFixture();
    const runnerDir = createRunnerVariant(runnerSource);
    const gitWrapper = createStatusStreamGitWrapper({ failFirstDiff: true });
    try {
      const graph = runRunnerInFixture(fixtureDir, runnerDir, 'fallback-ref', {
        PATH: `${gitWrapper.dir}:${process.env.PATH || ''}`,
        RELATED_TESTS_REAL_GIT: gitWrapper.realGit,
        GITHUB_BASE_REF: 'ci-base',
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
