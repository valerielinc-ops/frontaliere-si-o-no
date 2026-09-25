import { describe, it, expect } from 'vitest';
import {
  extractJobPostingAddress,
  extractJobPostingDescription,
  extractMicrodataDescription,
} from '../scripts/lib/jobposting-jsonld.mjs';

describe('extractJobPostingDescription (JSON-LD)', () => {
  it('pulls description from a single JobPosting block', () => {
    const html = `<html><head><script type="application/ld+json">
      {"@context":"https://schema.org","@type":"JobPosting","description":"<p>Full body here</p>"}
    </script></head></html>`;
    expect(extractJobPostingDescription(html)).toBe('<p>Full body here</p>');
  });

  it('finds JobPosting inside an array of nodes', () => {
    const html = `<script type="application/ld+json">
      [{"@type":"Organization","name":"X"},{"@type":"JobPosting","description":"D2"}]
    </script>`;
    expect(extractJobPostingDescription(html)).toBe('D2');
  });

  it('finds JobPosting inside a @graph wrapper', () => {
    const html = `<script type="application/ld+json">
      {"@graph":[{"@type":"WebPage"},{"@type":"JobPosting","description":"G3"}]}
    </script>`;
    expect(extractJobPostingDescription(html)).toBe('G3');
  });

  it('matches when @type is an array containing JobPosting', () => {
    const html = `<script type="application/ld+json">
      {"@type":["JobPosting","Thing"],"description":"AT"}
    </script>`;
    expect(extractJobPostingDescription(html)).toBe('AT');
  });

  it('skips malformed JSON-LD blocks and keeps scanning', () => {
    const html = `<script type="application/ld+json">{ not json</script>
      <script type="application/ld+json">{"@type":"JobPosting","description":"OK"}</script>`;
    expect(extractJobPostingDescription(html)).toBe('OK');
  });

  it('returns empty string when no JobPosting present', () => {
    expect(extractJobPostingDescription('<html>nothing</html>')).toBe('');
    expect(extractJobPostingDescription('')).toBe('');
    expect(extractJobPostingDescription(null)).toBe('');
  });
});

describe('extractMicrodataDescription (itemprop)', () => {
  it('captures the full nested description block (depth-balanced)', () => {
    const html = `<div class="jobDisplay">
      <div itemprop="description"><p>Intro</p><div><ul><li>A</li><li>B</li></ul></div></div>
    </div>`;
    const out = extractMicrodataDescription(html);
    expect(out).toContain('<p>Intro</p>');
    expect(out).toContain('<li>A</li>');
    expect(out).toContain('<ul>');
    // Must NOT bleed past the closing tag of the description element.
    expect(out).not.toContain('jobDisplay');
  });

  it('returns empty string when there is no itemprop=description', () => {
    expect(extractMicrodataDescription('<div>JS shell only</div>')).toBe('');
    expect(extractMicrodataDescription('')).toBe('');
    expect(extractMicrodataDescription(undefined)).toBe('');
  });
});

describe('extractJobPostingAddress (JSON-LD)', () => {
  it('returns the structured locality alongside the description', () => {
    const html = `<script type="application/ld+json">
      {"@type":"JobPosting","jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","streetAddress":"Churerstrasse 135","addressLocality":"Pfäffikon SZ","postalCode":"8808","addressCountry":"CH"}}}
    </script>`;
    expect(extractJobPostingAddress(html)).toEqual({
      locality: 'Pfäffikon SZ',
      postalCode: '8808',
      streetAddress: 'Churerstrasse 135',
      addressCountry: 'CH',
    });
  });

  it('returns null when a JobPosting has no structured address', () => {
    expect(extractJobPostingAddress('<script type="application/ld+json">{"@type":"JobPosting"}</script>')).toBeNull();
  });
});
