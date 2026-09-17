import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { resolveFnzSwissLocation } from '../scripts/lib/fnz-job-parser.mjs';
import { resolveFnzLocation } from '../scripts/update-fnz-jobs.mjs';

const fnzCrawlerSource = fs.readFileSync(
  new URL('../scripts/update-fnz-jobs.mjs', import.meta.url),
  'utf8',
);

describe('fnz-job-parser / resolveFnzSwissLocation', () => {
  it('prefers a later specific Swiss candidate over a country-only value', () => {
    expect(resolveFnzSwissLocation(['Switzerland', 'Zurich'])).toEqual({
      raw: 'Zurich',
      location: 'Zürich',
      canton: 'ZH',
    });
  });

  it('uses the richer requisition location when the listing says only Switzerland', () => {
    expect(resolveFnzSwissLocation([
      'Switzerland',
      {
        descriptor: 'CH Zurich',
        country: { descriptor: 'Switzerland', alpha2Code: 'CH' },
      },
    ])).toEqual({
      raw: 'CH Zurich',
      location: 'Zürich',
      canton: 'ZH',
    });
  });

  it('uses address and CAP fields when the location descriptor is only Switzerland', () => {
    expect(resolveFnzSwissLocation([{
      descriptor: 'Switzerland',
      address: '8001 Zürich',
      postalCode: '8001',
    }])).toEqual({
      raw: 'Switzerland',
      location: 'Zürich',
      canton: 'ZH',
    });
  });

  it('rejects a city and richer address signal that point to different cantons', () => {
    expect(resolveFnzSwissLocation([{
      descriptor: 'CH Zurich',
      addressLocality: 'Chiasso',
      postalCode: '8001',
    }])).toBeNull();
  });

  it('keeps a country-only Swiss posting with an explicit national fallback', () => {
    expect(resolveFnzSwissLocation(['Switzerland'])).toEqual({
      raw: 'Switzerland',
      location: 'Switzerland',
      canton: '',
      nationalFallback: true,
      addressLocality: 'Bern',
      addressRegion: 'BE',
      postalCode: '3011',
      streetAddress: 'Bundesplatz 3',
    });
  });

  it('keeps every country-only alias without selecting a historical office', () => {
    expect(resolveFnzSwissLocation(['Schweiz', 'Suisse', 'Svizzera', 'Swiss'])).toMatchObject({
      location: 'Switzerland',
      canton: '',
      nationalFallback: true,
    });
  });

  it('keeps an unresolved Swiss remote label without inventing a city', () => {
    expect(resolveFnzSwissLocation(['Remote, Switzerland'])).toMatchObject({
      location: 'Switzerland',
      canton: '',
      nationalFallback: true,
    });
  });

  it('does not treat a bare remote label as Swiss without corroboration', () => {
    expect(resolveFnzSwissLocation(['Remote'])).toBeNull();
  });

  it('keeps a country-only posting in the runner payload with a national address', () => {
    expect(resolveFnzLocation(['Switzerland'])).toMatchObject({
      city: 'Switzerland',
      canton: '',
      nationalFallback: true,
      addressLocality: 'Bern',
      addressRegion: 'BE',
      postalCode: '3011',
      streetAddress: 'Bundesplatz 3',
    });
  });

  it('does not map an explicit non-Zürich canton-only value to Zürich', () => {
    expect(resolveFnzSwissLocation(['Ticino'])).toBeNull();
  });

  it('rejects foreign-only candidates', () => {
    expect(resolveFnzSwissLocation(['London, United Kingdom'])).toBeNull();
  });

  it('fails closed when pagination reaches its cap without a verified end', () => {
    expect(fnzCrawlerSource).toMatch(
      /if \(pages >= MAX_PAGES\) \{\s*throw new Error\(/u,
    );
    expect(fnzCrawlerSource).not.toMatch(
      /if \(pages >= MAX_PAGES\) \{[\s\S]*?console\.warn[\s\S]*?break;/u,
    );
  });
});
