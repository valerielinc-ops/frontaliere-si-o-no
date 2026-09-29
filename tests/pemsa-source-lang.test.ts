/**
 * PEMSA — source language from the body, source text only (issue 5253).
 *
 * The 2026-09-29 slice had 19/314 jobs labelled from the TITLE
 * ("Imbianchino (M/F)" → en, "Carpentiere AFC / AEC (m/f/d)" → de) while every
 * body comes from the Italian site, and 267/314 jobs carried an invented
 * recruitment paragraph in en/de/fr. The stored record below is that
 * "Imbianchino (M/F)" job, minimized (body excerpts only).
 */
import { describe, expect, it } from 'vitest';
import {
  buildPemsaLocalizedContent,
  isPemsaInventedDescription,
  mergePemsaJobRecord,
} from '../scripts/lib/pemsa-job-parser.mjs';

const SOURCE_BODY = 'Vuoi la libertà del lavoro temporaneo e la sicurezza di un impiego fisso? Da 30 anni affianchiamo centinaia di aziende nei settori tecnici dell’edilizia, delle costruzioni e dell’industria in tutta la Svizzera, proponendo loro i migliori talenti. Non ti mentiremo però: siamo esigenti. Quindi, se sei una persona motivata ed estremamente entusiasta, unisciti al nostro team per la posizione di Imbianchino (M/F).';
const ROUND_TRIP = 'la libertà del lavoro temporaneo e la sicurezza di un impiego fisso? Da 30 anni affianchiamo di centinaia di aziende nei settori tecnici dell’edilizia, delle costruzioni e dell’industria in tutta la Svizzera, proponendo loro i migliori talenti. Non ti mentiremo però: siamo esigenti. Quindi, se sei una persona motivata ed urgente, unisciti al nostro team per la posizione di Imbianchino (M/F).';
const INVENTED_DE = 'PEMSA, eine auf Bau und Technik spezialisierte Personalvermittlung, sucht ein Profil als Imbianchino (M/F) in Biel/Bienne. PEMSA gewährleistet optimale Arbeitsbedingungen und professionelle Unterstützung. Bewirb dich über das offizielle Portal.';
const INVENTED_FR = 'PEMSA, agence de recrutement spécialisée dans le bâtiment et la technique, recherche un profil Imbianchino (M/F) à Biel/Bienne. PEMSA garantit des conditions de travail optimales et un accompagnement professionnel. Postulez via le portail officiel.';
const SLUG = 'imbianchino-m-f-pemsa-biel-bienne';

const STORED = {
  url: 'https://www.pemsa.ch/it/job/imbianchino-m-f-2697294/',
  title: 'Imbianchino (M/F)',
  location: 'Biel/Bienne',
  sourceLang: 'en',
  description: SOURCE_BODY,
  descriptionByLocale: { it: ROUND_TRIP, en: SOURCE_BODY, de: INVENTED_DE, fr: INVENTED_FR },
  titleByLocale: { it: 'Imbianchino (M/F)', en: 'Imbianchino (M/F)', de: 'Imbianchino (M/W)', fr: 'Imbianchino (H/F)' },
  slugByLocale: { it: SLUG, en: SLUG, de: SLUG, fr: SLUG },
  slug: SLUG,
};

function freshJob(description: string) {
  const localized = buildPemsaLocalizedContent({ title: STORED.title, city: STORED.location, description });
  return {
    url: STORED.url,
    title: localized.titleByLocale[localized.sourceLang],
    sourceLang: localized.sourceLang,
    description: localized.descriptionByLocale[localized.sourceLang] || '',
    titleByLocale: localized.titleByLocale,
    descriptionByLocale: localized.descriptionByLocale,
    slugByLocale: localized.slugByLocale,
  };
}

describe('buildPemsaLocalizedContent', () => {
  it('labels the Italian body it although the title reads as English, and writes only that slot', () => {
    const localized = buildPemsaLocalizedContent({ title: STORED.title, city: STORED.location, description: SOURCE_BODY });

    expect(localized.sourceLang).toBe('it');
    expect(localized.descriptionByLocale).toEqual({ it: SOURCE_BODY });
    expect(localized.titleByLocale).toEqual({ it: 'Imbianchino (M/F)' });
    expect(localized.slugByLocale).toEqual({ it: SLUG });
  });

  it('invents nothing when the body is missing', () => {
    const localized = buildPemsaLocalizedContent({ title: STORED.title, city: STORED.location, description: '' });

    expect(localized.descriptionByLocale).toEqual({});
  });

  it('recognises the old invented paragraph in its four languages, not the real body', () => {
    expect(isPemsaInventedDescription(INVENTED_DE)).toBe(true);
    expect(isPemsaInventedDescription(INVENTED_FR)).toBe(true);
    expect(isPemsaInventedDescription('PEMSA, a staffing agency specialised in construction and technical trades, is looking for a Painter.')).toBe(true);
    expect(isPemsaInventedDescription('PEMSA, agenzia di reclutamento specializzata nel settore edile e tecnico, cerca un profilo Imbianchino.')).toBe(true);
    expect(isPemsaInventedDescription(SOURCE_BODY)).toBe(false);
  });
});

describe('mergePemsaJobRecord', () => {
  it('relabels the source, drops the mislabeled copy and the invented slots, keeps the slugs', () => {
    const merged = mergePemsaJobRecord(STORED, freshJob(SOURCE_BODY));

    expect(merged.sourceLang).toBe('it');
    expect(merged.descriptionByLocale.it).toBe(SOURCE_BODY);
    // The Italian copy filed under `en` and the invented de/fr paragraphs are
    // gone; the translation step refills them from the real source.
    expect(merged.descriptionByLocale.en).toBeUndefined();
    expect(merged.descriptionByLocale.de).toBeUndefined();
    expect(merged.descriptionByLocale.fr).toBeUndefined();
    expect(merged.titleByLocale.en).toBeUndefined();
    expect(merged.needsRetranslation).toBe(true);
    expect(merged.slugByLocale).toEqual(STORED.slugByLocale);
  });

  it('keeps the body an earlier run read when the detail page gives none', () => {
    const merged = mergePemsaJobRecord(STORED, freshJob(''));

    expect(merged.description).toBe(SOURCE_BODY);
    expect(merged.sourceLang).toBe('it');
    expect(merged.descriptionByLocale.it).toBe(SOURCE_BODY);
    expect(Object.values(merged.descriptionByLocale).some(isPemsaInventedDescription)).toBe(false);
  });

  it('does not publish a job that never had a source body', () => {
    expect(mergePemsaJobRecord(null, freshJob(''))).toBeNull();
    const inventedOnly = { ...STORED, sourceLang: 'it', description: INVENTED_DE, descriptionByLocale: { it: INVENTED_DE } };
    expect(mergePemsaJobRecord(inventedOnly, freshJob(''))).toBeNull();
  });

  it('leaves a correctly labelled job without the retranslation flag', () => {
    const clean = { ...STORED, sourceLang: 'it', descriptionByLocale: { it: SOURCE_BODY, en: 'Do you want the freedom of temporary work and the security of a permanent job?' } };
    const merged = mergePemsaJobRecord(clean, freshJob(SOURCE_BODY));

    expect(merged.needsRetranslation).toBeUndefined();
    expect(merged.descriptionByLocale.en).toBe(clean.descriptionByLocale.en);
  });
});
