/**
 * Tests for the Otis SA (Workday) crawler parser.
 *
 * Tests parseOtisWorkdayListings(), parseOtisWorkdayDetail(),
 * isSwissLocation(), and utility functions using mock Workday API responses
 * matching the real API response format.
 */
import { describe, it, expect } from 'vitest';
import {
  parseOtisWorkdayListings,
  parseOtisWorkdayDetail,
  parseOtisSiteAddress,
  isSwissLocation,
  parseWorkdayCity,
  buildPublicUrl,
  inferEmploymentType,
  slugify,
  normalizeSpace,
  stripHtml,
} from '@/scripts/lib/otis-job-parser.mjs';
import { dropIdenticalPostings } from '@/scripts/lib/identical-posting-dedupe.mjs';

// ─── Mock Workday API listing response (matches real API format) ──────────────

const MOCK_LISTINGS = {
  total: 26,
  jobPostings: [
    {
      title: 'Aufzugsmonteur (m/w/d)',
      externalPath: '/job/Walenbchelstrasse-3-9000-St-Gallen-Switzerland/Aufzugsmonteur--m-w-d-_20152293',
      locationsText: 'Walenbüchelstrasse 3, 9000 St-Gallen, Switzerland',
      postedOn: 'Posted 30+ Days Ago',
      remoteType: 'On-Site',
      bulletFields: ['Walenbüchelstrasse 3, 9000 St-Gallen, Switzerland', '20152293'],
    },
    {
      title: 'Service Techniker Aufzüge (m/w/d)',
      externalPath: '/job/Zurich-Switzerland/Service-Techniker-Aufzuge--m-w-d-_20158801',
      locationsText: 'Zurich, Switzerland',
      postedOn: 'Posted 14 Days Ago',
      remoteType: 'On-Site',
      bulletFields: ['Zurich, Switzerland', '20158801'],
    },
    {
      title: 'Sales Manager DACH',
      externalPath: '/job/Berlin-Germany/Sales-Manager-DACH_20160001',
      locationsText: 'Berlin, Germany',
      postedOn: 'Posted 7 Days Ago',
      remoteType: 'On-Site',
      bulletFields: ['Berlin, Germany', '20160001'],
    },
    {
      title: 'Responsable Technique',
      externalPath: '/job/Paris-France/Responsable-Technique_20160002',
      locationsText: 'Paris, France',
      postedOn: 'Posted 3 Days Ago',
      remoteType: 'On-Site',
      bulletFields: ['Paris, France', '20160002'],
    },
    {
      title: 'Teilzeit Servicemonteur (m/w/d) 60%',
      externalPath: '/job/Bern-Switzerland/Teilzeit-Servicemonteur--m-w-d-_20159900',
      locationsText: 'Bern, Switzerland',
      postedOn: 'Posted 5 Days Ago',
      remoteType: 'On-Site',
      bulletFields: ['Bern, Switzerland', '20159900'],
    },
  ],
};

// ─── Mock Workday job detail (matches real API response format) ───────────────

const MOCK_DETAIL = {
  jobPostingInfo: {
    id: 'ba36e00ac18c10019e3cbf648a740000',
    title: 'Aufzugsmonteur (m/w/d)',
    jobDescription: '<p>Otis AG sucht einen erfahrenen Aufzugsmonteur für die Installation und Wartung von Aufzugsanlagen in der Region St-Gallen.</p><ul><li>Installation neuer Aufzugsanlagen</li><li>Wartung und Reparatur bestehender Systeme</li><li>Kundenbetreuung vor Ort</li></ul><p>Wir bieten ein dynamisches Arbeitsumfeld und kontinuierliche Weiterbildung.</p>',
    location: 'Walenbüchelstrasse 3, 9000 St-Gallen, Switzerland',
    postedOn: 'Posted 30+ Days Ago',
    startDate: '2026-02-05',
    timeType: 'Full time',
    jobReqId: '20152293',
    country: { descriptor: 'Switzerland', id: 'bc33aa3152ec42d4995f4791a106ed09' },
    remoteType: 'On-Site',
    externalUrl: 'https://otis.wd504.myworkdayjobs.com/REC_Ext_Gateway/job/Walenbchelstrasse-3-9000-St-Gallen-Switzerland/Aufzugsmonteur--m-w-d-_20152293',
  },
};

// ─── parseOtisWorkdayListings tests ───────────────────────────────────────────

