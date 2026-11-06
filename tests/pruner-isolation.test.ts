import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolatedPrunerArgs, runIsolatedPruner } from './helpers/runIsolatedPruner';
import { collectRelativeImportClosure } from './helpers/collectRelativeImportClosure';

const roots: string[] = [];
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pruner-isolation-')));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('pruner safety boundary', () => {
  it('does not import global sweepers, even transitively', () => {
    const closure = collectRelativeImportClosure(process.cwd(), 'scripts/prune-merged-worktrees.mjs');
    for (const name of ['device-artifact', 'workspace-artifact', 'temp-dir']) {
      expect(closure.some((file) => file.endsWith(`stale-${name}-sweep.mjs`))).toBe(false);
    }
  });

  it('permits fixture writes but denies writes and deletions outside the fixture', () => {
    const root = fixture();
    const outside = path.join(fixture(), 'keep.jsonl');
    fs.writeFileSync(outside, 'irreplaceable history');
    const code = `
      const fs = require('node:fs');
      const [inside, outside] = process.argv.slice(1);
      fs.writeFileSync(inside, 'allowed');
      for (const operation of [
        () => fs.writeFileSync(outside, 'overwritten'),
        () => fs.rmSync(outside),
      ]) {
        try { operation(); process.exit(91); }
        catch (error) { if (error.code !== 'ERR_ACCESS_DENIED') throw error; }
      }
    `;
    execFileSync(process.execPath, [...isolatedPrunerArgs(root), '-e', code,
      path.join(root, 'allowed'), outside], { stdio: 'pipe' });
    expect(fs.readFileSync(path.join(root, 'allowed'), 'utf8')).toBe('allowed');
    expect(fs.readFileSync(outside, 'utf8')).toBe('irreplaceable history');
  });

  it.runIf(process.platform === 'darwin')('OS sandbox blocks symlink escapes and child-process writes', () => {
    const root = fixture();
    const outside = path.join(fixture(), 'keep.jsonl');
    fs.writeFileSync(outside, 'irreplaceable history');
    const link = path.join(root, 'outside-link');
    fs.symlinkSync(outside, link);
    const code = `
      const fs = require('node:fs');
      const [link, outside] = process.argv.slice(1);
      try { fs.writeFileSync(link, 'overwritten'); process.exit(91); }
      catch (error) { if (!['EPERM', 'EACCES', 'ERR_ACCESS_DENIED'].includes(error.code)) throw error; }
      const child = require('node:child_process').spawnSync('/bin/sh',
        ['-c', 'printf overwritten > "$1"', 'fixture', outside]);
      if (child.status === 0) process.exit(92);
    `;
    runIsolatedPruner('-e', [code, link, outside], root, root, process.env);
    expect(fs.readFileSync(outside, 'utf8')).toBe('irreplaceable history');
  });

  it('rejects broad roots and out-of-fixture cwd before execution', () => {
    expect(() => isolatedPrunerArgs(os.tmpdir())).toThrow('dedicated directory');
    expect(() => runIsolatedPruner('unused', [], fixture(), process.cwd(), {}))
      .toThrow('cwd must belong');
  });
});
