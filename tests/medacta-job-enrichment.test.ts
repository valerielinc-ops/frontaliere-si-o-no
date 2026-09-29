import { describe, expect, it } from 'vitest';
import {
  inferMedactaCategory,
  inferMedactaContract,
  extractMedactaDetailMarkdown,
  isMedactaTemplateDescription,
  isMedactaDetailBacked,
  detailBackedMedactaLocales,
  resolveMedactaDescriptionAction,
  MEDACTA_DETAIL_SOURCE,
} from '../scripts/lib/medacta-job-enrichment.mjs';
import { sourceBodyWordCount } from '../scripts/lib/source-body-floor.mjs';

// Openings of the category template the crawler published before 2026-09-29,
// as stored for the Demand Planner (medacta-105851) in the committed slice:
// invented text (the same tasks for every role of a category), never the
// vacancy's. Pinned here because the generator is gone.
const LEGACY_TEMPLATE_BY_LOCALE = {
  it: '## Panoramica Ruolo\nMedacta International SA sta cercando Demand Planner con sede a Castel San Pietro, Mendrisio. Reparto: Operations & Supply Chain. Ticino\n## Mansioni Principali\n- Eseguirai attivita operative e tecniche su impianti, processi o linee produttive.',
  en: '## Role Overview\nMedacta International SA is hiring Demand Planner in Castel San Pietro, Mendrisio. Department: Operations & Supply Chain. Ticino\n## Main Responsibilities\n- Perform technical activities on equipment, production flows, or industrial processes.',
  de: '## Rollenubersicht\nMedacta International SA sucht Demand Planner in Castel San Pietro, Mendrisio. Abteilung: Operations & Supply Chain. Ticino\n## Hauptaufgaben',
  fr: '## Apercu Du Poste\nMedacta International SA recrute Demand Planner a Castel San Pietro, Mendrisio. Departement: Operations & Supply Chain. Ticino\n## Responsabilites Principales',
};

// Allibo detail page (joblink.allibo.com/ats3/job-offer.aspx?DM=1818&ID=105851),
// minimised from the live page of 2026-09-29: meta teaser + microdata body.
const DEMAND_PLANNER_DETAIL_HTML = `<html><head>
<meta name='description' content="Lavora con noi! Medacta International SA sta cercando Demand Planner su Ticino" />
<meta property="og:description" content="Lavora con noi! Medacta International SA sta cercando Demand Planner su Ticino" />
</head><body><main>
<section itemprop="mainEntity" itemscope itemtype="http://schema.org/JobPosting">
<meta itemprop="identifier" content="1818_105851" />
<h1 class="style-forced" itemprop="title">Demand Planner</h1>
<div class="style-forced" itemprop="description">
<p style="text-align: justify"><span style="color: black">Medacta International is searching for a&nbsp;</span><b>Demand Planner</b>.</p><p>The Demand Planner is responsible for managing large datasets, analyzing demand trends, and ensuring accurate forecast to support business objectives.</p><p>The candidate will be responsible for managing the following activities:</p><ul><li><b>Budget &amp; Forecast Support:</b> Assist in the preparation of budget and forecast sessions;</li><li><b>Order Evaluation:</b> Assess extra-forecast orders based on profitability;</li></ul><p>The resource should also have the following skills:</p><p>&nbsp;<b>Hard Skills</b></p><ul type="disc"> <li>Bachelor’s degree in management engineering/ Logistics/Supply Chain;</li> <li>Fluent in English;</li> </ul><p><strong>What we offer:</strong></p><ul type="disc"><li>Permanent contract;</li><li>Carpooling organized by Medacta;<br></li></ul><p><em>Medacta International is an equal opportunities employer.</em></p><div><br></div>
</div>
<details class="location map"><summary>Castel San Pietro</summary></details>
</section></main></body></html>`;

