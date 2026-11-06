import { describe, it, expect } from 'vitest';
import {
  OTTOS_KEY,
  OTTOS_COMPANY_NAME,
  OTTOS_COMPANY_DOMAIN,
  isOttosJob,
  isTrustedDomain,
  dedupeRepostedOttosJobs,
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

// ── #5253: the same store vacancy published under two requisitions ───────
describe('dedupeRepostedOttosJobs', () => {
  const job = (id: number, location = 'Interlaken', description = 'Deine Aufgaben: Kasse, Warenpräsentation. Pensum: 60-80%') => ({
    url: `https://live.solique.ch/ottosag/job/details/${id}/`,
    title: 'Aushilfe Verkäufer:in Food/Non-Food',
    location,
    description,
  });

  it('keeps the older requisition of two identical postings (Interlaken 3927347 / 4039251)', () => {
    const out = dedupeRepostedOttosJobs([job(4039251), job(3927347)]);
    expect(out.map((j) => j.url)).toEqual([job(3927347).url]);
  });

  it('keeps the per-store template: same role and body at different stores', () => {
    expect(dedupeRepostedOttosJobs([job(4075773, 'Wattwil'), job(4044650, 'Langenthal')])).toHaveLength(2);
  });

  it('keeps two postings at the same store whose bodies differ', () => {
    expect(dedupeRepostedOttosJobs([job(1, 'Thun', 'Pensum 40%'), job(2, 'Thun', 'Pensum 100%')])).toHaveLength(2);
  });
});
