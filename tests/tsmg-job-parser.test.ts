import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isTsmgTargetLocation,
  inferTsmgRegion,
  inferTsmgCategory,
  buildTsmgLocalizedContent,
} from '../scripts/lib/tsmg-job-parser.mjs';
import {
  assertCompleteTsmgSourceSnapshot,
  isTsmgSwissPosting,
  normalizeTsmgCountry,
} from '../scripts/update-tsmg-jobs.mjs';
import { extractStableJobId } from '../scripts/lib/job-match-key.mjs';

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

  it('discards foreign postings even when Lever exposes a Swiss-looking location', () => {
    const foreignSnapshot = [{
      id: 'foreign-with-swiss-looking-location',
      hostedUrl: 'https://jobs.lever.co/tsmg/foreign-with-swiss-looking-location',
      country: 'France',
      categories: { location: 'Villeneuve-sur-Lot' },
    }];

    expect(assertCompleteTsmgSourceSnapshot(foreignSnapshot)).toEqual(foreignSnapshot);
  });

  it('discards a foreign location misclassified as CH without failing the full snapshot', () => {
    const mismatchedSnapshot = [{
      id: 'foreign-location-marked-ch',
      hostedUrl: 'https://jobs.lever.co/tsmg/foreign-location-marked-ch',
      country: 'CH',
      categories: { location: 'France' },
    }];

    expect(assertCompleteTsmgSourceSnapshot(mismatchedSnapshot)).toEqual(mismatchedSnapshot);
    expect(isTsmgSwissPosting(mismatchedSnapshot[0])).toBe(false);
  });

  /**
   * Issue 9320: Lever serviva 3 posting su 4334 senza `country` («Jefferson
   * City, MO», «Windeck») e 2 posting CH con località non riconosciuta («Les
   * Diabterets», «Mont Tendre»): ciascuno rifiutava l'intero snapshot e TSMG è
   * rimasto fermo dal 2026-09-17. La quarantena per record vale solo per
   * posting che non possono toccare lo slice pubblicato.
   */
  describe('unclassifiable postings (issue 9320)', () => {
    const posting = (id: string, location: string, country: string | null = 'CH') => ({
      id,
      hostedUrl: `https://jobs.lever.co/tsmg/${id}`,
      country,
      categories: { location },
    });
    const clean = [
      posting('lugano-job', 'Lugano'),
      posting('zurich-job', 'Zurich'),
      posting('france-job', 'Lyon', 'FR'),
      posting('germany-job', 'Berlin', 'DE'),
      posting('usa-job', 'Austin, TX', 'US'),
      posting('italy-job', 'Milano', 'IT'),
    ];

    beforeEach(() => {
      vi.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('quarantines a posting without country whose location is not a target', () => {
      const missingCountry = posting('windeck-job', 'Windeck', null);
      const snapshot = [...clean, missingCountry, posting('jefferson-job', 'Jefferson City, MO', null)];

      const accepted = assertCompleteTsmgSourceSnapshot(snapshot);

      expect(accepted).toEqual(clean);
      expect(accepted.filter(isTsmgSwissPosting).map((job) => job.id)).toEqual(['lugano-job', 'zurich-job']);
    });

    it('quarantines a never-published CH posting whose location resolves to no canton', () => {
      const snapshot = [...clean, posting('diablerets-job', 'Les Diabterets'), posting('tendre-job', 'Mont Tendre')];

      expect(assertCompleteTsmgSourceSnapshot(snapshot)).toEqual(clean);
    });

    it('stays fail-closed when a posting without country could be a target vacancy', () => {
      expect(() => assertCompleteTsmgSourceSnapshot([...clean, posting('bellinzona-job', 'Bellinzona', null)]))
        .toThrow(/posting 7 of 7: missing country on a posting that may be a published or target Swiss vacancy \(id=bellinzona-job/);
    });

    it('stays fail-closed when an unclassifiable posting is already published', () => {
      const garbled = posting('published-job', 'Lugnao');
      const publishedKeys = new Set([extractStableJobId(garbled.hostedUrl)]);
      // Same posting, never published: quarantined like any non-target row.
      expect(assertCompleteTsmgSourceSnapshot([...clean, garbled])).toEqual(clean);

      expect(() => assertCompleteTsmgSourceSnapshot([...clean, garbled], { publishedKeys }))
        .toThrow(/"Lugnao" is not a recognised Swiss location \(id=published-job\)/);
      expect(() => assertCompleteTsmgSourceSnapshot([...clean, { ...garbled, country: null }], { publishedKeys }))
        .toThrow(/missing country on a posting that may be a published or target Swiss vacancy/);
    });

    it('names the missing structural fields instead of quarantining them', () => {
      expect(() => assertCompleteTsmgSourceSnapshot([...clean, { id: 'no-url', country: 'CH', categories: {} }]))
        .toThrow(/posting 7 of 7: missing hostedUrl, categories\.location \(id=no-url\)/);
      expect(() => assertCompleteTsmgSourceSnapshot([null]))
        .toThrow(/posting 1 of 1: missing posting/);
    });

    it('rejects the whole snapshot when unclassifiable postings are systemic', () => {
      const snapshot = [
        posting('lugano-job', 'Lugano'),
        posting('a-job', 'Windeck', null),
        posting('b-job', 'Jefferson City, MO', null),
        posting('c-job', 'Mont Tendre'),
      ];

      expect(() => assertCompleteTsmgSourceSnapshot(snapshot)).toThrow(/3\/4 postings could not be classified/);
    });
  });
});
