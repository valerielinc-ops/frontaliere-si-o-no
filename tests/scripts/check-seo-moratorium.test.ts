// @vitest-environment node
/**
 * Unit tests for scripts/check-seo-moratorium.mjs.
 *
 * Covers the two structural branches:
 *   1. avg_position ≤ THRESHOLD  → exit 0 regardless of diff (moratorium off)
 *   2. avg_position > THRESHOLD + diff adds a new `build-plugins/*Landing*.ts`
 *      → exit 1 (moratorium active and PR violates it)
 *
 * Both tests spawn the script in a temp git repo so we can fully control the
 * diff that `git diff --name-status origin/main...HEAD` returns — no mocks
 * needed, just real git plumbing.
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

describe('check-seo-moratorium', () => {
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

  it('exits 0 when avg_position ≤ 7.5 (moratorium not active)', () => {
    writeFileSync(
      join(repo, 'data', 'gsc-position-rolling.json'),
      JSON.stringify({
        avg_position: 6.5,
        window: { start: '2026-05-10', end: '2026-05-17' },
        daily: [],
      }),
    );
    // Even add a forbidden file — it must not trigger when moratorium is off
    writeFileSync(join(repo, 'build-plugins', 'newLandingPlugin.ts'), '// new\n');

    const r = spawnSync('node', ['scripts/check-seo-moratorium.mjs'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_BASE_REF: 'main' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Moratorium not active/);
  });

  it('exits 1 when avg_position > 7.5 AND diff adds a new build-plugins/*Landing*.ts', () => {
    writeFileSync(
      join(repo, 'data', 'gsc-position-rolling.json'),
      JSON.stringify({
        avg_position: 8.62,
        window: { start: '2026-05-10', end: '2026-05-17' },
        daily: [],
      }),
    );
    // Stage a new landing emitter and commit so it shows up in git diff
    writeFileSync(join(repo, 'build-plugins', 'fooLandingPlugin.ts'), '// new landing\n');
    git(repo, 'add', 'build-plugins/fooLandingPlugin.ts');
    git(repo, 'commit', '-m', 'feat: add foo landing');

    const r = spawnSync('node', ['scripts/check-seo-moratorium.mjs'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_BASE_REF: 'main' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Moratorium active \(avg position 8\.62 > 7\.5\)/);
    expect(r.stderr).toMatch(/fooLandingPlugin\.ts/);
  });

  it('exits 0 when moratorium active but diff only adds an exempt Bridge emitter', () => {
    writeFileSync(
      join(repo, 'data', 'gsc-position-rolling.json'),
      JSON.stringify({
        avg_position: 8.62,
        window: { start: '2026-05-10', end: '2026-05-17' },
        daily: [],
      }),
    );
    writeFileSync(join(repo, 'build-plugins', 'jobOrphanBridgePlugin.ts'), '// bridge\n');
    git(repo, 'add', 'build-plugins/jobOrphanBridgePlugin.ts');
    git(repo, 'commit', '-m', 'feat: add bridge');

    const r = spawnSync('node', ['scripts/check-seo-moratorium.mjs'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_BASE_REF: 'main' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/no new SEO landing emitters/);
  });
});
