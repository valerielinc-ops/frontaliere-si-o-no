/**
 * #3513 — JobPosting PostalAddress coherence.
 *
 * Safe-default street/CAP must anchor on the SAME place as the posting's
 * addressLocality. Audited incoherences:
 *  - EOC job: HQ street+CAP (Viale Officina 3, 6500 Bellinzona) paired with
 *    addressLocality "Lugano" (same canton — the old canton-level gate passed)
 *  - Coop job: Ticino HQ street on a Winterthur (ZH) posting
 *  - UBS job: region name "Ticino" emitted as addressLocality
 *
 * The 9 mandatory JobPosting fields must ALWAYS stay populated
 * (Non-Negotiable #3) — these tests assert coherence, never absence.
 */
import { describe, it, expect } from 'vitest';
import MUNICIPALITY_DATA from '../../data/canton-municipalities.json' with { type: 'json' };
import { readFileSync } from 'node:fs';
import { buildJobPostingSchema, resolveJobPostingAddress } from '../../build-plugins/shared/jobPostingSchema';
import { resolveLocalityPostalCode } from '../../build-plugins/shared/postalCodes';
import { resolveJobPostingPostalCode } from '../../services/jobLocationSnapshot';
import { transformSync } from 'esbuild';
import {
  CANTON_CAPITAL_ADDRESSES,
  localityMatchesHq,
  regionLocalityCapital,
  resolveFallbackAddress,
} from '../../build-plugins/shared/companyHqAddresses';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain ESM helper without type declarations
import { sameLocalityAsHq, applyCompanyDefaults, hqPostalCodeForLocality } from '../../scripts/lib/dedicated-crawler-common.mjs';

