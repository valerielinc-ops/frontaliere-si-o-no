import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Focused contract tests for the related selector.
 *
 * The former regression file launched the real runner against the complete
 * repository dozens of times. Its own graph rebuild made the test take more
 * than three minutes and it could hide the production failure behind another
 * expensive fallback. These fixtures keep the subprocess seam, but contain
 * only the handful of files needed by each assertion.
 */
const ROOT = path.resolve(import.meta.dirname, '..');
const RUNNER = path.join(ROOT, 'scripts/ci/run-related-tests.mjs');
const roots: string[] = [];

function link(root: string, relative: string) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(path.join(ROOT, relative), target);
}

function git(root: string, ...args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture(files: Record<string, string>, linked: string[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'related-selection-contract-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'scripts/ci/lib'), { recursive: true });
  for (const relative of [
    'scripts/ci/run-related-tests.mjs',
    'scripts/ci/corpus-wide-tests.mjs',
    'scripts/ci/dataset-dependent-tests.mjs',
    'scripts/ci/scan-site-hardcoded-secrets.mjs',
    'scripts/ci/corpus-ahead-check.mjs',
    'scripts/ci/lib/select-max-workers.mjs',
    'scripts/ci/lib/typecheck-sparse.mjs',
    'scripts/ci/lib/related-graph-scope.mjs',
    'scripts/lib/crawler-generation-runtime-paths.mjs',
    ...linked,
  ]) link(root, relative);
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'related-selection@example.invalid');
  git(root, 'config', 'user.name', 'related-selection-contract');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'selection fixture');
  const base = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/main', base);
  return root;
}

