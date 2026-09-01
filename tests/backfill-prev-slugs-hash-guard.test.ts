import { describe, expect, it } from 'vitest';

import {
  buildUniqueSuffixOwnerFiles,
  resolveForeignRecoveryOwnerFile,
  resolveRecoveryTarget,
} from '../scripts/backfill-prev-slugs-from-loss-events.mjs';
import { stableSlugHash } from '../scripts/lib/dedicated-crawler-common.mjs';

// Reproduces the real coop-ticino bug: a loss event recorded against a stale
// historical job.id snapshot gets replayed weeks later against whatever job
// currently holds that id. If a different, still-active job's own slug was
// the one actually lost, blindly writing it onto the stale id's current
// owner corrupts an unrelated job's previousSlugs (confirmed live: Basel's
// `company-vn6yz4`, Thun's `company-awtob4`, Neuhausen's `company-4dvdh4` —
// all real, distinct, currently-active Coop postings sharing the exact title
// "Verkäufer:in Food" — had their own hash-tagged slugs show up inside
// Zürich's `company-telail` previousSlugs).
const zurich = {
  id: 'company-telail',
  url: 'https://www.coopjobs.ch/offene-stellen/it/11111111-1111-1111-1111-111111111111',
};
const basel = {
  id: 'company-vn6yz4',
  url: 'https://www.coopjobs.ch/offene-stellen/it/22222222-2222-2222-2222-222222222222',
};

describe('resolveRecoveryTarget', () => {
  it('redirects a slug whose disambiguator tail belongs to a different current job', () => {
    const bySuffixHash = new Map([
      [stableSlugHash(zurich), zurich],
      [stableSlugHash(basel), basel],
    ]);
    const baselSlug = `verkaufer-in-food-coop-basel-stadt-${stableSlugHash(basel)}`;

    // Loss event resolved to zurich via a stale historical id, but the slug
    // itself carries basel's own content-hash tail.
    const result = resolveRecoveryTarget(zurich, baselSlug, bySuffixHash);

    expect(result.redirected).toBe(true);
    expect(result.targetJob).toBe(basel);
  });

  it('trusts a slug whose tail matches the resolved job\'s own hash', () => {
    const bySuffixHash = new Map([
      [stableSlugHash(zurich), zurich],
      [stableSlugHash(basel), basel],
    ]);
    const ownSlug = `verkaufer-in-food-coop-zurich-${stableSlugHash(zurich)}`;

    const result = resolveRecoveryTarget(zurich, ownSlug, bySuffixHash);

    expect(result.redirected).toBe(false);
    expect(result.targetJob).toBe(zurich);
  });

  it('leaves a mismatched tail untouched when no current job confirms ownership', () => {
    // "-campus" is a real trailing word (e.g. "universitatsspital-zurich-usz-campus"),
    // not a hash — with no positive match in bySuffixHash, it must not be
    // treated as evidence of contamination.
    const bySuffixHash = new Map([[stableSlugHash(zurich), zurich]]);
    const wordTailSlug = 'spontanbewerbung-universitatsspital-zurich-usz-campus';

    const result = resolveRecoveryTarget(zurich, wordTailSlug, bySuffixHash);

    expect(result.redirected).toBe(false);
    expect(result.targetJob).toBe(zurich);
  });

  it('passes through untagged legacy slugs with no disambiguator suffix unchanged', () => {
    const bySuffixHash = new Map([[stableSlugHash(zurich), zurich]]);
    const legacySlug = 'verkaufer-in-food-coop-basel-stadt';

    const result = resolveRecoveryTarget(zurich, legacySlug, bySuffixHash);

    expect(result.redirected).toBe(false);
    expect(result.targetJob).toBe(zurich);
  });

  it('passes through unchanged when the resolved job has no strong URL identity', () => {
    const weakJob = { id: 'company-abc', url: 'not-a-valid-url' };
    const bySuffixHash = new Map([[stableSlugHash(zurich), zurich]]);
    const slug = `some-title-${stableSlugHash(zurich)}`;

    const result = resolveRecoveryTarget(weakJob, slug, bySuffixHash);

    expect(result.redirected).toBe(false);
    expect(result.targetJob).toBe(weakJob);
  });
});

describe('cross-file recovery ownership', () => {
  it('fails closed on a uniquely-owned foreign hash instead of contaminating the claimant', () => {
    const ownerFiles = buildUniqueSuffixOwnerFiles([
      { file: 'claimant.json', jobs: [zurich] },
      { file: 'owner.json', jobs: [basel] },
    ]);
    const baselSlug = `verkaufer-in-food-coop-basel-stadt-${stableSlugHash(basel)}`;

    expect(resolveForeignRecoveryOwnerFile('claimant.json', baselSlug, ownerFiles)).toBe('owner.json');
    expect(resolveForeignRecoveryOwnerFile('owner.json', baselSlug, ownerFiles)).toBeNull();
  });

  it('does not choose between duplicate current records sharing the same hash', () => {
    const duplicateBasel = { ...basel, id: 'company-duplicate' };
    const ownerFiles = buildUniqueSuffixOwnerFiles([
      { file: 'claimant.json', jobs: [zurich] },
      { file: 'owner-a.json', jobs: [basel] },
      { file: 'owner-b.json', jobs: [duplicateBasel] },
    ]);
    const baselSlug = `verkaufer-in-food-coop-basel-stadt-${stableSlugHash(basel)}`;

    expect(resolveForeignRecoveryOwnerFile('claimant.json', baselSlug, ownerFiles)).toBeNull();
  });
});
