import { describe, expect, it } from 'vitest';

import {
  applyRecoveredSlug,
  buildRecoveryEvidenceIndex,
  createRecoveryPlanReport,
  denylistKey,
  planSliceSlugRecovery,
} from '../scripts/backfill-prev-slugs-from-loss-events.mjs';

const FILE = 'rittmeyer-ag.json';
const RITTMEYER_URL = 'https://karriere.rittmeyer.com/offene-stellen/sales-project-engineer-a-ticino/';
const RITTMEYER_SLUG = 'sales-project-engineer-a-ticino-rittmeyer-ag-tessin';

function evidence(revisions: Array<{ commit: string; jobs: object[] }>) {
  return buildRecoveryEvidenceIndex(revisions);
}

function plan({
  entries = [{ jobId: 'stale-id', slugs: [RITTMEYER_SLUG] }],
  currentJobs,
  revisions,
  denylist = new Set<string>(),
}: {
  entries?: Array<{ jobId: string; slugs: string[] }>;
  currentJobs: object[];
  revisions: Array<{ commit: string; jobs: object[] }>;
  denylist?: Set<string>;
}) {
  return planSliceSlugRecovery({
    file: FILE,
    entries,
    currentJobs,
    evidenceBySlug: evidence(revisions),
    denylist,
  });
}

