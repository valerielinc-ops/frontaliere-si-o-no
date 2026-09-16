import { describe, expect, it } from 'vitest';
import {
  buildRelatedClusterManifestInput,
  buildRelatedSitemapManifestInput,
} from '../build-plugins/relatedSearchClustersPlugin';
import {
  computeInputHash,
  getIncrementalManifestMap,
  INCREMENTAL_MANIFEST_ENABLED,
} from '../build-plugins/shared/incrementalManifest.mjs';
import type { RawJob } from '../build-plugins/relatedSearchClustersData';
import { RELATED_CLUSTER_FIXTURE } from './fixtures/related-search-cluster-manifest';

const jobsById = new Map(
  RELATED_CLUSTER_FIXTURE.jobs.map((job) => [job.id, job]),
);

function jobsFor(ids: readonly string[]): RawJob[] {
  return ids.map((id) => {
    const job = jobsById.get(id);
    if (!job) throw new Error(`Unknown fixture job: ${id}`);
    return job;
  });
}

function clusterInput(
  clusterIndex: 0 | 1,
  matchingJobs = jobsFor(RELATED_CLUSTER_FIXTURE.clusters[clusterIndex].matchingJobIds),
  title: string = RELATED_CLUSTER_FIXTURE.clusters[clusterIndex].title,
) {
  const cluster = RELATED_CLUSTER_FIXTURE.clusters[clusterIndex];
  return buildRelatedClusterManifestInput({
    slug: cluster.slug,
    title,
    locale: cluster.locale,
    canton: cluster.canton,
    matchingJobs,
    emission: {
      action: 'full',
      belowFloor: false,
      noindex: false,
      sitemapEligible: true,
    },
    related: [{ keyword: 'engineer', url: '/ricerca-engineer/' }],
    hreflang: [{ locale: 'it', url: `/it/${cluster.slug}/` }],
  });
}

describe('related-search cluster shadow manifest', () => {
  it('uses two fixture clusters and separates job membership from render order', () => {
    expect(RELATED_CLUSTER_FIXTURE.clusters).toHaveLength(2);
    const base = clusterInput(0);
    const reordered = clusterInput(0, [...jobsFor(base.jobs.order.map(({ id }) => id)).reverse()]);

    expect(reordered.jobs.membership).toEqual(base.jobs.membership);
    expect(reordered.jobs.order).not.toEqual(base.jobs.order);
    expect(computeInputHash(reordered, 'related-search-cluster'))
      .not.toBe(computeInputHash(base, 'related-search-cluster'));
  });

  it('changes the cluster hash for membership, job digest, title, or template changes', () => {
    const base = clusterInput(0);
    const membershipChanged = clusterInput(0, jobsFor(['fixture-job-1', 'fixture-job-2', 'fixture-job-4']));
    const titleChanged = clusterInput(0, undefined, 'Titolo aggiornato | Frontaliere Ticino');
    const jobChanged = clusterInput(0, [
      { ...RELATED_CLUSTER_FIXTURE.jobs[0], title: 'Titolo del job aggiornato' },
      ...jobsFor(['fixture-job-2', 'fixture-job-3']),
    ]);

    const hash = (input: unknown, templateVersion = 'related-search-cluster@1') =>
      computeInputHash(input, 'related-search-cluster', templateVersion);
    expect(hash(membershipChanged)).not.toBe(hash(base));
    expect(hash(jobChanged)).not.toBe(hash(base));
    expect(hash(titleChanged)).not.toBe(hash(base));
    expect(hash(base, 'related-search-cluster@2')).not.toBe(hash(base));
  });

  it('excludes the build date and other runtime metadata from cluster hashes', () => {
    const base = clusterInput(1);
    const withRuntimeFields = {
      ...base,
      dateStamp: '2026-09-17',
      lastmod: '2026-09-17',
      'ft-build-id': 'next-build',
    };
    expect(computeInputHash(withRuntimeFields, 'related-search-cluster'))
      .toBe(computeInputHash(base, 'related-search-cluster'));
  });

  it('hashes sitemap membership and order independently, without date churn', () => {
    const base = buildRelatedSitemapManifestInput({
      locale: 'it',
      shardFile: 'sitemap-search-clusters-001.xml',
      locs: [
        'https://frontaliereticino.ch/ricerca-a/',
        'https://frontaliereticino.ch/ricerca-b/',
      ],
    });
    const reordered = buildRelatedSitemapManifestInput({
      locale: 'it',
      shardFile: 'sitemap-search-clusters-001.xml',
      locs: [...base.order].reverse(),
    });
    expect(reordered.membership).toEqual(base.membership);
    expect(reordered.order).not.toEqual(base.order);
    expect(computeInputHash(reordered, 'related-search-sitemap'))
      .not.toBe(computeInputHash(base, 'related-search-sitemap'));
    expect(computeInputHash({ ...base, dateStamp: '2026-09-17' }, 'related-search-sitemap'))
      .toBe(computeInputHash(base, 'related-search-sitemap'));
  });

  it('keeps the manifest path inert when the shadow flag is absent', () => {
    expect(INCREMENTAL_MANIFEST_ENABLED).toBe(false);
    expect(getIncrementalManifestMap('/tmp/related-clusters-test', ['it', 'en'])).toBeNull();
  });
});
