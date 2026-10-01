// scripts/assisted-application/extension-sync.sh, the owner's Mac side of the
// extension's updates: the folder Chrome loads follows origin/main, exactly.
// Two throwaway git repositories stand in for GitHub and the site checkout.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = resolve(__dirname, '../scripts/assisted-application/extension-sync.sh');
const EXTENSION = 'scripts/assisted-application/extension';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });

function setup() {
  root = mkdtempSync(join(tmpdir(), 'extension-sync-'));
  const upstream = join(root, 'upstream');
  mkdirSync(join(upstream, EXTENSION), { recursive: true });
  git(root, 'init', '--quiet', '--initial-branch=main', upstream);
  const write = (file: string, text: string) => writeFileSync(join(upstream, EXTENSION, file), text);
  const commit = (message: string) => {
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '--quiet', '-m', message);
  };
  write('manifest.json', '{"version":"1.0.0"}');
  write('filler.js', '// v1');
  commit('v1');
  const checkout = join(root, 'checkout');
  git(root, 'clone', '--quiet', upstream, checkout);
  const dest = join(root, 'Chrome folder');
  const run = () => execFileSync('/bin/bash', [SCRIPT, 'run'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH || '/usr/bin:/bin', COMPILA_SYNC_GIT_DIR: join(checkout, '.git'), COMPILA_SYNC_DEST: dest, COMPILA_SYNC_STATE_DIR: join(root, 'state') },
  });
  return { write, commit, run, dest, upstream };
}

describe('extension sync (owner Mac)', () => {
  it('copies origin/main\'s extension folder and then follows it, removed files included', () => {
    const { write, commit, run, dest, upstream } = setup();
    expect(run()).toMatch(/synced .* to origin\/main/);
    expect(readFileSync(join(dest, 'filler.js'), 'utf8')).toBe('// v1');

    // Nothing new on main: nothing is rewritten.
    expect(run()).toBe('');

    // A merge changes a file and removes another: the folder becomes exactly the new one.
    write('filler.js', '// v2');
    write('manifest.json', '{"version":"1.1.0"}');
    write('content.js', '// new');
    commit('v2');
    git(upstream, 'rm', '--quiet', `${EXTENSION}/content.js`);
    commit('v3');
    expect(run()).toMatch(/synced/);
    expect(readFileSync(join(dest, 'filler.js'), 'utf8')).toBe('// v2');
    expect(readFileSync(join(dest, 'manifest.json'), 'utf8')).toBe('{"version":"1.1.0"}');
    expect(existsSync(join(dest, 'content.js'))).toBe(false);
  });

  it('puts back a folder that was emptied, even when main did not move', () => {
    const { run, dest } = setup();
    run();
    rmSync(dest, { recursive: true, force: true });
    expect(run()).toMatch(/synced/);
    expect(readFileSync(join(dest, 'filler.js'), 'utf8')).toBe('// v1');
  });
});
