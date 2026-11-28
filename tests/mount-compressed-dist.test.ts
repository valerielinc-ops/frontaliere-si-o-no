// scripts/ci/mount-compressed-dist.sh — dist/ logico su volume btrfs compresso
// (#19102, #17161, #7421).
//
// Il montaggio vero richiede Linux, sudo e btrfs: gira sul runner GitHub (la
// stessa immagine dei workflow di audit) ed e' saltato altrove. Il ramo di
// rinuncia e la protezione dei file gia' presenti girano ovunque.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(__dirname, '..', 'scripts/ci/mount-compressed-dist.sh');
const dirs: string[] = [];
const mounts: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'compressed-dist-'));
  dirs.push(dir);
  return dir;
}

function run(cwd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    cwd,
    encoding: 'utf-8',
    timeout: 240_000,
    env: {
      ...process.env,
      // Mai il volume o il GITHUB_ENV veri del job che esegue i test.
      DIST_VOLUME_ROOT: join(cwd, 'volume'),
      GITHUB_ENV: join(cwd, 'github-env'),
      GITHUB_WORKSPACE: cwd,
      RUNNER_TEMP: join(cwd, 'runner-temp'),
      ...env,
    },
  });
}

afterEach(() => {
  // Il bind mount prima del filesystem che lo ospita.
  for (const target of mounts.splice(0)) spawnSync('sudo', ['-n', 'umount', target]);
  for (const dir of dirs.splice(0)) {
    spawnSync('sudo', ['-n', 'rm', '-rf', join(dir, 'volume')]);
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('mount-compressed-dist.sh', () => {
  it('rejects an unknown command or a missing directory', () => {
    const cwd = workspace();
    expect(run(cwd, ['unmount', 'dist']).status).toBe(2);
    expect(run(cwd, ['mount']).status).toBe(2);
  });

  it('never mounts over a dist/ that already holds files', () => {
    const cwd = workspace();
    mkdirSync(join(cwd, 'dist'));
    writeFileSync(join(cwd, 'dist/index.html'), 'trunk');

    const result = run(cwd, ['mount', 'dist']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::compressed dist volume not mounted (dist is not empty)');
    expect(readFileSync(join(cwd, 'dist/index.html'), 'utf-8')).toBe('trunk');
    expect(existsSync(join(cwd, 'github-env'))).toBe(false);
  });

  it('keeps a plain dist/ when the volume cannot be sized', () => {
    const cwd = workspace();

    // Una riserva impossibile: rinuncia su ogni host, anche senza btrfs.
    const result = run(cwd, ['mount', 'dist'], { DIST_VOLUME_RESERVE_GIB: '1000000' });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('::warning::compressed dist volume not mounted');
    expect(existsSync(join(cwd, 'dist'))).toBe(true);
    expect(existsSync(join(cwd, 'github-env'))).toBe(false);
  });

  const hostedLinux = process.platform === 'linux'
    && process.env.GITHUB_ACTIONS === 'true'
    && spawnSync('sudo', ['-n', 'true']).status === 0;

  it.runIf(hostedLinux)('mounts a compressed volume on the hosted runner and stores HTML in fewer host blocks', () => {
    const cwd = workspace();
    const volume = join(cwd, 'volume');

    const result = run(cwd, ['mount', 'dist'], { DIST_VOLUME_RESERVE_GIB: '2', DIST_VOLUME_MIN_GIB: '1' });
    mounts.push(join(cwd, 'dist'), join(volume, 'fs'));

    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout, result.stdout + result.stderr).not.toContain('::warning::');
    expect(execFileSync('findmnt', ['-n', '-o', 'FSTYPE', join(cwd, 'dist')], { encoding: 'utf-8' }).trim())
      .toBe('btrfs');
    const cloneRoot = join(volume, 'fs/clones');
    expect(readFileSync(join(cwd, 'github-env'), 'utf-8')).toContain(`REHYDRATE_CLONE_ROOT=${cloneRoot}`);

    // Come il fallback del rehydrate: clone sul volume, poi `mv` dentro dist/.
    mkdirSync(join(cloneRoot, 'tree'));
    writeFileSync(join(cloneRoot, 'tree/index.html'), 'cloned');
    execFileSync('mv', [join(cloneRoot, 'tree'), join(cwd, 'dist/section')]);
    expect(readFileSync(join(cwd, 'dist/section/index.html'), 'utf-8')).toBe('cloned');

    // Una directory per pagina, come le pagine job: 5.000 file da ~16 KiB.
    const page = `<html><body>${'<div class="job-card"><a href="/cerca-lavoro-ticino/">Lavoro in Ticino</a></div>\n'.repeat(190)}</body></html>`;
    const pages = 5000;
    for (let i = 0; i < pages; i += 1) {
      mkdirSync(join(cwd, `dist/section/page-${i}`));
      writeFileSync(join(cwd, `dist/section/page-${i}/index.html`), `${page}<!-- ${i} -->`);
    }

    const report = run(cwd, ['report', 'dist']);
    expect(report.status).toBe(0);
    expect(report.stdout).toContain('dist volume (compressed):');
    const logicalBytes = pages * page.length;
    const hostBytes = Number(execFileSync('sudo', ['-n', 'du', '-B1', join(volume, 'volume.img')], { encoding: 'utf-8' }).split(/\s/)[0]);
    console.log(`compressed dist: ${logicalBytes} logical bytes held in ${hostBytes} host bytes`);
    // mkfs compreso, il volume deve stare ben sotto i byte logici.
    expect(hostBytes).toBeLessThan(logicalBytes * 0.75);
  }, 300_000);
});
