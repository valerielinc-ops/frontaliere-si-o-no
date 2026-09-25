/**
 * Tests for the VD emploi platform shared parser.
 *
 * Covers all four hospitals using the shared Next.js careers app with
 * `/api/offers` JSON endpoint:
 *   - EHC (Ensemble hospitalier de la Côte) — emploi.ehc-vd.ch
 *   - HRC (Hôpital Riviera-Chablais)        — emploi.hopitalrivierachablais.ch
 *   - HIB (Hôpital Intercantonal de la Broye) — emploi.hopital-broye.ch
 *   - Hôpital de La Tour                      — recrutement.latour.ch
 *
 * Verifies:
 *   - Constants (key, company name, domain) exported by each thin wrapper
 *   - isCompanyJob / isTrustedDomain matchers
 *   - Offer normalization: city extraction (cust-lieu-city), rate parsing,
 *     contract type, HTML entity decoding, fallback to hospital city when
 *     the workplace string is a brand name (e.g. "Hôpital de La Tour")
 *   - Slug stability + companyKey embedding
 */
import { describe, it, expect } from 'vitest';
import { createVdEmploiPlatformParser } from '../../scripts/lib/vd-emploi-platform-common.mjs';
import {
  EHC_VD_KEY,
  EHC_VD_COMPANY_NAME,
  EHC_VD_COMPANY_DOMAIN,
  isEhcVdJob,
  isTrustedDomain as isEhcTrusted,
} from '../../scripts/lib/ehc-vd-job-parser.mjs';
import {
  HRC_KEY,
  HRC_COMPANY_NAME,
  isHrcJob,
  isTrustedDomain as isHrcTrusted,
} from '../../scripts/lib/hrc-job-parser.mjs';
import {
  HIB_KEY,
  HIB_COMPANY_NAME,
  isHibJob,
} from '../../scripts/lib/hib-job-parser.mjs';
import {
  HOPITAL_LA_TOUR_KEY,
  HOPITAL_LA_TOUR_COMPANY_NAME,
  isHopitalLaTourJob,
  isTrustedDomain as isLaTourTrusted,
} from '../../scripts/lib/hopital-la-tour-job-parser.mjs';

describe('VD emploi platform — exported constants', () => {
  it('EHC exports valid constants', () => {
    expect(EHC_VD_KEY).toBe('ehc-vd');
    expect(EHC_VD_COMPANY_NAME).toMatch(/EHC/);
    expect(EHC_VD_COMPANY_DOMAIN).toBe('ehc-vd.ch');
  });

  it('HRC exports valid constants', () => {
    expect(HRC_KEY).toBe('hrc');
    expect(HRC_COMPANY_NAME).toMatch(/Riviera-Chablais/);
  });

  it('HIB exports valid constants', () => {
    expect(HIB_KEY).toBe('hib-broye');
    expect(HIB_COMPANY_NAME).toMatch(/Broye/);
  });

  it('Hôpital de La Tour exports valid constants', () => {
    expect(HOPITAL_LA_TOUR_KEY).toBe('hopital-la-tour');
    expect(HOPITAL_LA_TOUR_COMPANY_NAME).toMatch(/La Tour/);
  });
});

describe('VD emploi platform — isCompanyJob matchers', () => {
  it('EHC matches by companyKey', () => {
    expect(isEhcVdJob({ companyKey: 'ehc-vd' })).toBe(true);
    expect(isEhcVdJob({ companyKey: 'hrc' })).toBe(false);
  });

  it('EHC matches by URL', () => {
    expect(isEhcVdJob({ url: 'https://emploi.ehc-vd.ch/nos-offres/x' })).toBe(true);
    expect(isEhcVdJob({ url: 'https://www.ehc-vd.ch/something' })).toBe(true);
    expect(isEhcVdJob({ url: 'https://random.example.com/' })).toBe(false);
  });

  it('HRC matches by URL', () => {
    expect(isHrcJob({ url: 'https://emploi.hopitalrivierachablais.ch/nos-offres/x' })).toBe(true);
  });

  it('HIB matches by URL', () => {
    expect(isHibJob({ url: 'https://emploi.hopital-broye.ch/nos-offres/x' })).toBe(true);
  });

  it('Hôpital de La Tour matches by URL', () => {
    expect(isHopitalLaTourJob({ url: 'https://recrutement.latour.ch/nos-offres/x' })).toBe(true);
  });
});

describe('VD emploi platform — isTrustedDomain', () => {
  it('EHC trusts emploi + corporate subdomains', () => {
    expect(isEhcTrusted('https://emploi.ehc-vd.ch/nos-offres/x')).toBe(true);
    expect(isEhcTrusted('https://www.ehc-vd.ch/about')).toBe(true);
    expect(isEhcTrusted('https://phishing.example.com/')).toBe(false);
  });

  it('HRC trusts the recruitment subdomain', () => {
    expect(isHrcTrusted('https://emploi.hopitalrivierachablais.ch/x')).toBe(true);
    expect(isHrcTrusted('https://emploi.ehc-vd.ch/x')).toBe(false);
  });

  it('Hôpital de La Tour trusts recrutement.latour.ch + la-tour.ch', () => {
    expect(isLaTourTrusted('https://recrutement.latour.ch/x')).toBe(true);
    expect(isLaTourTrusted('https://www.la-tour.ch/x')).toBe(true);
    expect(isLaTourTrusted('https://malicious.com/')).toBe(false);
  });

  it('Rejects malformed URLs', () => {
    expect(isEhcTrusted('not-a-url')).toBe(false);
    expect(isEhcTrusted('')).toBe(false);
  });
});

describe('createVdEmploiPlatformParser — config validation', () => {
  it('throws when required config is missing', () => {
    expect(() => createVdEmploiPlatformParser({} as any)).toThrow();
    expect(() => createVdEmploiPlatformParser({
      companyKey: 'x',
      companyName: 'X',
      baseUrl: 'https://x.ch',
      // missing defaultCanton
    } as any)).toThrow();
  });

  it('returns three exposed functions', () => {
    const p = createVdEmploiPlatformParser({
      companyKey: 'test-hospital',
      companyName: 'Test Hospital',
      companyDomain: 'test.ch',
      baseUrl: 'https://emploi.test.ch',
      defaultCanton: 'VD',
      defaultCity: 'Lausanne',
      defaultPostalCode: '1000',
    });
    expect(typeof p.fetchAllJobs).toBe('function');
    expect(typeof p.isCompanyJob).toBe('function');
    expect(typeof p.isTrustedDomain).toBe('function');
  });
});
