// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ACCUMULATOR_MAX_STAGE_BYTES,
  ACCUMULATOR_WARN_BYTES,
  DIST_SIZE_HISTORY_FILE,
  GITHUB_FILE_LIMIT_BYTES,
  annotationsFor,
  isAllowedDistHistoryPath,
  partitionAccumulatorsBySize,
} from '../scripts/ci/dist-history-accumulators.mjs';
import {
  URL_FIRST_SEEN_DIR,
  URL_FIRST_SEEN_LEGACY_FILE,
  urlFirstSeenShardRelPath,
} from '../scripts/lib/url-first-seen-store.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/ci/dist-history-accumulators.mjs');
const MIB = 1024 * 1024;

const created: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-history-acc-'));
  created.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('limits', () => {
  it('stages nothing over 95 MiB, 5 MiB under the 100 MiB GitHub rejects; warns from 50 MiB', () => {
    expect(GITHUB_FILE_LIMIT_BYTES).toBe(100 * MIB);
    expect(ACCUMULATOR_MAX_STAGE_BYTES).toBe(95 * MIB);
    expect(ACCUMULATOR_WARN_BYTES).toBe(50 * MIB);
    expect(ACCUMULATOR_MAX_STAGE_BYTES).toBeLessThan(GITHUB_FILE_LIMIT_BYTES);
    expect(ACCUMULATOR_WARN_BYTES).toBeLessThan(ACCUMULATOR_MAX_STAGE_BYTES);
  });

  it('the run that failed (213.54 MB) is far over the limit', () => {
    expect(Math.round(223_911_614 / MIB * 100) / 100).toBe(213.54);
    expect(223_911_614).toBeGreaterThan(ACCUMULATOR_MAX_STAGE_BYTES);
  });
});

describe('partitionAccumulatorsBySize', () => {
  it('skips an oversized accumulator and keeps the others (the dist-size-history row must survive)', () => {
    const result = partitionAccumulatorsBySize([
      { path: DIST_SIZE_HISTORY_FILE, bytes: 42 * MIB },
      { path: urlFirstSeenShardRelPath('a'), bytes: 14 * MIB },
      { path: urlFirstSeenShardRelPath('b'), bytes: 213 * MIB },
      { path: urlFirstSeenShardRelPath('c'), bytes: null },
    ]);
    expect(result.stage).toEqual([DIST_SIZE_HISTORY_FILE, urlFirstSeenShardRelPath('a')]);
    expect(result.skipped).toEqual([{ path: urlFirstSeenShardRelPath('b'), bytes: 213 * MIB }]);
    expect(result.warned).toEqual([]);
  });

  it('is inclusive at the limit and warns above the pre-alarm without skipping', () => {
    const result = partitionAccumulatorsBySize([
      { path: 'data/dist-size-history.jsonl', bytes: ACCUMULATOR_MAX_STAGE_BYTES },
      { path: urlFirstSeenShardRelPath('a'), bytes: ACCUMULATOR_MAX_STAGE_BYTES + 1 },
      { path: urlFirstSeenShardRelPath('b'), bytes: ACCUMULATOR_WARN_BYTES + 1 },
      { path: urlFirstSeenShardRelPath('c'), bytes: ACCUMULATOR_WARN_BYTES },
    ]);
    expect(result.stage).toEqual([
      'data/dist-size-history.jsonl',
      urlFirstSeenShardRelPath('b'),
      urlFirstSeenShardRelPath('c'),
    ]);
    expect(result.skipped.map((s: { path: string }) => s.path)).toEqual([urlFirstSeenShardRelPath('a')]);
    // 95 MiB exactly is staged but past the pre-alarm; 50 MiB exactly is not.
    expect(result.warned.map((s: { path: string }) => s.path)).toEqual([
      'data/dist-size-history.jsonl',
      urlFirstSeenShardRelPath('b'),
    ]);
  });

  it('emits the exact error annotation the incident called for', () => {
    const lines = annotationsFor({
      skipped: [{ path: 'data/url-first-seen/a.json', bytes: 223_911_614 }],
      warned: [{ path: 'data/dist-size-history.jsonl', bytes: 60 * MIB }],
    });
    expect(lines[0]).toMatch(/^::warning title=dist-history accumulator approaching GitHub file limit::data\/dist-size-history\.jsonl 62914560 bytes/);
    expect(lines[1]).toMatch(/^::error title=dist-history accumulator over GitHub file limit::data\/url-first-seen\/a\.json 223911614 bytes/);
    expect(lines[1]).toContain('NOT staged');
  });
});