const OPTS = { locale: 'it', url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/x/' };

const baseJob = {
  title: 'Infermiere/a',
  description: 'Ruolo infermieristico con responsabilità cliniche e collaborazione con il team multidisciplinare della struttura.',
  company: 'EOC',
};

const CANTON_CAPITALS = {
  AG: { city: 'Aarau', postalCode: '5000' },
  AI: { city: 'Appenzell', postalCode: '9050' },
  AR: { city: 'Herisau', postalCode: '9100' },
  BE: { city: 'Bern', postalCode: '3011' },
  BL: { city: 'Liestal', postalCode: '4410' },
  BS: { city: 'Basel', postalCode: '4001' },
  FR: { city: 'Fribourg', postalCode: '1700' },
  GE: { city: 'Genève', postalCode: '1204' },
  GL: { city: 'Glarus', postalCode: '8750' },
  GR: { city: 'Chur', postalCode: '7000' },
  JU: { city: 'Delémont', postalCode: '2800' },
  LU: { city: 'Luzern', postalCode: '6004' },
  NE: { city: 'Neuchâtel', postalCode: '2000' },
  NW: { city: 'Stans', postalCode: '6370' },
  OW: { city: 'Sarnen', postalCode: '6060' },
  SG: { city: 'St. Gallen', postalCode: '9000' },
  SH: { city: 'Schaffhausen', postalCode: '8200' },
  SO: { city: 'Solothurn', postalCode: '4500' },
  SZ: { city: 'Schwyz', postalCode: '6430' },
  TG: { city: 'Frauenfeld', postalCode: '8500' },
  TI: { city: 'Bellinzona', postalCode: '6500' },
  UR: { city: 'Altdorf', postalCode: '6460' },
  VD: { city: 'Lausanne', postalCode: '1003' },
  VS: { city: 'Sion', postalCode: '1950' },
  ZG: { city: 'Zug', postalCode: '6300' },
  ZH: { city: 'Zürich', postalCode: '8001' },
} as const;

describe('buildJobPostingSchema — address coherence (#3513)', () => {
  it('same-canton job in a DIFFERENT city no longer inherits the HQ street/CAP', () => {
    const s = buildJobPostingSchema(
      { ...baseJob, companyKey: 'eoc-ente-ospedaliero-cantonale', addressLocality: 'Lugano', addressRegion: 'TI' },
      OPTS,
    );
    const addr = s.jobLocation.address;
    expect(addr.addressLocality).toBe('Lugano');
    expect(addr.postalCode).toBe('6900'); // Lugano CAP, not HQ 6500
    expect(addr.streetAddress).not.toBe('Viale Officina 3'); // not the Bellinzona HQ street
    expect(addr.streetAddress.length).toBeGreaterThan(0); // mandatory field stays populated
  });

  it('job in the HQ city keeps the curated HQ street/CAP', () => {
    const s = buildJobPostingSchema(
      { ...baseJob, companyKey: 'eoc-ente-ospedaliero-cantonale', addressLocality: 'Bellinzona', addressRegion: 'TI' },
      OPTS,
    );
    const addr = s.jobLocation.address;
    expect(addr.streetAddress).toBe('Viale Officina 3');
    expect(addr.postalCode).toBe('6500');
    expect(addr.addressLocality).toBe('Bellinzona');
  });

  it('job with no city signal still gets the fully-populated HQ address', () => {
    const s = buildJobPostingSchema(
      { ...baseJob, companyKey: 'eoc-ente-ospedaliero-cantonale' },
      OPTS,
    );
    const addr = s.jobLocation.address;
    expect(addr.streetAddress).toBe('Viale Officina 3');
    expect(addr.postalCode).toBe('6500');
    expect(addr.addressLocality).toBe('Bellinzona');
  });

  it('FNZ Zurich posting gets Zurich CAP/region instead of the Lugano HQ pair', () => {
    const s = buildJobPostingSchema(
      {
        ...baseJob,
        company: 'FNZ (Switzerland) AG',
        companyKey: 'fnz',
        addressLocality: 'Zürich',
        addressRegion: 'ZH',
      },
      OPTS,
    );
    const addr = s.jobLocation.address;
    expect(addr.addressLocality).toBe('Zürich');
    expect(addr.postalCode).toBe('8001');
    expect(addr.addressRegion).toBe('ZH');
    expect(addr.streetAddress).not.toBe('Via Cantonale 19');
  });

  it('region name shipped as locality ("Ticino") normalizes to a coherent capital locality', () => {
    const s = buildJobPostingSchema(
      { ...baseJob, company: 'UBS', companyKey: 'ubs', addressLocality: 'Ticino', addressRegion: 'TI', postalCode: '6500' },
      OPTS,
    );
    const addr = s.jobLocation.address;
    expect(addr.addressLocality).toBe('Bellinzona'); // never a region as locality
    expect(addr.postalCode).toBe('6500'); // coherent with Bellinzona
    expect(addr.streetAddress).not.toBe('Via G. Calgari 2'); // not the Lugano HQ street
  });

  it('explicit source street+CAP always win over defaults', () => {
    const s = buildJobPostingSchema(
      { ...baseJob, addressLocality: 'Lugano', streetAddress: 'Via Nassa 5', postalCode: '6900' },
      OPTS,
    );
    expect(s.jobLocation.address.streetAddress).toBe('Via Nassa 5');
    expect(s.jobLocation.address.postalCode).toBe('6900');
  });

  it('rejects a known CAP from another locality as a pair, not just as a field (#9108)', () => {
    const s = buildJobPostingSchema(
      {
        ...baseJob,
        addressLocality: 'Lugano',
        addressRegion: 'TI',
        streetAddress: 'Piazza Governo 1',
        postalCode: '6500', // Bellinzona's known CAP, not Lugano's
      },
      OPTS,
    );
    const addr = s.jobLocation.address;
    expect(addr.addressLocality).toBe('Lugano');
    expect(addr.addressRegion).toBe('TI');
    expect(addr.postalCode).toBe('6900');
    expect(addr.streetAddress).not.toBe('Piazza Governo 1');
    expect(addr.streetAddress).toBeTruthy();
  });

  it('uses the complete postal snapshot for a municipality outside the curated aliases', () => {
    const s = buildJobPostingSchema(
      {
        ...baseJob,
        addressLocality: 'Novaggio',
        addressRegion: 'TI',
        streetAddress: 'Via del Centro 1',
        postalCode: '6500', // Bellinzona's CAP, not Novaggio's snapshot CAP
      },
      OPTS,
    );
    const addr = s.jobLocation.address;
    expect(addr.addressLocality).toBe('Novaggio');
    expect(addr.addressRegion).toBe('TI');
    expect(addr.postalCode).toBe('6986');
    expect(addr.streetAddress).not.toBe('Via del Centro 1');
    expect(addr.streetAddress).toBeTruthy();
  });

  it('garbage/leaked free-text locality (Hirslanden Arbeitsort leak) never survives into the schema', () => {
    const s = buildJobPostingSchema(
      {
        ...baseJob,
        company: 'Hirslanden Klinik',
        companyKey: 'hirslanden-klinik',
        addressLocality: 'Bern - Futsal Minerva Besetzung per: 1',
        addressRegion: 'BE',
      },
      OPTS,
    );
    const addr = s.jobLocation.address;
    expect(addr.addressLocality).not.toBe('Bern - Futsal Minerva Besetzung per: 1');
    expect(addr.addressLocality).toBe('Bern'); // BE canton-capital fallback, no HQ/city match
    expect(addr.addressRegion).toBe('BE');
    expect(addr.streetAddress.length).toBeGreaterThan(0);
  });

  it('real city from the WRONG canton (Bellinzona/TI text with addressRegion BE) never pairs mismatched', () => {
    const s = buildJobPostingSchema(
      {
        ...baseJob,
        company: 'Hirslanden Klinik',
        companyKey: 'hirslanden-klinik',
        addressLocality: 'Bellinzona',
        addressRegion: 'BE',
      },
      OPTS,
    );
    const addr = s.jobLocation.address;
    expect(addr.addressLocality).not.toBe('Bellinzona');
    expect(addr.addressLocality).toBe('Bern'); // coherent with the authoritative BE region
    expect(addr.addressRegion).toBe('BE');
    expect(addr.postalCode).toBe('3001'); // resolvePostalCode('Bern', 'BE') — a real Bern CAP
  });
});

/**
 * Issue 9852: the canton capital's street/CAP never completes the address of a
 * DIFFERENT locality. The capital tuple stays legal only as a whole (locality
 * included), e.g. when the source locality is unknown.
 */
function expectNoCapitalTupleBesideAnotherLocality(address: {
  addressLocality: string;
  addressRegion: string;
  postalCode: string;
  streetAddress: string;
}) {
  const capital = CANTON_CAPITAL_ADDRESSES[address.addressRegion];
  if (address.addressLocality === capital.addressLocality) return;
  expect(address.streetAddress, `${address.addressLocality}: capital street`).not.toBe(capital.streetAddress);
  expect(address.postalCode, `${address.addressLocality}: capital CAP`).not.toBe(capital.postalCode);
}

describe('buildJobPostingSchema — no canton-capital street/CAP beside another locality (#9852)', () => {
  it.each([
    ['Pully', 'VD', '1009', 'Pully centro'],
    ['Aubonne', 'VD', '1170', 'Aubonne centro'],
    ['Weinfelden', 'TG', '8570', 'Weinfelden centro'],
  ])('%s %s keeps its locality with its own official CAP and a street of its own', (locality, region, postalCode, street) => {
    const addr = buildJobPostingSchema({ ...baseJob, addressLocality: locality, addressRegion: region }, OPTS)
      .jobLocation.address;
    expect(addr).toMatchObject({ addressLocality: locality, addressRegion: region, postalCode, streetAddress: street });
    expectNoCapitalTupleBesideAnotherLocality(addr);
  });

  it('Villars-sur-Ollon VD (a locality of Ollon, curated alias) gets its official CAP 1884', () => {
    // Not a BFS municipality: the CAP comes from the directory's locality rows.
    expect(resolveLocalityPostalCode('Villars-sur-Ollon', 'VD')).toBe('1884');
    const addr = buildJobPostingSchema(
      { ...baseJob, addressLocality: 'Villars-sur-Ollon', addressRegion: 'VD' },
      OPTS,
    ).jobLocation.address;
    expect(addr).toMatchObject({
      addressLocality: 'Villars-sur-Ollon',
      postalCode: '1884',
      streetAddress: 'Villars-sur-Ollon centro',
    });
    expectNoCapitalTupleBesideAnotherLocality(addr);
  });

  it('rejects the capital CAP a crawler stamped on another locality, keeps it on the capital', () => {
    const arisdorf = buildJobPostingSchema(
      { ...baseJob, addressLocality: 'Arisdorf', addressRegion: 'BL', postalCode: '4410', streetAddress: 'Rathausstrasse 36' },
      OPTS,
    ).jobLocation.address;
    expect(arisdorf).toMatchObject({ addressLocality: 'Arisdorf', postalCode: '4422', streetAddress: 'Arisdorf centro' });
    expectNoCapitalTupleBesideAnotherLocality(arisdorf);

    const liestal = buildJobPostingSchema(
      { ...baseJob, addressLocality: 'Liestal', addressRegion: 'BL', postalCode: '4410', streetAddress: 'Rathausstrasse 36' },
      OPTS,
    ).jobLocation.address;
    expect(liestal).toMatchObject({ addressLocality: 'Liestal', postalCode: '4410', streetAddress: 'Rathausstrasse 36' });

    // canton-postal-fallback's representative ZH CAP (Zürich 8000) on Brütten.
    const brutten = buildJobPostingSchema(
      { ...baseJob, addressLocality: 'Brütten', addressRegion: 'ZH', postalCode: '8000' },
      OPTS,
    ).jobLocation.address;
    expect(brutten).toMatchObject({ addressLocality: 'Brütten', postalCode: '8311' });
    // A default CAP that IS the locality's own stays (Massagno shares 6900).
    const massagno = buildJobPostingSchema(
      { ...baseJob, addressLocality: 'Massagno', addressRegion: 'TI', postalCode: '6900' },
      OPTS,
    ).jobLocation.address;
    expect(massagno.postalCode).toBe('6900');
  });

  it('a known locality without any CAP of its own keeps the locality the page shows (review of #9870)', () => {
    // "Oerlikon" is a curated ZH alias that the official directory does not
    // list. The page shows Oerlikon, so the JSON-LD must too: postalCode stays
    // mandatory (Non-Negotiable #3) and takes the canton safe default, while
    // the street is Oerlikon's own, never the capital's.
    const addr = resolveJobPostingAddress({ addressLocality: 'Oerlikon', addressRegion: 'ZH' }, 'it');
    expect(addr.addressLocality).toBe('Oerlikon');
    expect(addr.addressRegion).toBe('ZH');
    expect(addr.postalCode).toMatch(/^\d{4}$/);
    expect(addr.streetAddress).toBe('Oerlikon centro');
    expect(addr.streetAddress).not.toBe(CANTON_CAPITAL_ADDRESSES.ZH.streetAddress);
    expect(buildJobPostingSchema({ ...baseJob, addressLocality: 'Oerlikon', addressRegion: 'ZH' }, OPTS)
      .jobLocation.address.addressLocality).toBe('Oerlikon');
  });

  it('the SPA JobBoard JobPosting gets every address from the same resolver', () => {
    // JobBoard replaces the static JSON-LD at runtime; its own fallback CAP
    // (deriveJobPostalCode → Lugano's 6900) must not survive beside Pully.
    expect(resolveJobPostingAddress(
      { addressLocality: 'Pully', addressRegion: 'VD', postalCode: '6900', streetAddress: '' },
      'fr',
    )).toMatchObject({ addressLocality: 'Pully', postalCode: '1009', streetAddress: 'Pully centre-ville' });
    const jobBoard = readFileSync(new URL('../../components/community/JobBoard.tsx', import.meta.url), 'utf8');
    expect(jobBoard).toMatch(/const jobAddress = resolveJobPostingAddress\(/);
    expect(jobBoard).toMatch(/jobLocation: \{\s*'@type': 'Place',\s*address: jobAddress,\s*\}/);
  });

  it('remote and multi-location JobBoard postings never pair "Switzerland" with a concrete CAP or street (review of #9870)', () => {
    // A country-level address cannot carry the postalCode/streetAddress that
    // Non-Negotiable #3 makes mandatory, so JobBoard no longer rewrites the
    // locality to "Switzerland"/"CH": a remote posting keeps one coherent
    // place tuple, as on the static page, and remoteness stays in
    // jobLocationType (TELECOMMUTE) and applicantLocationRequirements.
    const jobBoard = readFileSync(new URL('../../components/community/JobBoard.tsx', import.meta.url), 'utf8');
    expect(jobBoard).not.toMatch(/addressLocality: (?:isRemote|multiLoc) \? 'Switzerland'/);
    expect(jobBoard).not.toMatch(/addressRegion: (?:isRemote|multiLoc) \? 'CH'/);
    expect(jobBoard).not.toContain('CANTON_FALLBACK_POSTAL');
    expect(jobBoard).toMatch(/jobLocationType: isRemote \? 'TELECOMMUTE' : undefined/);
    const remote = resolveJobPostingAddress(
      { addressLocality: 'Pully', addressRegion: 'VD', postalCode: '1009', streetAddress: 'Avenue de Lavaux 1' },
      'fr',
    );
    expect(remote).toMatchObject({ addressLocality: 'Pully', postalCode: '1009', streetAddress: 'Avenue de Lavaux 1' });
    expect(remote.addressLocality).not.toBe('Switzerland');
    // A multi-location label is not a locality: one coherent canton tuple.
    const multi = resolveJobPostingAddress({ addressLocality: 'Lugano · Bellinzona · Mendrisio', addressRegion: 'TI' }, 'it');
    expect(multi).toMatchObject(CANTON_CAPITAL_ADDRESSES.TI);
  });

  it('every BFS municipality resolves to a CAP of its own, canton-scoped', () => {
    const missing: string[] = [];
    for (const [canton, data] of Object.entries(MUNICIPALITY_DATA.cantons)) {
      for (const municipality of data.municipalities) {
        if (!/^\d{4}$/.test(resolveLocalityPostalCode(municipality, canton))) missing.push(`${canton}|${municipality}`);
      }
    }
    expect(missing).toEqual([]);
    // Disambiguated homonyms reach their own canton's CAP.
    expect(resolveLocalityPostalCode('Küsnacht', 'ZH')).toBe('8700');
    expect(resolveLocalityPostalCode('Wald', 'AR')).toBe('9044');
    expect(resolveLocalityPostalCode('Gossau', 'ZH')).toBe('8625');
    expect(resolveLocalityPostalCode('Gossau', 'SG')).toBe('9200');
    // An unknown locality has no CAP, instead of borrowing the capital's.
    expect(resolveLocalityPostalCode('Nowhere-sur-Rien', 'VD')).toBe('');
  });
});

describe('buildJobPostingSchema — parenthetical-only BFS municipalities (#6147)', () => {
  it('a bare city name that only exists as "<City> (XX)" in the gazetteer is NOT replaced by the canton capital', () => {
    const s = buildJobPostingSchema(
      { ...baseJob, addressLocality: 'Küsnacht', addressRegion: 'ZH' },
      OPTS,
    );
    const addr = s.jobLocation.address;
    expect(addr.addressLocality).toBe('Küsnacht'); // not the ZH capital "Zürich"
    expect(addr.addressRegion).toBe('ZH');
  });

  it('disambiguation is canton-scoped: the same bare name under the WRONG region still falls back, never guesses', () => {
    const s = buildJobPostingSchema(
      { ...baseJob, addressLocality: 'Oberwil', addressRegion: 'ZH' }, // Oberwil is BL, not ZH
      OPTS,
    );
    const addr = s.jobLocation.address;
    expect(addr.addressLocality).not.toBe('Oberwil');
    expect(addr.addressLocality).toBe('Zürich'); // ZH capital fallback, no invented canton
    expect(addr.addressRegion).toBe('ZH');
  });

  it('a homonym across three cantons resolves via the job canton, not the first BFS match', () => {
    for (const region of ['AR', 'BE', 'ZH']) { // Wald exists in all three, parenthetical-only in the gazetteer
      const s = buildJobPostingSchema({ ...baseJob, addressLocality: 'Wald', addressRegion: region }, OPTS);
      expect(s.jobLocation.address.addressLocality).toBe('Wald');
      expect(s.jobLocation.address.addressRegion).toBe(region);
    }
  });
});

describe('shared locality helpers (#3513)', () => {
  it('resolveFallbackAddress returns a coherent capital tuple for all 26 cantons', () => {
    expect(MUNICIPALITY_DATA.totalMunicipalities).toBe(2110);
    expect(Object.keys(CANTON_CAPITALS)).toHaveLength(26);

    for (const [canton, expected] of Object.entries(CANTON_CAPITALS)) {
      const cantonData = MUNICIPALITY_DATA.cantons[canton as keyof typeof MUNICIPALITY_DATA.cantons];
      const municipalities = [
        ...(cantonData?.municipalities || []),
        ...(cantonData?.aliases || []),
      ];
      const hasCapital = municipalities.some((municipality) => municipality === expected.city
        || municipality.replace(/\s*\([A-Z]{2}\)$/i, '') === expected.city);
      expect(hasCapital, `${canton} capital must exist in BFS municipality data`).toBe(true);
      expect(CANTON_CAPITAL_ADDRESSES[canton]).toMatchObject({
        addressLocality: expected.city,
        postalCode: expected.postalCode,
        addressRegion: canton,
      });

      const address = resolveFallbackAddress(undefined, expected.city, canton);
      expect(address).toMatchObject({
        addressLocality: expected.city,
        postalCode: expected.postalCode,
        addressRegion: canton,
      });
      expect(address.streetAddress).toBeTruthy();
    }
  });

  it('never keeps a non-capital city with the capital postal code', () => {
    const address = resolveFallbackAddress(undefined, 'Heiden', 'AR');

    expect(address).toMatchObject({
      addressLocality: 'Herisau',
      postalCode: '9100',
      addressRegion: 'AR',
    });
  });

  it('keeps the nine newly covered capital CAPs in emitted JobPosting schema', () => {
    for (const canton of ['AI', 'AR', 'BL', 'GL', 'JU', 'NW', 'OW', 'SZ', 'UR'] as const) {
      const expected = CANTON_CAPITALS[canton];
      const schema = buildJobPostingSchema({
        ...baseJob,
        addressLocality: expected.city,
        addressRegion: canton,
      }, OPTS);

      expect(schema.jobLocation.address).toMatchObject({
        addressLocality: expected.city,
        postalCode: expected.postalCode,
        addressRegion: canton,
      });
    }
  });

  it('localityMatchesHq: empty city matches, different city does not', () => {
    const hq = { addressLocality: 'Bellinzona' };
    expect(localityMatchesHq('', hq)).toBe(true);
    expect(localityMatchesHq('Bellinzona', hq)).toBe(true);
    expect(localityMatchesHq('Bellinzona (TI)', hq)).toBe(true);
    expect(localityMatchesHq('Lugano', hq)).toBe(false);
  });

  it('regionLocalityCapital maps region names and leaves real cities alone', () => {
    expect(regionLocalityCapital('Ticino')?.addressLocality).toBe('Bellinzona');
    expect(regionLocalityCapital('Tessin')?.addressLocality).toBe('Bellinzona');
    expect(regionLocalityCapital('Lugano')).toBeNull();
    expect(regionLocalityCapital('')).toBeNull();
  });

  it('resolveFallbackAddress no longer returns HQ for a same-canton different city', () => {
    const addr = resolveFallbackAddress('eoc-ente-ospedaliero-cantonale', 'lugano');
    expect(addr.streetAddress).not.toBe('Viale Officina 3');
    expect(addr.streetAddress.length).toBeGreaterThan(0);
    expect(addr.addressRegion).toBe('TI');
  });

  it('uses a curated non-TI HQ when the city is absent', () => {
    expect(resolveFallbackAddress('microsoft')).toMatchObject({
      addressLocality: 'Zürich',
      addressRegion: 'ZH',
      postalCode: '8058',
      streetAddress: 'The Circle 02',
    });
  });
});

describe('applyCompanyDefaults — crawler-side stamping (#3513)', () => {
  it('does not stamp HQ street/CAP on a same-canton job in a different city', () => {
    const job = applyCompanyDefaults(
      { addressLocality: 'Lugano', location: 'Lugano' },
      'eoc-ente-ospedaliero-cantonale',
    );
    expect(job.streetAddress).toBeUndefined();
    expect(job.postalCode).toBeUndefined();
    expect(job.addressRegion).toBe('TI'); // region default still applied
  });

  it('keeps the crawler canton for a homonymous city during HQ hardening', () => {
    const job = applyCompanyDefaults(
      { addressLocality: 'Buchs', location: 'Buchs', canton: 'AG' },
      'eoc-ente-ospedaliero-cantonale',
    );
    expect(job.addressRegion).toBe('AG');
    expect(job.streetAddress).toBeUndefined();
    expect(job.postalCode).toBeUndefined();
  });

  it('still stamps HQ street/CAP when the job is in the HQ city or has no city', () => {
    const inHqCity = applyCompanyDefaults({ addressLocality: 'Bellinzona' }, 'eoc-ente-ospedaliero-cantonale');
    expect(inHqCity.streetAddress).toBe('Viale Officina 3');
    expect(inHqCity.postalCode).toBe('6500');
    const noCity = applyCompanyDefaults({}, 'eoc-ente-ospedaliero-cantonale');
    expect(noCity.streetAddress).toBe('Viale Officina 3');
    expect(noCity.addressLocality).toBe('Bellinzona');
  });

  it('sameLocalityAsHq mirrors the shared TS helper semantics', () => {
    expect(sameLocalityAsHq('', 'Bellinzona')).toBe(true);
    expect(sameLocalityAsHq('Bellinzona, Ticino', 'Bellinzona')).toBe(true);
    expect(sameLocalityAsHq('Winterthur', 'Manno')).toBe(false);
  });
});

describe('hqPostalCodeForLocality — HQ CAP fallback of a crawler (#9841)', () => {
  it('keeps the HQ CAP only at the HQ or where the locality needs it as a Swiss anchor', () => {
    // At the HQ, decorated, or without a city of its own.
    expect(hqPostalCodeForLocality('Dübendorf', 'Dübendorf', '8600')).toBe('8600');
    expect(hqPostalCodeForLocality('Dübendorf-Stettbach', 'Dübendorf', '8600')).toBe('8600');
    expect(hqPostalCodeForLocality('', 'Dübendorf', '8600')).toBe('8600');
    // Another known Swiss city: no HQ CAP, the assembler derives the city's own.
    expect(hqPostalCodeForLocality('Chur', 'Dübendorf', '8600')).toBe('');
    expect(hqPostalCodeForLocality('Uznach', 'St. Gallen', '9007')).toBe('');
    expect(hqPostalCodeForLocality('Olten', 'Zürich', '8005')).toBe('');
    // Ambiguous name: the assembler whitelist needs a Swiss CAP on record.
    expect(hqPostalCodeForLocality('Biel', 'Dübendorf', '8600')).toBe('8600');
    expect(hqPostalCodeForLocality('Wil', 'St. Gallen', '9007')).toBe('9007');
    // No HQ CAP configured: unchanged.
    expect(hqPostalCodeForLocality('Chur', 'Dübendorf', undefined)).toBeUndefined();
  });
});

describe('FNZ country-only national fallback', () => {
  it('keeps the fallback city, postal code, and region aligned', () => {
    const s = buildJobPostingSchema(
      {
        ...baseJob,
        company: 'FNZ (Switzerland) AG',
        companyKey: 'fnz',
        location: 'Switzerland',
        addressLocality: 'Bern',
        addressRegion: 'BE',
        postalCode: '3011',
        streetAddress: 'Bundesplatz 3',
      },
      OPTS,
    );
    expect(s.jobLocation.address).toMatchObject({
      addressLocality: 'Bern',
      addressRegion: 'BE',
      postalCode: '3011',
      streetAddress: 'Bundesplatz 3',
    });
    expect(Object.values(s.jobLocation.address).every(Boolean)).toBe(true);
  });
});

/**
 * Review finding bace4dae1710 (JobBoard.tsx, remote and multi-location
 * postings). JobBoard cannot be mounted in a unit test, so this runs the real
 * source lines of its JSON-LD effect: the address block (from `isValidAddr`
 * to `resolveJobPostingAddress(...)`), the `jobLocationType`/`jobLocation`
 * members of the posting and the remote-only `applicantLocationRequirements`
 * block, cut out of components/community/JobBoard.tsx and transpiled.
 */
function runJobBoardJobLocation(job: Record<string, unknown>, isRemote: boolean, locale = 'fr') {
  const source = readFileSync(new URL('../../components/community/JobBoard.tsx', import.meta.url), 'utf8');
  const addressStart = source.indexOf(' const isValidAddr = (s: string) =>');
  const resolverCall = source.indexOf(' const jobAddress = resolveJobPostingAddress(', addressStart);
  const addressEnd = source.indexOf(' }, locale);\n', resolverCall) + ' }, locale);\n'.length;
  const locationStart = source.indexOf(" jobLocationType: isRemote ? 'TELECOMMUTE' : undefined,", addressEnd);
  const locationEnd = source.indexOf(' directApply:', locationStart);
  const remoteStart = source.indexOf(' if (isRemote) {', locationEnd);
  const remoteEnd = source.indexOf('\n }\n', source.indexOf('posting.applicantLocationRequirements', remoteStart)) + '\n }\n'.length;
  const cuts = [addressStart, resolverCall, addressEnd, locationStart, locationEnd, remoteStart, remoteEnd];
  expect(cuts.every((cut, index) => cut > 0 && (index === 0 || cut > cuts[index - 1])), 'JobBoard JSON-LD address block moved').toBe(true);
  const snippet = [
    source.slice(addressStart, addressEnd),
    'const posting: Record<string, unknown> = {',
    source.slice(locationStart, locationEnd),
    '};',
    source.slice(remoteStart, remoteEnd),
    'return posting;',
  ].join('\n');
  const run = new Function(
    'job', 'isRemote', 'locale', 'DEFAULT_CANTON_DISPLAY', 'DEFAULT_CANTON',
    'resolveJobPostingPostalCode', 'resolveJobPostingAddress',
    transformSync(snippet, { loader: 'ts' }).code,
  );
  return run(job, isRemote, locale, 'Ticino', 'TI', resolveJobPostingPostalCode, resolveJobPostingAddress) as {
    jobLocationType?: string;
    jobLocation: { '@type': string; address: Record<string, string> };
    applicantLocationRequirements?: { '@type': string; name: string };
  };
}

const COUNTRY_LEVEL = /^(?:switzerland|schweiz|suisse|svizzera|ch)$/i;

describe('JobBoard runtime JobPosting — remote and multi-location address (review finding bace4dae1710)', () => {
  it('remote Pully posting: jobLocation.address is never a Switzerland/CH address holding a concrete CAP or street', () => {
    const posting = runJobBoardJobLocation({
      addressLocality: 'Pully',
      location: 'Pully',
      canton: 'VD',
      postalCode: '1009',
      streetAddress: 'Avenue de Lavaux 1',
    }, true);
    const address = posting.jobLocation.address;
    // The acceptance criterion, literally: no Switzerland/CH locality or region.
    expect(COUNTRY_LEVEL.test(address.addressLocality)).toBe(false);
    expect(address.addressRegion).not.toBe('CH');
    expect(JSON.stringify(address)).not.toMatch(/Switzerland/);
    // …so 1009 and the street can only appear inside their own place's tuple.
    expect(address).toEqual({
      '@type': 'PostalAddress',
      addressLocality: 'Pully',
      addressRegion: 'VD',
      addressCountry: 'CH',
      postalCode: '1009',
      streetAddress: 'Avenue de Lavaux 1',
    });
    // Remoteness is carried by the remote-only members, not by the address.
    expect(posting.jobLocationType).toBe('TELECOMMUTE');
    expect(posting.applicantLocationRequirements).toEqual({ '@type': 'Country', name: 'CH' });
  });

  it('multi-location posting: the canton\'s full coherent tuple, locality + CAP + street of the same place', () => {
    const posting = runJobBoardJobLocation({
      addressLocality: 'Lugano · Bellinzona · Mendrisio',
      location: 'Lugano · Bellinzona · Mendrisio',
      canton: 'TI',
    }, false);
    const address = posting.jobLocation.address;
    expect(COUNTRY_LEVEL.test(address.addressLocality)).toBe(false);
    expect(address.addressRegion).not.toBe('CH');
    expect(address).toMatchObject({ ...CANTON_CAPITAL_ADDRESSES.TI, addressCountry: 'CH' });
    expect(posting.jobLocationType).toBeUndefined();
    expect(posting.applicantLocationRequirements).toBeUndefined();
  });

  it('on-site posting keeps the same single-place address (no country-level branch left)', () => {
    const posting = runJobBoardJobLocation({
      addressLocality: 'Pully',
      location: 'Pully',
      canton: 'VD',
    }, false);
    expect(posting.jobLocation.address).toMatchObject({ addressLocality: 'Pully', postalCode: '1009', addressRegion: 'VD' });
    expect(COUNTRY_LEVEL.test(posting.jobLocation.address.addressLocality)).toBe(false);
  });
});
