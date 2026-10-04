import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { sourcePostingDateFields, sourceRssPostingDateFields, mergeSourcePostingDates } from '../scripts/lib/source-posting-date.mjs';
import { parseTplListingPage } from '../scripts/lib/tpl-lugano-job-parser.mjs';
import { buildTplJobRow, mergeTplJobRows, buildTplAdapterSeedFields } from '../scripts/update-tpl-lugano-jobs.mjs';
import { normalizeSmnApiPosting } from '../scripts/lib/swiss-medical-network-job-parser.mjs';
import { buildJobFromApi as buildSmnJob } from '../scripts/update-swiss-medical-network-jobs.mjs';
import { parseMticDetailPage } from '../scripts/lib/mtic-job-parser.mjs';
import { parseGreenhouseJobs } from '../scripts/lib/vir-biotechnology-job-parser.mjs';
import { parseAtomEntries, parseRssItems } from '../scripts/lib/stadt-chur-feed-parser.mjs';
import { buildJob as buildChurJob } from '../scripts/update-stadt-chur-jobs.mjs';

const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };

// Legacy CLI runners execute main on import. Load their actual declarations,
// with I/O dependencies injected, so the test never contacts an employer or writes the dataset.
function declaration(file: string, name: string, dependencies: Record<string, unknown> = {}) {
  const source = readFileSync(new URL(`../scripts/${file}`, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = tree.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!node) throw new Error(`Missing declaration ${name}`);
  return new Function(...Object.keys(dependencies), `return (${node.getText(tree).replace(/^export\s+/, '')});`)(...Object.values(dependencies));
}

describe('source publication dates across crawler families', () => {
  it('carries a public SmartRecruiters release through normalization without using modification time', () => {
    const releasedDate = new Date(Date.now() - 7 * 86400000).toISOString();
    const raw = { id: '123', name: 'Infirmier', location: { city: 'Lugano', country: 'CH' }, releasedDate };
    expect(buildSmnJob(normalizeSmnApiPosting(raw), 'Texte du poste')).toMatchObject({ datePosted: releasedDate, postedDate: releasedDate, postingDateSource: 'reported' });
    expect(buildSmnJob(normalizeSmnApiPosting({ ...raw, releasedDate: '', updatedAt: releasedDate }), 'Texte du poste')).toMatchObject(unknown);
  });

  it('reads the TPL publication column, never its adjacent closing date, through build and adapter', () => {
    const date = daysAgo(5);
    const [year, month, day] = date.split('-');
    const months = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
    const html = `<div class="col-md-12"><div>Data pubblicazione</div><div>Data scadenza</div><div>Posizione</div></div>
      <div class="col-md-12"><div>${day} ${months[Number(month) - 1]} ${year}</div><div>31 dicembre ${new Date().getUTCFullYear() + 2}</div><div><a href="/2/50/candidati/?idhr=769">Addetto rimessa</a></div></div>`;
    const listed = parseTplListingPage(html)[0];
    const source = { ...listed, body: 'Mansioni e requisiti dichiarati nella fonte per la posizione di addetto rimessa.' };
    expect(buildTplJobRow(source)).toMatchObject({ datePosted: date, postedDate: date, postingDateSource: 'reported' });
    expect(buildTplAdapterSeedFields([source]).seedMetaByUrl[source.url]).toMatchObject({ datePosted: date, postingDateSource: 'reported' });
    expect(buildTplJobRow({ ...source, datePosted: '' })).toMatchObject(unknown);
    expect(parseTplListingPage(html.replace('Data pubblicazione', 'Data aggiornamento'))[0].datePosted).toBeUndefined();
  });

  it('clears an unproven legacy TPL date, retains a reported one on source loss, and accepts new source evidence', () => {
    const source = { url: 'https://www.tplsa.ch/2/50/candidati/?idhr=769', title: 'Addetto rimessa', body: 'Mansioni e requisiti della posizione.' };
    const legacy = { ...buildTplJobRow(source), postedDate: daysAgo(20), datePosted: daysAgo(20), postingDateSource: undefined };
    expect(mergeTplJobRows([source], [legacy]).jobs[0]).toMatchObject(unknown);
    const reported = { ...legacy, ...sourcePostingDateFields(daysAgo(10)) };
    expect(mergeTplJobRows([source], [reported]).jobs[0]).toMatchObject({ postedDate: daysAgo(10), postingDateSource: 'reported' });
    expect(mergeTplJobRows([{ ...source, datePosted: daysAgo(3) }], [legacy]).jobs[0]).toMatchObject({ postedDate: daysAgo(3), postingDateSource: 'reported' });
  });

  it('does not promote MTIC parser-generated collection time or Greenhouse modification time', () => {
    const mtic = parseMticDetailPage('<div class="content_main"><h2>Auditor</h2><div class="frame-type-text">Lugano, requisiti e mansioni.</div></div>');
    expect(sourcePostingDateFields(mtic.datePosted)).toEqual(unknown);
    const base = { id: 123, title: 'Scientist', absolute_url: 'https://job-boards.greenhouse.io/virbiotechnologyinc/jobs/123', location: { name: 'Bellinzona, Switzerland' }, content: 'Source description', updated_at: daysAgo(1) };
    expect(parseGreenhouseJobs({ jobs: [base] })[0].datePosted).toBe('');
    expect(parseGreenhouseJobs({ jobs: [{ ...base, first_published: daysAgo(7) }] })[0].datePosted).toBe(daysAgo(7));
  });

  it('keeps genuine RSS/Atom publication dates while refusing Atom updated-only feeds', () => {
    const published = daysAgo(6);
    const updated = daysAgo(1);
    const entry = `<title>Informatiker</title><link href="https://jobs.chur.ch/test-de-j123.html"/><summary>${'Aufgaben '.repeat(60)}</summary>`;
    const [atom] = parseAtomEntries(`<feed><entry>${entry}<published>${published}</published><updated>${updated}</updated></entry></feed>`);
    expect(buildChurJob(atom)).toMatchObject({ postedDate: published, postingDateSource: 'reported' });
    const [modifiedOnly] = parseAtomEntries(`<feed><entry>${entry}<updated>${updated}</updated></entry></feed>`);
    expect(buildChurJob(modifiedOnly)).toMatchObject(unknown);
    const [rss] = parseRssItems(`<rss><channel><item><title>Informatiker</title><link>https://jobs.chur.ch/test-de-j123.html</link><description>${'Aufgaben '.repeat(60)}</description><pubDate>${new Date(published).toUTCString()}</pubDate></item></channel></rss>`);
    expect(buildChurJob(rss)).toMatchObject({ postedDate: `${published}T00:00:00Z`, postingDateSource: 'reported' });
  });

  it('normalizes actual RSS dates without inventing a date for missing or invalid pubDate', () => {
    const parseDate = declaration('update-mkspamp-jobs.mjs', 'parseDate', { sourceRssPostingDateFields });
    expect(sourcePostingDateFields(parseDate(new Date(daysAgo(4)).toUTCString()))).toMatchObject({ postedDate: `${daysAgo(4)}T00:00:00Z`, postingDateSource: 'reported' });
    for (const raw of ['', 'invalid']) expect(sourcePostingDateFields(parseDate(raw))).toEqual(unknown);
  });

  it('validates original timestamps before truncation or calendar rollover in RSS, Atom, Greenhouse and Workday', () => {
    const today = daysAgo(0);
    const year = new Date().getUTCFullYear();
    const now = new Date(`${today}T12:00:00Z`);
    const parseDate = declaration('update-mkspamp-jobs.mjs', 'parseDate', { sourceRssPostingDateFields });
    const enrichTrumpf = declaration('update-trumpf-jobs.mjs', 'enrichJobFromDetail', {
      stripHtml: String, detectLang: () => 'de', mapEmploymentType: () => 'full-time',
      COMPANY_NAME: 'TRUMPF', sourcePostingDateFields,
    });
    const base = { id: 123, title: 'Scientist', absolute_url: 'https://job-boards.greenhouse.io/virbiotechnologyinc/jobs/123', location: { name: 'Bellinzona, Switzerland' }, content: 'Source description' };
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      for (const raw of [`${today}T23:00:00Z`, `${year}-02-30T01:00:00Z`, `${today}Tmalformed`]) {
        expect(buildChurJob({ title: 'Informatiker', link: 'https://jobs.chur.ch/test-de-j123.html', updated: raw })).toMatchObject(unknown);
        expect(sourcePostingDateFields(parseGreenhouseJobs({ jobs: [{ ...base, first_published: raw }] })[0].datePosted)).toEqual(unknown);
        expect(enrichTrumpf({ title: 'Engineer' }, { jobPostingInfo: { startDate: raw } })).toMatchObject(unknown);
      }
      expect(parseDate(new Date(`${today}T23:00:00Z`).toUTCString())).toBe('');
      expect(parseDate(`30 Feb ${year} 01:00:00 GMT`)).toBe('');
      const previousDay = new Date(now.getTime() - 86400000).toISOString().slice(0, 10);
      const offsetSource = `${previousDay}T23:30:00-02:00`;
      expect(buildChurJob({ title: 'Informatiker', link: 'https://jobs.chur.ch/test-de-j123.html', updated: offsetSource })).toMatchObject({ datePosted: offsetSource, postingDateSource: 'reported' });
      const rssDate = new Date(`${previousDay}T00:00:00Z`).toUTCString().replace('00:00:00 GMT', '23:30:00 -0200');
      expect(parseDate(rssDate)).toBe(offsetSource);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not interpret Lever record creation or modification as original publication', () => {
    const localized = Object.fromEntries(['it', 'en', 'de', 'fr'].map((locale) => [locale, { title: 'Engineer', slug: 'engineer', description: 'Source description' }]));
    const build = declaration('update-tsmg-jobs.mjs', 'buildJob', {
      buildTsmgLocalizedContent: () => localized, inferTsmgRegion: () => ({ canton: 'TI', country: 'CH' }),
      appendSlugDisambiguator: (slug: string) => slug, inferTsmgCategory: () => 'engineering', normalize: String,
      COMPANY_NAME: 'TSMG', COMPANY_KEY: 'tsmg', COMPANY_DOMAIN: 'tsmg.com', sourcePostingDateFields,
    });
    expect(build({ id: 'abc', text: 'Engineer', categories: { location: 'Lugano' }, createdAt: Date.now() - 86400000, updatedAt: Date.now() })).toMatchObject(unknown);
  });

  it('custom spread mergers preserve evidence together and never retain an unmarked date', () => {
    const url = 'https://jobs.lever.co/tsmg/fixture';
    let existing: object[] = [];
    let written: Record<string, unknown>[] = [];
    const merge = declaration('update-tsmg-jobs.mjs', 'mergeJobs', {
      readExistingCrawlerJobs: () => existing, COMPANY_KEY: 'tsmg', DATA_JOBS: 'scratch', PUBLIC_JOBS: 'scratch-public',
      isTargetJob: () => true, snapshotJobSlugs: () => new Map(), jobMatchKey: (job: { url: string }) => job.url,
      mergeLocaleTextMap: (before: unknown, after: unknown) => after || before, captureLostSlugs: () => {},
      writeJson: (_path: string, jobs: Record<string, unknown>[]) => { written = jobs; },
      computeCrawlDiff: () => ({}), printCrawlChangeSummary: () => {}, writeCrawlChangeSummaryToGH: () => {}, writeJobsSummary: () => {}, printPublishedJobUrls: () => {},
      mergeSourcePostingDates,
    });
    const fresh = { url, ...unknown, titleByLocale: {}, descriptionByLocale: {}, slugByLocale: {} };
    existing = [{ ...fresh, postedDate: daysAgo(20), datePosted: daysAgo(20), postingDateSource: undefined }];
    merge([fresh]);
    expect(written[0]).toMatchObject(unknown);
    existing = [{ ...fresh, ...sourcePostingDateFields(daysAgo(20)) }];
    merge([fresh]);
    expect(written[0]).toMatchObject({ postedDate: daysAgo(20), postingDateSource: 'reported' });
  });
});
