import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyTiHubLatestJobsSlot,
  renderTiHubLatestJobsBlock,
  summarizeTiHubInventory,
  TI_HUB_LATEST_JOBS_LIMIT,
  TI_HUB_LATEST_JOBS_MARKER,
  TI_HUB_LATEST_JOBS_SLOT,
} from '../build-plugins/shared/tiHubLatestJobs';
import { patchTiHubFile, tiHubIndexPath, tiHubLatestJobsPlugin } from '../build-plugins/tiHubLatestJobsPlugin';
import { resolveStaticPagesFlushed } from '../build-plugins/shared/buildSignals';
import {
  buildCantonHubH1,
  buildListingHubH1,
  buildListingHubTitle,
} from '../services/seo/job-board-titles';
import { buildJobBoardSeo } from '../build-plugins/jobBoardSeoPure';
import { salaryStatsJobHubHref } from '../build-plugins/salaryStatsChCantonPages';

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function job(i: number, extra: Record<string, unknown> = {}) {
  return {
    job: {
      title: `Ruolo ${i}`,
      company: i % 2 ? 'EOC' : 'PEMSA',
      location: i % 3 ? 'Lugano' : 'Bellinzona',
      canton: 'TI',
      datePosted: daysAgo(i),
      ...extra,
    },
    href: `https://frontaliereticino.ch/cerca-lavoro-ticino/ruolo-${i}/`,
  };
}

const STATS = summarizeTiHubInventory([
  { location: 'Lugano', company: 'EOC' },
  { location: 'Lugano, TI', company: 'eoc' },
  { location: 'Bellinzona', company: 'PEMSA' },
]);

describe('summarizeTiHubInventory', () => {
  it('counts cities by first comma part and employers case-insensitively', () => {
    expect(STATS.topCity).toEqual({ name: 'Lugano', count: 2 });
    expect(STATS.employerCount).toBe(2);
    expect(STATS.topEmployer).toEqual({ name: 'EOC', count: 2 });
  });

  it('returns empty stats for an empty pool', () => {
    expect(summarizeTiHubInventory([])).toEqual({ topCity: null, employerCount: 0, topEmployer: null });
  });
});

describe('renderTiHubLatestJobsBlock', () => {
  const base = {
    stats: STATS,
    todayHref: '/cerca-lavoro-ticino/offerte-di-lavoro-ticino-oggi/',
    allHref: '/cerca-lavoro-ticino/tutti/',
  };

  it('renders nothing without a linkable job, so the hub never shows an empty grid', () => {
    expect(renderTiHubLatestJobsBlock({ ...base, locale: 'it', jobs: [] })).toBe('');
  });

  it('links every card to its active detail URL and caps the grid', () => {
    const jobs = Array.from({ length: TI_HUB_LATEST_JOBS_LIMIT + 5 }, (_, i) => job(i));
    const html = renderTiHubLatestJobsBlock({ ...base, locale: 'it', jobs });
    expect(html).toContain(TI_HUB_LATEST_JOBS_MARKER);
    expect(html).toContain('Ultime offerte di lavoro in Ticino');
    // The shared card renderer emits site-relative hrefs (trailing slash kept).
    const hrefs = [...html.matchAll(/href="(\/cerca-lavoro-ticino\/ruolo-\d+\/)"/g)].map((m) => m[1]);
    expect(new Set(hrefs).size).toBe(TI_HUB_LATEST_JOBS_LIMIT);
    expect(html).toContain('href="/cerca-lavoro-ticino/offerte-di-lavoro-ticino-oggi/"');
    expect(html).toContain('href="/cerca-lavoro-ticino/tutti/"');
    // Data area order (AGENTS.md landing order): tiles → CTA → listing.
    expect(html.indexOf('data-stat-tile-grid')).toBeLessThan(html.indexOf('data-primary-cta'));
    expect(html.indexOf('data-primary-cta')).toBeLessThan(html.indexOf('data-listing-grid'));
  });

  it('escapes crawler-sourced stat values', () => {
    const html = renderTiHubLatestJobsBlock({
      ...base,
      locale: 'en',
      jobs: [job(1)],
      stats: { topCity: { name: '<b>Lugano</b>', count: 3 }, employerCount: 1, topEmployer: null },
    });
    expect(html).not.toContain('<b>Lugano</b>');
    expect(html).toContain('&lt;b&gt;Lugano&lt;/b&gt;');
  });

  it('has its own heading in every locale', () => {
    const headings = (['it', 'en', 'de', 'fr'] as const).map((locale) =>
      renderTiHubLatestJobsBlock({ ...base, locale, jobs: [job(1)] }).match(/<h2[^>]*>([^<]+)<\/h2>/)?.[1],
    );
    expect(new Set(headings).size).toBe(4);
  });
});

