/**
 * job-location-audit-layers — the two detectors behind layers 5 and 6 of
 * scripts/audit-job-locations.mjs.
 *
 * Every fixture is a value taken verbatim from `data/jobs/by-crawler/*.json`,
 * on the side it belongs to. That matters more here than usual, because both
 * detectors exist to separate a defect from prose that merely resembles it, and
 * a test written from imagination would not contain the resemblance:
 * `Standort: Aarau (Kanton AG)` is correct German and appears 421 times, while
 * `Konolfingen, CH, Kanton BE` is the defect and appears 35 times. A detector
 * that cannot tell those apart is worse than none, because it opens work on
 * 4,124 healthy jobs.
 *
 * No dataset is read — that is the whole reason the detectors live in
 * scripts/lib/job-location-plausibility.mjs rather than in the audit script.
 */
import { describe, expect, it } from 'vitest';
import {
  descriptionRepeatsRegion,
  implausibilityReasons,
} from '../scripts/lib/job-location-plausibility.mjs';

describe('implausibilityReasons — layer 6', () => {
  it('accepts every shape a real Swiss municipality has', () => {
    // Checked against data/canton-municipalities.json: of 2,294 municipalities,
    // 1,977 are one word, 244 two, 67 three, and exactly six are four. None
    // reaches five. These are those six plus the longest by characters.
    for (const name of [
      'Lugano', 'Zürich', 'Bellinzona', 'La Chaux-de-Fonds', 'Baden-Daettwil',
      'Santa Maria in Calanca', 'Wangen an der Aare', 'Büren an der Aare',
      'Ellikon an der Thur', 'Thalheim an der Thur', 'Oetwil an der Limmat',
      'Deisswil bei Münchenbuchsee',
    ]) {
      expect(implausibilityReasons(name), name).toEqual([]);
    }
  });

  it('rejects page furniture a scraper left in the location field', () => {
    // The job that opened this work: /cerca-lavoro-berna/masterdata-specialista-
    // 60-rado-watch-co-ltd-.../ — the crawler stored the site's own navigation.
    expect(implausibilityReasons('0200 Deutsch Suche Suche Masterdata Specialist'))
      .toEqual(['too-many-words', 'repeated-word']);
    // Real values, one per offending crawler.
    expect(implausibilityReasons('2050 and has the highest-possible ESG rating from MSCI'))
      .toContain('too-many-words');
    expect(implausibilityReasons('free of discrimination of all forms')).toContain('too-many-words');
    expect(implausibilityReasons('EMEA · CHE · Stabio · VF Campus VF1')).toContain('too-many-words');
    expect(implausibilityReasons('Via al Mulino 22a, 6814 Cadempino')).toContain('too-many-words');
    expect(implausibilityReasons('Zürich, Oerlikon Hybrides Arbeiten: bis zu 40% #LI-Hybrid'))
      .toContain('too-many-words');
  });

  it('catches a doubled word even inside a short value', () => {
    expect(implausibilityReasons('Geneva GENEVA')).toEqual(['repeated-word']);
    // Folding is diacritic- and punctuation-insensitive, because the two copies
    // a scraper leaves rarely match byte for byte.
    expect(implausibilityReasons('Zürich, Zurich')).toEqual(['repeated-word']);
  });

  it('catches markup and URLs', () => {
    expect(implausibilityReasons('Wetzikon <br> Zürich')).toContain('markup');
    expect(implausibilityReasons('https://example.com/jobs')).toContain('markup');
  });

  it('keeps 43 characters of margin over the longest real name', () => {
    expect(implausibilityReasons('x'.repeat(70))).toEqual([]);
    expect(implausibilityReasons('x'.repeat(71))).toEqual(['over-70-chars']);
  });

  it('is empty and safe on an empty value', () => {
    expect(implausibilityReasons('')).toEqual([]);
  });
});

describe('descriptionRepeatsRegion — layer 5, the frozen half', () => {
  const withDescription = (description: string) => ({ description, descriptionByLocale: {} });

  it('finds the city → country → canton triple a crawler froze into the text', () => {
    expect(descriptionRepeatsRegion(
      withDescription('• Location: Konolfingen, CH, Kanton BE, Schweiz'), 'Konolfingen', 'BE',
    )).toBe('Konolfingen, CH, Kanton BE');
    expect(descriptionRepeatsRegion(
      withDescription('• Location: Lausanne, CH, VD canton, Switzerland'), 'Lausanne', 'VD',
    )).toBe('Lausanne, CH, VD');
    expect(descriptionRepeatsRegion(
      withDescription('Sede: Lugano, Svizzera (TI), presso la filiale'), 'Lugano', 'TI',
    )).toBe('Lugano, Svizzera (TI');
  });

  it('leaves correct prose alone — the whole point of requiring the country marker', () => {
    // Measured on the corpus: "two region qualifiers in a row" matches 4,124
    // jobs, and these are what they look like. Every one is good writing.
    for (const [text, location, canton] of [
      ['• Standort: Aarau (Kanton AG)', 'Aarau', 'AG'],          // kanton-aargau, 421 jobs
      ['- Standort: Zürich, Kanton ZH', 'Zürich', 'ZH'],          // helsana, 41 jobs
      ['Arbeitsort: Zürich (ZH)', 'Zürich', 'ZH'],
      ['Sede di lavoro: Zürich, Svizzera', 'Zürich', 'ZH'],
      ['Location: Bern, Switzerland', 'Bern', 'BE'],
    ] as const) {
      expect(descriptionRepeatsRegion(withDescription(text), location, canton), text).toBeNull();
    }
  });

  it('does not need the location field to still look wrong', () => {
    // This is the regression the production re-crawl exposed on 2026-08-19: the
    // nestle parser fix cleaned `location` on 85 of 86 jobs within the hour,
    // every stale description survived untouched, and the previous
    // marker-gated check went from 35 to 0 while 36 pages stayed broken.
    const job = withDescription('• Location: Konolfingen, CH, Kanton BE, Schweiz');
    expect(descriptionRepeatsRegion(job, 'Konolfingen', 'BE')).not.toBeNull();
  });

  it('searches every locale slot, not just the source description', () => {
    const job = {
      description: 'Beschreibung ohne Ort.',
      descriptionByLocale: { it: 'Sede: Vevey, CH, Canton VD.', de: 'Kein Ort.' },
    };
    expect(descriptionRepeatsRegion(job, 'Vevey', 'VD')).toBe('Vevey, CH, Canton VD');
  });

  it('treats a location containing regex metacharacters as literal text', () => {
    const job = withDescription('Standort: Lengnau (BE), CH, Kanton BE');
    expect(descriptionRepeatsRegion(job, 'Lengnau (BE)', 'BE')).toBe('Lengnau (BE), CH, Kanton BE');
  });

  it('is null on missing inputs rather than throwing', () => {
    expect(descriptionRepeatsRegion(withDescription('x'), '', 'BE')).toBeNull();
    expect(descriptionRepeatsRegion(withDescription('x'), 'Bern', '')).toBeNull();
    expect(descriptionRepeatsRegion({ descriptionByLocale: {} }, 'Bern', 'BE')).toBeNull();
  });
});
