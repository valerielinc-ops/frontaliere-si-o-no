import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { stableSlugHash } from '../scripts/lib/dedicated-crawler-common.mjs';

// Reproduces the review finding on this PR: a slug present ONLY in a job's
// flat `previousSlugs` array (never mirrored into `previousSlugsByLocale`)
// that resolves to a different current job was being dropped by the flat-
// array filter instead of moved there — silent data loss, contradicting the
// script's own "never drop, only redirect" contract (see resolveRecoveryTarget
// in backfill-prev-slugs-from-loss-events.mjs).
describe('decontaminate-prev-slugs: flat previousSlugs redirect', () => {
  it('moves a redirected flat-array slug onto its real target job instead of dropping it', async () => {
    process.argv.push('--apply');
    const { processFile } = await import('../scripts/decontaminate-prev-slugs.mjs');

    const zurich = {
      id: 'company-telail',
      url: 'https://www.coopjobs.ch/offene-stellen/it/11111111-1111-1111-1111-111111111111',
    };
    const basel = {
      id: 'company-vn6yz4',
      url: 'https://www.coopjobs.ch/offene-stellen/it/22222222-2222-2222-2222-222222222222',
    };
    const baselSlug = `verkaufer-in-food-coop-basel-stadt-${stableSlugHash(basel)}`;
    zurich.previousSlugs = [baselSlug];
    basel.previousSlugs = [];

    const tmpFile = path.join(os.tmpdir(), `decontaminate-flat-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ jobs: [zurich, basel] }));

    try {
      const result = processFile(tmpFile);
      expect(result?.moved).toBe(1);

      const written = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
      const writtenZurich = written.jobs.find((job: { id: string }) => job.id === 'company-telail');
      const writtenBasel = written.jobs.find((job: { id: string }) => job.id === 'company-vn6yz4');

      expect(writtenZurich.previousSlugs).not.toContain(baselSlug);
      expect(writtenBasel.previousSlugs).toContain(baselSlug);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });

  it('prunes empty locale buckets while preserving route ownership and is idempotent', async () => {
    process.argv.push('--apply');
    const { processFile } = await import('../scripts/decontaminate-prev-slugs.mjs');

    const claimant = {
      id: 'company-claimant',
      url: 'https://jobs.example.com/posting/claimant',
      previousSlugsByLocale: { en: [] as string[], de: [] as string[], fr: ['route-fr-storica'] },
      previousSlugs: [] as string[],
    };
    const owner = {
      id: 'company-owner',
      url: 'https://jobs.example.com/posting/owner',
      previousSlugsByLocale: { it: [] as string[] },
      previousSlugs: [] as string[],
    };
    const ownerSlug = `owner-route-storica-${stableSlugHash(owner)}`;
    claimant.previousSlugsByLocale.en.push(ownerSlug);
    claimant.previousSlugs.push(ownerSlug);

    const tmpFile = path.join(os.tmpdir(), `decontaminate-idempotent-test-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify({ jobs: [claimant, owner] }));

    try {
      expect(processFile(tmpFile)).toEqual({ moved: 2, emptyLocaleBucketsPruned: 3 });

      const written = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
      const writtenClaimant = written.jobs.find((job: { id: string }) => job.id === claimant.id);
      const writtenOwner = written.jobs.find((job: { id: string }) => job.id === owner.id);

      expect(writtenClaimant.previousSlugsByLocale).toEqual({ fr: ['route-fr-storica'] });
      expect(writtenClaimant.previousSlugs).not.toContain(ownerSlug);
      expect(writtenOwner.previousSlugsByLocale).toEqual({ en: [ownerSlug] });
      expect(writtenOwner.previousSlugs).toEqual([ownerSlug]);
      expect(processFile(tmpFile)).toBeNull();
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
  });
});
