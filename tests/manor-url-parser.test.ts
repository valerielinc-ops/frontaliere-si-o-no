import { describe, expect, it } from 'vitest';
import {
  buildManorJobDescriptions,
  dedupeManorReposts,
  extractCityFromUrl,
  extractTitleFromUrl,
  parseJobPage,
  readManorDescriptionLang,
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

  it('keeps a short portal body ahead of the store context instead of replacing it', () => {
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
    });

    for (const locale of ['it', 'en', 'de', 'fr']) {
      expect(built.descriptionByLocale[locale]).toMatch(/^Muss englisch verstehen und sprechen können\s+Flexibel einsetzbar\n\n/);
    }
    expect(built.descriptionByLocale.it).toContain('presso Manor, con sede a Luzern');
    expect(built.descriptionByLocale.de).toContain('bei Manor, gelegen in Luzern');
    expect(built.description).toBe(built.descriptionByLocale.it);
  });

  it('does not carry a portal placeholder such as "Voir JD" into the description', () => {
    const built = buildManorJobDescriptions({
      title: 'Head of Retail Media 100%',
      city: 'Basel',
      canton: 'BS',
      pageDescription: 'Voir JD',
      pageLang: 'fr',
    });

    expect(built.description).not.toContain('Voir JD');
    expect(built.description).toMatch(/^Head of Retail Media 100% presso Manor/);
  });

  it('publishes a substantial body in its own language slot, not the generic paragraph', () => {
    const body = 'Sens de l’accueil, rigueur dans les encaissements, rapidité, esprit d’équipe et disponibilité durant la période des fêtes.';
    const built = buildManorJobDescriptions({
      title: 'Collaborateur/trice caisse (Parfumerie) 100%',
      city: 'Fribourg',
      canton: 'FR',
      pageDescription: body,
      pageLang: 'fr',
    });

    expect(built.sourceLang).toBe('fr');
    expect(built.descriptionByLocale.fr).toBe(body);
    expect(built.descriptionByLocale.it).toBe(body);
    expect(built.descriptionByLocale.en).toContain('at Manor, located in Fribourg');
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
