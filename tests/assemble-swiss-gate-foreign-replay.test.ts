import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applySwissLocationGate } from '../scripts/assemble-jobs-dataset.mjs';
import { archiveFilteredJobsToSlices, readExpiredSlice } from '../scripts/lib/expired-jobs-archive.mjs';
import { isExplicitlyOutsideTarget, isLocationExplicitlyForeign } from '../scripts/lib/dedicated-crawler-common.mjs';
import { isCantonRelevant, locationFieldHasSwissSignal } from '../scripts/lib/target-swiss-locations.mjs';

/**
 * Replay of #9846 on real rows.
 *
 * The fixture holds the rows of data/jobs/by-crawler/ (origin/main 707c4bd,
 * 2026-09-25) that the audit of foreign workplaces traced through the
 * assembler's Swiss whitelist, reduced to the fields the gate reads. Each
 * description keeps every sentence that names a Swiss municipality, in order,
 * i.e. everything the description rescue can latch onto.
 *
 * - `drop`: 23 postings abroad that the step-4 rescue republished as Swiss
 *   because a word of the description matched a municipality: "Hoffmann-La
 *   Roche" and "la Roche" → La Roche (FR), "Baden-Württemberg" → Baden (AG),
 *   the adjective "tenero" → Tenero (TI), the Dutch "leuk" → Leuk (VS), a
 *   list of offices → Zürich, the headquarters → Winterthur, a production
 *   network → Basel, plus "Santiago de Chile, Chile" kept on its Chilean
 *   postcode 2206.
 * - `keep`: the Tertianum home in Oberlindach (BE), dropped as a Berlin
 *   posting because "berlin" is a substring of its name.
 * - `keep:<city>`: Swiss rows the same step rescues today, which must keep
 *   their published locality.
 */
type ReplayRow = {
  crawler: string;
  location: string;
  addressLocality: string;
  canton: string;
  postalCode: string;
  streetAddress: string;
  expect: string;
  text: string[];
};

const rows: ReplayRow[] = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/swiss-gate-foreign-rescue-9846.json'), 'utf8'),
);

/** Published locality after the gate, or null when the gate drops the row. */
function publishedLocality(row: ReplayRow): string | null {
  const job = {
    location: row.location,
    addressLocality: row.addressLocality,
    canton: row.canton,
    postalCode: row.postalCode,
    streetAddress: row.streetAddress,
    description: row.text.join(' '),
  };
  const { jobs } = applySwissLocationGate([job]);
  return jobs.length ? String(job.addressLocality || job.location) : null;
}

const label = (row: ReplayRow) => `${row.crawler}: ${row.location} [${row.canton}]`;

describe('#9846 Swiss gate replay on real rows', () => {
  it('drops the 23 foreign postings the description rescue republished as Swiss', () => {
    const foreign = rows.filter((row) => row.expect === 'drop');
    expect(foreign).toHaveLength(23);
    const published = foreign
      .map((row) => [label(row), publishedLocality(row)] as const)
      .filter(([, locality]) => locality !== null)
      .map(([name, locality]) => `${name} -> ${locality}`);
    expect(published).toEqual([]);
  });

  it('keeps the Swiss home in Oberlindach (BE)', () => {
    const [oberlindach] = rows.filter((row) => row.location === 'Oberlindach');
    expect(publishedLocality(oberlindach)).not.toBeNull();
  });

  it('keeps every Swiss row the same step rescues today, with its locality', () => {
    const controls = rows.filter((row) => row.expect.startsWith('keep:'));
    expect(controls.length).toBeGreaterThanOrEqual(4);
    for (const row of controls) {
      expect(publishedLocality(row), label(row)).toBe(row.expect.slice('keep:'.length));
    }
  });
});

describe('#9846 a Swiss name glued to a foreign word is not Swiss geography', () => {
  const gate = (locality: string, canton: string, description: string) => {
    const job = { addressLocality: locality, location: locality, canton, postalCode: '', description };
    const { jobs } = applySwissLocationGate([job]);
    return jobs.length ? job.addressLocality : null;
  };

  it('drops Baden-Württemberg whatever canton the record carries', () => {
    expect(gate('Baden-Württemberg', 'TI', 'Baden-Württemberg')).toBeNull();
    expect(gate('Baden-Württemberg', 'AG', 'Baden-Württemberg')).toBeNull();
  });

  it('keeps a foreign compound in the foreign context unless the record\'s canton owns the Swiss part', () => {
    // Karsau is a quarter of the German Rheinfelden; the Swiss one is in Aargau.
    expect(locationFieldHasSwissSignal('Rheinfelden-Karsau', 'BS')).toBe(false);
    expect(gate('Rheinfelden-Karsau', 'BS', 'Werk Rheinfelden-Karsau')).toBeNull();
  });

  it('keeps municipality-quarter compounds of the record\'s own canton', () => {
    expect(gate('Baden-Dättwil', 'AG', 'Standort Baden-Dättwil')).toBe('Baden');
    expect(gate('Risch-Rotkreuz', 'ZG', 'Standort Risch-Rotkreuz')).toBe('Risch');
    expect(gate('Estavayer-le-Lac', 'FR', 'Site Estavayer-le-Lac')).toBe('Estavayer');
    expect(locationFieldHasSwissSignal('Basel-Stadt', 'TI')).toBe(true);
    expect(locationFieldHasSwissSignal('Nordwest-Schweiz', '')).toBe(true);
  });
});

