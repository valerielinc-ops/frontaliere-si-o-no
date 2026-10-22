import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { COMPANY_ROUTE_PREFIX, SECTION_LEGACY_TI_PATH } from '../build-plugins/shared/cantonSection';

const config = JSON.parse(readFileSync(new URL('../data/job-canonical-overrides.json', import.meta.url), 'utf8'));
const overrides = config.overrides as Record<string, string>;
const SEARCH_SLUG = /^(?:search|ricerca|suche|recherche)-/i;

function isCompanyHubTarget(canonical: string) {
  const pathname = new URL(canonical).pathname;
  return Object.entries(COMPANY_ROUTE_PREFIX).some(([locale, companyPrefix]) => {
    const sectionRoot = SECTION_LEGACY_TI_PATH[locale as keyof typeof SECTION_LEGACY_TI_PATH];
    if (!pathname.startsWith(sectionRoot)) return false;
    const suffix = pathname.slice(sectionRoot.length);
    return suffix.startsWith(`${companyPrefix}-`) && suffix.endsWith('/') && suffix.split('/').length === 2;
  });
}

function isForbiddenDetailToCompanyHub(slug: string, canonical: string) {
  return isCompanyHubTarget(canonical) && !SEARCH_SLUG.test(slug);
}

describe('job canonical override policy', () => {
  it('keeps company-hub targets for search-intent pages and rejects job-detail to company-hub overrides', () => {
    const companyHubOverrides = Object.entries(overrides).filter(([, canonical]) => isCompanyHubTarget(canonical));
    expect(companyHubOverrides.length).toBeGreaterThan(0);
    for (const [slug, canonical] of companyHubOverrides) {
      expect(SEARCH_SLUG.test(slug)).toBe(true);
      expect(isForbiddenDetailToCompanyHub(slug, canonical)).toBe(false);
    }
    expect(overrides['search-lugano-eoc-ente-ospedaliero-cantonale']).toBe(
      'https://frontaliereticino.ch/cerca-lavoro-ticino/azienda-eoc-ente-ospedaliero-cantonale/',
    );
    expect(isForbiddenDetailToCompanyHub(
      'impiegato-a-amministrativo-a-eoc-ente-ospedaliero-cantonale-bellinzona',
      'https://frontaliereticino.ch/cerca-lavoro-ticino/azienda-eoc-ente-ospedaliero-cantonale/',
    )).toBe(true);
  });

  it('allows search slugs and detail-to-detail deduplication without treating a detail as a company hub', () => {
    const hub = 'https://frontaliereticino.ch/cerca-lavoro-ticino/azienda-eoc-ente-ospedaliero-cantonale/';
    const dedupedDetail = 'https://frontaliereticino.ch/cerca-lavoro-ticino/expediter-casale-sa-lugano/';
    expect(isForbiddenDetailToCompanyHub('ricerca-impiego-eoc', hub)).toBe(false);
    expect(isForbiddenDetailToCompanyHub('suche-jobs-eoc', hub)).toBe(false);
    expect(isForbiddenDetailToCompanyHub('recherche-emploi-eoc', hub)).toBe(false);
    expect(isForbiddenDetailToCompanyHub('old-vacancy-slug', dedupedDetail)).toBe(false);
    for (const [locale, companyPrefix] of Object.entries(COMPANY_ROUTE_PREFIX)) {
      const companyTarget = `https://frontaliereticino.ch${SECTION_LEGACY_TI_PATH[locale as keyof typeof SECTION_LEGACY_TI_PATH]}${companyPrefix}-fixture/`;
      expect(isCompanyHubTarget(companyTarget), `${locale} company route should be recognized`).toBe(true);
    }
  });

  it('removes the eleven reviewed detail-to-hub overrides while leaving archived and dedup alias routing to its existing code path', () => {
    const removed = [
      'spedizione-casale-sa-lugano-ticino',
      'hse-spezialist-casale-sa-lugano-ticino-b892fl',
      'hse-spezialist-casale-sa-lugano-ticino',
      'instrument-ingegnere-casale-sa-lugano',
      'proposal-manager-casale-sa-lugano-ticino-slm01t',
      'beschleuniger-casale-sa-lugano-ticino',
      'work-with-us-casale-sa-lugano',
      'expediter-casale-sa-lugano',
      'unternehmenssteuerleiter-80-100-pwc-switzerland-zurich',
      'rechtsberatung-regulierung-und-compliance-50-pwc-switzerland-zurich-jt2i9b',
      'impiegato-a-amministrativo-a-eoc-ente-ospedaliero-cantonale-bellinzona',
    ];
    for (const slug of removed) expect(overrides).not.toHaveProperty(slug);
    expect(overrides).toHaveProperty('search-lugano-eoc-ente-ospedaliero-cantonale');
    expect(config._doc).toMatch(/archiv|dedup|detail-to-detail/i);
  });
});
