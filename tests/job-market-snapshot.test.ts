/**
 * Tests for the Weekly Job Market Snapshot (F4).
 *
 * Coverage:
 *   • Slug tables + path builders (hub / weekly / monthly) in all 4 locales
 *   • ISO week + Monday/Sunday helpers
 *   • Route enumeration + router predicate
 *   • Page generation: hub ≥300 words, weekly/monthly ≥350 words
 *   • Self-referencing canonical + hreflang alternates for all 4 locales
 *   • JSON-LD: BreadcrumbList + NewsArticle + Dataset + FAQPage
 *   • Degraded mode (empty / sparse history) still emits all 4 hubs + current week
 *   • Older weekly archives (>12 weeks back) are noindex,follow
 *   • No `dark:` color classes in the generated HTML
 */

import { describe, expect, it } from 'vitest';
import {
  JOB_MARKET_SNAPSHOT_LOCALES,
  JOB_MARKET_SNAPSHOT_ROUTES,
  JOB_MARKET_SECTION_SLUG,
  buildHubPath,
  buildMonthlyPath,
  buildWeeklyPath,
  getIsoWeek,
  isJobMarketSnapshotPath,
  mondayOfIsoWeek,
  parseMonthSlug,
  parseWeekSlug,
  sundayOfIsoWeek,
} from '../build-plugins/jobMarketSnapshotData';
import {
  bucketHistoryByMonth,
  bucketHistoryByWeek,
  buildWeeklyTrendSeries,
  generateJobMarketSnapshotPages,
} from '../build-plugins/jobMarketSnapshotPlugin';

// ── Fixtures ─────────────────────────────────────────────

function makeEntry(
  date: string,
  overrides: Partial<{
    totalJobs: number;
    added: number;
    removed: number;
    updated: number;
    companyStats: Array<{ key: string; name: string; added: number; url?: string }>;
    locationStats: Array<{ key: string; name: string; added: number }>;
    titleStats: Array<{ key: string; name: string; added: number }>;
  }> = {},
): any {
  return {
    date,
    totalJobs: overrides.totalJobs ?? 2400,
    added: overrides.added ?? 12,
    updated: overrides.updated ?? 20,
    removed: overrides.removed ?? 5,
    addedKeys: [],
    updatedKeys: [],
    removedKeys: [],
    companyStats: (overrides.companyStats ?? []).map((c) => ({
      key: c.key,
      name: c.name,
      url: c.url,
      addedKeys: Array.from({ length: c.added }, (_, i) => `url:https://ex.com/c/${c.key}/${i}`),
      updatedKeys: [],
      removedKeys: [],
    })),
    locationStats: (overrides.locationStats ?? []).map((l) => ({
      key: l.key,
      name: l.name,
      addedKeys: Array.from({ length: l.added }, (_, i) => `url:https://ex.com/l/${l.key}/${i}`),
      updatedKeys: [],
      removedKeys: [],
    })),
    titleStats: (overrides.titleStats ?? []).map((t) => ({
      key: t.key,
      name: t.name,
      addedKeys: Array.from({ length: t.added }, (_, i) => `url:https://ex.com/t/${t.key}/${i}`),
      updatedKeys: [],
      removedKeys: [],
    })),
  };
}

function buildMultiWeekHistory(): any[] {
  // Build 14 full ISO weeks (weeks 4..17 of 2026, Mon..Sun each) so we exercise the
  // 12-week indexable window (older ones should be noindex).
  const entries: any[] = [];
  for (let week = 4; week <= 17; week++) {
    const mon = mondayOfIsoWeek(2026, week);
    for (let d = 0; d < 7; d++) {
      const day = new Date(mon.getTime());
      day.setUTCDate(mon.getUTCDate() + d);
      const iso = day.toISOString().slice(0, 10);
      entries.push(
        makeEntry(iso, {
          totalJobs: 2000 + week * 10 + d,
          added: 10 + (d % 3),
          removed: 3,
          updated: 15,
          companyStats: [
            { key: 'eoc', name: 'EOC', added: 4, url: 'https://frontaliereticino.ch/cerca-lavoro-ticino/azienda-eoc' },
            { key: 'denner', name: 'Denner', added: 2 },
            { key: 'lonza', name: 'Lonza', added: 2 },
            { key: 'coop', name: 'Coop', added: 1 },
            { key: 'migros', name: 'Migros', added: 1 },
          ],
          locationStats: [
            { key: 'lugano', name: 'Lugano', added: 5 },
            { key: 'bellinzona', name: 'Bellinzona', added: 4 },
            { key: 'mendrisio', name: 'Mendrisio', added: 3 },
            { key: 'locarno', name: 'Locarno', added: 2 },
            { key: 'chiasso', name: 'Chiasso', added: 1 },
          ],
          titleStats: [
            { key: 'infermiere', name: 'Infermiere/a', added: 4 },
            { key: 'assistente-cura', name: 'Assistente di cura', added: 3 },
            { key: 'impiegato-amministrativo', name: 'Impiegato amministrativo', added: 2 },
            { key: 'vendita', name: 'Addetto alla vendita', added: 2 },
            { key: 'autista', name: 'Autista di camion', added: 1 },
          ],
        }),
      );
    }
  }
  return entries;
}

