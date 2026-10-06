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

function fixture(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'related-selection-contract-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'scripts/ci/lib'), { recursive: true });
  for (const relative of [
    'scripts/ci/run-related-tests.mjs',
    'scripts/ci/corpus-wide-tests.mjs',
    'scripts/ci/dataset-dependent-tests.mjs',
    'scripts/ci/scan-site-hardcoded-secrets.mjs',
    'scripts/ci/corpus-ahead-check.mjs',
    'scripts/ci/ci-generated-data-tests.mjs',
    'scripts/ci/lib/select-max-workers.mjs',
    'scripts/ci/lib/typecheck-sparse.mjs',
    'scripts/ci/lib/related-graph-scope.mjs',
    'scripts/lib/crawler-generation-runtime-paths.mjs',
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
      VITEST_SKIP_GENERATED_DATA_TESTS: '',
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

  it('excludes generated-data tests from the blocking CI selection', () => {
    const generated = 'tests/generate-crawler-group-workflows.test.ts';
    const root = fixture({
      [generated]: 'export const generated = true;\n',
      'tests/unrelated.test.ts': 'export const unrelated = true;\n',
    });
    const result = select(root, [generated], 'complete', { VITEST_SKIP_LIVE_DATA: 'true' });
    expect(result.status, result.stdout).toBe(0);
    expect(result.stdout).not.toContain(generated);
    expect(result.stdout).not.toContain('tests/unrelated.test.ts');
    expect(result.output).toContain('required=false');
  });
});