describe('allowlist', () => {
  it('admits the history file and the shards, nothing else', () => {
    expect(isAllowedDistHistoryPath(DIST_SIZE_HISTORY_FILE)).toBe(true);
    expect(isAllowedDistHistoryPath(urlFirstSeenShardRelPath('f'))).toBe(true);
    // the job never touches the legacy single file
    expect(isAllowedDistHistoryPath(URL_FIRST_SEEN_LEGACY_FILE)).toBe(false);
    expect(isAllowedDistHistoryPath(`${URL_FIRST_SEEN_DIR}/readme.md`)).toBe(false);
    expect(isAllowedDistHistoryPath('data/jobs.json')).toBe(false);
    expect(isAllowedDistHistoryPath('../data/dist-size-history.jsonl')).toBe(false);
  });
});

describe('CLI', () => {
  function run(cwd: string, args: string[], input?: string) {
    return spawnSync('node', [SCRIPT, ...args], { cwd, input, encoding: 'utf8' });
  }

  it('guard: writes the stageable list, annotates the oversized one, exits 3', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, URL_FIRST_SEEN_DIR), { recursive: true });
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, DIST_SIZE_HISTORY_FILE), '{"row":1}\n');
    fs.writeFileSync(path.join(dir, urlFirstSeenShardRelPath('0')), '{}\n');
    // sparse file: 96 MiB apparent size, no real disk use
    const big = path.join(dir, urlFirstSeenShardRelPath('1'));
    fs.closeSync(fs.openSync(big, 'w'));
    fs.truncateSync(big, 96 * MIB);
    const selected = path.join(dir, 'selected.txt');
    const result = run(dir, [
      'guard', '--selected', selected,
      DIST_SIZE_HISTORY_FILE, urlFirstSeenShardRelPath('0'), urlFirstSeenShardRelPath('1'), urlFirstSeenShardRelPath('2'),
    ]);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain(`::error title=dist-history accumulator over GitHub file limit::${urlFirstSeenShardRelPath('1')} ${96 * MIB} bytes`);
    expect(fs.readFileSync(selected, 'utf8').split('\n').filter(Boolean)).toEqual([
      DIST_SIZE_HISTORY_FILE,
      urlFirstSeenShardRelPath('0'),
    ]);
  });

  it('guard: exits 0 when everything is within limits', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, DIST_SIZE_HISTORY_FILE), 'row\n');
    const selected = path.join(dir, 'selected.txt');
    const result = run(dir, ['guard', '--selected', selected, DIST_SIZE_HISTORY_FILE]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain('::error');
  });

  it('guard: refuses a candidate outside the allowlist (exit 2, nothing selected)', () => {
    const dir = tempDir();
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data/jobs.json'), '[]');
    const selected = path.join(dir, 'selected.txt');
    const result = run(dir, ['guard', '--selected', selected, 'data/jobs.json']);
    expect(result.status).toBe(2);
    expect(fs.existsSync(selected)).toBe(false);
  });

  it('unexpected: lists staged paths outside the allowlist and exits 1', () => {
    const dir = tempDir();
    const ok = run(dir, ['unexpected'], `${DIST_SIZE_HISTORY_FILE}\n${urlFirstSeenShardRelPath('a')}\n`);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe('');
    const bad = run(dir, ['unexpected'], `${DIST_SIZE_HISTORY_FILE}\n${URL_FIRST_SEEN_LEGACY_FILE}\ndata/other.json\n`);
    expect(bad.status).toBe(1);
    expect(bad.stdout.split('\n').filter(Boolean)).toEqual([URL_FIRST_SEEN_LEGACY_FILE, 'data/other.json']);
  });
});
