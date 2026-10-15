import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  aggregateHealthFacilityJobs,
  _resetHealthFacilityJobsAggregateCache,
} from '../../build-plugins/healthFacilitiesJobsAggregate';
import { getHealthFacility } from '../../build-plugins/healthFacilitiesData';
import { renderFacilityPage } from '../../build-plugins/healthFacilitiesPlugin';

const tempRoots: string[] = [];

function fixtureRoot(jobCount: number): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-facility-jobs-'));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  const jobs = Array.from({ length: jobCount }, (_, index) => ({
    id: `usz-fixture-${index + 1}`,
    slug: `usz-fixture-job-${index + 1}`,
    title: `Pflegefachperson USZ ${index + 1}`,
    company: 'Universitätsspital Zürich (USZ)',
    companyKey: 'usz',
    canton: 'ZH',
    addressLocality: 'Zürich',
    contract: 'full-time',
    postedDate: '2026-09-01T00:00:00.000Z',
    firstSeenAt: '2026-09-01T00:00:00.000Z',
    url: `https://example.test/usz-${index + 1}`,
  }));
  fs.writeFileSync(path.join(root, 'data', 'jobs.json'), JSON.stringify(jobs));
  return root;
}

afterEach(() => {
  _resetHealthFacilityJobsAggregateCache();
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('health-facility visible inventory', () => {
  it('keeps all valid live jobs while bounding only the schema projection', () => {
    const root = fixtureRoot(8);
    const snapshot = aggregateHealthFacilityJobs(root, Date.parse('2026-09-14T00:00:00.000Z')).get('usz');

    expect(snapshot).toBeDefined();
    expect(snapshot?.liveCount).toBe(8);
    expect(snapshot?.jobs).toHaveLength(8);
    expect(snapshot?.featured).toHaveLength(6);
    expect(new Set(snapshot?.jobs.map((job) => job.id)).size).toBe(8);
  });

  it('renders the complete list and keeps in-feed ads on the shared cadence', () => {
    const root = fixtureRoot(8);
    const facility = getHealthFacility('usz');
    const snapshot = aggregateHealthFacilityJobs(root, Date.parse('2026-09-14T00:00:00.000Z')).get('usz');
    if (!facility || !snapshot) throw new Error('USZ fixture did not aggregate');

    const { html } = renderFacilityPage('it', facility, snapshot, '2026-09-14', root);
    expect((html.match(/<article /g) || []).length).toBe(8);
    expect((html.match(/class="ft-infeed-ad/g) || []).length).toBe(2);
    expect(html).not.toContain('"@type":"JobPosting"');
    expect(html).toContain('"@type":"ItemList"');
    expect((html.match(/"@type":"WebPage"/g) || []).length).toBe(6);
  });

  it('keeps long facility titles distinct after the metadata cap', () => {
    const root = fixtureRoot(8);
    const facility = getHealthFacility('usz');
    const snapshot = aggregateHealthFacilityJobs(root, Date.parse('2026-09-14T00:00:00.000Z')).get('usz');
    if (!facility || !snapshot) throw new Error('USZ fixture did not aggregate');

    // The source names differ only after the 66-character SERP budget. The
    // route-derived token must survive the metadata-only cap, while the
    // visible H1/body/schema keep their complete source names.
    const prefix = 'N'.repeat(70);
    const first = renderFacilityPage(
      'it',
      { ...facility, slug: 'fixture-long-facility-a', name: `${prefix}A` },
      snapshot,
      '2026-09-14',
      root,
    ).html;
    const second = renderFacilityPage(
      'it',
      { ...facility, slug: 'fixture-long-facility-b', name: `${prefix}B` },
      snapshot,
      '2026-09-14',
      root,
    ).html;
    const title = (html: string): string => html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';

    const firstTitle = title(first);
    const secondTitle = title(second);
    expect(firstTitle.length).toBeLessThanOrEqual(66);
    expect(secondTitle.length).toBeLessThanOrEqual(66);
    expect(firstTitle).not.toBe(secondTitle);
    expect(first).toContain(`${prefix}A`);
    expect(second).toContain(`${prefix}B`);
  });

  it('caps facility titles after HTML escaping metadata names', () => {
    const root = fixtureRoot(8);
    const facility = getHealthFacility('usz');
    const snapshot = aggregateHealthFacilityJobs(root, Date.parse('2026-09-14T00:00:00.000Z')).get('usz');
    if (!facility || !snapshot) throw new Error('USZ fixture did not aggregate');

    const html = renderFacilityPage(
      'it',
      {
        ...facility,
        slug: 'fixture-escaped-facility',
        name: `${'N'.repeat(70)} &A<Z>\"`,
      },
      snapshot,
      '2026-09-14',
      root,
    ).html;
    const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '';

    // This is the serialized title seen by the crawler: & becomes &amp; and
    // the other reserved characters expand as well.
    expect(title.length).toBeLessThanOrEqual(66);
  });

  it('keeps a production-sized complete facility inventory under the finite weight ceiling', () => {
    const root = fixtureRoot(411);
    const facility = getHealthFacility('usz');
    const snapshot = aggregateHealthFacilityJobs(root, Date.parse('2026-09-14T00:00:00.000Z')).get('usz');
    if (!facility || !snapshot) throw new Error('USZ fixture did not aggregate');

    const { html } = renderFacilityPage('it', facility, snapshot, '2026-09-14', root);
    expect(Buffer.byteLength(html, 'utf8')).toBeLessThanOrEqual(640 * 1024);
    expect((html.match(/<article /g) || []).length).toBe(411);
    expect((html.match(/class="ft-infeed-ad/g) || []).length).toBe(12);
  });
});
