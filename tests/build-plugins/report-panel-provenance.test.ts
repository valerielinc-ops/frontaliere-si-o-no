import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { isReportYearJob, loadReportJobPanel } from '../../build-plugins/shared/reportJobPanel';
import { marketReportPlugin } from '../../build-plugins/marketReportPlugin';
import { aggregateSalaryBySector } from '../../build-plugins/comparisonsHubAggregate';
import { comparisonsHubPlugin } from '../../build-plugins/comparisonsHubPlugin';
import { buildComparisonsHubPath } from '../../build-plugins/comparisonsHubData';

// jsdom is an existing dependency without bundled TypeScript declarations.
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
  JSDOM: new (html: string) => { window: { document: Document; close(): void } };
};

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const job = {
  canton: 'TI', datePosted: '2026-06-15', company: 'Reported employer', location: 'Lugano',
  salaryMin: 80_000, salaryMax: 100_000, currency: 'CHF', salarySource: 'reported', salaryPeriod: 'YEAR',
};

async function emit(jobs?: object[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'market-report-provenance-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'data'));
  if (jobs) fs.writeFileSync(path.join(root, 'data/jobs.json'), JSON.stringify(jobs));
  // Deliberately contradictory aggregate: the report must never trust its pay or counts.
  fs.writeFileSync(path.join(root, 'data/jobs-stats.json'), JSON.stringify({
    totals: { activeJobs: 9999, activeCompanies: 999 },
    salary: { coverage: { avgMid: 250000 }, leaders: { topSalaryCompanies: [{ name: 'Invented employer', count: 99, avgMid: 250000 }] } },
  }));
  vi.stubEnv('SKIP_MARKET_REPORT', '0');
  await (marketReportPlugin(root).closeBundle as () => Promise<void>)();
  const xml = fs.readFileSync(path.join(root, 'dist/sitemap-market-report.xml'), 'utf8');
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => {
    const html = fs.readFileSync(path.join(root, 'dist', new URL(match[1]).pathname, 'index.html'), 'utf8');
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const dataset = [...doc.querySelectorAll('script[type="application/ld+json"]')]
      .map((script) => JSON.parse(script.textContent || '{}')).find((entry) => entry['@type'] === 'Dataset');
    const text = doc.body.textContent;
    dom.window.close();
    return { text, dataset };
  });
}

describe('report panel provenance', () => {
  it.each(['2026-06-15T00:00:00+02:00', '2026-06-15T23:00:00-02:00', '2026-01-01T00:00:00+02:00'])(
    'accepts the source calendar year with valid timezone offsets: %s', (datePosted) => {
      expect(isReportYearJob({ ...job, datePosted }, 2026)).toBe(true);
    },
  );
  it.each(['2026-02-31', '2025-12-31T23:00:00-02:00', 'invalid'])(
    'rejects impossible dates and other source calendar years: %s', (datePosted) => {
      expect(isReportYearJob({ ...job, datePosted }, 2026)).toBe(false);
    },
  );
  it('derives Ticino counts and salary averages from the same raw observation panel in four locales', async () => {
    const pages = await emit([
      ...Array.from({ length: 3 }, (_, i) => ({ ...job, id: `reported-${i}` })),
      { ...job, company: 'Estimated employer', salarySource: 'estimated', salaryMin: 200000, salaryMax: 300000 },
      { ...job, company: 'Unknown employer', salarySource: 'existing' },
      { ...job, canton: 'ZH', company: 'Zurich employer' },
      { ...job, datePosted: '2025-06-15', company: 'Old employer' },
    ]);
    expect(pages).toHaveLength(4);
    for (const { text, dataset } of pages) {
      expect(dataset.variableMeasured.map((entry: { value: number }) => entry.value)).toEqual([5, 3, 90000]);
      expect(text).toContain('Reported employer');
      expect(text).not.toMatch(/Invented employer|Zurich employer|Old employer|bimodal|12[–-]18\s*%|300[–-]400|100\s*%/);
      expect(text).toContain('N/D');
    }
  });
  it.each([{ canton: 7 }, { ...job, salaryPeriod: 12 }, { ...job, company: 12 }, { ...job, location: 12 }, { ...job, sector: 12 }, { ...job, baseSalary: { value: { unitText: 12 } } }])('treats a corrupt row as unavailable rather than a valid empty panel: %j', async (invalid) => {
    const pages = await emit([job, invalid]);
    expect(pages).toHaveLength(4);
    for (const { dataset } of pages) expect(dataset.variableMeasured).toEqual([]);
  });
  it('omits unobserved counts and salaries instead of trusting aggregate fallback data', async () => {
    const pages = await emit();
    for (const { text, dataset } of pages) {
      expect(dataset.variableMeasured).toEqual([]);
      expect(text).not.toContain('Invented employer');
      expect(text).toContain('N/D');
    }
  });
});


