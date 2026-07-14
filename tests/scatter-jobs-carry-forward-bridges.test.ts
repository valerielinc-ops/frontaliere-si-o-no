/**
 * Regression tests for the previousSlugs writer regression fired daily by the
 * "Recover Lost previousSlugs" monitor (issues #4165 #4161 #4134 #4112 #4102
 * #4088 #4076 #3885 — all the same class).
 *
 * Root cause: scatter-jobs-to-slices.mjs is the assembled→slice writer for
 * every job NOT processed by relocalize-pending-jobs.mjs. It journaled
 * per-locale slug RENAMES (old active slug → previousSlugsByLocale) correctly,
 * but — unlike relocalize (which has an explicit "Sync previousSlugs from
 * assembled dataset to per-crawler file" block) and unlike
 * assemble-jobs-dataset's trackSlugHistoryDrift — it never carried forward the
 * SEO bridge slugs the assembled dataset had already captured
 * (previousSlugs / previousSlugsByLocale). Those bridges were silently dropped
 * from the committed slice (the source of truth the build plugin reads to emit
 * redirect/bridge pages), producing 404s for URLs Google already indexed.
 *
 * The fix carries forward the missing bridges through the canonical
 * journal-backed helper (addPreviousSlugForLocale), bounded to the flat
 * legacy cap headroom so it can NEVER evict a bridge the slice already had.
 */
import { describe, it, expect } from 'vitest';
import {
  applyAssembledToSliceJob,
  collectMissingAssembledBridges,
} from '../scripts/scatter-jobs-to-slices.mjs';
import { LEGACY_PREV_SLUGS_CAP } from '../scripts/lib/dedicated-crawler-common.mjs';

const baseSlice = () => ({
  id: 'company-abc',
  url: 'https://example.test/company-abc',
  company: 'C',
  location: 'L',
  slug: 's-it',
  slugByLocale: { it: 's-it', en: 's-en-old' },
  titleByLocale: { it: 'T', en: 'T' },
  descriptionByLocale: {},
});

describe('scatter carry-forward of assembled previousSlugs bridges', () => {
  it('preserves an assembled bridge slug the slice was missing (the dropped-bridge regression)', () => {
    const sliceJob = baseSlice();
    const assembled = {
      ...baseSlice(),
      // en renamed on the assembled side; the old EN active slug must be
      // captured AND the assembler-known bridge must be carried forward.
      slugByLocale: { it: 's-it', en: 's-en-new' },
      previousSlugs: ['bridge-old'],
      previousSlugsByLocale: { en: ['bridge-old'] },
    };

    const { job, changed } = applyAssembledToSliceJob(sliceJob, assembled);
    expect(changed).toBe(true);

    // Bridge the assembled dataset knew about but the slice lacked — was
    // silently dropped before the fix.
    expect(job.previousSlugs).toContain('bridge-old');
    expect(job.previousSlugsByLocale.en).toContain('bridge-old');

    // The old active EN slug is still captured (pre-existing behaviour).
    expect(job.previousSlugs).toContain('s-en-old');
    expect(job.previousSlugsByLocale.en).toContain('s-en-old');

    // Input never mutated.
    expect(sliceJob.previousSlugs).toBeUndefined();
  });

  it('carries forward a bridge even when locale/slug fields are otherwise unchanged', () => {
    const sliceJob = baseSlice();
    // Identical locale fields — only the assembled bridge history is richer.
    const assembled = {
      ...baseSlice(),
      previousSlugsByLocale: { en: ['legacy-en-bridge'] },
    };

    const { job, changed } = applyAssembledToSliceJob(sliceJob, assembled);
    expect(changed).toBe(true);
    expect(job.previousSlugsByLocale.en).toContain('legacy-en-bridge');
  });

  it('is a no-op when the slice already holds every assembled bridge', () => {
    const sliceJob = {
      ...baseSlice(),
      previousSlugs: ['bridge-old'],
      previousSlugsByLocale: { en: ['bridge-old'] },
    };
    const assembled = {
      ...baseSlice(),
      previousSlugs: ['bridge-old'],
      previousSlugsByLocale: { en: ['bridge-old'] },
    };
    const { changed } = applyAssembledToSliceJob(sliceJob, assembled);
    expect(changed).toBe(false);
  });

  it('NEVER evicts a pre-existing slice bridge when the assembled side floods new ones (cap headroom guard)', () => {
    // Slice already near the flat legacy cap with its own committed bridges.
    const existing = Array.from({ length: LEGACY_PREV_SLUGS_CAP - 2 }, (_, i) => `slice-bridge-${i}`);
    const sliceJob = {
      ...baseSlice(),
      slugByLocale: { it: 's-it', en: 's-en-old' },
      previousSlugs: [...existing],
      previousSlugsByLocale: { it: [...existing] },
    };
    // Assembled renames EN and offers far more bridges than the cap can hold.
    const flood = Array.from({ length: 50 }, (_, i) => `assembled-bridge-${i}`);
    const assembled = {
      ...baseSlice(),
      slugByLocale: { it: 's-it', en: 's-en-new' },
      previousSlugs: flood,
      previousSlugsByLocale: { en: flood },
    };

    const { job } = applyAssembledToSliceJob(sliceJob, assembled);
    const survivingUnion = new Set([
      ...(job.previousSlugs || []),
      ...Object.values(job.previousSlugsByLocale || {}).flat(),
    ]);
    // Every pre-existing committed bridge must survive — that was the
    // secondary regression risk (carry-forward appended as "newest" and the
    // cap trimmed the slice's own older entries).
    for (const s of existing) {
      expect(survivingUnion.has(s)).toBe(true);
    }
    // The old active EN slug is still captured too.
    expect(survivingUnion.has('s-en-old')).toBe(true);
  });

  it('collectMissingAssembledBridges returns nothing once the flat cap is already full', () => {
    const full = Array.from({ length: LEGACY_PREV_SLUGS_CAP }, (_, i) => `b-${i}`);
    const sliceJob = { ...baseSlice(), previousSlugs: full, previousSlugsByLocale: { it: full } };
    const assembled = {
      ...baseSlice(),
      previousSlugs: ['brand-new-bridge'],
      previousSlugsByLocale: { en: ['brand-new-bridge'] },
    };
    expect(collectMissingAssembledBridges(sliceJob, assembled)).toEqual([]);
  });

  it('applying twice is idempotent (no runaway history growth)', () => {
    const sliceJob = baseSlice();
    const assembled = {
      ...baseSlice(),
      slugByLocale: { it: 's-it', en: 's-en-new' },
      previousSlugs: ['bridge-old'],
      previousSlugsByLocale: { en: ['bridge-old'] },
    };
    const first = applyAssembledToSliceJob(sliceJob, assembled).job;
    const second = applyAssembledToSliceJob(first, assembled);
    expect(second.changed).toBe(false);
    expect(second.job).toBe(first);
  });
});
