import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { annualReportPlugin } from '../build-plugins/annualReportPlugin';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('annual report source dates', () => {
  it('keeps publication metadata and URL sitemap stable when an unchanged panel is rebuilt', async () => {
    const current = Date.now();
    const jobs = Array.from({ length: 12 }, (_, i) => ({
      id: `job-${i}`, sector: 'Informatica', canton: 'TI', location: 'Lugano',
      salaryMin: 70_000 + i * 100, salaryMax: 80_000 + i * 100, currency: 'CHF',
      salarySource: 'reported', salaryPeriod: 'YEAR', datePosted: new Date(current).toISOString(),
    }));
    const results: { xml: string; schemas: unknown[] }[] = [];
    vi.stubEnv('SKIP_ANNUAL_REPORT', '0');
    vi.useFakeTimers({ toFake: ['Date'] });
    for (const offset of [0, 2]) {
      vi.setSystemTime(current + offset * 86_400_000);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'annual-report-dates-'));
      roots.push(root);
      fs.mkdirSync(path.join(root, 'data'));
      fs.writeFileSync(path.join(root, 'data/jobs.json'), JSON.stringify(jobs));
      const plugin = annualReportPlugin(root);
      await (plugin.closeBundle as () => Promise<void>)();
      const xml = fs.readFileSync(path.join(root, 'dist/sitemap-annual-report.xml'), 'utf-8');
      const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]));
      expect(locs).toHaveLength(4);
      expect(xml).not.toContain('<lastmod>');
      const schemas = locs.flatMap((url) => {
        const html = fs.readFileSync(path.join(root, 'dist', url.pathname, 'index.html'), 'utf-8');
        const dom = new JSDOM(html);
        const doc = dom.window.document;
        const entries = [...doc.querySelectorAll('script[type="application/ld+json"]')]
          .map((script) => JSON.parse(script.textContent || '{}'))
          .filter((entry) => ['Article', 'Dataset'].includes(entry['@type']));
        expect(entries).toHaveLength(2);
        for (const entry of entries) {
          expect(entry).not.toHaveProperty('datePublished');
          expect(entry).not.toHaveProperty('dateModified');
        }
        dom.window.close();
        return entries;
      });
      results.push({ xml, schemas });
    }
    expect(results[1]).toEqual(results[0]);
  });
});
