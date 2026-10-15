import { describe, expect, it } from 'vitest';
import { decodeSitemapLoc } from '../scripts/lib/sitemap-loc.mjs';

describe('decodeSitemapLoc (parser-quality audit #5253)', () => {
  it('decodes every predefined XML entity of a <loc>, &amp; last', () => {
    // Manor sitemap, 2026-09-29: the apostrophe stayed escaped in the stored URL.
    expect(decodeSitemapLoc(' https://positions.manor.ch/job/Basel-Buyer-%28Women&apos;s-Fashion%29-100/1368279755/ '))
      .toBe("https://positions.manor.ch/job/Basel-Buyer-%28Women's-Fashion%29-100/1368279755/");
    expect(decodeSitemapLoc('https://example.ch/a?x=1&amp;y=&#39;2&#39;&amp;z=&quot;3&quot;')).toBe('https://example.ch/a?x=1&y=\'2\'&z="3"');
    expect(decodeSitemapLoc('https://example.ch/a?x=&#38;y=&#60;tag&#62;')).toBe('https://example.ch/a?x=&y=<tag>');
    // An escaped entity is decoded once, not twice.
    expect(decodeSitemapLoc('https://example.ch/a?q=&amp;apos;')).toBe('https://example.ch/a?q=&apos;');
  });
});