describe('medacta-job-enrichment', () => {
  it('maps Medacta categories to canonical job board categories', () => {
    expect(
      inferMedactaCategory({
        category: 'general-services',
        categoryLabel: 'General Services',
        title: 'Manutentore Elettromeccanico',
        jobCategory: 'Altro',
      })
    ).toBe('engineering');

    expect(
      inferMedactaCategory({
        category: 'mkt-communication',
        categoryLabel: 'Marketing & Communications',
        title: 'Group Associate Product Manager',
        jobCategory: 'Marketing',
      })
    ).toBe('sales');
  });

  it('normalizes Medacta contract values to canonical contract types', () => {
    expect(inferMedactaContract({ rawContract: 'permanent', title: 'IT Web Developer' })).toBe('full-time');
    expect(inferMedactaContract({ rawContract: '80%', title: 'HR Specialist' })).toBe('part-time');
    expect(inferMedactaContract({ rawContract: '', title: 'Thesis R&D Orthopedics' })).toBe('internship');
  });

  // The crawler read only og:description (the one-line teaser) and published
  // the category template: a Demand Planner got "Eseguirai attivita operative
  // e tecniche su impianti" — overlap 0.08 with the real page.
  it('reads the vacancy body of the Allibo detail page as markdown', () => {
    const md = extractMedactaDetailMarkdown(DEMAND_PLANNER_DETAIL_HTML);
    expect(md).toBe([
      'Medacta International is searching for a Demand Planner.',
      '',
      'The Demand Planner is responsible for managing large datasets, analyzing demand trends, and ensuring accurate forecast to support business objectives.',
      '',
      'The candidate will be responsible for managing the following activities:',
      '',
      '- Budget & Forecast Support: Assist in the preparation of budget and forecast sessions;',
      '- Order Evaluation: Assess extra-forecast orders based on profitability;',
      '',
      'The resource should also have the following skills:',
      '',
      '## Hard Skills',
      '',
      '- Bachelor’s degree in management engineering/ Logistics/Supply Chain;',
      '- Fluent in English;',
      '',
      '## What we offer',
      '',
      '- Permanent contract;',
      '- Carpooling organized by Medacta;',
      '',
      'Medacta International is an equal opportunities employer.',
    ].join('\n'));
    expect(md).not.toContain('Lavora con noi');
    expect(extractMedactaDetailMarkdown('<html><body><p>captcha</p></body></html>')).toBe('');
  });

  it('tells the retired category template apart from a real vacancy body', () => {
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      expect(isMedactaTemplateDescription(LEGACY_TEMPLATE_BY_LOCALE[locale])).toBe(true);
    }
    expect(isMedactaTemplateDescription(extractMedactaDetailMarkdown(DEMAND_PLANNER_DETAIL_HTML))).toBe(false);
  });

  it('keeps a detail-backed body and drops the stale template locales so translation regenerates them', () => {
    const body = extractMedactaDetailMarkdown(DEMAND_PLANNER_DETAIL_HTML);
    const job = {
      source: MEDACTA_DETAIL_SOURCE,
      sourceLang: 'en',
      description: body,
      descriptionByLocale: { ...LEGACY_TEMPLATE_BY_LOCALE, fr: 'Medacta International recherche un Demand Planner. Le Demand Planner gère de grands ensembles de données et analyse les tendances de la demande.' },
    };
    expect(isMedactaDetailBacked(job)).toBe(true);
    const locales = detailBackedMedactaLocales(job);
    expect(Object.keys(locales).sort()).toEqual(['en', 'fr']);
    expect(locales.en).toBe(body);
    // A record of the template era is not source-backed, whatever its source tag.
    expect(isMedactaDetailBacked({ ...job, source: 'Allibo ATS API + structured enrichment' })).toBe(false);
    expect(isMedactaDetailBacked({ ...job, description: LEGACY_TEMPLATE_BY_LOCALE.it })).toBe(false);
  });

  // No invented fallback: without a body read from the source the job keeps
  // the body of an earlier run, or is not published at all.
  it('publishes only source text: detail body, else the stored source body, else nothing', () => {
    const body = extractMedactaDetailMarkdown(DEMAND_PLANNER_DETAIL_HTML);
    const sourceBacked = { source: MEDACTA_DETAIL_SOURCE, sourceLang: 'en', description: body };
    const templateEra = {
      source: 'Allibo ATS API + structured enrichment',
      sourceLang: 'it',
      description: LEGACY_TEMPLATE_BY_LOCALE.it,
    };
    expect(resolveMedactaDescriptionAction({ detailMarkdown: body, existing: templateEra })).toBe('detail');
    expect(resolveMedactaDescriptionAction({ detailMarkdown: body, existing: null })).toBe('detail');
    expect(resolveMedactaDescriptionAction({ detailMarkdown: '', existing: sourceBacked })).toBe('keep');
    expect(resolveMedactaDescriptionAction({ detailMarkdown: '', existing: templateEra })).toBe('drop');
    expect(resolveMedactaDescriptionAction({ detailMarkdown: '', existing: null })).toBe('drop');
    // The meta teaser is not a body.
    expect(resolveMedactaDescriptionAction({
      detailMarkdown: 'Lavora con noi! Medacta International SA sta cercando Demand Planner su Ticino',
      existing: null,
    })).toBe('drop');
  });
});

// Word floor (source-body-floor.mjs): real body text of the Demand Planner
// (job-offer.aspx?DM=1818&ID=105851, 2026-09-29) cut at 49 and 50 words. Both
// cuts are far above the old 150-character gate.
const DEMAND_PLANNER_BODY_TEXT = 'The Demand Planner is responsible for managing large datasets, analyzing demand trends, and ensuring accurate forecast to support business objectives. The role requires strong communication skills to collaborate effectively with internal departments and external customers, as well as a commitment to continuous improvement of demand planning processes. The candidate will be responsible for managing the following activities: Budget & Forecast Support: Assist in the preparation of budget and forecast sessions by providing accurate demand insights and data-driven recommendations;';
const firstWords = (text: string, n: number) => text.split(' ').slice(0, n).join(' ');

describe('Medacta source body word floor', () => {
  const body49 = firstWords(DEMAND_PLANNER_BODY_TEXT, 49);
  const body50 = firstWords(DEMAND_PLANNER_BODY_TEXT, 50);

  it('pins the fixture at 49 and 50 words, both over the old character gate', () => {
    expect(sourceBodyWordCount(body49)).toBe(49);
    expect(sourceBodyWordCount(body50)).toBe(50);
    expect(body49.length).toBeGreaterThan(150);
  });

  it('publishes a 50-word detail body and drops a 49-word one', () => {
    expect(resolveMedactaDescriptionAction({ detailMarkdown: body49, existing: null })).toBe('drop');
    expect(resolveMedactaDescriptionAction({ detailMarkdown: body50, existing: null })).toBe('detail');
  });

  it('keeps a stored body only at 50 words or more', () => {
    const stored = (description: string) => ({ source: MEDACTA_DETAIL_SOURCE, sourceLang: 'en', description });
    expect(isMedactaDetailBacked(stored(body49))).toBe(false);
    expect(isMedactaDetailBacked(stored(body50))).toBe(true);
    expect(resolveMedactaDescriptionAction({ detailMarkdown: '', existing: stored(body49) })).toBe('drop');
    expect(resolveMedactaDescriptionAction({ detailMarkdown: '', existing: stored(body50) })).toBe('keep');
  });
});
