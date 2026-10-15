import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import {
  ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_CAREER_URL,
  ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_KEY,
  ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_COMPANY_NAME,
  fetchAllRohrerGartenbauUndHauswartungenJobs,
  isRohrerGartenbauUndHauswartungenJob,
  isTrustedDomain,
  parseRohrerGartenbauUndHauswartungenPage,
} from '../scripts/lib/rohrer-gartenbau-und-hauswartungen-job-parser.mjs';
import { sourceBodyWordCount } from '../scripts/lib/source-body-floor.mjs';

const NOW = new Date();

function daysAgo(days: number): Date {
  const value = new Date(NOW);
  value.setUTCDate(value.getUTCDate() - days);
  return value;
}

const PUBLISHED_AT = daysAgo(12).toISOString();

const OFFICIAL_PAGE_HTML = `
<!doctype html>
<html lang="de">
  <head>
    <meta property="article:published_time" content="${PUBLISHED_AT}">
  </head>
  <body>
    <main>
      <h1>Jobs – Werde Teil unseres Teams</h1>
      <section>
        <h2>Landschaftsgärtner/in EFZ – 100%</h2>
        <p>Du gestaltest Gärten, Wege und Aussenräume. Wir suchen eine zuverlässige Person mit Freude an abwechslungsreichen Arbeiten und praktischem Einsatz.</p>
      </section>
      <section>
        <h2>Mitarbeiter/in Flachdach-Service – 80%</h2>
        <p>Du unterstützt unser Team im Flachdach-Service und arbeitest sorgfältig, selbstständig und kundenorientiert an verschiedenen Projekten.</p>
      </section>
      <section>
        <h2>Mitarbeiter/in Treppenhausreinigung – 40%</h2>
        <p>Du arbeitest gerne selbstständig, zuverlässig und legst Wert auf Sauberkeit? Dann bist du bei uns genau richtig.</p>
        <p>Für unsere Hauswartungen suchen wir eine motivierte Persönlichkeit, die für die Reinigung und Pflege von Treppenhäusern in Wohnliegenschaften verantwortlich ist.</p>
        <ul>
          <li>Reinigung und Pflege von Treppenhäusern in Wohnliegenschaften</li>
          <li>Selbstständige Planung und Ausführung der regelmässigen Arbeiten</li>
          <li>Abwechslungsreiche Einsatzorte in Obwalden</li>
          <li>Eine sorgfältige Einführung und ein kollegiales Arbeitsumfeld</li>
        </ul>
        <p>Du bringst Erfahrung in der Reinigung mit, arbeitest zuverlässig und bist freundlich im Umgang mit Kundinnen und Kunden. Wir freuen uns auf deine Bewerbung.</p>
      </section>
    </main>
    <footer>Birkenweg 7, 6072 Sachseln – Obwalden</footer>
  </body>
</html>`;

