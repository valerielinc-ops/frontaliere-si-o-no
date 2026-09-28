import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { purgeLegacyCrawlerResidues } from '../scripts/cleanup-legacy-crawler-residues.mjs';

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
});
