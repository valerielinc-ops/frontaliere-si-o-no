/**
 * Contract: the job locale hardening of cleanup-jobs.mjs (step 0
 * `hardenJobLocaleFields` + step 0b `repairShortDescriptions`) leaves nothing
 * that the publish gate `validate:translation-completeness` blocks.
 *
 * The gate (`collectBlockingIssues`) stops the publish of the whole site on a
 * single record with a title under 3 chars or a description under 120 chars in
 * one of the four published locales. Before this test nothing tied the two
 * stages to that predicate: the Romansh fallback (PR 11011) arrived only after
 * the gate had already stopped the site. A new slot combination the hardening
 * does not repair must turn into a red test on a PR, not a stopped deploy.
 *
 * If this test fails, the failure title is:
 * «Hardening dei job: una combinazione di slot esce ancora bloccante per il
 * gate di completezza (parser <crawler>)». Fix the GENERATOR (the title
 * fallback in hardenJobLocaleFields, or repairShortDescriptions) — never this
 * matrix and never the gate predicate.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hardenJobLocaleFields } from '../scripts/lib/dedicated-crawler-common.mjs';
import { repairShortDescriptions } from '../scripts/lib/job-locale-slot-repair.mjs';
import { collectBlockingIssues, LOCALES } from '../scripts/validate-translation-completeness.mjs';

type Job = Record<string, any>;

const SOURCE_LANGS = ['it', 'de', 'fr', 'en', 'rm'] as const;
type SourceLang = typeof SOURCE_LANGS[number];

const TITLES: Record<SourceLang, string> = {
  it: 'Ingegnere software senior',
  de: 'Softwareentwickler Backend (m/w/d)',
  fr: 'Ingénieur logiciel confirmé',
  en: 'Senior software engineer',
  rm: 'Redactura / Redactur Surselva',
};

// In-language bodies well above the gate's 120 chars, so the source-language
// detection of the hardening sees the declared language.
const BODIES: Record<SourceLang, string> = {
  it: 'Cerchiamo una persona motivata che si occupi dello sviluppo delle nostre applicazioni. '
    + 'Lavorerai in un gruppo dinamico a Lugano e collaborerai con i colleghi della produzione. '
    + 'Offriamo un contratto a tempo indeterminato e la possibilità di crescere con noi.',
  de: 'Wir suchen eine motivierte Person, die sich um die Entwicklung unserer Anwendungen kümmert. '
    + 'Sie arbeiten in einem dynamischen Team in Zürich und mit den Kolleginnen und Kollegen der Produktion. '
    + 'Wir bieten eine unbefristete Anstellung und die Möglichkeit, mit uns zu wachsen.',
  fr: 'Nous recherchons une personne motivée qui se chargera du développement de nos applications. '
    + 'Vous travaillerez dans une équipe dynamique à Genève avec les collègues de la production. '
    + 'Nous offrons un contrat à durée indéterminée et la possibilité de grandir avec nous.',
  en: 'We are looking for a motivated person who will take care of the development of our applications. '
    + 'You will work in a dynamic team in Basel together with the colleagues from production. '
    + 'We offer a permanent contract and the opportunity to grow with us over the coming years.',
  rm: 'La redacziun coordinescha ils cussegls editorials e publitgescha '
    + 'cuntegn per la Svizra rumantscha. '.repeat(6),
};

// The labels hardenJobLocaleFields writes for an unsupported source language
// (safeUnsupportedSourceTitle): the "fallback already applied" shape.
const GENERIC_TITLES: Record<string, string> = {
  it: 'Posizione',
  en: 'Job opening',
  de: 'Stellenangebot',
  fr: "Offre d'emploi",
};

type TitleShape =
  | 'source-slot-only'
  | 'job-title-only'
  | 'slots-1'
  | 'slots-2'
  | 'slots-3'
  | 'slots-3-without-job-title'
  | 'short-title-usable-elsewhere'
  | 'fallback-applied';
const TITLE_SHAPES: TitleShape[] = [
  'source-slot-only',
  'job-title-only',
  'slots-1',
  'slots-2',
  'slots-3',
  'slots-3-without-job-title',
  'short-title-usable-elsewhere',
  'fallback-applied',
];

type DescriptionShape = 'absent' | 'short' | 'garbage' | 'main-description-only';
const DESCRIPTION_SHAPES: DescriptionShape[] = ['absent', 'short', 'garbage', 'main-description-only'];

const GARBAGE = 'Search by keyword Create Alert Select how often you want to receive alerts. '
  + 'Suche nach Stichwort Benachrichtigung erstellen. Read our cookie policy before you continue. '
  + 'Search by keyword Create Alert.';

function titleFields(lang: SourceLang, shape: TitleShape): Job {
  const title = TITLES[lang];
  const otherPublished = LOCALES.filter((l) => l !== lang);
  const slotsFrom = (n: number) => Object.fromEntries(
    // The source slot first (when it is published), then the others.
    [...(lang === 'rm' ? [] : [lang]), ...otherPublished].slice(0, n).map((l) => [l, title]),
  );
  switch (shape) {
    case 'source-slot-only':
      return { titleByLocale: { [lang]: title } };
    case 'job-title-only':
      return { title, titleByLocale: {} };
    case 'slots-1':
      return { title, titleByLocale: slotsFrom(1) };
    case 'slots-2':
      return { title, titleByLocale: slotsFrom(2) };
    case 'slots-3':
      return { title, titleByLocale: slotsFrom(3) };
    case 'slots-3-without-job-title':
      return { titleByLocale: slotsFrom(3) };
    case 'short-title-usable-elsewhere':
      // A 1-2 char job.title (and source slot, when published) must not shadow
      // the usable title sitting in another slot.
      return {
        title: 'AB',
        titleByLocale: lang === 'rm'
          ? { rm: title }
          : { [lang]: 'AB', [otherPublished[0]]: title },
      };
    case 'fallback-applied':
      return {
        title,
        titleByLocale: lang === 'rm'
          ? { rm: title, ...GENERIC_TITLES }
          : Object.fromEntries(LOCALES.map((l) => [l, title])),
        needsRetranslation: true,
      };
  }
}

function descriptionFields(lang: SourceLang, shape: DescriptionShape): Job {
  switch (shape) {
    case 'absent':
      return { descriptionByLocale: {} };
    case 'short':
      return { description: 'Breve testo.', descriptionByLocale: { [lang]: 'Breve testo.' } };
    case 'garbage':
      return { description: GARBAGE, descriptionByLocale: Object.fromEntries(LOCALES.map((l) => [l, GARBAGE])) };
    case 'main-description-only':
      return { description: BODIES[lang], descriptionByLocale: {} };
  }
}

function buildJob(lang: SourceLang, titleShape: TitleShape, descShape: DescriptionShape): Job {
  const key = `${lang}-${titleShape}-${descShape}`;
  return {
    id: `contract-${key}`,
    url: `https://careers.example.test/jobs/${key}`,
    slug: `contract-${key}`,
    company: 'Acme SA',
    companyKey: 'acme',
    addressLocality: 'Lugano',
    canton: 'TI',
    sourceLang: lang,
    // The shape prepareSrgSsrExistingJobs gives an RTR record.
    ...(lang === 'rm' ? { sourceLangOriginal: 'rm' } : {}),
    ...titleFields(lang, titleShape),
    ...descriptionFields(lang, descShape),
  };
}

function matrix(): Job[] {
  const jobs: Job[] = [];
  for (const lang of SOURCE_LANGS) {
    for (const titleShape of TITLE_SHAPES) {
      for (const descShape of DESCRIPTION_SHAPES) {
        jobs.push(buildJob(lang, titleShape, descShape));
      }
    }
  }
  return jobs;
}

/** Step 0 + 0b of cleanup-jobs.mjs (dataset mode) on a dataset file. */
function hardenAndRepair(jobsPath: string): Job[] {
  hardenJobLocaleFields({ dataJobsPath: jobsPath });
  const hardened = JSON.parse(fs.readFileSync(jobsPath, 'utf-8'));
  const { jobs } = repairShortDescriptions(hardened);
  fs.writeFileSync(jobsPath, `${JSON.stringify(jobs, null, 2)}\n`, 'utf-8');
  return jobs;
}

