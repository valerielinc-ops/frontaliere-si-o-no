// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  JOB_STATS_HISTORY_LEGACY_FILE,
  readJobsStatsHistory,
  writeJobsStatsHistory,
} from '../scripts/lib/job-stats-history-store.mjs';

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

  it('writes only the current monthly shard and leaves the legacy blob byte-identical', () => {
    withTempRoot((root) => {
      const legacyPath = path.join(root, JOB_STATS_HISTORY_LEGACY_FILE);
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      const legacy = JSON.stringify({ version: 1, entries: [entry('2026-09-19')] });
      fs.writeFileSync(legacyPath, legacy);

      const result = writeJobsStatsHistory({ version: 1, entries: [
        entry('2026-09-19'),
        entry('2026-09-20', { added: 1, addedKeys: ['url:new'] }),
      ] }, root, { currentDate: '2026-09-20' });

      expect(result.month).toBe('2026-09');
      expect(fs.readFileSync(legacyPath, 'utf8')).toBe(legacy);
      expect(fs.readdirSync(path.join(root, 'data/jobs-stats-history')).sort()).toEqual(['2026-09.json', 'manifest.json']);
      expect(JSON.parse(fs.readFileSync(path.join(root, 'data/jobs-stats-history/2026-09.json'), 'utf8')).entries).toEqual([
        entry('2026-09-20', { added: 1, addedKeys: ['url:new'] }),
      ]);
      expect(readJobsStatsHistory(root).entries.map((item) => item.date)).toEqual(['2026-09-19', '2026-09-20']);
    });
  });

  it('preserves existing days in a shard while replacing the current day', () => {
    withTempRoot((root) => {
      const shardPath = path.join(root, 'data/jobs-stats-history/2026-09.json');
      fs.mkdirSync(path.dirname(shardPath), { recursive: true });
      fs.writeFileSync(shardPath, JSON.stringify({ entries: [entry('2026-09-19', { added: 2, addedKeys: ['url:old'] })] }));

      writeJobsStatsHistory({ entries: [
        entry('2026-09-19', { added: 99, addedKeys: ['url:should-not-replace-old-day'] }),
        entry('2026-09-20', { totalJobs: 13 }),
      ] }, root, { currentDate: '2026-09-20' });

      expect(JSON.parse(fs.readFileSync(shardPath, 'utf8')).entries).toEqual([
        entry('2026-09-19', { added: 2, addedKeys: ['url:old'] }),
        entry('2026-09-20', { totalJobs: 13 }),
      ]);
    });
  });

  it('reconciles existing shards with compacted history and prunes expired entries', () => {
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

      expect(JSON.parse(fs.readFileSync(oldShardPath, 'utf8')).entries).toEqual([compacted]);
      expect(fs.existsSync(expiredShardPath)).toBe(false);
      expect(JSON.parse(fs.readFileSync(path.join(root, 'data/jobs-stats-history/manifest.json'), 'utf8')).months)
        .toEqual(['2026-07', '2026-09']);
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
