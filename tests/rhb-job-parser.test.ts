import { describe, expect, it } from 'vitest';

import { parseRhbJobDetail, parseRhbListingPage } from '../scripts/lib/rhb-job-parser.mjs';

describe('rhb-job-parser', () => {
  it('parses listing cards from paginated overview pages', () => {
    const html = [
      '<main>',
      '<article>',
      '<h3><a href="/de/job/projektverantwortliche-r-produktmanagement-unesco-und-bahnkultur-80-100_2026-2155/">Projektverantwortliche/r Produktmanagement UNESCO und Bahnkultur (80-100%)</a></h3>',
      '<p>Angebote entwickeln – Erlebnisse gestalten – Marktchancen nutzen</p>',
      '<div><p><img />Chur</p><p><img />07. März 2026</p></div>',
      '</article>',
      '<article>',
      '<h3><a href="/de/job/junior-netzwerk-spezialist-in-80-100_2026-2150/">Junior Netzwerk-Spezialist/in (80–100%)</a></h3>',
      '<p>Netzwerke verstehen — Systeme betreuen — Verbindungen sichern</p>',
      '<div><p><img />Landquart</p><p><img />27. Februar 2026</p></div>',
      '</article>',
      '</main>',
    ].join('');

    const result = parseRhbListingPage(html, 'https://www.rhb.ch/de/jobs-karriere/jobs-bewerbung/job-uebersicht/?page=1');

    expect(result).toEqual([
      {
        detailUrl: 'https://www.rhb.ch/de/job/projektverantwortliche-r-produktmanagement-unesco-und-bahnkultur-80-100_2026-2155/',
        title: 'Projektverantwortliche/r Produktmanagement UNESCO und Bahnkultur (80-100%)',
        summary: 'Angebote entwickeln – Erlebnisse gestalten – Marktchancen nutzen',
        location: 'Chur',
        postedDate: '2026-03-07',
      },
      {
        detailUrl: 'https://www.rhb.ch/de/job/junior-netzwerk-spezialist-in-80-100_2026-2150/',
        title: 'Junior Netzwerk-Spezialist/in (80–100%)',
        summary: 'Netzwerke verstehen — Systeme betreuen — Verbindungen sichern',
        location: 'Landquart',
        postedDate: '2026-02-27',
      },
    ]);
  });

  it('parses job detail data from JSON-LD and embedded Next payload', () => {
    const html = [
      '<html><head>',
      '<title>Projektverantwortliche/r Produktmanagement UNESCO und Bahnkultur (80-100%) | Rhätische Bahn</title>',
      '<script type="application/ld+json">',
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: 'Projektverantwortliche/r Produktmanagement UNESCO und Bahnkultur (80-100%) | Rhätische Bahn',
        description: 'Angebote entwickeln – Erlebnisse gestalten – Marktchancen nutzen',
        datePosted: '2026-03-07T00:06:28.973',
        employmentType: 'Unbefristet',
        jobLocation: { '@type': 'Place', address: { '@type': 'PostalAddress', addressRegion: 'Graubünden' } },
      }),
      '</script>',
      '</head><body>',
      '<script>self.__next_f.push([1,"{\\"intro\\":\\"Du denkst in Produkten, Zielgruppen und Potenzialen?\\",\\"tasks\\":\\"\\\\u003cul\\\\u003e\\\\u003cli\\\\u003eMitarbeit in Schluesselprojekten\\\\u003c/li\\\\u003e\\\\u003cli\\\\u003eKonzeptionelle Produktentwicklung\\\\u003c/li\\\\u003e\\\\u003c/ul\\\\u003e\\",\\"qualifications\\":\\"\\\\u003cul\\\\u003e\\\\u003cli\\\\u003eAusbildung im Bereich Tourismus\\\\u003c/li\\\\u003e\\\\u003cli\\\\u003eErfahrung im Projektmanagement\\\\u003c/li\\\\u003e\\\\u003c/ul\\\\u003e\\",\\"offer\\":\\"\\\\u003cul\\\\u003e\\\\u003cli\\\\u003e2. Klasse Generalabonnement\\\\u003c/li\\\\u003e\\\\u003c/ul\\\\u003e\\",\\"additional\\":\\"\\\\u003cp\\\\u003eArbeitsbeginn ist der 1. Mai 2026 oder nach Vereinbarung.\\\\u003c/p\\\\u003e\\",\\"department\\":\\"Chur\\",\\"period\\":\\"Unbefristet\\",\\"name\\":\\"Roman Cathomas\\",\\"phone\\":\\"+41 81 288 63 90\\",\\"url\\":\\"https://rhb-career.talent-soft.com/stelle/projektverantwortliche-r-produktmanagement-unesco-und-bahnkultur-80-100-_2155.aspx?action=jobapplication\\"}"]) </script>',
      '</body></html>',
    ].join('');

    const result = parseRhbJobDetail(
      html,
      'https://www.rhb.ch/de/job/projektverantwortliche-r-produktmanagement-unesco-und-bahnkultur-80-100_2026-2155/'
    );

    expect(result.title).toBe('Projektverantwortliche/r Produktmanagement UNESCO und Bahnkultur (80-100%)');
    expect(result.location).toBe('Chur');
    expect(result.contract).toBe('Unbefristet');
    expect(result.applyUrl).toBe(
      'https://rhb-career.talent-soft.com/stelle/projektverantwortliche-r-produktmanagement-unesco-und-bahnkultur-80-100-_2155.aspx?action=jobapplication'
    );
    expect(result.postedDate).toBe('2026-03-07');
    expect(result.description).toContain('## Aufgaben');
    expect(result.description).toContain('- Mitarbeit in Schluesselprojekten');
    expect(result.description).toContain('## Anforderungen');
    expect(result.description).toContain('- Ausbildung im Bereich Tourismus');
    expect(result.description).toContain('## Angebot');
    expect(result.requirements).toEqual([
      'Ausbildung im Bereich Tourismus',
      'Erfahrung im Projektmanagement',
    ]);
  });
});
