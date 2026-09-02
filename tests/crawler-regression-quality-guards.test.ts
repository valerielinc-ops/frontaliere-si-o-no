/**
 * Regression tests for the shared crawler quality guards
 * (docs/copilot-crawler-fix-prompts.md).
 *
 * These guards are the single chokepoint that filters thin-content, wrong-
 * company, or boilerplate-only job records across ~30 dedicated crawlers.
 * Breaking any of them would silently let low-quality data into jobs.json —
 * hence the source-level coverage plus unit tests for each predicate.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  titleOverlap,
  checkMinDescription,
  checkCompanyNameSanity,
  runQualityGuards,
  DEFAULT_MIN_DESCRIPTION,
  DEFAULT_MIN_TITLE_OVERLAP,
} from '../scripts/lib/crawler-quality-guards.mjs';
import {
  getCantonDisplayName,
  getCantonForLocation,
  HQ_REGISTRY,
  COMPANY_HQ,
} from '../scripts/lib/crawler-location-config.mjs';
import { readdirSync } from 'node:fs';
import {
  TRUNCATED_ST_LOCALITY_RE,
  recoverTruncatedStLocality,
  healTruncatedStLocalities,
} from '../scripts/lib/dedicated-crawler-common.mjs';
import {
  applyCoopSourceDetailToJob,
  validateCoopDescription,
} from '../scripts/lib/coop-job-parser.mjs';

describe('titleOverlap()', () => {
  it('returns 1 for identical inputs (modulo case/accents/punctuation)', () => {
    expect(titleOverlap('Impiegato Commerciale', 'impiegato commerciale')).toBe(1);
    expect(titleOverlap('Addetto Vendita', 'Addetto vendita!')).toBe(1);
  });

  it('returns 0 for completely different tokens', () => {
    expect(titleOverlap('Cashier Lugano', 'Panettiere Biasca')).toBe(0);
  });

  it('returns a ratio in [0,1] for partial overlap', () => {
    const ov = titleOverlap('Cashier Lugano part-time', 'Cashier full-time Bellinzona');
    expect(ov).toBeGreaterThan(0);
    expect(ov).toBeLessThan(1);
  });

  it('ignores short stopword-length tokens', () => {
    expect(titleOverlap('a b c', 'd e f')).toBe(0);
  });
});

describe('checkMinDescription()', () => {
  it('accepts a description at or above the threshold', () => {
    const job = { description: 'x'.repeat(DEFAULT_MIN_DESCRIPTION) };
    expect(checkMinDescription(job).ok).toBe(true);
  });

  it('rejects a too-short description with a diagnostic reason', () => {
    const res = checkMinDescription({ description: 'too short' });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/too short/i);
  });

  it('honours a custom minimum length', () => {
    expect(checkMinDescription({ description: 'x'.repeat(50) }, 40).ok).toBe(true);
    expect(checkMinDescription({ description: 'x'.repeat(50) }, 80).ok).toBe(false);
  });
});

describe('checkCompanyNameSanity()', () => {
  it('accepts when the actual name matches the expected canonical name', () => {
    expect(checkCompanyNameSanity({ company: 'Coop' }, 'Coop').ok).toBe(true);
  });

  it('accepts case-insensitive and accent-insensitive aliases', () => {
    expect(
      checkCompanyNameSanity({ company: 'Società Cooperativa Coop' }, ['Coop', 'Coop Società']).ok,
    ).toBe(true);
  });

  it('accepts when actual name contains the expected alias as a substring', () => {
    expect(checkCompanyNameSanity({ company: 'Migros Aare SA' }, 'Migros').ok).toBe(true);
  });

  it('rejects when company name is missing', () => {
    expect(checkCompanyNameSanity({ company: '' }, 'Coop').ok).toBe(false);
  });

  it('rejects when company name is a different brand', () => {
    const res = checkCompanyNameSanity({ company: 'Denner SA' }, 'Coop');
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/Denner/i);
  });
});

describe('runQualityGuards()', () => {
  const makeJob = (over: Partial<{ id: string; title: string; company: string; description: string }> = {}) => ({
    id: over.id ?? `job-${Math.random().toString(36).slice(2, 8)}`,
    title: over.title ?? 'Commesso vendita',
    company: over.company ?? 'Coop',
    description: over.description ?? 'd'.repeat(DEFAULT_MIN_DESCRIPTION + 50),
  });

  it('keeps valid jobs and mutates the array in place when rejecting bad ones', () => {
    const jobs = [
      makeJob(),
      makeJob({ id: 'short', description: 'nope' }),
      makeJob({ id: 'wrong-brand', company: 'Lidl' }),
    ];
    const res = runQualityGuards(jobs, {
      companyName: 'Coop',
      minDescription: DEFAULT_MIN_DESCRIPTION,
    });
    expect(res.kept).toBe(1);
    expect(res.rejected).toBe(2);
    expect(res.reasons.min_description).toBe(1);
    expect(res.reasons.company_name).toBe(1);
    expect(jobs).toHaveLength(1);
  });

  it('respects the DEFAULT_MIN_TITLE_OVERLAP constant when provided a ref field', () => {
    expect(DEFAULT_MIN_TITLE_OVERLAP).toBeGreaterThan(0);
    const jobs = [
      // overlap ~1.0 — same tokens in different order → kept
      { ...makeJob({ title: 'Cassiere Lugano part-time' }), jsonLdTitle: 'Part-time Cassiere Lugano' },
      // overlap 0 — no tokens in common → rejected
      { ...makeJob({ title: 'Fioraio' }), jsonLdTitle: 'Ingegnere Software' },
    ];
    const res = runQualityGuards(jobs, {
      expectedTitleRefField: 'jsonLdTitle',
      minTitleOverlap: DEFAULT_MIN_TITLE_OVERLAP,
    });
    expect(res.kept).toBe(1);
    expect(res.rejected).toBe(1);
    expect(res.reasons.title_overlap).toBe(1);
  });

  it('is a no-op on an empty or non-array input', () => {
    expect(runQualityGuards([] as never[]).kept).toBe(0);
    expect(runQualityGuards(null as unknown as never[]).kept).toBe(0);
  });

  it('can be bypassed by providing no guards', () => {
    const jobs = [{ description: 'short', company: 'Anything' }];
    const res = runQualityGuards(jobs, { minDescription: 0 });
    expect(res.kept).toBe(1);
    expect(res.rejected).toBe(0);
  });
});

describe('crawler-location-config — HQ_REGISTRY alias + canton helpers', () => {
  it('HQ_REGISTRY is the same object as COMPANY_HQ (docs/crawler-parametrizzazione-plan.md)', () => {
    expect(HQ_REGISTRY).toBe(COMPANY_HQ);
  });

  it('getCantonForLocation resolves free-text locations to 2-letter codes', () => {
    expect(getCantonForLocation('Lugano, Ticino')).toBe('TI');
    expect(getCantonForLocation('Chur, Graubünden')).toBe('GR');
    expect(getCantonForLocation('Sion, Valais')).toBe('VS');
    expect(getCantonForLocation('')).toBe('');
    expect(getCantonForLocation('Atlantis')).toBe('');
  });

  it('getCantonDisplayName returns locale-appropriate names for canton codes', () => {
    expect(getCantonDisplayName('TI', 'it')).toBe('Ticino');
    expect(getCantonDisplayName('TI', 'de')).toBe('Tessin');
    expect(getCantonDisplayName('GR', 'it')).toBe('Grigioni');
    expect(getCantonDisplayName('GR', 'de')).toBe('Graubünden');
    expect(getCantonDisplayName('VS', 'it')).toBe('Vallese');
    expect(getCantonDisplayName('VS', 'fr')).toBe('Valais');
  });

  it('getCantonDisplayName falls back gracefully on unknown codes', () => {
    expect(getCantonDisplayName('ZZ', 'it')).toBe('ZZ');
  });
});

describe('Crawler wiring — Coop and Migros import the shared guards', () => {
  it.each([
    ['scripts/update-coop-jobs.mjs'],
    ['scripts/update-migros-jobs.mjs'],
  ])('%s imports runQualityGuards from the shared module', (relPath) => {
    const src = readFileSync(resolve(__dirname, '..', relPath), 'utf8');
    expect(src).toMatch(/from '\.\/lib\/crawler-quality-guards\.mjs'/);
    expect(src).toMatch(/runQualityGuards\(/);
  });

  it('Coop crawler keeps its existing title-overlap guard (≥0.6)', () => {
    const src = readFileSync(resolve(__dirname, '..', 'scripts/update-coop-jobs.mjs'), 'utf8');
    expect(src).toMatch(/overlap\s*<\s*0\.6/);
  });

  it('VOLG delegates detail validation to the fail-closed Coop-family helper', () => {
    const src = readFileSync(resolve(__dirname, '..', 'scripts/update-volg-jobs.mjs'), 'utf8');
    expect(src).toContain('enrichCoopSourceBackedJobs');
    expect(src).toContain("allowedHosts: ['jobs.fenaco.com']");
  });

  it('Coop-family detail validation keeps the 15% body-ratio boundary', () => {
    const markdown = `## Aufgaben\n- ${'Source-backed Inhalt mit belastbarer Detailtiefe. '.repeat(12)}`;
    const textLength = markdown.replace(/[#\-*>\n]/g, ' ').replace(/\s+/g, ' ').trim().length;
    const sourceLengthAtBoundary = Math.floor(textLength / 0.15);

    expect(validateCoopDescription(markdown, sourceLengthAtBoundary).ok).toBe(true);
    expect(validateCoopDescription(markdown, sourceLengthAtBoundary + 10).warnings)
      .toContainEqual(expect.stringMatching(/Coverage ratio too low/));
  });

  it('Coop-family detail validation accepts title overlap 0.6 and rejects below it', () => {
    const listing = {
      id: 'volg-stable',
      url: 'https://jobs.fenaco.com/offene-stellen/test/44444444-4444-4444-8444-444444444444',
      title: 'alpha beta gamma delta epsilon',
      description: 'listing fallback',
      location: 'fallback',
      canton: 'TI',
      sourceLang: 'de',
    };
    const detail = {
      '@type': 'JobPosting',
      title: 'alpha beta gamma',
      description: `<h2>Aufgaben</h2><ul>${Array.from({ length: 30 }, (_, index) => `<li>Source-backed Aufgabe ${index + 1} mit Verantwortung und Zusammenarbeit im Team.</li>`).join('')}</ul>`,
      jobLocation: {
        address: {
          addressLocality: 'Höri',
          addressRegion: 'Zürich',
          addressCountry: 'CH',
          postalCode: '8181',
        },
      },
    };

    expect(applyCoopSourceDetailToJob(listing, detail)).toMatchObject({ location: 'Höri', canton: 'ZH' });
    expect(() => applyCoopSourceDetailToJob(listing, { ...detail, title: 'alpha beta' }))
      .toThrow(/title mismatch \(0\.40\)/);
  });
});

// ── Truncated "St" locality guard (issue #1158) ──────────────────────────────
// A bare "St"/"St." is a textContent-truncation artifact of "St. Moritz" /
// "St. Gallen" etc. and must never reach jobLocation.addressLocality in the
// indexed JSON-LD. The normalizer recovers the full city per-record; this suite
// pins both the recovery logic and the corpus invariant (no slice may emit a
// bare token).
describe('Truncated "St" locality guard (issue #1158)', () => {
  it('flags only the bare token, never a real "St. X" city', () => {
    expect(TRUNCATED_ST_LOCALITY_RE.test('St')).toBe(true);
    expect(TRUNCATED_ST_LOCALITY_RE.test('St.')).toBe(true);
    expect(TRUNCATED_ST_LOCALITY_RE.test('st')).toBe(true);
    expect(TRUNCATED_ST_LOCALITY_RE.test('St. Moritz')).toBe(false);
    expect(TRUNCATED_ST_LOCALITY_RE.test('St. Gallen')).toBe(false);
    expect(TRUNCATED_ST_LOCALITY_RE.test('Stein')).toBe(false);
    expect(TRUNCATED_ST_LOCALITY_RE.test('Pontresina')).toBe(false);
  });

  it('recovers via per-crawler HQ override (kronenhof → Pontresina, not St. Moritz)', () => {
    // kronenhof slug carries "kulm-hotel-st-moritz" but the hotel is in Pontresina.
    const job = {
      companyKey: 'grand-hotel-kronenhof',
      addressLocality: 'St',
      addressRegion: 'GR',
      postalCode: '7504',
      slug: 'office-manager-m-w-d-kulm-hotel-st-moritz-st-moritz-675',
    };
    expect(recoverTruncatedStLocality(job)).toBe('Pontresina');
  });

  it('recovers from the URL path even when addressRegion is HQ-stamped wrong', () => {
    const job = {
      companyKey: 'fielmann',
      addressLocality: 'St',
      addressRegion: 'VS', // HQ-stamp, wrong
      url: 'https://fielmann.wd3.myworkdayjobs.com/en/External/job/St-Gallen/Augenoptiker',
      slug: 'augenoptiker-w-m-d-fielmann-group-st',
    };
    expect(recoverTruncatedStLocality(job)).toBe('St. Gallen');
  });

  it('recovers from a whitelisted slug city token (St. Moritz)', () => {
    const job = {
      companyKey: 'badrutts-palace',
      addressLocality: 'St',
      addressRegion: 'GR',
      slug: 'beauty-therapist-m-w-d-badrutts-palace-st-moritz',
    };
    expect(recoverTruncatedStLocality(job)).toBe('St. Moritz');
  });

  it('recovers an org-seat employer via PLZ override (kliniken-valens 7317 → Valens, not St. Gallen)', () => {
    // Jobs sit at PLZ 7317 (Valens), yet slug labels them "…-st-gallen". The
    // untrusted slug seat must NOT win — the postal code pins the real city.
    const job = {
      companyKey: 'kliniken-valens',
      addressLocality: 'St',
      addressRegion: 'SG',
      postalCode: '7317',
      slug: 'pflegefachfrau-mann-kliniken-valens-st-gallen',
    };
    expect(recoverTruncatedStLocality(job)).toBe('Valens');
  });

  it('defers an org-seat employer when the PLZ is not in the override map', () => {
    // A different kliniken-valens site (e.g. Chur PLZ 7000) has no PLZ entry yet,
    // and the slug seat stays untrusted → defer, never guess the wrong city.
    const job = {
      companyKey: 'kliniken-valens',
      addressLocality: 'St',
      addressRegion: 'GR',
      postalCode: '7000',
      slug: 'pflegefachfrau-mann-kliniken-valens-st-gallen',
    };
    expect(recoverTruncatedStLocality(job)).toBeNull();
  });

  it('recovers via PLZ override when slug/url carry no city token (bosch 1950 → St. Niklaus, #1242)', () => {
    const job = {
      companyKey: 'bosch-thermotechnik-ag',
      addressLocality: 'St',
      addressRegion: 'VS',
      postalCode: '1950',
      slug: 'instandhaltung-ref285547a-bosch-thermotechnik-ag-st',
      url: 'https://jobs.bosch.com/en/job/REF285547A-instandhaltung-w-m-div',
    };
    expect(recoverTruncatedStLocality(job)).toBe('St. Niklaus');
  });

  it('heals the canton-capital fallback postalCode to match the recovered locality (bosch 1950 → 3924, #1242)', () => {
    // The crawler stamped the VS canton-capital fallback "1950" (= Sion) because
    // "St. Niklaus" was missing from swiss-postal-codes.json. healing must rewrite
    // the postalCode to St. Niklaus' real value (3924) so the PostalAddress is
    // internally consistent — recovering the locality alone left it as Sion's PLZ.
    const job = {
      companyKey: 'bosch-thermotechnik-ag',
      addressLocality: 'St',
      addressRegion: 'VS',
      postalCode: '1950',
      slug: 'instandhaltung-ref285547a-bosch-thermotechnik-ag-st',
      url: 'https://jobs.bosch.com/en/job/REF285547A-instandhaltung-w-m-div',
    };
    const { healed } = healTruncatedStLocalities([job]);
    expect(healed).toBe(1);
    expect(job.addressLocality).toBe('St. Niklaus');
    expect(job.postalCode).toBe('3924'); // not the misleading 1950 (Sion) fallback
  });

  it('does NOT rewrite a postalCode for a recovered locality whose own PLZ is correct (valens 7317)', () => {
    // ST_LOCALITY_CANONICAL_PLZ is scoped to localities with a wrong fallback PLZ.
    // Valens jobs already carry the correct 7317 → must be left untouched.
    const job = {
      companyKey: 'kliniken-valens',
      addressLocality: 'St',
      addressRegion: 'SG',
      postalCode: '7317',
      slug: 'pflegefachperson-kliniken-valens-st-gallen',
      url: 'https://example.com/job/x',
    };
    const { healed } = healTruncatedStLocalities([job]);
    expect(healed).toBe(1);
    expect(job.addressLocality).toBe('Valens');
    expect(job.postalCode).toBe('7317');
  });

  it('defers when no signal is recoverable (no slug/url city, no override)', () => {
    const job = {
      companyKey: 'some-unknown-employer',
      addressLocality: 'St',
      addressRegion: 'VS',
      postalCode: '1950',
      slug: 'irgendein-job-some-unknown-employer-st',
      url: 'https://example.com/job/REF000000A-irgendein-job',
    };
    expect(recoverTruncatedStLocality(job)).toBeNull();
  });

  it('heals a slice and uses same-site consensus for bare-slug siblings', () => {
    const jobs = [
      // recovered via slug → St. Urban, seeds the (company, plz) consensus
      { companyKey: 'lups', addressLocality: 'St', postalCode: '4915', slug: 'a-100-m-f-d-lups-st-urban' },
      // bare slug, no per-record signal → recovered via same-site consensus
      { companyKey: 'lups', addressLocality: 'St', postalCode: '4915', slug: 'pflegefachperson-lups' },
    ];
    const { healed, deferred } = healTruncatedStLocalities(jobs);
    expect(healed).toBe(2);
    expect(deferred).toBe(0);
    expect(jobs.every((j) => j.addressLocality === 'St. Urban')).toBe(true);
  });

  it('does NOT apply consensus across different postal codes', () => {
    const jobs = [
      { companyKey: 'x', addressLocality: 'St', postalCode: '9000', slug: 'a-x-st-gallen' },
      { companyKey: 'x', addressLocality: 'St', postalCode: '7500', slug: 'b-x' }, // different site, no signal
    ];
    const { deferred } = healTruncatedStLocalities(jobs);
    expect(deferred).toBe(1);
    expect(jobs[1].addressLocality).toBe('St');
  });

  it('CORPUS INVARIANT: no by-crawler slice emits a bare "St"/"St." addressLocality', () => {
    const dir = resolve(__dirname, '..', 'data/jobs/by-crawler');
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      let data: unknown;
      try {
        data = JSON.parse(readFileSync(resolve(dir, file), 'utf8'));
      } catch {
        continue;
      }
      const jobs = Array.isArray(data)
        ? data
        : (data as { jobs?: Array<{ addressLocality?: string }> })?.jobs;
      if (!Array.isArray(jobs)) continue;
      for (const job of jobs) {
        const loc = String((job as { addressLocality?: string }).addressLocality || '').trim();
        if (loc && TRUNCATED_ST_LOCALITY_RE.test(loc)) {
          offenders.push(`${file}: "${loc}"`);
        }
      }
    }
    // pwc is knowingly deferred (no recoverable per-job signal), tracked in the
    // PR's "Non implementato". kliniken-valens was healed by the #1199 rebaseline
    // (PLZ override 7317 → Valens, issue #1180); bosch-thermotechnik-ag was healed
    // by the #1242 PLZ override (1950 → St. Niklaus) — both slices no longer emit a
    // bare "St", so they are held to the invariant like any other crawler.
    const KNOWN_DEFERRED = /^(pwc)\.json:/;
    const unexpected = offenders.filter((o) => !KNOWN_DEFERRED.test(o));
    expect(unexpected).toEqual([]);
  });
});
