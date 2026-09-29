import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildManorCompanyContext,
  buildManorJobDescriptions,
  dedupeManorReposts,
  MANOR_CAREERS_SOURCES,
  parseManorCareersBenefits,
  parseManorCareersLead,
  stripStaleManorLocaleSlots,
  extractCityFromUrl,
  extractTitleFromUrl,
  parseJobPage,
  parseSitemapUrls,
  readManorDescriptionLang,
  resolveManorBodyLang,
  resolveManorLocation,
  stripSiteTitleSuffix,
} from '../scripts/update-manor-jobs.mjs';
import { normalizeKey } from '../scripts/lib/dedicated-crawler-common.mjs';

const BIEL_JOB_ID = '1364490355';
const BIEL_URL = `https://positions.manor.ch/job/Biel-Mitarbeiterin-Visual-Merchandising-80/${BIEL_JOB_ID}/`;
const BIEL_PREVIOUS_SLUG =
  'manor-mitarbeiter-in-visual-merchandising-80-biel-mitarbeiterin-visual-merchandising';
const BIEL_REGRESSION_FIXTURE = {
  page: `
    <meta property="og:title" content="Mitarbeiter*in Visual Merchandising 80%" />
    <meta itemprop="streetAddress" content="Biel" />
  `,
  titleByLocale: { it: 'Collaboratore/trice*in Visual Merchandising 80%' },
  previousSlugs: [BIEL_PREVIOUS_SLUG],
};
const RICKENBACH_URL =
  'https://positions.manor.ch/job/Rickenbach-b_-Wil-Mitarbeiterin-Verkauf-Fashion-40/1364892555/';

