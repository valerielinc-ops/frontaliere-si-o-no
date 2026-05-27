import { describe, expect, it } from 'vitest';
import {
  parseRuagListingLinks,
  parseRuagJobDetail,
  isRuagTargetLocation,
  inferRuagCanton,
} from '../scripts/lib/ruag-job-parser.mjs';

describe('ruag-job-parser', () => {
  it('extracts official job links from listing-like html', () => {
    const html = `
      <a href="https://jobs.ruag.ch/offene-stellen/facility-office-manager/49bf3704-581a-43a6-a61b-e6995907530a">One</a>
      <a href="https://jobs.ruag.ch/posizioni-aperte/apprendista-polimeccanico-a-afc-2026/8719425f-0598-427b-94ec-9d6a1189fe64">Two</a>
    `;
    expect(parseRuagListingLinks(html)).toEqual([
      'https://jobs.ruag.ch/offene-stellen/facility-office-manager/49bf3704-581a-43a6-a61b-e6995907530a',
      'https://jobs.ruag.ch/posizioni-aperte/apprendista-polimeccanico-a-afc-2026/8719425f-0598-427b-94ec-9d6a1189fe64',
    ]);
  });

  it('parses a RUAG detail page and fixes location from inline script', () => {
    const html = `
      <html>
        <head>
          <title>Apprendista Polimeccanico/a AFC 2026 100% (f/m/d)</title>
          <link rel="canonical" href="https://jobs.ruag.ch/posizioni-aperte/apprendista-polimeccanico-a-afc-2026/8719" />
          <script type="application/ld+json">
            {"@context":"http://schema.org","@type":"JobPosting","title":"Apprendista Polimeccanico/a AFC 2026","datePosted":"2025-10-31","validThrough":"2053-03-16","employmentType":"FULL_TIME","hiringOrganization":{"name":"RUAG MRO Holding AG"},"jobLocation":{"@type":"Place","address":{"addressLocality":"Emmen","addressRegion":"Emmen"}},"responsibilities":"<ul><li>Lavorazione di metalli</li></ul>","qualifications":"<ul><li>Buone prestazioni in matematica</li></ul>"}
          </script>
        </head>
        <body>
          <section id="about"><div class="contentTextWrapper"><h2><b>Il tuo ambito di lavoro</b></h2><div>Presso la nostra sede di Lodrino abbiamo un posto di apprendistato libero.</div></div></section>
          <section id="benefits"><div class="benefitIntroduction"><h2><b>I tuoi vantaggi</b></h2><div>Molti vantaggi.</div></div></section>
          <section id="applicationProcess"><div class="contentTextWrapper"><h2>Ecco come funziona il nostro processo di candidatura</h2><div id="applicationProcessText"><ul><li>Usa jobs.ruag.ch</li></ul></div></div></section>
          <section id="contact"><div class="contactInfoText"><div class="contactInfoName">Sonja Schwyn</div><p>Human Resources Assistant</p><a href="tel:+41584886234">+41 58 488 62 34</a></div></section>
          <a id="otherJob-0" href="https://jobs.ruag.ch/offene-stellen/facility-office-manager/49bf3704-581a-43a6-a61b-e6995907530a"></a>
          <a href="https://jobs.ruag.ch/apply/ats/8719">Apply</a>
          <script>
            $('#location .placeList').html('Lodrino');
          </script>
        </body>
      </html>
    `;
    const parsed = parseRuagJobDetail(html, 'https://jobs.ruag.ch/posizioni-aperte/apprendista-polimeccanico-a-afc-2026/8719');
    expect(parsed.title).toContain('Apprendista Polimeccanico');
    expect(parsed.location).toBe('Lodrino');
    expect(parsed.canton).toBe('TI');
    expect(parsed.applyUrl).toBe('https://jobs.ruag.ch/apply/ats/8719');
    expect(parsed.similarLinks).toHaveLength(1);
    expect(parsed.description).toContain('Ambito di lavoro');
    expect(parsed.description).toContain('Responsabilita');
    expect(parsed.description).toContain('Requisiti');
  });

  it('matches Ticino and Grigioni locations', () => {
    expect(isRuagTargetLocation('Lodrino')).toBe(true);
    expect(isRuagTargetLocation('Chur')).toBe(true);
    expect(inferRuagCanton('Lodrino')).toBe('TI');
    expect(inferRuagCanton('Chur')).toBe('GR');
  });
});
