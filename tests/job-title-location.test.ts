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
  buildTitleWithBrand,
  TITLE_BRAND_SUFFIX,
  TITLE_MAX_CHARS,
} from '@/build-plugins/shared/titleSuffix';
import { isMultiLocation } from '@/services/jobDataNormalization';

/**
 * Mirrors the caller-side guard wired in `services/seoService.ts` (L380) and
 * `components/community/JobBoard.tsx` (L3546, L3578): a non-geographic
 * multi-location blob must be replaced by an empty city BEFORE it reaches
 * `buildJobTitleWithLocation`, so the blob never becomes a city token.
 */
function titleForJobLocation(
  role: string,
  company: string,
  location: unknown,
  locale: string,
): string {
  const titleCity = isMultiLocation(location) ? '' : String(location || '').trim();
  return buildJobTitleWithLocation(role, company, titleCity, locale);
}

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

  it('case-2 boundary: drops the brand but keeps the whole headline when headline ≤ cap yet headline + brand > cap', () => {
    // Headline alone fits the SERP cap (≤66) but appending the 21-char brand
    // suffix would push it over → brand DROPPED, headline returned verbatim,
    // never ellipsis-truncated. This locks the most SEO-relevant branch of
    // buildTitleWithBrand (case-2), distinct from case-3 (headline alone >cap).
    const headline = 'Responsabile Vendite — Azienda Internazionale a Lugano';
    expect(headline.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
    expect(headline.length + TITLE_BRAND_SUFFIX.length).toBeGreaterThan(TITLE_MAX_CHARS);
    const out = buildTitleWithBrand(headline);
    expect(out).toBe(headline);
    expect(out).not.toContain(TITLE_BRAND_SUFFIX);
    expect(out).not.toContain('…');
  });
});

describe('caller multi-location guard wiring', () => {
  it('drops a multi-location blob (city token never emitted) through the caller guard', () => {
    const blob = 'Schweiz und Ausland (abhängig von Funktion und Einsatzort)';
    // Sanity: the blob does match the guard regex so the test exercises the
    // city-dropping branch, not an accidental fallthrough.
    expect(isMultiLocation(blob)).toBe(true);
    const out = titleForJobLocation('Consulente', 'Tether', blob, 'it');
    // Brand fallback only — no blob fragment leaked into the title.
    expect(out).toBe('Consulente — Tether | Frontaliere Ticino');
    expect(out).not.toContain('Schweiz');
    expect(out).not.toContain('abhängig');
    expect(out).not.toContain('Einsatzort');
  });

  it('drops a "ganz Schweiz" blob in a non-IT locale through the caller guard', () => {
    const blob = 'ganz Schweiz';
    expect(isMultiLocation(blob)).toBe(true);
    const out = titleForJobLocation('Nurse', 'Clinica', blob, 'en');
    expect(out).toBe('Nurse — Clinica | Frontaliere Ticino');
    expect(out).not.toContain('Schweiz');
  });

  it('keeps a real city as a city token through the caller guard', () => {
    const out = titleForJobLocation('Cuoco', 'Hotel Splendide', 'Lugano', 'it');
    // Concrete place survives the guard and rides inside the headline.
    expect(out).toBe('Cuoco — Hotel Splendide a Lugano | Frontaliere Ticino');
  });
});
