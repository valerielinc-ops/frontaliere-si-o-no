import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildManorCompanyContext,
  buildManorJobDescriptions,
  dedupeManorReposts,
  MANOR_CAREERS_SOURCES,
  MANOR_FABRICATED_DESCRIPTION_RE,
  parseManorCareersBenefits,
  parseManorCareersLead,
  prepareManorSourceBody,
  stripStaleManorLocaleSlots,
  detectManorEmploymentType,
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
import { dropFabricatedDescriptions } from '../scripts/lib/drop-fabricated-description.mjs';
import { sourceBodyWordCount } from '../scripts/lib/source-body-floor.mjs';

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

  it('publishes a short portal body together with the official Manor careers block', () => {
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
    expect(built.description).toBe(`${parsed.description}\n\n${careersContext('de')}`);
    expect(built.descriptionByLocale).toEqual({ de: built.description });
    expect(built.companyContext).toBe('careers');
  });

  it('does not replace a placeholder with a generic company paragraph', () => {
    const built = buildManorJobDescriptions({
      title: 'Head of Retail Media 100%',
      city: 'Basel',
      canton: 'BS',
      pageDescription: 'Voir JD',
      pageLang: 'fr',
      companyContexts: {},
    });

    expect(built.description).toBe('');
    expect(built.companyContext).toBe('none');
    expect(built.descriptionByLocale).toEqual({});
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
    expect(MANOR_CAREERS_SOURCES.de.benefitsUrl).toBe('https://careers.manor.ch/de/ueber-manor/benefits/');
    expect(buildManorCompanyContext('de', { lead: '', benefits: null })).toBe('');
  });

  it('drops stale slots written by earlier runs: a non-Italian `it` copy and the generic paragraph', () => {
    // Shape of the Fribourg caisse record (1369579555) in the 2026-09-29 slice.
    const body = 'Sens de l’accueil, rigueur dans les encaissements, rapidité, esprit d’équipe et disponibilité durant la période des fêtes.';
    const generic = {
      it: "Mitarbeiter*in Verkauf 40% presso Manor, con sede a Fribourg, Canton Freiburg, Svizzera. Manor è una delle principali catene di grandi magazzini svizzere, con una vasta gamma di prodotti tra cui moda, bellezza, casa, alimentari e ristoranti Manora. Questa posizione offre l'opportunità di lavorare in un ambiente dinamico e orientato al cliente.",
      en: 'Mitarbeiter*in Verkauf 40% at Manor, located in Fribourg, Canton of Fribourg, Switzerland. Manor is one of Switzerland\'s leading department store chains, offering a wide range of products including fashion, beauty, home, food, and Manora restaurants. This position offers the opportunity to work in a dynamic, customer-oriented environment.',
      de: 'Mitarbeiter*in Verkauf 40% bei Manor, gelegen in Fribourg, Kanton Freiburg, Schweiz. Manor ist eine der führenden Warenhausgruppen der Schweiz mit einem vielfältigen Angebot in den Bereichen Mode, Beauty, Home, Food und Manora-Restaurants. Diese Stelle bietet die Möglichkeit, in einem dynamischen und kundenorientierten Umfeld zu arbeiten.',
    };
    const stale = {
      sourceLang: 'fr',
      description: body,
      descriptionByLocale: {
        it: `## Collaborateur/trice caisse (Parfumerie) 100%\n\n**Manor AG** — Fribourg (FR)\n\n${body}\n\n${generic.it}`,
        en: generic.en,
        de: generic.de,
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

  it('drops placeholder source text but keeps the official block, and keeps short requirements', () => {
    for (const placeholder of ['-', 'Keine', 'Nessuno', 'Aucune', 'Voir JD', 'selon profil du rôle.', 'voire profil de rôle', 'gemäss Rollenprofil', 'già menzionato sopra']) {
      const built = buildManorJobDescriptions({ title: 'T', city: 'Genève', canton: 'GE', pageDescription: placeholder, pageLang: 'fr', companyContexts: { fr: careersContext('fr') } });
      expect(built.body).toBe('');
      expect(built.description).toContain('## À propos de Manor');
      expect(built.descriptionByLocale).toEqual({ fr: built.description });
    }
    for (const requirement of ['Deutschkenntnisse', 'Flexibilität, Verkaufstalent', 'Kasse']) {
      const built = buildManorJobDescriptions({ title: 'T', city: 'Chur', canton: 'GR', pageDescription: requirement, pageLang: 'de', companyContexts: { de: careersContext('de') } });
      expect(built.body).toBe(requirement);
      expect(built.description).toContain(requirement);
      expect(built.description).toContain('## Über Manor');
    }
  });

  it('does not use the 50-word source floor to quarantine Manor jobs', () => {
    const body = (count: number) => Array.from({ length: count }, (_, index) => `Aufgabe${index + 1}`).join(' ');
    const thin = buildManorJobDescriptions({ pageDescription: body(35), pageLang: 'de', companyContexts: { de: careersContext('de') } });
    const thinWithoutContext = buildManorJobDescriptions({ pageDescription: body(35), pageLang: 'de' });
    const rich = buildManorJobDescriptions({ pageDescription: body(60), pageLang: 'de' });

    expect(thin.description).toBe(`${body(35)}\n\n${careersContext('de')}`);
    expect(thin.descriptionByLocale).toEqual({ de: thin.description });
    expect(thinWithoutContext.description).toBe(body(35));
    expect(thinWithoutContext.descriptionByLocale).toEqual({ de: body(35) });
    expect(rich.description).toBe(body(60));
    expect(rich.descriptionByLocale).toEqual({ de: body(60) });

    const stored = prepareManorSourceBody({
      sourceLang: 'de',
      description: 'Kurzer Quelltext',
      descriptionByLocale: { de: 'Kurzer Quelltext' },
    });
    expect(stored.description).toBe('Kurzer Quelltext');
    expect(stored.descriptionByLocale).toEqual({ de: 'Kurzer Quelltext' });
  });

  it('keeps the careers block and removes only a placeholder before it', () => {
    const body = (count: number) => Array.from({ length: count }, (_, index) => `Mansione${index + 1}`).join(' ');
    const careersBlock = careersContext('de');
    const thinWithContext = prepareManorSourceBody({
      sourceLang: 'de',
      descriptionByLocale: { de: `${body(35)}\n\n${careersBlock}` },
    });
    expect(thinWithContext.description).toBe(`${body(35)}\n\n${careersBlock}`);
    expect(thinWithContext.descriptionByLocale).toEqual({ de: thinWithContext.description });

    const richBody = body(60);
    const rich = prepareManorSourceBody({
      sourceLang: 'it',
      descriptionByLocale: { it: richBody },
    });
    expect(rich.description).toBe(richBody);
    expect(rich.descriptionByLocale).toEqual({ it: richBody });

    const richWithContext = prepareManorSourceBody({
      sourceLang: 'de',
      descriptionByLocale: { de: `${richBody}\n\n${careersBlock}` },
    });
    expect(richWithContext.description).toBe(`${richBody}\n\n${careersBlock}`);
    expect(richWithContext.descriptionByLocale).toEqual({ de: richWithContext.description });

    const placeholderWithContext = prepareManorSourceBody({
      sourceLang: 'de',
      descriptionByLocale: { de: `Keine\n\n${careersBlock}` },
    });
    expect(placeholderWithContext.description).toBe(careersBlock);
    expect(placeholderWithContext.description).not.toContain('Keine');

    const sourceHeadingOnly = prepareManorSourceBody({
      sourceLang: 'de',
      descriptionByLocale: { de: `${body(60)}\n\n## Über Manor\nQuelle della posizione.` },
    });
    expect(sourceHeadingOnly.description).toContain('## Über Manor');
  });

  it('removes the complete synthetic paragraph without removing real source text', () => {
    const fabricated = "Mitarbeiter*in Verkauf Herrenkonfektion 30% presso Manor, con sede a Pfäffikon, Canton Zurigo, Svizzera. Manor è una delle principali catene di grandi magazzini svizzere, con una vasta gamma di prodotti tra cui moda, bellezza, casa, alimentari e ristoranti Manora. Questa posizione offre l'opportunità di lavorare in un ambiente dinamico e orientato al cliente.";
    expect(MANOR_FABRICATED_DESCRIPTION_RE.test(fabricated)).toBe(true);
    const source = 'Du sprichts fliessend Deutsch';
    const job = {
      sourceLang: 'de',
      description: `${source}\n\n${fabricated}`,
      descriptionByLocale: { de: `${source}\n\n${fabricated}`, it: fabricated },
    };
    const prepared = prepareManorSourceBody(job);
    dropFabricatedDescriptions([prepared], MANOR_FABRICATED_DESCRIPTION_RE, 'Manor AG');
    expect(prepared.description).toBe(source);
    expect(prepared.descriptionByLocale).toEqual({ de: source });
  });

  it('derives the scalar employment type from the title percentage', () => {
    expect(detectManorEmploymentType('Mitarbeiter*in Kasse 100%')).toBe('FULL_TIME');
    expect(detectManorEmploymentType('Mitarbeiter*in Kasse 30%')).toBe('PART_TIME');
    expect(detectManorEmploymentType('Mitarbeiter*in Kasse 20–50%')).toBe('PART_TIME');
    // The JobPosting schema in this repository accepts one enum string, not an
    // array; an interval containing 100% is conservatively full time.
    expect(detectManorEmploymentType('Mitarbeiter*in Kasse 80-100%')).toBe('FULL_TIME');
    expect(detectManorEmploymentType('Head of Retail Media')).toBe('FULL_TIME');
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
    expect(en.description).toMatch(/^- Minimum of 5 years' experience in a similar senior buying role/);
    expect(en.description).toBe(de.description);
  });

  it('reads the complete nested source body and keeps HTML lists as dash bullets', () => {
    const html = readFileSync(new URL('./fixtures/manor-job-nested-description.html', import.meta.url), 'utf8');
    const parsed = parseJobPage(html, BIEL_URL);

    expect(parsed.description).toContain('Du berätst unsere Kundinnen und Kunden mit Freude.');
    expect(parsed.description).toContain('DEINE AUFGABEN');
    expect(parsed.description).toContain('- Du betreust die Verkaufsfläche.');
    expect(parsed.description).toContain('DEIN PROFIL');
    expect(parsed.description).toContain('- Du bist zuverlässig und flexibel.');
    expect(parsed.description.indexOf('DEINE AUFGABEN')).toBeLessThan(parsed.description.indexOf('DEIN PROFIL'));
    expect(sourceBodyWordCount(parsed.description) + sourceBodyWordCount(parsed.title)).toBe(29);
  });

  it('does not treat a data-class attribute as the vacancy body class', () => {
    const html = '<meta property="og:title" content="Buyer" />'
      + '<span itemprop="description"><span data-class="jobdescription">wrong</span></span>';
    expect(parseJobPage(html, BIEL_URL).description).toBe('');
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
