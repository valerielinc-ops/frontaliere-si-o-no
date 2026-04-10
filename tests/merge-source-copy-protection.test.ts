/**
 * Tests for the source-copy-overwrite protection in mergeAndDeduplicate.
 *
 * Bug: mergeLocaleTextMap picks the LONGER text, so English source copies (e.g. 4469 chars)
 * overwrite shorter real translations (e.g. Italian 4000 chars). This causes:
 * 1. IT/DE/FR slots filled with English source copy
 * 2. Coverage = 1 → needsRetranslation = true on every crawl
 * 3. translate-pending re-translates → slug instability
 */
import { describe, expect, it } from 'vitest';
import { mergeAndDeduplicate } from '../scripts/lib/dedicated-crawler-common.mjs';

// A long English description (simulating VF's 4469-char EN source)
const EN_DESC_LONG = 'The North Face EMEA is looking for an Influencer Marketing Coordinator to join our Communications Marketing team based in Stabio, Switzerland. ' +
  'Live the Brand. The North Face is the premier exploration company in the world. ' +
  'We deliver the best gear to the world\'s greatest athletes, support exploratory expeditions around the globe. ' +
  'The successful candidate will be responsible for developing and executing influencer marketing strategies. ' +
  'They will manage relationships with key influencers, content creators and brand ambassadors across the EMEA region. ' +
  'Working closely with the brand marketing, PR and social media teams, they will ensure cohesive messaging. ' +
  'The role requires strong analytical skills to measure campaign effectiveness and ROI. ' +
  'Experience in influencer marketing or social media management is essential for this position.';

// Real Italian translation (slightly shorter than EN_DESC_LONG)
const IT_TRANSLATION = 'The North Face EMEA cerca un Coordinatore di Influencer Marketing da unire al nostro team di Marketing delle Comunicazioni con sede a Stabio, in Svizzera. ' +
  'Vivi il Brand. The North Face è la principale azienda di esplorazione al mondo. ' +
  'Consegniamo il miglior equipaggiamento agli atleti più grandi del mondo, supportiamo spedizioni esplorative in tutto il globo. ' +
  'Il candidato di successo sarà responsabile dello sviluppo e dell\'esecuzione di strategie di marketing con influencer. ' +
  'Gestirà le relazioni con influencer chiave, content creator e ambasciatori del brand in tutta la regione EMEA. ' +
  'Lavorando a stretto contatto con i team di brand marketing, PR e social media, garantirà messaggi coerenti. ' +
  'Il ruolo richiede forti capacità analitiche per misurare l\'efficacia delle campagne e il ROI.';

const QUALITY_CFG = {};

