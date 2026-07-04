import { describe, expect, it } from 'vitest';
import { parseDebiopharmJobDetailPayload } from '../scripts/lib/debiopharm-job-parser.mjs';

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
});
