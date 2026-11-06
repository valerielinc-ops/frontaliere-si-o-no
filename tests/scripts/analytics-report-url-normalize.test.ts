import { describe, it, expect } from 'vitest';
import { normalizeInspectionUrl } from '@/scripts/lib/url-normalize';

describe('normalizeInspectionUrl', () => {
  it('adds trailing slash to top-level paths', () => {
    expect(normalizeInspectionUrl('https://frontaliereticino.ch/cerca-lavoro-ticino'))
      .toBe('https://frontaliereticino.ch/cerca-lavoro-ticino/');
  });
  it('keeps trailing slash if present', () => {
    expect(normalizeInspectionUrl('https://frontaliereticino.ch/guida-frontaliere/'))
      .toBe('https://frontaliereticino.ch/guida-frontaliere/');
  });
  it('preserves the root', () => {
    expect(normalizeInspectionUrl('https://frontaliereticino.ch/'))
      .toBe('https://frontaliereticino.ch/');
  });
  it('does not add slash to URLs ending in a file extension', () => {
    expect(normalizeInspectionUrl('https://frontaliereticino.ch/sitemap.xml'))
      .toBe('https://frontaliereticino.ch/sitemap.xml');
  });
  it('preserves query string while normalizing path', () => {
    expect(normalizeInspectionUrl('https://frontaliereticino.ch/cerca-lavoro-ticino?q=foo'))
      .toBe('https://frontaliereticino.ch/cerca-lavoro-ticino/?q=foo');
  });
});
