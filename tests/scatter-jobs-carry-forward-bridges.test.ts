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

  // #4208 (post-merge review of #4200): collectMissingAssembledBridges was
  // called on the PRE-rename sliceJob, so its headroom didn't yet know about
  // the flat-cap slots the rename loop (L189-196) was about to spend on the
  // locales renaming THIS run. With 2+ locales renamed in the same crawl run,
  // that stale headroom could hand the carry-forward loop more "missing"
  // bridges than the cap truly had room for after the rename landed. Fixed
  // by recomputing collectMissingAssembledBridges on `updatedJob` AFTER the
  // rename loop completes.
  it('carry-forward headroom reflects the POST-rename occupancy, not the pre-rename snapshot (2 locales renamed same run)', () => {
    // 70 pre-existing flat bridges + 4 distinct active locale slugs (it/en/de/fr)
    // headroom computed PRE-rename (on sliceJob) = 80 - 70 - 4 = 6.
    // headroom computed POST-rename (on updatedJob, after en+de rename push
    // their 2 old actives into the flat union) = 80 - 72 - 4 = 4.
    const existing = Array.from({ length: 70 }, (_, i) => `slice-bridge-${i}`);
    const sliceJob = {
      id: 'company-xyz',
      slug: 's-it',
      slugByLocale: { it: 's-it', en: 's-en-old', de: 's-de-old', fr: 's-fr-old' },
      titleByLocale: { it: 'T', en: 'T', de: 'T', fr: 'T' },
      descriptionByLocale: {},
      previousSlugs: [...existing],
      previousSlugsByLocale: { it: [...existing] },
    };
    // Assembled renames en+de AND offers 6 brand-new bridge candidates
    // (attributed to fr, which is NOT renaming this run).
    const newCandidates = Array.from({ length: 6 }, (_, i) => `assembled-new-${i}`);
    const assembled = {
      ...sliceJob,
      slugByLocale: { it: 's-it', en: 's-en-new', de: 's-de-new', fr: 's-fr-old' },
      previousSlugs: [...existing, ...newCandidates],
      previousSlugsByLocale: { it: [...existing], fr: newCandidates },
    };

    const { job } = applyAssembledToSliceJob(sliceJob, assembled);
    const unionAll = new Set([
      ...(job.previousSlugs || []),
      ...Object.values(job.previousSlugsByLocale || {}).flat(),
    ]);

    // Every pre-existing bridge survives.
    for (const s of existing) expect(unionAll.has(s)).toBe(true);
    // Both renamed-away old actives are captured.
    expect(unionAll.has('s-en-old')).toBe(true);
    expect(unionAll.has('s-de-old')).toBe(true);

    // Only 4 of the 6 new candidates fit under the POST-rename headroom —
    // the pre-rename computation would have (incorrectly) admitted all 6.
    const admitted = newCandidates.filter((s) => unionAll.has(s));
    expect(admitted).toHaveLength(4);
    expect(admitted).toEqual(newCandidates.slice(0, 4));
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
