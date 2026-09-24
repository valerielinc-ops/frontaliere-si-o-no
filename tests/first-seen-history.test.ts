import { describe, expect, it } from 'vitest';
import {
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
