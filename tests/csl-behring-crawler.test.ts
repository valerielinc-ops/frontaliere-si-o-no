import { describe, expect, it } from 'vitest';
import {
  CSL_BEHRING_KEY,
  CSL_BEHRING_COMPANY_NAME,
  isCslBehringJob,
  isTrustedDomain,
  resolveCslLocation,
  resolveCslPublishLocation,
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

  // The union above is NOT the publish decision. Measured on
  // data/jobs/by-crawler/csl-behring.json: 12 of 25 records carried a non-Swiss
  // primary location in their own Workday path (US-PA King of Prussia, US-MA
  // Waltham, GB Berkshire-Maidenhead) and were published as Glattbrugg,
  // Opfikon or Bern. All 13 correctly-published records have an `EMEA-CH-*`
  // primary.
  it('refuses to publish a foreign req that merely lists a Swiss site alongside', () => {
    const crossPosted = {
      location: 'Americas, US-PA, King of Prussia, CSL Behring',
      additionalLocations: [{ descriptor: 'EMEA, CH, Glattbrugg, CSL Behring' }],
    };
    // The union still resolves a Swiss city…
    expect(resolveCslLocation(crossPosted.location, crossPosted.additionalLocations)).toBe('Glattbrugg');
    // …but the publish decision reads only the req's own primary location.
    expect(resolveCslPublishLocation(crossPosted)).toBe('');
  });

  it('publishes a req whose own primary location is Swiss', () => {
    expect(resolveCslPublishLocation({
      location: 'EMEA, CH, Glattbrugg, CSL Behring',
      additionalLocations: [{ descriptor: 'Americas, US-PA, King of Prussia, CSL Behring' }],
    })).toBe('Glattbrugg');
    expect(resolveCslPublishLocation({
      location: 'EMEA, CH, Kanton Bern, Bern, CSL Behring',
    })).toBe('Bern');
  });

  it('fails closed when the req has no readable primary location', () => {
    // Used to fall back to the hardcoded `Bern` / `BE`, which is the
    // generic-city fallback audit-parser-quality.mjs names in its ACTION line.
    expect(resolveCslPublishLocation({ additionalLocations: [{ descriptor: 'EMEA, CH, Glattbrugg' }] })).toBe('');
    expect(resolveCslPublishLocation({ location: '' })).toBe('');
    expect(resolveCslPublishLocation({})).toBe('');
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

  it('does not publish a Swiss additional location when the primary is foreign', () => {
    expect(resolveCslPublishLocation({
      location: 'Americas, US-PA, King of Prussia, CSL Behring',
      additionalLocations: [{ descriptor: 'EMEA, CH, Glattbrugg, CSL Behring' }],
    })).toBe('');
  });

  it('publishes a Swiss primary location', () => {
    expect(resolveCslPublishLocation({
      location: 'EMEA, CH, Kanton Bern, Bern, CSL Behring',
      additionalLocations: [{ descriptor: 'Americas, US-PA, King of Prussia' }],
    })).toBe('Bern');
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
