/**
 * Regression 2026-05-19 — JobBoard legacy-fallback canton filter.
 *
 * Context: the per-canton shards at /data/jobs-by-canton/{CODE}.json are not
 * yet emitted in production (every shard 404s). JobBoard's fallback path
 * loads the locale-wide monolith (`/data/jobs-it.json`, ~13 MB, TI-dominant).
 * Without a post-filter, every non-TI /cerca-lavoro-{canton}/ SERP renders a
 * TI-biased listing — user-visible bug reported on /cerca-lavoro-basilea/.
 *
 * `scopeJobsToCanton` is the pure helper that filters the legacy payload to
 * the URL-driven canton before it reaches React state. Aggregator routes
 * (`_AGGREGATE_`) keep the full list.
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
});
