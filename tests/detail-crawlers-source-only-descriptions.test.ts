/**
 * Crawlers whose description was written by the crawler because the posting
 * itself was never read (lot L, H2a of #5253): Flury Stiftung (PDF), REHAB
 * Basel (Talentsoft detail), PDGR apprenticeship pages, Klinik Schloss
 * Mammern (Elementor post content), Zermatt Bergbahnen and Moncucco (listing
 * metadata below MIN_DESC_LENGTH). They now publish the posting's own text,
 * keyed by its language; a posting without text gets no description and takes
 * the pipeline's thin-source path. Stored jobs still carrying the old text are
 * cleaned before the merge with each crawler's `*_FABRICATED_DESCRIPTION_RE`.
 *
 * Fixtures: minimized live pages and PDF text of 2026-09-29 (contact persons
 * redacted), minimized stored rows of the main slices.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';

const { fetchHtml } = vi.hoisted(() => ({ fetchHtml: vi.fn() }));
vi.mock('../scripts/lib/crawler-template.mjs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchHtml };
});

import { dropFabricatedDescription } from '../scripts/lib/drop-fabricated-description.mjs';
import {
  FLURY_STIFTUNG_FABRICATED_DESCRIPTION_RE,
  buildFluryStiftungDescription,
  fetchAllFluryStiftungJobs,
  restoreFluryPdfLists,
} from '../scripts/lib/flury-stiftung-job-parser.mjs';
import {
  REHAB_BASEL_FABRICATED_DESCRIPTION_RE,
  fetchAllRehabBaselJobs,
  parseRehabBaselDetail,
} from '../scripts/lib/rehab-basel-job-parser.mjs';
import { PDGR_FABRICATED_DESCRIPTION_RE, parseDetailPage as parsePdgrDetailPage } from '../scripts/lib/pdgr-job-parser.mjs';
import { KLINIK_SCHLOSS_MAMMERN_FABRICATED_DESCRIPTION_RE, extractKsmDetail } from '../scripts/lib/klinik-schloss-mammern-job-parser.mjs';
import {
  ZERMATT_BERGBAHNEN_FABRICATED_DESCRIPTION_RE,
  parseDetailPage as parseZermattDetailPage,
} from '../scripts/lib/zermatt-bergbahnen-job-parser.mjs';
import { MONCUCCO_FABRICATED_DESCRIPTION_RE, fetchAllMoncuccoJobs } from '../scripts/lib/moncucco-job-parser.mjs';
import { CERBIOS_PHARMA_FABRICATED_DESCRIPTION_RE, buildJob as buildCerbiosJob } from '../scripts/lib/cerbios-pharma-job-parser.mjs';

const fixture = (name: string) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const LIST_LINE_RE = /^\s*[-•*]\s/m;

afterEach(() => {
  vi.unstubAllGlobals();
  fetchHtml.mockReset();
});

describe('Flury Stiftung — the PDF text is the description', () => {
  const pdfText = fixture('flury-stiftung/applikationsmanager-pdf.txt');

  it('publishes the PDF text with its lists and headings back on their own lines', () => {
    const out = buildFluryStiftungDescription(pdfText);
    expect(out).toContain('Zu Ihrem Aufgabenbereich gehören:\n\n- Betrieb, Betreuung und Weiterentwicklung des KIS');
    expect(out).toContain('\n\nIhr Profil:\n\n- Ausbildung oder Studium im Bereich Informatik');
    expect(out).toContain('\n\nWir bieten:\n\n- Zukunftsorientiertes und innovatives Unternehmen');
    expect(out).not.toContain('›');
    expect(LIST_LINE_RE.test(out)).toBe(true);
    expect(FLURY_STIFTUNG_FABRICATED_DESCRIPTION_RE.test(out)).toBe(false);
    expect(out).not.toMatch(/Arbeitsort: |Bereich: /);
  });

  it('leaves a text without list markers as it is', () => {
    expect(restoreFluryPdfLists('Wir suchen eine Pflegefachperson.')).toBe('Wir suchen eine Pflegefachperson.');
  });

  it('reads each PDF and gives a posting without PDF text no description', async () => {
    const listing = `<div class="table-responsive"><div class="caption"><caption>Spital Schiers</caption></div>
      <table><tbody><tr><td><span class="file file--mime-application-pdf file--application-pdf"><a href="/sites/default/files/2026-08/Stelleninserat_Applikationsmanager.pdf" type="application/pdf" title="x">Applikationsmanager*in 80 – 100 %</a></span></td></tr>
      <tr><td><span class="file file--mime-application-pdf file--application-pdf"><a href="/sites/default/files/2026-08/Scan.pdf" type="application/pdf" title="y">Pflegefachperson HF 80%</a></span></td></tr></tbody></table></div>`;
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => listing })));
    const extractPdf = vi.fn(async (url: string) => (url.endsWith('Scan.pdf')
      ? { text: '', rawText: '', thin: true, totalPages: 1 }
      : { text: pdfText, rawText: pdfText, thin: false, totalPages: 1 }));

    const jobs = await fetchAllFluryStiftungJobs({ extractPdf, delayMs: 0 });

    expect(extractPdf).toHaveBeenCalledTimes(2);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].description).toBe(buildFluryStiftungDescription(pdfText));
    expect(jobs[0].sourceLang).toBe('de');
    expect(jobs[0].descriptionByLocale).toEqual({ de: jobs[0].description });
    expect(jobs[1].description).toBe('');
  });
});

describe('REHAB Basel — the Talentsoft detail is read', () => {
  it('publishes every field of the posting, lists kept, without logo, reference or video', () => {
    const out = parseRehabBaselDetail(fixture('rehab-basel/detail-297.html'));
    expect(out.startsWith('Über uns\nAlles andere als alltäglich.')).toBe(true);
    expect(out).toContain('Ihr Aufgabenbereich\n• Befunderhebung der senso-motorischen');
    expect(out).toContain('Ihr Profil\n• Ausbildung als Dipl. Ergotherapeut*in FH/HF/BSc');
    expect(out).toContain('Sie finden bei uns\n• Ein engagiertes Team');
    expect(out).toContain('Stelle zu besetzen ab\n01.10.2026 oder nach Vereinbarung');
    expect(out).not.toMatch(/Kennziffer|REHAB Video|youtube/);
    expect(REHAB_BASEL_FABRICATED_DESCRIPTION_RE.test(out)).toBe(false);
  });

  it('builds each job from its detail page, keyed by the posting language', async () => {
    const pages: Record<string, string> = {
      'https://rehabbasel-career.talent-soft.com/stelle/liste-aller-stellen.aspx?all=1&mode=list': fixture('rehab-basel/listing-297.html'),
      'https://rehabbasel-career.talent-soft.com/stelle/stelle-ergotherapeut-in-bsc-90-100-m-w-d_297.aspx': fixture('rehab-basel/detail-297.html'),
    };
    const fetchPage = vi.fn(async (url: string) => pages[url] ?? '');
    const jobs = await fetchAllRehabBaselJobs({ fetchPage, delayMs: 0 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0].description).toBe(parseRehabBaselDetail(pages[jobs[0].url]));
    expect(jobs[0].sourceLang).toBe('de');
    expect(jobs[0].descriptionByLocale).toEqual({ de: jobs[0].description });
  });

  it('gives a detail without text no description', async () => {
    const fetchPage = vi.fn(async (url: string) => (url.includes('liste-aller-stellen') ? fixture('rehab-basel/listing-297.html') : '<html></html>'));
    const jobs = await fetchAllRehabBaselJobs({ fetchPage, delayMs: 0 });
    expect(jobs[0].description).toBe('');
  });
});

describe('PDGR — apprenticeship pages without ACF job fields', () => {
  it('reads the page elements in order up to the contact persons', () => {
    const detail = parsePdgrDetailPage(fixture('pdgr/detail-lehrstelle-koch.html'));
    const out = detail.description;
    expect(out.startsWith('In der Klinik Beverin in Cazis bilden wir Lernende Köchinnen und Köche aus.')).toBe(true);
    expect(out).toContain('Eckpunkte deiner Ausbildung');
    expect(out).toContain('Lehrdauer und schulische Ausbildung\nDeine Lehrzeit dauert 3 Jahre');
    expect(out).toContain('Unsere Anforderungen an dich');
    expect(out).toContain('Deine passende Ausbildung bei uns\nWir bieten dir eine auf dich abgestimmte Berufsausbildung.');
    expect(LIST_LINE_RE.test(out)).toBe(true);
    // Page navigation, accordion teasers and the contact block stay out.
    expect(out).not.toMatch(/Hast du Fragen|Leiter Küchen|It's a match|mehr erfahren|Entdecke unsere Werte/);
    expect(PDGR_FABRICATED_DESCRIPTION_RE.test(out)).toBe(false);
    expect(detail.employmentType).toBe('APPRENTICESHIP');
  });

  it('keeps the ACF job fields when the page has them', () => {
    const html = '<span id="acf_jobs_duties"><ul><li>Führen von Therapiegesprächen mit Patientinnen und Patienten</li></ul></span>'
      + '<div class="left-space textblock-spacer "><div class="container margin-strong-top textblock-wrapper">Allgemeiner Text</div></div>';
    expect(parsePdgrDetailPage(html).description).toBe('Ihre Aufgaben:\n- Führen von Therapiegesprächen mit Patientinnen und Patienten');
  });
});

describe('Klinik Schloss Mammern — the Elementor post content', () => {
  it('publishes the posting text without the benefit icons, the contact person or the site menu', () => {
    const { title, description } = extractKsmDetail(fixture('klinik-schloss-mammern/detail-fage-ausbildung.html'));
    expect(title).toBe('Ausbildungsplätze als Fachfrau/Fachmann Gesundheit EFZ');
    expect(description.startsWith('Die Klinik Schloss Mammern, eingebettet in eine beeindruckende Landschaft')).toBe(true);
    expect(description).toContain('• Sekundarschulabschluss Niveau E, M oder G');
    expect(description).toContain('• Multicheck alle Seiten');
    expect(description).not.toMatch(/^• Kinderhort$|Vorname Name|Jetzt Bewerben|Offene Stellen/m);
    expect(KLINIK_SCHLOSS_MAMMERN_FABRICATED_DESCRIPTION_RE.test(description)).toBe(false);
  });

  it('gives a page without posting text no description instead of the menu', () => {
    const html = '<nav><ul><li><a>Offene Stellen</a></li><li><a>Ausbildung</a></li></ul></nav>'
      + '<h1 class="elementor-heading-title">Schnupperpraktikum</h1><div>Anmeldung</div>';
    expect(extractKsmDetail(html)).toEqual({ title: 'Schnupperpraktikum', description: '' });
  });
});

describe('Zermatt Bergbahnen — the text sections of the detail page', () => {
  it('publishes the introduction and the job sections, not the hero with the breadcrumbs', () => {
    const out = parseZermattDetailPage(fixture('zermatt-bergbahnen/detail-unterhalt-gletscherlifte.html'));
    expect(out.startsWith('Die Zermatt Bergbahnen AG betreibt das ganzjährige')).toBe(true);
    expect(out).toContain('• Pikettdienst Sommerbetrieb');
    expect(out).toContain('Dein Profil');
    expect(out).toContain('Wir bieten:');
    expect(out).not.toMatch(/breadcrumbs|Jetzt bewerben|Bewerbungsunterlagen/);
    expect(ZERMATT_BERGBAHNEN_FABRICATED_DESCRIPTION_RE.test(out)).toBe(false);
  });

  it('gives a page without those sections no description instead of the hero', () => {
    expect(parseZermattDetailPage('<main>breadcrumbs.home Jobs und Karriere</main>')).toBe('');
    const heroOnly = fixture('zermatt-bergbahnen/detail-unterhalt-gletscherlifte.html')
      .replace(/<section class="wysiwyg-(?:usp-area|with-medium)[\s\S]*?<\/section>/g, '');
    expect(parseZermattDetailPage(heroOnly)).toBe('');
  });
});

describe('Moncucco — the detail text whatever its length', () => {
  const LISTING = `<div class="listing-job"><div class="item-job"><a href="https://www.moncucco.ch/tecnico_di_radiologia.php5">
    <h3>Tecnico/a di radiologia medica</h3><div class="info-job">Percentuale di impiego: <span>80%</span></div>
    <div class="info-job">Disponibilità: <span>subito</span></div></a></div></div>`;

  it('keeps a short detail text instead of the listing metadata', async () => {
    fetchHtml
      .mockResolvedValueOnce(LISTING)
      .mockResolvedValueOnce('<div class="testo-pagina"><p>Candidature entro il 31 ottobre 2026.</p></div>');
    const jobs = await fetchAllMoncuccoJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].description).toBe('Candidature entro il 31 ottobre 2026.');
    expect(MONCUCCO_FABRICATED_DESCRIPTION_RE.test(jobs[0].description)).toBe(false);
  });

  it('gives a detail without text no description', async () => {
    fetchHtml.mockResolvedValueOnce(LISTING).mockResolvedValueOnce('<div class="testo-pagina"></div>');
    const jobs = await fetchAllMoncuccoJobs();
    expect(jobs[0].description).toBe('');
    expect(jobs[0].descriptionByLocale).toEqual({ it: '' });
  });
});

describe('stored rows carrying crawler-written text (main slices)', () => {
  const FIXTURE = JSON.parse(fixture('crawler-fabricated-descriptions/detail-crawlers.json'));
  const PATTERNS: Record<string, RegExp> = {
    'flury-stiftung': FLURY_STIFTUNG_FABRICATED_DESCRIPTION_RE,
    'rehab-basel': REHAB_BASEL_FABRICATED_DESCRIPTION_RE,
    pdgr: PDGR_FABRICATED_DESCRIPTION_RE,
    'klinik-schloss-mammern': KLINIK_SCHLOSS_MAMMERN_FABRICATED_DESCRIPTION_RE,
    'zermatt-bergbahnen': ZERMATT_BERGBAHNEN_FABRICATED_DESCRIPTION_RE,
  };

  for (const [key, pattern] of Object.entries(PATTERNS)) {
    it(`${key}: the stored text is removed with the translations made from it`, () => {
      const row = FIXTURE[key];
      expect(pattern.test(row.source)).toBe(true);
      const job: any = {
        sourceLang: row.sourceLang,
        description: row.source,
        descriptionByLocale: { [row.sourceLang]: row.source, ...(row.translation || {}) },
      };
      expect(dropFabricatedDescription(job, pattern)).toBe(true);
      expect(job.descriptionByLocale).toEqual({});
      expect(job.description).toBe('');
    });
  }

  it('cerbios-pharma: the former builder paragraph is recognised and removed (no stored rows today)', () => {
    // The paragraph the builder used to write when the listing had no text.
    const former = 'Chimico di processo presso Cerbios-Pharma SA, azienda farmaceutica CDMO con sede a Barbengo (Lugano, Ticino). Cerbios-Pharma è specializzata nello sviluppo e nella produzione di principi attivi farmaceutici (API).';
    const job: any = {
      sourceLang: 'it',
      description: former,
      descriptionByLocale: { it: former, en: 'Process chemist at Cerbios-Pharma SA, a CDMO pharmaceutical company based in Barbengo.' },
    };
    expect(dropFabricatedDescription(job, CERBIOS_PHARMA_FABRICATED_DESCRIPTION_RE)).toBe(true);
    expect(job.descriptionByLocale).toEqual({});
    expect(job.description).toBe('');
    const fresh = buildCerbiosJob({ title: 'Chimico di processo' });
    expect(CERBIOS_PHARMA_FABRICATED_DESCRIPTION_RE.test(fresh!.description)).toBe(false);
  });

  it('moncucco: the former metadata description is recognised (no stored rows today)', () => {
    expect(MONCUCCO_FABRICATED_DESCRIPTION_RE.test('Infermiere/a — Gruppo Ospedaliero Moncucco, Lugano Percentuale di impiego: 80%')).toBe(true);
  });
});
