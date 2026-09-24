import { describe, it, expect } from 'vitest';
import {
  ECAM_CAREER_URL,
  ECAM_CANTON,
  ECAM_CITY,
  ECAM_COMPANY_NAME,
  ECAM_KEY,
  buildEcamJob,
  extractEcamPostedDate,
  extractEcamTitle,
  extractEcamValidThrough,
  fetchAllEcamJobs,
  isEcamJob,
  isTrustedDomain,
  parseEcamListingPage,
} from '../scripts/lib/ecam-job-parser.mjs';

const LISTING_HTML = `
  <html>
    <head><title>Opportunità d'impiego | ECAM</title></head>
    <body>
      <h1>Opportunità d'impiego</h1>
      <a href="/wp-content/uploads/2026/08/2026.03.08_Concorso-RU-ECAM-80-100_-002_def.pdf">
        Responsabile servizio risorse umane
      </a>
      <a href="/wp-content/uploads/2026/03/MODRU01_Questionario-sullo-stato-di-salute.pdf">
        Questionario sullo stato di salute
      </a>
      <a href="/wp-content/uploads/2026/01/Concorso-generale-sito-ECAM-2026.pdf">
        Concorso generale permanente
      </a>
      <a href="https://example.com/foreign-concorso.pdf">Foreign PDF</a>
    </body>
  </html>
`;

const HR_PDF_TEXT = `
AVVISO DI CONCORSO PER L'ASSUNZIONE DI PERSONALE
un/a Responsabile servizio risorse umane al 80%-100%
Compiti:
collaborare con il Consiglio e la Direzione per la definizione degli obiettivi del servizio;
fornire consulenza e supporto nell'ambito delle risorse umane.
Requisiti:
comprovata esperienza pluriennale in analoga posizione;
conoscenza del diritto del lavoro e delle assicurazioni sociali.
Grado di occupazione
80%-100% Orario flessibile.
Inoltro candidature entro venerdì 18 settembre 2026 alle ore 16:00.
Mendrisio, 07 agosto 2026
`;

const GENERAL_PDF_TEXT = `
CONCORSO GENERALE PERMANENTE ANNO 2026
L'Ente Case Anziani Mendrisiotto rende noto che è aperto il concorso generale per l'assunzione
del seguente personale: personale di cura e terapeutico, personale servizio cucina e servizio
economia domestica, personale servizio tecnico e personale amministrativo.
Le posizioni sono aperte sia a candidature maschili che femminili.
La pubblicazione del concorso vale per tutto l'anno 2026.
Mendrisio, gennaio 2026
`;

const HR_PDF_URL =
  'https://www.ecam.swiss/wp-content/uploads/2026/08/2026.03.08_Concorso-RU-ECAM-80-100_-002_def.pdf';
const GENERAL_PDF_URL =
  'https://www.ecam.swiss/wp-content/uploads/2026/01/Concorso-generale-sito-ECAM-2026.pdf';

