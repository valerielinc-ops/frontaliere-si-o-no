import { describe, it, expect } from 'vitest';
import {
  NANT_KEY,
  NANT_COMPANY_NAME,
  NANT_COMPANY_DOMAIN,
  isNantJob,
  isTrustedDomain,
} from '../scripts/lib/nant-job-parser.mjs';
import { slugify } from '../scripts/lib/crawler-template.mjs';

describe('Fondation de Nant crawler parser', () => {
  it('exports valid constants', () => {
    expect(NANT_KEY).toBe('nant');
    expect(NANT_COMPANY_NAME).toBe('Fondation de Nant');
    expect(NANT_COMPANY_DOMAIN).toBe('nant.ch');
  });

  describe('isNantJob', () => {
    it('matches by companyKey', () => {
      expect(isNantJob({ companyKey: 'nant' })).toBe(true);
    });
    it('matches by nant.ch URL', () => {
      expect(isNantJob({ url: 'https://nant.ch/carrieres/' })).toBe(true);
    });
    it('matches by Beehire career URL', () => {
      expect(isNantJob({ url: 'https://app.beehire.com/career/nant' })).toBe(true);
    });
    it('matches by Beehire invite URL with Nant company name', () => {
      expect(
        isNantJob({
          url: 'https://app.beehire.com/invite/abc',
          company: 'Fondation de Nant',
        })
      ).toBe(true);
    });
    it('rejects Beehire invite URL for a different tenant', () => {
      expect(
        isNantJob({
          url: 'https://app.beehire.com/invite/abc',
          company: 'Hôpital de Lavaux',
        })
      ).toBe(false);
    });
    it('rejects null/empty', () => {
      expect(isNantJob(null)).toBe(false);
      expect(isNantJob({})).toBe(false);
    });
  });

  describe('isTrustedDomain', () => {
    it('trusts nant.ch', () => {
      expect(isTrustedDomain('https://nant.ch/carrieres/')).toBe(true);
    });
    it('trusts the Beehire app domain', () => {
      expect(isTrustedDomain('https://app.beehire.com/career/nant')).toBe(true);
    });
    it('rejects other domains', () => {
      expect(isTrustedDomain('https://example.com')).toBe(false);
      expect(isTrustedDomain('not-a-url')).toBe(false);
    });
  });

  describe('slugify', () => {
    it('handles French diacritics and middot job titles', () => {
      expect(slugify('Infirmier·ère à 80% SPAUL')).toBe('infirmier-ere-a-80-spaul');
    });
    it('respects max length', () => {
      expect(slugify('a'.repeat(200)).length).toBeLessThanOrEqual(90);
    });
  });
});
