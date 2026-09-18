import { describe, expect, it } from 'vitest';
import {
  isDebiopharmSwissJob,
  isVerifiedEmptyDebiopharmCareersSource,
  parseDebiopharmJobDetailPayload,
} from '../scripts/lib/debiopharm-job-parser.mjs';
import { buildDebiopharmJob, resolveDebiopharmBackfillCanton } from '../scripts/update-debiopharm-jobs.mjs';

describe('debiopharm-job-parser', () => {
  describe('careers source completeness', () => {
    it('accepts zero only with the explicit source empty-state marker and no Workable link', () => {
      expect(isVerifiedEmptyDebiopharmCareersSource(
        '<div class="u-section-open-position-list__list-no-result">There are currently no positions matching your criteria.</div>',
      )).toBe(true);
      expect(isVerifiedEmptyDebiopharmCareersSource(
        '<div class="u-section-open-position-list__list-no-result">There are currently no positions matching your criteria.</div><a href="https://apply.workable.com/debiopharm/j/ABC123">Scientist</a>',
      )).toBe(false);
      expect(isVerifiedEmptyDebiopharmCareersSource('<main>Careers</main>')).toBe(false);
    });
  });

  // ── parseDebiopharmJobDetailPayload.inferredCanton (unresolved-canton skip guard — task-critical) ──
  describe('inferredCanton', () => {
    it('resolves a known Swiss city/region to its canton', () => {
      const parsed = parseDebiopharmJobDetailPayload({
        title: 'Scientist',
        location: { city: 'Lausanne', region: 'Vaud', countryCode: 'CH' },
      });
      expect(parsed.inferredCanton).toBe('VD');
    });

    it('does not invent a canton when no source location text was scraped', () => {
      const parsed = parseDebiopharmJobDetailPayload({
        title: 'Scientist',
        location: { city: '', region: '', countryCode: 'CH' },
      });
      expect(parsed.city).toBe('');
      expect(parsed.region).toBe('');
      expect(parsed.inferredCanton).toBeNull();
    });

    it('returns null (skip) when real city/region text is present but unresolvable — never fabricates the HQ canton', () => {
      const parsed = parseDebiopharmJobDetailPayload({
        title: 'Scientist',
        location: { city: 'Nonexistentburg', region: 'Nonexistentregion', countryCode: 'CH' },
      });
      expect(parsed.inferredCanton).toBeNull();
    });

    it('does not treat an explicit foreign locality as Swiss even when country says CH', () => {
      expect(isDebiopharmSwissJob({
        location: { city: 'Como', region: 'Lombardia', countryCode: 'CH' },
      })).toBe(false);
    });

    it('requires a concrete Swiss locality for authoritative publication', () => {
      expect(isDebiopharmSwissJob(
        { location: { countryCode: 'CH' } },
        '',
        { requireConcreteLocation: true },
      )).toBe(false);
      expect(isDebiopharmSwissJob(
        { location: { countryCode: 'CH' } },
        'Lausanne, Vaud',
        { requireConcreteLocation: true },
      )).toBe(true);
    });

    it('does NOT fabricate VD for the negative-control case (Bern, not VD)', () => {
      const parsed = parseDebiopharmJobDetailPayload({
        title: 'Scientist',
        location: { city: 'Bern', region: '', countryCode: 'CH' },
      });
      expect(parsed.inferredCanton).toBe('BE');
      expect(parsed.inferredCanton).not.toBe('VD');
    });
  });

  // ── buildDebiopharmJob wiring (update-debiopharm-jobs.mjs — regression) ──
  // Admission requires a concrete source-backed Swiss locality; the employer
  // headquarters is not a substitute for a missing Workable location.
  describe('buildDebiopharmJob (skip-guard wiring, not just the parser in isolation)', () => {
    it('returns null (skips) for an empty city + a genuinely unresolvable region', () => {
      const job = buildDebiopharmJob(
        { shortcode: 'abc123', title: 'Scientist' },
        { title: 'Scientist', location: { city: '', region: 'Nonexistentregion', countryCode: 'CH' } },
      );
      expect(job).toBeNull();
    });

    it('still builds a real job for a resolvable city', () => {
      const job = buildDebiopharmJob(
        { shortcode: 'def456', title: 'Scientist' },
        { title: 'Scientist', location: { city: 'Lausanne', region: 'Vaud', countryCode: 'CH' } },
      );
      expect(job).not.toBeNull();
      expect(job.addressRegion).toBe('VD');
    });

    it('returns null when there is no source location text at all', () => {
      const job = buildDebiopharmJob(
        { shortcode: 'ghi789', title: 'Scientist' },
        { title: 'Scientist', location: { city: '', region: '', countryCode: 'CH' } },
      );
      expect(job).toBeNull();
    });
  });

  // ── resolveDebiopharmBackfillCanton (postProcessJobs() backfill guard —
  // #3480, the item this issue was filed for). Unlike buildDebiopharmJob's
  // admission-time skip, an already-published job is never dropped here: a
  // real-but-unresolvable location earns a needsCantonReview flag without
  // inventing an employer-wide canton.
  describe('resolveDebiopharmBackfillCanton', () => {
    it('resolves a known city with no review flag', () => {
      expect(resolveDebiopharmBackfillCanton('Lausanne')).toEqual({ canton: 'VD', needsCantonReview: false });
    });

    it('does not invent a canton when there is no location text at all', () => {
      expect(resolveDebiopharmBackfillCanton('')).toEqual({ canton: '', needsCantonReview: true });
    });

    it('flags a real, unresolvable location without inventing the HQ canton', () => {
      expect(resolveDebiopharmBackfillCanton('Nonexistentburg')).toEqual({ canton: '', needsCantonReview: true });
    });

    it('resolves a real, non-HQ Swiss city correctly with no review flag (negative control)', () => {
      expect(resolveDebiopharmBackfillCanton('Bern')).toEqual({ canton: 'BE', needsCantonReview: false });
    });
  });
});
