/**
 * #900 — choke-point guard: normalizeParsedJobsForSlice (run by writeJobsCrawlerSlice
 * for every crawler) must never persist `addressLocality: "undefined"`. Google
 * rejects such JobPosting structured data → de-index (AGENTS.md non-negotiable #3).
 * Defends ALL crawlers, not just the ones with their own upstream guard.
 */

import { describe, it, expect } from 'vitest';
import { normalizeParsedJobsForSlice } from '../scripts/assemble-jobs-dataset.mjs';

describe('normalizeParsedJobsForSlice — addressLocality "undefined" guard (#900)', () => {
  it('never persists the literal "undefined" in addressLocality or location', () => {
    const jobs = [{ slug: 'x', addressLocality: 'undefined', location: 'undefined', canton: 'TI' }];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].addressLocality.toLowerCase()).not.toBe('undefined');
    expect(String(jobs[0].location).toLowerCase()).not.toBe('undefined');
  });

  it('keeps a valid addressLocality untouched', () => {
    const jobs = [{ slug: 'x', addressLocality: 'Lugano', location: 'Lugano', canton: 'TI' }];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].addressLocality).toBe('Lugano');
  });

  it('backfills an empty addressLocality from the sanitized location (not "undefined")', () => {
    const jobs = [{ slug: 'x', addressLocality: '', location: 'undefined', canton: 'TI' }];
    normalizeParsedJobsForSlice(jobs);
    expect(jobs[0].addressLocality.toLowerCase()).not.toBe('undefined');
    expect(jobs[0].addressLocality.trim()).not.toBe('');
  });
});
