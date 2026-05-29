/**
 * #900 — choke-point guard: normalizeParsedJobsForSlice (run by writeJobsCrawlerSlice
 * for every crawler) must never persist `addressLocality: "undefined"`. Google
 * rejects such JobPosting structured data → de-index (AGENTS.md non-negotiable #3).
 * Defends ALL crawlers, not just the ones with their own upstream guard.
 */

import { describe, it, expect } from 'vitest';
import { normalizeParsedJobsForSlice } from '../scripts/assemble-jobs-dataset.mjs';

describe('normalizeParsedJobsForSlice — addressLocality "undefined" guard (#900)', () => {
  it('rewrites literal "undefined" addressLocality + location to the safe canton default', () => {
    const jobs = [{ slug: 'x', addressLocality: 'undefined', location: 'undefined', canton: 'TI' }];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].addressLocality).toBe('Ticino'); // exact: the choke-point fallback
    expect(jobs[0].location).toBe('Ticino');
  });

  it('keeps a valid addressLocality untouched', () => {
    const jobs = [{ slug: 'x', addressLocality: 'Lugano', location: 'Lugano', canton: 'TI' }];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].addressLocality).toBe('Lugano');
  });

  it('backfills an empty addressLocality from the sanitized location (→ "Ticino", not "undefined")', () => {
    const jobs = [{ slug: 'x', addressLocality: '', location: 'undefined', canton: 'TI' }];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].addressLocality).toBe('Ticino'); // exact: location sanitized first, then backfilled
  });
});
