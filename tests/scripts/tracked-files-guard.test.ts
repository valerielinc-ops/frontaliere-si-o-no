import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  formatTrackedChanges,
  parsePorcelainZ,
  snapshotTrackedState,
  trackedChanges,
} from '../../scripts/ci/lib/tracked-files-guard.mjs';

describe('parsePorcelainZ', () => {
  it('reads modified and deleted tracked paths', () => {
    expect(parsePorcelainZ(' M data/a.json\0 D data/b.json\0')).toEqual(['data/a.json', 'data/b.json']);
  });

  it('keeps both sides of a staged rename', () => {
    expect(parsePorcelainZ('R  data/new.json\0data/old.json\0 M x.ts\0')).toEqual(['data/new.json', 'data/old.json', 'x.ts']);
  });

  it('keeps paths with spaces intact', () => {
    expect(parsePorcelainZ(' M docs/a file.md\0')).toEqual(['docs/a file.md']);
  });
});

describe('trackedChanges', () => {
  const before = new Map([['wip.ts', 'h1'], ['data/steady.json', 'h2']]);

  it('ignores files that were already dirty and did not change', () => {
    expect(trackedChanges(before, new Map(before))).toEqual([]);
  });

  it('reports files dirtied by the run', () => {
    const after = new Map([...before, ['data/pharmacy-sources-registry.json', 'h3']]);
    expect(trackedChanges(before, after)).toEqual(['data/pharmacy-sources-registry.json']);
  });

  it('reports an already dirty file that the run changed again', () => {
    const after = new Map([['wip.ts', 'h9'], ['data/steady.json', 'h2']]);
    expect(trackedChanges(before, after)).toEqual(['wip.ts']);
  });

  it('does not report a file the run restored', () => {
    expect(trackedChanges(before, new Map([['data/steady.json', 'h2']]))).toEqual([]);
  });

  it('allows snapshot files only in snapshot update mode', () => {
    const after = new Map([...before, ['tests/__snapshots__/a.test.ts.snap', 'h4']]);
    expect(trackedChanges(before, after)).toEqual(['tests/__snapshots__/a.test.ts.snap']);
    expect(trackedChanges(before, after, { allowSnapshotUpdates: true })).toEqual([]);
  });
});

describe('snapshotTrackedState on a real repository', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tracked-guard-'));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'guard@example.test');
  git('config', 'user.name', 'guard');
  writeFileSync(join(repo, 'tracked.json'), '{"a":1}\n');
  writeFileSync(join(repo, 'other.json'), '{"b":1}\n');
  git('add', '.');
  git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');

  it('sees a modification, a deletion and ignores untracked files', () => {
    const before = snapshotTrackedState(repo);
    expect(before).toEqual(new Map());
    writeFileSync(join(repo, 'tracked.json'), '{"a":2}\n');
    renameSync(join(repo, 'other.json'), join(repo, 'moved.json'));
    writeFileSync(join(repo, 'scratch.txt'), 'untracked\n');
    const after = snapshotTrackedState(repo)!;
    expect(trackedChanges(before!, after)).toEqual(['other.json', 'tracked.json']);
    expect(after.get('other.json')).toBe('missing');
  });

  it('returns null outside a git repository', () => {
    const plain = mkdtempSync(join(tmpdir(), 'tracked-guard-plain-'));
    try {
      expect(snapshotTrackedState(plain, { git: () => { throw new Error('not a repo'); } })).toBeNull();
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe('formatTrackedChanges', () => {
  it('names the files and the rule', () => {
    const message = formatTrackedChanges(['data/pharmacy-sources-registry.json']);
    expect(message).toContain('1 file tracciato');
    expect(message).toContain('  - data/pharmacy-sources-registry.json');
    expect(message).toContain('Un test non scrive MAI in un file tracciato');
  });
});