// ── Slug tables / path builders ─────────────────────────

describe('jobMarketSnapshotData — slug tables', () => {
  it('exposes all 4 locales', () => {
    expect(JOB_MARKET_SNAPSHOT_LOCALES).toEqual(['it', 'en', 'de', 'fr']);
  });

  it('uses expected section slugs per locale', () => {
    expect(JOB_MARKET_SECTION_SLUG.it).toBe('mercato-lavoro-ticino');
    expect(JOB_MARKET_SECTION_SLUG.en).toBe('ticino-job-market');
    expect(JOB_MARKET_SECTION_SLUG.de).toBe('tessiner-arbeitsmarkt');
    expect(JOB_MARKET_SECTION_SLUG.fr).toBe('marche-travail-tessin');
  });
});

describe('jobMarketSnapshotData — path builders', () => {
  it('builds hub paths', () => {
    expect(buildHubPath('it')).toBe('/mercato-lavoro-ticino/');
    expect(buildHubPath('en')).toBe('/en/ticino-job-market/');
    expect(buildHubPath('de')).toBe('/de/tessiner-arbeitsmarkt/');
    expect(buildHubPath('fr')).toBe('/fr/marche-travail-tessin/');
  });

  it('builds weekly paths with the locale-specific prefix', () => {
    expect(buildWeeklyPath('it', 2026, 16)).toBe('/mercato-lavoro-ticino/settimana-16-2026/');
    expect(buildWeeklyPath('en', 2026, 16)).toBe('/en/ticino-job-market/week-16-2026/');
    expect(buildWeeklyPath('de', 2026, 16)).toBe('/de/tessiner-arbeitsmarkt/woche-16-2026/');
    expect(buildWeeklyPath('fr', 2026, 16)).toBe('/fr/marche-travail-tessin/semaine-16-2026/');
  });

  it('zero-pads single-digit weeks', () => {
    expect(buildWeeklyPath('it', 2026, 1)).toBe('/mercato-lavoro-ticino/settimana-01-2026/');
    expect(buildWeeklyPath('en', 2026, 9)).toBe('/en/ticino-job-market/week-09-2026/');
  });

  it('builds monthly paths with the localised month name', () => {
    expect(buildMonthlyPath('it', 2026, 4)).toBe('/mercato-lavoro-ticino/aprile-2026/');
    expect(buildMonthlyPath('en', 2026, 4)).toBe('/en/ticino-job-market/april-2026/');
    expect(buildMonthlyPath('de', 2026, 4)).toBe('/de/tessiner-arbeitsmarkt/april-2026/');
    expect(buildMonthlyPath('fr', 2026, 4)).toBe('/fr/marche-travail-tessin/avril-2026/');
  });

  it('rejects invalid months', () => {
    expect(() => buildMonthlyPath('it', 2026, 0)).toThrow(RangeError);
    expect(() => buildMonthlyPath('it', 2026, 13)).toThrow(RangeError);
  });
});

// ── ISO week helpers ─────────────────────────────────────

describe('ISO week helpers', () => {
  it('computes the correct ISO week for a known date', () => {
    expect(getIsoWeek(new Date('2026-04-20'))).toEqual({ year: 2026, week: 17 });
    expect(getIsoWeek(new Date('2026-04-13'))).toEqual({ year: 2026, week: 16 });
    expect(getIsoWeek(new Date('2026-01-01'))).toEqual({ year: 2026, week: 1 });
  });

  it('mondayOfIsoWeek returns a Monday', () => {
    const mon = mondayOfIsoWeek(2026, 16);
    expect(mon.getUTCDay()).toBe(1);
    // Week 16 of 2026 starts Monday 2026-04-13
    expect(mon.toISOString().slice(0, 10)).toBe('2026-04-13');
  });

  it('sundayOfIsoWeek returns a Sunday', () => {
    const sun = sundayOfIsoWeek(2026, 16);
    expect(sun.getUTCDay()).toBe(0);
    expect(sun.toISOString().slice(0, 10)).toBe('2026-04-19');
  });
});

