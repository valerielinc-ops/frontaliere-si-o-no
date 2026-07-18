/**
 * Regression coverage for the marketReportPlugin sibling of issue #4394
 * (annualReportPlugin's hardcoded-vs-computed median drift). `salaryP` used
 * to hardcode "CHF 73 000" in narrative prose across all 4 locales while
 * the stat tile / embed snippet / Dataset JSON-LD rendered a dynamically
 * computed `avgMid` from `data/jobs-stats.json` — the exact same class of
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

const tempRoots: string[] = [];
afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function buildItHtml(jobsStats: unknown): Promise<string> {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'market-report-salary-sync-'));
  tempRoots.push(tempRoot);
  fs.mkdirSync(path.join(tempRoot, 'dist'));
  fs.mkdirSync(path.join(tempRoot, 'data'), { recursive: true });
  fs.writeFileSync(path.join(tempRoot, 'data', 'jobs-stats.json'), JSON.stringify(jobsStats));

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
  it('interpolates a real jobs-stats.json avgMid into the narrative copy', async () => {
    const html = await buildItHtml({
      totals: { activeJobs: 500, activeCompanies: 80, last7d: { added: 12 } },
      leaders: { topCompaniesActive: [], topLocationsActive: [] },
      salary: {
        coverage: { jobsWithSalary: 200, coveragePct: 40, avgMid: 91500, medianMid: 89000 },
        leaders: {},
      },
    });

    expect(html).not.toMatch(/CHF 73[ .,']?000/);
    expect(html).toMatch(/stipendio medio annuo si attesta intorno a CHF 91[.,']?500 lordi/);
  });

  it('degrades to N/D (not a fabricated 73000) when salary coverage is missing', async () => {
    const html = await buildItHtml({
      totals: { activeJobs: 500, activeCompanies: 80, last7d: { added: 12 } },
      leaders: { topCompaniesActive: [], topLocationsActive: [] },
    });

    expect(html).not.toMatch(/CHF 73[ .,']?000/);
    expect(html).toMatch(/stipendio medio annuo si attesta intorno a N\/D lordi/);
  });
});