describe('parseOtisWorkdayListings — Swiss filtering', () => {
  it('filters only Swiss listings (Switzerland in location)', () => {
    const results = parseOtisWorkdayListings(MOCK_LISTINGS);
    expect(results).toHaveLength(3); // St-Gallen + Zurich + Bern (all have "Switzerland")
  });

  it('excludes Berlin and Paris listings', () => {
    const results = parseOtisWorkdayListings(MOCK_LISTINGS);
    const locations = results.map((r) => r.location);
    expect(locations.every((l) => !l.includes('Berlin') && !l.includes('Paris'))).toBe(true);
  });

  it('extracts correct titles', () => {
    const results = parseOtisWorkdayListings(MOCK_LISTINGS);
    const titles = results.map((r) => r.title);
    expect(titles).toContain('Aufzugsmonteur (m/w/d)');
    expect(titles).toContain('Service Techniker Aufzüge (m/w/d)');
    expect(titles).toContain('Teilzeit Servicemonteur (m/w/d) 60%');
  });

  it('extracts city from real locationsText format', () => {
    const results = parseOtisWorkdayListings(MOCK_LISTINGS);
    const stGallenJob = results.find((r) => r.title === 'Aufzugsmonteur (m/w/d)');
    expect(stGallenJob?.city).toBe('St-Gallen');
  });

  it('extracts city from "City, Country" format', () => {
    const results = parseOtisWorkdayListings(MOCK_LISTINGS);
    const zurichJob = results.find((r) => r.title.includes('Service Techniker'));
    expect(zurichJob?.city).toBe('Zurich');
  });

  it('extracts jobId from bulletFields', () => {
    const results = parseOtisWorkdayListings(MOCK_LISTINGS);
    expect(results[0].jobId).toBe('20152293');
    expect(results[1].jobId).toBe('20158801');
  });

  it('deduplicates by externalPath', () => {
    const duped = {
      jobPostings: [
        ...MOCK_LISTINGS.jobPostings,
        MOCK_LISTINGS.jobPostings[0], // duplicate
      ],
    };
    const results = parseOtisWorkdayListings(duped);
    expect(results).toHaveLength(3);
  });

  it('returns empty for null/undefined', () => {
    expect(parseOtisWorkdayListings(null as any)).toHaveLength(0);
    expect(parseOtisWorkdayListings(undefined as any)).toHaveLength(0);
  });

  it('returns empty for empty postings', () => {
    expect(parseOtisWorkdayListings({ jobPostings: [] })).toHaveLength(0);
  });
});

// ─── parseOtisWorkdayDetail tests ─────────────────────────────────────────────

describe('parseOtisWorkdayDetail', () => {
  it('extracts title', () => {
    const result = parseOtisWorkdayDetail(MOCK_DETAIL, '/job/test');
    expect(result).not.toBeNull();
    expect(result!.title).toBe('Aufzugsmonteur (m/w/d)');
  });

  it('extracts description without HTML', () => {
    const result = parseOtisWorkdayDetail(MOCK_DETAIL, '/job/test');
    expect(result!.description).not.toMatch(/<[a-z]/i);
    expect(result!.description).toContain('Aufzugsmonteur');
    expect(result!.description).toContain('Aufzugsanlagen');
  });

  it('builds correct public URL', () => {
    const path = '/job/Walenbchelstrasse-3-9000-St-Gallen-Switzerland/Aufzugsmonteur--m-w-d-_20152293';
    const result = parseOtisWorkdayDetail(MOCK_DETAIL, path);
    expect(result!.url).toContain('otis.wd504.myworkdayjobs.com');
    expect(result!.url).toContain('/Aufzugsmonteur--m-w-d-_20152293');
  });

  it('extracts datePosted from startDate', () => {
    const result = parseOtisWorkdayDetail(MOCK_DETAIL, '/job/test');
    expect(result!.datePosted).toBe('2026-02-05');
  });

  it('detects FULL_TIME from Workday timeType', () => {
    const result = parseOtisWorkdayDetail(MOCK_DETAIL, '/job/test');
    expect(result!.employmentType).toBe('FULL_TIME');
  });

  it('detects PART_TIME from Workday timeType', () => {
    const partTimeDetail = {
      jobPostingInfo: {
        ...MOCK_DETAIL.jobPostingInfo,
        timeType: 'Part time',
      },
    };
    const result = parseOtisWorkdayDetail(partTimeDetail, '/job/test');
    expect(result!.employmentType).toBe('PART_TIME');
  });

  it('extracts jobReqId', () => {
    const result = parseOtisWorkdayDetail(MOCK_DETAIL, '/job/test');
    expect(result!.jobReqId).toBe('20152293');
  });

  it('returns null for null input', () => {
    expect(parseOtisWorkdayDetail(null, '/job/test')).toBeNull();
  });

  it('returns null for empty title', () => {
    const noTitle = { jobPostingInfo: { title: '', jobDescription: 'text' } };
    expect(parseOtisWorkdayDetail(noTitle, '/job/test')).toBeNull();
  });
});

