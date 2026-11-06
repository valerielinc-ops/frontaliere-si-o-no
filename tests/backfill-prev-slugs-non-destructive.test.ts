import { describe, expect, it } from 'vitest';

import { applyRecoveredSlug } from '../scripts/backfill-prev-slugs-from-loss-events.mjs';
import { classifyJobSliceRemovals } from '../scripts/scan-prev-slug-losses.mjs';

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
// The fix (applyRecoveredSlug): recovery is bounded and strictly additive —
// it uses one cap-sized overflow window for proven losses, then skips without
// evicting live entries. Recovered values are prepended so a later normal cap
// trim removes recovery overflow first.
describe('applyRecoveredSlug (previousSlugs recovery, #3587/#9056)', () => {
  it('uses bounded overflow without evicting existing entries at the live cap', () => {
    const existing = Array.from({ length: 20 }, (_, i) => `roche-ch-${i}`);
    const job = {
      id: 'roche-4da2a57c7c98',
      previousSlugsByLocale: { it: [...existing] },
      previousSlugs: [...existing],
    };

    const result = applyRecoveredSlug(job, 'it', 'roche-nanjing-4mxh6m', 20);

    expect(result).toEqual({ restored: true, skippedAtCap: false });
    // Every previously-tracked entry must survive — recovery must never
    // evict a live redirect target just to fit a recovered one.
    expect(job.previousSlugsByLocale.it).toEqual(['roche-nanjing-4mxh6m', ...existing]);
    expect(job.previousSlugs).toEqual(['roche-nanjing-4mxh6m', ...existing]);
  });

  it('stops at the bounded recovery cap without evicting live history', () => {
    const existing = ['live-0', 'live-1'];
    const job = {
      id: 'bounded-recovery',
      previousSlugsByLocale: { en: [...existing] },
      previousSlugs: [...existing],
    };

    expect(applyRecoveredSlug(job, 'en', 'recovered-0', 2)).toEqual({ restored: true, skippedAtCap: false });
    expect(applyRecoveredSlug(job, 'en', 'recovered-1', 2)).toEqual({ restored: true, skippedAtCap: false });
    expect(applyRecoveredSlug(job, 'en', 'recovered-2', 2)).toEqual({ restored: false, skippedAtCap: true });

    expect(job.previousSlugsByLocale.en).toEqual(['recovered-1', 'recovered-0', ...existing]);
    expect(job.previousSlugsByLocale.en).toHaveLength(4);
    expect(job.previousSlugs).toEqual(['recovered-1', 'recovered-0', ...existing]);
  });

  it('persists all 17 full-bucket recoveries with locale ownership and clears the next scan', () => {
    const live = Array.from({ length: 20 }, (_, i) => `live-en-${i}`);
    const recovered = Array.from({ length: 17 }, (_, i) => `proven-en-${i}`);
    const job = {
      id: 'full-bucket-recovery',
      url: 'https://example.ch/jobs/full-bucket-recovery',
      slugByLocale: { en: 'live-en-19' },
      previousSlugsByLocale: { en: [...live] },
      previousSlugs: [...live],
    };

    for (const slug of recovered) {
      expect(applyRecoveredSlug(job, 'en', slug, 20)).toEqual({ restored: true, skippedAtCap: false });
    }

    expect(job.previousSlugsByLocale.en).toHaveLength(37);
    expect(job.previousSlugsByLocale.en).toEqual(expect.arrayContaining([...live, ...recovered]));
    expect(job.previousSlugs).toEqual(expect.arrayContaining([...live, ...recovered]));
    expect(classifyJobSliceRemovals(
      [{ ...job, previousSlugsByLocale: { en: [...recovered, ...live] }, previousSlugs: [...recovered, ...live] }],
      [job],
    )).toEqual([]);
  });

  it('restores a recovered slug normally when the bucket has spare capacity', () => {
    const job = {
      id: 'manor-c0d8a64b6096',
      previousSlugsByLocale: { it: ['old-slug-1'] },
      previousSlugs: ['old-slug-1'],
    };

    const result = applyRecoveredSlug(job, 'it', 'recovered-slug', 20);

    expect(result).toEqual({ restored: true, skippedAtCap: false });
    expect(job.previousSlugsByLocale.it).toEqual(['recovered-slug', 'old-slug-1']);
    expect(job.previousSlugs).toEqual(['recovered-slug', 'old-slug-1']);
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
