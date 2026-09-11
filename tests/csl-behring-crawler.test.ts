import { describe, expect, it } from 'vitest';
import {
  CSL_BEHRING_KEY,
  CSL_BEHRING_COMPANY_NAME,
  isCslBehringJob,
  isTrustedDomain,
  resolveCslLocation,
} from '../scripts/lib/csl-behring-job-parser.mjs';

describe('CSL Behring crawler parser', () => {
  it('resolves a normal Swiss Workday location', () => {
    expect(resolveCslLocation('EMEA, CH, Kanton Bern, Bern, CSL Behring')).toBe('Bern');
  });

  it('uses a Swiss additional location when the primary posting location is foreign', () => {
    expect(resolveCslLocation(
      'Americas, US-PA, King of Prussia, CSL Behring',
      [{ descriptor: 'EMEA, CH, Glattbrugg, CSL Behring' }],
    )).toBe('Glattbrugg');
  });

  it('resolves detail locations when the listing is only an N Locations roll-up', () => {
    expect(resolveCslLocation(
      '3 Locations',
      [{ descriptor: 'EMEA, CH, Kanton Bern, Bern, CSL Behring' }],
    )).toBe('Bern');
  });

  it('does not invent a Swiss city for foreign-only detail locations', () => {
    expect(resolveCslLocation('Americas, US-PA, King of Prussia, CSL Behring')).toBe('');
  });

  it('keeps the company matcher and trusted-domain boundary intact', () => {
    expect(CSL_BEHRING_KEY).toBe('csl-behring');
    expect(CSL_BEHRING_COMPANY_NAME).toBe('CSL Behring');
    expect(isCslBehringJob({ companyKey: 'csl-behring' })).toBe(true);
    expect(isCslBehringJob({ company: 'Unrelated', url: 'https://example.test/job' })).toBe(false);
    expect(isTrustedDomain('https://csl.wd1.myworkdayjobs.com/CSL_External/job/1')).toBe(true);
    expect(isTrustedDomain('https://example.test/job/1')).toBe(false);
  });
});
