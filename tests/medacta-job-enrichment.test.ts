import { describe, expect, it } from 'vitest';
import {
  inferMedactaCategory,
  inferMedactaContract,
  buildMedactaLocalizedDescriptions,
  extractMedactaDetailMarkdown,
  isMedactaTemplateDescription,
  isMedactaDetailBacked,
  detailBackedMedactaLocales,
  MEDACTA_DETAIL_SOURCE,
} from '../scripts/lib/medacta-job-enrichment.mjs';

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

  it('builds rich localized descriptions with markdown sections for all locales', () => {
    const descriptions = buildMedactaLocalizedDescriptions({
      title: 'Manutentore Elettromeccanico',
      location: 'Castel San Pietro/Rancate',
      category: 'engineering',
      departmentLabel: 'General Services',
      isUrgent: false,
      metaDescription: 'Lavora con noi! Medacta International SA sta cercando Manutentore Elettromeccanico su Svizzera',
    });

    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const text = descriptions[locale] || '';
      expect(text.length).toBeGreaterThan(220);
      expect(text).toContain('## ');
      expect(text).toContain('Manutentore Elettromeccanico');
    }

    expect(descriptions.it).not.toBe(descriptions.en);
    expect(descriptions.it).not.toBe(descriptions.de);
    expect(descriptions.it).not.toBe(descriptions.fr);
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

  it('tells the category template apart from a real vacancy body', () => {
    const template = buildMedactaLocalizedDescriptions({ title: 'Demand Planner', category: 'engineering' });
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      expect(isMedactaTemplateDescription(template[locale])).toBe(true);
    }
    expect(isMedactaTemplateDescription(extractMedactaDetailMarkdown(DEMAND_PLANNER_DETAIL_HTML))).toBe(false);
  });

  it('keeps a detail-backed body and drops the stale template locales so translation regenerates them', () => {
    const body = extractMedactaDetailMarkdown(DEMAND_PLANNER_DETAIL_HTML);
    const template = buildMedactaLocalizedDescriptions({ title: 'Demand Planner', category: 'engineering' });
    const job = {
      source: MEDACTA_DETAIL_SOURCE,
      sourceLang: 'en',
      description: body,
      descriptionByLocale: { ...template, fr: 'Medacta International recherche un Demand Planner. Le Demand Planner gère de grands ensembles de données et analyse les tendances de la demande.' },
    };
    expect(isMedactaDetailBacked(job)).toBe(true);
    const locales = detailBackedMedactaLocales(job);
    expect(Object.keys(locales).sort()).toEqual(['en', 'fr']);
    expect(locales.en).toBe(body);
    // Without the detail source the template path stays in charge.
    expect(isMedactaDetailBacked({ ...job, source: 'Allibo ATS API + structured enrichment' })).toBe(false);
    expect(isMedactaDetailBacked({ ...job, description: template.it })).toBe(false);
  });
});
