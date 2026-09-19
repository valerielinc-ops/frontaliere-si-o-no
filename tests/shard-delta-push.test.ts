import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANIFEST_VERSION } from '../build-plugins/shared/incrementalManifest.mjs';

const ROOT = process.cwd();
const PUSH_LOCALE = join(ROOT, 'scripts/lib/push-locale-shard.sh');
const PUSH_SECTION = join(ROOT, 'scripts/lib/push-section-shard.sh');
const KINDS = [
  'active-job',
  'expired-soft-landing',
  'legacy-slug-bridge',
  'previous-slugs-full-content',
  'cross-locale-reconciliation',
  'related-search-cluster',
  'related-search-sitemap',
  'cf-hot-404-bridge',
];

type Scenario = {
  root: string;
  remote: string;
  dist: string;
  manifestDir: string;
};

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function createScenario(name: string): Scenario {
  const root = mkdtempSync(join(tmpdir(), `shard-delta-${name}-`));
  const remote = join(root, 'remote.git');
  mkdirSync(remote, { recursive: true });
  git(['init', '--bare', '-q', '-b', 'main', remote]);
  return {
    root,
    remote,
    dist: join(root, 'dist'),
    manifestDir: join(root, 'manifest'),
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function pagePath(page: string, prefix = 'en'): string {
  return page ? `${prefix}/${page}/` : `${prefix}/`;
}

function writeManifest(
  scenario: Scenario,
  pages: string[],
  version: string,
  prefix = 'en',
  includeRoot = false,
  omitCountKinds: string[] = [],
): void {
  mkdirSync(scenario.manifestDir, { recursive: true });
  const manifestPages = includeRoot ? ['', ...pages] : pages;
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  counts['active-job'] = manifestPages.length;
  for (const kind of omitCountKinds) delete counts[kind];
  const lines = [
    JSON.stringify({ type: 'header', manifestVersion: MANIFEST_VERSION, format: 'jsonl', locale: 'en' }),
    JSON.stringify({
      type: 'kind',
      kind: 'active-job',
      templateVersion: 'active-job@1',
      sourceVersion: 'input@1',
      state: 'live',
    }),
    ...manifestPages.map((page) => JSON.stringify({
      path: pagePath(page, prefix),
      hash: hash(`${version}:${page}`),
    })),
    JSON.stringify({ type: 'footer', counts: { total: manifestPages.length, byKind: counts } }),
  ];
  writeFileSync(join(scenario.manifestDir, 'en.jsonl'), `${lines.join('\n')}\n`);
}

function writePayload(scenario: Scenario, files: Record<string, string>): void {
  rmSync(scenario.dist, { recursive: true, force: true });
  mkdirSync(join(scenario.dist, 'en'), { recursive: true });
  writeFileSync(join(scenario.dist, 'en', 'index.html'), '<html>locale-root</html>');
  for (const [page, content] of Object.entries(files)) {
    const pageDir = join(scenario.dist, 'en', page);
    mkdirSync(pageDir, { recursive: true });
    const target = join(pageDir, 'index.html');
    writeFileSync(target, content);
  }
}

function writePayloadFile(scenario: Scenario, relativePath: string, content: string): void {
  const target = join(scenario.dist, 'en', relativePath);
  mkdirSync(join(target, '..'), { recursive: true });
  writeFileSync(target, content);
}

function writeManyPayload(scenario: Scenario, count: number, changedIndex = -1): void {
  rmSync(scenario.dist, { recursive: true, force: true });
  const assets = join(scenario.dist, 'en', 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(scenario.dist, 'en', 'index.html'), '<html>locale-root</html>');
  for (let index = 0; index < count; index += 1) {
    const version = index === changedIndex ? 'v2' : 'v1';
    writeFileSync(join(assets, `asset-${index}.txt`), `asset-${index}-${version}\n`);
  }
}

function writeSectionPayload(scenario: Scenario, files: Record<string, string>): void {
  const sectionRoot = join(scenario.dist, 'en', 'find-jobs-ticino');
  rmSync(scenario.dist, { recursive: true, force: true });
  mkdirSync(sectionRoot, { recursive: true });
  writeFileSync(join(sectionRoot, 'index.html'), '<html>section-root</html>');
  for (const [page, content] of Object.entries(files)) {
    const pageDir = join(sectionRoot, page);
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, 'index.html'), content);
  }
}