describe('#9846 toponyms are whole words, never substrings', () => {
  it('does not read Berlin inside Oberlindach', () => {
    expect(isLocationExplicitlyForeign('Oberlindach')).toBe(false);
    expect(isExplicitlyOutsideTarget('Oberlindach')).toBe(false);
  });

  it('still reads a foreign city as a word, also inside a hyphenated compound', () => {
    expect(isLocationExplicitlyForeign('Berlin')).toBe(true);
    expect(isLocationExplicitlyForeign('Berlin-Mitte')).toBe(true);
    expect(isExplicitlyOutsideTarget('Berlin-Mitte')).toBe(true);
    expect(isLocationExplicitlyForeign('Wien 1010')).toBe(true);
  });

  it('reads an explicit country the location field names', () => {
    expect(isLocationExplicitlyForeign('Santiago de Chile, Chile')).toBe(true);
    expect(isLocationExplicitlyForeign('San Jose, Costa Rica')).toBe(true);
  });

  it('does not read Como inside the Italian "comodo"', () => {
    expect(isCantonRelevant('un posto di lavoro comodo', 'TI')).toBe(false);
    expect(isCantonRelevant('a pochi minuti da Como', 'TI')).toBe(true);
  });
});

describe('Swiss locality variants and canton-scoped homonyms', () => {
  const realSwissRows = [
    ['Bremgarten', 'AG'],
    ['Geneva', 'GE'],
    ['Küssnacht am Rigi', 'SZ'],
    ['Gossau', 'SG'],
    ['Bienne', 'BE'],
  ] as const;

  it('keeps the real Swiss localities that the current slices expose', () => {
    for (const [locality, canton] of realSwissRows) {
      const job = {
        location: locality,
        addressLocality: locality,
        canton,
        postalCode: '',
        description: '',
      };
      const result = applySwissLocationGate([job]);
      expect(result.jobs, `${locality} (${canton})`).toHaveLength(1);
    }
  });

  it('keeps both canton owners of an ambiguous bare municipality', () => {
    for (const canton of ['SG', 'ZH']) {
      const job = { location: 'Gossau', addressLocality: 'Gossau', canton, description: '' };
      expect(applySwissLocationGate([job]).jobs, `Gossau (${canton})`).toHaveLength(1);
    }
  });

  it('keeps official Swiss localities even when the source canton is stale or absent', () => {
    const cases = [
      ['Le Crêt-Du-Locle', 'GE'], // official locality in NE; source carries GE
      ['Nussbaumen', 'FR'],       // official localities in AG/TG; source carries FR
      ['Wohlen', ''],             // AG/BE homonym with no structured canton
      ['Feldmeilen', 'ZH'],
      ['Haag', 'SG'],
    ] as const;
    for (const [locality, canton] of cases) {
      const job = {
        location: locality,
        addressLocality: locality,
        canton,
        postalCode: '',
        description: '',
      };
      expect(applySwissLocationGate([job]).jobs, `${locality} (${canton || 'missing canton'})`).toHaveLength(1);
    }
  });

  it('keeps the additional real variants found by the slice audit', () => {
    const variants = [
      'Charmey', 'Cuira', 'Domats-Ems', 'Fehraltdorf', 'Fusterie',
      'Küssnacht a', 'Langnau Ilfis', 'Les Diabterets', 'Marin', 'Neuhausen Posthof',
      'Plan', 'Räterschen', 'Saint Légier', 'Yverdon',
    ];
    for (const locality of variants) {
      const job = { location: locality, addressLocality: locality, description: '' };
      expect(applySwissLocationGate([job]).jobs, locality).toHaveLength(1);
    }
  });

  it('keeps a true foreign locality out of active publication', () => {
    const job = {
      companyKey: 'colin-cie',
      location: 'Munsbach, Luxembourg',
      addressLocality: 'Munsbach, Luxembourg',
      canton: '',
      description: '',
    };
    const result = applySwissLocationGate([job]);
    expect(result.jobs).toHaveLength(0);
    expect(result.dropped[0]?.reason).toBe('foreign-location');
  });

  it('archives a gate exclusion once and preserves its expired route', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swiss-gate-expired-'));
    const job = {
      companyKey: 'colin-cie',
      slug: 'test-munsbach-luxembourg',
      title: 'Test foreign posting',
      company: 'Colin & Cie',
      location: 'Munsbach, Luxembourg',
      addressLocality: 'Munsbach, Luxembourg',
      descriptionByLocale: { it: 'Test' },
    };
    try {
      expect(archiveFilteredJobsToSlices([{ job, reason: 'foreign-location' }], { dir }).added).toBe(1);
      const first = readExpiredSlice('colin-cie', { dir });
      expect(first).toHaveLength(1);
      expect(first[0].slug).toBe(job.slug);
      const expiredAt = first[0].expiredAt;
      expect(archiveFilteredJobsToSlices([{ job, reason: 'foreign-location' }], { dir }).added).toBe(0);
      expect(readExpiredSlice('colin-cie', { dir })[0].expiredAt).toBe(expiredAt);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