describe('applyTiHubLatestJobsSlot / patchTiHubFile', () => {
  const page = `<h1>x</h1><div>${TI_HUB_LATEST_JOBS_SLOT}<h2>rest</h2></div>`;

  it('replaces the slot, clears it when the block is empty, and is idempotent', () => {
    const block = `<section ${TI_HUB_LATEST_JOBS_MARKER}>cards</section>`;
    const inserted = applyTiHubLatestJobsSlot(page, block);
    expect(inserted.outcome).toBe('inserted');
    expect(inserted.html).toContain('cards');
    expect(inserted.html).not.toContain(TI_HUB_LATEST_JOBS_SLOT);
    expect(applyTiHubLatestJobsSlot(inserted.html, block).outcome).toBe('duplicate');
    const cleared = applyTiHubLatestJobsSlot(page, '');
    expect(cleared.outcome).toBe('cleared');
    expect(cleared.html).toBe('<h1>x</h1><div><h2>rest</h2></div>');
    expect(applyTiHubLatestJobsSlot('<h1>x</h1>', block).outcome).toBe('no-slot');
  });

  it('writes the patched hub file and reports a missing one', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-hub-'));
    const file = path.join(dir, 'index.html');
    fs.writeFileSync(file, page);
    expect(patchTiHubFile(file, `<section ${TI_HUB_LATEST_JOBS_MARKER}>ok</section>`)).toBe('inserted');
    expect(fs.readFileSync(file, 'utf-8')).toContain('>ok<');
    expect(patchTiHubFile(path.join(dir, 'missing.html'), 'x')).toBe('missing-file');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('job hub H1 builders', () => {
  it('states the head query and the live count on the Ticino hub, distinct from the title', () => {
    expect(buildListingHubH1({ locale: 'it', count: 943 })).toBe('Offerte di lavoro in Ticino: 943 annunci attivi');
    expect(buildListingHubH1({ locale: 'en', count: 943 })).toBe('Jobs in Ticino: 943 open vacancies');
    expect(buildListingHubH1({ locale: 'de', count: 1200 })).toBe("Stellenangebote im Tessin: 1'200 offene Stellen");
    expect(buildListingHubH1({ locale: 'fr', count: 0 })).toBe('Offres d’emploi au Tessin');
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      const seo = buildJobBoardSeo(locale, 943, 2026);
      expect(seo.h1).toBe(buildListingHubH1({ locale, count: 943 }));
      expect(seo.h1).not.toBe(seo.title);
    }
  });

  it('replaces the bare canton-name H1 with the searched shape', () => {
    expect(buildCantonHubH1({ locale: 'it', cantonDisplay: 'Zurigo', count: 8205 })).toBe("Lavoro Zurigo: 8'205 offerte di lavoro attive");
    expect(buildCantonHubH1({ locale: 'it', cantonDisplay: 'Svizzera', count: 10 })).toBe('Lavoro in Svizzera: 10 offerte di lavoro attive');
    expect(buildCantonHubH1({ locale: 'en', cantonDisplay: 'Geneva', count: 0 })).toBe('Jobs in Geneva');
    expect(buildCantonHubH1({ locale: 'de', cantonDisplay: 'Wallis', count: 5 })).toBe('Jobs im Wallis: 5 offene Stellen');
    expect(buildCantonHubH1({ locale: 'fr', cantonDisplay: 'Genève', count: 1099 })).toBe("Emploi dans le canton de Genève : 1'099 offres actives");
  });

  it('no longer pads the German hub title with a stray "kostenlos"', () => {
    for (const count of [1, 99, 938, 12582]) {
      expect(buildListingHubTitle({ locale: 'de', count, year: 2026 })).not.toContain('kostenlos');
    }
  });
});

describe('salary page → canton job hub link', () => {
  it('targets the canton job hub with a trailing slash in every locale', () => {
    expect(salaryStatsJobHubHref('it', 'TI')).toBe('/cerca-lavoro-ticino/');
    expect(salaryStatsJobHubHref('it', 'ZH')).toBe('/cerca-lavoro-zurigo/');
    expect(salaryStatsJobHubHref('fr', 'GE')).toBe('/fr/trouver-emploi-geneve/');
    expect(salaryStatsJobHubHref('de', 'TI')).toBe('/de/jobs-im-tessin/');
  });
});

describe('tiHubLatestJobsPlugin closeBundle', () => {
  const run = async (rootDir: string) => {
    const prev = process.env.FAST_BUILD;
    process.env.FAST_BUILD = '1'; // no jobsSeo producer: blocks stay null → slot cleared
    resolveStaticPagesFlushed();
    try {
      const plugin = tiHubLatestJobsPlugin(rootDir) as { closeBundle: () => Promise<void> };
      await plugin.closeBundle();
    } finally {
      if (prev === undefined) delete process.env.FAST_BUILD;
      else process.env.FAST_BUILD = prev;
    }
  };

  const writeHubs = (dist: string, withSlot: Partial<Record<'it' | 'en' | 'de' | 'fr', boolean>>) => {
    for (const [locale, slot] of Object.entries(withSlot) as ['it' | 'en' | 'de' | 'fr', boolean][]) {
      fs.mkdirSync(path.dirname(tiHubIndexPath(dist, locale)), { recursive: true });
      fs.writeFileSync(tiHubIndexPath(dist, locale), `<h1>x</h1>${slot ? TI_HUB_LATEST_JOBS_SLOT : ''}`);
    }
  };

  it('fails the build when the IT hub lost its slot or is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-hub-plugin-'));
    const dist = path.join(root, 'dist');
    writeHubs(dist, { it: false, en: true, de: true, fr: true });
    await expect(run(root)).rejects.toThrow(/it=no-slot:/);
    fs.rmSync(tiHubIndexPath(dist, 'it'));
    await expect(run(root)).rejects.toThrow(/it=missing-file:/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('only warns when an en/de/fr hub is missing or lost its slot (deploy 40087494526)', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-hub-plugin-'));
    const dist = path.join(root, 'dist');
    writeHubs(dist, { it: true, en: false, de: false });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(run(root)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^::warning::\[ti-hub-latest-jobs\] en=no-slot, de=no-slot, fr=missing-file:/));
    } finally {
      warn.mockRestore();
    }
    expect(fs.readFileSync(tiHubIndexPath(dist, 'it'), 'utf-8')).toBe('<h1>x</h1>');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('clears the slot on every hub when there is no producer block', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-hub-plugin-'));
    const dist = path.join(root, 'dist');
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      fs.mkdirSync(path.dirname(tiHubIndexPath(dist, locale)), { recursive: true });
      fs.writeFileSync(tiHubIndexPath(dist, locale), `<h1>x</h1>${TI_HUB_LATEST_JOBS_SLOT}`);
    }
    await run(root);
    for (const locale of ['it', 'en', 'de', 'fr'] as const) {
      expect(fs.readFileSync(tiHubIndexPath(dist, locale), 'utf-8')).toBe('<h1>x</h1>');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
});
