import { describe, expect, it } from 'vitest';

import { restoreDeclaredImageRefs } from '../scripts/lib/article-image-postcondition.mjs';

describe('article image postcondition fallback repair', () => {
  it('replaces generic absolute and relative heroes with the registry image', () => {
    const html = [
      '<meta property="og:image" content="https://frontaliereticino.ch/og-image.png">',
      '<meta name="twitter:image" content="/og-image.png">',
      '<img src="/og-image.png">',
    ].join('');

    const patched = restoreDeclaredImageRefs(html, '/images/places/mendrisio.webp');
    expect(patched).not.toContain('og-image.png');
    expect((patched.match(/\/images\/places\/mendrisio\.webp/g) ?? []).length).toBe(3);
  });

  it('leaves external or missing declarations unchanged', () => {
    const html = '<meta property="og:image" content="/og-image.png">';
    expect(restoreDeclaredImageRefs(html, '')).toBe(html);
    expect(restoreDeclaredImageRefs(html, 'https://example.test/hero.webp')).toBe(html);
  });
});
