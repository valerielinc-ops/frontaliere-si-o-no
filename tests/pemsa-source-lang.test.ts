/**
 * PEMSA — source language from the body, source text only (issue 5253).
 *
 * The 2026-09-29 slice had 19/314 jobs labelled from the TITLE
 * ("Imbianchino (M/F)" → en, "Carpentiere AFC / AEC (m/f/d)" → de) while every
 * body comes from the Italian site, and 267/314 jobs carried an invented
 * recruitment paragraph in en/de/fr. The stored record below is that
 * "Imbianchino (M/F)" job, minimized (body excerpts only).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPemsaLocalizedContent,
  mergePemsaJobRecord,
  parseDescriptionToMarkdown,
  PEMSA_FABRICATED_DESCRIPTION_RE,
} from '../scripts/lib/pemsa-job-parser.mjs';
import { getCompanyBoilerplateIT } from '../scripts/lib/dedicated-crawler-common.mjs';
import { dropFabricatedDescriptions } from '../scripts/lib/drop-fabricated-description.mjs';

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

const isFabricated = (text: unknown) => PEMSA_FABRICATED_DESCRIPTION_RE.test(String(text || ''));

// The runner's flow (update-pemsa-jobs.mjs mergeJobs): the stored records lose
// the crawler-written text first, then each one is merged with its fresh job.
function cleanThenMerge(prev: Record<string, unknown> | null, fresh: ReturnType<typeof freshJob>) {
  const stored = prev ? dropFabricatedDescriptions([structuredClone(prev)], PEMSA_FABRICATED_DESCRIPTION_RE, 'PEMSA')[0] : null;
  return mergePemsaJobRecord(stored, fresh);
}

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
    expect(isFabricated(INVENTED_DE)).toBe(true);
    expect(isFabricated(INVENTED_FR)).toBe(true);
    expect(isFabricated('PEMSA, a staffing agency specialised in construction and technical trades, is looking for a Painter.')).toBe(true);
    expect(isFabricated('PEMSA, agenzia di reclutamento specializzata nel settore edile e tecnico, cerca un profilo Imbianchino.')).toBe(true);
    expect(isFabricated(SOURCE_BODY)).toBe(false);
  });
});

describe('mergePemsaJobRecord after dropFabricatedDescriptions (the runner flow)', () => {
  it('relabels the source, drops the mislabeled copy and the invented slots, keeps the slugs', () => {
    const merged = cleanThenMerge(STORED, freshJob(SOURCE_BODY));

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
    const merged = cleanThenMerge(STORED, freshJob(''));

    expect(merged.description).toBe(SOURCE_BODY);
    expect(merged.sourceLang).toBe('it');
    expect(merged.descriptionByLocale.it).toBe(SOURCE_BODY);
    expect(Object.values(merged.descriptionByLocale).some(isFabricated)).toBe(false);
  });

  it('does not publish a job that never had a source body', () => {
    expect(cleanThenMerge(null, freshJob(''))).toBeNull();
    const inventedOnly = { ...STORED, sourceLang: 'it', description: INVENTED_DE, descriptionByLocale: { it: INVENTED_DE } };
    expect(cleanThenMerge(inventedOnly, freshJob(''))).toBeNull();
  });

  it('does not publish a real text under the shared 50-word floor, even above 100 characters (review #10396)', () => {
    const short = 'Questo testo reale contiene venti parole e supera il limite di cento caratteri grazie a una descrizione abbastanza lunga ma ancora troppo breve.';
    expect(short.length).toBeGreaterThan(100);
    expect(mergePemsaJobRecord(null, { sourceLang: 'it', description: short, descriptionByLocale: { it: short } })).toBeNull();
    // Nor is a stored body under the floor carried over.
    const stored = { ...STORED, sourceLang: 'it', description: short, descriptionByLocale: { it: short } };
    expect(mergePemsaJobRecord(stored, freshJob(''))).toBeNull();
  });

  it('leaves a correctly labelled job without the retranslation flag', () => {
    const clean = { ...STORED, sourceLang: 'it', descriptionByLocale: { it: SOURCE_BODY, en: 'Do you want the freedom of temporary work and the security of a permanent job?' } };
    const merged = cleanThenMerge(clean, freshJob(SOURCE_BODY));

    expect(merged.needsRetranslation).toBeUndefined();
    expect(merged.descriptionByLocale.en).toBe(clean.descriptionByLocale.en);
  });

  it('is only reached through the runner after the stored records are cleaned', () => {
    const runner = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'update-pemsa-jobs.mjs'), 'utf8');
    const clean = runner.search(/dropFabricatedDescriptions\(existing\.filter\(isTargetJob\), PEMSA_FABRICATED_DESCRIPTION_RE, 'PEMSA'\)/);
    expect(clean).toBeGreaterThan(-1);
    expect(runner.indexOf('mergePemsaJobRecord(prev, job)')).toBeGreaterThan(clean);
  });
});

describe('PEMSA ads with bold-paragraph sections (issue 5253)', () => {
  // Minimized JSON-LD description of https://www.pemsa.ch/it/job/posatore-di-resina-2696898/
  // (2026-09-29): plain intro, then "<p><strong>…</strong></p><ul>…" sections
  // and no <h2-4>. The parser returned '' for it, and 3/313 stored jobs then
  // carried the invented recruitment paragraph plus the central boilerplate.
  const RAW = 'Vuoi la libertà del lavoro temporaneo e la sicurezza di un impiego a tempo indeterminato? \n\nDa 30 anni affianchiamo centinaia di aziende nei settori tecnici dell’edilizia, delle costruzioni e dell’industria in tutta la Svizzera.\n'
    + '&lt;/br&gt;&lt;p&gt;&lt;strong&gt;Il tuo incarico: &lt;/strong&gt;&lt;/p&gt;\n&lt;ul&gt;\n&lt;li&gt;Leggere e interpretare i disegni esecutivi.&lt;/li&gt;\n&lt;li&gt;Preparare, riparare e controllare i supporti prima dell’applicazione.&lt;/li&gt;\n&lt;/ul&gt;\n'
    + '&lt;p&gt;&lt;strong&gt;Il tuo profilo: &lt;/strong&gt;&lt;/p&gt;\n&lt;ul&gt;\n&lt;li&gt;Esperienza nella posa di resine epossidiche o poliuretaniche.&lt;/li&gt;\n&lt;/ul&gt;';

  it('reads intro and sections instead of returning an empty ad', () => {
    const parsed = parseDescriptionToMarkdown(RAW);
    expect(parsed.text).toContain('Vuoi la libertà del lavoro temporaneo');
    expect(parsed.text).toContain('## Il tuo incarico:\n- Leggere e interpretare i disegni esecutivi.\n- Preparare, riparare');
    expect(parsed.text).toContain('## Il tuo profilo:');
    expect(parsed.sectionCount).toBe(2);
  });

  it('recognises the central boilerplate read from dedicated-crawler-common, bullet-split as stored', () => {
    const central = getCompanyBoilerplateIT('PEMSA') as string;
    const stored = `## Posatore di resina\n\n**PEMSA** — Genève (GE)\n\n${central.replace(', impiantistica, ', ',\n• impiantistica, ').replace('. Offriamo', '. \n• Offriamo')}`;
    expect(isFabricated(stored)).toBe(true);
    const merged = cleanThenMerge(
      { ...STORED, sourceLang: 'it', description: stored, descriptionByLocale: { it: stored } },
      freshJob(SOURCE_BODY),
    );
    expect(merged.descriptionByLocale.it).toBe(SOURCE_BODY);
    expect(isFabricated(merged.description)).toBe(false);
    expect(cleanThenMerge({ ...STORED, sourceLang: 'it', description: stored, descriptionByLocale: { it: stored } }, freshJob(''))).toBeNull();
  });
});
