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

    const applied = purgeLegacyCrawlerResidues({ expiredDir, apply: true });
    expect(applied.filesRemoved).toEqual([scratch]);
    expect(fs.existsSync(scratch)).toBe(false);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it('fails closed when the allowlisted path contains another company', () => {
    const expiredDir = fixtureDir();
    const scratch = path.join(expiredDir, 'coop-ticino-locale-cache.json');
    fs.writeFileSync(scratch, JSON.stringify([{ companyKey: 'other-company', slug: 'unexpected' }]));

    expect(() => purgeLegacyCrawlerResidues({ expiredDir, apply: true })).toThrow(/non-coop-ticino entry/);
    expect(fs.existsSync(scratch)).toBe(true);
  });
});