describe('previousSlugs Git recovery plan', () => {
  it('binds the historical slug to the unique source posting, never the stale input id owner', () => {
    const historicalRittmeyer = {
      id: 'stale-id',
      url: RITTMEYER_URL,
      slugByLocale: { it: RITTMEYER_SLUG },
    };
    const currentRittmeyer = {
      id: 'rittmeyer-current',
      url: RITTMEYER_URL,
      previousSlugsByLocale: {},
      previousSlugs: [],
    };
    const unrelatedCurrentHolderOfStaleId = {
      id: 'stale-id',
      url: 'https://vitrea.example/jobs/apprendistato-salute',
      previousSlugsByLocale: {},
      previousSlugs: [],
    };

    const [item] = plan({
      currentJobs: [unrelatedCurrentHolderOfStaleId, currentRittmeyer],
      revisions: [{ commit: 'b'.repeat(40), jobs: [historicalRittmeyer] }],
    });

    expect(item).toMatchObject({
      decision: 'restore',
      reason: 'unique_historical_proof',
      targetJobId: 'rittmeyer-current',
      locale: 'it',
      evidenceKind: 'active',
      revisions: ['b'.repeat(40)],
    });
    expect(item.targetJob).toBe(currentRittmeyer);
  });

  it('prefers an active locale observation over contaminated historical buckets', () => {
    const slug = 'nous-recrutons-un-e-physiotherapeute-a-temps-partiel-morges';
    const url = 'https://physioswiss.ch/stelleninserate/157738/nous-recrutons/';
    const historical = {
      id: 'physio-old',
      url,
      slugByLocale: { fr: slug },
      previousSlugsByLocale: { it: [slug], en: [slug] },
    };
    const current = {
      id: 'physio-current',
      url,
      previousSlugsByLocale: {},
      previousSlugs: [],
    };

    const [item] = plan({
      entries: [{ jobId: 'physio-old', slugs: [slug] }],
      currentJobs: [current],
      revisions: [{ commit: 'a'.repeat(40), jobs: [historical] }],
    });

    expect(item).toMatchObject({ decision: 'restore', locale: 'fr', evidenceKind: 'active' });
  });

  it('uses persisted sourceIdentityHistory only on the current side to bridge a source URL rename', () => {
    const oldUrl = 'https://jobs.example.test/vacancies/old-source-id';
    const current = {
      id: 'renamed-current',
      url: 'https://jobs.example.test/vacancies/new-source-id',
      sourceIdentityHistory: [{ sourceIdentity: `url:${oldUrl}` }],
      previousSlugsByLocale: {},
      previousSlugs: [],
    };

    const [item] = plan({
      currentJobs: [current],
      revisions: [{
        commit: 'c'.repeat(40),
        jobs: [{ id: 'old', url: oldUrl, previousSlugsByLocale: { it: [RITTMEYER_SLUG] } }],
      }],
    });

    expect(item).toMatchObject({ decision: 'restore', targetJobId: 'renamed-current', locale: 'it' });
  });

  it('rejects case-distinct source references when the source URL also changed', () => {
    const [item] = plan({
      currentJobs: [{
        id: 'current',
        url: 'https://jobs.example.test/vacancies/current',
        sourceReference: 'abc',
      }],
      revisions: [{
        commit: 'c'.repeat(40),
        jobs: [{
          id: 'old',
          url: 'https://jobs.example.test/vacancies/old',
          sourceReference: 'ABC',
          previousSlugsByLocale: { it: [RITTMEYER_SLUG] },
        }],
      }],
    });

    expect(item).toMatchObject({ decision: 'reject', reason: 'historical_posting_not_current' });
  });

  it('rejects a slug observed as active in more than one locale', () => {
    const current = { id: 'current', url: RITTMEYER_URL };
    const [item] = plan({
      currentJobs: [current],
      revisions: [{
        commit: 'd'.repeat(40),
        jobs: [{ id: 'old', url: RITTMEYER_URL, slugByLocale: { it: RITTMEYER_SLUG, fr: RITTMEYER_SLUG } }],
      }],
    });

    expect(item).toMatchObject({
      decision: 'reject',
      reason: 'ambiguous_historical_locale',
      locales: ['fr', 'it'],
    });
  });

  it('rejects duplicate current owners of the same source identity', () => {
    const [item] = plan({
      currentJobs: [
        { id: 'current-a', url: RITTMEYER_URL },
        { id: 'current-b', url: RITTMEYER_URL },
      ],
      revisions: [{
        commit: 'e'.repeat(40),
        jobs: [{ id: 'old', url: RITTMEYER_URL, slugByLocale: { it: RITTMEYER_SLUG } }],
      }],
    });

    expect(item).toMatchObject({ decision: 'reject', reason: 'ambiguous_current_source_owner' });
  });

  it('keeps denylisted routes in the report but never plans a write', () => {
    const [item] = plan({
      currentJobs: [{ id: 'current', url: RITTMEYER_URL }],
      revisions: [{
        commit: 'f'.repeat(40),
        jobs: [{ id: 'old', url: RITTMEYER_URL, slugByLocale: { it: RITTMEYER_SLUG } }],
      }],
      denylist: new Set([denylistKey(FILE, RITTMEYER_SLUG)]),
    });

    expect(item).toEqual(expect.objectContaining({ decision: 'reject', reason: 'denylisted' }));
  });

  it('is idempotent: after one proven restore the next plan is a no-op', () => {
    const current = {
      id: 'current',
      url: RITTMEYER_URL,
      previousSlugsByLocale: {},
      previousSlugs: [],
    };
    const revisions = [{
      commit: '1'.repeat(40),
      jobs: [{ id: 'old', url: RITTMEYER_URL, slugByLocale: { it: RITTMEYER_SLUG } }],
    }];
    const [first] = plan({ currentJobs: [current], revisions });
    expect(first.decision).toBe('restore');
    expect(applyRecoveredSlug(first.targetJob, first.locale, first.slug)).toEqual({
      restored: true,
      skippedAtCap: false,
    });
    const afterFirst = JSON.stringify(current);

    const [second] = plan({ currentJobs: [current], revisions });
    expect(second).toMatchObject({ decision: 'noop', reason: 'already_present' });
    expect(JSON.stringify(current)).toBe(afterFirst);
  });

  it('emits the same report regardless of input ordering and omits mutable job objects', () => {
    const base = {
      file: FILE,
      inputJobId: 'b',
      slug: 'slug-b',
      decision: 'reject',
      reason: 'no_localized_history',
      targetJob: { id: 'must-not-leak' },
    };
    const other = {
      file: FILE,
      inputJobId: 'a',
      slug: 'slug-a',
      decision: 'noop',
      reason: 'already_present',
      targetJob: { id: 'also-private' },
    };

    const forward = createRecoveryPlanReport([base, other]);
    const reverse = createRecoveryPlanReport([other, base]);

    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
    expect(forward).toMatchObject({
      version: 1,
      summary: { requested: 2, restore: 0, noop: 1, rejected: 1 },
    });
    expect(JSON.stringify(forward)).not.toContain('must-not-leak');
    expect(forward.items.map((item) => item.inputJobId)).toEqual(['a', 'b']);
  });
});
