// @vitest-environment node
/**
 * Last boundary of the history backfill: whatever step loses a served route,
 * the archive on disk stays as it was.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { processSlice } from '../scripts/backfill-expired-from-history.mjs';

// A defective collapse: it silently discards an already-served record.
vi.mock('../scripts/lib/expired-jobs-archive.mjs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    collapseDuplicateRouteEntries: (entries: Array<{ slug: string }>) => ({
      entries: entries.filter((entry) => entry.slug !== 'posting-2'),
    }),
  };
});

describe('history backfill: route-loss refusal', () => {
  it('leaves the archive untouched and names the routes at stake', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'backfill-expired-guard-'));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const git = (args: string[]) => execFileSync('git', args, {
        cwd: root,
        env: {
          PATH: process.env.PATH || '/usr/bin:/bin',
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_AUTHOR_NAME: 'test',
          GIT_AUTHOR_EMAIL: 'test@example.invalid',
          GIT_COMMITTER_NAME: 'test',
          GIT_COMMITTER_EMAIL: 'test@example.invalid',
        },
      });
      const activePath = path.join(root, 'data', 'jobs', 'by-crawler', 'acme.json');
      const expiredPath = path.join(root, 'data', 'jobs', 'expired', 'by-crawler', 'acme.json');
      mkdirSync(path.dirname(activePath), { recursive: true });
      mkdirSync(path.dirname(expiredPath), { recursive: true });
      git(['init', '-q', '-b', 'main']);
      const day = 24 * 60 * 60 * 1000;
      const archive = `${JSON.stringify([1, 2].map((n) => ({
        slug: `posting-${n}`,
        title: `Posting ${n}`,
        companyKey: 'acme',
        expiredAt: new Date(Date.now() - n * day).toISOString(),
      })), null, 2)}\n`;
      writeFileSync(expiredPath, archive);
      writeFileSync(activePath, `${JSON.stringify([{
        id: 'acme-3',
        slug: 'posting-3',
        title: 'Posting 3',
        companyKey: 'acme',
        url: 'https://jobs.example.invalid/vacancy/3',
        crawledAt: new Date(Date.now() - 3 * day).toISOString(),
      }])}\n`);
      git(['add', '-A']);
      git(['commit', '-qm', 'seen']);
      writeFileSync(activePath, '[]\n');
      git(['commit', '-qam', 'dropped']);

      const result = processSlice('acme.json', { rootDir: root });

      expect(result?.refusedRoutes).toBeGreaterThan(0);
      expect(readFileSync(expiredPath, 'utf8')).toBe(archive);
      expect(errors.mock.calls.flat().join('\n')).toContain('refusing to write the archive');
    } finally {
      vi.restoreAllMocks();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
