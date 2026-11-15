// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  mergeFirstSeenSides,
  parseFirstSeenSide,
} from '../scripts/ci/merge-json-first-seen.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DRIVER = path.join(ROOT, 'scripts/ci/merge-json-first-seen.mjs');

const created: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-first-seen-'));
  created.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runDriver(base: string, ours: string, theirs: string) {
  return spawnSync('node', [DRIVER, base, ours, theirs], { encoding: 'utf8' });
}

describe('merge-json-first-seen: pure merge', () => {
  it('unions both sides, keeps the earliest date, sorts the keys', () => {
    const merged = mergeFirstSeenSides([
      { '/b': '2026-03-01', '/a': '2026-02-01' },
      { '/c': '2026-01-01', '/a': '2026-01-15', '/b': '2026-04-01' },
    ]);
    expect(merged).toEqual({ '/a': '2026-01-15', '/b': '2026-03-01', '/c': '2026-01-01' });
    expect(Object.keys(merged)).toEqual(['/a', '/b', '/c']);
  });

  it('gives the same result whichever side is ours', () => {
    const x = { '/a': '2026-05-01', '/z': '2026-01-01' };
    const y = { '/a': '2026-02-01', '/m': '2026-03-03' };
    expect(mergeFirstSeenSides([x, y])).toEqual(mergeFirstSeenSides([y, x]));
  });

  it('parses an empty side (git hands an empty file for an absent ancestor) as {}', () => {
    expect(parseFirstSeenSide('', 'x')).toEqual({});
    expect(parseFirstSeenSide('  \n', 'x')).toEqual({});
  });

  it('rejects text that is not a JSON object instead of reading it as empty', () => {
    expect(() => parseFirstSeenSide('{"a":', 'ours')).toThrow(/ours is not valid JSON/);
    expect(() => parseFirstSeenSide('[1]', 'ours')).toThrow(/not a JSON object/);
    expect(() => parseFirstSeenSide('null', 'ours')).toThrow(/not a JSON object/);
    expect(() => parseFirstSeenSide('"str"', 'ours')).toThrow(/not a JSON object/);
  });
});

describe('merge-json-first-seen: the git driver', () => {
  it('writes the merged map into %A with the generator format and exits 0', () => {
    const dir = tempDir();
    const ours = path.join(dir, 'ours.json');
    const theirs = path.join(dir, 'theirs.json');
    fs.writeFileSync(ours, JSON.stringify({ '/b': '2026-02-02' }));
    fs.writeFileSync(theirs, JSON.stringify({ '/a': '2026-01-01', '/b': '2026-03-03' }));
    const result = runDriver('/dev/null', ours, theirs);
    expect(result.status).toBe(0);
    expect(fs.readFileSync(ours, 'utf8')).toBe(
      JSON.stringify({ '/a': '2026-01-01', '/b': '2026-02-02' }, null, 2) + '\n',
    );
  });

  it('FAILS and leaves %A untouched when the other side is corrupt (the old load() returned {} and exited 0)', () => {
    const dir = tempDir();
    const ours = path.join(dir, 'ours.json');
    const theirs = path.join(dir, 'theirs.json');
    const original = JSON.stringify({ '/a': '2026-01-01' });
    fs.writeFileSync(ours, original);
    fs.writeFileSync(theirs, '{"/a": "2026-0');
    const result = runDriver('/dev/null', ours, theirs);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('theirs.json is not valid JSON');
    expect(fs.readFileSync(ours, 'utf8')).toBe(original);
  });

  it('FAILS when our own side is corrupt, and when a side file does not exist', () => {
    const dir = tempDir();
    const ours = path.join(dir, 'ours.json');
    const theirs = path.join(dir, 'theirs.json');
    fs.writeFileSync(ours, 'not json');
    fs.writeFileSync(theirs, '{}');
    expect(runDriver('/dev/null', ours, theirs).status).toBe(1);
    fs.writeFileSync(ours, '{}');
    expect(runDriver('/dev/null', ours, path.join(dir, 'absent.json')).status).toBe(1);
  });

  it('resolves a real rebase conflict on shards through .gitattributes, losing nothing', () => {
    const repo = tempDir();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q', '--initial-branch=main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'merge.json-first-seen.driver', `node ${DRIVER} %O %A %B`);
    const attributes = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8')
      .split('\n').filter((line) => /^data\/url-first-seen\/\*\.json\s+merge=json-first-seen$/.test(line));
    expect(attributes).toHaveLength(1);
    fs.writeFileSync(path.join(repo, '.gitattributes'), attributes.join('\n') + '\n');
    fs.mkdirSync(path.join(repo, 'data/url-first-seen'), { recursive: true });
    const shard = path.join(repo, 'data/url-first-seen/a.json');
    const write = (value: Record<string, string>) => fs.writeFileSync(shard, JSON.stringify(value, null, 2) + '\n');
    write({ '/base': '2026-01-01' });
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    git('checkout', '-q', '-b', 'side');
    write({ '/base': '2026-01-01', '/side': '2026-02-02', '/shared': '2026-03-03' });
    git('commit', '-q', '-am', 'side');
    git('checkout', '-q', 'main');
    write({ '/base': '2026-01-01', '/main': '2026-02-03', '/shared': '2026-01-20' });
    git('commit', '-q', '-am', 'main');
    git('merge', '-q', '--no-edit', 'side');
    expect(JSON.parse(fs.readFileSync(shard, 'utf8'))).toEqual({
      '/base': '2026-01-01',
      '/main': '2026-02-03',
      '/shared': '2026-01-20',
      '/side': '2026-02-02',
    });
  });

  it('the legacy single file keeps the driver too', () => {
    const attributes = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8');
    expect(attributes).toMatch(/^data\/url-first-seen\.json\s+merge=json-first-seen$/m);
  });
});
