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
    'scripts/lib/article-chunk-publish-freshness.mjs',
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
  const dataFixtures = Object.keys(files).filter((relative) => relative.startsWith('data/'));
  if (dataFixtures.length > 0) git(root, 'add', '-f', '--', ...dataFixtures);
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
  it('selects pruner subprocess safety tests for a pruner-only change, not unrelated scripts', () => {
    const prunerTests = [
      'tests/pruner-isolation.test.ts',
      'tests/worktree-prune-signals.test.ts',
      'tests/prune-merged-worktrees-e2e.test.ts',
      'tests/prune-merged-worktrees-proofs-e2e.test.ts',
      'tests/prune-merged-worktrees-corpus-e2e.test.ts',
      'tests/prune-merged-worktrees-expiry-e2e.test.ts',
    ];
    const root = fixture({
      'scripts/prune-merged-worktrees.mjs': 'throw new Error("fixture pruner must never execute");\n',
      'scripts/unrelated.mjs': 'export const unrelated = true;\n',
      'tests/unrelated.test.ts': "import '../scripts/unrelated.mjs';\n",
      ...Object.fromEntries(prunerTests.map((file) => [file, 'export const contract = true;\n'])),
    });
    const pruner = select(root, ['scripts/prune-merged-worktrees.mjs']);
    expect(pruner.status, pruner.stderr || pruner.stdout).toBe(0);
    for (const file of prunerTests) expect(pruner.stdout).toContain(file);
    expect(pruner.stdout).not.toContain('tests/unrelated.test.ts');

    const unrelated = select(root, ['scripts/unrelated.mjs']);
    expect(unrelated.status, unrelated.stderr || unrelated.stdout).toBe(0);
    for (const file of prunerTests) expect(unrelated.stdout).not.toContain(file);
  });

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

  it('selects the source-backed AIL, JobBoard and Google News tests', () => {
    const contracts = [
      {
        source: 'scripts/update-ail-jobs.mjs',
        test: 'tests/ail-crawler.test.ts',
      },
      {
        source: 'services/jobBoardSearchPipeline.ts',
        test: 'tests/jobboard-interruptible-search-pipeline.test.ts',
      },
      {
        source: 'scripts/lib/discovery/googleNewsUrlResolver.mjs',
        test: 'tests/google-news-url-resolver.test.ts',
      },
    ];

    for (const { source, test } of contracts) {
      const root = fixture({}, [source, test]);
      const result = select(root, [source]);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain(test);
    }
  });

  it('selects the AIL test from the CI full-checkout profile', () => {
    const root = fixture({
      // These are the same checkout sentinels required by the real selector.
      'data/blog-articles-data.ts': 'export const articles = [];\n',
      'data/swiss-articles-data.ts': 'export const articles = [];\n',
      'public/.nojekyll': '',
    }, [
      'scripts/update-ail-jobs.mjs',
      'tests/ail-crawler.test.ts',
    ]);
    const result = select(
      root,
      ['scripts/update-ail-jobs.mjs'],
      'complete',
      { GITHUB_ACTIONS: 'true', VITEST_RELATED_DRY_RUN: '' },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain('tests/ail-crawler.test.ts');
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
    // These exact reads are indexed as assets; there is no image-specific
    // test-to-data mapping in sourceTreeLintTests.
    const policy = 'tests/published-image-policy.test.ts';
    const images = 'tests/generated-site-images.test.ts';
    const root = fixture({
      'data/event-image-library.json': '{}\n',
      'data/generated-image-registry.json': '{}\n',
      [policy]: "import { readFileSync } from 'node:fs'; export const policy = readFileSync('data/event-image-library.json', 'utf8');\n",
      [images]: "import { readFileSync } from 'node:fs'; export const images = readFileSync('data/generated-image-registry.json', 'utf8');\n",
    });
    const library = select(root, ['data/event-image-library.json']);
    expect(library.status, library.stderr || library.stdout).toBe(0);
    expect(library.stdout).toContain(policy);
    expect(library.stdout).not.toContain(images);

    const shared = select(root, ['data/generated-image-registry.json']);
    expect(shared.status, shared.stderr || shared.stdout).toBe(0);
    expect(shared.stdout).toContain(images);
    expect(shared.stdout).not.toContain(policy);
  });

  it('indexes full quoted data paths precisely and ignores comment-only mentions', () => {
    const reader = 'tests/translation-data-reader.test.ts';
    const segmentedReader = 'tests/translation-data-segmented-reader.test.ts';
    const relativeReader = 'tests/translation-data-relative-reader.test.ts';
    const relativeSegmentedReader = 'tests/translation-data-relative-segmented-reader.test.ts';
    const commentOnly = 'tests/translation-data-comment.test.ts';
    const unrelated = 'tests/unrelated-data-reader.test.ts';
    const root = fixture({
      'data/translation-stats-history.json': '{}\n',
      'data/weather-snapshot.json': '{}\n',
      [reader]: "import { readFileSync } from 'node:fs'; export const history = readFileSync('data/translation-stats-history.json', 'utf8');\n",
      [segmentedReader]: "import { readFileSync } from 'node:fs'; import path from 'node:path'; const ROOT = '/repo'; export const weather = readFileSync(path.join(ROOT, 'data', 'weather-snapshot.json'), 'utf8');\n",
      [relativeReader]: "import { readFileSync } from 'node:fs'; export const weather = readFileSync(new URL('../data/weather-snapshot.json', import.meta.url), 'utf8');\n",
      [relativeSegmentedReader]: "import { readFileSync } from 'node:fs'; import path from 'node:path'; export const weather = readFileSync(path.join(__dirname, '..', 'data', 'weather-snapshot.json'), 'utf8');\n",
      [commentOnly]: "// readFileSync('data/translation-stats-history.json')\nexport const comment = true;\n",
      [unrelated]: "import { readFileSync } from 'node:fs'; export const weather = readFileSync('data/weather-snapshot.json', 'utf8');\n",
    });

    const history = select(root, ['data/translation-stats-history.json']);
    expect(history.status, history.stderr || history.stdout).toBe(0);
    expect(history.stdout).toContain(reader);
    expect(history.stdout).not.toContain(commentOnly);
    expect(history.stdout).not.toContain(unrelated);

    const weather = select(root, ['data/weather-snapshot.json']);
    expect(weather.status, weather.stderr || weather.stdout).toBe(0);
    expect(weather.stdout).toContain(unrelated);
    expect(weather.stdout).toContain(segmentedReader);
    expect(weather.stdout).toContain(relativeReader);
    expect(weather.stdout).toContain(relativeSegmentedReader);
    expect(weather.stdout).not.toContain(reader);
  });

  it('runs the publisher-code closure test when a file it only reaches by name changes', () => {
    // The freshness test walks the replay's scripts from disk and imports two
    // of them; the edge publisher and the upload helper it reaches by name.
    const freshness = 'tests/scripts/article-chunk-publish-freshness.test.ts';
    const root = fixture({
      'scripts/publish-edge-files.mjs': 'export const edge = true;\n',
      'scripts/lib/upload-cdn-file.sh': '#!/usr/bin/env bash\n',
      'scripts/unrelated.mjs': 'export const unrelated = true;\n',
      'tests/unrelated.test.ts': "import '../scripts/unrelated.mjs';\n",
      [freshness]: 'export const freshness = true;\n',
    });
    for (const changed of ['scripts/publish-edge-files.mjs', 'scripts/lib/upload-cdn-file.sh']) {
      const result = select(root, [changed]);
      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout, changed).toContain(freshness);
    }

    const unrelated = select(root, ['scripts/unrelated.mjs']);
    expect(unrelated.status, unrelated.stderr || unrelated.stdout).toBe(0);
    expect(unrelated.stdout).not.toContain(freshness);
  });

  it('reuses an ancestor graph across data snapshots and reindexes intervening source edits', () => {
    const reader = 'tests/live-snapshot-reader.test.ts';
    const root = fixture({
      'data/live-snapshot.json': '{"count":1}\n',
      'services/first.mjs': 'export const value = 1;\n',
      'services/second.mjs': 'export const value = 2;\n',
      'services/reader.mjs': "import { readFileSync } from 'node:fs'; import { value } from './first.mjs'; export const snapshot = readFileSync('data/live-snapshot.json', 'utf8') + value;\n",
      [reader]: "import { snapshot } from '../services/reader.mjs'; export const observed = snapshot;\n",
    });

    const initial = select(root, ['services/reader.mjs']);
    expect(initial.status, initial.stderr || initial.stdout).toBe(0);
    const initialGraph = JSON.parse(fs.readFileSync(path.join(root, 'graph.json'), 'utf8'));

    fs.writeFileSync(path.join(root, 'data/live-snapshot.json'), '{"count":2}\n');
    git(root, 'add', '--', 'data/live-snapshot.json');
    git(root, 'commit', '-qm', 'refresh data snapshot');
    const snapshot = select(root, ['data/live-snapshot.json']);
    expect(snapshot.status, snapshot.stderr || snapshot.stdout).toBe(0);
    expect(snapshot.stdout).toMatch(/Related graph: reused \d+ entries, rebuilt 0\./);
    expect(snapshot.stdout).toContain(reader);
    const snapshotGraph = JSON.parse(fs.readFileSync(path.join(root, 'graph.json'), 'utf8'));
    expect(snapshotGraph.revision).not.toBe(initialGraph.revision);

    fs.writeFileSync(
      path.join(root, 'services/reader.mjs'),
      "import { readFileSync } from 'node:fs'; import { value } from './second.mjs'; export const snapshot = readFileSync('data/live-snapshot.json', 'utf8') + value;\n",
    );
    git(root, 'add', '--', 'services/reader.mjs');
    git(root, 'commit', '-qm', 'change a source import');
    const source = select(root, ['services/reader.mjs']);
    expect(source.status, source.stderr || source.stdout).toBe(0);
    expect(source.stdout).toContain(reader);
    expect(source.stdout).toMatch(/Related graph: reused [1-9]\d* entries, rebuilt [1-9]\d*\./);
    const sourceGraph = JSON.parse(fs.readFileSync(path.join(root, 'graph.json'), 'utf8'));
    expect(sourceGraph.files['services/reader.mjs'].deps).toContain('services/second.mjs');
    expect(sourceGraph.files['services/reader.mjs'].deps).not.toContain('services/first.mjs');
  });

  it('rebuilds when source paths are added or deleted since the cached revision', () => {
    const root = fixture({
      'services/existing.mjs': 'export const value = 1;\n',
      'tests/existing.test.ts': "import { value } from '../services/existing.mjs'; export const observed = value;\n",
    });
    const initial = select(root, ['services/existing.mjs']);
    expect(initial.status, initial.stderr || initial.stdout).toBe(0);

    fs.writeFileSync(path.join(root, 'services/added.mjs'), 'export const added = true;\n');
    git(root, 'add', '--', 'services/added.mjs');
    git(root, 'commit', '-qm', 'add a source module');
    const added = select(root, ['services/added.mjs']);
    expect(added.status, added.stderr || added.stdout).toBe(0);
    expect(added.stdout).toMatch(/Related graph: reused 0 entries, rebuilt [1-9]\d*\./);

    fs.rmSync(path.join(root, 'services/added.mjs'));
    git(root, 'add', '-u', '--', 'services/added.mjs');
    git(root, 'commit', '-qm', 'remove a source module');
    const deleted = select(root, ['services/added.mjs']);
    expect(deleted.status, deleted.stderr || deleted.stdout).toBe(0);
    expect(deleted.stdout).toMatch(/Related graph: reused 0 entries, rebuilt [1-9]\d*\./);
  });

  it('rebuilds rather than reuses a graph from a divergent cached revision', () => {
    const root = fixture({
      'data/live-snapshot.json': '{"count":1}\n',
      'tests/live-snapshot-reader.test.ts': "import { readFileSync } from 'node:fs'; export const snapshot = readFileSync('data/live-snapshot.json', 'utf8');\n",
    });
    const base = git(root, 'rev-parse', 'HEAD');

    fs.writeFileSync(path.join(root, 'data/live-snapshot.json'), '{"count":2}\n');
    git(root, 'add', '--', 'data/live-snapshot.json');
    git(root, 'commit', '-qm', 'first snapshot update');
    const cached = select(root, ['data/live-snapshot.json']);
    expect(cached.status, cached.stderr || cached.stdout).toBe(0);

    git(root, 'checkout', '-q', '-b', 'divergent', base);
    fs.writeFileSync(path.join(root, 'data/live-snapshot.json'), '{"count":3}\n');
    git(root, 'add', '--', 'data/live-snapshot.json');
    git(root, 'commit', '-qm', 'divergent snapshot update');
    const divergent = select(root, ['data/live-snapshot.json']);
    expect(divergent.status, divergent.stderr || divergent.stdout).toBe(0);
    expect(divergent.stdout).toMatch(/Related graph: reused 0 entries, rebuilt [1-9]\d*\./);
  });
});
