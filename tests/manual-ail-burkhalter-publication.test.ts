import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sourcePostingDateFields, mergeSourcePostingDates } from '../scripts/lib/source-posting-date.mjs';
import { mergeBurkhalterRecord } from '../scripts/lib/burkhalter-job-parser.mjs';
function declaration(file: string, name: string, deps: Record<string, unknown>, variable = false) {
  const tree = ts.createSourceFile(file, readFileSync(new URL(`../scripts/update-${file}-jobs.mjs`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let code = '';
  function visit(node: ts.Node) {
    if (!variable && ts.isFunctionDeclaration(node) && node.name?.text === name) code = node.getText(tree).replace(/^export\s+/, '');
    if (variable && ts.isVariableDeclaration(node) && node.name.getText(tree) === name) code = node.initializer!.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree); if (!code) throw new Error(`Missing ${name}`);
  return new Function(...Object.keys(deps), `return (${code});`)(...Object.values(deps));
}
const unknown = { datePosted: '', postedDate: '', postingDateSource: 'unknown' };
const common = { sourcePostingDateFields, mergeSourcePostingDates, COMPANY_NAME: 'Employer', COMPANY_KEY: 'employer', HQ: { canton: 'TI' }, mergeLocaleTextMap: (a: object, b: object) => ({ ...a, ...b }) };
beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout'] }));
afterEach(() => vi.useRealTimers());
for (const kind of ['valid', 'missing', 'invalid', 'future', 'deadline-only', 'long-year', 'year-suffix'] as const) {
  it(`AIL real listing and discovery ${kind}`, async () => {
    const year = new Date().getUTCFullYear() - 1;
    const date = kind === 'valid' ? `15 giugno ${year}` : kind === 'invalid' ? `31 aprile ${year}` : `${year + 3}`;
    const dateLabel = kind === 'future' ? `15 giugno ${year + 3}` : kind === 'long-year' ? `15 giugno ${year}0` : kind === 'year-suffix' ? `15 giugno ${year}junk` : date;
    const html = `<article class="job-position"><h4>Tecnico</h4>${['missing', 'deadline-only'].includes(kind) ? '' : `Data di pubblicazione <span>${dateLabel}</span>`}Data di chiusura <span>15 giugno ${year + 3}</span></article>`;
    const normalizeSpace = (s: string) => String(s).replace(/\s+/g, ' ').trim();
    const parseItalianDate = declaration('ail', 'parseItalianDate', { ITALIAN_MONTHS: { giugno: '06', aprile: '04' } });
    const parseListingPage = declaration('ail', 'parseListingPage', { ...common, parseItalianDate, normalizeSpace, decodeHtmlEntities: (s: string) => s, BASE_URL: 'https://ail.ch', CAREERS_URL: 'https://ail.ch/jobs' });
    const producer = declaration('ail', 'fetchAilJobs', { ...common, parseListingPage, AJAX_URL: 'https://ail.ch/ajax', CAREERS_URL: 'https://ail.ch/jobs', fetchPage: async () => html, buildAilDescriptionFields: () => ({ description: '', descriptionByLocale: {}, sourceLang: 'it' }), slugify: () => 'tecnico', detectCategory: () => 'engineering', detectEmploymentType: () => 'full-time', detectExperienceLevel: () => 'mid' });
    const pending = producer(); await vi.runAllTimersAsync(); const jobs = await pending;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject(kind === 'valid' ? { datePosted: `${year}-06-15`, postedDate: `${year}-06-15`, postingDateSource: 'reported' } : unknown);
    expect(jobs[0].validThrough).toBe(`${year + 3}-06-15`);
    expect(jobs[0].crawledAt).toBeTruthy();
  });
}
for (const issueDate of [undefined, 1700000000, 'invalid']) {
  it(`Burkhalter issueDate ${issueDate} is not proven publication`, () => {
    const build = declaration('burkhalter', 'buildJob', { ...common, COMPANY_DOMAIN: 'burkhalter.ch', BASE_URL: 'https://burkhalter.ch', mapCanton: () => 'TI', slugify: () => 'job', safeLocationToken: (v: string) => v, detectLang: () => 'de' });
    expect(build({ job: 'Techniker', city: 'Lugano', issueDate }, 'Original source description')).toMatchObject({ ...unknown, description: 'Original source description', crawledAt: expect.any(String) });
  });
}
for (const name of ['ail', 'burkhalter']) {
  for (const reported of [false, true]) {
    it(`${name} actual persistence ${reported ? 'retains reported' : 'clears legacy'}`, () => {
      const date = `${new Date().getUTCFullYear() - 1}-01-01`;
      const prev = { datePosted: date, postedDate: date, ...(reported ? { postingDateSource: 'reported' } : {}), description: 'Stored original source body with full vacancy responsibilities and requirements. '.repeat(8), sourceLang: 'de' };
      const fresh = { ...unknown, description: 'Fresh original source body with full vacancy responsibilities and requirements. '.repeat(8), sourceLang: 'de', crawledAt: new Date().toISOString() };
      const result = name === 'ail' ? declaration('ail', 'updatedJob', { ...common, ex: prev, discovered: fresh }, true) : mergeBurkhalterRecord(prev, fresh, declaration('burkhalter', 'mergeLocales', common, true));
      expect(result).toMatchObject(reported ? { datePosted: date, postedDate: date, postingDateSource: 'reported' } : unknown);
      expect(result.crawledAt).toBe(fresh.crawledAt);
    });
  }
}
