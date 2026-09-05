import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  BRAND_RELABELLED_CRAWLER_KEYS,
  applyDeclaredBrandRelabel,
  declaredBrandLabels,
  parserPathForCrawlerKey,
} from '../scripts/lib/crawler-brand-relabel.mjs';
import { canonicalCompanyProfileSlug } from '../build-plugins/shared/companyProfileSlug.mjs';

const ROOT = path.resolve(__dirname, '..');

describe('declared brand relabel', () => {
  it('has a parser on disk for every listed crawler key', () => {
    for (const key of BRAND_RELABELLED_CRAWLER_KEYS) {
      expect(fs.existsSync(parserPathForCrawlerKey(key)), `missing parser for ${key}`).toBe(true);
    }
  });

  it('reads a non-empty declared label for every listed crawler key', () => {
    const labels = declaredBrandLabels();
    for (const key of BRAND_RELABELLED_CRAWLER_KEYS) {
      expect(labels.get(key), `no declared label for ${key}`).toBeTruthy();
    }
  });

  it('never assigns the same label to two different crawler keys', () => {
    // The whole point of the swap is that the two brands stay DISTINCT. Two
    // keys resolving to one label would collapse their profile slugs into a
    // single group and delete the other page — the failure this net prevents.
    const labels = [...declaredBrandLabels().values()];
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('rewrites a stale label and leaves an already-aligned one untouched', () => {
    const labels = new Map([
      ['ipersonal', 'MediPersonal'],
      ['med-ipersonal', 'iPersonal AG'],
    ]);
    const jobs = [
      { companyKey: 'ipersonal', company: 'iPersonal AG' },
      { companyKey: 'med-ipersonal', company: 'iPersonal AG' },
      { companyKey: 'coop-ticino', company: 'Coop Genossenschaft' },
    ];
    const result = applyDeclaredBrandRelabel(jobs, labels);

    expect(jobs[0].company).toBe('MediPersonal');
    expect(jobs[1].company).toBe('iPersonal AG');
    // A key outside the list is never touched: multi-employer slices must keep
    // their per-row brands.
    expect(jobs[2].company).toBe('Coop Genossenschaft');
    expect(result.relabelled).toBe(1);
  });

  it('leaves both profile slugs populated when two crawlers swap labels', () => {
    // Reproduces the non-atomic window: without the relabel, the slice that
    // has already re-run collides onto the other brand's slug and the loser
    // drops to zero rows (404 + sitemap exit on an indexed evergreen route).
    const labels = new Map([
      ['ipersonal', 'MediPersonal'],
      ['med-ipersonal', 'iPersonal AG'],
    ]);
    // `ipersonal` re-crawled (new label), `med-ipersonal` not yet (old label).
    const jobs = [
      ...Array.from({ length: 13 }, () => ({ companyKey: 'ipersonal', company: 'MediPersonal' })),
      ...Array.from({ length: 15 }, () => ({ companyKey: 'med-ipersonal', company: 'MediPersonal' })),
    ];

    const slugsBefore = new Set(jobs.map((j) => canonicalCompanyProfileSlug(j.company, j.companyKey)));
    expect(slugsBefore.size).toBe(1); // the collapse this net exists to prevent

    applyDeclaredBrandRelabel(jobs, labels);

    const counts = new Map<string, number>();
    for (const j of jobs) {
      const slug = canonicalCompanyProfileSlug(j.company, j.companyKey);
      counts.set(slug, (counts.get(slug) || 0) + 1);
    }
    expect(counts.size).toBe(2);
    // BRIDGE_FLOOR / MIN_ACTIVE_JOBS in build-employer-profiles.mjs: both
    // groups must stay above the floor so neither page disappears.
    for (const n of counts.values()) expect(n).toBeGreaterThanOrEqual(5);
  });

  it('is wired into the assembly of both active and expired jobs', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'assemble-jobs-dataset.mjs'), 'utf8');
    // Two call sites: the active `deduped` pass and the expired one. A net that
    // is only imported repairs nothing.
    expect(src.match(/applyDeclaredBrandRelabel\(/g)?.length).toBe(2);
  });
});
