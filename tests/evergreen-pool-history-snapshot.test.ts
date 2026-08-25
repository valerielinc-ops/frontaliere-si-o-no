/**
 * OSSERVATORE for #6446: evergreen-pool-history-snapshot.mjs must persist an
 * append-only, dated history of `evergreen-pool-consumption.mjs --json`
 * output so a consumption RATE becomes computable (needs ≥2 points; parent
 * #6019 item 2b).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'evergreen-pool-history-snapshot.mjs');

const tmpDirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'evergreen-pool-history-'));
  tmpDirs.push(dir);
  return dir;
}

function writeJson(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

function readHistory(path: string) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const SAMPLE_POOL = [
  { section: 'frontaliere', poolTotal: 734, poolRemaining: 560, poolConsumed: 174, poolConsumedPct: 23.7 },
  { section: 'svizzera', poolTotal: 110, poolRemaining: 92, poolConsumed: 18, poolConsumedPct: 16.4 },
];

describe('scripts/evergreen-pool-history-snapshot.mjs', () => {
  it('creates a fresh history file with one entry per section on the first run', () => {
    const dir = makeDir();
    const inFile = join(dir, 'pool.json');
    const historyFile = join(dir, 'evergreen-pool-history.json');
    writeJson(inFile, SAMPLE_POOL);

    execFileSync('node', [SCRIPT, `--in=${inFile}`, `--history=${historyFile}`]);

    const history = readHistory(historyFile);
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0].sections).toEqual([
      { section: 'frontaliere', poolTotal: 734, poolRemaining: 560, poolConsumedPct: 23.7 },
      { section: 'svizzera', poolTotal: 110, poolRemaining: 92, poolConsumedPct: 16.4 },
    ]);
  });

  it('is append-only across dated entries and dedupes same-day re-runs (last write wins)', () => {
    const dir = makeDir();
    const inFile = join(dir, 'pool.json');
    const historyFile = join(dir, 'evergreen-pool-history.json');

    writeJson(historyFile, {
      updatedAt: '2026-08-10T00:00:00.000Z',
      entries: [
        { date: '2026-08-10', sections: [{ section: 'frontaliere', poolTotal: 734, poolRemaining: 600, poolConsumedPct: 18.3 }] },
      ],
    });
    writeJson(inFile, [{ section: 'frontaliere', poolTotal: 734, poolRemaining: 560, poolConsumed: 174, poolConsumedPct: 23.7 }]);

    execFileSync('node', [SCRIPT, `--in=${inFile}`, `--history=${historyFile}`]);

    const history = readHistory(historyFile);
    // Prior dated entry preserved (append-only)...
    expect(history.entries).toHaveLength(2);
    expect(history.entries[0].date).toBe('2026-08-10');
    // ...same-day re-run replaces, not duplicates.
    execFileSync('node', [SCRIPT, `--in=${inFile}`, `--history=${historyFile}`]);
    const historyAfterRerun = readHistory(historyFile);
    const todayEntries = historyAfterRerun.entries.filter((e: any) => e.date === historyAfterRerun.entries[historyAfterRerun.entries.length - 1].date);
    expect(todayEntries).toHaveLength(1);
  });

  it('caps history to --max-entries, dropping the oldest first', () => {
    const dir = makeDir();
    const inFile = join(dir, 'pool.json');
    const historyFile = join(dir, 'evergreen-pool-history.json');

    writeJson(historyFile, {
      updatedAt: '2026-08-01T00:00:00.000Z',
      entries: Array.from({ length: 5 }, (_, i) => ({
        date: `2026-07-2${i}`,
        sections: [{ section: 'frontaliere', poolTotal: 734, poolRemaining: 700 - i, poolConsumedPct: i }],
      })),
    });
    writeJson(inFile, SAMPLE_POOL);

    execFileSync('node', [SCRIPT, `--in=${inFile}`, `--history=${historyFile}`, '--max-entries=3']);

    const history = readHistory(historyFile);
    expect(history.entries).toHaveLength(3);
    expect(history.entries[0].date).toBe('2026-07-23');
  });

  it('renders a markdown summary with the per-section rate vs the previous entry', () => {
    const dir = makeDir();
    const inFile = join(dir, 'pool.json');
    const historyFile = join(dir, 'evergreen-pool-history.json');
    const summaryFile = join(dir, 'summary.md');

    writeJson(historyFile, {
      updatedAt: '2026-08-10T00:00:00.000Z',
      entries: [
        { date: '2026-08-10', sections: [{ section: 'frontaliere', poolTotal: 734, poolRemaining: 570, poolConsumedPct: 22.3 }] },
      ],
    });
    writeJson(inFile, [{ section: 'frontaliere', poolTotal: 734, poolRemaining: 560, poolConsumed: 174, poolConsumedPct: 23.7 }]);

    execFileSync('node', [SCRIPT, `--in=${inFile}`, `--history=${historyFile}`, `--summary-out=${summaryFile}`]);

    const summary = readFileSync(summaryFile, 'utf8');
    expect(summary).toContain('frontaliere');
    expect(summary).toContain('Consumed since 2026-08-10');
    expect(summary).toContain('10'); // 570 - 560
  });

  it('exits with code 2 when --in is missing or unreadable', () => {
    const dir = makeDir();
    const historyFile = join(dir, 'evergreen-pool-history.json');
    expect(() =>
      execFileSync('node', [SCRIPT, `--in=${join(dir, 'missing.json')}`, `--history=${historyFile}`]),
    ).toThrow();
  });
});