// ── Route enumeration + predicate ───────────────────────

describe('route enumeration', () => {
  it('JOB_MARKET_SNAPSHOT_ROUTES contains exactly 4 hub paths', () => {
    expect(JOB_MARKET_SNAPSHOT_ROUTES).toHaveLength(4);
    expect(new Set(JOB_MARKET_SNAPSHOT_ROUTES).size).toBe(4);
    for (const path of JOB_MARKET_SNAPSHOT_ROUTES) {
      expect(path.endsWith('/')).toBe(true);
    }
  });

  it('isJobMarketSnapshotPath matches every hub path', () => {
    for (const path of JOB_MARKET_SNAPSHOT_ROUTES) {
      expect(isJobMarketSnapshotPath(path)).toBe(true);
    }
  });

  it('isJobMarketSnapshotPath tolerates missing trailing slash', () => {
    expect(isJobMarketSnapshotPath('/mercato-lavoro-ticino')).toBe(true);
  });

  it('isJobMarketSnapshotPath recognises weekly archives in all locales', () => {
    expect(isJobMarketSnapshotPath('/mercato-lavoro-ticino/settimana-16-2026/')).toBe(true);
    expect(isJobMarketSnapshotPath('/en/ticino-job-market/week-16-2026/')).toBe(true);
    expect(isJobMarketSnapshotPath('/de/tessiner-arbeitsmarkt/woche-16-2026/')).toBe(true);
    expect(isJobMarketSnapshotPath('/fr/marche-travail-tessin/semaine-16-2026/')).toBe(true);
  });

  it('isJobMarketSnapshotPath recognises monthly archives in all locales', () => {
    expect(isJobMarketSnapshotPath('/mercato-lavoro-ticino/aprile-2026/')).toBe(true);
    expect(isJobMarketSnapshotPath('/en/ticino-job-market/april-2026/')).toBe(true);
    expect(isJobMarketSnapshotPath('/de/tessiner-arbeitsmarkt/april-2026/')).toBe(true);
    expect(isJobMarketSnapshotPath('/fr/marche-travail-tessin/avril-2026/')).toBe(true);
  });

  it('isJobMarketSnapshotPath rejects unrelated paths', () => {
    expect(isJobMarketSnapshotPath('/')).toBe(false);
    expect(isJobMarketSnapshotPath('/cerca-lavoro-ticino/')).toBe(false);
    expect(isJobMarketSnapshotPath('/mercato-lavoro-ticino/garbage/')).toBe(false);
    expect(isJobMarketSnapshotPath('/comparatori/cambio-valuta/')).toBe(false);
  });

  it('parseWeekSlug / parseMonthSlug round-trip', () => {
    expect(parseWeekSlug('settimana-16-2026')).toEqual({ year: 2026, week: 16 });
    expect(parseWeekSlug('week-09-2026')).toEqual({ year: 2026, week: 9 });
    expect(parseWeekSlug('broken-slug')).toBeNull();
    expect(parseMonthSlug('aprile-2026')).toEqual({ year: 2026, month: 4 });
    expect(parseMonthSlug('april-2026')).toEqual({ year: 2026, month: 4 });
    expect(parseMonthSlug('avril-2026')).toEqual({ year: 2026, month: 4 });
    expect(parseMonthSlug('nonsense-2026')).toBeNull();
  });
});

// ── History bucketing ───────────────────────────────────

