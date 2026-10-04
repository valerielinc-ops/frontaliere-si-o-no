import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { annualReportPlugin } from '../../build-plugins/annualReportPlugin';

// jsdom is an existing dependency without bundled TypeScript declarations.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: { document: Document; close(): void } };
};

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// A historical edition's observation year is fixed, not an expiry fixture.
const year = 2026;
const validJob = {
  sector: 'Engineering', canton: 'TI', location: 'Lugano',
  salaryMin: 80_000, salaryMax: 100_000, currency: 'CHF',
  salarySource: 'reported', salaryPeriod: 'YEAR', datePosted: `${year}-06-15`,
};

async function emit(jobs?: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'annual-report-statistics-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'data'));
  if (jobs !== undefined) fs.writeFileSync(path.join(root, 'data/jobs.json'), JSON.stringify(jobs));
  vi.stubEnv('SKIP_ANNUAL_REPORT', '0');
  await (annualReportPlugin(root).closeBundle as () => Promise<void>)();
  const xml = fs.readFileSync(path.join(root, 'dist/sitemap-annual-report.xml'), 'utf8');
  const pages = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => {
    const url = new URL(match[1]);
    const html = fs.readFileSync(path.join(root, 'dist', url.pathname, 'index.html'), 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const dataset = [...doc.querySelectorAll('script[type="application/ld+json"]')]
      .map((el) => JSON.parse(el.textContent || '{}'))
      .find((entry) => entry['@type'] === 'Dataset');
    const text = doc.body.textContent;
    dom.window.close();
    return { html, text, dataset };
  });
  return { pages, csv: fs.readFileSync(path.join(root, 'dist/data/jobs-salary-aggregate.csv'), 'utf8') };
}

describe('annual report statistics provenance', () => {
  it('uses only reported annual CHF observations from the report year and canton in HTML, schema and CSV', async () => {
    const eligible = Array.from({ length: 12 }, (_, i) => ({ ...validJob, id: `valid-${i}` }));
    const excluded = [
      { salarySource: 'estimated' }, { salarySource: 'existing' }, { salarySource: undefined },
      { currency: 'EUR' }, { currency: undefined }, { salaryPeriod: 'MONTH' },
      { salaryPeriod: undefined }, { datePosted: `${year - 1}-06-15` },
      { datePosted: undefined }, { datePosted: 'invalid' }, { datePosted: `${year}-02-31` }, { canton: 'ZH' },
      { baseSalary: { value: { unitText: 'MONTH' } } },
      { salaryMin: 4000, salaryMax: 6000 }, { salaryMin: 110_000, salaryMax: 100_000 },
      { salaryMax: 900_000 },
    ].map((change, i) => ({ ...validJob, id: `excluded-${i}`, ...change }));
    const { pages, csv } = await emit([...eligible, ...excluded]);
    expect(pages).toHaveLength(4);
    expect(csv).toContain('overall,All sectors,12,90000,90000,,');
    expect(csv).toContain('sector,"Engineering",12,90000,90000,90000,90000');
    expect(csv).toContain('region,"Lugano",12,90000,90000,,');
    for (const { text, dataset } of pages) {
      expect(dataset.variableMeasured.map((entry: { value: number }) => entry.value)).toEqual([90000, 12]);
      expect(dataset.variableMeasured.some((entry: { unitText?: string }) => entry.unitText === 'percent')).toBe(false);
      expect(text).not.toMatch(/3\.2%|1\.7-2\.2|95\s*%|bimodal|7-10\s*%|1\.25|duemila|thousand|zweitausend|deux mille/);
    }
  });

  it('publishes unavailable values instead of invented salaries or growth when no observations qualify', async () => {
    const { pages, csv } = await emit([{ ...validJob, salarySource: 'estimated' }]);
    expect(csv).toContain('overall,All sectors,0,,,,');
    expect(pages).toHaveLength(4);
    for (const { text, dataset } of pages) {
      expect(dataset.variableMeasured).toHaveLength(1);
      expect(dataset.variableMeasured[0].value).toBe(0);
      expect(text).not.toContain('CHF 0');
      expect(text).toMatch(/Non disponibile|Non disponible|Not available|Nicht verfügbar/);
    }
  });

  it.each([undefined, { invalid: 'not an array' }, [{ canton: 7 }], [validJob, { ...validJob, company: 12 }]])('does not report zero observations for unavailable source %j', async (source) => {
    const { pages, csv } = await emit(source);
    expect(csv).toContain('overall,All sectors,,,,,');
    for (const { dataset } of pages) expect(dataset.variableMeasured).toEqual([]);
  });

  it('keeps the report available for an empty source without numerical salary measurements', async () => {
    const { pages, csv } = await emit([]);
    expect(pages).toHaveLength(4);
    expect(csv).toContain('overall,All sectors,0,,,,');
    for (const { dataset } of pages) expect(dataset.variableMeasured).toHaveLength(1);
  });

  it('honours an explicit structured annual period and does not require a sector-sized overall sample', async () => {
    const { pages, csv } = await emit([{ ...validJob, salaryPeriod: undefined, baseSalary: { value: { unitText: 'YEAR' } } }]);
    expect(csv).toContain('overall,All sectors,1,90000,90000,,');
    expect(csv).not.toContain('sector,"Engineering"');
    expect(pages[0].dataset.variableMeasured[1].value).toBe(1);
  });
});
