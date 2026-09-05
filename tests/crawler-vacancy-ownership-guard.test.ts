import { describe, expect, it } from 'vitest';
import { dropForeignOwnedVacancies } from '../scripts/lib/crawler-source-hosts.mjs';

/**
 * Observer for issue #6759 — "crawler diversi pubblicano le stesse vacancy
 * sotto companyKey diverse".
 *
 * The defect had been repaired twice as a data migration and came back twice,
 * because nothing refused the WRITE that recreates it. These cases fail if the
 * write-time guard stops holding the invariant: one vacancy URL, one crawler.
 *
 * No fixture: the guard is pure, so an ownership snapshot is two Maps.
 */
const ownershipOf = (byKey: Record<string, string[]>) => ({
  urlsByKey: new Map(Object.entries(byKey).map(([k, urls]) => [k, new Set(urls)])),
});

describe('#6759 — a vacancy belongs to exactly one crawler', () => {
  it('drops a vacancy another crawler already publishes', () => {
    const ownership = ownershipOf({
      'villa-im-park': ['https://jobs.smartrecruiters.com/swissmedicalnetwork1/744000146906639-mitarbeiter-in-bistro'],
    });

    const result = dropForeignOwnedVacancies(
      'swiss-medical-network',
      [
        { url: 'https://jobs.smartrecruiters.com/swissmedicalnetwork1/744000146906639-mitarbeiter-in-bistro' },
        { url: 'https://jobs.smartrecruiters.com/swissmedicalnetwork1/000000000000001-eigene-stelle' },
      ],
      ownership as never,
    );

    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].url).toContain('eigene-stelle');
    expect(result.dropped).toEqual([
      expect.objectContaining({ owner: 'villa-im-park' }),
    ]);
  });

  it('catches the duplicate through URL normalisation, not string equality', () => {
    // The two crawlers reach the same posting by different links. A raw string
    // compare would let this through and publish the vacancy twice.
    const ownership = ownershipOf({ spz: ['https://jobs.paraplegie.ch/offene-stellen/assistenzarzt-aerztin-intensivmedizin/6b65e952'] });

    const result = dropForeignOwnedVacancies(
      'paraplegie',
      [{ url: 'https://JOBS.paraplegie.ch/offene-stellen/assistenzarzt-aerztin-intensivmedizin/6b65e952/?utm_source=newsletter#apply' }],
      ownership as never,
    );

    expect(result.dropped).toHaveLength(1);
    expect(result.jobs).toHaveLength(0);
  });

  it('never drops a crawler own vacancies, so ownership cannot flap', () => {
    // The incumbent rewrites its slice every run. If it saw itself as a foreign
    // owner it would erase its own catalogue, and the two crawlers would take
    // turns owning the URL instead of one keeping it.
    const url = 'https://jobs.so-h.ch/offene-stellen/arztsekretaerin/02cc9a57';
    const ownership = ownershipOf({ 'soh-solothurner-spitaeler': [url] });

    const result = dropForeignOwnedVacancies('soh-solothurner-spitaeler', [{ url }], ownership as never);

    expect(result.dropped).toEqual([]);
    expect(result.jobs).toHaveLength(1);
  });

  it('drops nothing when ownership is unknown', () => {
    // A sparse checkout has no data/jobs/by-crawler. "I cannot see an owner"
    // must never be read as "somebody else owns it", or a crawler would empty
    // its own slice wherever the slices are not materialised.
    const jobs = [{ url: 'https://example.test/offene-stellen/a' }];

    expect(dropForeignOwnedVacancies('any-key', jobs, { urlsByKey: new Map() } as never).dropped).toEqual([]);
    expect(dropForeignOwnedVacancies('any-key', jobs, {} as never).jobs).toEqual(jobs);
  });

  it('never drops a vacancy this crawler already publishes', () => {
    // An already-live duplicate has an indexed slug under BOTH keys. Dropping it
    // here would delete that page instead of redirecting it: collapsing a
    // published duplicate is a slug-preserving migration, not a write-time drop.
    const url = 'https://jobs.smartrecruiters.com/swissmedicalnetwork1/744000146906639-mitarbeiter-in-bistro';
    const ownership = {
      urlsByKey: new Map([
        ['villa-im-park', new Set([url])],
        ['swiss-medical-network', new Set([url])],
      ]),
    };

    const result = dropForeignOwnedVacancies('swiss-medical-network', [{ url }], ownership as never);

    expect(result.dropped).toEqual([]);
    expect(result.jobs).toHaveLength(1);
  });

  it('keeps the incumbent owner through the grace period', () => {
    // `activeUrlsByKey` drops a job at the FIRST miss (crawlerJobActivity
    // returns 'grace' for missStreak > 0), so indexing owners by it would hand
    // the vacancy away after one flaky crawl — and this guard would create the
    // duplicate it exists to stop. Slice membership is what "still published"
    // means, and the job is still in the incumbent's slice.
    const url = 'https://jobs.example.test/offene-stellen/flaky';
    const ownership = {
      urlsByKey: new Map([['incumbent', new Set([url])]]),
      activeUrlsByKey: new Map([['incumbent', new Set<string>()]]),
    };

    const result = dropForeignOwnedVacancies('newcomer', [{ url }], ownership as never);

    expect(result.dropped).toEqual([expect.objectContaining({ owner: 'incumbent' })]);
    expect(result.jobs).toHaveLength(0);
  });

  it('lets ownership hand over once the incumbent drops the vacancy', () => {
    // The other half of the same rule: archived out of the slice, so claimable.
    const url = 'https://jobs.example.test/offene-stellen/handover';
    const ownership = { urlsByKey: new Map([['old-owner', new Set<string>()]]) };

    const result = dropForeignOwnedVacancies('new-owner', [{ url }], ownership as never);

    expect(result.dropped).toEqual([]);
    expect(result.jobs).toHaveLength(1);
  });

  it('picks one owner deterministically when two crawlers both hold the URL', () => {
    // Already-duplicated state must resolve the same way on every run,
    // whatever order readdir returned the slices in.
    const url = 'https://jobs.example.test/offene-stellen/x';
    const forward = dropForeignOwnedVacancies('newcomer', [{ url }], ownershipOf({ alpha: [url], omega: [url] }) as never);
    const reverse = dropForeignOwnedVacancies('newcomer', [{ url }], ownershipOf({ omega: [url], alpha: [url] }) as never);

    expect(forward.dropped[0].owner).toBe('alpha');
    expect(reverse.dropped[0].owner).toBe('alpha');
  });
});
