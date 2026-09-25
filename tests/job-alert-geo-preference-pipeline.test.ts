/**
 * Closes two adversarial nits raised on the PR #3146 review (graduated geo
 * preference, issue #2993) that were left "unverified" rather than fixed —
 * see issue #3155.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildAlertProfile, partitionByGeoPreference } from '../services/jobAlertMatching.mjs';
import { filterUnsentJobs, normalizeSentMap } from '../scripts/lib/alert-sent-jobs.mjs';
import { filterLiveJobs, STATIC_CITY_CANTON_FLOOR } from '../scripts/send-job-alerts.mjs';

function job(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-id',
    slug: 'job-slug',
    slugByLocale: {},
    title: 'Software Engineer',
    description: 'We are hiring a backend software engineer in Ticino.',
    company: 'Board International',
    companyKey: 'board-international',
    location: 'Lugano',
    addressLocality: 'Lugano',
    addressRegion: 'TI',
    canton: 'TI',
    contract: 'full-time',
    sector: 'IT',
    category: 'Software',
    firstSeenAt: '2026-06-10T00:00:00Z',
    ...overrides,
  };
}

describe('STATIC_CITY_CANTON_FLOOR (nit: cityToCanton coverage gap, PR #3146)', () => {
  it('guarantees the 4 hardcoded city-preference flags resolve to Ticino regardless of today\'s crawl snapshot', () => {
    // These are the same 4 cities jobAlertMatching.mjs's preferenceCities()
    // treats as explicit TI signals — the dataset-derived cityToCanton index
    // in loadJobs() must never be the ONLY way to resolve them, or a
    // subscriber whose home city has zero live jobs today falls through to
    // CH-wide instead of same-canton jobs from a nearby TI city.
    expect(STATIC_CITY_CANTON_FLOOR).toEqual({
      lugano: 'ti', bellinzona: 'ti', mendrisio: 'ti', chiasso: 'ti',
    });
  });

  it('resolves a subscriber\'s home city to TI via buildAlertProfile even with an empty dataset-derived index', () => {
    const profile = buildAlertProfile(
      { keywords: ['infermiere'] },
      { location_interest: 'Bellinzona' },
      { cityToCanton: STATIC_CITY_CANTON_FLOOR }, // simulates today's snapshot having zero Bellinzona jobs
    );
    expect(profile.preferredCantons).toEqual(['ti']);
  });
});

describe('geo-preference floor survives the full send pipeline (nit: minLocal vs per-email cap, PR #3146)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('keeps in-area jobs ordered before out-of-area padding through dedup + live-check + final slice', async () => {
    // Below GEO_PREFERENCE_MIN_LOCAL (5): 3 TI (in-area) + 3 BS (padding),
    // so partitionByGeoPreference returns TI-first then BS (never starved).
    const tiJobs = [0, 1, 2].map((i) => job({ id: `ti-${i}`, slug: `ti-${i}`, canton: 'TI', location: 'Lugano', addressLocality: 'Lugano', addressRegion: 'TI' }));
    const bsJobs = [0, 1, 2].map((i) => job({ id: `bs-${i}`, slug: `bs-${i}`, canton: 'BS', location: 'Basel', addressLocality: 'Basel', addressRegion: 'BS' }));

    const profile = buildAlertProfile(
      { keywords: ['infermiere'] },
      { location_interest: 'Lugano' },
      { cityToCanton: { lugano: 'ti' } },
    );
    const ranked = partitionByGeoPreference([...tiJobs, ...bsJobs], profile);
    expect(ranked.map((j) => j.canton)).toEqual(['TI', 'TI', 'TI', 'BS', 'BS', 'BS']);

    // Dedup drops one already-sent TI job (filterUnsentJobs preserves order).
    const sentMap = normalizeSentMap({ 'ti-1': Date.now() });
    const deduped = filterUnsentJobs(ranked, sentMap, Date.now());
    expect(deduped.map((j) => j.id)).toEqual(['ti-0', 'ti-2', 'bs-0', 'bs-1', 'bs-2']);

    // Live-link check drops one BS job (filterLiveJobs preserves order too).
    const fetchSpy = vi.fn(async (url: string) => {
      const dead = String(url).includes('bs-1');
      return { status: dead ? 404 : 200, ok: !dead, text: async () => '<html>live job page</html>' };
    });
    vi.stubGlobal('fetch', fetchSpy);
    const liveMatched = await filterLiveJobs(deduped, 'it', new Map());

    // Final per-email cap (buildAlertEmail renders/slices the first 10).
    const sentJobs = liveMatched.slice(0, 10);

    expect(sentJobs.map((j) => j.id)).toEqual(['ti-0', 'ti-2', 'bs-0', 'bs-2']);
    // The invariant the review nit left unverified: no out-of-area job ever
    // precedes a surviving in-area job in what actually gets sent.
    const firstBsIdx = sentJobs.findIndex((j) => j.canton === 'BS');
    const lastTiIdx = sentJobs.map((j) => j.canton).lastIndexOf('TI');
    expect(firstBsIdx).toBeGreaterThan(lastTiIdx);
  });
});
