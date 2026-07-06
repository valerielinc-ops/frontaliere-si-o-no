import { describe, expect, it } from 'vitest';

import { applyRecoveredSlug } from '../scripts/backfill-prev-slugs-from-loss-events.mjs';

// Regression test for issue #3587 ("previousSlugs writer regression: 5886
// losses in 24 hours"). The scheduled "Recover Lost previousSlugs" workflow
// (scan-prev-slug-losses.mjs + backfill-prev-slugs-from-loss-events.mjs)
// itself turned out to be the dominant source of NEW losses: it restored
// historically-lost slugs by pushing them onto the tail of an
// already-at-cap `previousSlugsByLocale[locale]` / flat `previousSlugs`
// array and then slicing to the last CAP entries — which evicted whatever
// was CURRENTLY tracked to make room for the (much older) recovered
// entries. Confirmed live: commit 88284dcdb5 ("Recover 1357 previousSlugs
// across 311 jobs") wiped roche.json job roche-4da2a57c7c98's entire `it`
// previousSlugsByLocale bucket (19 live entries incl. "roche-ch-166",
// "roche-ch-10", ...) to make room for 20 freshly-recovered historical
// slugs, which the next scan then re-reported as new losses — an
// unbounded recover-then-lose oscillation.
//
// The fix (applyRecoveredSlug): recovery is capacity-permitting and
// strictly additive — it skips adding a recovered slug once a bucket is
// already at cap instead of evicting live entries to fit it in.
describe('applyRecoveredSlug (previousSlugs recovery, #3587)', () => {
  it('does not evict existing entries when the locale bucket is already at cap', () => {
    const existing = Array.from({ length: 20 }, (_, i) => `roche-ch-${i}`);
    const job = {
      id: 'roche-4da2a57c7c98',
      previousSlugsByLocale: { it: [...existing] },
      previousSlugs: [...existing],
    };

    const result = applyRecoveredSlug(job, 'it', 'roche-nanjing-4mxh6m', 20);

    expect(result).toEqual({ restored: false, skippedAtCap: true });
    // Every previously-tracked entry must survive — recovery must never
    // evict a live redirect target just to fit a recovered one.
    expect(job.previousSlugsByLocale.it).toEqual(existing);
    expect(job.previousSlugs).toEqual(existing);
    expect(job.previousSlugsByLocale.it).not.toContain('roche-nanjing-4mxh6m');
  });

  it('restores a recovered slug normally when the bucket has spare capacity', () => {
    const job = {
      id: 'manor-c0d8a64b6096',
      previousSlugsByLocale: { it: ['old-slug-1'] },
      previousSlugs: ['old-slug-1'],
    };

    const result = applyRecoveredSlug(job, 'it', 'recovered-slug', 20);

    expect(result).toEqual({ restored: true, skippedAtCap: false });
    expect(job.previousSlugsByLocale.it).toEqual(['old-slug-1', 'recovered-slug']);
    expect(job.previousSlugs).toEqual(['old-slug-1', 'recovered-slug']);
  });

  it('is idempotent for a slug already present in the bucket', () => {
    const job = {
      id: 'coop-ticino-abc123',
      previousSlugsByLocale: { it: ['already-there'] },
      previousSlugs: ['already-there'],
    };

    const result = applyRecoveredSlug(job, 'it', 'already-there', 20);

    expect(result).toEqual({ restored: false, skippedAtCap: false });
    expect(job.previousSlugsByLocale.it).toEqual(['already-there']);
  });

  it('lazily initializes previousSlugsByLocale/previousSlugs when absent', () => {
    const job = { id: 'new-yorker-xyz' };

    const result = applyRecoveredSlug(job, 'en', 'first-recovered-slug', 20);

    expect(result).toEqual({ restored: true, skippedAtCap: false });
    expect(job.previousSlugsByLocale.en).toEqual(['first-recovered-slug']);
    expect(job.previousSlugs).toEqual(['first-recovered-slug']);
  });
});
