/**
 * SWICA, CSS Versicherung and Kanton Solothurn (Prospective careercenter +
 * JobPosting JSON-LD) publish the posting text only — issue 5253.
 *
 * Under 50 words each parser used to add "<title> — <company>, <city>.", a
 * paragraph about the company and "Bewirb dich direkt online über …", all
 * written by the parser; without a JSON-LD description it published those
 * lines alone. Now the source text is published only from the shared
 * 50-word floor up (`scripts/lib/source-body-floor.mjs`); a shorter text, or
 * none, gives no description, and the job takes the pipeline's thin-source
 * path (quarantine) instead of becoming an indexable thin page.
 *
 * Texts and addresses: the opening of live postings of the three boards
 * (2026-09-29), trimmed below and above 50 words.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAllSwicaJobs } from '../scripts/lib/swica-job-parser.mjs';
import { fetchAllCssVersicherungJobs } from '../scripts/lib/css-versicherung-job-parser.mjs';
import { fetchAllKantonSolothurnJobs } from '../scripts/lib/kanton-solothurn-job-parser.mjs';

function htmlResponse(body: string) {
  return { ok: true, status: 200, text: () => Promise.resolve(body) };
}

function detailPage(jsonLd: Record<string, unknown>) {
  return `<html><head><script type="application/ld+json">${JSON.stringify(jsonLd)}</script></head><body></body></html>`;
}

const BOARDS = [
  {
    name: 'SWICA',
    fetchAll: fetchAllSwicaJobs,
    listingPrefix: 'https://jobs.swica.ch/?',
    listingHtml: '<a href="https://jobs.swica.ch/offene-stellen/kundenberater-alle/2627f149-a164-42a5-a6e3-020d219b5621" title="Kundenberater (alle)">Kundenberater</a>',
    title: 'Kundenberater (alle)',
    text: 'Nähe ist in unserer DNA. Bei SWICA können wir in den Agenturen entscheiden, wie wir unseren Versicherten am Besten helfen.',
    longText: 'Nähe ist in unserer DNA. Bei SWICA können wir in den Agenturen entscheiden, wie wir unseren Versicherten am Besten helfen. Kurze Wege, schnelle Entscheide: Du bist mittendrin, arbeitest an vielfältigen Projekten und gestaltest Lösungen aktiv mit. Du bringst deine Ideen direkt ein und siehst, wie sie Wirkung entfalten. Das macht den Unterschied. So gestaltest du Gesundheit mit.',
    address: { addressCountry: 'Schweiz', addressLocality: 'Herisau', addressRegion: 'Appenzell Ausserrhoden', postalCode: '9100', streetAddress: 'Kasernenstrasse 6' },
    padding: /SWICA ist eine der führenden Kranken- und Unfallversicherungen|Bewirb dich direkt online|— SWICA, /,
  },
  {
    name: 'CSS Versicherung',
    fetchAll: fetchAllCssVersicherungJobs,
    listingPrefix: 'https://jobs.css.ch/?',
    listingHtml: '<a class="job-title" href="https://jobs.css.ch/offene-stellen/kundenbetreuer-in-kundenservice-center-mit-fokus-im-einzelleben/049bb6e8-7e4f-4bbb-9e45-dd7ce56bcd1d">Kundenbetreuer/in</a>',
    title: 'Kundenbetreuer/in Kundenservice-Center mit Fokus im Einzelleben 80-100%',
    text: 'Unseren Kundinnen und Kunden individuell zur Seite stehen, das ist Teil unserer DNA. Im Kundenservice-Center sorgen wir gemeinsam dafür, dass alles rund läuft.',
    longText: 'Unseren Kundinnen und Kunden individuell zur Seite stehen, das ist Teil unserer DNA. Im Kundenservice-Center sorgen wir gemeinsam dafür, dass alles rund läuft. Und jetzt gehen wir einen Schritt weiter: Mit dem Markteintritt der CSS in den Geschäftsbereich Leben hast du die einmalige Chance, von Anfang an dabei zu sein und aktiv mitzugestalten, wie wir unseren Kundinnen und Kunden künftig begegnen.',
    address: { addressCountry: 'CH', addressLocality: 'Root', addressRegion: 'Luzern', postalCode: '6037' },
    padding: /Die CSS ist eine der führenden Kranken- und Sachversicherungen|Bewirb dich direkt online|— CSS/,
  },
  {
    name: 'Kanton Solothurn',
    fetchAll: fetchAllKantonSolothurnJobs,
    listingPrefix: 'https://job.so.ch/',
    listingHtml: '<a class="job" href="https://job.so.ch/offene-stellen/informationssicherheitsverantwortliche-r-und-projektleiter-in/d29b5286-0e5e-4837-b17a-8b5afc60a5fa"><span>Informationssicherheitsverantwortliche/-r</span></a>',
    title: 'Informationssicherheitsverantwortliche/-r und Projektleiter/-in, 80-100%',
    text: 'Das Departementssekretariat unterstützt die Departementsleitung und verantwortet die digitale Transformation im Bau- und Justizdepartement. Der Projektleitungspool des Amts für Geoinformation unterstützt das Departementssekretariat und die Fachämter bei der Entwicklung und Umsetzung digitaler Vorhaben.',
    longText: 'Das Departementssekretariat unterstützt die Departementsleitung und verantwortet die digitale Transformation im Bau- und Justizdepartement. Der Projektleitungspool des Amts für Geoinformation unterstützt das Departementssekretariat und die Fachämter bei der Entwicklung und Umsetzung digitaler Vorhaben. Für die Abteilung Dienstleistungen suchen wir per 04.01.2027 oder nach Vereinbarung am Standort Solothurn eine/-n IS-Verantwortliche/-n und Projektleiter/-in, 80-100%. Sie initialisieren, planen und leiten IT-Projekte.',
    address: { addressCountry: 'CH', addressLocality: 'Solothurn', addressRegion: 'Solothurn', postalCode: '4500' },
    padding: /Der Kanton Solothurn ist Arbeitgeber für tausende|Bewirb dich direkt online|— Kanton Solothurn, /,
  },
];

describe.each(BOARDS)('$name — the JSON-LD text only', (board) => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubBoard(jsonLd: Record<string, unknown>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => (
      String(url).startsWith(board.listingPrefix) && !String(url).includes('/offene-stellen/')
        ? htmlResponse(board.listingHtml)
        : htmlResponse(detailPage(jsonLd))
    )));
  }

  const baseJsonLd = () => ({
    '@type': 'JobPosting',
    title: board.title,
    datePosted: '2026-09-20',
    employmentType: 'FULL_TIME',
    hiringOrganization: { '@type': 'Organization', name: board.name },
    jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', ...board.address } },
  });

  it('publishes a description from 50 words up as the source wrote it', async () => {
    expect(board.longText.split(/\s+/).length).toBeGreaterThanOrEqual(50);
    stubBoard({ ...baseJsonLd(), description: `<p>${board.longText}</p>` });

    const jobs = await board.fetchAll();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].description).toBe(board.longText);
    expect(jobs[0].descriptionByLocale).toEqual({ de: board.longText });
    expect(jobs[0].description).not.toMatch(board.padding);
  });

  it('gives a description under 50 words no indexable text (thin-source path), not a padded one', async () => {
    expect(board.text.split(/\s+/).length).toBeLessThan(50);
    stubBoard({ ...baseJsonLd(), description: `<p>${board.text}</p>` });

    const jobs = await board.fetchAll();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].description).toBe('');
    expect(jobs[0].descriptionByLocale).toEqual({});
  });

  it('gives a posting without a description no description', async () => {
    stubBoard(baseJsonLd());

    const jobs = await board.fetchAll();

    expect(jobs).toHaveLength(1);
    expect(jobs[0].description).toBe('');
    expect(jobs[0].descriptionByLocale).toEqual({});
  });
});
