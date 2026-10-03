import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { sourcePostingDateFields, mergeSourcePostingDates } from '../scripts/lib/source-posting-date.mjs';
import { mergePreserveLocaleData } from '../scripts/lib/dedicated-crawler-common.mjs';
import { parseHitachiEnergyListingJson } from '../scripts/lib/hitachi-energy-job-parser.mjs';
import { parseEngelvoelkersDetailPage } from '../scripts/lib/engelvoelkers-job-parser.mjs';
import { parseKsgrApiJob } from '../scripts/lib/ksgr-job-parser.mjs';

type Job = Record<string, unknown>;
type Builder = (input: Job) => Job;
const noop = () => undefined;
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

// Run the actual crawler function without invoking its network/main entry point.
// Only unrelated company/location and I/O dependencies are replaced.
function isolatedFunction<T>(file: string, name: string, dependencies: Record<string, unknown> = {}): T {
  const filename = path.resolve(import.meta.dirname, '../scripts', file);
  const source = fs.readFileSync(filename, 'utf8');
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const declaration = ast.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing crawler function ${file}:${name}`);
  const context = vm.createContext({
    sourcePostingDateFields, mergeSourcePostingDates, console: { log: noop, warn: noop }, ...dependencies,
  });
  return vm.runInContext(`(${declaration.getText(ast).replace(/^export\s+/, '')})`, context) as T;
}

function expectUnknown(job: Job) {
  expect(job).toMatchObject({ postedDate: '', datePosted: '', postingDateSource: 'unknown' });
}

describe('crawler publication evidence at source and merge boundaries', () => {
  it('does not turn absent parser timestamps or modification time into publication', () => {
    expect(parseHitachiEnergyListingJson({ items: [{ title: 'Engineer', url: '/details/JID3-123' }] })[0].publicationDate).toBe('');
    expect(parseEngelvoelkersDetailPage('<h1>Sales consultant</h1>').datePosted).toBe('');
    const job = parseKsgrApiJob({ links: { directlink: 'https://jobs.ksgr.ch/job/123' }, last_modification_timestamp: daysAgo(2) });
    expect(job?.postedDate).toBe('');
    expect(parseKsgrApiJob({ links: { directlink: 'https://jobs.ksgr.ch/job/123' }, start_date: '2025-02-30' })?.postedDate).toBe('');
  });

  it('preserves the exact reported timestamp in the upstream Hitachi parser', () => {
    const publicationDate = new Date(Date.now() - 86400000).toISOString();
    expect(parseHitachiEnergyListingJson({ items: [{ title: 'Engineer', url: '/details/JID3-123', publicationDate }] })[0].publicationDate).toBe(publicationDate);
  });

  it('Fust seed dates stay unknown when absent, malformed or future', () => {
    const build = isolatedFunction<Builder>('update-fust-jobs.mjs', 'buildSeedMetaFromApiJob', {
      normalizeCantonCode: () => 'ZH', preferLocationEncodedCanton: () => 'ZH', cantonLabel: () => 'Zürich',
    });
    for (const date of [undefined, 'not-a-date', '2025-02-30', daysAgo(-2)]) expectUnknown(build({ date }));
    const date = daysAgo(7);
    expect(build({ datePosted: date })).toMatchObject({ postedDate: date, datePosted: date, postingDateSource: 'reported' });
  });

  it('HAS keeps the complete source year and rejects trailing junk', () => {
    const parseDate = isolatedFunction<(raw: string) => string>('update-has-healthcare-jobs.mjs', 'parseDate');
    const iso = daysAgo(10);
    const [year, month, day] = iso.split('-');
    expect(parseDate(`${day}.${month}.${year}`)).toBe(iso);
    expect(parseDate(`${day}.${month}.${year.slice(-2)}`)).toBe(iso);
    expect(parseDate(`${day}.${month}.${year}extra`)).toBe('');
    expect(parseDate(`prefix${day}.${month}.${year}`)).toBe('');
  });

  it('never treats a Kempinski application deadline as publication', () => {
    const build = isolatedFunction<Builder>('update-kempinski-jobs.mjs', 'buildJob', {
      detectCanton: () => 'GR', slugify: String, stripHtml: String, detectLang: () => 'en',
      mapEmploymentType: () => 'full-time', mapContractType: () => 'permanent',
      COMPANY_NAME: 'Kempinski', COMPANY_KEY: 'kempinski', COMPANY_DOMAIN: 'kempinski.com',
    });
    expectUnknown(build({ title: 'Receptionist', deadline_at: daysAgo(7), id: '123' }));
  });

  it('CSOD reads the source publication date but ignores employment start and creation dates', () => {
    const build = isolatedFunction<Builder>('update-groupe-mutuel-jobs.mjs', 'parseCsodJob', {
      normalizeSpace: String, stripHtml: String, parseCsodLocation: String,
      inferCanton: () => 'VS', buildPublicUrl: (id: string) => `https://example.test/${id}/`,
      groupeMutuelSourceContent: () => ({ description: 'Source body', sourceLang: 'fr' }),
      slugify: String, detectEmploymentType: () => 'full-time', detectCategory: () => 'insurance',
      detectExperienceLevel: () => 'mid', GROUPE_MUTUEL_COMPANY_NAME: 'Groupe Mutuel', GROUPE_MUTUEL_KEY: 'groupe-mutuel',
    });
    const base = { title: 'Conseiller', city: 'Sion', id: '123' };
    expectUnknown(build({ ...base, startDate: daysAgo(2), createdDate: daysAgo(3) }));
    const iso = daysAgo(8);
    const [year, month, day] = iso.split('-');
    expect(build({ ...base, postingEffectiveDate: `${day}/${month}/${year}` })).toMatchObject({
      postedDate: iso, datePosted: iso, postingDateSource: 'reported',
    });
  });

  it('shared crawler merge cannot promote an older legacy date or lose a reported date', () => {
    const base = { url: 'https://example.test/job/123456/', title: 'Engineer', sourceLang: 'en' };
    const oldDate = daysAgo(14);
    const freshDate = daysAgo(3);
    const oldLegacy = { ...base, postedDate: oldDate, datePosted: oldDate };
    const freshReported = { ...base, ...sourcePostingDateFields(freshDate) };
    expect(mergePreserveLocaleData([oldLegacy], [freshReported])[0]).toMatchObject(sourcePostingDateFields(freshDate));
    const oldReported = { ...base, ...sourcePostingDateFields(oldDate) };
    const freshUnknown = { ...base, ...sourcePostingDateFields() };
    expect(mergePreserveLocaleData([oldReported], [freshUnknown])[0]).toMatchObject(sourcePostingDateFields(oldDate));
  });

  it.each(['legacy', 'reported'] as const)('custom merge and adapter projection preserve %s provenance atomically', (kind) => {
    const date = daysAgo(14);
    const previous = { url: 'https://example.test/job/1/', ...(kind === 'reported'
      ? sourcePostingDateFields(date) : { postedDate: date, datePosted: date }) };
    const fresh = { url: previous.url, ...sourcePostingDateFields() };
    const writes: unknown[] = [];
    const merge = isolatedFunction<(jobs: Job[]) => unknown>('update-delvitech-jobs.mjs', 'mergeJobs', {
      readExistingCrawlerJobs: () => [previous], isTargetJob: () => true,
      jobMatchKey: (job: Job) => job.url, snapshotJobSlugs: () => [],
      mergeLocaleTextMap: () => ({}), dropStaleLocaleDescriptions: noop, captureLostSlugs: noop,
      writeJson: (_target: string, jobs: unknown) => writes.push(jobs),
      computeCrawlDiff: () => ({}), printCrawlChangeSummary: noop, writeCrawlChangeSummaryToGH: noop,
      writeJobsSummary: noop, printPublishedJobUrls: noop,
      COMPANY_KEY: 'delvitech', DATA_JOBS: '/unused-data', PUBLIC_JOBS: '/unused-public',
    });
    merge([fresh]);
    const result = (writes[0] as Job[])[0];
    if (kind === 'reported') expect(result).toMatchObject(sourcePostingDateFields(date));
    else expectUnknown(result);
    let adapter: { seedMetaByUrl: Record<string, Job> } | undefined;
    const project = isolatedFunction<(jobs: Job[]) => unknown>('update-delvitech-jobs.mjs', 'updateAdapterConfig', {
      writeJson: (_target: string, value: typeof adapter) => { adapter = value; },
      DEFAULT_CANTON: 'TI', COMPANY_NAME: 'Delvitech', COMPANY_KEY: 'delvitech',
      COMPANY_HOST: 'delvi.tech', CAREERS_URL: 'https://delvi.tech/careers/', ADAPTER_PATH: '/unused-adapter',
    });
    project([result]);
    expect(adapter?.seedMetaByUrl[previous.url]).toMatchObject({
      postedDate: result.postedDate, datePosted: result.datePosted, postingDateSource: result.postingDateSource,
    });
  });
});