function select(
  root: string,
  changed: string[],
  status = 'complete',
  extraEnv: Record<string, string> = {},
) {
  const changedPath = path.join(root, 'changed-paths.txt');
  const statusPath = path.join(root, 'changed-paths-status.txt');
  const outputPath = path.join(root, 'github-output.txt');
  fs.writeFileSync(changedPath, `${changed.join('\n')}\n`);
  fs.writeFileSync(statusPath, `${status}\n`);
  const result = spawnSync(process.execPath, [RUNNER, '--select-only'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      CHANGED_PATHS_FILE: changedPath,
      CHANGED_PATHS_STATUS_FILE: statusPath,
      VITEST_RELATED_GRAPH: path.join(root, 'graph.json'),
      VITEST_RELATED_DRY_RUN: 'true',
      VITEST_SKIP_CORPUS_WIDE: 'true',
      VITEST_SKIP_LIVE_DATA: '',
      GITHUB_ACTIONS: '',
      GITHUB_EVENT_NAME: 'pull_request',
      GITHUB_OUTPUT: outputPath,
      ...extraEnv,
    },
  });
  return {
    ...result,
    output: fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8') : '',
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('run-related-tests selection contract', () => {
  it('selects the direct impacted test without broadening to unrelated files', () => {
    const root = fixture({
      'services/changed.mjs': 'export const value = 1;\n',
      'services/importer.mjs': "import { value } from './changed.mjs'; export const doubled = value * 2;\n",
      'tests/changed.test.ts': "import { value } from '../services/changed.mjs'; export const observed = value;\n",
      'tests/unrelated.test.ts': 'export const unrelated = true;\n',
    });
    const result = select(root, ['services/changed.mjs']);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('tests/changed.test.ts');
    expect(result.stdout).not.toContain('tests/unrelated.test.ts');
    expect(result.output).toContain('required=false');
    expect(result.output).not.toContain('selection_failed=true');
  });

  it('does not turn a documented asset path into a directory-wide dependency', () => {
    const root = fixture({
      '.github/workflows/full-suite-dispatch.yml': 'name: full-suite\n',
      'scripts/ci/asset-message.mjs': "export const message = 'See .github/workflows/ for the process.';\n",
      'tests/asset-message.test.ts': "import { message } from '../scripts/ci/asset-message.mjs'; export const observed = message;\n",
      'tests/full-suite-dispatch-workflow.test.ts': "import { readFileSync } from 'node:fs'; export const workflow = readFileSync('.github/workflows/full-suite-dispatch.yml', 'utf8');\n",
    });
    const result = select(root, ['.github/workflows/full-suite-dispatch.yml']);
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).toContain('tests/full-suite-dispatch-workflow.test.ts');
    expect(result.stdout).not.toContain('tests/asset-message.test.ts');
    expect(result.output).toContain('required=false');
  });

  it('fails fast when a source change has no statically related runnable test', () => {
    const root = fixture({
      'services/orphan.mjs': 'export const orphan = true;\n',
      'tests/unrelated.test.ts': 'export const unrelated = true;\n',
    });
    const result = select(root, ['services/orphan.mjs']);
    const diagnostic = `${result.stderr}${result.stdout}`;
    expect(result.status, result.stdout).toBe(0);
    expect(diagnostic).toContain('BLOCKED: related-test selection is not provable');
    expect(diagnostic).toContain('services/orphan.mjs');
    expect(result.stdout).not.toContain('tests/unrelated.test.ts');
    expect(result.output).toContain('selection_failed=true');
    expect(result.output).toContain('required=false');
  });

  it('fails fast on an incomplete changed-path list instead of starting the suite', () => {
    const root = fixture({
      'services/changed.mjs': 'export const value = 1;\n',
      'tests/unrelated.test.ts': 'export const unrelated = true;\n',
    });
    const result = select(root, ['services/changed.mjs'], 'partial');
    expect(result.status, result.stdout).toBe(0);
    expect(result.stderr).toContain('changed-paths status is partial');
    expect(result.stdout).not.toContain('tests/unrelated.test.ts');
    expect(result.output).toContain('selection_failed=true');
    expect(result.output).toContain('required=false');
  });

  it('runs a costly generated-artifact test on the diffs that can break it', () => {
    // A fixed exclusion list kept this file, and the 145 cases in it, out of
    // every automated run from 2026-10-06 to 2026-10-08. Seventeen hours in, a
    // change to the translation workflow turned one of them red on main. The
    // real file is linked here so the edge under test is the one it declares.
    const generated = 'tests/generate-crawler-group-workflows.test.ts';
    const root = fixture({
      '.github/workflows/translate-pending-logic.yml': 'name: translate-pending\n',
      '.github/workflows/unrelated.yml': 'name: unrelated\n',
      'tests/unrelated.test.ts': 'export const unrelated = true;\n',
    }, [generated]);
    const prGate = { VITEST_SKIP_LIVE_DATA: 'true' };

    const input = select(root, ['.github/workflows/translate-pending-logic.yml'], 'complete', prGate);
    expect(input.status, input.stderr || input.stdout).toBe(0);
    expect(input.stdout).toContain(generated);
    expect(input.stdout).not.toContain('tests/unrelated.test.ts');

    const itself = select(root, [generated], 'complete', prGate);
    expect(itself.status, itself.stderr || itself.stdout).toBe(0);
    expect(itself.stdout).toContain(generated);

    const elsewhere = select(root, ['.github/workflows/unrelated.yml'], 'complete', prGate);
    expect(elsewhere.stdout).not.toContain(generated);
  });

  it('runs the two readers of the static SEO image literals when seo-pages.ts changes', () => {
    // Both tests judge `services/seo/seo-pages.ts` from disk and import none of
    // it. Pull request 12329 changed 36 image literals there: the rights-fields
    // test was not selected, and main stayed red for every later pull request
    // that inherited it.
    const rights = 'tests/static-pages-image-credit.test.ts';
    const creators = 'tests/seo/imageObjectLd.test.ts';
    const root = fixture({
      'services/seo/seo-pages.ts': 'export const pages = {};\n',
      'services/seo/other.ts': 'export const other = 1;\n',
      [rights]: 'export const rights = true;\n',
      [creators]: 'export const creators = true;\n',
      'tests/other.test.ts': "import { other } from '../services/seo/other'; export const observed = other;\n",
    });
    const literals = select(root, ['services/seo/seo-pages.ts']);
    expect(literals.status, literals.stderr || literals.stdout).toBe(0);
    expect(literals.stdout).toContain(rights);
    expect(literals.stdout).toContain(creators);

    const elsewhere = select(root, ['services/seo/other.ts']);
    expect(elsewhere.status, elsewhere.stderr || elsewhere.stdout).toBe(0);
    expect(elsewhere.stdout).toContain('tests/other.test.ts');
    expect(elsewhere.stdout).not.toContain(rights);
    expect(elsewhere.stdout).not.toContain(creators);
  });

  it('runs the live-data guard whenever a test file changes', () => {
    // The guard reads every test file and imports none of them: on the pull
    // request that adds a test reading live data, nothing else selects it.
    const guard = 'tests/live-data-test-guard.test.ts';
    const root = fixture({
      [guard]: 'export const guard = true;\n',
      'tests/check-cron-count-literals.test.ts': 'export const lint = true;\n',
      'tests/new-reader.test.ts': 'export const reader = true;\n',
      'services/changed.mjs': 'export const value = 1;\n',
      'tests/changed.test.ts': "import { value } from '../services/changed.mjs'; export const observed = value;\n",
    });
    const added = select(root, ['tests/new-reader.test.ts']);
    expect(added.status, added.stderr || added.stdout).toBe(0);
    expect(added.stdout).toContain(guard);

    const sourceOnly = select(root, ['services/changed.mjs']);
    expect(sourceOnly.status, sourceOnly.stderr || sourceOnly.stdout).toBe(0);
    expect(sourceOnly.stdout).toContain('tests/changed.test.ts');
    expect(sourceOnly.stdout).not.toContain(guard);
  });

  it('runs the image-registry readers on the data pull request that rewrites a registry', () => {
    // `data/` is outside the import graph: without these links the recurring
    // licence audit rewrote the registries behind a gate that read none of them.
    const policy = 'tests/published-image-policy.test.ts';
    const images = 'tests/generated-site-images.test.ts';
    const root = fixture({
      'data/event-image-library.json': '{}\n',
      'data/generated-image-registry.json': '{}\n',
      [policy]: 'export const policy = true;\n',
      [images]: 'export const images = true;\n',
    });
    const library = select(root, ['data/event-image-library.json']);
    expect(library.status, library.stderr || library.stdout).toBe(0);
    expect(library.stdout).toContain(policy);
    expect(library.stdout).not.toContain(images);

    const shared = select(root, ['data/generated-image-registry.json']);
    expect(shared.status, shared.stderr || shared.stdout).toBe(0);
    expect(shared.stdout).toContain(policy);
    expect(shared.stdout).toContain(images);
  });
});