function blockingCombinations(jobs: Job[]): string[] {
  return [...new Set(collectBlockingIssues(jobs).map((issue: { slug: string }) => issue.slug))].sort();
}

describe('job locale hardening ↔ translation-completeness gate contract', () => {
  let tempDir: string;
  let previousRegistryOverride: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-locale-gate-contract-'));
    // Never read the tracked slug registry: the matrix must not depend on it.
    previousRegistryOverride = process.env.SLUG_REGISTRY_PATH_OVERRIDE;
    process.env.SLUG_REGISTRY_PATH_OVERRIDE = path.join(tempDir, 'no-slug-registry.json');
  });

  afterEach(() => {
    if (previousRegistryOverride === undefined) delete process.env.SLUG_REGISTRY_PATH_OVERRIDE;
    else process.env.SLUG_REGISTRY_PATH_OVERRIDE = previousRegistryOverride;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('leaves no blocking slot for any combination that carries a title somewhere', () => {
    const input = matrix();
    // Sanity: the matrix does exercise the gate before the hardening.
    expect(blockingCombinations(input).length).toBeGreaterThan(0);

    const jobsPath = path.join(tempDir, 'jobs.json');
    fs.writeFileSync(jobsPath, `${JSON.stringify(input, null, 2)}\n`, 'utf-8');
    const out = hardenAndRepair(jobsPath);

    expect(out).toHaveLength(input.length);
    expect(blockingCombinations(out)).toEqual([]);
    expect(collectBlockingIssues(out)).toEqual([]);
  });

  it('flags every repaired combination for retranslation instead of dropping the page', () => {
    const jobsPath = path.join(tempDir, 'jobs.json');
    const input = matrix();
    fs.writeFileSync(jobsPath, `${JSON.stringify(input, null, 2)}\n`, 'utf-8');
    const out = hardenAndRepair(jobsPath);

    const byIdIn = new Map(input.map((job) => [job.id, job]));
    const repairedWithoutFlag = out
      .filter((job) => collectBlockingIssues([byIdIn.get(job.id)]).length > 0)
      .filter((job) => job.needsRetranslation !== true)
      .map((job) => job.id);
    expect(repairedWithoutFlag).toEqual([]);
  });

  it('is idempotent: a second, uncached pass gives the same slots and no blocking issue', () => {
    const firstPath = path.join(tempDir, 'first', 'jobs.json');
    fs.mkdirSync(path.dirname(firstPath), { recursive: true });
    fs.writeFileSync(firstPath, `${JSON.stringify(matrix(), null, 2)}\n`, 'utf-8');
    const first = hardenAndRepair(firstPath);

    // A different path, so the per-process _hardenResultCache of the first
    // pass cannot be what makes the second one a no-op.
    const secondPath = path.join(tempDir, 'second', 'jobs.json');
    fs.mkdirSync(path.dirname(secondPath), { recursive: true });
    fs.copyFileSync(firstPath, secondPath);
    const second = hardenAndRepair(secondPath);

    expect(collectBlockingIssues(second)).toEqual([]);
    const slots = (jobs: Job[]) => jobs.map((job) => ({
      id: job.id,
      sourceLang: job.sourceLang,
      titleByLocale: job.titleByLocale,
      descriptionByLocale: job.descriptionByLocale,
      needsRetranslation: job.needsRetranslation,
    }));
    expect(slots(second)).toEqual(slots(first));
  });

  it('repairShortDescriptions is pure: the input records are not mutated', () => {
    const input = matrix();
    const snapshot = JSON.parse(JSON.stringify(input));
    const { jobs, enriched } = repairShortDescriptions(input);
    expect(enriched).toBeGreaterThan(0);
    expect(input).toEqual(snapshot);
    expect(jobs).not.toBe(input);
    expect(repairShortDescriptions(jobs)).toEqual({ jobs, enriched: 0 });
  });

  it('keeps a record with no title anywhere blocking: no title is invented for a published source', () => {
    const published = SOURCE_LANGS.filter((lang) => lang !== 'rm');
    const input = published.map((lang) => ({
      ...buildJob(lang, 'job-title-only', 'main-description-only'),
      id: `contract-${lang}-no-title`,
      slug: `contract-${lang}-no-title`,
      url: `https://careers.example.test/jobs/${lang}-no-title`,
      title: '',
      titleByLocale: {},
    }));
    const jobsPath = path.join(tempDir, 'jobs.json');
    fs.writeFileSync(jobsPath, `${JSON.stringify(input, null, 2)}\n`, 'utf-8');
    const out = hardenAndRepair(jobsPath);

    for (const job of out) {
      const titleIssues = collectBlockingIssues([job])
        .filter((issue: { reason: string }) => issue.reason.startsWith('missing/short title'))
        .map((issue: { locale: string }) => issue.locale)
        .sort();
      expect(titleIssues, job.slug).toEqual([...LOCALES].sort());
    }
  });
});
