import { describe, it, expect } from 'vitest';
import { PROVIDER_LOGOS, getProviderLogoUrl } from '@/services/brandLogos';

describe('getProviderLogoUrl', () => {
  it('returns Clearbit URL for known slug without localPath', () => {
    // intesa-sanpaolo has no localPath (download failed) — reliably tests the Clearbit fallback path
    const url = getProviderLogoUrl('intesa-sanpaolo');
    expect(url).toBe('https://logo.clearbit.com/intesasanpaolo.com');
  });

  it('returns localPath when set', () => {
    const original = PROVIDER_LOGOS['intesa-sanpaolo'];
    PROVIDER_LOGOS['intesa-sanpaolo'] = { ...original, localPath: '/images/providers/intesa-sanpaolo.png' };
    expect(getProviderLogoUrl('intesa-sanpaolo')).toBe('/images/providers/intesa-sanpaolo.png');
    PROVIDER_LOGOS['intesa-sanpaolo'] = original; // restore
  });

  it('returns null for unknown slug', () => {
    expect(getProviderLogoUrl('unknown-provider-xyz')).toBeNull();
  });

  it('covers all 26 expected provider slugs', () => {
    const expectedSlugs = [
      'wise', 'revolut', 'yuh', 'postfinance', 'ubs', 'credit-suisse',
      'fineco', 'intesa-sanpaolo', 'credit-agricole-it', 'unicredit',
      'banco-bpm', 'cambiavalute',
      'iliad', 'ho-mobile', 'vodafone-it', 'tim', 'windtre', 'very-mobile',
      'fastweb-mobile', 'swisscom', 'salt', 'sunrise', 'yallo', 'wingo',
      'aldi-mobile-ch',
    ];
    for (const slug of expectedSlugs) {
      expect(PROVIDER_LOGOS[slug], `missing slug: ${slug}`).toBeDefined();
    }
  });
});
