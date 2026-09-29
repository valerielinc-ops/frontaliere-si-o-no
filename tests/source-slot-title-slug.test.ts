import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { sourceLangOfBody, sourceLangOfPosting, sourceSlotTitleAndSlug } from '../scripts/lib/source-locale-slots.mjs';
import { buildDelvitechLocalizedContent } from '../scripts/lib/delvitech-job-parser.mjs';
import { guessPostingSourceLang } from '../scripts/lib/guess-job-parser.mjs';
import { buildJobFromApi as buildSwissMedicalNetworkJob } from '../scripts/update-swiss-medical-network-jobs.mjs';
import { postProcessPostJobs } from '../scripts/update-postch-jobs.mjs';
import { postProcessPostFinanceJobs } from '../scripts/update-postfinance-jobs.mjs';

// Pinned: published jobs of the runners that filed title and slug under a
// fixed `en`/`it` key (main slice, 2026-09-29), #5253.
const samples = JSON.parse(fs.readFileSync(
  path.join(__dirname, 'fixtures', 'crawler-quality-f', 'source-slot-title-slug-samples.json'),
  'utf8',
));

type Sample = { sourceLang: string, title: string, location: string, description: string, slugByLocale: Record<string, string> };

describe('title and slug in the source slot (#5253)', () => {
  it('reads each pinned body as its published source language', () => {
    for (const key of Object.keys(samples).filter((k) => k !== '_note')) {
      expect(sourceLangOfBody(samples[key].description, 'it')).toBe(samples[key].sourceLang);
    }
  });

  it('sourceSlotTitleAndSlug files both under the source language only', () => {
    expect(sourceSlotTitleAndSlug('Teamleiter Logistik', 'teamleiter-logistik-post', 'de')).toEqual({
      titleByLocale: { de: 'Teamleiter Logistik' },
      slugByLocale: { de: 'teamleiter-logistik-post' },
    });
  });

  it.each([
    ['Post.ch', postProcessPostJobs, 'posta-svizzera-centro-regionale', 'La Posta Svizzera', 'https://job.post.ch/default/job/x/1-de_DE'],
    ['PostFinance', postProcessPostFinanceJobs, 'postfinance', 'PostFinance', 'https://job.post.ch/PostFinance/job/x/1/'],
  ])('%s post-process adds a missing source slug slot without dropping the legacy key', (_label, postProcess, companyKey, company, url) => {
    const job = {
      url,
      title: 'Teamleiter Logistik',
      company,
      companyKey,
      location: 'Lugano',
      canton: 'TI',
      sourceLang: 'de',
      description: 'Das ist eine deutsche Stellenbeschreibung fuer die Akzeptanzpruefung.',
      descriptionByLocale: { de: 'Das ist eine deutsche Stellenbeschreibung fuer die Akzeptanzpruefung.' },
      titleByLocale: { de: 'Teamleiter Logistik' },
      slug: 'x',
      slugByLocale: { it: 'x' },
    };

    const [processed] = postProcess([job]);
    expect(processed.slugByLocale).toEqual({ it: 'x', de: 'x' });
  });

  // Main slice: 30 German and 31 French postings, every one with its title
  // under `en` and its slug under `en`/`it`, none under its own language.
  it.each(['swiss-medical-network-de', 'swiss-medical-network-fr'])('swiss-medical-network files the %s posting under its own language', (key) => {
    const sample: Sample = samples[key];
    const job = buildSwissMedicalNetworkJob({ title: sample.title, city: sample.location }, sample.description);
    expect(job.sourceLang).toBe(sample.sourceLang);
    expect(job.titleByLocale).toEqual({ [sample.sourceLang]: sample.title });
    expect(job.slugByLocale).toEqual({ [sample.sourceLang]: job.slug });
    expect(Object.keys(job.descriptionByLocale)).toEqual([sample.sourceLang]);
  });

  it('delvitech returns its source language and keys title, body and slug by it', () => {
    const sample: Sample = samples.delvitech;
    const localized = buildDelvitechLocalizedContent({ title: sample.title, location: sample.location, description: sample.description });
    expect(localized.sourceLang).toBe(sample.sourceLang);
    expect(localized.titleByLocale).toEqual({ [sample.sourceLang]: sample.title });
    expect(localized.descriptionByLocale).toEqual({ [sample.sourceLang]: sample.description });
    // Same slug formula: the value main publishes for this job.
    expect(localized.slugByLocale).toEqual({ [sample.sourceLang]: sample.slugByLocale[sample.sourceLang] });
    expect(localized.slug).toBe(sample.slugByLocale[sample.sourceLang]);
  });

  it('sourceLangOfPosting reads the body first and falls back to a declared site locale', () => {
    expect(sourceLangOfPosting(samples['guess-fr'].description, 'en')).toBe('fr');
    expect(sourceLangOfPosting('', 'de-CH')).toBe('de');
    expect(sourceLangOfPosting('', 'es')).toBe('en');
    expect(sourceLangOfPosting('', '', 'it')).toBe('it');
  });

  it('guess reads the posting language from its body, with the declared one as fallback', () => {
    expect(guessPostingSourceLang({ description: samples['guess-de'].description, sourceLanguage: 'de' })).toBe('de');
    expect(guessPostingSourceLang({ description: samples['guess-fr'].description, sourceLanguage: 'fr' })).toBe('fr');
    // The body wins over a wrong declaration.
    expect(guessPostingSourceLang({ description: samples['guess-fr'].description, sourceLanguage: 'en' })).toBe('fr');
    expect(guessPostingSourceLang({ description: '', sourceLanguage: 'de' })).toBe('de');
    expect(guessPostingSourceLang({ description: '', sourceLanguage: 'es' })).toBe('en');
  });

  // Runners whose job builder runs inside main() (not importable): no title
  // or slug map of theirs may name a fixed locale again, and the Post
  // runners no longer force the slug into `it`.
  const runners = [
    'update-bracco-jobs.mjs',
    'update-capri-holdings-jobs.mjs',
    'update-casale-jobs.mjs',
    'update-cler-jobs.mjs',
    'update-debiopharm-jobs.mjs',
    'update-delvitech-jobs.mjs',
    'update-dxt-jobs.mjs',
    'update-fnz-jobs.mjs',
    'update-guess-jobs.mjs',
    'update-hugo-boss-jobs.mjs',
    'update-ist-jobs.mjs',
    'update-julius-baer-jobs.mjs',
    'update-linnea-jobs.mjs',
    'update-mikron-jobs.mjs',
    'update-postch-jobs.mjs',
    'update-postfinance-jobs.mjs',
    'update-sintetica-jobs.mjs',
    'update-swiss-medical-network-jobs.mjs',
    'update-vir-biotechnology-jobs.mjs',
    'lib/delvitech-job-parser.mjs',
  ];
  it.each(runners)('%s keys no title or slug map by a fixed locale', (file) => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', file), 'utf8');
    expect(source).not.toMatch(/(?:title|slug)ByLocale:\s*\{\s*(?:en|it|de|fr)\s*:/);
    expect(source).not.toMatch(/slugByLocale\.it !== job\.slug/);
  });
});
