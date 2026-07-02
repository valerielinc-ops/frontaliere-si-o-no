/**
 * Bug: mergeAndDeduplicate's heuristic-dedup pass grouped jobs by
 * dedupHeuristicKey (company+title+location+canton+contract+category+salary),
 * which is too coarse for multi-branch employers whose `location` is
 * city-level only (e.g. Coop, Manor, Migros post many genuinely distinct
 * "Verkäufer:in Food, Zürich" openings at different branches/URLs).
 *
 * Two different real postings sharing that coarse signature got collapsed
 * into ONE record via preferJob (whole-object pick, not a field merge). The
 * "winner" rotated crawl-to-crawl as recency shifted, so the persisted
 * record's url/slug/previousSlugs corrupted with fragments from multiple
 * unrelated real postings — this is what fed the `recover-prev-slugs.yml`
 * growing-loss volume, concentrated in coop-ticino.json (see 2026-07-02
 * investigation: company-telail's slugByLocale carried company-ixjaym's own
 * stable hash suffix after a heuristic-collapse round).
 *
 * Fix: jobs with a strong per-posting URL identity (fingerprintJob returns
 * `id|...`) are never heuristically merged with a different strong-identity
 * job, even if they share the coarse heuristic signature.
 */
import { describe, expect, it } from 'vitest';
import { mergeAndDeduplicate } from '../scripts/lib/dedicated-crawler-common.mjs';

const QUALITY_CFG = {};

function coopJob(overrides) {
  return {
    title: 'Verkäufer:in Food',
    company: 'Coop Genossenschaft',
    location: 'Zürich',
    description: 'Als Verkäufer:in Food sorgst du für ein optimales Einkaufserlebnis unserer Kundschaft und pflegst dein Sortiment mit Herz.',
    source: 'Company Careers Crawler',
    crawledAt: '2026-07-02T08:00:00Z',
    ...overrides,
  };
}

describe('mergeAndDeduplicate heuristic dedup vs strong URL identity', () => {
  it('keeps two distinct real postings that share the coarse heuristic signature', () => {
    const jobA = coopJob({
      id: 'company-telail',
      url: 'https://jobs.coopjobs.ch/offene-stellen/verkaeufer-in-food/5225283c-3732-4d4c-a89d-dd0b168fc7e2',
    });
    const jobB = coopJob({
      id: 'company-ixjaym',
      url: 'https://jobs.coopjobs.ch/offene-stellen/verkaeufer-in-food/9abce118-a581-4ef9-88f7-49d36af2a40e',
    });

    const result = mergeAndDeduplicate([], [jobA, jobB], QUALITY_CFG);
    const ids = result.merged.map((j) => j.id).sort();

    expect(ids).toEqual(['company-ixjaym', 'company-telail']);
  });

  it('still collapses true duplicates that lack a strong URL identity', () => {
    // A detail-shaped URL with no extractable per-posting id — fingerprintJob
    // falls back to `url|...`, which the fix still treats as weak identity.
    const jobA = coopJob({
      id: 'weak-a',
      url: 'https://www.coop.ch/jobs/verkaeufer-in-food-zuerich',
      crawledAt: '2026-07-02T08:00:00Z',
    });
    const jobB = coopJob({
      id: 'weak-b',
      url: 'https://www.coop.ch/jobs/verkaeufer-in-food-zuerich',
      crawledAt: '2026-07-02T09:00:00Z',
    });

    const result = mergeAndDeduplicate([], [jobA, jobB], QUALITY_CFG);

    expect(result.merged).toHaveLength(1);
  });

  it('does not let the surviving record swap identity across crawls (persists both across a re-merge)', () => {
    const jobA = coopJob({
      id: 'company-telail',
      url: 'https://jobs.coopjobs.ch/offene-stellen/verkaeufer-in-food/5225283c-3732-4d4c-a89d-dd0b168fc7e2',
      crawledAt: '2026-06-30T08:00:00Z',
    });
    const jobB = coopJob({
      id: 'company-ixjaym',
      url: 'https://jobs.coopjobs.ch/offene-stellen/verkaeufer-in-food/9abce118-a581-4ef9-88f7-49d36af2a40e',
      crawledAt: '2026-07-01T08:00:00Z',
    });

    const first = mergeAndDeduplicate([], [jobA, jobB], QUALITY_CFG);
    // Re-crawl a day later: only jobB re-scraped (jobA's branch listing rolled off this page).
    const jobBRecrawled = { ...jobB, crawledAt: '2026-07-02T08:00:00Z' };
    const second = mergeAndDeduplicate(first.merged, [jobBRecrawled], QUALITY_CFG);

    const ids = second.merged.map((j) => j.id).sort();
    expect(ids).toEqual(['company-ixjaym', 'company-telail']);
  });
});
