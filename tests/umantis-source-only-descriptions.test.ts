import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  repairStoredUmantisJobs,
  stripUmantisListingLabelLines,
  umantisListingContract,
  UMANTIS_FABRICATED_DESCRIPTION_RE,
} from '../scripts/lib/umantis-listing-common.mjs';
import { fetchAllKlinikSonnenhaldeJobs } from '../scripts/lib/klinik-sonnenhalde-job-parser.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';

// Issue 5253, Umantis factory (11 tenants). The description is the posting's
// own text: the listing columns «Bereich / Art / Befristung» used to be
// appended to it as «• …: …» lines, and a job without text got a description
// the crawler wrote («<Titel> bei <Firma> in <Ort> (<PLZ>, <Kanton>),
// Schweiz.» + «• Standort» + «• Bewerbung über das Umantis-Karriereportal»).
// Real Klinik Sonnenhalde pages (tenant 3030), minimised, contacts anonymised:
// the listing's first page cut to three rows, two detail pages.
const fixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', 'umantis-sonnenhalde', name), 'utf8');
const LISTING = fixture('listing-3030.html');
const DETAILS: Record<string, string> = {
  416: fixture('detail-416.html'),
  406: fixture('detail-406.html'),
};
const LABEL_LINE_RE = /^• (?:Bereich|Art|Befristung|Standort): /m;

function stubTenant() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/Jobs/All')) return new Response(LISTING, { status: 200 });
    const id = String(url).match(/\/Vacancies\/(\d+)\/Description\//)?.[1] || '';
    // 399 («Lehrstelle Koch/Köchin EFZ»): the detail cannot be read, and the
    // listing teaser is 13 words — under the 50-word floor.
    if (DETAILS[id]) return new Response(DETAILS[id], { status: 200 });
    return new Response('not found', { status: 404 });
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Umantis factory — description is only the posting text', () => {
  it('publishes the detail text without the listing-column lines', async () => {
    stubTenant();
    const jobs = await fetchAllKlinikSonnenhaldeJobs();
    expect(jobs.map((j: any) => j.url.match(/Vacancies\/(\d+)/)[1])).toEqual(['416', '406', '399']);
    const [billing, nurse] = jobs;
    expect(billing.description).toContain('Ihr Aufgabenbereich\n\n• Fakturierung & Datenpflege: Sie erfassen medizinische Leistungen');
    expect(billing.description).toMatch(/Wir freuen uns, Sie kennenzulernen!$/);
    expect(nurse.description).toMatch(/Wir freuen uns, Sie kennenzulernen!$/);
    for (const job of [billing, nurse]) {
      expect(job.description).not.toMatch(LABEL_LINE_RE);
      expect(job.descriptionByLocale).toEqual({ de: job.description });
      expect(job.sourceLang).toBe('de');
    }
  });

  it('carries the listing columns in the structured fields', async () => {
    stubTenant();
    const [billing, nurse, cook] = await fetchAllKlinikSonnenhaldeJobs();
    // «Vollzeit oder Teilzeit möglich» / «Unbefristet»
    expect(billing.department).toBe('Querschnittsdienste Finanzen, Prozesse und Services');
    expect(billing.employmentType).toBe('PART_TIME');
    expect(billing.contract).toBe('part-time');
    // «Vollzeit» / «Unbefristet»: permanent, no longer «temporary»
    expect(nurse.department).toBe('Pflege, Therapie, SPD');
    expect(nurse.contract).toBe('full-time');
    // «Vollzeit» / «Befristet»
    expect(cook.contract).toBe('temporary');
  });

  it('gives a job without source text no description, and keeps its slug', async () => {
    stubTenant();
    const jobs = await fetchAllKlinikSonnenhaldeJobs();
    const cook = jobs[2];
    expect(cook.title).toBe('Lehrstelle Koch/Köchin EFZ');
    expect(cook.description).toBe('');
    expect(cook.descriptionByLocale).toEqual({ de: '' });
    expect(cook.sourceLang).toBe('de');
    // Slugs are the ones the tenant already publishes.
    expect(jobs.map((j: any) => j.slug)).toEqual([
      'mitarbeiter-in-patientenabrechnung-klinik-sonnenhalde-riehen',
      'pflegefachperson-hf-fh-tk-hybrid-klinik-sonnenhalde-riehen',
      'lehrstelle-koch-kochin-efz-klinik-sonnenhalde-riehen',
    ]);
    for (const job of jobs) expect(job.description).not.toMatch(UMANTIS_FABRICATED_DESCRIPTION_RE);
  });

  it('maps «Befristung» without reading «Unbefristet» as fixed-term', () => {
    expect(umantisListingContract('Unbefristet', 'FULL_TIME')).toBe('full-time');
    expect(umantisListingContract('unbefristet', 'OTHER')).toBe('full-time');
    expect(umantisListingContract('Befristet', 'FULL_TIME')).toBe('temporary');
    expect(umantisListingContract('Befristet', 'PART_TIME')).toBe('part-time');
    expect(umantisListingContract('', '')).toBe('full-time');
  });
});

