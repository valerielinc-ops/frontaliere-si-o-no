import { describe, expect, it } from 'vitest';
import { computeCrawlDiff, snapshotJobSlugs } from '../scripts/jobs-url-helper.mjs';
import { computeSlicePartition } from '../scripts/lib/crawler-summary-partition.mjs';

/**
 * A crawler whose only URL is the listing page gives every posting the same
 * stable identity: Galenica writes `…/it/jobs/#job.id=<n>` and the identity
 * strips the fragment, État de Vaud writes the bare listing URL. Measured on
 * 2026-10-05: 374 jobs in 7 slices share an identity with another posting.
 * Keyed on that identity alone, a posting that left the source was never
 * "removed" (no soft-landing archive) and a new one was never "new".
 */
function galenica(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `galenica-${n}`,
    title: `Farmacista ${n}`,
    slug: `farmacista-${n}-amavita-galenica`,
    url: `https://jobs.galenica.com/it/jobs/#job.id=31375${n}.40691${n}`,
    company: 'Amavita (Galenica)',
    location: 'Lugano',
    ...overrides,
  };
}

describe('computeCrawlDiff — postings that share the listing URL', () => {
  it('reports the posting that left the source as removed and the arrival as new', () => {
    const before = snapshotJobSlugs([galenica(1), galenica(2), galenica(3)]);
    const after = snapshotJobSlugs([galenica(1), galenica(3), galenica(4)]);
    const diff = computeCrawlDiff(before, after);

    expect(diff.removedJobs.map((job) => job.id)).toEqual(['galenica-2']);
    expect(diff.newJobs.map((job) => job.id)).toEqual(['galenica-4']);
    expect(diff.unchangedCount).toBe(2);
  });

  it('still pairs the last remaining posting with its own history', () => {
    const before = snapshotJobSlugs([galenica(1), galenica(2)]);
    const after = snapshotJobSlugs([galenica(2, { title: 'Farmacista 2 (80%)' })]);
    const diff = computeCrawlDiff(before, after);

    expect(diff.removedJobs.map((job) => job.id)).toEqual(['galenica-1']);
    expect(diff.updatedJobs.map((job) => job.id)).toEqual(['galenica-2']);
    expect(diff.newJobs).toEqual([]);
  });

  it('keeps the one-to-one lookup for ordinary per-posting URLs', () => {
    const job = (n: number) => ({ id: `x-${n}`, slug: `x-${n}`, url: `https://example.invalid/jobs/${n}`, title: `T${n}` });
    const diff = computeCrawlDiff(snapshotJobSlugs([job(1), job(2)]), snapshotJobSlugs([job(2), job(3)]));
    expect(diff.removedJobs.map((j) => j.id)).toEqual(['x-1']);
    expect(diff.newJobs.map((j) => j.id)).toEqual(['x-3']);
  });
});

describe('computeSlicePartition — postings that share the listing URL', () => {
  it('counts the arrival as new and the departure as removed', () => {
    const partition = computeSlicePartition(
      [galenica(1), galenica(2)],
      [galenica(1), galenica(3)],
    );
    expect(partition.newJobs.map((job) => job.id)).toEqual(['galenica-3']);
    expect(partition.removedJobs.map((job) => job.id)).toEqual(['galenica-2']);
    expect(partition.unchangedJobs.map((job) => job.id)).toEqual(['galenica-1']);
    expect(partition.total).toBe(2);
  });
});