describe('ECAM crawler parser', () => {
  it('exports the canonical company identity and career URL', () => {
    expect(ECAM_KEY).toBe('ecam');
    expect(ECAM_COMPANY_NAME).toBe('Ente Case Anziani Mendrisiotto (ECAM)');
    expect(ECAM_CAREER_URL).toBe('https://www.ecam.swiss/lavora-con-noi/opportunita-dimpiego/');
    expect(ECAM_CITY).toBe('Mendrisio');
    expect(ECAM_CANTON).toBe('TI');
  });

  it('extracts only branded job PDFs and excludes the health questionnaire', () => {
    expect(parseEcamListingPage(LISTING_HTML)).toEqual([
      {
        pdfUrl: HR_PDF_URL,
        filename: '2026.03.08_Concorso-RU-ECAM-80-100_-002_def.pdf',
        anchorText: 'Responsabile servizio risorse umane',
      },
      {
        pdfUrl: GENERAL_PDF_URL,
        filename: 'Concorso-generale-sito-ECAM-2026.pdf',
        anchorText: 'Concorso generale permanente',
      },
    ]);
  });

  it('fails closed when the page is not the branded ECAM career page', () => {
    expect(() => parseEcamListingPage('<html><title>Other site</title><h1>Jobs</h1></html>'))
      .toThrow(/authoritative career-page boundary/i);
  });

  it('extracts titles and source dates from the two current notice shapes', () => {
    expect(extractEcamTitle(HR_PDF_TEXT, 'hr.pdf'))
      .toBe('un/a Responsabile servizio risorse umane al 80%-100%');
    expect(extractEcamTitle(
      "L'ente apre un pubblico concorso per l'assunzione di: un/a Responsabile servizio risorse umane al 80%-100% Compiti: collaborare con la Direzione.",
      'hr.pdf',
    )).toBe('un/a Responsabile servizio risorse umane al 80%-100%');
    expect(extractEcamTitle(GENERAL_PDF_TEXT, 'Concorso-generale-sito-ECAM-2026.pdf'))
      .toBe('Concorso generale permanente 2026');
    expect(extractEcamPostedDate(HR_PDF_TEXT, 'hr.pdf')).toBe('2026-08-07');
    expect(extractEcamPostedDate(GENERAL_PDF_TEXT, 'general.pdf')).toBe('2026-01-01');
    expect(extractEcamValidThrough(HR_PDF_TEXT)).toBe('2026-09-18');
    expect(extractEcamValidThrough(GENERAL_PDF_TEXT)).toBe('2026-12-31');
  });

  it('builds source-backed jobs with stable PDF identity and Swiss geography', () => {
    const job = buildEcamJob({
      pdfUrl: HR_PDF_URL,
      filename: '2026.03.08_Concorso-RU-ECAM-80-100_-002_def.pdf',
      pdfText: HR_PDF_TEXT,
    });

    expect(job.id).toMatch(/^ecam-[a-f0-9]{12}$/);
    expect(job.url).toBe(HR_PDF_URL);
    expect(job.applyUrl).toBe(ECAM_CAREER_URL);
    expect(job.title).toContain('Responsabile servizio risorse umane');
    expect(job.description).toContain('conoscenza del diritto del lavoro');
    expect(job.description).toContain(HR_PDF_URL);
    expect(job.location).toBe('Mendrisio');
    expect(job.canton).toBe('TI');
    expect(job.addressCountry).toBe('CH');
    expect(job.employmentType).toBe('FULL_TIME');
    expect(job.postedDate).toBe('2026-08-07');
    expect(job.validThrough).toBe('2026-09-18');
    expect(job.slugByLocale).toEqual({ it: job.slug });
  });

  it('fetches and parses the full official PDF inventory offline', async () => {
    const jobs = await fetchAllEcamJobs({
      fetchPage: async () => LISTING_HTML,
      extractPdfText: async (url: string) => ({
        text: url === HR_PDF_URL ? HR_PDF_TEXT : GENERAL_PDF_TEXT,
      }),
    });

    expect(jobs).toHaveLength(2);
    expect(jobs.map((job) => job.url)).toEqual([HR_PDF_URL, GENERAL_PDF_URL]);
    expect(jobs.every((job) => job.companyKey === ECAM_KEY)).toBe(true);
  });

  it('matches ECAM jobs and trusts only ECAM hosts', () => {
    expect(isEcamJob({ companyKey: ECAM_KEY })).toBe(true);
    expect(isEcamJob({ company: ECAM_COMPANY_NAME })).toBe(true);
    expect(isEcamJob({ url: HR_PDF_URL })).toBe(true);
    expect(isEcamJob({ companyKey: 'other', url: 'https://example.com/jobs/1' })).toBe(false);
    expect(isTrustedDomain(HR_PDF_URL)).toBe(true);
    expect(isTrustedDomain('https://jobs.ecam.swiss/apply/1')).toBe(true);
    expect(isTrustedDomain('https://ecam.swiss.evil.example/jobs')).toBe(false);
    expect(isTrustedDomain('not-a-url')).toBe(false);
  });
});
