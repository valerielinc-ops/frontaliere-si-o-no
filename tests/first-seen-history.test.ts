import { describe, expect, it } from 'vitest';
import {
  ambiguousJobIdentities,
  carryForwardFirstSeenAt,
  createFirstSeenMetadataIndex,
} from '../scripts/lib/first-seen-history.mjs';
import {
  buildExpiredEntry,
  mergeSourceIdentityHistory,
} from '../scripts/lib/expired-jobs-archive.mjs';
import { selectNewlyPublishedJobs } from '../scripts/send-company-alerts.mjs';

function job(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Infermiere/a in cure generali',
    slug: 'infermiere-a-in-cure-generali-eoc-feezsb',
    url: 'https://recruitingapp-2761.umantis.com/Vacancies/1373/Description/4',
    firstSeenAt: '2026-09-23T23:53:42.243Z',
    ...overrides,
  };
}

describe('carryForwardFirstSeenAt', () => {
  it('reconstructs firstSeenAt and source identity for a legacy archive', () => {
    const archived = [{ title: job().title, slug: job().slug }];
    const history = createFirstSeenMetadataIndex();
    history.add(job({ firstSeenAt: '2026-09-23T23:53:42.243Z' }));
    history.add(job({ firstSeenAt: '2026-09-19T23:09:25.433Z' }));

    const result = history.enrich(archived);

    expect(archived[0]).toMatchObject({
      sourceIdentity: 'url:https://recruitingapp-2761.umantis.com/vacancies/1373/description/4',
      firstSeenAt: '2026-09-19T23:09:25.433Z',
    });
    expect(result.enrichedEntries).toBe(1);
    expect(result.enrichedFields).toBe(2);
  });

  it('repairs a currently active job whose crawler reset firstSeenAt', () => {
    const current = job({ firstSeenAt: '2026-09-23T23:53:42.243Z' });
    const history = createFirstSeenMetadataIndex();
    history.add(job({ firstSeenAt: '2026-09-10T23:21:49.331Z' }));

    const result = history.enrichActive([current]);

    expect(current).toMatchObject({
      sourceIdentity: 'url:https://recruitingapp-2761.umantis.com/vacancies/1373/description/4',
      firstSeenAt: '2026-09-10T23:21:49.331Z',
    });
    expect(result.enrichedEntries).toBe(1);
    expect(result.enrichedFields).toBe(2);
  });

  it('keeps the current URL when a previous slug points to another same-title vacancy', () => {
    const current = job({
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/2776/Description/4',
      slug: 'infermiere-a-in-cure-generali-eoc-lugano',
      previousSlugs: ['infermiere-a-in-cure-generali-eoc-bellinzona'],
      firstSeenAt: '2026-09-23T23:53:42.243Z',
    });
    const history = createFirstSeenMetadataIndex();
    history.add({
      ...current,
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/2776/Description/4',
      firstSeenAt: '2026-09-10T23:21:49.331Z',
    });
    history.add({
      ...current,
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/1094/Description/4',
      slug: 'infermiere-a-in-cure-generali-eoc-bellinzona',
      firstSeenAt: '2026-05-21T11:53:54.295Z',
    });

    history.enrichActive([current]);

    expect(current.sourceIdentity).toBe(
      'url:https://recruitingapp-2761.umantis.com/vacancies/2776/description/4',
    );
    expect(current.firstSeenAt).toBe('2026-09-10T23:21:49.331Z');
  });

  it('archives the stable source identity and firstSeenAt for future reintroductions', () => {
    const entry = buildExpiredEntry(job());

    expect(entry.sourceIdentity).toBe(
      'url:https://recruitingapp-2761.umantis.com/vacancies/1373/description/4',
    );
    expect(entry.firstSeenAt).toBe('2026-09-23T23:53:42.243Z');
  });

  it('restores firstSeenAt when a vacancy returns from the expired slice', () => {
    const current = job();
    const result = carryForwardFirstSeenAt([current], {
      archivedJobs: [{
        title: current.title,
        slug: current.slug,
        sourceIdentity: 'url:https://recruitingapp-2761.umantis.com/vacancies/1373/description/4',
        firstSeenAt: '2026-09-19T23:09:25.433Z',
      }],
    });

    expect(current.firstSeenAt).toBe('2026-09-19T23:09:25.433Z');
    expect(result.restored).toBe(1);
    expect(result.suppressed).toBe(0);
  });

  it('keeps multiple source identities when route dedup collapses archive entries', () => {
    const survivor = buildExpiredEntry(job({ firstSeenAt: '2026-09-19T23:09:25.433Z' }));
    const removed = buildExpiredEntry(job({
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/1009/Description/4',
      firstSeenAt: '2026-09-18T23:09:25.433Z',
    }));

    expect(mergeSourceIdentityHistory(survivor, removed)).toBe(true);
    expect(survivor.sourceIdentityHistory).toHaveLength(2);

    const current = job({
      url: 'https://recruitingapp-2761.umantis.com/Vacancies/1009/Description/4',
      firstSeenAt: '2026-09-23T23:53:42.243Z',
    });
    carryForwardFirstSeenAt([current], { archivedJobs: [survivor] });
    expect(current.firstSeenAt).toBe('2026-09-18T23:09:25.433Z');
  });

  it('fails closed for legacy expired entries without firstSeenAt', () => {
    const current = job();
    const result = carryForwardFirstSeenAt([current], {
      archivedJobs: [{ title: current.title, slug: current.slug }],
    });

    expect(current).not.toHaveProperty('firstSeenAt');
    expect(result.suppressed).toBe(1);
    expect(result.suppressedJobs.has(current)).toBe(true);
  });

  it('keeps a legacy reintroduction out of the immediate email candidate set', () => {
    const current = job();
    carryForwardFirstSeenAt([current], {
      archivedJobs: [{ title: current.title, slug: current.slug }],
    });

    expect(
      selectNewlyPublishedJobs([current], Date.parse('2026-09-24T01:41:03.000Z'), 6 * 60 * 60 * 1000),
    ).toEqual([]);
  });

  it('does not suppress a reused source identity when the source title changed', () => {
    const current = job({ title: 'Cuoco/a in dietetica' });
    const result = carryForwardFirstSeenAt([current], {
      archivedJobs: [{
        title: 'Infermiere/a in cure generali',
        sourceIdentity: 'url:https://recruitingapp-2761.umantis.com/vacancies/1373/description/4',
        firstSeenAt: '2026-09-19T23:09:25.433Z',
      }],
    });

    expect(current.firstSeenAt).toBe('2026-09-23T23:53:42.243Z');
    expect(result.restored).toBe(0);
    expect(result.suppressed).toBe(0);
  });

  it('prefers active-slice history over a legacy expired route', () => {
    const current = job();
    const result = carryForwardFirstSeenAt([current], {
      existingJobs: [{
        ...current,
        firstSeenAt: '2026-09-18T12:00:00.000Z',
      }],
      archivedJobs: [{ title: current.title, slug: current.slug }],
    });

    expect(current.firstSeenAt).toBe('2026-09-18T12:00:00.000Z');
    expect(result.suppressed).toBe(0);
  });
});