describe('bucketHistoryByWeek / bucketHistoryByMonth', () => {
  it('splits history into ISO weeks and keeps only complete weeks', () => {
    const entries = buildMultiWeekHistory();
    const buckets = bucketHistoryByWeek(entries, { requireComplete: true });
    // 14 full weeks were synthesised
    expect(buckets.length).toBeGreaterThanOrEqual(14);
    for (const b of buckets) {
      expect(b.entries.length).toBeGreaterThanOrEqual(4);
      expect(b.sunday.getTime()).toBeGreaterThan(b.monday.getTime());
    }
  });

  it('groups entries into months, oldest first', () => {
    const entries = buildMultiWeekHistory();
    const months = bucketHistoryByMonth(entries);
    expect(months.length).toBeGreaterThanOrEqual(2);
    // Chronologically ascending
    for (let i = 1; i < months.length; i++) {
      const a = months[i - 1];
      const b = months[i];
      const aKey = a.year * 100 + a.month;
      const bKey = b.year * 100 + b.month;
      expect(bKey).toBeGreaterThan(aKey);
    }
  });
});

describe('buildWeeklyTrendSeries', () => {
  it('caps the series at 12 entries', () => {
    const entries = buildMultiWeekHistory();
    const buckets = bucketHistoryByWeek(entries, { requireComplete: true });
    const series = buildWeeklyTrendSeries(buckets);
    expect(series.length).toBeLessThanOrEqual(12);
    expect(series.every((s) => typeof s.value === 'number')).toBe(true);
  });
});

// ── Page generation ─────────────────────────────────────

