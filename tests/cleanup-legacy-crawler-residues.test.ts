import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  LEGACY_CRAWLER_RESIDUE_PATHS,
  purgeLegacyCrawlerResidues,
} from '../scripts/cleanup-legacy-crawler-residues.mjs';

const roots: string[] = [];

function fixtureDir(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-crawler-residues-'));
  roots.push(root);
  return root;
}

function proofOptions(root: string) {
  return {
    proofDir: path.join(root, 'proofs'),
    cwd: root,
    baseSha: 'cleanup-base-sha',
    env: { GITHUB_RUN_ID: 'cleanup-run', GITHUB_RUN_ATTEMPT: '1' },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('purgeLegacyCrawlerResidues', () => {
  it('is dry-run by default and removes only the allowlisted archive on apply', () => {
    const expiredDir = fixtureDir();
    const scratch = path.join(expiredDir, 'coop-ticino-locale-cache.json');
    const unrelated = path.join(expiredDir, 'coop-ticino.json');
    fs.writeFileSync(scratch, JSON.stringify([{ companyKey: 'coop-ticino', slug: 'legacy' }]));
    fs.writeFileSync(unrelated, '[]');

    const dryRun = purgeLegacyCrawlerResidues({ expiredDir });
    expect(dryRun.filesScanned).toBe(1);
    expect(dryRun.wouldRemove).toEqual([scratch]);
    expect(fs.existsSync(scratch)).toBe(true);

    const applied = purgeLegacyCrawlerResidues({
      expiredDir,
      apply: true,
      ...proofOptions(expiredDir),
    });
    expect(applied.filesRemoved).toEqual([scratch]);
    expect(fs.existsSync(scratch)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
    const proof = JSON.parse(fs.readFileSync(path.join(
      expiredDir,
      'proofs/data/jobs/expired/by-crawler/coop-ticino-locale-cache.json.housekeeping-proof.json',
    ), 'utf8'));
    expect(proof).toMatchObject({
      path: 'data/jobs/expired/by-crawler/coop-ticino-locale-cache.json',
      baseSha: 'cleanup-base-sha',
      runId: 'cleanup-run',
      entries: [{
        operation: 'retired-scratch-archive-delete',
        companyKey: 'coop-ticino',
        entryCount: 1,
      }],
    });
  });

  it('fails closed when the allowlisted path contains another company', () => {
    const expiredDir = fixtureDir();
    const scratch = path.join(expiredDir, 'coop-ticino-locale-cache.json');
    fs.writeFileSync(scratch, JSON.stringify([{ companyKey: 'other-company', slug: 'unexpected' }]));

    expect(() => purgeLegacyCrawlerResidues({
      expiredDir,
      apply: true,
      ...proofOptions(expiredDir),
    })).toThrow(/non-coop-ticino entry/);
    expect(fs.existsSync(scratch)).toBe(true);
  });

  // #9142 residue 3: after #11295 nothing writes the active-side Coop
  // translation cache any more, but the tracked `[]` sentinel stayed in
  // data/jobs/by-crawler with no owner that would ever remove it.
  it('removes the ownerless active-side Coop sentinel only while it is an empty array', () => {
    const root = fixtureDir();
    const expiredDir = path.join(root, 'expired');
    const activeDir = path.join(root, 'active');
    fs.mkdirSync(expiredDir);
    fs.mkdirSync(activeDir);
    const sentinel = path.join(activeDir, 'coop-ticino-locale-cache.json');
    const slice = path.join(activeDir, 'coop-ticino.json');
    fs.writeFileSync(sentinel, '[]\n');
    fs.writeFileSync(slice, '[]\n');

    const dryRun = purgeLegacyCrawlerResidues({ expiredDir, activeDir });
    expect(dryRun.wouldRemove).toEqual([sentinel]);
    expect(fs.existsSync(sentinel)).toBe(true);

    const applied = purgeLegacyCrawlerResidues({
      expiredDir,
      activeDir,
      apply: true,
      ...proofOptions(root),
    });
    expect(applied.filesRemoved).toEqual([sentinel]);
    expect(applied.filesKept).toEqual([]);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(fs.existsSync(slice)).toBe(true);
    // A 3-byte sentinel is below the accumulator floor: no proof is needed,
    // and none is written that could later be mistaken for a slice proof.
    expect(fs.existsSync(path.join(root, 'proofs'))).toBe(false);

    const again = purgeLegacyCrawlerResidues({ expiredDir, activeDir, apply: true, ...proofOptions(root) });
    expect(again.filesRemoved).toEqual([]);
  });

  it('keeps a non-empty or malformed active-side sentinel instead of deleting data', () => {
    for (const content of [
      JSON.stringify([{ companyKey: 'coop-ticino', slug: 'unexpected-writer' }]),
      '{}',
      'not json',
    ]) {
      const root = fixtureDir();
      const expiredDir = path.join(root, 'expired');
      const activeDir = path.join(root, 'active');
      fs.mkdirSync(expiredDir);
      fs.mkdirSync(activeDir);
      const sentinel = path.join(activeDir, 'coop-ticino-locale-cache.json');
      fs.writeFileSync(sentinel, content);

      const applied = purgeLegacyCrawlerResidues({
        expiredDir,
        activeDir,
        apply: true,
        ...proofOptions(root),
      });
      expect(applied.filesRemoved).toEqual([]);
      expect(applied.filesKept).toEqual([sentinel]);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe(content);
    }
  });

  it('never scans the real repository data when a caller redirects only the archive directory', () => {
    const expiredDir = fixtureDir();
    const report = purgeLegacyCrawlerResidues({ expiredDir });
    expect(report.filesScanned).toBe(0);
    expect(report.wouldRemove).toEqual([]);
  });

  it('exposes every allowlisted residue as a repository path for the commit step', () => {
    expect(LEGACY_CRAWLER_RESIDUE_PATHS).toEqual(expect.arrayContaining([
      'data/jobs/expired/by-crawler/coop-ticino-locale-cache.json',
      'data/jobs/by-crawler/coop-ticino-locale-cache.json',
    ]));
  });
});
