/**
 * SHARD_DELTA_CDN_REWRITE=changed — in delta mode push-section-shard.sh
 * CDN-rewrites only the staged files the delta push reads (changed +
 * unmanifested overlay + 404.html) and completes the rest of the staged copy
 * in background for the validate-dist pack.
 *
 * Contract locked here:
 *   1. offload-generated-images-cdn.mjs --files-from rewrites ONLY the listed
 *      files, with the same bytes a full pass produces, writes no /assets/
 *      verdict marker, and fails loud (exit 1) on a bad list.
 *   2. Same payload sequence pushed with the variable off and on → the SAME
 *      git tree lands on the shard remote, both on the first push (delta falls
 *      back to full) and on a real delta push.
 *   3. With the variable on, the staged copy the pack step tars ends up
 *      byte-identical to the variable-off one once the background pass is done.
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { MANIFEST_VERSION } from '../build-plugins/shared/incrementalManifest.mjs';

const ROOT = process.cwd();
const OFFLOAD = join(ROOT, 'scripts/offload-generated-images-cdn.mjs');
const PUSH_SECTION = join(ROOT, 'scripts/lib/push-section-shard.sh');
const CDN_LIB = join(ROOT, 'scripts/lib/shard-cdn-rewrite.sh');
const CDN_BASE = 'https://cdn.frontaliereticino.ch';
const SCOPE = 'en/find-jobs-ticino';
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

function page(label: string): string {
  // <head> → base inject; same-origin og:image and /data/ refs → rewritten.
  // No /assets/ ref: that family triggers a live CDN existence check.
  return '<!doctype html><html><head><meta charset="utf-8">'
    + `<meta property="og:image" content="https://frontaliereticino.ch/og/jobs/${label}.webp">`
    + `</head><body><a href="/data/${label}.json">${label}</a></body></html>`;
}

function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const fp = join(d, e.name);
      if (e.isDirectory()) walk(fp);
      else out.push(relative(dir, fp));
    }
  };
  walk(dir);
  return out.sort();
}

function snapshotTree(dir: string): Record<string, string> {
  return Object.fromEntries(listFiles(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
}

describe('offload --files-from', () => {
  it('riscrive solo i file elencati, con gli stessi byte del pass completo', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'offload-files-from-'));
    const full = mkdtempSync(join(tmpdir(), 'offload-files-full-'));
    const runnerTemp = mkdtempSync(join(tmpdir(), 'offload-files-runner-'));
    try {
      for (const root of [tmp, full]) {
        for (const name of ['a', 'b', 'c']) {
          mkdirSync(join(root, 'dist', 'en', name), { recursive: true });
          writeFileSync(join(root, 'dist', 'en', name, 'index.html'), page(name));
        }
      }
      writeFileSync(join(tmp, 'list.txt'), 'en/b/index.html\0');
      execFileSync('node', [OFFLOAD, '--files-from', join(tmp, 'list.txt')], {
        cwd: tmp, env: { ...process.env, CDN_BASE, RUNNER_TEMP: runnerTemp }, stdio: 'pipe',
      });
      execFileSync('node', [OFFLOAD], { cwd: full, env: { ...process.env, CDN_BASE }, stdio: 'pipe' });

      const read = (root: string, name: string) => readFileSync(join(root, 'dist', 'en', name, 'index.html'), 'utf8');
      expect(read(tmp, 'a')).toBe(page('a'));
      expect(read(tmp, 'c')).toBe(page('c'));
      expect(read(tmp, 'b')).not.toBe(page('b'));
      expect(read(tmp, 'b')).toBe(read(full, 'b'));
      expect(read(tmp, 'b')).toContain(`${CDN_BASE}/og/jobs/b.webp`);
      expect(existsSync(join(runnerTemp, 'assets-same-origin.marker'))).toBe(false);

      // Idempotent completion: a full pass after the partial one gives the
      // same bytes as a single full pass.
      execFileSync('node', [OFFLOAD, '--strict'], { cwd: tmp, env: { ...process.env, CDN_BASE }, stdio: 'pipe' });
      expect(snapshotTree(join(tmp, 'dist'))).toEqual(snapshotTree(join(full, 'dist')));
    } finally {
      for (const d of [tmp, full, runnerTemp]) rmSync(d, { recursive: true, force: true });
    }
  });

  it('esce 1 su una lista con un file mancante o fuori da dist', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'offload-files-bad-'));
    try {
      mkdirSync(join(tmp, 'dist'), { recursive: true });
      const bare = spawnSync('node', [OFFLOAD, '--files-from'], {
        cwd: tmp, env: { ...process.env, CDN_BASE }, encoding: 'utf8',
      });
      expect(bare.status).toBe(1);
      for (const entry of ['missing/index.html', '../escape.html']) {
        writeFileSync(join(tmp, 'list.txt'), `${entry}\n`);
        const result = spawnSync('node', [OFFLOAD, '--files-from', join(tmp, 'list.txt')], {
          cwd: tmp, env: { ...process.env, CDN_BASE }, encoding: 'utf8',
        });
        expect(result.status).toBe(1);
        expect(result.stdout).toContain('strict mode');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

type Scenario = { root: string; remote: string; dist: string; manifestDir: string };

function createScenario(name: string): Scenario {
  const root = mkdtempSync(join(tmpdir(), `shard-cdn-${name}-`));
  const remote = join(root, 'remote.git');
  mkdirSync(remote, { recursive: true });
  git(['init', '--bare', '-q', '-b', 'main', remote]);
  return { root, remote, dist: join(root, 'dist'), manifestDir: join(root, 'manifest') };
}

// Manifest hash = page content, so an identical page is `unchanged` across runs
// and comes from the shard HEAD instead of the staged copy.
function writeInputs(scenario: Scenario, pages: Record<string, string>, manifestPages: string[]): void {
  const sectionRoot = join(scenario.dist, SCOPE);
  rmSync(scenario.dist, { recursive: true, force: true });
  mkdirSync(sectionRoot, { recursive: true });
  writeFileSync(join(sectionRoot, 'index.html'), page('section-root'));
  for (const [name, content] of Object.entries(pages)) {
    mkdirSync(join(sectionRoot, name), { recursive: true });
    writeFileSync(join(sectionRoot, name, 'index.html'), content);
  }
  mkdirSync(scenario.manifestDir, { recursive: true });
  const counts = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
  counts['active-job'] = manifestPages.length;
  const hash = (v: string) => createHash('sha256').update(v, 'utf8').digest('hex');
  const lines = [
    JSON.stringify({ type: 'header', manifestVersion: MANIFEST_VERSION, format: 'jsonl', locale: 'en' }),
    JSON.stringify({ type: 'kind', kind: 'active-job', templateVersion: 'active-job@1', sourceVersion: 'input@1', state: 'live' }),
    ...manifestPages.map((name) => JSON.stringify({ path: `${SCOPE}/${name}/`, hash: hash(pages[name]) })),
    JSON.stringify({ type: 'footer', counts: { total: manifestPages.length, byKind: counts } }),
  ];
  writeFileSync(join(scenario.manifestDir, 'en.jsonl'), `${lines.join('\n')}\n`);
}

function waitForBackground(runnerTemp: string): void {
  const result = spawnSync('bash', ['-c', `source "${CDN_LIB}"; shard_cdn_rewrite_wait_all "$1" 60`, '_', runnerTemp], {
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
}

function push(scenario: Scenario, cdnRewrite: string): { output: string; staged: Record<string, string> } {
  const runnerTemp = mkdtempSync(join(scenario.root, 'runner-'));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      SHARD_TICINO_EN_DEPLOY_KEY: 'test-deploy-key',
      SHARD_REPO_OVERRIDE: scenario.remote,
      SHARD_INCREMENTAL_MANIFEST_DIR: scenario.manifestDir,
      RUNNER_TEMP: runnerTemp,
      SHARD_PUSH_MODE: 'delta',
      SHARD_PUSH_RETRY_DELAY: '0',
      SHARD_HISTORY_CAP: '50',
      GITHUB_PAT: '',
      SHARD_PUSH_PAT: '',
      GIT_TERMINAL_PROMPT: '0',
      SHARD_DELTA_CDN_REWRITE: cdnRewrite,
    };
    const result = spawnSync('bash', [PUSH_SECTION, 'ticino', 'en', scenario.dist], {
      cwd: ROOT, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    expect(result.status, output).toBe(0);
    waitForBackground(runnerTemp);
    const ready = spawnSync('bash', ['-c', `source "${CDN_LIB}"; shard_cdn_rewrite_ready "$1" ticino en`, '_', runnerTemp], {
      encoding: 'utf8',
    });
    expect(ready.status, ready.stdout).toBe(0);
    const stagedRoot = join(runnerTemp, 'ticino-src-en', 'dist');
    expect(statSync(stagedRoot).isDirectory()).toBe(true);
    return { output, staged: snapshotTree(stagedRoot) };
  } finally {
    rmSync(runnerTemp, { recursive: true, force: true });
  }
}

describe('push-section-shard con SHARD_DELTA_CDN_REWRITE', () => {
  it('pusha lo stesso tree git con la variabile spenta e accesa', () => {
    const off = createScenario('off');
    const on = createScenario('on');
    try {
      const v1 = { a: page('a'), b: page('b-v1'), extra: page('extra-v1') };
      const v2 = { a: page('a'), b: page('b-v2'), c: page('c'), extra: page('extra-v2') };
      const results: Record<string, Array<{ output: string; staged: Record<string, string> }>> = { off: [], on: [] };
      for (const [label, scenario, value] of [['off', off, ''], ['on', on, 'changed']] as const) {
        // `extra` is deliberately NOT in the manifest: unmanifested overlay.
        writeInputs(scenario, v1, ['a', 'b']);
        results[label].push(push(scenario, value));
        writeInputs(scenario, v2, ['a', 'b', 'c']);
        results[label].push(push(scenario, value));
      }

      // First push: remote empty → full fallback → whole staged copy rewritten.
      expect(results.on[0].output).toContain('delta fell back to full');
      // Second push: a real delta that rewrote only what it read.
      expect(results.on[1].output).toContain('delta indexed tree');
      expect(results.on[1].output).toContain('partial offload (--files-from)');
      // a is manifest-unchanged: reused from HEAD, never rewritten by the push.
      expect(results.on[1].output).toMatch(/unchanged=1\b/);
      expect(results.on[1].output).toContain('completing the staged CDN rewrite in background');
      expect(results.off[1].output).not.toContain('partial offload');

      expect(git(['-C', on.remote, 'rev-parse', 'main^{tree}']))
        .toBe(git(['-C', off.remote, 'rev-parse', 'main^{tree}']));
      expect(git(['-C', on.remote, 'rev-parse', 'main~1^{tree}']))
        .toBe(git(['-C', off.remote, 'rev-parse', 'main~1^{tree}']));
      // Pushed bytes are rewritten, including an unchanged page reused from HEAD.
      const pushedA = git(['-C', on.remote, 'show', `main:${SCOPE}/a/index.html`]);
      expect(pushedA).toContain(`${CDN_BASE}/og/jobs/a.webp`);
      expect(pushedA).toContain('__CDN_DATA_BASE__');

      // The staged copy the pack step tars is complete and identical.
      expect(results.on[1].staged).toEqual(results.off[1].staged);
      expect(results.on[1].staged[`${SCOPE}/a/index.html`]).toBe(pushedA);
    } finally {
      rmSync(off.root, { recursive: true, force: true });
      rmSync(on.root, { recursive: true, force: true });
    }
  });

  it('senza la variabile non scrive marker di rewrite parziale', () => {
    const lib = readFileSync(CDN_LIB, 'utf8');
    expect(lib).toContain('shard_cdn_rewrite_enabled');
    for (const value of ['', 'off', 'full', 'bogus']) {
      const result = spawnSync('bash', ['-c', `source "${CDN_LIB}"; shard_cdn_rewrite_enabled delta`], {
        env: { ...process.env, SHARD_DELTA_CDN_REWRITE: value }, encoding: 'utf8',
      });
      expect(result.status).toBe(1);
    }
    const onFull = spawnSync('bash', ['-c', `source "${CDN_LIB}"; shard_cdn_rewrite_enabled full`], {
      env: { ...process.env, SHARD_DELTA_CDN_REWRITE: 'changed' }, encoding: 'utf8',
    });
    expect(onFull.status).toBe(1);
    const onDelta = spawnSync('bash', ['-c', `source "${CDN_LIB}"; shard_cdn_rewrite_enabled delta`], {
      env: { ...process.env, SHARD_DELTA_CDN_REWRITE: 'changed' }, encoding: 'utf8',
    });
    expect(onDelta.status).toBe(0);
  });
});

describe('deploy.yml cabla SHARD_DELTA_CDN_REWRITE', () => {
  it('passa la variabile ai due step di push sezione e mette la barriera nei due pack', () => {
    const yml = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
    const wire = "SHARD_DELTA_CDN_REWRITE: ${{ vars.SHARD_DELTA_CDN_REWRITE == 'changed' && 'changed' || '' }}";
    expect(yml.split(wire).length - 1).toBe(2);
    expect(yml.split('shard_cdn_rewrite_wait_all "$RUNNER_TEMP" || true').length - 1).toBe(2);
    expect(yml.split('shard_cdn_rewrite_ready "$RUNNER_TEMP" "$section"').length - 1).toBe(2);
  });
});

describe('barriera del pack: shard_cdn_rewrite_wait_all', () => {
  it('ripete in modo sincrono un pass in background fallito e registra il nuovo exit code', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'cdn-barrier-'));
    const runnerTemp = mkdtempSync(join(tmpdir(), 'cdn-barrier-runner-'));
    try {
      const stageSrc = join(tmp, 'ticino-src-en');
      mkdirSync(join(stageSrc, 'dist', 'en', 'a'), { recursive: true });
      mkdirSync(join(stageSrc, 'dist', 'en', 'b'), { recursive: true });
      writeFileSync(join(stageSrc, 'dist', 'en', 'a', 'index.html'), page('a'));
      // CRLF newline list: accepted, the \r is not part of the path.
      writeFileSync(join(tmp, 'list.txt'), 'en/b/index.html\r\n');
      writeFileSync(join(stageSrc, 'dist', 'en', 'b', 'index.html'), page('b'));
      execFileSync('node', [OFFLOAD, '--files-from', join(tmp, 'list.txt')], {
        cwd: stageSrc, env: { ...process.env, CDN_BASE }, stdio: 'pipe',
      });
      writeFileSync(join(runnerTemp, 'shard-cdn-partial-ticino-en'), `${stageSrc}\n${OFFLOAD}\n${CDN_BASE}\n`);
      writeFileSync(join(runnerTemp, 'shard-cdn-done-ticino-en'), '1');

      const run = (fn: string) => spawnSync('bash', ['-c', `source "${CDN_LIB}"; ${fn}`, '_', runnerTemp], {
        encoding: 'utf8',
      });
      const barrier = run('shard_cdn_rewrite_wait_all "$1"');
      expect(barrier.status, barrier.stdout).toBe(0);
      expect(barrier.stdout).toContain('re-running the full pass synchronously');
      expect(readFileSync(join(runnerTemp, 'shard-cdn-done-ticino-en'), 'utf8')).toBe('0');
      expect(run('shard_cdn_rewrite_ready "$1" ticino en').status).toBe(0);
      const a = readFileSync(join(stageSrc, 'dist', 'en', 'a', 'index.html'), 'utf8');
      expect(a).toContain(`${CDN_BASE}/og/jobs/a.webp`);
      expect(readFileSync(join(stageSrc, 'dist', 'en', 'b', 'index.html'), 'utf8')).toContain('__CDN_DATA_BASE__');

      // A section whose staged copy is gone stays failed and is not packed.
      writeFileSync(join(runnerTemp, 'shard-cdn-partial-zurigo-en'), `${join(tmp, 'missing')}\n${OFFLOAD}\n${CDN_BASE}\n`);
      writeFileSync(join(runnerTemp, 'shard-cdn-done-zurigo-en'), '1');
      const failed = run('shard_cdn_rewrite_wait_all "$1"');
      expect(failed.status).toBe(1);
      expect(failed.stdout).toContain('failed twice');
      expect(run('shard_cdn_rewrite_ready "$1" zurigo en').status).toBe(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(runnerTemp, { recursive: true, force: true });
    }
  });
});