// Stored jobs as they are on main (klinik-sonnenhalde and upd slices).
const BODY = 'Ihr Aufgabenbereich\n• Fakturierung & Datenpflege: Sie erfassen medizinische Leistungen\n\nHaben wir Ihr Interesse geweckt? Dann bewerben Sie sich jetzt!';
function labelledJob() {
  const de = `${BODY}\n\n• Bereich: Ärztliche- Psychologischer Dienst\n• Art: Teilzeit\n• Befristung: Unbefristet`;
  return {
    url: 'https://recruitingapp-3030.umantis.com/Vacancies/416/Description/1',
    slug: 'mitarbeiter-in-patientenabrechnung-klinik-sonnenhalde-riehen',
    title: 'Mitarbeiter:in Patientenabrechnung',
    sourceLang: 'de',
    description: de,
    descriptionByLocale: {
      de,
      it: 'Le sue mansioni\n• Fatturazione\n\n• Area: Servizio medico e psicologico\n• Tipo: part-time\n• Termine temporaneo: perpetuo',
      en: 'Your tasks\n• Invoicing\n\n• Area: Medical and Psychological Service\n• Type: part-time\n• Temporary term: perpetual',
    },
    titleByLocale: { de: 'Mitarbeiter:in Patientenabrechnung', it: 'Collaboratore/trice fatturazione pazienti' },
  };
}
function fabricatedJob() {
  const de = 'Sozialarbeiter*in (m/w/d) als Mutterschaftsvertretung bei Universitäres Psychiatrisches Zentrum Bern AG in Bern (3000, BE), Schweiz.\n\n• Bereich: Sozialdienst\n• Art: Teilzeit\n• Befristung: Befristet\n• Standort: Bern (BE)\n• Bewerbung über das Umantis-Karriereportal von Universitäre Psychiatrische Dienste Bern (UPD)';
  return {
    url: 'https://recruitingapp-2987.umantis.com/Vacancies/1/Description/1',
    slug: 'sozialarbeiter-in-upd-bern',
    title: 'Sozialarbeiter*in (m/w/d) als Mutterschaftsvertretung',
    sourceLang: 'de',
    description: de,
    descriptionByLocale: {
      de,
      en: 'Social worker … in Bern (3000, BE), Switzerland.\n\n• Application via the Umantis Career Portal of UPD',
    },
  };
}

describe('repairStoredUmantisJobs — prepareExistingJobs of the factory runners', () => {
  it('strips the listing-column lines, keeps the posting text, drops the translations made from it', () => {
    const job: any = labelledJob();
    expect(stripUmantisListingLabelLines(job)).toBe(true);
    expect(job.descriptionByLocale).toEqual({ de: BODY });
    expect(job.description).toBe(BODY);
    expect(job.needsRetranslation).toBe(true);
    // Titles are the source's: they stay.
    expect(job.titleByLocale.it).toBe('Collaboratore/trice fatturazione pazienti');
  });

  it('drops the whole description the factory wrote for a job without text', () => {
    const [labelled, fabricated, clean]: any[] = repairStoredUmantisJobs(
      [labelledJob(), fabricatedJob(), { sourceLang: 'de', description: BODY, descriptionByLocale: { de: BODY, it: 'Le sue mansioni' } }],
      'Test',
    );
    expect(labelled.descriptionByLocale).toEqual({ de: BODY });
    expect(fabricated.descriptionByLocale).toEqual({});
    expect(fabricated.description).toBe('');
    expect(fabricated.needsRetranslation).toBe(true);
    expect(clean.descriptionByLocale).toEqual({ de: BODY, it: 'Le sue mansioni' });
    expect(clean.needsRetranslation).toBeUndefined();
  });

  it('with the real merge: a run without text keeps the stored posting text, never the crawler text', () => {
    const freshWithoutText = (stored: any) => ({
      url: stored.url,
      slug: stored.slug,
      title: stored.title,
      sourceLang: 'de',
      description: '',
      descriptionByLocale: { de: '' },
      titleByLocale: { de: stored.title },
      slugByLocale: { de: stored.slug },
    });
    const stored = repairStoredUmantisJobs([labelledJob(), fabricatedJob()], 'Test');
    const merged: any[] = mergePreserveLocaleData(stored, stored.map(freshWithoutText));
    const byUrl = new Map(merged.map((job) => [job.url, job]));
    // The posting text an earlier run read stays, without the lines.
    expect(byUrl.get(labelledJob().url).descriptionByLocale).toEqual({ de: BODY });
    // Nothing stored from the source: no description (thin-source path).
    expect(byUrl.get(fabricatedJob().url).descriptionByLocale.de).toBeUndefined();

    // Without the repair the merge would keep both texts.
    const unrepaired: any[] = mergePreserveLocaleData([labelledJob(), fabricatedJob()], [labelledJob(), fabricatedJob()].map(freshWithoutText));
    expect(unrepaired.every((job) => LABEL_LINE_RE.test(job.descriptionByLocale.de))).toBe(true);
  });
});

