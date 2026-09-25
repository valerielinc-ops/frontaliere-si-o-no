import { describe, expect, it } from 'vitest';
import { buildPath } from '@/services/router';

describe('buildPath SEO canonical form', () => {
  it('adds trailing slash to indexable section URLs', () => {
    expect(buildPath({ activeTab: 'stats', statsSubTab: 'livability' }, 'de')).toBe('/de/statistiken/beste-grenzgemeinden/');
    expect(buildPath({ activeTab: 'stats', statsSubTab: 'jobs-observatory' }, 'it')).toBe('/statistiche/osservatorio-stipendi-lavori-ticino/');
    expect(buildPath({ activeTab: 'job-board', jobSlug: 'test-job' }, 'it')).toBe('/cerca-lavoro-ticino/test-job/');
    expect(buildPath({ activeTab: 'privacy' }, 'en')).toBe('/en/privacy/');
    expect(buildPath({ activeTab: 'fisco', fiscoSubTab: 'withholding-rates' }, 'it')).toBe('/tasse-e-pensione/aliquote-imposta-alla-fonte-ticino-2026/');
    expect(buildPath({ activeTab: 'fisco', fiscoSubTab: 'withholding-rates' }, 'en')).toBe('/en/taxes-and-pension/ticino-withholding-tax-rates-2026/');
    expect(buildPath({ activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: 'new-frontier-over20km' }, 'it')).toBe('/calcola-stipendio/nuovi-frontalieri-oltre-20-km/');
    expect(buildPath({ activeTab: 'calculator', calcolatoreSubTab: 'calculator', seoLanding: 'new-frontier-over20km' }, 'en')).toBe('/en/calculate-salary/new-cross-border-workers-over-20km/');
  });

  it('localizes editorial job-board slugs when switching locale', () => {
    expect(buildPath({ activeTab: 'job-board', jobSlug: 'offerte-di-lavoro-ticino-oggi' }, 'en')).toBe('/en/find-jobs-ticino/ticino-jobs-today/');
    expect(buildPath({ activeTab: 'job-board', jobSlug: 'ricerca-lugano' }, 'en')).toBe('/en/find-jobs-ticino/search-lugano/');
    expect(buildPath({ activeTab: 'job-board', jobSlug: 'ricerca-lugano-apprendistato' }, 'de')).toBe('/de/jobs-im-tessin/suche-lugano-lehrstelle/');
    expect(buildPath({ activeTab: 'job-board', jobSlug: 'ricerca-chiasso-finanza' }, 'fr')).toBe('/fr/trouver-emploi-tessin/recherche-chiasso-finance/');
  });

  it('keeps root locale URLs canonical', () => {
    expect(buildPath({ activeTab: 'calculator' }, 'it')).toBe('/');
    expect(buildPath({ activeTab: 'calculator' }, 'fr')).toBe('/fr/');
  });
});
