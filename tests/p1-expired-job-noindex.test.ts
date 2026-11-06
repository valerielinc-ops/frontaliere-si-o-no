/**
 * P1 noindex plan (2026-10-24): expired-job soft-landings leave the index 30
 * days after expiry unless Search Console still shows them. Robots and sitemap
 * only — page, links and JSON-LD stay (another agent owns JobPosting).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPIRED_JOB_INDEX_GRACE_DAYS,
  isExpiredJobDemandIndexable,
} from '../build-plugins/shared/expiredJobIndexPolicy';
import { buildExpiredSoftLandingPageInput } from '../build-plugins/shared/incrementalManifest.mjs';

const NOW = Date.parse('2026-10-24T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const none = { active: true, hasImpressions: () => false };
const any = { active: true, hasImpressions: () => true };
const paths = ['/cerca-lavoro-ticino/x/', '/en/find-jobs-ticino/x/'];

describe('isExpiredJobDemandIndexable', () => {
  it('keeps a job that expired less than 30 days ago', () => {
    expect(EXPIRED_JOB_INDEX_GRACE_DAYS).toBe(30);
    expect(isExpiredJobDemandIndexable({ expiredAt: daysAgo(29), paths }, none, NOW)).toBe(true);
  });

  it('noindexes an older job without impressions, keeps it with impressions', () => {
    expect(isExpiredJobDemandIndexable({ expiredAt: daysAgo(31), paths }, none, NOW)).toBe(false);
    expect(isExpiredJobDemandIndexable({ expiredAt: daysAgo(31), paths }, any, NOW)).toBe(true);
  });

  it('probes every path of the job', () => {
    const asked: string[][] = [];
    const probe = { active: true, hasImpressions: (p: readonly string[]) => { asked.push([...p]); return false; } };
    isExpiredJobDemandIndexable({ expiredAt: daysAgo(60), paths }, probe, NOW);
    expect(asked).toEqual([paths]);
  });

  it('never noindexes on unknown age or dormant evidence', () => {
    expect(isExpiredJobDemandIndexable({ expiredAt: '', paths }, none, NOW)).toBe(true);
    expect(isExpiredJobDemandIndexable({ expiredAt: 'not-a-date', paths }, none, NOW)).toBe(true);
    expect(isExpiredJobDemandIndexable(
      { expiredAt: daysAgo(400), paths },
      { active: false, hasImpressions: () => false },
      NOW,
    )).toBe(true);
  });
});

describe('expired soft-landing incremental input', () => {
  const base = {
    job: { slug: 'x' }, locale: 'it', slug: 'x', path: '/cerca-lavoro-ticino/x/', title: 'X',
    trackingPaths: { it: '/cerca-lavoro-ticino/x/' }, company: '', location: '', canton: 'TI',
    sector: '', contract: '', datePosted: '', expiredAt: daysAgo(40), gscQueries: [],
    currentYear: 2026, candidatePaths: [], prosePaths: [], keepProse: false, action: 'full',
    expiredPayloadJson: '', postalCode: '', derivedFromUnhashedSource: false,
  };

  it('an indexable page keeps its pre-P1 input (no needless re-render)', () => {
    expect(buildExpiredSoftLandingPageInput({ ...base } as any))
      .toEqual(buildExpiredSoftLandingPageInput({ ...base, demandIndexable: true } as any));
  });

  it('a demand-noindexed page changes its input, so a cached index,follow page is not reused', () => {
    const noindexed = buildExpiredSoftLandingPageInput({ ...base, demandIndexable: false } as any);
    expect(noindexed).toMatchObject({ demandNoindex: true });
  });
});

describe('jobsSeoPagesPlugin wiring', () => {
  const src = fs.readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'build-plugins/jobsSeoPagesPlugin.ts'),
    'utf8',
  );

  it('the robots verdict and the expired sitemap read the same per-job variable', () => {
    expect(src).toMatch(/\} else if \(!expiredDemandIndexable\) \{\s*\n[^\n]*\n[^\n]*\n\s*expiredRobotsTag = ROBOTS_NOINDEX_FOLLOW;/);
    expect(src).toMatch(/if \(itPath && expiredDemandIndexable && itBodyWordCount >= MIN_INDEXABLE_WORDS/);
    expect(src).toMatch(/demandIndexable: expiredDemandIndexable,/);
  });
});
