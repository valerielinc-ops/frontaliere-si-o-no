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
});
