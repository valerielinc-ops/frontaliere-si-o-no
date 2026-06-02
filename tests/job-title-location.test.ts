/**
 * Unit tests for `buildJobTitleWithLocation` in
 * `build-plugins/shared/titleSuffix.ts`.
 *
 * Policy ("preferisci il luogo dell'offerta anziché il brand"): the offer
 * LOCATION rides inside the <title> headline and the " | Frontaliere Ticino"
 * brand suffix is the FIRST thing dropped when the title would exceed the
 * SERP cap (TITLE_MAX_CHARS = 66). The headline is never mid-truncated with
 * an ellipsis. This guarantees a concrete place beats the generic brand in
 * the SERP across both the SSG and the SPA runtime title paths
 * (services/seoService.ts, components/community/JobBoard.tsx).
 */
import { describe, it, expect } from 'vitest';
import {
  buildJobTitleWithLocation,
  TITLE_BRAND_SUFFIX,
  TITLE_MAX_CHARS,
} from '@/build-plugins/shared/titleSuffix';

describe('buildJobTitleWithLocation', () => {
  it('places the city in the tail and appends the brand when both fit', () => {
    const out = buildJobTitleWithLocation('Cuoco', 'Hotel Splendide', 'Lugano', 'it');
    expect(out).toBe('Cuoco — Hotel Splendide a Lugano | Frontaliere Ticino');
    expect(out.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });

  it('uses the per-locale connector', () => {
    expect(buildJobTitleWithLocation('Nurse', 'Clinica', 'Bellinzona', 'en'))
      .toContain('Nurse — Clinica in Bellinzona');
    expect(buildJobTitleWithLocation('Pflege', 'Clinica', 'Bellinzona', 'de'))
      .toContain('Pflege — Clinica in Bellinzona');
    expect(buildJobTitleWithLocation('Infirmier', 'Clinica', 'Bellinzona', 'fr'))
      .toContain('Infirmier — Clinica à Bellinzona');
  });

  it('drops the brand FIRST (keeping the city) when the headline + brand exceeds the cap', () => {
    const role = 'Senior Manager Operations and Strategic Partnerships';
    const out = buildJobTitleWithLocation(role, 'Tether', 'Lugano', 'it');
    // Brand dropped, city preserved verbatim — location beats brand.
    expect(out).not.toContain(TITLE_BRAND_SUFFIX);
    expect(out).toContain('Lugano');
    // Never an ellipsis-truncated headline.
    expect(out).not.toContain('…');
  });

  it('falls back to role — company when no city is available', () => {
    expect(buildJobTitleWithLocation('Cuoco', 'Hotel Splendide', '', 'it'))
      .toBe('Cuoco — Hotel Splendide | Frontaliere Ticino');
  });

  it('falls back to role + city when no company is available', () => {
    expect(buildJobTitleWithLocation('Cuoco', '', 'Lugano', 'it'))
      .toBe('Cuoco a Lugano | Frontaliere Ticino');
  });

  it('returns the bare role when neither company nor city is available', () => {
    expect(buildJobTitleWithLocation('Cuoco', '', '', 'it'))
      .toBe('Cuoco | Frontaliere Ticino');
  });

  it('defaults to the Italian connector for an unknown locale', () => {
    expect(buildJobTitleWithLocation('Cuoco', '', 'Lugano', 'xx'))
      .toBe('Cuoco a Lugano | Frontaliere Ticino');
  });
});
