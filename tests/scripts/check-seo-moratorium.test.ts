// @vitest-environment node
/**
 * Unit tests for scripts/check-seo-moratorium.mjs.
 *
 * The script is REPORT-ONLY (the SEO-landing moratorium was downgraded from a
 * deploy gate to a tracker — owner decision 2026-06-24). It must therefore
 * ALWAYS exit 0, regardless of the 7-day avg position or whether the PR adds a
 * new SEO-landing emitter; it only PRINTS the position and, for visibility,
 * lists any new landing emitters.
 *
 * Tests spawn the script in a temp git repo so we can fully control the diff
 * that `git diff --name-status origin/main...HEAD` returns — no mocks needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve('scripts/check-seo-moratorium.mjs');

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  }
  return r.stdout;
}

function setupRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'seo-moratorium-test-'));
  // Set up a bare repo to act as "origin"
  const origin = join(dir, 'origin.git');
  spawnSync('git', ['init', '--bare', '-b', 'main', origin], { encoding: 'utf8' });

  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'remote', 'add', 'origin', origin);

  // Seed an initial commit on main with a placeholder file so we have a base
  mkdirSync(join(repo, 'build-plugins'));
  writeFileSync(join(repo, 'build-plugins', 'existingLandingPlugin.ts'), '// placeholder\n');
  mkdirSync(join(repo, 'data'));
  // Copy the script into the temp repo so it can be invoked with relative paths
  mkdirSync(join(repo, 'scripts'));
  cpSync(SCRIPT, join(repo, 'scripts', 'check-seo-moratorium.mjs'));

  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'push', 'origin', 'main');

  // Branch off
  git(repo, 'checkout', '-b', 'feature');
  return repo;
}

function writeRolling(repo: string, avg: number) {
  writeFileSync(
    join(repo, 'data', 'gsc-position-rolling.json'),
    JSON.stringify({ avg_position: avg, window: { start: '2026-05-10', end: '2026-05-17' }, daily: [] }),
  );
}

function runTracker(repo: string) {
  return spawnSync('node', ['scripts/check-seo-moratorium.mjs'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_BASE_REF: 'main' },
  });
}

describe('check-seo-moratorium (report-only tracker)', () => {
  let repo: string;

  beforeEach(() => {
    repo = setupRepo();
  });

  afterEach(() => {
    try {
      rmSync(join(repo, '..'), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });

  it('exits 0 and reports a healthy position when avg ≤ 7.5', () => {
    writeRolling(repo, 6.5);
    const r = runTracker(repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/avg position 6\.50/);
    expect(r.stdout).toMatch(/healthy/);
  });

  it('NEVER blocks: exits 0 even when avg > 7.5 AND the PR adds a new landing emitter', () => {
    writeRolling(repo, 8.62);
    // Stage a new landing emitter and commit so it shows up in git diff
    writeFileSync(join(repo, 'build-plugins', 'fooLandingPlugin.ts'), '// new landing\n');
    git(repo, 'add', 'build-plugins/fooLandingPlugin.ts');
    git(repo, 'commit', '-m', 'feat: add foo landing');

    const r = runTracker(repo);
    expect(r.status).toBe(0); // tracking only — must not fail the build
    expect(r.stdout).toMatch(/avg position 8\.62/);
    // The new landing is surfaced for visibility, explicitly marked as allowed.
    expect(r.stdout).toMatch(/fooLandingPlugin\.ts/);
    expect(r.stdout).toMatch(/tracking only/);
  });

  it('does not flag exempt Bridge/Redirect emitters as new landings', () => {
    writeRolling(repo, 8.62);
    writeFileSync(join(repo, 'build-plugins', 'jobOrphanBridgePlugin.ts'), '// bridge\n');
    git(repo, 'add', 'build-plugins/jobOrphanBridgePlugin.ts');
    git(repo, 'commit', '-m', 'feat: add bridge');

    const r = runTracker(repo);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/jobOrphanBridgePlugin\.ts/);
  });

  it('exits 0 (non-blocking) when the rolling data file is missing', () => {
    // No gsc-position-rolling.json written → must skip gracefully, never fail.
    const r = runTracker(repo);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/not present|skipping/);
  });
});