describe('Manor jobs2web URL and title parsing', () => {
  it('keeps title words out of the city prefix used by the URL fallback', () => {
    expect(extractCityFromUrl(BIEL_URL)).toEqual({ city: 'Biel', segments: 1 });
    expect(extractTitleFromUrl(BIEL_URL)).toBe('Mitarbeiterin Visual Merchandising 80');
  });

  it('keeps the documented Manor locality alias without reopening fuzzy prefix matching', () => {
    expect(extractCityFromUrl(RICKENBACH_URL)).toEqual({
      city: 'Rickenbach b. Wil',
      segments: 3,
    });
    expect(extractTitleFromUrl(RICKENBACH_URL)).toBe('Mitarbeiterin Verkauf Fashion 40');
  });

  it('uses the canonical og:title when the current template has no itemprop title', () => {
    const page = `
      <meta property="og:title" content="Mitarbeiter*in Visual Merchandising 80%" />
      <div class="jobTitle"><span>80</span></div>
    `;

    expect(parseJobPage(page, BIEL_URL).title).toBe(
      'Mitarbeiter*in Visual Merchandising 80%',
    );
  });

  it('keeps the portal city out of streetAddress when SuccessFactors combines it with CH', () => {
    const page = `
      <meta property="og:title" content="Collaborateur/trice service 50%" />
      <meta itemprop="streetAddress" content="Chavannes-de-Bogis, CH" />
      <meta itemprop="datePosted" content="Mon Aug 24 00:00:00 UTC 2026" />
    `;

    expect(parseJobPage(page, BIEL_URL)).toMatchObject({
      location: 'Chavannes-de-Bogis',
      streetAddress: '',
      postalCode: '',
      addressRegion: '',
    });
  });

  it('keeps emitted locality and canton aligned with the detail page source', () => {
    expect(resolveManorLocation({ addressLocality: 'Zürich', addressRegion: 'ZH' }, 'Zürich')).toEqual({
      location: 'Zürich',
      canton: 'ZH',
    });
  });

  it('rejects a detail locality from another canton instead of mixing address fields', () => {
    expect(resolveManorLocation({ addressLocality: 'Zürich', addressRegion: 'ZH' }, 'Lugano')).toBeNull();
    expect(resolveManorLocation({ addressLocality: 'Lugano', addressRegion: 'ZH' }, 'Lugano')).toBeNull();
  });

  it('rejects an explicit detail region that is not a Swiss canton', () => {
    expect(resolveManorLocation({ addressLocality: 'Lugano', addressRegion: 'Ontario' }, 'Lugano')).toBeNull();
  });

  it('does not treat an explicit unknown detail region as missing', () => {
    expect(resolveManorLocation({ addressLocality: 'Lugano', addressRegion: 'N/A' }, 'Lugano')).toBeNull();
  });

  it('does not infer a Swiss canton from a foreign region containing a Swiss token', () => {
    expect(resolveManorLocation({ addressLocality: 'Como', addressRegion: 'Como, TI' }, 'Como')).toBeNull();
  });

  it('rejects a foreign border locality in an explicit detail region', () => {
    expect(resolveManorLocation({ addressLocality: 'Como', addressRegion: 'Como' }, 'Como')).toBeNull();
  });

  it('removes the site suffix while preserving the role title', () => {
    expect(stripSiteTitleSuffix('Verkäufer*in 60% | Manor')).toBe('Verkäufer*in 60%');
    expect(stripSiteTitleSuffix('Verkäufer*in 60% - Manor AG')).toBe('Verkäufer*in 60%');
    expect(stripSiteTitleSuffix('Empfangsmitarbeiter/in 50% | Ferienvertretung 100%')).toBe('Empfangsmitarbeiter/in 50% | Ferienvertretung 100%');
    expect(stripSiteTitleSuffix('Mitarbeiter*in Verkauf - 60%')).toBe('Mitarbeiter*in Verkauf - 60%');
  });

  it('strips only the site suffix from a title that also has an internal pipe', () => {
    expect(stripSiteTitleSuffix('Empfangsmitarbeiter/in 50% | Ferienvertretung 100% | Manor')).toBe(
      'Empfangsmitarbeiter/in 50% | Ferienvertretung 100%',
    );
  });

  it('strips the site suffix from canonical og:title before falling back', () => {
    const page = '<meta property="og:title" content="Senior Verkäufer*in 60% | Manor" />';

    expect(parseJobPage(page, BIEL_URL).title).toBe('Senior Verkäufer*in 60%');
  });

  it('keeps the legacy itemprop title fallback for older templates', () => {
    const page = '<div itemprop="title">Senior Verkäufer*in 60%</div>';

    expect(parseJobPage(page, BIEL_URL).title).toBe('Senior Verkäufer*in 60%');
  });

  it('does not reintroduce the persisted short-title record that blocked the deploy gate', () => {
    // This is the exact page/URL fixture from #8232. The live Manor listing
    // may expire the posting, but the parser regression must remain testable.
    const parsed = parseJobPage(BIEL_REGRESSION_FIXTURE.page, BIEL_URL);
    const { city } = extractCityFromUrl(BIEL_URL);
    const job = {
      title: parsed.title,
      location: city,
      titleByLocale: BIEL_REGRESSION_FIXTURE.titleByLocale,
      slug: normalizeKey(`manor ${parsed.title} ${city}`),
      previousSlugs: BIEL_REGRESSION_FIXTURE.previousSlugs,
    };

    expect(job).toMatchObject({
      title: 'Mitarbeiter*in Visual Merchandising 80%',
      location: 'Biel',
      titleByLocale: { it: 'Collaboratore/trice*in Visual Merchandising 80%' },
    });
    expect([job.slug, ...(job.previousSlugs || [])]).toContain(
      BIEL_PREVIOUS_SLUG,
    );
  });
});

// Minimized from the live jobs2web detail pages (2026-09-29): the vacancy body
// is the `jobdescription` span, its language the `lang` of the itemprop span.
function manorDetailPage({ title, lang, body }: { title: string; lang: string; body: string }) {
  return `
    <meta property="og:title" content="${title}" />
    <span xml:lang="${lang}" lang="${lang}" itemprop="description" data-careersite-propertyid="description" class="rtltextaligneligible">
                <span class="jobdescription">${body}
                </span>
    </span>
  `;
}

