import { describe, expect, it } from 'vitest';
import {
  buildGuessApplyUrl,
  buildGuessDetailUrl,
  isGuessTicinoWidgetJob,
  parseGuessBullets,
  parseGuessJobDetailPayload,
  parseGuessWidgetJsonp,
  resolveGuessCanton,
  resolveGuessBackfillCanton,
} from '../scripts/lib/guess-job-parser.mjs';

describe('guess-job-parser', () => {
  it('parses workable widget jsonp and keeps ticino jobs', () => {
    const payload = parseGuessWidgetJsonp('/**/whrcallback({"jobs":[{"title":"A","shortcode":"AAA","country":"Switzerland","city":"Bioggio","state":"Ticino"},{"title":"B","shortcode":"BBB","country":"Italy","city":"Milano","state":"Lombardia"}]})');
    expect(payload.jobs).toHaveLength(2);
    expect(payload.jobs.filter(isGuessTicinoWidgetJob).map((job) => job.shortcode)).toEqual(['AAA']);
  });

  it('builds canonical workable urls', () => {
    expect(buildGuessDetailUrl('04327CCE51')).toBe('https://apply.workable.com/guess-europe-sagl/j/04327CCE51/');
    expect(buildGuessApplyUrl('04327CCE51')).toBe('https://apply.workable.com/guess-europe-sagl/j/04327CCE51/apply/');
  });

  it('parses detail payload into rich description and arrays', () => {
    const parsed = parseGuessJobDetailPayload({
      title: 'Customer Service Specialist Jewellery',
      language: 'en',
      type: 'Full-time',
      location: { city: 'Bioggio', region: 'Ticino', countryCode: 'CH', display: 'Bioggio, Ticino, Switzerland' },
      description: '<p>Lead customer service execution.</p><p><strong>Support wholesale markets.</strong></p>',
      requirements: '<ul><li>3 years of experience</li><li>Excellent English</li></ul>',
      benefits: '<ul><li>International environment</li><li>Product discount</li></ul>',
      department: ['Headquarters'],
      published: '2026-02-09T00:00:00.000Z',
    });

    expect(parsed.city).toBe('Bioggio');
    expect(parsed.employmentType).toBe('full-time');
    expect(parsed.requirements).toEqual(['3 years of experience', 'Excellent English']);
    expect(parsed.benefits).toEqual(['International environment', 'Product discount']);
    expect(parsed.description).toContain('Lead customer service execution.');
    expect(parsed.description).toContain('## Requirements');
    expect(parsed.description).toContain('## Benefits');
  });

  it('extracts bullet items from html lists', () => {
    expect(parseGuessBullets('<ul><li>First item</li><li>Second item</li></ul>')).toEqual(['First item', 'Second item']);
  });

  // ── resolveGuessCanton (unresolved-canton skip guard — #3480 sibling of
  // #3466's clariant/swisslog/debiopharm/komax/lindt-spruengli fix.
  // isGuessTicinoWidgetJob() actually admits ANY TARGET_CANTON job, not just
  // Ticino despite the crawler's docstring, so a real but unrecognized city
  // must never fabricate the Bioggio HQ canton, task-critical) ──
  describe('resolveGuessCanton', () => {
    it('resolves a known Ticino city', () => {
      expect(resolveGuessCanton('Bioggio')).toBe('TI');
      expect(resolveGuessCanton('Stabio')).toBe('TI');
    });

    it('resolves a known Swiss city outside Ticino via generic inference', () => {
      expect(resolveGuessCanton('Bern')).toBe('BE');
    });

    it('falls back to the Bioggio HQ canton when no city text was scraped at all', () => {
      expect(resolveGuessCanton('')).toBe('TI');
    });

    it('returns null (skip) when city text is present but unresolvable — never fabricates the HQ canton', () => {
      expect(resolveGuessCanton('Nonexistentburg')).toBeNull();
    });

    it('does NOT fabricate TI for the negative-control case (Bern, not TI)', () => {
      expect(resolveGuessCanton('Bern')).not.toBe('TI');
    });
  });

  // ── resolveGuessBackfillCanton (postProcessJobs() backfill guard — #3480,
  // the item this issue was filed for. An already-published job is never
  // dropped: a real-but-unresolvable location earns a needsCantonReview
  // flag, the safe-default canton is always still returned) ──
  describe('resolveGuessBackfillCanton', () => {
    it('resolves a known city with no review flag', () => {
      expect(resolveGuessBackfillCanton('Bioggio')).toEqual({ canton: 'TI', needsCantonReview: false });
    });

    it('falls back to the HQ canton with no review flag when there is no location text at all', () => {
      expect(resolveGuessBackfillCanton('')).toEqual({ canton: 'TI', needsCantonReview: false });
    });

    it('falls back to the HQ canton BUT flags needsCantonReview for a real, unresolvable location', () => {
      expect(resolveGuessBackfillCanton('Nonexistentburg')).toEqual({ canton: 'TI', needsCantonReview: true });
    });
  });
});
