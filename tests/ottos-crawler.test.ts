import { describe, it, expect } from 'vitest';
import {
  OTTOS_KEY,
  OTTOS_COMPANY_NAME,
  OTTOS_COMPANY_DOMAIN,
  isOttosJob,
  isTrustedDomain,
} from '../scripts/lib/ottos-job-parser.mjs';

describe("OTTO'S AG crawler parser", () => {
  // ── Constants ──
  it('exports valid company key/name/domain', () => {
    expect(OTTOS_KEY).toBe('ottos');
    expect(OTTOS_COMPANY_NAME).toBe("OTTO'S AG");
    expect(OTTOS_COMPANY_DOMAIN).toBe('ottos.ch');
  });

  // ── isCompanyJob ──
  describe('isOttosJob', () => {
    it('matches by companyKey', () => {
      expect(isOttosJob({ companyKey: 'ottos' })).toBe(true);
    });

    it('matches by Solique tenant URL', () => {
      expect(
        isOttosJob({ url: 'https://live.solique.ch/ottosag/job/details/3959908' })
      ).toBe(true);
    });

    it('matches by URL domain', () => {
      expect(isOttosJob({ url: 'https://www.ottos.ch/de/jobs/123' })).toBe(true);
    });

    it('rejects unrelated jobs', () => {
      expect(
        isOttosJob({ companyKey: 'other-company', company: 'Other', url: 'https://other.com/jobs' })
      ).toBe(false);
    });

    it('rejects unrelated Solique tenants (no cross-tenant leakage)', () => {
      expect(
        isOttosJob({ url: 'https://live.solique.ch/spital-emmental/job/details/123' })
      ).toBe(false);
    });

    it('handles null/undefined gracefully', () => {
      expect(isOttosJob(null)).toBe(false);
      expect(isOttosJob(undefined)).toBe(false);
      expect(isOttosJob({})).toBe(false);
    });
  });

  // ── isTrustedDomain ──
  describe('isTrustedDomain', () => {
    it('trusts primary domain', () => {
      expect(isTrustedDomain('https://www.ottos.ch/de/jobs')).toBe(true);
    });

    it('trusts the ottosag Solique tenant path', () => {
      expect(isTrustedDomain('https://live.solique.ch/ottosag/job/details/3959908')).toBe(true);
    });

    it('rejects a different Solique tenant on the same host', () => {
      expect(isTrustedDomain('https://live.solique.ch/spital-emmental/job/details/123')).toBe(false);
    });

    it('rejects unrelated domains', () => {
      expect(isTrustedDomain('https://evil.example.com/ottos')).toBe(false);
    });

    it('handles malformed URLs gracefully', () => {
      expect(isTrustedDomain('not-a-url')).toBe(false);
      expect(isTrustedDomain('')).toBe(false);
    });
  });
});