// Pinned careers.manor.ch pages (landing lead + benefits), minimized 2026-09-29.
function careersFixture(lang: 'de' | 'fr') {
  const html = readFileSync(new URL(`./fixtures/manor-careers-${lang}.html`, import.meta.url), 'utf8');
  return html.split('<!-- benefits -->') as [string, string];
}

function careersContext(lang: 'de' | 'fr') {
  const [landing, benefits] = careersFixture(lang);
  return buildManorCompanyContext(lang, {
    lead: parseManorCareersLead(landing),
    benefits: parseManorCareersBenefits(benefits),
  });
}

describe('Manor vacancy body and reposts (audit-parser-quality issue 5253)', () => {
  it('keeps an apostrophe inside a double-quoted og:title instead of cutting the role there', () => {
    const page = manorDetailPage({
      title: "Buyer (Women's Fashion) 100%",
      lang: 'fr-FR',
      body: "• Minimum of 5 years' experience in a similar senior buying role, preferably within womenswear.",
    });

    expect(parseJobPage(page, BIEL_URL).title).toBe("Buyer (Women's Fashion) 100%");
    expect(readManorDescriptionLang(page)).toBe('fr');
  });

  it('keeps a short portal body and follows it with Manor careers text, in the source slot only', () => {
    const page = manorDetailPage({
      title: 'Mitarbeiter*in Verkauf 40%',
      lang: 'de-DE',
      body: 'Muss englisch verstehen und sprechen können \nFlexibel einsetzbar',
    });
    const parsed = parseJobPage(page, BIEL_URL);
    const built = buildManorJobDescriptions({
      title: parsed.title,
      city: 'Luzern',
      canton: 'LU',
      pageDescription: parsed.description,
      pageLang: parsed.descriptionLang,
      companyContexts: { de: careersContext('de') },
    });

    expect(built.sourceLang).toBe('de');
    expect(Object.keys(built.descriptionByLocale)).toEqual(['de']);
    expect(built.description).toBe(built.descriptionByLocale.de);
    expect(built.description).toMatch(/^Muss englisch verstehen und sprechen können\s+Flexibel einsetzbar\n\n## Über Manor\n/);
    expect(built.description).toContain('- Mindestlohn von CHF 4\'200');
    expect(built.description).not.toMatch(/presso Manor|bei Manor, gelegen in/);
    expect(built.companyContext).toBe('careers');
    expect((built.description.match(/\p{L}+/gu) || []).length).toBeGreaterThanOrEqual(50);
  });

  it('falls back to the generic paragraph only as a separate block of the source language', () => {
    const built = buildManorJobDescriptions({
      title: 'Head of Retail Media 100%',
      city: 'Basel',
      canton: 'BS',
      pageDescription: 'Voir JD',
      pageLang: 'fr',
      companyContexts: {},
    });

    expect(built.description).not.toContain('Voir JD');
    expect(built.companyContext).toBe('fallback');
    expect(built.descriptionByLocale).toEqual({ fr: built.description });
    expect(built.description).toMatch(/^## À propos de Manor\nHead of Retail Media 100% chez Manor, situé à Basel/);
  });

  it('publishes a substantial body in its own language slot and leaves every other slot to translation', () => {
    const body = [
      'Kernaufgaben:',
      '70% MANAGEMENT-Kernaufgaben:',
      '• Ganzheitliche Betreuung betrieblicher Projekte FM Hauptsitz, Warenhäuser und Verteilzentralen',
      '• Betreuung und laufende Optimierung betrieblicher Prozesse FM',
      '20% STRATEGISCHE-Kernaufgaben:',
      '• Einleiten von betriebsoptimierenden Änderungen. (Innovation)',
      '10% ADMINISTRATIVE-Kernaufgaben:',
      '• Terminkoordination und Sitzungskoordination mit Vertragsfirmen, Protokollführung, Mithilfe bei Planung von internen Anlässen, Erstellung Organigramm, Administrative Unterstützung im Team FM BAZ. Zentralisierung und Vereinheitlichung der administrativen Tätigkeiten.',
      'IT Affinität wird vorausgesetzt.',
    ].join('\n');
    // The portal tagged this German body `it-IT` (Basel FM project lead, 1364514655).
    const built = buildManorJobDescriptions({
      title: 'Projektleiter Facility Management 100%',
      city: 'Basel',
      canton: 'BS',
      pageDescription: body,
      pageLang: 'it',
      companyContexts: { de: careersContext('de') },
    });

    expect(built.sourceLang).toBe('de');
    expect(built.descriptionByLocale).toEqual({ de: body });
    expect(built.description).toBe(body);
    expect(built.companyContext).toBe('none');
  });

  it('parses the Manor careers lead and benefit groups in the page language', () => {
    for (const lang of ['de', 'fr'] as const) {
      const [landing, benefits] = careersFixture(lang);
      expect(parseManorCareersLead(landing)).toMatch(lang === 'de'
        ? /^Was wir unseren Kundinnen und Kunden versprechen, .* Hauptsitz in Basel\.$/
        : /^Ce que nous promettons à nos clientes et clients .* siège principale à Bâle\.$/);
      const parsed = parseManorCareersBenefits(benefits);
      expect(parsed.heading).toBe(lang === 'de' ? 'Deine Benefits bei Manor' : 'Tes avantages chez Manor');
      expect(parsed.groups[0].title).toBe(lang === 'de' ? 'ANSTELLUNGSBEDINGUNGEN' : 'CONDITIONS D’EMPLOI');
      expect(parsed.groups[0].rows[0]).toBe(lang === 'de' ? "Mindestlohn von CHF 4'200" : "Salaire minimum de CHF 4'200");
    }
    expect(MANOR_CAREERS_SOURCES.de.benefitsUrl).toBe('https://careers.manor.ch/de/ueber-manor/benefits');
    expect(buildManorCompanyContext('de', { lead: '', benefits: null })).toBe('');
  });

  it('drops stale slots written by earlier runs: a non-Italian `it` copy and the generic paragraph', () => {
    // Shape of the Fribourg caisse record (1369579555) in the 2026-09-29 slice.
    const body = 'Sens de l’accueil, rigueur dans les encaissements, rapidité, esprit d’équipe et disponibilité durant la période des fêtes.';
    const stale = {
      sourceLang: 'fr',
      description: body,
      descriptionByLocale: {
        it: `## Collaborateur/trice caisse (Parfumerie) 100%\n\n**Manor AG** — Fribourg (FR)\n\n${body}\n\nManor AG è una delle principali catene di grandi magazzini in Svizzera, con attività nei settori moda, beauty, casa, food e ristorazione Manora.`,
        en: 'Collaborateur/trice caisse (Parfumerie) 100% at Manor, located in Fribourg, Canton of Fribourg, Switzerland.',
        de: 'Collaborateur/trice caisse (Parfumerie) 100% bei Manor, gelegen in Fribourg, Kanton Freiburg, Schweiz.',
        fr: body,
      },
    };
    const cleaned = stripStaleManorLocaleSlots(stale);
    expect(cleaned.descriptionByLocale).toEqual({ fr: body });
    expect(cleaned.needsRetranslation).toBe(true);

    const germanCopy = { sourceLang: 'de', descriptionByLocale: { it: 'Muss Spielsachen lieben. Gerne in einem hektischen lauten Umfeld arbeiten.', de: 'Muss Spielsachen lieben. Gerne in einem hektischen lauten Umfeld arbeiten.' } };
    expect(stripStaleManorLocaleSlots(germanCopy).descriptionByLocale).toEqual({ de: germanCopy.descriptionByLocale.de });

    const translated = { sourceLang: 'de', descriptionByLocale: { de: 'Muss Spielsachen lieben.', it: 'Deve amare i giocattoli. Lavorare volentieri in un ambiente frenetico e rumoroso.' } };
    expect(stripStaleManorLocaleSlots(translated)).toBe(translated);
  });

  it('keeps short real requirements but drops bodies that only point elsewhere', () => {
    for (const placeholder of ['-', 'Voir JD', 'selon profil du rôle.', 'voire profil de rôle', 'gemäss Rollenprofil', 'già menzionato sopra']) {
      const built = buildManorJobDescriptions({ title: 'T', city: 'Genève', canton: 'GE', pageDescription: placeholder, pageLang: 'fr', companyContexts: { fr: careersContext('fr') } });
      expect(built.body).toBe('');
      expect(built.description).toMatch(/^## À propos de Manor\n/);
    }
    for (const requirement of ['Deutschkenntnisse', 'Flexibilität, Verkaufstalent', 'Kasse']) {
      const built = buildManorJobDescriptions({ title: 'T', city: 'Chur', canton: 'GR', pageDescription: requirement, pageLang: 'de', companyContexts: { de: careersContext('de') } });
      expect(built.description.startsWith(`${requirement}\n\n## Über Manor\n`)).toBe(true);
    }
  });

  it('trusts the portal language tag on short bodies and the detector only on a clear, long body', () => {
    // Trigram detection reads this French requirement list as English.
    expect(resolveManorBodyLang('Langue française et/ou allemande, flexibilité horaire', 'fr')).toBe('fr');
    expect(resolveManorBodyLang('Kasse', 'de')).toBe('de');
    // Lugano Polydesigner 3D (1367443255): an Italian body tagged `fr-FR`.
    expect(resolveManorBodyLang(
      '• Passione per le esposizioni merce nel negozio\n• Resistenza fisica\n• Volontà di apprendere i sistemi digitali interni\n• Capacità di lavorare in Team',
      'fr',
    )).toBe('it');
    expect(resolveManorBodyLang('', 'it')).toBe('it');
  });

  it('collapses reposts on the vacancy body even when the portal tagged them in different languages', () => {
    const post = (id: string, lang: string) => ({
      url: `https://positions.manor.ch/job/Marin-Epagnier-Boucher%C3%A8re-70/${id}/`,
      title: 'Boucher/ère 70%',
      location: 'Marin Epagnier',
      description: `Boucher/ère\n\n## ${lang}`,
      _manorVacancyBody: 'Boucher/ère',
    });
    const { jobs, reposts } = dedupeManorReposts([post('1363511255', 'Über Manor'), post('1363511155', 'À propos de Manor')]);

    expect(jobs).toHaveLength(1);
    expect(jobs[0].url).toContain('1363511155');
    expect(jobs[0]).not.toHaveProperty('_manorVacancyBody');
    expect(reposts).toEqual([{ url: expect.stringContaining('1363511255'), keptUrl: expect.stringContaining('1363511155') }]);
  });

  it('keeps same-title openings at one store separate when neither has a source body', () => {
    const opening = (id: string, body: string) => ({
      url: `https://positions.manor.ch/job/Hochdorf-Logistikerin-EFZEBA-100/${id}/`,
      title: 'Logistiker*in EFZ/EBA 100%',
      location: 'Hochdorf',
      description: '## Über Manor\n\nManor ist die grösste Warenhausgruppe der Schweiz.',
      _manorVacancyBody: body,
    });
    const empty = dedupeManorReposts([opening('1365430055', ''), opening('1365430255', '')]);
    expect(empty.jobs).toHaveLength(2);
    expect(empty.reposts).toEqual([]);

    const identical = dedupeManorReposts([opening('1365430055', 'Körperlich fit'), opening('1365430255', 'Körperlich fit')]);
    expect(identical.jobs).toHaveLength(1);
    expect(identical.reposts).toHaveLength(1);
  });

  it('collapses one vacancy re-posted under several requisition ids, keeping the lowest id', () => {
    const repost = (id: string, description: string) => ({
      url: `https://positions.manor.ch/job/Hochdorf-Mitarbeiterin-Logistik-Kommissionierung-100/${id}/`,
      title: 'Mitarbeiter*in Logistik Kommissionierung 100%',
      location: 'Hochdorf',
      description,
    });
    const body = 'Körperlich fit\nArbeitsstart ab 06:00 Uhr\n\nMitarbeiter*in Logistik Kommissionierung 100% presso Manor';
    const { jobs, reposts } = dedupeManorReposts([
      repost('1363666255', body),
      repost('1362291455', body),
      repost('1363666055', body),
      repost('1368627455', 'Körperlich fit\nArbeitsstart ab 07:00 Uhr'),
    ]);

    expect(jobs.map((job) => job.url.match(/(\d+)\/$/)?.[1])).toEqual(['1362291455', '1368627455']);
    expect(reposts).toHaveLength(2);
    expect(reposts.every((r) => r.keptUrl.includes('1362291455'))).toBe(true);
  });
});

describe('Manor locale copies of one vacancy (audit-parser-quality issue 5253, duplicate-descriptions)', () => {
  // positions.manor.ch gives no store: the page carries "Basel, CH" only, so
  // the city is the whole site the source states. Manor publishes one
  // vacancy once per portal locale (1368279755 en-US, 1368279855 fr-FR,
  // 1368279955 de-DE for "Buyer (Women's Fashion) 100%", same body).
  const fixture = (name: string) => readFileSync(new URL(`./fixtures/manor-job-buyer-${name}-template.html`, import.meta.url), 'utf8');
  const SITEMAP = [
    "<loc>https://positions.manor.ch/job/Basel-Buyer-%28Women&apos;s-Fashion%29-100/1368279955/</loc>",
    "<loc>https://positions.manor.ch/job/Basel-Buyer-%28Women&apos;s-Fashion%29-100/1368279755/</loc>",
  ].join('\n');

  it('decodes the escaped apostrophe of the sitemap instead of publishing it in the URL', () => {
    expect(parseSitemapUrls(SITEMAP)).toEqual([
      "https://positions.manor.ch/job/Basel-Buyer-%28Women's-Fashion%29-100/1368279955/",
      "https://positions.manor.ch/job/Basel-Buyer-%28Women's-Fashion%29-100/1368279755/",
    ]);
    expect(parseSitemapUrls('<loc>https://positions.manor.ch/job/a?x=1&amp;y=2/1/</loc>')).toEqual(['https://positions.manor.ch/job/a?x=1&y=2/1/']);
  });

  it('reads the vacancy body of the English template, whose span declares itemprop before class', () => {
    const [deUrl, enUrl] = parseSitemapUrls(SITEMAP);
    const de = parseJobPage(fixture('de'), deUrl);
    const en = parseJobPage(fixture('en'), enUrl);
    expect(en.title).toBe("Buyer (Women's Fashion) 100%");
    expect(en.description).toMatch(/^• Minimum of 5 years' experience in a similar senior buying role/);
    expect(en.description).toBe(de.description);
  });

  it('collapses the locale copies once both bodies are read, keeping the lowest requisition id', () => {
    const jobs = parseSitemapUrls(SITEMAP).map((url) => {
      const page = parseJobPage(fixture(url.includes('1368279755') ? 'en' : 'de'), url);
      const built = buildManorJobDescriptions({
        title: page.title, city: 'Basel', canton: 'BS', pageDescription: page.description, pageLang: page.descriptionLang,
      });
      return { url, title: page.title, location: 'Basel', description: built.description, _manorVacancyBody: built.body };
    });
    const { jobs: unique, reposts } = dedupeManorReposts(jobs);
    expect(unique.map((job) => job.url.match(/(\d+)\/$/)?.[1])).toEqual(['1368279755']);
    expect(reposts).toEqual([{ url: expect.stringContaining('1368279955'), keptUrl: expect.stringContaining('1368279755') }]);
  });
});
