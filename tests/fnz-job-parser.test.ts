import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { resolveFnzSwissLocation, hasFnzSwissPrimaryLocation } from '../scripts/lib/fnz-job-parser.mjs';
import { resolveFnzLocation, buildFnzDescriptionFields, dropFnzFabricatedText } from '../scripts/update-fnz-jobs.mjs';
import { isCantonOnlyLabel } from '../scripts/lib/target-swiss-locations.mjs';

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

  it('rejects an ambiguous structured municipality unless the source scopes its canton independently', () => {
    expect(resolveFnzSwissLocation([{
      descriptor: 'CH Buchs',
      addressLocality: 'Buchs',
      postalCode: '9470',
    }])).toBeNull();
    expect(resolveFnzSwissLocation([{
      descriptor: 'CH Buchs SG',
      addressLocality: 'Buchs',
      addressRegion: 'SG',
      postalCode: '9470',
    }])).toMatchObject({
      location: 'Buchs (SG)',
      canton: 'SG',
    });
  });

  it('retains concrete capital municipalities whose names also identify cantons', () => {
    expect(resolveFnzSwissLocation(['Bern'])).toMatchObject({
      location: 'Bern',
      canton: 'BE',
    });
    expect(resolveFnzSwissLocation(['Zürich'])).toMatchObject({
      location: 'Zürich',
      canton: 'ZH',
    });
    expect(resolveFnzSwissLocation([{
      descriptor: 'Bern',
      addressLocality: 'Bern',
      postalCode: '3000',
    }])).toMatchObject({
      location: 'Bern',
      canton: 'BE',
    });
    expect(resolveFnzSwissLocation([{
      descriptor: 'Zürich',
      addressLocality: 'Zürich',
      postalCode: '8001',
    }])).toMatchObject({
      location: 'Zürich',
      canton: 'ZH',
    });
  });

  it('retains a concrete municipality when the canton-only guard misclassifies its label', () => {
    expect(resolveFnzSwissLocation([{
      descriptor: 'CH Altdorf',
      addressLocality: 'Altdorf',
      postalCode: '6460',
    }])).toMatchObject({
      location: 'Altdorf',
      canton: 'UR',
    });
  });

  it('keeps capital municipalities out of the canton-only classification', () => {
    expect(isCantonOnlyLabel('Bern')).toBe(false);
    expect(isCantonOnlyLabel('Zürich')).toBe(false);
    expect(isCantonOnlyLabel('Ticino')).toBe(true);
  });

  it('does not accept a canton-only municipality label without address evidence', () => {
    expect(resolveFnzSwissLocation(['Altdorf'])).toBeNull();
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

  it('keeps a posting whose only location field is Switzerland', () => {
    expect(resolveFnzSwissLocation([{ location: 'Switzerland' }])).toMatchObject({
      location: 'Switzerland',
      canton: '',
      nationalFallback: true,
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

  // Workday reqs are cross-posted to several countries. Only candidates[0] —
  // the req's OWN primary workplace — licenses publication; a later
  // `Switzerland` entry must not reach the national fallback and fabricate
  // `Bern / BE / 3011 Bundesplatz 3` for a foreign vacancy. 0 of the 1 record
  // in `data/jobs/by-crawler/fnz.json` uses that fallback today, so this pins
  // a latent regression.
  it('refuses a foreign primary even when a later candidate is Swiss', () => {
    expect(resolveFnzSwissLocation(['Frankfurt, Germany', 'Switzerland'])).toBeNull();
    expect(resolveFnzSwissLocation(['Frankfurt, Germany', 'Zurich'])).toBeNull();
    expect(resolveFnzLocation(['London, United Kingdom', 'Switzerland'])).toBeNull();
  });

  it('refuses a req with no primary location instead of inventing a Bern address', () => {
    expect(resolveFnzSwissLocation(['', 'Switzerland'])).toBeNull();
    expect(resolveFnzSwissLocation([])).toBeNull();
  });

  it('still enriches a Swiss country-only primary from a later candidate', () => {
    expect(resolveFnzSwissLocation(['Switzerland', 'Chiasso'])).toMatchObject({
      location: 'Chiasso',
      canton: 'TI',
    });
  });

  it('keeps the primary-only publish gate exported and wired into the resolver', () => {
    expect(hasFnzSwissPrimaryLocation(['Frankfurt, Germany', 'Switzerland'])).toBe(false);
    expect(hasFnzSwissPrimaryLocation(['Switzerland'])).toBe(true);
    expect(hasFnzSwissPrimaryLocation([])).toBe(false);
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

// Fixture: the start of a live Workday `jobDescription` (Chiasso, 2026-09-29).
describe('FNZ description fields', () => {
  const text = fs.readFileSync(new URL('./fixtures/fnz/workday-description-chiasso.txt', import.meta.url), 'utf8').trim();

  it('publishes the Workday text alone, keyed by its language', () => {
    const fields = buildFnzDescriptionFields('Solution Consultant CRM', text, 'Chiasso');
    expect(fields.description).toBe(text);
    expect(fields.descriptionByLocale).toEqual({ en: text });
    expect(fields.description).not.toContain('FNZ is a global fintech platform provider');
  });

  it('removes the Italian blurb and the translations of the blurb-appended source from a stored job', () => {
    const job: any = {
      sourceLang: 'en',
      descriptionByLocale: {
        en: `${text}\n\nFNZ is a global fintech platform provider that partners with financial institutions, wealth managers, and asset managers.`,
        it: 'Posizione aperta presso FNZ a Chiasso.\nRuolo: Solution Consultant CRM.\n\nFNZ è un provider globale di piattaforme fintech che collabora con istituzioni finanziarie.',
        fr: 'Description du rôle …',
      },
    };
    expect(dropFnzFabricatedText(job)).toBe(true);
    expect(Object.keys(job.descriptionByLocale)).toEqual(['en']);
    expect(job.needsRetranslation).toBe(true);
    const clean: any = { sourceLang: 'en', descriptionByLocale: { en: text, it: 'Descrizione del ruolo …' } };
    expect(dropFnzFabricatedText(clean)).toBe(false);
  });
});
