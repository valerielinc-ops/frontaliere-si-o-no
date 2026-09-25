// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  JOB_STATS_HISTORY_LEGACY_FILE,
  JOB_STATS_HISTORY_SHARD_MAX_BYTES,
  readJobsStatsHistory,
  writeJobsStatsHistory,
} from '../scripts/lib/job-stats-history-store.mjs';
import { updateJobsStatsHistory } from '../scripts/lib/job-board-stats.mjs';

const SHARD_DIR = 'data/jobs-stats-history';

function shardSizes(root: string) {
  const dir = path.join(root, SHARD_DIR);
  return Object.fromEntries(
    fs.readdirSync(dir)
      .filter((name) => name !== 'manifest.json')
      .map((name) => [name, fs.statSync(path.join(dir, name)).size]),
  );
}

function readShard(root: string, name: string) {
  return JSON.parse(fs.readFileSync(path.join(root, SHARD_DIR, name), 'utf8'));
}

function withTempRoot(run: (root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-stats-history-'));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function entry(date: string, overrides: Record<string, unknown> = {}) {
  return {
    date,
    totalJobs: 10,
    added: 0,
    updated: 0,
    removed: 0,
    addedKeys: [],
    updatedKeys: [],
    removedKeys: [],
    companyStats: [],
    locationStats: [],
    titleStats: [],
    ...overrides,
  };
}

describe('job stats history store', () => {
  it('keeps the legacy monolith as a read fallback', () => {
    withTempRoot((root) => {
      const legacyPath = path.join(root, JOB_STATS_HISTORY_LEGACY_FILE);
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.writeFileSync(legacyPath, JSON.stringify({ version: 1, entries: [entry('2026-09-19')] }));

      expect(readJobsStatsHistory(root).entries.map((item) => item.date)).toEqual(['2026-09-19']);
    });
  });

  it('lets a monthly shard override the legacy copy for its dates', () => {
    withTempRoot((root) => {
      const legacyPath = path.join(root, JOB_STATS_HISTORY_LEGACY_FILE);
      const shardPath = path.join(root, 'data/jobs-stats-history/2026-09.json');
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      fs.mkdirSync(path.dirname(shardPath), { recursive: true });
      fs.writeFileSync(legacyPath, JSON.stringify({ entries: [entry('2026-09-20', { totalJobs: 10 })] }));
      fs.writeFileSync(shardPath, JSON.stringify({ entries: [entry('2026-09-20', { totalJobs: 12 })] }));

      expect(readJobsStatsHistory(root).entries).toEqual([entry('2026-09-20', { totalJobs: 12 })]);
    });
  });

  it('writes only the current daily shard and leaves the legacy blob byte-identical', () => {
    withTempRoot((root) => {
      const legacyPath = path.join(root, JOB_STATS_HISTORY_LEGACY_FILE);
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      const legacy = JSON.stringify({ version: 1, entries: [entry('2026-09-19')] });
      fs.writeFileSync(legacyPath, legacy);

      const result = writeJobsStatsHistory({ version: 1, entries: [
        entry('2026-09-19'),
        entry('2026-09-20', { added: 1, addedKeys: ['url:new'] }),
      ] }, root, { currentDate: '2026-09-20' });

      expect(result.date).toBe('2026-09-20');
      expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacy);
      expect(fs.readdirSync(path.join(root, SHARD_DIR)).sort()).toEqual(['2026-09-20.json', 'manifest.json']);
      expect(readShard(root, '2026-09-20.json').entries).toEqual([
        entry('2026-09-20', { added: 1, addedKeys: ['url:new'] }),
      ]);
      expect(readJobsStatsHistory(root).entries.map((item) => item.date)).toEqual(['2026-09-19', '2026-09-20']);
    });
  });

  it('rewrites a past day from the slimmed canonical history and keeps the current day verbatim', () => {
    withTempRoot((root) => {
      const pastPath = path.join(root, SHARD_DIR, '2026-09-19.json');
      fs.mkdirSync(path.dirname(pastPath), { recursive: true });
      fs.writeFileSync(pastPath, JSON.stringify({ entries: [entry('2026-09-19', {
        added: 1,
        updated: 2,
        addedKeys: ['url:old'],
        updatedKeys: ['url:u1', 'url:u2'],
      })] }));

      const slimmedPast = entry('2026-09-19', { added: 1, updated: 2, addedKeys: ['url:old'] });
      const today = entry('2026-09-20', { totalJobs: 13, updated: 1, updatedKeys: ['url:u3'] });
      writeJobsStatsHistory({ entries: [slimmedPast, today] }, root, { currentDate: '2026-09-20' });

      expect(readShard(root, '2026-09-19.json').entries).toEqual([slimmedPast]);
      expect(readShard(root, '2026-09-20.json').entries).toEqual([today]);
    });
  });

  it('migrates legacy monthly shards to compacted daily shards and prunes expired entries', () => {
    withTempRoot((root) => {
      const oldShardPath = path.join(root, 'data/jobs-stats-history/2026-07.json');
      const expiredShardPath = path.join(root, 'data/jobs-stats-history/2025-12.json');
      fs.mkdirSync(path.dirname(oldShardPath), { recursive: true });
      fs.writeFileSync(oldShardPath, JSON.stringify({ entries: [entry('2026-07-01', {
        updated: 1,
        updatedKeys: ['url:stale'],
        companyStats: [{ key: 'acme', updatedKeys: ['url:stale'] }],
      })] }));
      fs.writeFileSync(expiredShardPath, JSON.stringify({ entries: [entry('2025-12-01')] }));

      const compacted = entry('2026-07-01', { updated: 1 });
      writeJobsStatsHistory({ entries: [
        compacted,
        entry('2026-09-20', { totalJobs: 13 }),
      ] }, root, { currentDate: '2026-09-20' });

      // The legacy monthly shard is migrated into a compacted daily shard.
      expect(fs.existsSync(oldShardPath)).toBe(false);
      expect(readShard(root, '2026-07-01.json').entries).toEqual([compacted]);
      expect(fs.existsSync(expiredShardPath)).toBe(false);
      expect(readShard(root, 'manifest.json')).toMatchObject({
        format: 'daily-entry-shards',
        days: ['2026-07-01', '2026-09-20'],
      });
    });
  });

  it('reads legacy monolith, legacy monthly shards and daily shards together', () => {
    withTempRoot((root) => {
      const legacyPath = path.join(root, JOB_STATS_HISTORY_LEGACY_FILE);
      fs.mkdirSync(path.join(root, SHARD_DIR), { recursive: true });
      fs.writeFileSync(legacyPath, JSON.stringify({ entries: [entry('2026-08-30'), entry('2026-09-01', { totalJobs: 1 })] }));
      fs.writeFileSync(path.join(root, SHARD_DIR, '2026-09.json'), JSON.stringify({ entries: [
        entry('2026-09-01', { totalJobs: 11 }),
        entry('2026-09-02', { added: 1, addedKeys: ['url:monthly'] }),
      ] }));
      fs.writeFileSync(path.join(root, SHARD_DIR, '2026-09-02.json'), JSON.stringify({ entries: [
        entry('2026-09-02', { added: 1, addedKeys: ['url:daily'] }),
      ] }));
      fs.writeFileSync(path.join(root, SHARD_DIR, '2026-09-03.json'), JSON.stringify({ entries: [entry('2026-09-03', { totalJobs: 12 })] }));

      const entries = readJobsStatsHistory(root).entries;
      expect(entries.map((item) => item.date)).toEqual(['2026-08-30', '2026-09-01', '2026-09-02', '2026-09-03']);
      expect(entries[1].totalJobs).toBe(11);
      // A date present in both a monthly and a daily shard is merged monotonically.
      expect(entries[2]).toMatchObject({ added: 2, addedKeys: ['url:daily', 'url:monthly'] });
    });
  });

  it('keeps every shard under the push guard across a full month of realistic days (#9654)', () => {
    // Production shape, scaled down: ~25k updated jobs/day made a verbose day
    // ~20 MB against a 90 MB guard (ratio 4.5). Here a day is ~1/15 of that
    // and the guard keeps the same ratio to the verbose day size.
    const GUARD_TO_VERBOSE_DAY = 4.5;
    const UPDATED_PER_DAY = 1000;
    const ADDED_PER_DAY = 120;
    const REMOVED_PER_DAY = 90;
    const job = (id: string) => {
      const n = Number(id.replace(/\D/g, '')) || 0;
      return {
        url: `https://careers.example-employer-${n % 400}.ch/jobs/offerta-lavoro-posizione-${id}-full-time-100`,
        company: `Employer ${n % 400}`,
        location: `Localita ${n % 150}`,
        title: `Titolo professionale ${n % 1200}`,
      };
    };
    withTempRoot((root) => {
      let verboseDayBytes = 0;
      let history: Record<string, unknown> = { entries: [] };
      for (let day = 1; day <= 30; day += 1) {
        const date = `2026-09-${String(day).padStart(2, '0')}`;
        const diff = {
          updatedJobs: Array.from({ length: UPDATED_PER_DAY }, (_, i) => job(`u${(day * 997 + i) % 20000}`)),
          addedJobs: Array.from({ length: ADDED_PER_DAY }, (_, i) => job(`a${day * 1000 + i}`)),
          removedJobs: Array.from({ length: REMOVED_PER_DAY }, (_, i) => job(`r${day * 1000 + i}`)),
        };
        history = updateJobsStatsHistory(readJobsStatsHistory(root), diff, new Array(20000).fill({}), {
          now: `${date}T10:00:00.000Z`,
        });
        const current = (history.entries as Array<{ date: string }>).find((item) => item.date === date);
        verboseDayBytes = Math.max(
          verboseDayBytes,
          Buffer.byteLength(JSON.stringify({ entries: [current] }, null, 2)),
        );
        writeJobsStatsHistory(history, root, {
          currentDate: date,
          maxShardBytes: Math.floor(verboseDayBytes * GUARD_TO_VERBOSE_DAY),
        });
      }

      const guard = Math.floor(verboseDayBytes * GUARD_TO_VERBOSE_DAY);
      const sizes = shardSizes(root);
      const total = Object.values(sizes).reduce((sum, size) => sum + size, 0);
      // The month as a whole does not fit under the guard: a monthly shard cannot work.
      expect(total).toBeGreaterThan(guard);
      for (const [name, size] of Object.entries(sizes)) {
        expect({ name, underGuard: size <= guard }).toEqual({ name, underGuard: true });
      }
      expect(Object.keys(sizes)).toHaveLength(30);

      const entries = readJobsStatsHistory(root).entries;
      expect(entries).toHaveLength(30);
      for (const item of entries) {
        expect(item).toMatchObject({ added: ADDED_PER_DAY, updated: UPDATED_PER_DAY, removed: REMOVED_PER_DAY });
        expect(item.addedKeys).toHaveLength(ADDED_PER_DAY);
      }
    });
  }, 60_000);

  it('refuses to write a shard above the guard and leaves the store untouched', () => {
    withTempRoot((root) => {
      const pastPath = path.join(root, SHARD_DIR, '2026-09-19.json');
      fs.mkdirSync(path.dirname(pastPath), { recursive: true });
      const before = JSON.stringify({ entries: [entry('2026-09-19')] });
      fs.writeFileSync(pastPath, before);

      const huge = entry('2026-09-20', {
        updated: 5000,
        updatedKeys: Array.from({ length: 5000 }, (_, i) => `url:https://example.ch/job/${i}`),
      });
      expect(() => writeJobsStatsHistory({ entries: [entry('2026-09-19'), huge] }, root, {
        currentDate: '2026-09-20',
        maxShardBytes: 10_000,
      })).toThrow(/2026-09-20\.json would be .* MB, above the .* MB guard/);
      expect(fs.readFileSync(pastPath, 'utf8')).toBe(before);
      expect(fs.existsSync(path.join(root, SHARD_DIR, '2026-09-20.json'))).toBe(false);
      expect(JOB_STATS_HISTORY_SHARD_MAX_BYTES).toBeLessThan(100 * 1024 * 1024);
    });
  });

  it('refuses a catastrophic rewrite of an existing accumulator shard', () => {
    withTempRoot((root) => {
      const shardPath = path.join(root, SHARD_DIR, '2026-09-20.json');
      fs.mkdirSync(path.dirname(shardPath), { recursive: true });
      const existing = entry('2026-09-20', {
        updated: 30_000,
        updatedKeys: Array.from({ length: 30_000 }, (_, i) => `url:https://example.ch/job/${i}`),
      });
      const before = JSON.stringify({ entries: [existing] }, null, 2) + '\n';
      fs.writeFileSync(shardPath, before);

      expect(() => writeJobsStatsHistory({ entries: [entry('2026-09-20')] }, root, {
        currentDate: '2026-09-20',
      })).toThrow(/ABORT write.*2026-09-20\.json/);
      expect(fs.readFileSync(shardPath, 'utf8')).toBe(before);
    });
  });

  it('refuses to migrate a large shard whose raw entries have no valid dates', () => {
    withTempRoot((root) => {
      const shardPath = path.join(root, SHARD_DIR, '2026-09-19.json');
      fs.mkdirSync(path.dirname(shardPath), { recursive: true });
      const before = JSON.stringify({
        entries: [{ date: 'invalid', payload: 'preserve'.repeat(180_000) }],
      }, null, 2) + '\n';
      fs.writeFileSync(shardPath, before);

      expect(() => writeJobsStatsHistory({ entries: [entry('2026-09-20')] }, root, {
        currentDate: '2026-09-20',
      })).toThrow(/no valid dates.*2026-09-19\.json/);
      expect(fs.readFileSync(shardPath, 'utf8')).toBe(before);
      expect(fs.existsSync(path.join(root, SHARD_DIR, '2026-09-20.json'))).toBe(false);
    });
  });

  it('allows the intentional compaction of a verbose past-day shard', () => {
    withTempRoot((root) => {
      const shardPath = path.join(root, SHARD_DIR, '2026-09-19.json');
      fs.mkdirSync(path.dirname(shardPath), { recursive: true });
      const verbose = entry('2026-09-19', {
        updated: 30_000,
        updatedKeys: Array.from({ length: 30_000 }, (_, i) => `url:https://example.ch/job/${i}`),
      });
      fs.writeFileSync(shardPath, JSON.stringify({ entries: [verbose] }, null, 2) + '\n');
      const compacted = entry('2026-09-19', { updated: 30_000 });

      writeJobsStatsHistory({ entries: [compacted, entry('2026-09-20')] }, root, {
        currentDate: '2026-09-20',
      });

      expect(readShard(root, '2026-09-19.json').entries).toEqual([compacted]);
    });
  });

  it('allows a historical title-locale rewrite when counters are preserved', () => {
    withTempRoot((root) => {
      const shardPath = path.join(root, SHARD_DIR, '2026-09-19.json');
      fs.mkdirSync(path.dirname(shardPath), { recursive: true });
      const verbose = entry('2026-09-19', {
        added: 1,
        updated: 30_000,
        removed: 2,
        addedKeys: ['url:added'],
        titleStats: Array.from({ length: 30_000 }, (_, i) => ({
          key: `raw-title-${i}`,
          name: `Raw title ${i}`,
          addedKeys: ['url:added'],
        })),
      });
      fs.writeFileSync(shardPath, JSON.stringify({ entries: [verbose] }, null, 2) + '\n');
      const migrated = entry('2026-09-19', {
        added: 1,
        updated: 30_000,
        removed: 2,
        addedKeys: ['url:added'],
        titleStats: [{ key: 'titolo-locale', name: 'Titolo locale', addedKeys: ['url:added'] }],
      });

      writeJobsStatsHistory({ entries: [migrated, entry('2026-09-20')] }, root, {
        currentDate: '2026-09-20',
      });

      expect(readShard(root, '2026-09-19.json').entries).toEqual([migrated]);
    });
  });

  it('refuses a controlled rewrite that drops existing added keys and bucket payload', () => {
    withTempRoot((root) => {
      const shardPath = path.join(root, SHARD_DIR, '2026-09-19.json');
      fs.mkdirSync(path.dirname(shardPath), { recursive: true });
      const bucketItems = (prefix: string) => Array.from({ length: 12_000 }, (_, i) => ({
        key: `${prefix}-${i}`,
        name: `${prefix} bucket ${i}`,
        addedKeys: [`url:${prefix}-${i}`],
      }));
      const existing = entry('2026-09-19', {
        added: 1,
        updated: 2,
        removed: 3,
        addedKeys: ['url:preserve'],
        companyStats: bucketItems('company'),
        locationStats: bucketItems('location'),
        titleStats: bucketItems('title'),
      });
      const before = JSON.stringify({ entries: [existing] }, null, 2) + '\n';
      expect(Buffer.byteLength(before)).toBeGreaterThan(2 * 1024 * 1024);
      fs.writeFileSync(shardPath, before);

      const replacement = entry('2026-09-19', {
        added: 1,
        updated: 2,
        removed: 3,
      });
      expect(() => writeJobsStatsHistory({ entries: [replacement, entry('2026-09-20')] }, root, {
        currentDate: '2026-09-20',
      })).toThrow(/ABORT write.*2026-09-19\.json/);
      expect(fs.readFileSync(shardPath, 'utf8')).toBe(before);
      expect(fs.existsSync(path.join(root, SHARD_DIR, '2026-09-20.json'))).toBe(false);
    });
  });

  it('refuses to delete a large shard whose date disappeared from canonical history', () => {
    withTempRoot((root) => {
      const shardPath = path.join(root, SHARD_DIR, '2026-09-19.json');
      fs.mkdirSync(path.dirname(shardPath), { recursive: true });
      const existing = entry('2026-09-19', {
        updated: 30_000,
        updatedKeys: Array.from({ length: 30_000 }, (_, i) => `url:https://example.ch/job/${i}`),
      });
      const before = JSON.stringify({ entries: [existing] }, null, 2) + '\n';
      fs.writeFileSync(shardPath, before);

      expect(() => writeJobsStatsHistory({ entries: [entry('2026-09-20')] }, root, {
        currentDate: '2026-09-20',
      })).toThrow(/ABORT write.*2026-09-19\.json/);
      expect(fs.readFileSync(shardPath, 'utf8')).toBe(before);
    });
  });

  it('merges concurrent shard rewrites by date and action key', () => {
    withTempRoot((root) => {
      const basePath = path.join(root, 'base.json');
      const oursPath = path.join(root, 'ours.json');
      const theirsPath = path.join(root, 'theirs.json');
      const base = { entries: [entry('2026-09-19', { added: 1, addedKeys: ['url:base'] })] };
      const ours = { entries: [entry('2026-09-19', { added: 2, addedKeys: ['url:base', 'url:ours'] })] };
      const theirs = { entries: [entry('2026-09-19', { added: 2, addedKeys: ['url:base', 'url:theirs'] })] };
      for (const [file, value] of [[basePath, base], [oursPath, ours], [theirsPath, theirs]] as const) {
        fs.writeFileSync(file, JSON.stringify(value));
      }

      const driver = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '../scripts/ci/merge-job-stats-history-shard.mjs',
      );
      const result = spawnSync(process.execPath, [driver, basePath, oursPath, theirsPath], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(oursPath, 'utf8')).entries[0]).toMatchObject({
        added: 3,
        addedKeys: ['url:base', 'url:ours', 'url:theirs'],
      });
    });
  });
});
