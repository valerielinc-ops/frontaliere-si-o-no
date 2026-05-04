import { describe, it, expect } from 'vitest';
import { PROVIDER_LOGOS, getProviderLogoUrl } from '@/services/brandLogos';

describe('getProviderLogoUrl', () => {
  it('returns Clearbit URL for known slug without localPath', () => {
    const url = getProviderLogoUrl('wise');
    expect(url).toBe('https://logo.clearbit.com/wise.com');
  });

  it('returns localPath when set', () => {
    const original = PROVIDER_LOGOS['wise'];
    PROVIDER_LOGOS['wise'] = { ...original, localPath: '/images/providers/wise.png' };
    expect(getProviderLogoUrl('wise')).toBe('/images/providers/wise.png');
    PROVIDER_LOGOS['wise'] = original; // restore
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
