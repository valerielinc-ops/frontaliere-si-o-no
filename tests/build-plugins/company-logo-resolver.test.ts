import { describe, it, expect } from 'vitest';
import {
  resolveJobLogoSrc,
  generateInitialsLogo,
  LOGO_FALLBACK_SRC,
} from '../../build-plugins/shared/companyLogoResolver';

describe('companyLogoResolver', () => {
  it('returns explicit logo override when present', () => {
    expect(
      resolveJobLogoSrc({ company: 'X', logo: 'https://cdn/x.png' }),
    ).toBe('https://cdn/x.png');
  });

  it('falls back to deterministic initials SVG when no host is known', () => {
    const src = resolveJobLogoSrc({ company: 'Acme Pizza' });
    expect(src).toMatch(/^data:image\/svg\+xml/);
    expect(decodeURIComponent(src)).toContain('AP');
  });

  it('returns the placeholder when neither logo nor company name exist', () => {
    expect(resolveJobLogoSrc({})).toBe(LOGO_FALLBACK_SRC);
  });

  it('generates stable initials for the same input', () => {
    expect(generateInitialsLogo('Migros')).toBe(generateInitialsLogo('Migros'));
  });

  it('falls through to initials (never a grey-globe favicon) for an unknown company with a real host', () => {
    // A crawled company that is NOT in CRAWLED_COMPANY_LOGOS. The old chain
    // returned a Google s2/favicons URL here, which renders as a grey globe
    // for domains Google can't resolve. The new chain must return the
    // coloured-initials data URI instead.
    const src = resolveJobLogoSrc({
      company: 'Totally Unknown Crawled GmbH',
      companyKey: 'totally-unknown-crawled-gmbh',
      companyDomain: 'totally-unknown-crawled-example.ch',
      url: 'https://totally-unknown-crawled-example.ch/jobs/123',
    });
    expect(src).not.toContain('google.com/s2/favicons');
    expect(src).toMatch(/^data:image\/svg\+xml/);
  });

  it('resolves the curated Duferco brand asset instead of the talentics.ai grey globe', () => {
    // Regression for the reported case: duferco.talentics.ai (an ATS host)
    // resolved to a Google grey globe. Duferco is now curated.
    const src = resolveJobLogoSrc({
      company: 'Duferco',
      companyKey: 'duferco',
      companyDomain: 'duferco.talentics.ai',
      url: 'https://duferco.talentics.ai/job/b77369d4',
    });
    expect(src).not.toContain('google.com/s2/favicons');
    expect(src).toBe('/images/brands/duferco.png');
  });
});