describe('mergeAndDeduplicate source-copy protection', () => {
  it('preserves real IT translation even when fresh crawl brings longer EN source copy', () => {
    const prevJob = {
      id: 'job-1',
      slug: 'influencer-marketing-coordinator-vf',
      title: 'Influencer Marketing Coordinator - THE NORTH FACE',
      company: 'VF International',
      location: 'Stabio',
      description: EN_DESC_LONG,
      url: 'https://vfc.com/jobs/1234',
      crawledAt: '2026-03-30T10:00:00Z',
      source: 'Company Careers Crawler',
      titleByLocale: {
        en: 'Influencer Marketing Coordinator - THE NORTH FACE',
        it: 'Coordinatore di Influencer Marketing - THE NORTH FACE',
        de: 'Influencer Marketing Koordinator - THE NORTH FACE',
        fr: 'Coordinateur de Marketing Influenceur - THE NORTH FACE',
      },
      descriptionByLocale: {
        en: EN_DESC_LONG,
        it: IT_TRANSLATION,
        de: 'The North Face EMEA sucht einen Influencer Marketing Coordinator für unser Communications Marketing Team mit Sitz in Stabio, Schweiz. ' +
          'Erlebe die Marke. The North Face ist das führende Explorationsunternehmen der Welt. ' +
          'Wir liefern die beste Ausrüstung an die größten Athleten der Welt und unterstützen Forschungsexpeditionen rund um den Globus.',
        fr: 'The North Face EMEA recherche un Coordinateur Marketing Influenceur pour rejoindre notre équipe Marketing des Communications basée à Stabio, en Suisse. ' +
          'Vivez la Marque. The North Face est la première entreprise d\'exploration au monde. ' +
          'Nous livrons le meilleur équipement aux plus grands athlètes du monde et soutenons des expéditions exploratoires dans le monde entier.',
      },
      slugByLocale: {
        en: 'influencer-marketing-coordinator-the-north-face-vf-stabio',
        it: 'coordinatore-influencer-marketing-the-north-face-vf-stabio',
        de: 'influencer-marketing-koordinator-the-north-face-vf-stabio',
        fr: 'coordinateur-marketing-influenceur-the-north-face-vf-stabio',
      },
    };

    // Fresh crawl brings same job — English only, other locales are source copies
    const freshCrawl = {
      ...prevJob,
      crawledAt: '2026-03-31T09:00:00Z',
      // Fresh crawl: source copies in IT/DE/FR (longer than real translations)
      descriptionByLocale: {
        en: EN_DESC_LONG,
        it: EN_DESC_LONG,  // source copy — LONGER than IT_TRANSLATION
        de: EN_DESC_LONG,
        fr: EN_DESC_LONG,
      },
      titleByLocale: {
        en: 'Influencer Marketing Coordinator - THE NORTH FACE',
        it: 'Influencer Marketing Coordinator - THE NORTH FACE',  // source copy
        de: 'Influencer Marketing Coordinator - THE NORTH FACE',
        fr: 'Influencer Marketing Coordinator - THE NORTH FACE',
      },
    };

    const result = mergeAndDeduplicate([prevJob], [freshCrawl], QUALITY_CFG);
    const jobs = result.merged;
    expect(jobs).toHaveLength(1);
    const merged = jobs[0];

    // IT/DE/FR descriptions should be the real translations from prev, NOT the EN source copies
    expect(merged.descriptionByLocale.it).toBe(IT_TRANSLATION);
    expect(merged.descriptionByLocale.it).not.toBe(EN_DESC_LONG);
    expect(merged.descriptionByLocale.de).not.toBe(EN_DESC_LONG);
    expect(merged.descriptionByLocale.fr).not.toBe(EN_DESC_LONG);

    // EN description is the source — OK to keep
    expect(merged.descriptionByLocale.en).toBe(EN_DESC_LONG);
  });

  it('preserves real IT title even when fresh crawl brings EN source copy', () => {
    const prevJob = {
      id: 'job-2',
      slug: 'allocator-intern-vf',
      title: 'Allocator Intern - EMEA Internship Program',
      company: 'VF International',
      location: 'Stabio',
      description: EN_DESC_LONG,
      url: 'https://vfc.com/jobs/5678',
      crawledAt: '2026-03-30T10:00:00Z',
      source: 'Company Careers Crawler',
      titleByLocale: {
        en: 'Allocator Intern - EMEA Internship Program',
        it: 'Tirocinante Allocatore - Programma di Stage EMEA',  // good translation
        de: 'Allocator Praktikant - EMEA Praktikumsprogramm',
        fr: 'Stagiaire Alloueur - Programme de Stage EMEA',
      },
      descriptionByLocale: {
        en: EN_DESC_LONG,
        it: IT_TRANSLATION,
        de: IT_TRANSLATION.replace('Coordinatore', 'Koordinator'),
        fr: IT_TRANSLATION.replace('Coordinatore', 'Coordinateur'),
      },
      slugByLocale: {
        en: 'allocator-intern-emea-internship-program-vf-stabio',
        it: 'tirocinante-allocatore-programma-di-stage-emea-vf-stabio',
        de: 'allocator-praktikant-emea-praktikumsprogramm-vf-stabio',
        fr: 'stagiaire-alloueur-programme-de-stage-emea-vf-stabio',
      },
    };

    // Fresh crawl: all titles are source copies
    const freshCrawl = {
      ...prevJob,
      crawledAt: '2026-03-31T09:00:00Z',
      titleByLocale: {
        en: 'Allocator Intern - EMEA Internship Program',
        it: 'Allocator Intern - EMEA Internship Program',  // source copy
        de: 'Allocator Intern - EMEA Internship Program',
        fr: 'Allocator Intern - EMEA Internship Program',
      },
      descriptionByLocale: {
        en: EN_DESC_LONG,
        it: EN_DESC_LONG,
        de: EN_DESC_LONG,
        fr: EN_DESC_LONG,
      },
    };

    const result = mergeAndDeduplicate([prevJob], [freshCrawl], QUALITY_CFG);
    const merged = result.merged[0];

    // Good translations should be preserved
    expect(merged.titleByLocale.it).toBe('Tirocinante Allocatore - Programma di Stage EMEA');
    expect(merged.titleByLocale.it).not.toBe('Allocator Intern - EMEA Internship Program');
    expect(merged.titleByLocale.de).toBe('Allocator Praktikant - EMEA Praktikumsprogramm');
    expect(merged.titleByLocale.fr).toBe('Stagiaire Alloueur - Programme de Stage EMEA');
  });

  it('does NOT set needsRetranslation after merge when translations are complete and no source copies remain', () => {
    // If we have a complete job (all 4 locales properly translated), a fresh
    // crawl with source copies should not result in needsRetranslation after merge.
    const prevJob = {
      id: 'job-3',
      slug: 'sustainability-specialist-vf',
      title: 'Sustainability Specialist',
      company: 'VF International',
      location: 'Stabio',
      description: EN_DESC_LONG,
      url: 'https://vfc.com/jobs/9999',
      crawledAt: '2026-03-30T10:00:00Z',
      source: 'Company Careers Crawler',
      titleByLocale: {
        en: 'Sustainability Specialist',
        it: 'Specialista della Sostenibilità',
        de: 'Nachhaltigkeitsspezialist',
        fr: 'Spécialiste en Durabilité',
      },
      descriptionByLocale: {
        en: EN_DESC_LONG,
        it: IT_TRANSLATION,
        de: IT_TRANSLATION.replace('Coordinatore', 'Fachspezialist'),
        fr: IT_TRANSLATION.replace('Coordinatore', 'Spécialiste'),
      },
      slugByLocale: {
        en: 'sustainability-specialist-vf-stabio',
        it: 'specialista-sostenibilita-vf-stabio',
        de: 'nachhaltigkeitsspezialist-vf-stabio',
        fr: 'specialiste-durabilite-vf-stabio',
      },
    };

    const freshCrawl = {
      ...prevJob,
      crawledAt: '2026-03-31T09:00:00Z',
      titleByLocale: {
        en: 'Sustainability Specialist',
        it: 'Sustainability Specialist',  // source copy
        de: 'Sustainability Specialist',
        fr: 'Sustainability Specialist',
      },
      descriptionByLocale: {
        en: EN_DESC_LONG,
        it: EN_DESC_LONG,
        de: EN_DESC_LONG,
        fr: EN_DESC_LONG,
      },
    };

    const result = mergeAndDeduplicate([prevJob], [freshCrawl], QUALITY_CFG);
    const merged = result.merged[0];

    // Translations should be preserved from prev
    expect(merged.descriptionByLocale.it).toBe(IT_TRANSLATION);
    expect(merged.titleByLocale.it).toBe('Specialista della Sostenibilità');
  });

  it('preserves existing locale slugs when crawler brings longer variants (existing wins)', () => {
    const prevJob = {
      id: 'job-4',
      slug: 'coordinatore-marketing-vf-stabio',
      title: 'Marketing Coordinator - THE NORTH FACE',
      company: 'VF International',
      location: 'Stabio',
      description: EN_DESC_LONG,
      url: 'https://vfc.com/jobs/4444',
      crawledAt: '2026-03-30T10:00:00Z',
      source: 'Company Careers Crawler',
      titleByLocale: {
        en: 'Marketing Coordinator - THE NORTH FACE',
        it: 'Coordinatore Marketing - THE NORTH FACE',
        de: 'Marketing Koordinator - THE NORTH FACE',
        fr: 'Coordinateur Marketing - THE NORTH FACE',
      },
      descriptionByLocale: {
        en: EN_DESC_LONG,
        it: IT_TRANSLATION,
        de: IT_TRANSLATION.replace('Coordinatore', 'Koordinator'),
        fr: IT_TRANSLATION.replace('Coordinatore', 'Coordinateur'),
      },
      slugByLocale: {
        en: 'marketing-coordinator-the-north-face-vf-stabio',
        it: 'coordinatore-marketing-the-north-face-vf-stabio',
        de: 'marketing-koordinator-the-north-face-vf-stabio',
        fr: 'coordinateur-marketing-the-north-face-vf-stabio',
      },
      previousSlugs: [],
    };

    // Fresh crawl brings a LONGER slug for IT (e.g. regenerated with extra tokens).
    // With "existing wins" merge, existing slugs are preserved — no overwrite.
    const freshCrawl = {
      ...prevJob,
      crawledAt: '2026-03-31T09:00:00Z',
      requirements: ['Strong marketing skills', 'Fluent in English and Italian'],
      slugByLocale: {
        en: 'marketing-coordinator-the-north-face-vf-stabio',
        it: 'coordinatore-marketing-the-north-face-vf-international-emea-stabio-campus',  // longer, different
        de: 'marketing-koordinator-the-north-face-vf-international-emea-stabio-campus',
        fr: 'coordinateur-marketing-the-north-face-vf-international-emea-stabio-campus',
      },
    };

    const result = mergeAndDeduplicate([prevJob], [freshCrawl], QUALITY_CFG);
    const merged = result.merged[0];

    // Existing slugs should be preserved (not overwritten by longer crawler variants)
    expect(merged.slugByLocale.it).toBe('coordinatore-marketing-the-north-face-vf-stabio');
    expect(merged.slugByLocale.de).toBe('marketing-koordinator-the-north-face-vf-stabio');
    expect(merged.slugByLocale.fr).toBe('coordinateur-marketing-the-north-face-vf-stabio');
    // No slug changes → no previousSlugs entries needed
    expect(merged.previousSlugs).not.toContain('coordinatore-marketing-the-north-face-vf-stabio');
  });

  it('protects locale slugs from EN source-copy overwrite', () => {
    const prevJob = {
      id: 'job-5',
      slug: 'analista-pss-vf-stabio',
      title: 'PSS Analyst - THE NORTH FACE',
      company: 'VF International',
      location: 'Stabio',
      description: EN_DESC_LONG,
      url: 'https://vfc.com/jobs/5555',
      crawledAt: '2026-03-30T10:00:00Z',
      source: 'Company Careers Crawler',
      titleByLocale: {
        en: 'PSS Analyst - THE NORTH FACE',
        it: 'Analista PSS - THE NORTH FACE',
        de: 'PSS Analyst - THE NORTH FACE',
        fr: 'Analyste PSS - THE NORTH FACE',
      },
      descriptionByLocale: {
        en: EN_DESC_LONG,
        it: IT_TRANSLATION,
        de: IT_TRANSLATION.replace('Coordinatore', 'Analyst'),
        fr: IT_TRANSLATION.replace('Coordinatore', 'Analyste'),
      },
      slugByLocale: {
        en: 'pss-analyst-the-north-face-vf-stabio',
        it: 'analista-pss-the-north-face-vf-stabio',
        de: 'pss-analyst-the-north-face-vf-stabio-de',
        fr: 'analyste-pss-the-north-face-vf-stabio',
      },
      previousSlugs: [],
    };

    // Fresh crawl: all slugs are EN source copies (longer than the IT slug)
    const freshCrawl = {
      ...prevJob,
      crawledAt: '2026-03-31T09:00:00Z',
      slugByLocale: {
        en: 'pss-analyst-the-north-face-vf-stabio',
        it: 'pss-analyst-the-north-face-vf-stabio',  // source copy
        de: 'pss-analyst-the-north-face-vf-stabio',
        fr: 'pss-analyst-the-north-face-vf-stabio',
      },
      descriptionByLocale: {
        en: EN_DESC_LONG,
        it: EN_DESC_LONG,
        de: EN_DESC_LONG,
        fr: EN_DESC_LONG,
      },
    };

    const result = mergeAndDeduplicate([prevJob], [freshCrawl], QUALITY_CFG);
    const merged = result.merged[0];

    // Real locale slugs should be preserved, not overwritten by EN source
    expect(merged.slugByLocale.it).toBe('analista-pss-the-north-face-vf-stabio');
    expect(merged.slugByLocale.fr).toBe('analyste-pss-the-north-face-vf-stabio');
    // EN slug stays as-is
    expect(merged.slugByLocale.en).toBe('pss-analyst-the-north-face-vf-stabio');
  });
});
