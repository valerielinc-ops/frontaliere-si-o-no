import { describe, expect, it } from 'vitest';

import {
  CONSERVATORIO_CAREER_URL,
  CONSERVATORIO_COMPANY_NAME,
  CONSERVATORIO_KEY,
  buildConservatorioJob,
  discoverConservatorioPageNumbers,
  extractConservatorioValidThrough,
  fetchAllConservatorioJobs,
  isConservatorioJob,
  isCurrentConservatorioListing,
  isTrustedDomain,
  parseConservatorioDate,
  parseConservatorioDetailPage,
  parseConservatorioListingPage,
} from '../scripts/lib/conservatorio-job-parser.mjs';

const NOW = new Date('2026-10-29T12:00:00.000Z');
const DETAIL_DIRECTOR = `${CONSERVATORIO_CAREER_URL}/dettaglio/id/57566/direttore`;
const DETAIL_FISARMONICA = `${CONSERVATORIO_CAREER_URL}/dettaglio/id/57397/fisarmonica`;
const PDF_DIRECTOR = 'https://www.conservatorio.ch/media/844577/bando-direttore-sum_2026.pdf';
const PDF_FISARMONICA = 'https://www.conservatorio.ch/media/841016/bando-fisarmonica-sum.pdf';

function archivePage(items, pageCount = 1) {
  const links = items.map(({ url, date, title }) => `
    <li><a href="${url}"><div class="news-description"><time>${date}</time><strong>${title}</strong></div></a></li>
  `).join('');
  const pages = Array.from({ length: pageCount }, (_, index) =>
    `<a href="${CONSERVATORIO_CAREER_URL}?page=${index + 1}">${index + 1}</a>`,
  ).join('');
  return `<ul class="list-events list-news">${links}</ul><nav>${pages}</nav>`;
}

function detailPage({ title, date, roleMarkup, pdfUrl }) {
  return `
    <div class="box box-1"><h1>${title}</h1><h4>${date}</h4></div>
    <div class="box box-3"><h3>${roleMarkup}</h3><p><a href="${pdfUrl}">SCARICA IL BANDO</a></p></div>
  `;
}

const directorPdfText = `
  Direttore/Direttrice della Scuola universitaria di Musica (SUM)
  La Fondazione cerca una persona con esperienza nella direzione di istituzioni
  musicali, capacità di gestione, visione strategica, competenze organizzative
  e forte attitudine alla collaborazione con docenti, studenti e organi direttivi.
  Il ruolo prevede un impiego all'80-100% e ingresso in
  funzione il primo settembre duemilaventisette. Le candidature devono essere
  inviate entro il 20 novembre 2026 esclusivamente all'indirizzo indicato nel bando.
`;

const expiredPdfText = `
  Docente di Fisarmonica
  La Scuola universitaria di Musica cerca una docente o un docente con alto
  profilo artistico e didattico, esperienza internazionale, disponibilità per
  lezioni individuali e partecipazione alle attività formative dell'istituto.
  Le candidature devono essere inviate entro il 7 ottobre 2026.
`;