describe('comparison hub uses observed salaries without synthetic Italian pairing', () => {
  it('keeps the same annual panel, leaves Italian values unavailable and does not fabricate tax percentages', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comparisons-salary-provenance-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'data'));
    fs.mkdirSync(path.join(root, 'dist'));
    const valid = { ...job, sector: 'Engineering' };
    const jobs = [
      ...Array.from({ length: 12 }, (_, i) => ({ ...valid, id: `valid-${i}` })),
      { ...valid, salarySource: 'estimated' }, { ...valid, salaryPeriod: 'MONTH' },
      { ...valid, currency: undefined }, { ...valid, canton: 'ZH' },
    ];
    fs.writeFileSync(path.join(root, 'data/jobs.json'), JSON.stringify(jobs));
    expect(aggregateSalaryBySector(root)).toEqual([
      { sector: 'Engineering', count: 12, medianCHF: 90000, estimatedItalyEUR: null, ratio: null },
    ]);
    vi.stubEnv('SKIP_COMPARISONS_HUB', '0');
    await (comparisonsHubPlugin(root).closeBundle as () => Promise<void>)();
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const html = fs.readFileSync(path.join(root, 'dist', buildComparisonsHubPath(locale), 'index.html'), 'utf8');
      const dom = new JSDOM(html);
      const doc = dom.window.document;
      const tables = doc.querySelectorAll('table');
      const salaryCells = [...tables[0].querySelectorAll('tbody tr:first-child td')].map((cell) => cell.textContent);
      expect(salaryCells[0]).toBe('Engineering');
      expect(salaryCells[1]).toBe('12');
      expect(salaryCells.slice(3)).toEqual(['–', '–']);
      for (const row of tables[1].querySelectorAll('tbody tr')) {
        expect([...row.querySelectorAll('td')].slice(1).map((cell) => cell.textContent)).toEqual(['N/D', 'N/D', 'N/D']);
      }
      expect(doc.body.textContent).toMatch(/Pagina generata|Page generated|Seite erstellt|Page générée/);
      dom.window.close();
    }
  });
});


describe('comparison source availability', () => {
  it.each([undefined, [{ canton: 7 }], []])('preserves the unavailable/valid-empty distinction for %j', async (source) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comparison-availability-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'data'));
    fs.mkdirSync(path.join(root, 'dist'));
    if (source !== undefined) fs.writeFileSync(path.join(root, 'data/jobs.json'), JSON.stringify(source));
    const validEmpty = Array.isArray(source) && source.length === 0;
    expect(loadReportJobPanel(root, 2026)).toEqual(validEmpty ? [] : null);
    expect(aggregateSalaryBySector(root)).toEqual(validEmpty ? [] : null);
    vi.stubEnv('SKIP_COMPARISONS_HUB', '0');
    await (comparisonsHubPlugin(root).closeBundle as () => Promise<void>)();
    const labels = {
      it: 'Dati salariali non disponibili', en: 'Salary data unavailable',
      de: 'Lohndaten nicht verfügbar', fr: 'Données salariales indisponibles',
    };
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const html = fs.readFileSync(path.join(root, 'dist', buildComparisonsHubPath(locale), 'index.html'), 'utf8');
      const dom = new JSDOM(html);
      const table = dom.window.document.querySelector('table')!;
      if (validEmpty) {
        expect(table.querySelectorAll('tbody tr')).toHaveLength(0);
        expect(table.textContent).not.toContain(labels[locale]);
      } else {
        expect(table.textContent).toContain(labels[locale]);
      }
      dom.window.close();
    }
  });
});