// ─── isSwissLocation tests ────────────────────────────────────────────────────

describe('isSwissLocation', () => {
  it('returns true for real locationsText with Switzerland', () => {
    expect(isSwissLocation('Walenbüchelstrasse 3, 9000 St-Gallen, Switzerland')).toBe(true);
  });
  it('returns true for City, Switzerland', () => { expect(isSwissLocation('Zurich, Switzerland')).toBe(true); });
  it('returns true for Lugano', () => { expect(isSwissLocation('Lugano, TI')).toBe(true); });
  it('returns true for Switzerland', () => { expect(isSwissLocation('Switzerland')).toBe(true); });
  it('returns false for Berlin, Germany', () => { expect(isSwissLocation('Berlin, Germany')).toBe(false); });
  it('returns false for Paris, France', () => { expect(isSwissLocation('Paris, France')).toBe(false); });
});

// ─── Utility function tests ───────────────────────────────────────────────────

describe('parseWorkdayCity', () => {
  it('extracts city from "Street, PostalCode City, Country"', () => {
    expect(parseWorkdayCity('Walenbüchelstrasse 3, 9000 St-Gallen, Switzerland')).toBe('St-Gallen');
  });
  it('extracts city from "City, Country"', () => { expect(parseWorkdayCity('Zurich, Switzerland')).toBe('Zurich'); });
  it('extracts city from "CHE - Lugano"', () => { expect(parseWorkdayCity('CHE - Lugano')).toBe('Lugano'); });
  it('preserves hyphenated uppercase cities and strips administrative suffixes', () => {
    expect(parseWorkdayCity('ST-MAURICE')).toBe('ST-MAURICE');
    expect(parseWorkdayCity('Sion-VS')).toBe('Sion');
    expect(parseWorkdayCity('Visp-Switzerland')).toBe('Visp');
  });
  it('handles plain "Switzerland"', () => { expect(parseWorkdayCity('Switzerland')).toBe('Switzerland'); });
  it('handles "Lugano, Switzerland"', () => { expect(parseWorkdayCity('Lugano, Switzerland')).toBe('Lugano'); });
  it('skips Postfach and extracts real city from "Street, Postfach, City / Canton"', () => {
    expect(parseWorkdayCity('Bahnhofstrasse 3, Postfach 371, Dietlikon / ZH')).toBe('Dietlikon');
  });
  it('skips Postfach in "Street, Postfach, Country" format', () => {
    const city = parseWorkdayCity('Bahnhofstrasse 3, Postfach 371, Switzerland');
    expect(city).not.toContain('Postfach');
  });
});

describe('buildPublicUrl', () => {
  it('builds correct URL', () => {
    expect(buildPublicUrl('/job/Walenbchelstrasse-3-9000-St-Gallen-Switzerland/Aufzugsmonteur--m-w-d-_20152293')).toBe(
      'https://otis.wd504.myworkdayjobs.com/en-US/REC_Ext_Gateway/job/Walenbchelstrasse-3-9000-St-Gallen-Switzerland/Aufzugsmonteur--m-w-d-_20152293'
    );
  });
});

describe('Otis — slugify', () => {
  it('generates correct slug', () => {
    expect(slugify('Aufzugsmonteur (m/w/d)')).toBe('aufzugsmonteur-m-w-d');
  });

  it('handles accented characters', () => {
    expect(slugify('Técnico de Campo Zürich')).toBe('tecnico-de-campo-zurich');
  });

  it('truncates long slugs to 180 chars', () => {
    const long = 'a'.repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(180);
  });
});

describe('Otis — stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>')).not.toMatch(/<[a-z]/i);
  });

  it('decodes HTML entities', () => {
    expect(stripHtml('AT&amp;T')).toContain('AT&T');
  });

  it('returns empty string for empty input', () => {
    expect(stripHtml('')).toBe('');
  });
});

describe('Otis — inferEmploymentType', () => {
  it('detects FULL_TIME from Workday "Full time"', () => {
    expect(inferEmploymentType('', '', 'Full time')).toBe('FULL_TIME');
  });

  it('detects PART_TIME from Workday "Part time"', () => {
    expect(inferEmploymentType('', '', 'Part time')).toBe('PART_TIME');
  });

  it('detects PART_TIME from 60% in title', () => {
    expect(inferEmploymentType('Technician 60%')).toBe('PART_TIME');
  });

  it('defaults to FULL_TIME when no signals', () => {
    expect(inferEmploymentType('Aufzugsmonteur')).toBe('FULL_TIME');
  });

  it('detects PART_TIME from Teilzeit', () => {
    expect(inferEmploymentType('Teilzeit Servicemonteur')).toBe('PART_TIME');
  });
});

