import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  assertSlugRegenerationPostRun,
  compareSlugBridgeCoverage,
  createSlugRegenerationProof,
  snapshotSlugCorpus,
} from '../scripts/lib/slug-regeneration-proof.mjs';

describe('slug regeneration post-run proof', () => {
  it('binds before/after snapshots and preserves every old bridge', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-regeneration-proof-'));
    const slicePath = path.join(root, 'slice.json');
    const before = {
      jobs: [{
        id: 'job-1',
        slug: 'canonical-it',
        slugByLocale: { it: 'canonical-it', en: 'canonical-en' },
        previousSlugs: ['canonical-it', 'old-flat'],
        previousSlugsByLocale: { it: ['canonical-it'], en: ['old-en'] },
      }],
    };
    const after = {
      jobs: [{
        id: 'job-1',
        slug: 'canonical-it',
        slugByLocale: { it: 'canonical-it', en: 'canonical-en' },
        previousSlugs: ['old-flat'],
        previousSlugsByLocale: { en: ['old-en'] },
      }],
    };

    try {
      fs.writeFileSync(slicePath, JSON.stringify(before));
      const beforeSnapshot = snapshotSlugCorpus([slicePath], { root });
      fs.writeFileSync(slicePath, JSON.stringify(after));
      const afterSnapshot = snapshotSlugCorpus([slicePath], { root });
      const verification = assertSlugRegenerationPostRun({
        before: beforeSnapshot,
        after: afterSnapshot,
        ownership: { moved: 0, emptyLocaleBucketsPruned: 0 },
      });

      expect(beforeSnapshot.selfBridgeCount).toBe(1);
      expect(afterSnapshot.selfBridgeCount).toBe(0);
      expect(verification).toMatchObject({ pass: true, missingBridgeCount: 0 });
      expect(createSlugRegenerationProof({
        generationToken: '12121-1',
        before: beforeSnapshot,
        after: afterSnapshot,
        verification,
      })).toMatchObject({
        schemaVersion: 1,
        kind: 'slug-regeneration-post-run-proof',
        generationToken: '12121-1',
        before: { digest: beforeSnapshot.digest },
        after: { digest: afterSnapshot.digest },
        verification: { pass: true },
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a historical bridge disappears', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-regeneration-proof-missing-'));
    const slicePath = path.join(root, 'slice.json');
    try {
      fs.writeFileSync(slicePath, JSON.stringify({
        jobs: [{ slug: 'canonical', previousSlugs: ['old-route'] }],
      }));
      const before = snapshotSlugCorpus([slicePath], { root });
      fs.writeFileSync(slicePath, JSON.stringify({ jobs: [{ slug: 'canonical' }] }));
      const after = snapshotSlugCorpus([slicePath], { root });

      expect(compareSlugBridgeCoverage(before, after)).toMatchObject({ missingBridgeCount: 1 });
      expect(() => assertSlugRegenerationPostRun({
        before,
        after,
        ownership: { moved: 0, emptyLocaleBucketsPruned: 0 },
      })).toThrow(/missing_bridge_count=1/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
