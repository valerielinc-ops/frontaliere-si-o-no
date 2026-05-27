import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '../../dist');

function listJobHtmlUnder(cantonSection: string): string[] {
  const dir = path.join(DIST, cantonSection);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'index.html'))) {
      out.push(entry.name);
    }
  }
  return out;
}

describe('cathedral flip — job-detail URLs route per job.canton', () => {
  it('non-TI jobs do NOT live under /cerca-lavoro-ticino/', () => {
    const tiSlugs = listJobHtmlUnder('cerca-lavoro-ticino');
    const cantonsToCheck = ['cerca-lavoro-zurigo', 'cerca-lavoro-ginevra', 'cerca-lavoro-argovia'];
    for (const sect of cantonsToCheck) {
      const slugs = listJobHtmlUnder(sect);
      const leaked = slugs.filter((s) => tiSlugs.includes(s));
      expect(leaked, `${sect} slugs also under TI: ${leaked.slice(0,5).join(',')}`).toEqual([]);
    }
  });

  it('every non-TI canton with ≥ MIN_JOBS has at least one job-detail page', () => {
    const SAMPLE = ['cerca-lavoro-zurigo', 'cerca-lavoro-ginevra', 'cerca-lavoro-vaud', 'cerca-lavoro-berna'];
    for (const sect of SAMPLE) {
      const slugs = listJobHtmlUnder(sect);
      expect(slugs.length, `${sect} has no job detail pages`).toBeGreaterThan(0);
    }
  });

  it('canton-landing body contains a real listing grid (not a thin indice)', () => {
    const html = fs.readFileSync(path.join(DIST, 'cerca-lavoro-zurigo/index.html'), 'utf8');
    expect(html).toMatch(/<article[\s\S]+job-card|data-job-id|JobPosting/);
    expect(html.length).toBeGreaterThan(15_000); // thin indice is ~7KB
  });
});