describe('Rohrer Gartenbau und Hauswartungen GmbH crawler', () => {
  it('keeps the official source contract in the promoted spec', () => {
    const spec = JSON.parse(fs.readFileSync(
      'data/prospector/crawlers/rohrer-gartenbau-und-hauswartungen.json',
      'utf8',
    ));
    expect(spec.companyKey).toBe(ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_KEY);
    expect(spec.companyHost).toBe('rohrer-gartenbau.ch');
    expect(spec.seedUrls).toEqual([ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_CAREER_URL]);
    expect(spec.listingCandidateText).toBe('Treppenhausreinigung');
    expect(spec.canton).toBe('OW');
    expect(spec.sampleVacancyCount).toBe(1);
  });

  it('extracts only the source-backed cleaning vacancy from the inline page', () => {
    const parsed = parseRohrerGartenbauUndHauswartungenPage(
      OFFICIAL_PAGE_HTML,
      ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_CAREER_URL,
      { now: NOW },
    );
    expect(parsed.discoveredCount).toBe(3);
    expect(parsed.fetchOutcome).toBe('ok');
    expect(parsed.listings).toHaveLength(1);
    expect(parsed.listings[0]).toMatchObject({
      title: 'Mitarbeiter/in Treppenhausreinigung – 40%',
      location: 'Obwalden',
      canton: 'OW',
      addressRegion: 'OW',
      employmentType: 'PART_TIME',
      datePosted: PUBLISHED_AT,
      postingDateSource: 'reported',
    });
    expect(sourceBodyWordCount(parsed.listings[0].description)).toBeGreaterThanOrEqual(50);
    expect(parsed.listings[0].url).toBe(
      `${ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_CAREER_URL}#mitarbeiter-in-treppenhausreinigung-40`,
    );
  });

  it('builds a stable source-locale job through the standard fetch entry point', async () => {
    const jobs = await fetchAllRohrerGartenbauUndHauswartungenJobs({
      now: NOW,
      fetchHtmlImpl: async () => OFFICIAL_PAGE_HTML,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs.discoveredCount).toBe(3);
    expect(jobs.fetchOutcome).toBe('ok');
    expect(jobs[0]).toMatchObject({
      company: ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_COMPANY_NAME,
      companyKey: ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_KEY,
      sourceLang: 'de',
      canton: 'OW',
      employmentType: 'PART_TIME',
      category: 'Pulizie',
      postingDateSource: 'reported',
    });
    expect(jobs[0].id).toMatch(/^rohrer-gartenbau-und-hauswartungen-[a-f0-9]{12}$/);
    expect(jobs[0].description).toContain('Treppenhäusern');
  });

  it('reports selector drift when no role heading is present', () => {
    const parsed = parseRohrerGartenbauUndHauswartungenPage(
      '<main><h1>Jobs</h1><p>Keine Stellenangebote</p></main>',
      ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_CAREER_URL,
      { now: NOW },
    );
    expect(parsed.listings).toHaveLength(0);
    expect(parsed.fetchOutcome).toBe('selector_miss');
  });

  it('does not publish a cleaning heading without source-backed OW body evidence', () => {
    const parsed = parseRohrerGartenbauUndHauswartungenPage(
      '<main><h2>Mitarbeiter/in Treppenhausreinigung – 40%</h2><p>Reinigung und Pflege von Treppenhäusern in Wohnliegenschaften.</p></main>',
      ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_CAREER_URL,
      { now: NOW },
    );
    expect(parsed.listings).toHaveLength(0);
    expect(parsed.fetchOutcome).toBe('selector_miss');
  });

  it('requires positive workplace context for an Obwalden mention', () => {
    const body = [
      'Diese ausgeschriebene Tätigkeit umfasst sorgfältige Reinigungsarbeiten in verschiedenen Liegenschaften und verlangt Selbstständigkeit, Zuverlässigkeit, Diskretion, Ausdauer und einen freundlichen Umgang mit Kundinnen und Kunden.',
      'Die regelmässigen Einsätze werden geplant, dokumentiert und kontrolliert, jedoch ausdrücklich nicht in Obwalden angeboten.',
      'Gesucht wird eine belastbare Person, die Arbeitszeiten einhält, Material sorgfältig verwendet und Rückmeldungen aus dem Team zuverlässig umsetzt.',
    ].join(' ');
    expect(sourceBodyWordCount(body)).toBeGreaterThanOrEqual(50);
    const parsed = parseRohrerGartenbauUndHauswartungenPage(
      `<main><h2>Mitarbeiter/in Treppenhausreinigung – 40%</h2><p>${body}</p></main>`,
      ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_CAREER_URL,
      { now: NOW },
    );
    expect(parsed.listings).toHaveLength(0);
  });

  it('ends a cleaning section at an unlisted vacancy heading', () => {
    const cleaningBody = [
      'Diese Reinigungsstelle umfasst die sorgfältige Pflege von Treppenhäusern in Wohnliegenschaften und verlangt eine zuverlässige, selbstständige und freundliche Arbeitsweise.',
      'Die Aufgaben werden im Team besprochen, nach Plan ausgeführt und mit der zuständigen Hauswartung abgestimmt, ohne dass eine Ortsangabe für Obwalden gemacht wird.',
      'Sicherheitsvorgaben, Qualitätskontrollen und eine klare Dokumentation gehören ebenfalls zum täglichen Ablauf dieser Tätigkeit.',
    ].join(' ');
    const unrelatedBody = [
      'Die Hauswartung betreut verschiedene Anlagen, organisiert Kontrollgänge, koordiniert Reparaturen und dokumentiert die erledigten Arbeiten für die Eigentümerschaft.',
      'Für diese andere Tätigkeit werden Einsätze in Obwalden beschrieben, ausserdem gehören Materialbestellungen, Winterdienst, kleinere Pflegearbeiten und die Kommunikation mit externen Partnern zum Aufgabenbereich.',
      'Der Tagesablauf umfasst zudem Abnahmen, Schlüsselverwaltung, Bereitschaftsdienste und die Meldung von Schäden an die zuständige Verwaltung.',
    ].join(' ');
    expect(sourceBodyWordCount(cleaningBody)).toBeGreaterThanOrEqual(50);
    expect(sourceBodyWordCount(unrelatedBody)).toBeGreaterThanOrEqual(50);
    const parsed = parseRohrerGartenbauUndHauswartungenPage(
      `<main><h2>Mitarbeiter/in Treppenhausreinigung – 40%</h2><p>${cleaningBody}</p><h2>Hauswartung</h2><p>${unrelatedBody}</p></main>`,
      ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_CAREER_URL,
      { now: NOW },
    );
    expect(parsed.listings).toHaveLength(0);
  });

  it('keeps publication date unknown when the official page supplies no date', () => {
    const parsed = parseRohrerGartenbauUndHauswartungenPage(
      OFFICIAL_PAGE_HTML.replace(/\s*<meta property="article:published_time"[^>]+>/, ''),
      ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_CAREER_URL,
      { now: NOW },
    );
    expect(parsed.listings[0]).toMatchObject({
      datePosted: '',
      postedDate: '',
      postingDateSource: 'unknown',
    });
  });

  it('distinguishes a readable page with only non-target roles as filtered-empty', () => {
    const parsed = parseRohrerGartenbauUndHauswartungenPage(
      '<main><h2>Landschaftsgärtner/in EFZ – 100%</h2><p>Arbeiten im Gartenbau und in der Pflege von Aussenanlagen.</p></main>',
      ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_CAREER_URL,
      { now: NOW },
    );
    expect(parsed.listings).toHaveLength(0);
    expect(parsed.fetchOutcome).toBe('filtered_empty');
  });

  it('matches company identity but rejects unrelated domains and protocols', () => {
    expect(isRohrerGartenbauUndHauswartungenJob({ companyKey: ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_KEY })).toBe(true);
    expect(isRohrerGartenbauUndHauswartungenJob({ company: ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_COMPANY_NAME })).toBe(true);
    expect(isRohrerGartenbauUndHauswartungenJob({ url: ROHRER_GARTENBAU_UND_HAUSWARTUNGEN_CAREER_URL })).toBe(true);
    expect(isRohrerGartenbauUndHauswartungenJob({ url: 'https://other.example/jobs/1' })).toBe(false);
    expect(isTrustedDomain('https://careers.rohrer-gartenbau.ch/jobs/')).toBe(true);
    expect(isTrustedDomain('http://rohrer-gartenbau.ch/unternehmen/jobs/')).toBe(false);
    expect(isTrustedDomain('https://rohrer-gartenbau.ch.evil.example/jobs/')).toBe(false);
  });
});
