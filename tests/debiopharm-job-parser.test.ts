import { describe, expect, it } from 'vitest';
import { parseDebiopharmJobDetailPayload } from '../scripts/lib/debiopharm-job-parser.mjs';
import { buildDebiopharmJob } from '../scripts/update-debiopharm-jobs.mjs';

describe('debiopharm-job-parser', () => {
  // ── parseDebiopharmJobDetailPayload.inferredCanton (unresolved-canton skip guard — task-critical) ──
  describe('inferredCanton', () => {
    it('resolves a known Swiss city/region to its canton', () => {
      const parsed = parseDebiopharmJobDetailPayload({
        title: 'Scientist',
        location: { city: 'Lausanne', region: 'Vaud', countryCode: 'CH' },
      });
      expect(parsed.inferredCanton).toBe('VD');
    });

    it('falls back to the Lausanne HQ canton (VD) when no real city/region text was scraped at all', () => {
      const parsed = parseDebiopharmJobDetailPayload({
        title: 'Scientist',
        location: { city: '', region: '', countryCode: 'CH' },
      });
      expect(parsed.inferredCanton).toBe('VD');
    });

    it('returns null (skip) when real city/region text is present but unresolvable — never fabricates the HQ canton', () => {
      const parsed = parseDebiopharmJobDetailPayload({
        title: 'Scientist',
        location: { city: 'Nonexistentburg', region: 'Nonexistentregion', countryCode: 'CH' },
      });
      expect(parsed.inferredCanton).toBeNull();
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
  // parsed.city is ALREADY HQ-defaulted (Lausanne) by
  // parseDebiopharmJobDetailPayload() itself, independently of whether
  // inferredCanton resolved. A caller that re-derives canton from
  // `parsed.city` (rather than trusting `parsed.inferredCanton` directly)
  // would see `inferAnyCanton('Lausanne')` resolve truthy and short-circuit
  // before ever consulting the real null-skip signal — silently publishing a
  // fabricated Lausanne/VD job for an empty-city + unresolvable-region input.
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

    it('still falls back to the Lausanne HQ canton when there is no real city/region text at all', () => {
      const job = buildDebiopharmJob(
        { shortcode: 'ghi789', title: 'Scientist' },
        { title: 'Scientist', location: { city: '', region: '', countryCode: 'CH' } },
      );
      expect(job).not.toBeNull();
      expect(job.addressRegion).toBe('VD');
    });
  });
});
