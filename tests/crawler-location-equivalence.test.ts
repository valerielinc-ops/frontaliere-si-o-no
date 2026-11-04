import { describe, expect, it } from 'vitest';
import {
  canonicalCrawlerLocationKey,
  cantonFromPublishedPostalCode,
  compareCrawlerPublishedLocation,
} from '../scripts/lib/crawler-location-equivalence.mjs';

describe('crawler/published location equivalence', () => {
  it('accepts language aliases and canonical municipality names', () => {
    expect(compareCrawlerPublishedLocation({
      sourceLocation: 'Geneva, Switzerland',
      publishedLocation: 'Genève',
      sourceCanton: 'GE',
      publishedCanton: 'GE',
    })).toBe('same');
    expect(compareCrawlerPublishedLocation({
      sourceLocation: 'Biel',
      publishedLocation: 'Bienne',
      sourceCanton: 'BE',
      publishedCanton: 'BE',
    })).toBe('same');
  });

  it('uses a source postal locality for facility and sub-locality labels', () => {
    expect(compareCrawlerPublishedLocation({
      sourceLocation: 'Hirslanden Salem-Spital',
      publishedLocation: 'Bern',
      sourcePostalCode: '3013',
      publishedPostalCode: '3013',
      sourceCanton: 'BE',
      publishedCanton: 'BE',
    })).toBe('same');
    expect(compareCrawlerPublishedLocation({
      sourceLocation: 'Ibach-Schwyz',
      publishedLocation: 'Schwyz',
      sourcePostalCode: '6438',
      sourceCanton: 'SZ',
      publishedCanton: 'SZ',
    })).toBe('same');
  });

  it('keeps a concrete source contradiction visible', () => {
    expect(compareCrawlerPublishedLocation({
      sourceLocation: 'Winterthur, Zürich',
      publishedLocation: 'Zürich',
      sourceCanton: 'ZH',
      publishedCanton: 'ZH',
    })).toBe('different');
    expect(compareCrawlerPublishedLocation({
      sourceLocation: 'Brugg',
      publishedLocation: 'Baden',
      sourcePostalCode: '5200',
      publishedPostalCode: '5400',
      sourceCanton: 'AG',
      publishedCanton: 'AG',
    })).toBe('different');
    expect(compareCrawlerPublishedLocation({
      sourceLocation: 'Baden-Württemberg',
      publishedLocation: 'Baden',
      publishedCanton: 'AG',
    })).toBe('different');
  });

  it('does not turn a multi-site region into a first-match verdict', () => {
    expect(canonicalCrawlerLocationKey('Biel / Solothurn / Mittelland', 'BE')).toBe('');
    expect(compareCrawlerPublishedLocation({
      sourceLocation: 'Biel / Solothurn / Mittelland',
      publishedLocation: 'Solothurn',
      sourceCanton: 'BE',
      publishedCanton: 'SO',
    })).toBe('unknown');
    expect(compareCrawlerPublishedLocation({
      sourceLocation: 'Suisse romande',
      publishedLocation: 'Zürich',
      sourceCanton: 'VD',
      publishedCanton: 'ZH',
    })).toBe('unknown');
  });

  it('uses a postal code to disambiguate a homonym only when the city agrees', () => {
    expect(cantonFromPublishedPostalCode({
      city: 'Seewen',
      postalCode: '6423',
      storedCanton: 'SZ',
    })).toBe('SZ');
    expect(cantonFromPublishedPostalCode({
      city: 'Seewen',
      postalCode: '8008',
      storedCanton: 'SZ',
    })).toBe('');
  });
});