// Minimised from the CXS payload of otis.wd504.myworkdayjobs.com
// …/Sales-Manager-Aussendienst--m-w-d-_20169211 (2026-09-29): the template
// leaves the metadata values outside any element, so value and next label
// used to merge ("2026-09-16Country:") in every published locale.
describe('stripHtml — Otis metadata header', () => {
  it('puts each label and value on its own line', () => {
    const html = '<p style="text-align:left"><b>Date Posted:</b></p>2026-09-16<p style="text-align:left"><b>Country: </b></p>Switzerland'
      + '<p style="text-align:left"><b>Location: </b></p>Bahnhofstrasse 3, Postfach 371, Dietlikon / ZH<p><b>Deine Rolle</b></p><p>Als Account Manager übernimmst Du die Verantwortung.</p>';
    const text = stripHtml(html);
    expect(text).toMatch(/^2026-09-16$/m);
    expect(text).toMatch(/^Switzerland$/m);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}Country|SwitzerlandLocation/);
    expect(text).toMatch(/^Deine Rolle$/m);
  });
});

// The ad prints its branch address in the header ("Location:"), 2026-09-29.
// It is the workplace the dedupe key needs; a part the ad does not print
// stays empty (the Dietlikon line has no postal code).
describe('parseOtisSiteAddress', () => {
  const header = (line: string) => `Date Posted:\n2026-09-16\nCountry: \nSwitzerland\nLocation: \n${line}\nDeine Rolle\n\nDu bist verantwortlich …`;

  it('reads street, postal code and town, skipping post-office boxes', () => {
    expect(parseOtisSiteAddress(header('Nenzlingerweg 2, 4153 Reinach'))).toEqual({ streetAddress: 'Nenzlingerweg 2', postalCode: '4153', locality: 'Reinach' });
    expect(parseOtisSiteAddress(header('Route de Moncor 12, CP 1136, 1701 Fribourg'))).toEqual({ streetAddress: 'Route de Moncor 12', postalCode: '1701', locality: 'Fribourg' });
    expect(parseOtisSiteAddress(header('Chemin des Mésanges 5, 1032, Romanel-sur-Lausanne'))).toEqual({ streetAddress: 'Chemin des Mésanges 5', postalCode: '1032', locality: 'Romanel-sur-Lausanne' });
  });

  it('leaves the postal code empty when the ad prints none, and returns null without a Location line', () => {
    expect(parseOtisSiteAddress(header('Bahnhofstrasse 3, Postfach 371, Dietlikon / ZH'))).toEqual({ streetAddress: 'Bahnhofstrasse 3', postalCode: '', locality: 'Dietlikon' });
    expect(parseOtisSiteAddress('Deine Rolle\n\nDu bist verantwortlich …')).toBeNull();
  });

  it('is part of the parsed detail', () => {
    const detail = parseOtisWorkdayDetail({
      jobPostingInfo: { title: 'Servicetechniker:in (m/w/d)', location: 'Reinach', jobDescription: `<p>${header('Nenzlingerweg 2, 4153 Reinach').replace(/\n/g, '<br>')}</p>`, jobReqId: '20169334' },
    }, '/job/Reinach/Servicetechniker-in--m-w-d-_20169334');
    expect(detail?.siteAddress).toEqual({ streetAddress: 'Nenzlingerweg 2', postalCode: '4153', locality: 'Reinach' });
  });

  it('groups two reqs with the same ad only when the branch address is complete', () => {
    const body = `${header('Nenzlingerweg 2, 4153 Reinach')}\n\nWartung und Reparatur von Aufzügen in der Region Basel.`;
    const job = (id: string, address: Record<string, string>) => ({
      title: 'Servicetechniker:in (m/w/d)', sourceLang: 'de', description: body, descriptionByLocale: { de: body },
      location: 'Reinach', addressLocality: 'Reinach', url: `https://otis.wd5.myworkdayjobs.com/en-US/REC_Ext_Gateway/job/Reinach/Servicetechniker-in--m-w-d-_${id}`, ...address,
    });
    const site = { postalCode: '4153', streetAddress: 'Nenzlingerweg 2' };
    expect(dropIdenticalPostings([job('20169334', site), job('20169288', site)]).jobs).toHaveLength(1);
    // Dietlikon: street printed, postal code not: never grouped.
    expect(dropIdenticalPostings([job('20169211', {}), job('20169212-1', {})]).jobs).toHaveLength(2);
  });
});
