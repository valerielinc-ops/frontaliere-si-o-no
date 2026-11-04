import { describe, expect, it } from 'vitest';
import {
  canonicalHrefFromHead,
  hasSelfCanonical,
} from '../build-plugins/shared/sitemapCanonicalContract';

describe('sitemap canonical head boundary', () => {
  it('ignores a closing-head string inside a script before the live canonical', () => {
    const canonical = 'https://frontaliereticino.ch/foo/';
    const html = `<head><script>const s='</head>';</script><link rel="canonical" href="${canonical}"></head>`;

    expect(canonicalHrefFromHead(html)).toBe(canonical);
    expect(hasSelfCanonical(html, canonical)).toBe(true);
  });

  it('ignores a closing-head string inside a comment', () => {
    const canonical = 'https://frontaliereticino.ch/foo/';
    const html = `<head><!-- </head> --><link rel="canonical" href="${canonical}"></head>`;

    expect(canonicalHrefFromHead(html)).toBe(canonical);
  });
});