function objectStats(repo: string): { objectBytes: number; raw: string } {
  const raw = git(['-C', repo, 'count-objects', '-v']);
  const fields = Object.fromEntries(
    raw.split('\n').map((line) => {
      const [key, ...value] = line.split(':');
      return [key, value.join(':').trim()];
    }),
  );
  const looseKiB = Number(fields.size || 0);
  const packKiB = Number(fields['size-pack'] || 0);
  return { objectBytes: (looseKiB + packKiB) * 1024, raw };
}

function treeSha(remote: string): string {
  return git(['-C', remote, 'rev-parse', 'main^{tree}']);
}

function treeFiles(remote: string): string[] {
  const output = git(['-c', 'core.quotePath=false', '-C', remote, 'ls-tree', '-r', '--name-only', 'main']);
  return output ? output.split('\n') : [];
}

function blobSha(remote: string, path: string): string {
  const line = git(['-C', remote, 'ls-tree', '-r', 'main', '--', path]);
  return line.split(/\s+/)[2] || '';
}

function runBloblessMeasurement(remote: string): number {
  const clone = mkdtempSync(join(tmpdir(), 'shard-delta-measure-'));
  try {
    const result = spawnSync(
      'git',
      ['clone', '-q', '--depth', '1', '--filter=blob:none', '--no-checkout', remote, clone],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    if (result.status !== 0) return 0;
    return objectStats(clone).objectBytes;
  } finally {
    rmSync(clone, { recursive: true, force: true });
  }
}

function runPush(
  scenario: Scenario,
  mode: 'delta' | 'full' | undefined,
  extraEnv: Record<string, string> = {},
  target: {
    script: string;
    args: (scenario: Scenario) => string[];
    deployKey: string;
    label: string;
  } = {
    script: PUSH_LOCALE,
    args: (current) => ['en', current.dist],
    deployKey: 'SHARD_EN_DEPLOY_KEY',
    label: 'locale',
  },
): { status: number; output: string; elapsedMs: number } {
  const runnerTemp = mkdtempSync(join(scenario.root, 'runner-'));
  const before = objectStats(scenario.remote);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [target.deployKey]: 'test-deploy-key',
    SHARD_REPO_OVERRIDE: scenario.remote,
    SHARD_INCREMENTAL_MANIFEST_DIR: scenario.manifestDir,
    RUNNER_TEMP: runnerTemp,
    SHARD_PUSH_RETRY_DELAY: '0',
    SHARD_HISTORY_CAP: '50',
    SHARD_SHRINK_GUARD_PCT: '50',
    GITHUB_PAT: '',
    SHARD_PUSH_PAT: '',
    GIT_TERMINAL_PROMPT: '0',
    ...extraEnv,
  };
  if (mode === undefined) delete env.SHARD_PUSH_MODE;
  else env.SHARD_PUSH_MODE = mode;

  const started = performance.now();
  const result = spawnSync('bash', [target.script, ...target.args(scenario)], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const elapsedMs = performance.now() - started;
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  const after = objectStats(scenario.remote);
  const clonedBytes = runBloblessMeasurement(scenario.remote);
  console.log(
    `[shard-delta-measure] target=${target.label} mode=${mode || 'default-full'} status=${result.status ?? 'signal'} `
    + `wall_ms=${elapsedMs.toFixed(1)} clone_object_bytes=${clonedBytes} `
    + `remote_object_bytes_before=${before.objectBytes} after=${after.objectBytes} `
    + `push_object_delta_bytes=${after.objectBytes - before.objectBytes}`,
  );
  rmSync(runnerTemp, { recursive: true, force: true });
  return { status: result.status ?? 1, output, elapsedMs };
}

function assertContent(remote: string, path: string, expected: string): void {
  const verify = mkdtempSync(join(tmpdir(), 'shard-delta-verify-'));
  try {
    git(['clone', '-q', remote, verify]);
    expect(readFileSync(join(verify, path), 'utf8')).toBe(expected);
  } finally {
    rmSync(verify, { recursive: true, force: true });
  }
}

describe('delta push degli shard', () => {
  it('gestisce add/change/reuse/delete e il primo push con fallback full', () => {
    const scenario = createScenario('lifecycle');
    try {
      writePayload(scenario, {
        'pages/a': '<html>A</html>',
        'pages/b': '<html>B v1</html>',
        'pages/c': '<html>C</html>',
      });
      writeManifest(scenario, ['pages/a', 'pages/b', 'pages/c'], 'v1');
      const first = runPush(scenario, 'delta');
      expect(first.status).toBe(0);
      expect(first.output).toContain('manifest delta: mode=snapshot');
      expect(first.output).toMatch(/delta fallback: fallback reason=(first push \/ remote empty|remote empty)/);
      expect(treeFiles(scenario.remote)).toContain('.deploy-manifest/v1/en.jsonl');
      const oldA = blobSha(scenario.remote, 'en/pages/a/index.html');
      const oldB = blobSha(scenario.remote, 'en/pages/b/index.html');

      writePayload(scenario, {
        'pages/a': '<html>A</html>',
        'pages/b': '<html>B v2</html>',
        'pages/d': '<html>D</html>',
      });
      writeManifest(scenario, ['pages/a', 'pages/b', 'pages/d'], 'v2');
      const second = runPush(scenario, 'delta');
      expect(second.status).toBe(0);
      expect(second.output).toContain('manifest delta: mode=delta');
      expect(second.output).toContain('delta indexed tree');
      expect(treeFiles(scenario.remote)).not.toContain('en/pages/c/index.html');
      expect(treeFiles(scenario.remote)).toContain('en/pages/d/index.html');
      expect(blobSha(scenario.remote, 'en/pages/a/index.html')).toBe(oldA);
      expect(blobSha(scenario.remote, 'en/pages/b/index.html')).not.toBe(oldB);
      assertContent(scenario.remote, 'en/pages/a/index.html', '<html>A</html>');
      assertContent(scenario.remote, 'en/pages/b/index.html', '<html>B v2</html>');
      assertContent(scenario.remote, 'en/pages/d/index.html', '<html>D</html>');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('fa fallback se manca il count di un kind obbligatorio', () => {
    const scenario = createScenario('required-kind-count-missing');
    try {
      writePayload(scenario, { 'pages/a': '<html>A</html>' });
      writeManifest(scenario, ['pages/a'], 'v1', 'en', false, ['active-job']);
      const result = runPush(scenario, 'delta');
      expect(result.status).toBe(0);
      expect(result.output).toContain('delta fallback: fallback reason=current manifest invalid or payload missing');
      assertContent(scenario.remote, 'en/pages/a/index.html', '<html>A</html>');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('rimuove nel delta un file payload non coperto dal manifest', () => {
    const scenario = createScenario('unmanifested-delete');
    try {
      writePayload(scenario, { 'pages/a': '<html>A</html>' });
      writePayloadFile(scenario, 'assets/obsolete.txt', 'obsolete\n');
      writeManifest(scenario, ['pages/a'], 'v1');
      expect(runPush(scenario, 'delta').status).toBe(0);
      expect(treeFiles(scenario.remote)).toContain('en/assets/obsolete.txt');

      writePayload(scenario, { 'pages/a': '<html>A</html>' });
      writeManifest(scenario, ['pages/a'], 'v1');
      const result = runPush(scenario, 'delta');
      expect(result.status).toBe(0);
      expect(result.output).toContain('delta indexed tree');
      expect(result.output).toMatch(/removed=1/);
      expect(treeFiles(scenario.remote)).not.toContain('en/assets/obsolete.txt');
      assertContent(scenario.remote, 'en/pages/a/index.html', '<html>A</html>');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('rimuove nel delta un child stale di una entry manifest ancora live', () => {
    const scenario = createScenario('live-manifest-child-delete');
    try {
      writePayload(scenario, { 'pages/a': '<html>A</html>' });
      writePayloadFile(scenario, 'pages/a/obsolete.txt', 'obsolete child\n');
      writeManifest(scenario, ['pages/a'], 'v1');
      expect(runPush(scenario, 'delta').status).toBe(0);
      expect(treeFiles(scenario.remote)).toContain('en/pages/a/obsolete.txt');

      writePayload(scenario, { 'pages/a': '<html>A</html>' });
      writeManifest(scenario, ['pages/a'], 'v1');
      const result = runPush(scenario, 'delta');
      expect(result.status).toBe(0);
      expect(result.output).toContain('delta indexed tree');
      expect(result.output).toMatch(/removed=1/);
      expect(treeFiles(scenario.remote)).not.toContain('en/pages/a/obsolete.txt');
      assertContent(scenario.remote, 'en/pages/a/index.html', '<html>A</html>');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('fa fallback se il sidecar marca unchanged un file assente dall’indice HEAD', () => {
    const scenario = createScenario('unchanged-missing-from-head');
    try {
      writePayload(scenario, { 'pages/a': '<html>A</html>' });
      writeManifest(scenario, ['pages/a'], 'v1');
      expect(runPush(scenario, 'delta').status).toBe(0);

      // Simulate a torn/filtered shard commit: keep the published sidecar,
      // but remove the payload blob from HEAD. The next manifest says the
      // entry is unchanged, so delta must refuse to reuse a missing file and
      // rebuild via the full overlay.
      const corrupt = join(scenario.root, 'corrupt-head');
      git(['clone', '-q', scenario.remote, corrupt]);
      git(['config', 'user.email', 'test@example.com'], corrupt);
      git(['config', 'user.name', 'Test User'], corrupt);
      rmSync(join(corrupt, 'en/pages/a/index.html'));
      git(['add', '-A'], corrupt);
      git(['commit', '-qm', 'simulate missing unchanged payload'], corrupt);
      git(['push', '-q', 'origin', 'main'], corrupt);

      writePayload(scenario, { 'pages/a': '<html>A</html>' });
      writeManifest(scenario, ['pages/a'], 'v1');
      const result = runPush(scenario, 'delta');
      expect(result.status).toBe(0);
      expect(result.output).toMatch(/delta fallback: fallback reason=unchanged payload missing from indexed HEAD/);
      assertContent(scenario.remote, 'en/pages/a/index.html', '<html>A</html>');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('tratta come no-op un tombstone assente dall’indice anche con payload correlato', () => {
    const scenario = createScenario('tombstone-absent-from-head');
    try {
      writePayload(scenario, { 'pages/gone': '<html>old</html>' });
      writeManifest(scenario, ['pages/gone'], 'v1');
      expect(runPush(scenario, 'delta').status).toBe(0);

      // Leave the sidecar tombstone source in HEAD, but remove the old target
      // from the indexed tree before the next build. The current payload is
      // deliberately unmanifested and route-related: the tombstone pass must
      // still be a no-op because there is nothing in HEAD to delete.
      const corrupt = join(scenario.root, 'corrupt-head');
      git(['clone', '-q', scenario.remote, corrupt]);
      git(['config', 'user.email', 'test@example.com'], corrupt);
      git(['config', 'user.name', 'Test User'], corrupt);
      rmSync(join(corrupt, 'en/pages/gone/index.html'));
      git(['add', '-A'], corrupt);
      git(['commit', '-qm', 'remove tombstone target from head'], corrupt);
      git(['push', '-q', 'origin', 'main'], corrupt);

      writePayload(scenario, { 'pages/gone': '<html>replacement</html>' });
      writeManifest(scenario, [], 'v2');
      const result = runPush(scenario, 'delta');
      expect(result.status).toBe(0);
      expect(result.output).toContain('manifest tombstone no-op for en/pages/gone');
      expect(result.output).toContain('reason=absent from indexed HEAD');
      expect(result.output).not.toContain('delta fallback: manifest tombstone cross-check failed');
      assertContent(scenario.remote, 'en/pages/gone/index.html', '<html>replacement</html>');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('sovrascrive e conta un payload non manifestato senza fallback dello shard', () => {
    const scenario = createScenario('unmanifested-overlay');
    try {
      writePayload(scenario, { 'pages/gone': '<html>old</html>' });
      writeManifest(scenario, ['pages/gone'], 'v1', 'en', true);
      expect(runPush(scenario, 'delta').status).toBe(0);

      // The old manifest entry disappears, but the direct emitter still
      // produces the same route in the current payload. It must be overlaid
      // from source, not treated as an ambiguous tombstone.
      writePayload(scenario, { 'pages/gone': '<html>replacement</html>' });
      writeManifest(scenario, [], 'v2', 'en', true);
      const result = runPush(scenario, 'delta');
      expect(result.status).toBe(0);
      expect(result.output).toContain('delta indexed tree');
      expect(result.output).toContain('unmanifested-overlay=1');
      expect(result.output).not.toContain('delta fallback:');
      assertContent(scenario.remote, 'en/pages/gone/index.html', '<html>replacement</html>');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('esclude dal manifest del locale i subtree già assegnati agli shard-sezione', () => {
    const scenario = createScenario('locale-section-strip');
    try {
      const sectionPage = 'find-jobs-aargau/job-slug';
      writePayload(scenario, {
        'pages/kept': '<html>kept</html>',
        [sectionPage]: '<html>section</html>',
      });
      writeManifest(scenario, ['pages/kept', sectionPage], 'v1');
      expect(runPush(scenario, 'delta').status).toBe(0);
      expect(treeFiles(scenario.remote)).toContain(`en/${sectionPage}/index.html`);

      // Mirrors deploy.yml: the section push has succeeded, then
      // strip-section-subtree.sh removes the section from the locale dist, but
      // the build manifest remains the complete pre-strip manifest.
      writePayload(scenario, { 'pages/kept': '<html>kept</html>' });
      writeManifest(scenario, ['pages/kept', sectionPage], 'v2');
      const result = runPush(scenario, 'delta');
      expect(result.status).toBe(0);
      expect(result.output).toContain('delta indexed tree');
      expect(result.output).not.toContain('payload mancante');
      expect(treeFiles(scenario.remote)).not.toContain(`en/${sectionPage}/index.html`);
      assertContent(scenario.remote, 'en/pages/kept/index.html', '<html>kept</html>');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('fa fallback full su manifest corrente invalido e conserva l’output finale', () => {
    const scenario = createScenario('invalid-manifest');
    try {
      writePayload(scenario, { 'pages/a': '<html>A</html>', 'pages/b': '<html>B</html>' });
      writeManifest(scenario, ['pages/a', 'pages/b'], 'v1');
      expect(runPush(scenario, 'delta').status).toBe(0);
      writeFileSync(join(scenario.manifestDir, 'en.jsonl'), '{invalid jsonl\n');
      const result = runPush(scenario, 'delta');
      expect(result.status).toBe(0);
      expect(result.output).toMatch(/delta fallback: .*manifest.*invalid|current manifest/);
      expect(treeFiles(scenario.remote)).not.toContain('.deploy-manifest/v1/en.jsonl');
      assertContent(scenario.remote, 'en/pages/a/index.html', '<html>A</html>');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('fa fallback full su clone failure senza mascherare il fallimento del push', () => {
    const scenario = createScenario('clone-failure');
    const unreachable = join(scenario.root, 'missing-remote.git');
    try {
      writePayload(scenario, { 'pages/a': '<html>A</html>' });
      writeManifest(scenario, ['pages/a'], 'v1');
      const result = runPush(scenario, 'delta', { SHARD_REPO_OVERRIDE: unreachable });
      expect(result.status).toBe(1);
      expect(result.output).toContain('delta clone failure');
      expect(result.output).toMatch(/delta fallback: .*clone failure.*full overlay/);
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('fa fallback full quando il history cap è raggiunto', () => {
    const scenario = createScenario('history-cap');
    try {
      writePayload(scenario, { 'pages/a': '<html>A</html>', 'pages/b': '<html>B</html>' });
      writeManifest(scenario, ['pages/a', 'pages/b'], 'v1');
      expect(runPush(scenario, 'delta').status).toBe(0);
      writePayload(scenario, { 'pages/a': '<html>A v2</html>', 'pages/b': '<html>B</html>' });
      writeManifest(scenario, ['pages/a', 'pages/b'], 'v2');
      const result = runPush(scenario, 'delta', { SHARD_HISTORY_CAP: '1' });
      expect(result.status).toBe(0);
      expect(result.output).toMatch(/history cap 1 reached/);
      expect(result.output).toMatch(/delta fallback: .*history cap.*full overlay/);
      expect(git(['-C', scenario.remote, 'rev-list', '--count', 'main'])).toBe('1');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('rifiuta uno shrink non riconosciuto e lascia il remote invariato', () => {
    const scenario = createScenario('shrink-guard');
    try {
      writePayload(scenario, {
        'pages/a': '<html>A</html>',
        'pages/b': '<html>B</html>',
        'pages/c': '<html>C</html>',
        'pages/d': '<html>D</html>',
      });
      writeManifest(scenario, ['pages/a', 'pages/b', 'pages/c', 'pages/d'], 'v1');
      expect(runPush(scenario, 'delta').status).toBe(0);
      const before = git(['-C', scenario.remote, 'rev-parse', 'main']);
      writePayload(scenario, { 'pages/a': '<html>A</html>' });
      writeManifest(scenario, ['pages/a'], 'v2');
      const result = runPush(scenario, 'delta');
      expect(result.status).toBe(1);
      expect(result.output).toMatch(/delta fallback: fallback reason=shrink guard/);
      expect(result.output).toContain('refusing push');
      expect(git(['-C', scenario.remote, 'rev-parse', 'main'])).toBe(before);
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('usa il self-heal full quando il push delta fallisce', () => {
    const scenario = createScenario('self-heal');
    try {
      writePayload(scenario, { 'pages/a': '<html>A</html>', 'pages/b': '<html>B</html>' });
      writeManifest(scenario, ['pages/a', 'pages/b'], 'v1');
      expect(runPush(scenario, 'delta').status).toBe(0);
      const before = git(['-C', scenario.remote, 'rev-parse', 'main']);
      const hook = join(scenario.remote, 'hooks', 'pre-receive');
      writeFileSync(hook, [
        '#!/bin/sh',
        'while read old new ref; do',
        '  if git cat-file -p "$new" | grep -q "^parent "; then',
        '    echo "forced delta rejection" >&2',
        '    exit 1',
        '  fi',
        'done',
        'exit 0',
        '',
      ].join('\n'), { mode: 0o755 });
      writePayload(scenario, { 'pages/a': '<html>A v2</html>', 'pages/b': '<html>B</html>' });
      writeManifest(scenario, ['pages/a', 'pages/b'], 'v2');
      const result = runPush(scenario, 'delta');
      expect(result.status).toBe(0);
      expect(result.output).toContain('delta self-heal required');
      expect(git(['-C', scenario.remote, 'rev-parse', 'main'])).not.toBe(before);
      expect(git(['-C', scenario.remote, 'rev-list', '--count', 'main'])).toBe('1');
      assertContent(scenario.remote, 'en/pages/a/index.html', '<html>A v2</html>');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('applica lo stesso delta alla entrypoint dei section shard', () => {
    const scenario = createScenario('section-lifecycle');
    const sectionTarget = {
      script: PUSH_SECTION,
      args: (current: Scenario) => ['ticino', 'en', current.dist],
      deployKey: 'SHARD_TICINO_EN_DEPLOY_KEY',
      label: 'section',
    };
    try {
      writeSectionPayload(scenario, {
        'pages/a': '<html>A</html>',
        'pages/b': '<html>B v1</html>',
      });
      writeManifest(scenario, ['pages/a', 'pages/b'], 'v1', 'en/find-jobs-ticino');
      expect(runPush(scenario, 'delta', {}, sectionTarget).status).toBe(0);
      expect(treeFiles(scenario.remote)).toContain('en/find-jobs-ticino/pages/a/index.html');

      writeSectionPayload(scenario, {
        'pages/a': '<html>A</html>',
        'pages/c': '<html>C</html>',
      });
      writeManifest(scenario, ['pages/a', 'pages/c'], 'v2', 'en/find-jobs-ticino');
      const result = runPush(scenario, 'delta', {}, sectionTarget);
      expect(result.status).toBe(0);
      expect(result.output).toContain('delta indexed tree');
      expect(treeFiles(scenario.remote)).toContain('en/find-jobs-ticino/pages/c/index.html');
      expect(treeFiles(scenario.remote)).not.toContain('en/find-jobs-ticino/pages/b/index.html');
      assertContent(scenario.remote, 'en/find-jobs-ticino/pages/a/index.html', '<html>A</html>');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('mantiene l’output byte-identico tra default full e full esplicito', () => {
    const implicit = createScenario('full-default');
    const explicit = createScenario('full-explicit');
    try {
      for (const scenario of [implicit, explicit]) {
        writePayload(scenario, {
          'pages/a': '<html>A</html>',
          'pages/b': '<html>B</html>',
        });
      }
      const defaultRun = runPush(implicit, undefined);
      const explicitRun = runPush(explicit, 'full');
      expect(defaultRun.status).toBe(0);
      expect(explicitRun.status).toBe(0);
      expect(treeSha(implicit.remote)).toBe(treeSha(explicit.remote));
      expect(treeFiles(implicit.remote)).toEqual(treeFiles(explicit.remote));
      expect(treeFiles(implicit.remote)).not.toContain('.deploy-manifest/v1/en.jsonl');
    } finally {
      rmSync(implicit.root, { recursive: true, force: true });
      rmSync(explicit.root, { recursive: true, force: true });
    }
  });

  it('verifica in modo advisory il tree delta accanto al push full', () => {
    const scenario = createScenario('full-verify');
    try {
      writePayload(scenario, {
        'pages/a': '<html>A v1</html>',
        'pages/b': '<html>B</html>',
      });
      writeManifest(scenario, ['pages/a', 'pages/b'], 'v1');
      expect(runPush(scenario, 'full').status).toBe(0);

      writePayload(scenario, {
        'pages/a': '<html>A v2</html>',
        'pages/c': '<html>C</html>',
      });
      writeManifest(scenario, ['pages/a', 'pages/c'], 'v2');
      const result = runPush(scenario, 'full', { SHARD_PUSH_VERIFY: '1' });
      expect(result.status).toBe(0);
      expect(result.output).toMatch(/\[shard-push-verify\] shard=.* mode=full plan=delta .*adds=\d+ mods=\d+ dels=\d+ mismatches=0 wall_plan=\d+s/);
      expect(treeFiles(scenario.remote)).toContain('.deploy-manifest/v1/en.jsonl');
      expect(treeFiles(scenario.remote)).not.toContain('en/pages/b/index.html');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('verifica anche il tree full di un section shard', () => {
    const scenario = createScenario('section-full-verify');
    const sectionTarget = {
      script: PUSH_SECTION,
      args: (current: Scenario) => ['ticino', 'en', current.dist],
      deployKey: 'SHARD_TICINO_EN_DEPLOY_KEY',
      label: 'section',
    };
    try {
      writeSectionPayload(scenario, { 'pages/a': '<html>A v1</html>', 'pages/b': '<html>B</html>' });
      writeManifest(scenario, ['pages/a', 'pages/b'], 'v1', 'en/find-jobs-ticino');
      expect(runPush(scenario, 'full', {}, sectionTarget).status).toBe(0);

      writeSectionPayload(scenario, { 'pages/a': '<html>A v2</html>', 'pages/c': '<html>C</html>' });
      writeManifest(scenario, ['pages/a', 'pages/c'], 'v2', 'en/find-jobs-ticino');
      const result = runPush(scenario, 'full', { SHARD_PUSH_VERIFY: '1' }, sectionTarget);
      expect(result.status).toBe(0);
      expect(result.output).toMatch(/\[shard-push-verify\] shard=.* mode=full plan=delta .*mismatches=0 wall_plan=\d+s/);
      expect(treeFiles(scenario.remote)).toContain('.deploy-manifest/v1/en.jsonl');
      expect(treeFiles(scenario.remote)).not.toContain('en/find-jobs-ticino/pages/b/index.html');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('mantiene path Unicode e bookkeeping identici tra piano delta e push full', () => {
    const full = createScenario('unicode-full');
    const delta = createScenario('unicode-delta');
    const initialFiles = {
      'pages/aktienmarkt-rot-ölpreise-tessin': '<html>oil v1</html>',
    };
    const updatedFiles = {
      'pages/aktienmarkt-rot-ölpreise-tessin': '<html>oil v2</html>',
    };
    try {
      for (const scenario of [full, delta]) {
        writePayload(scenario, initialFiles);
        writeManifest(scenario, Object.keys(initialFiles), 'v1');
        expect(runPush(scenario, 'full', { SHARD_PUSH_VERIFY: '1' }).status).toBe(0);
      }

      for (const scenario of [full, delta]) {
        writePayload(scenario, updatedFiles);
        writeManifest(scenario, Object.keys(updatedFiles), 'v2');
      }

      const fullResult = runPush(full, 'full', { SHARD_PUSH_VERIFY: '1' });
      const deltaResult = runPush(delta, 'delta');
      expect(fullResult.status).toBe(0);
      expect(fullResult.output).toMatch(/mismatches=0/);
      expect(deltaResult.status).toBe(0);
      expect(deltaResult.output).toContain('delta indexed tree');
      expect(treeSha(delta.remote)).toBe(treeSha(full.remote));
      expect(treeFiles(delta.remote)).toContain('en/pages/aktienmarkt-rot-ölpreise-tessin/index.html');
      expect(blobSha(delta.remote, '.shard-filecount')).toBe(blobSha(full.remote, '.shard-filecount'));
    } finally {
      rmSync(full.root, { recursive: true, force: true });
      rmSync(delta.root, { recursive: true, force: true });
    }
  });

  it('mantiene path con spazi e apostrofi nel piano delta', () => {
    const scenario = createScenario('spaces-and-apostrophes');
    const initialFiles = {
      "pages/spaced path/editor's-choice": '<html>apostrophe</html>',
    };
    try {
      writePayload(scenario, initialFiles);
      writeManifest(scenario, Object.keys(initialFiles), 'v1');
      const initialResult = runPush(scenario, 'full', { SHARD_PUSH_VERIFY: '1' });
      expect(initialResult.status).toBe(0);
      expect(initialResult.output).toMatch(/mismatches=0/);
      const updatedFiles = {
        "pages/spaced path/editor's-choice": '<html>apostrophe v2</html>',
      };
      writePayload(scenario, updatedFiles);
      writeManifest(scenario, Object.keys(updatedFiles), 'v2');
      const result = runPush(scenario, 'full', { SHARD_PUSH_VERIFY: '1' });
      expect(result.status).toBe(0);
      expect(result.output).toMatch(/mismatches=0/);
      expect(treeFiles(scenario.remote)).toContain("en/pages/spaced path/editor's-choice/index.html");
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('mantiene path Unicode anche nel fallback del verifier senza manifest valido', () => {
    const scenario = createScenario('unicode-verifier-fallback');
    const files = {
      'pages/aktienmarkt-rot-ölpreise-tessin': '<html>oil fallback</html>',
    };
    try {
      writePayload(scenario, files);
      writeManifest(scenario, Object.keys(files), 'v1');
      writeFileSync(join(scenario.manifestDir, 'en.jsonl'), '{invalid jsonl\n');
      const result = runPush(scenario, 'full', { SHARD_PUSH_VERIFY: '1' });
      expect(result.status).toBe(0);
      expect(result.output).toMatch(/mismatches=0/);
      expect(treeFiles(scenario.remote)).toContain('en/pages/aktienmarkt-rot-ölpreise-tessin/index.html');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });

  it('usa liste e hashing batch anche con qualche migliaio di file non manifestati', () => {
    const scenario = createScenario('batch-thousands');
    const payloadFiles = 3000;
    try {
      writeManyPayload(scenario, payloadFiles);
      writeManifest(scenario, [], 'v1');
      expect(runPush(scenario, 'delta').status).toBe(0);

      writeManyPayload(scenario, payloadFiles, 1777);
      writeManifest(scenario, [], 'v2');
      const result = runPush(scenario, 'delta');
      expect(result.status).toBe(0);
      expect(result.output).toContain('delta indexed tree');
      expect(result.output).toMatch(/changed=1, unmanifested-overlay=3001, reused=3001/);
      expect(result.elapsedMs).toBeLessThan(15000);
      assertContent(scenario.remote, 'en/assets/asset-1777.txt', 'asset-1777-v2\n');
    } finally {
      rmSync(scenario.root, { recursive: true, force: true });
    }
  });
});
