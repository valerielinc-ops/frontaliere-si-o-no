import { describe, expect, it } from 'vitest';
import {
  isTsmgTargetLocation,
  inferTsmgRegion,
  inferTsmgCategory,
  buildTsmgLocalizedContent,
} from '../scripts/lib/tsmg-job-parser.mjs';
import { assertCompleteTsmgSourceSnapshot, normalizeTsmgCountry } from '../scripts/update-tsmg-jobs.mjs';

describe('tsmg-job-parser', () => {
  it('keeps only Ticino and Grigioni locations', () => {
    expect(isTsmgTargetLocation('Bellinzona')).toBe(true);
    expect(isTsmgTargetLocation('Lugano')).toBe(true);
    expect(isTsmgTargetLocation('Chur')).toBe(true);
    expect(isTsmgTargetLocation('Landquart')).toBe(true);
    expect(isTsmgTargetLocation('Lugano, Italy')).toBe(false);
    // Cathedral 2026-05-10: Zurich (ZH) is now a target canton — assertion updated to true.
    expect(isTsmgTargetLocation('Zurich')).toBe(true);
    expect(isTsmgTargetLocation('Furttal')).toBe(true);
  });

  it('maps target locations to their cantons', () => {
    expect(inferTsmgRegion('Bellinzona').canton).toBe('TI');
    expect(inferTsmgRegion('Chur').canton).toBe('GR');
    expect(inferTsmgRegion('Furttal')).toEqual({ canton: 'ZH', country: 'CH' });
    const furttalSnapshot = [{
      id: 'furttal-job',
      hostedUrl: 'https://jobs.lever.co/tsmg/furttal-job',
      country: 'CH',
      categories: { location: 'Furttal' },
    }];
    expect(assertCompleteTsmgSourceSnapshot(furttalSnapshot)).toEqual(furttalSnapshot);
  });

  it('builds localized content and locale slugs', () => {
    const job = {
      text: 'AI Speech Tester (Italian native speaker - Switzerland regional variant)',
      descriptionPlain: 'TSMG is a field data collection company.',
      openingPlain: 'We are looking for native speakers for a 2-hour recording session.',
      additionalPlain: 'Sessions are moderated on-site.',
      categories: { location: 'Bellinzona' },
      lists: [
        { text: 'Responsibilities', content: '<li>Participate in a paired conversation</li>' },
        { text: 'Requirements', content: '<li>Native speaker of the target language</li>' },
      ],
    };
    const localized = buildTsmgLocalizedContent(job);
    expect(localized.it.title).toContain('Tester conversazioni vocali AI');
    expect(localized.fr.description).toContain('TSMG recrute');
    expect(localized.de.slug).toContain('ki-sprachtester');
    expect(inferTsmgCategory(job.text)).toBe('tech');
  });

  it('fails closed when a source country is unknown instead of treating it as foreign', () => {
    expect(normalizeTsmgCountry('Germany')).toBe('FOREIGN');
    expect(normalizeTsmgCountry('UNKNOWN')).toBe('');
    expect(normalizeTsmgCountry('N/A')).toBe('');
    expect(() => assertCompleteTsmgSourceSnapshot([{
      id: 'unknown-country-job',
      hostedUrl: 'https://jobs.lever.co/tsmg/unknown-country-job',
      country: 'UNKNOWN',
      categories: { location: 'Unmapped City' },
    }])).toThrow(/not a recognised country value/);
  });
});