// Kanton St. Gallen (own parser on the shared listing reader, tenant 2800):
// same class — «• Pensum / • Standort / • Bewerbung über das offizielle
// Stellenportal des Kantons St. Gallen (…)» appended to the posting, and an
// intro + canton paragraph when the detail had no text. Real listing rows and
// detail page, minimised; the commented-out contact template anonymised.
describe('Kanton St. Gallen — description is only the posting text', () => {
  const sgFixture = (name: string) => readFileSync(resolve(__dirname, 'fixtures', 'kanton-st-gallen', name), 'utf8');
  const SG_LISTING = sgFixture('listing-2800.html');
  const SG_DETAIL = sgFixture('detail-6519.html');
  const SG_LABEL_RE = /^• (?:Pensum|Standort|Bewerbung über das offizielle Stellenportal)/m;

  function stubCanton() {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).includes('/Jobs/All')) return new Response(SG_LISTING, { status: 200 });
      // 6534: the detail cannot be read this run.
      if (String(url).includes('/Vacancies/6519/Description/')) return new Response(SG_DETAIL, { status: 200 });
      return new Response('not found', { status: 404 });
    }));
  }

  it('publishes the detail text and carries Pensum/Befristung/Bereich in structured fields', async () => {
    stubCanton();
    const { fetchAllKantonStGallenJobs } = await import('../scripts/lib/kanton-st-gallen-job-parser.mjs');
    const jobs = await fetchAllKantonStGallenJobs();
    const byId = new Map(jobs.map((job: any) => [job.url.match(/Vacancies\/(\d+)/)[1], job]));
    const secretary: any = byId.get('6519');
    expect(secretary.description.startsWith('Die Akademie St. Gallen ist die Weiterbildungsabteilung des KBZ St. Gallen.')).toBe(true);
    expect(secretary.description).toContain('Was wir bieten:\n\n• ein motiviertes und offenes Team');
    expect(secretary.description).not.toMatch(SG_LABEL_RE);
    expect(secretary.workload).toBe('50 - 60 %');
    expect(secretary.employmentType).toBe('PART_TIME');
    expect(secretary.contract).toBe('part-time');
    expect(secretary.department).toBe('Bildungsdepartement');
    expect(secretary.location).toBe('St. Gallen');
    expect(secretary.slug).toBe('mitarbeiter-in-im-sekretariat-m-w-d-kanton-st-gallen-ch');
  });

  it('gives a posting without detail text no description instead of the canton paragraph', async () => {
    stubCanton();
    const { fetchAllKantonStGallenJobs, KANTON_ST_GALLEN_FABRICATED_DESCRIPTION_RE } = await import('../scripts/lib/kanton-st-gallen-job-parser.mjs');
    const jobs = await fetchAllKantonStGallenJobs();
    const intern: any = jobs.find((job: any) => job.url.includes('/Vacancies/6534/'));
    expect(intern.description).toBe('');
    expect(intern.descriptionByLocale).toEqual({ de: '' });
    expect(intern.description).not.toMatch(KANTON_ST_GALLEN_FABRICATED_DESCRIPTION_RE);
    // «Befristet» on the listing.
    expect(intern.contract).toBe('temporary');
    expect(intern.slug).toBe('praktikant-in-kreisgericht-toggenburg-m-w-d-kanton-st-gallen-ch');
  });

  it('strips the appended lines from a stored job (main slice shape)', async () => {
    const { KANTON_ST_GALLEN_LABEL_LINES_RE, KANTON_ST_GALLEN_FABRICATED_DESCRIPTION_RE } = await import('../scripts/lib/kanton-st-gallen-job-parser.mjs');
    const body = 'Das Kreisforstamt sucht eine/n Vorarbeiter/in.\n\nIhre Aufgaben:\n• Holzernte';
    const de = `${body}\n\n• Pensum: 80-100%\n• Standort: Oberuzwil\n• Bewerbung über das offizielle Stellenportal des Kantons St. Gallen (https://www.sg.ch/ueber-den-kanton-st-gallen/arbeitgeber-kanton-stgallen/stellenportal.html)`;
    const [job]: any[] = repairStoredUmantisJobs([{
      sourceLang: 'de',
      description: de,
      descriptionByLocale: { de, en: 'The forestry office … - Pensum: 80-100% - Location: Oberuzwil - Application via the official job portal' },
    }], 'Kanton St. Gallen', {
      fabricatedRe: KANTON_ST_GALLEN_FABRICATED_DESCRIPTION_RE,
      labelLinesRe: KANTON_ST_GALLEN_LABEL_LINES_RE,
    });
    expect(job.descriptionByLocale).toEqual({ de: body });
    expect(job.description).toBe(body);
    expect(job.needsRetranslation).toBe(true);
  });
});
