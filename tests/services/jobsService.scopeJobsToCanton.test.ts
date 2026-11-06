/**
 * Regression 2026-05-19 — JobBoard legacy-fallback canton filter.
 *
 * Context: when this regression was filed the per-canton shards at
 * /data/jobs-by-canton/ were not emitted at all (every shard 404'd), so
 * JobBoard's fallback path loaded the locale-wide corpus and filtered it
 * client-side. Without that post-filter every non-TI /cerca-lavoro-{canton}/
 * SERP rendered a TI-biased listing — user-visible bug reported on
 * /cerca-lavoro-basilea/.
 *
 * `scopeJobsToCanton` is the pure helper that filters the corpus to the
 * URL-driven canton before it reaches React state. Aggregator routes
 * (`_AGGREGATE_`) keep the full list.
 *
 * STILL LOAD-BEARING after the shard pipeline landed (S10a, 2026-08-07), for
 * two reasons: it remains the filter on the fallback path (shard 404 / CDN
 * lag), and it is now also the SPECIFICATION of what a shard contains —
 * `buildCantonShards(index)[KEY]` is asserted equal to `scopeJobsToCanton(
 * index, KEY)` in tests/job-canton-shards.test.ts, which is what proves
 * sharding did not change any canton SERP's contents.
 */

import { describe, it, expect } from 'vitest';
import {
  scopeJobsToCanton,
  AGGREGATE_CANTON_CODE,
} from '@/services/jobsService';

type Fixture = { id: string; canton?: string | null };

const FIXTURE: Fixture[] = [
  { id: 'a', canton: 'TI' },
  { id: 'b', canton: 'TI' },
  { id: 'c', canton: 'BL' },
  { id: 'd', canton: 'BS' },
  { id: 'e', canton: 'ZH' },
  { id: 'f', canton: null },
  { id: 'g' }, // canton field absent
];

describe('scopeJobsToCanton', () => {
  it('filters legacy payload to the target canton', () => {
    const scoped = scopeJobsToCanton(FIXTURE, 'BL');
    expect(scoped.map((j) => j.id)).toEqual(['c']);
  });

  it('TI bias regression: BL request must NOT leak TI jobs', () => {
    const scoped = scopeJobsToCanton(FIXTURE, 'BL');
    expect(scoped.every((j) => j.canton === 'BL')).toBe(true);
    expect(scoped.some((j) => j.canton === 'TI')).toBe(false);
  });

  it('aggregator sentinel preserves the full payload', () => {
    const scoped = scopeJobsToCanton(FIXTURE, AGGREGATE_CANTON_CODE);
    expect(scoped).toHaveLength(FIXTURE.length);
    expect(scoped.map((j) => j.id)).toEqual(FIXTURE.map((j) => j.id));
  });

  it('aggregator returns a defensive copy (caller can mutate without side effects)', () => {
    const scoped = scopeJobsToCanton(FIXTURE, AGGREGATE_CANTON_CODE);
    scoped.pop();
    expect(FIXTURE).toHaveLength(7);
  });

  it('unknown canton yields empty array (no silent fallthrough)', () => {
    const scoped = scopeJobsToCanton(FIXTURE, 'XX');
    expect(scoped).toEqual([]);
  });

  it('jobs with null/missing canton are dropped (strict equality)', () => {
    const scoped = scopeJobsToCanton(FIXTURE, 'TI');
    expect(scoped.map((j) => j.id).sort()).toEqual(['a', 'b']);
  });

  // Regression 2026-05-19: BASILEA and APPENZELLO are URL group codes that
  // expand to multiple BFS members. Jobs always carry the BFS code
  // (BL/BS/AI/AR) — never the group key. Without expansion the filter
  // returned 0 rows on /cerca-lavoro-basilea/ and /cerca-lavoro-appenzello/.
  it('BASILEA group code expands to BL+BS members', () => {
    const scoped = scopeJobsToCanton(FIXTURE, 'BASILEA');
    expect(scoped.map((j) => j.id).sort()).toEqual(['c', 'd']);
  });

  it('APPENZELLO group expansion: jobs in AI/AR surface when none in fixture exists', () => {
    const fixture: Fixture[] = [
      { id: '1', canton: 'AI' },
      { id: '2', canton: 'AR' },
      { id: '3', canton: 'TI' },
    ];
    const scoped = scopeJobsToCanton(fixture, 'APPENZELLO');
    expect(scoped.map((j) => j.id).sort()).toEqual(['1', '2']);
  });

  it('case-insensitive group code resolution', () => {
    const scoped = scopeJobsToCanton(FIXTURE, 'basilea');
    expect(scoped.map((j) => j.id).sort()).toEqual(['c', 'd']);
  });
});
