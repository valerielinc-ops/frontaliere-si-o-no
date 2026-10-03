/**
 * Regression coverage for the marketReportPlugin sibling of issue #4394
 * (annualReportPlugin's hardcoded-vs-computed median drift). `salaryP` used
 * to hardcode "CHF 73 000" in narrative prose across all 4 locales while
 * the stat tile / embed snippet / Dataset JSON-LD rendered a dynamically
 * computed `avgMid` from reported `data/jobs.json` observations — the exact same class of
 * bug, found via the mandatory sibling-pattern grep (AGENTS.md §6) while
 * fixing #4394. `salaryP` is now a function of `avgMid`, so the narrative
 * copy can't drift from the displayed stat again. The `avgMid` fallback
 * was also `?? 73000` (a fabricated number asserted with full confidence
 * whenever salary coverage was missing) — it's now `?? null`, degrading
 * to "N/D" like the rest of the page instead of lying.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { marketReportPlugin } from '../../build-plugins/marketReportPlugin';
import { extractJsonLdBlocks, flattenSchemas } from '../post-build/seo-helpers';
import { formatSourceDate } from '../../services/dataFreshness';

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function buildItHtml(jobsStats: unknown, jobs: object[] = []): Promise<string> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'market-report-salary-sync-'));
  tempRoots.push(tempRoot);
  fs.mkdirSync(path.join(tempRoot, 'dist'));
  fs.mkdirSync(path.join(tempRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'data', 'jobs-stats.json'), JSON.stringify(jobsStats));
  fs.writeFileSync(path.join(tempRoot, 'data', 'jobs.json'), JSON.stringify(jobs));

  const plugin = marketReportPlugin(tempRoot) as unknown as { closeBundle: () => Promise<void> };
  await plugin.closeBundle();

  const files = fs.readdirSync(path.join(tempRoot, 'dist'), { recursive: true }) as string[];
  const itIndex = files.find(
    (f) => f.includes('mercato-lavoro-frontalieri-ticino') && f.endsWith('index.html'),
  );
  expect(itIndex, `no IT market-report index.html found among: ${files.join(', ')}`).toBeTruthy();
  return fs.readFileSync(path.join(tempRoot, 'dist', itIndex!), 'utf-8');
}

describe('marketReportPlugin — salaryP tracks avgMid, no stale/fake hardcode', () => {
  it('interpolates the reported jobs.json average, ignoring precomputed estimates', async () => {
    const html = await buildItHtml({
      totals: { activeJobs: 500, activeCompanies: 80, last7d: { added: 12 } },
      leaders: { topCompaniesActive: [], topLocationsActive: [] },
      salary: {
        coverage: { jobsWithSalary: 200, coveragePct: 40, avgMid: 73000, medianMid: 73000 },
        leaders: {},
      },
    }, [{ canton: 'TI', datePosted: '2026-06-15', salaryMin: 90000, salaryMax: 93000, currency: 'CHF', salarySource: 'reported', salaryPeriod: 'YEAR' }]);

    expect(html).not.toMatch(/CHF 73[ .,'’]?000/);
    expect(html).toMatch(/stipendio medio annuo si attesta intorno a CHF 91[.,'’]?500 lordi/);
  });

  it('degrades to N/D (not a fabricated 73000) when salary coverage is missing', async () => {
    const html = await buildItHtml({
      totals: { activeJobs: 500, activeCompanies: 80, last7d: { added: 12 } },
      leaders: { topCompaniesActive: [], topLocationsActive: [] },
    });

    expect(html).not.toMatch(/CHF 73[ .,'’]?000/);
    expect(html).toMatch(/stipendio medio annuo si attesta intorno a N\/D lordi/);
  });
});


describe('market report source timestamps', () => {
  it('keeps the compiled dataset date separate from page generation', async () => {
    const generatedAt = '2020-09-27T22:15:00.000Z';
    const html = await buildItHtml({ generatedAt, totals: { activeJobs: 500 } });
    const schemas = flattenSchemas(extractJsonLdBlocks(html));
    for (const type of ['Article', 'Dataset']) {
      const schema = schemas.find((item) => item['@type'] === type);
      expect(schema).toBeDefined();
      expect(schema?.dateModified).toBe(generatedAt);
      expect(schema?.datePublished).toBeUndefined();
    }
    expect(html).toContain(`Dati elaborati · ${formatSourceDate(generatedAt, 'it')}`);
    expect(html).toContain('Pagina generata:');
  });

  it.each([undefined, 'invalid', '2999-01-01T00:00:00.000Z'])('does not replace unknown or invalid dates (%s) with build time', async (generatedAt) => {
    const html = await buildItHtml({ generatedAt, totals: { activeJobs: 500 } });
    const schemas = flattenSchemas(extractJsonLdBlocks(html));
    for (const type of ['Article', 'Dataset']) {
      const schema = schemas.find((item) => item['@type'] === type);
      expect(schema).toBeDefined();
      expect(schema?.dateModified).toBeUndefined();
      expect(schema?.datePublished).toBeUndefined();
    }
    expect(html).toContain('Data di elaborazione non disponibile');
  });
});