describe('Conservatorio della Svizzera italiana crawler parser', () => {
  it('exposes the dedicated identity and trusts only the official domain', () => {
    expect(CONSERVATORIO_KEY).toBe('conservatorio');
    expect(CONSERVATORIO_COMPANY_NAME).toBe('Conservatorio della Svizzera italiana');
    expect(isConservatorioJob({ companyKey: 'conservatorio' })).toBe(true);
    expect(isConservatorioJob({ company: CONSERVATORIO_COMPANY_NAME })).toBe(true);
    expect(isConservatorioJob({ url: PDF_DIRECTOR })).toBe(true);
    expect(isConservatorioJob({ company: 'Other', url: 'https://example.com/jobs/1' })).toBe(false);
    expect(isConservatorioJob(null)).toBe(false);
    expect(isTrustedDomain('https://www.conservatorio.ch/media/1/job.pdf')).toBe(true);
    expect(isTrustedDomain('https://careers.conservatorio.ch/job/1')).toBe(true);
    expect(isTrustedDomain('https://evilconservatorio.ch/job/1')).toBe(false);
    expect(isTrustedDomain('https://example.com/job/1')).toBe(false);
    expect(isConservatorioJob({ url: 'https://evilconservatorio.ch/job/1' })).toBe(false);
  });

  it('parses the archive boundary, dates, pagination and vacancy filtering', () => {
    const html = archivePage([
      {
        url: DETAIL_DIRECTOR,
        date: '15.09.26',
        title: 'La Fondazione Conservatorio della Svizzera italiana cerca un/a Direttore/Direttrice SUM',
      },
      {
        url: `${CONSERVATORIO_CAREER_URL}/dettaglio/id/57551/competition`,
        date: '10.09.26',
        title: 'Kristina Papiieva 3° Premio al Concorso Nazionale',
      },
    ], 3);

    expect(parseConservatorioDate('15.09.26')).toBe('2026-09-15');
    expect(parseConservatorioDate('31.02.2026')).toBe('');
    expect(discoverConservatorioPageNumbers(html)).toEqual([1, 2, 3]);
    expect(parseConservatorioListingPage(html)).toEqual([
      {
        detailUrl: DETAIL_DIRECTOR,
        title: 'La Fondazione Conservatorio della Svizzera italiana cerca un/a Direttore/Direttrice SUM',
        publishedDate: '2026-09-15',
      },
    ]);
    expect(() => parseConservatorioListingPage('<html><body>challenge</body></html>')).toThrow(/news-list boundary/);
  });

  it('extracts multiple role headings and ignores untrusted PDF attachments', () => {
    const html = detailPage({
      title: 'La Scuola universitaria di Musica cerca un docente di arpa e di basso tuba',
      date: '26.05.26',
      roleMarkup: '<strong>Docente di Arpa</strong><br><strong>Docente di Basso Tuba</strong>',
      pdfUrl: 'https://www.conservatorio.ch/media/836662/bando-docenti-sum_maggio-2026_complete.pdf',
    }).replace('</p></div>', '<a href="https://example.com/fake.pdf">fake</a></p></div>');
    const parsed = parseConservatorioDetailPage(html, `${CONSERVATORIO_CAREER_URL}/dettaglio/id/57287/arpa`);
    expect(parsed.roleTitles).toEqual(['Docente di Arpa', 'Docente di Basso Tuba']);
    expect(parsed.pdfs).toHaveLength(1);
    expect(parsed.pdfs[0].pdfUrl).toContain('/media/836662/');
    expect(parsed.publishedDate).toBe('2026-05-26');
  });

  it('scopes deadlines to each role in a shared official PDF', () => {
    const text = `
      Docente di Arpa Docente di Basso Tuba
      Le audizioni per il concorso di arpa si terranno a settembre.
      Il dossier per il concorso di arpa va inviato entro il 20 agosto 2026.
      Il dossier per il concorso di basso tuba va inviato entro il 31 agosto 2026.
    `;
    const roles = ['Docente di Arpa', 'Docente di Basso Tuba'];
    expect(extractConservatorioValidThrough(text, { roleTitle: roles[0], roleTitles: roles })).toBe('2026-08-20');
    expect(extractConservatorioValidThrough(text, { roleTitle: roles[1], roleTitles: roles })).toBe('2026-08-31');
  });

  it('builds a source-only job with stable PDF identity and structured fields', () => {
    const job = buildConservatorioJob({
      listing: { detailUrl: DETAIL_DIRECTOR, publishedDate: '2026-09-15' },
      roleTitle: 'Direttore/Direttrice SUM',
      roleTitles: ['Direttore/Direttrice SUM'],
      pdfUrl: PDF_DIRECTOR,
      pdfText: directorPdfText,
      now: NOW,
    });
    expect(job.id).toMatch(/^conservatorio-[a-f0-9]{12}$/);
    expect(job.url).toBe(PDF_DIRECTOR);
    expect(job.applyUrl).toBe(DETAIL_DIRECTOR);
    expect(job.location).toBe('Lugano');
    expect(job.canton).toBe('TI');
    expect(job.postedDate).toBe('2026-09-15');
    expect(job.validThrough).toBe('2026-11-20');
    expect(job.employmentType).toBe('FULL_TIME');
    expect(job.description).toContain('La Fondazione cerca una persona');
    expect(job.description).not.toContain('Fonte (PDF):');
    expect(isCurrentConservatorioListing(job, NOW)).toBe(true);
  });

  it('walks all advertised pages, emits active roles and retires expired notices', async () => {
    const archiveOne = archivePage([
      {
        url: DETAIL_DIRECTOR,
        date: '15.09.26',
        title: 'La Fondazione Conservatorio della Svizzera italiana cerca un/a Direttore/Direttrice SUM',
      },
    ], 2);
    const archiveTwo = archivePage([
      {
        url: DETAIL_FISARMONICA,
        date: '16.07.26',
        title: 'La Scuola universitaria di Musica cerca un docente di fisarmonica',
      },
    ], 2);
    const pages = new Map([
      [CONSERVATORIO_CAREER_URL, archiveOne],
      [`${CONSERVATORIO_CAREER_URL}?page=2`, archiveTwo],
      [DETAIL_DIRECTOR, detailPage({
        title: 'La Fondazione Conservatorio della Svizzera italiana cerca un/a Direttore/Direttrice SUM',
        date: '15.09.26',
        roleMarkup: 'Direttore/Direttrice SUM',
        pdfUrl: PDF_DIRECTOR,
      })],
      [DETAIL_FISARMONICA, detailPage({
        title: 'La Scuola universitaria di Musica cerca un docente di fisarmonica',
        date: '16.07.26',
        roleMarkup: 'Docente di Fisarmonica',
        pdfUrl: PDF_FISARMONICA,
      })],
    ]);
    const result = await fetchAllConservatorioJobs({
      now: NOW,
      fetchPage: async (url) => pages.get(url) || (() => { throw new Error(`unexpected URL ${url}`); })(),
      extractPdfText: async (url) => ({ text: url === PDF_DIRECTOR ? directorPdfText : expiredPdfText }),
    });

    expect(result.discoveredCount).toBe(2);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].title).toBe('Direttore/Direttrice SUM');
    expect(result.jobs[0].validThrough).toBe('2026-11-20');
    expect(result.sourceBodyFailures).toEqual([]);
  });

  it('stamps an authoritative empty result when every parsed PDF is expired', async () => {
    const archive = archivePage([{
      url: DETAIL_FISARMONICA,
      date: '16.07.26',
      title: 'La Scuola universitaria di Musica cerca un docente di fisarmonica',
    }]);
    const result = await fetchAllConservatorioJobs({
      now: NOW,
      fetchPage: async (url) => url === CONSERVATORIO_CAREER_URL
        ? archive
        : detailPage({
          title: 'La Scuola universitaria di Musica cerca un docente di fisarmonica',
          date: '16.07.26',
          roleMarkup: 'Docente di Fisarmonica',
          pdfUrl: PDF_FISARMONICA,
        }),
      extractPdfText: async () => ({ text: expiredPdfText }),
    });
    expect(result.jobs).toEqual([]);
    expect(Reflect.get(result.jobs, 'authoritativeEmptyState')).toBe('authoritative-source-zero');
  });

  it('keeps a failed PDF visible to the standard pipeline as a source-body failure', async () => {
    const archive = archivePage([{
      url: DETAIL_DIRECTOR,
      date: '15.09.26',
      title: 'La Fondazione Conservatorio della Svizzera italiana cerca un/a Direttore/Direttrice SUM',
    }]);
    const result = await fetchAllConservatorioJobs({
      now: NOW,
      fetchPage: async (url) => url === CONSERVATORIO_CAREER_URL
        ? archive
        : detailPage({
          title: 'La Fondazione Conservatorio della Svizzera italiana cerca un/a Direttore/Direttrice SUM',
          date: '15.09.26',
          roleMarkup: 'Direttore/Direttrice SUM',
          pdfUrl: PDF_DIRECTOR,
        }),
      extractPdfText: async () => ({ error: 'network timeout' }),
    });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].sourceBodyFailureReason).toBe('pdf-extraction-failed');
    expect(result.sourceBodyFailures[0].message).toBe('network timeout');
  });
});
