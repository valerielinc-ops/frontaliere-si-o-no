import { describe, expect, it } from 'vitest';

import { buildSocialBioLinks } from '../scripts/social-bio-links.mjs';
import { socialBioUrl } from '../scripts/lib/social-redirect-links.mjs';

describe('social profile bio links', () => {
  it('keeps stable per-channel keys and only claims channel-level attribution', () => {
    const first = new URL(socialBioUrl('instagram'));
    const repeated = new URL(socialBioUrl('instagram'));

    expect(first.pathname).toBe(repeated.pathname);
    expect(first.pathname).toMatch(/^\/social\/r\/[a-f0-9]{20}\/$/u);
    expect(first.searchParams.get('to')).toBe('/social/');
    expect(first.searchParams.get('utm_source')).toBe('instagram');
    expect(first.searchParams.get('utm_medium')).toBe('social');
    expect(first.searchParams.get('utm_campaign')).toBe('instagram_bio');
    expect(first.searchParams.get('utm_content')).toBe('profile');
  });

  it('uses the requested localized destination and rejects unsupported channels/locales', () => {
    const links = buildSocialBioLinks('fr');
    const tiktok = new URL(links.tiktok);

    expect(tiktok.searchParams.get('to')).toBe('/fr/social/');
    expect(tiktok.searchParams.get('utm_source')).toBe('tiktok');
    expect(socialBioUrl('unknown')).toBe('');
    expect(socialBioUrl('instagram', 'es')).toBe('');
  });
});
