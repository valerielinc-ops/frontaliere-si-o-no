import { describe, expect, it } from 'vitest';
import {
  buildSectorHubDiscoveryReport,
  type DiscoveryJob,
  type TrafficSnapshot,
} from '../scripts/lib/sector-hub-discovery';

const DESCRIPTION = Array.from({ length: 60 }, () => 'contenuto').join(' ');

function jobsAt(now: Date, count = 15): DiscoveryJob[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `ocean-${index}`,
    slug: `ocean-${index}`,
    title: 'Specialista operativo',
    description: DESCRIPTION,
    category: 'analisi oceanografica',
    company: `Datore ${index % 5}`,
    canton: 'TI',
    firstSeenAt: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
  }));
}

function reportAt(
  now: Date,
  jobs: readonly DiscoveryJob[],
  previous?: { candidates?: Array<Record<string, unknown>> },
) {
  const popularity = Object.fromEntries(jobs.map((job) => [job.slug, 1]));
  const traffic: TrafficSnapshot = {
    generatedAt: now.toISOString(),
    window: { startDate: '2026-09-21', endDate: '2026-10-19' },
    gsc: { queries: {}, pages: {} },
    ga4: { pages: {} },
  };
  return buildSectorHubDiscoveryReport({
    jobs,
    popularity,
    popularityScannedAt: now.toISOString(),
    traffic,
    previous,
    now,
  });
}

describe('sector-hub discovery candidate history', () => {
  it('persists observations so three consecutive reports become eligible', () => {
    const dates = [
      new Date('2026-10-05T12:00:00.000Z'),
      new Date('2026-10-12T12:00:00.000Z'),
      new Date('2026-10-19T12:00:00.000Z'),
    ];
    let previous: { candidates?: Array<Record<string, unknown>> } | undefined;
    let report;
    for (const now of dates) {
      report = reportAt(now, jobsAt(now), previous);
      previous = { candidates: report.candidates as Array<Record<string, unknown>> };
    }

    const candidate = report!.candidates.find((row) => row.suggestedSlug === 'analisi-oceanografica');
    expect(candidate).toMatchObject({
      suggestedSlug: 'analisi-oceanografica',
      status: 'eligible-for-review',
      consecutiveWeeks: 3,
    });
    expect(candidate?.observedWeeks).toHaveLength(3);
  });

  it('retains a prior candidate as dormant when only two jobs remain active', () => {
    const firstNow = new Date('2026-10-12T12:00:00.000Z');
    const first = reportAt(firstNow, jobsAt(firstNow, 3));
    const secondNow = new Date('2026-10-19T12:00:00.000Z');
    const second = reportAt(secondNow, jobsAt(secondNow, 2), {
      candidates: first.candidates as Array<Record<string, unknown>>,
    });

    const candidate = second.candidates.find((row) => row.suggestedSlug === 'analisi-oceanografica');
    expect(candidate).toMatchObject({
      suggestedSlug: 'analisi-oceanografica',
      status: 'dormant',
      activeJobCount: 0,
    });
  });
});