/**
 * A crawler that writes the listing page as every posting's URL (Galenica:
 * `…/it/jobs/#job.id=<n>`, whose fragment the stable identity strips; État de
 * Vaud: the bare listing URL) gives every posting ONE identity. Measured on
 * 2026-10-05: 106 Galenica postings added in a month, all carrying the
 * crawler's first-run firstSeenAt, so the CompanyAlert sender never saw one as
 * new. The identity must not decide; the posting's own id and slugs do.
 */
describe('carryForwardFirstSeenAt — identity shared by several postings', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
  function galenica(n: number, overrides: Record<string, unknown> = {}) {
    return {
      id: `galenica-${n}`,
      title: 'Farmacista (80-100%)',
      slug: `farmacista-80-100-amavita-galenica-${n}`,
      url: `https://jobs.galenica.com/it/jobs/#job.id=31375${n}.40691${n}`,
      ...overrides,
    };
  }

  it('flags an identity carried by two different postings, not one posting seen twice', () => {
    const a = galenica(1);
    const b = galenica(2);
    const ambiguous = ambiguousJobIdentities([a, b]);
    expect([...ambiguous]).toEqual(['url:https://jobs.galenica.com/it/jobs']);
    expect(ambiguousJobIdentities([a, { ...a }]).size).toBe(0);
  });

  it('flags a replacement when the different postings are split across compared lists', () => {
    const oldPosting = galenica(1);
    const newPosting = galenica(2);
    expect(ambiguousJobIdentities([oldPosting], [newPosting])).toEqual(
      new Set(['url:https://jobs.galenica.com/it/jobs']),
    );
  });

  it('flags a bare listing URL replacement when only the posting keys differ', () => {
    const oldPosting = galenica(1, { url: 'https://example.test/jobs' });
    const newPosting = galenica(2, { url: 'https://example.test/jobs' });
    expect(ambiguousJobIdentities([oldPosting], [newPosting])).toEqual(
      new Set(['url:https://example.test/jobs']),
    );
  });

  it('leaves a NEW posting with the same title and listing URL without an inherited firstSeenAt', () => {
    const firstRun = daysAgo(170);
    const existingJobs = [galenica(1, { firstSeenAt: firstRun }), galenica(2, { firstSeenAt: firstRun })];
    const arrival = galenica(3);
    const result = carryForwardFirstSeenAt([galenica(1), galenica(2), arrival], { existingJobs });

    expect(arrival).not.toHaveProperty('firstSeenAt');
    expect(result.ambiguousIdentities.has('url:https://jobs.galenica.com/it/jobs')).toBe(true);
  });

  it('still carries the history of a continuing posting through its id when its slug changed', () => {
    const firstSeenAt = daysAgo(40);
    const existingJobs = [galenica(1, { firstSeenAt }), galenica(2, { firstSeenAt: daysAgo(10) })];
    const continuing = galenica(1, { slug: 'farmacista-80-100-amavita-galenica-lugano' });
    const result = carryForwardFirstSeenAt([continuing, galenica(2)], { existingJobs });

    expect(continuing.firstSeenAt).toBe(firstSeenAt);
    expect(result.restored).toBeGreaterThanOrEqual(1);
  });

  it('does not hand the only prior posting\'s firstSeenAt to the only new one (review #11732)', () => {
    const existingJobs = [galenica(1, { firstSeenAt: daysAgo(170) })];
    const arrival = galenica(2, { title: galenica(1).title as string });
    carryForwardFirstSeenAt([arrival], { existingJobs });
    expect(arrival).not.toHaveProperty('firstSeenAt');
  });

  it('does not suppress a new posting because an archived sibling shares the listing URL', () => {
    const arrival = galenica(9, { firstSeenAt: daysAgo(0) });
    const result = carryForwardFirstSeenAt([arrival, galenica(1)], {
      archivedJobs: [
        { title: arrival.title, slug: 'farmacista-80-100-amavita-galenica-old-a', url: arrival.url },
        { title: arrival.title, slug: 'farmacista-80-100-amavita-galenica-old-b', url: arrival.url },
      ],
    });

    expect(result.suppressed).toBe(0);
    expect(arrival.firstSeenAt).toBeTruthy();
  });
});
