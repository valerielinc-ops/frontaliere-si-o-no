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
import { buildJobPostingSchema } from '../../build-plugins/shared/jobPostingSchema';
import {
  localityMatchesHq,
  regionLocalityCapital,
  resolveFallbackAddress,
} from '../../build-plugins/shared/companyHqAddresses';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain ESM helper without type declarations
import { sameLocalityAsHq, applyCompanyDefaults } from '../../scripts/lib/dedicated-crawler-common.mjs';

const OPTS = { locale: 'it', url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/x/' };

const baseJob = {
  title: 'Infermiere/a',
  description: 'Ruolo infermieristico con responsabilità cliniche e collaborazione con il team multidisciplinare della struttura.',
  company: 'EOC',
};

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