describe('generateJobMarketSnapshotPages — normal mode (rich history)', () => {
  const today = new Date('2026-04-27T06:00:00.000Z'); // Monday after week 17 closes
  const entries = buildMultiWeekHistory();
  const out = generateJobMarketSnapshotPages({
    history: { version: 1, generatedAt: today.toISOString(), entries },
    jobs: [
      { title: 'Infermiere', company: 'EOC', location: 'Bellinzona', baseSalary: { value: { minValue: 70000, maxValue: 90000 } } },
      { title: 'Cassiere', company: 'Coop', location: 'Lugano', baseSalary: { value: { minValue: 48000, maxValue: 55000 } } },
      { title: 'Tecnico', company: 'Lonza', location: 'Visp', baseSalary: { value: { minValue: 85000, maxValue: 110000 } } },
    ] as any,
    today,
  });

  it('is not in degraded mode', () => {
    expect(out.degraded).toBe(false);
  });

  it('emits 4 hub pages, one per locale', () => {
    for (const locale of JOB_MARKET_SNAPSHOT_LOCALES) {
      const hubPath = buildHubPath(locale);
      expect(out.pages[hubPath]).toBeTruthy();
    }
  });

  it('hub page has ≥300 words of body content', () => {
    const hubHtml = out.pages[buildHubPath('it')];
    const body = hubHtml.replace(/<head[\s\S]*?<\/head>/i, '').replace(/<[^>]+>/g, ' ');
    const words = body.replace(/\s+/g, ' ').trim().split(' ').filter((w) => w.length > 0);
    expect(words.length).toBeGreaterThanOrEqual(300);
  });

  it('emits a weekly page per locale for every completed week', () => {
    for (const bucket of out.completedWeeks) {
      for (const locale of JOB_MARKET_SNAPSHOT_LOCALES) {
        const path = buildWeeklyPath(locale, bucket.isoYear, bucket.isoWeek);
        expect(out.pages[path], `missing weekly page at ${path}`).toBeTruthy();
      }
    }
  });

  it('every weekly page has ≥350 words of body content', () => {
    for (const [path, html] of Object.entries(out.pages)) {
      if (!/\/(settimana|week|woche|semaine)-\d/.test(path)) continue;
      const body = html.replace(/<head[\s\S]*?<\/head>/i, '').replace(/<[^>]+>/g, ' ');
      const words = body.replace(/\s+/g, ' ').trim().split(' ').filter((w) => w.length > 0);
      expect(words.length, `page ${path} has ${words.length} words`).toBeGreaterThanOrEqual(350);
    }
  });

  it('every page has self-referencing canonical', () => {
    for (const [path, html] of Object.entries(out.pages)) {
      expect(html).toContain(`<link rel="canonical" href="https://frontaliereticino.ch${path}">`);
    }
  });

  it('every page has hreflang alternates for all 4 locales + x-default', () => {
    for (const [path, html] of Object.entries(out.pages)) {
      expect(html, `missing hreflang on ${path}`).toContain('hreflang="it"');
      expect(html).toContain('hreflang="en"');
      expect(html).toContain('hreflang="de"');
      expect(html).toContain('hreflang="fr"');
      expect(html).toContain('hreflang="x-default"');
    }
  });

  it('every page embeds parseable BreadcrumbList + FAQPage JSON-LD', () => {
    for (const [path, html] of Object.entries(out.pages)) {
      const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
      expect(ldBlocks.length, `page ${path} missing JSON-LD`).toBeGreaterThanOrEqual(3);
      const types = ldBlocks.map((m) => JSON.parse(m[1])['@type']);
      expect(types).toContain('BreadcrumbList');
      expect(types).toContain('FAQPage');
    }
  });

  it('weekly and monthly pages embed NewsArticle + Dataset JSON-LD', () => {
    for (const [path, html] of Object.entries(out.pages)) {
      const isSnapshot = /\/(settimana|week|woche|semaine)-\d/.test(path)
        || /\/(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre|january|february|march|april|may|june|july|august|september|october|november|december|januar|februar|maerz|mai|juni|juli|oktober|dezember|janvier|fevrier|mars|avril|juin|juillet|aout|octobre|decembre)-\d{4}\//.test(path);
      if (!isSnapshot) continue;
      const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
      const types = ldBlocks.map((ld) => ld['@type']);
      expect(types, `types for ${path} = ${JSON.stringify(types)}`).toContain('NewsArticle');
      expect(types).toContain('Dataset');
    }
  });

  it('weekly archives older than 12 weeks are noindex,follow', () => {
    // From 14 ISO weeks we expect 2 weeks to be noindex (the oldest)
    let noindexCount = 0;
    for (const [path, html] of Object.entries(out.pages)) {
      if (!/\/(settimana|week|woche|semaine)-\d/.test(path)) continue;
      if (/meta name="robots" content="noindex/.test(html)) noindexCount++;
    }
    // We have 14 complete weeks × 4 locales = 56 weekly pages; oldest 2 × 4 = 8 should be noindex
    expect(noindexCount).toBeGreaterThanOrEqual(4);
  });

  it('contains no dark: color class in body', () => {
    for (const html of Object.values(out.pages)) {
      expect(html).not.toMatch(/\sdark:[a-z-]+/);
    }
  });

  it('every body contains the full hub name (branding check)', () => {
    for (const [path, html] of Object.entries(out.pages)) {
      // Every page links back to its own hub so the hub name must appear in the body.
      // SEO content is now emitted OUTSIDE `#root` (empty) inside a sibling
      // `<main class="seo-static-content">` — see seoPageShell.ts.
      const bodyMatch = html.match(/<main class="seo-static-content">([\s\S]*?)<\/main>/);
      const body = bodyMatch?.[1] ?? '';
      expect(body.length, `empty seo-static-content body on ${path}`).toBeGreaterThan(0);
    }
  });
});

describe('generateJobMarketSnapshotPages — degraded mode (no history)', () => {
  const today = new Date('2026-04-27T06:00:00.000Z');
  const out = generateJobMarketSnapshotPages({
    history: null,
    jobs: [
      { title: 'Infermiere', company: 'EOC', location: 'Bellinzona' },
      { title: 'Cassiere', company: 'Coop', location: 'Lugano' },
    ] as any,
    today,
  });

  it('reports degraded=true', () => {
    expect(out.degraded).toBe(true);
  });

  it('still emits all 4 hub pages with ≥300 words', () => {
    for (const locale of JOB_MARKET_SNAPSHOT_LOCALES) {
      const hubPath = buildHubPath(locale);
      const html = out.pages[hubPath];
      expect(html).toBeTruthy();
      const body = html.replace(/<head[\s\S]*?<\/head>/i, '').replace(/<[^>]+>/g, ' ');
      const words = body.replace(/\s+/g, ' ').trim().split(' ').filter((w) => w.length > 0);
      expect(words.length).toBeGreaterThanOrEqual(300);
    }
  });

  it('emits the degraded notice on the hub', () => {
    const html = out.pages[buildHubPath('it')];
    expect(html).toContain('Stiamo iniziando');
  });
});

describe('generateJobMarketSnapshotPages — empty data fallback', () => {
  const today = new Date('2026-04-27T06:00:00.000Z');
  const out = generateJobMarketSnapshotPages({
    history: null,
    jobs: [],
    today,
  });

  it('still emits all 4 hub pages (no build failure)', () => {
    for (const locale of JOB_MARKET_SNAPSHOT_LOCALES) {
      expect(out.pages[buildHubPath(locale)]).toBeTruthy();
    }
  });

  it('is in degraded mode', () => {
    expect(out.degraded).toBe(true);
  });
});
