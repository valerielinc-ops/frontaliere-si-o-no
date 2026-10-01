import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateBorderWaitPages, type BorderWaitCurrent } from '../build-plugins/borderWaitPagesPlugin';
import { buildOggiPath, buildRootHubPath } from '../build-plugins/borderWaitData';
import { generateHealthPremiumsPages, type HealthPremiumsDataset } from '../build-plugins/healthPremiumsLandingPlugin';
import { buildHealthPremiumsRootPath, buildHealthPremiumsCantonPath, buildHealthPremiumsLeafPath } from '../build-plugins/healthPremiumsData';
import { BORDER_WAIT_HYDRATION_JS } from '../build-plugins/borderWaitHydrationScript';
import { formatSourceDate } from '../services/dataFreshness';

const today = new Date();
const daysAgo = (n: number) => new Date(today.getTime() - n * 86400000).toISOString();
const observedAt = daysAgo(2);
const current: BorderWaitCurrent = {
  updatedAt: daysAgo(1),
  perCrossing: { 'chiasso-brogeda': { waitTimeMinutes: 9, source: 'tomtom', lastUpdate: observedAt } },
};
const borderPages = generateBorderWaitPages({ current, today });
const premiumDataset: HealthPremiumsDataset = {
  year: today.getUTCFullYear() - 1, fetchedAt: daysAgo(40),
  insurers: [{ id: 'one', name: 'One' }, { id: 'two', name: 'Two' }],
  premiums: { TI: { canton: 'TI', type: 'canton', insurers: { one: { standard: 300 }, two: { standard: 350 } } } },
};
const premiumPages = generateHealthPremiumsPages({ dataset: premiumDataset, today }).pages;
const locales = ['it', 'en', 'de', 'fr'] as const;
const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const webpage = (html: string) => [...parse(html).querySelectorAll('script[type="application/ld+json"]')]
  .map((s) => JSON.parse(s.textContent!)).flatMap((s) => s['@graph'] ?? [s]).find((s) => s['@type'] === 'WebPage');

function doc(slug: string, lastUpdate: string, source = 'here') {
  return { name: `trafficCurrent/${slug}`, fields: { waitTimeMinutes: { integerValue: '3' }, totalCrossingMinutes: { integerValue: '3' }, source: { stringValue: source }, lastUpdate: { timestampValue: lastUpdate } } };
}
async function hydrate(documents: ReturnType<typeof doc>[], locale = 'it') {
  document.documentElement.lang = locale;
  document.body.innerHTML = `<section data-bw-crossing="chiasso-brogeda"><span data-bw-field="totalCrossingMinutes">9 min</span><span data-bw-field="lastUpdate">old snapshot</span><a href="https://www.tomtom.com/" data-bw-field="source">TomTom</a></section><span data-bw-live-badge data-bw-badge-crossing="chiasso-brogeda">original observed snapshot</span>`;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ documents }) }));
  new Function(BORDER_WAIT_HYDRATION_JS)();
  document.dispatchEvent(new Event('DOMContentLoaded'));
  await vi.waitFor(() => expect(document.querySelector('[data-bw-crossing]')?.getAttribute('data-bw-hydrated')).toBe('true'));
}
afterEach(() => {
  clearTimeout((window as unknown as { __bwTimer?: ReturnType<typeof setTimeout> }).__bwTimer);
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('B4.4 emitted source freshness', () => {
  it.each(locales)('%s dogane preserve observation dates, primary sources and expired status', (locale) => {
    const html = borderPages[buildOggiPath(locale, 'chiasso-brogeda')];
    const parsed = parse(html);
    expect(webpage(html).dateModified).toBe(observedAt);
    expect(webpage(html).datePublished).toBeUndefined();
    const card = parsed.querySelector('[aria-labelledby="currentStatus"]')!;
    expect(card.getAttribute('data-bw-data-state')).toBe('stale');
    expect(card.querySelector('[data-bw-field="lastUpdate"]')?.textContent).toBe(formatSourceDate(observedAt, locale, today));
    expect(card.querySelector('a[data-bw-field="source"]')?.getAttribute('href')).toBe('https://www.tomtom.com/');
    expect(parsed.querySelector('header time')?.getAttribute('datetime')).toBe(today.toISOString());
    expect(webpage(borderPages[buildRootHubPath(locale)]).dateModified).toBe(current.updatedAt);
    expect(webpage(borderPages[buildOggiPath(locale, 'gaggiolo')]).dateModified).toBeUndefined();
  });
  it.each(locales)('%s premiums show retrieval, validity year and generation separately', (locale) => {
    for (const path of [buildHealthPremiumsRootPath(locale), buildHealthPremiumsCantonPath(locale, 'ticino'), buildHealthPremiumsLeafPath(locale, 'ticino', '31-45')]) {
      const html = premiumPages[path];
      expect(html).toBeDefined();
      expect(webpage(html).dateModified).toBe(premiumDataset.fetchedAt);
      expect(webpage(html).datePublished).toBeUndefined();
      const freshness = parse(html).querySelector('[data-premium-freshness]')!;
      expect(freshness.getAttribute('data-premium-freshness')).toBe('stale');
      expect(freshness.querySelector('time')?.getAttribute('datetime')).toBe(premiumDataset.fetchedAt);
      expect(freshness.textContent).toContain(String(premiumDataset.year));
      expect(freshness.querySelector('a')?.getAttribute('href')).toBe('https://www.priminfo.admin.ch/');
    }
  });
  it('never substitutes build time when a premium retrieval date is missing', () => {
    const pages = generateHealthPremiumsPages({ dataset: { ...premiumDataset, year: today.getUTCFullYear(), fetchedAt: undefined }, today }).pages;
    const html = pages[buildHealthPremiumsRootPath('it')];
    expect(webpage(html).dateModified).toBeUndefined();
    expect(parse(html).querySelector('[data-premium-freshness]')?.getAttribute('data-premium-freshness')).toBe('unknown');
  });
});

describe('B4.4 runtime observation freshness', () => {
  it.each(locales)('%s preserves an expired crossing timestamp even when another crossing is fresh', async (locale) => {
    await hydrate([doc('chiasso-brogeda', observedAt), doc('gaggiolo', daysAgo(0))], locale);
    expect(document.querySelector('[data-bw-crossing]')?.getAttribute('data-bw-data-state')).toBe('stale');
    expect(document.querySelector('[data-bw-live-badge]')?.getAttribute('data-bw-live')).toBe('false');
    expect(document.querySelector('[data-bw-field="lastUpdate"]')?.textContent).toContain(String(new Date(observedAt).getUTCFullYear()));
    expect(document.querySelector('[data-bw-field="source"]')?.getAttribute('href')).toBe('https://www.here.com/');
  });
  it('does not borrow a fresh badge from an unrelated crossing when the requested reading is absent', async () => {
    await hydrate([doc('gaggiolo', daysAgo(0))]);
    expect(document.querySelector('[data-bw-crossing]')?.getAttribute('data-bw-data-state')).toBe('unavailable');
    expect(document.querySelector('[data-bw-live-badge]')?.getAttribute('data-bw-live')).toBe('false');
    expect(document.querySelector('[data-bw-field="source"]')?.hasAttribute('href')).toBe(false);
  });
  it('marks a cached snapshot expired and keeps its date when the live request fails', async () => {
    const oldTimestamp = Date.parse(observedAt);
    document.documentElement.lang = 'it';
    document.body.innerHTML = `<section data-bw-crossing="chiasso-brogeda" data-bw-observed-at="${oldTimestamp}"><span data-bw-field="lastUpdate">old snapshot</span></section><span data-bw-live-badge data-bw-observed-at="${oldTimestamp}">old snapshot</span>`;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    new Function(BORDER_WAIT_HYDRATION_JS)();
    document.dispatchEvent(new Event('DOMContentLoaded'));
    await vi.waitFor(() => expect(document.querySelector('[data-bw-live-badge]')?.getAttribute('data-bw-fetch-state')).toBe('offline'));
    expect(document.querySelector('[data-bw-crossing]')?.getAttribute('data-bw-data-state')).toBe('stale');
    expect(document.querySelector('[data-bw-field="lastUpdate"]')?.textContent).toContain('Dato scaduto');
    expect(document.querySelector('[data-bw-live-badge]')?.textContent).toContain(String(new Date(observedAt).getUTCFullYear()));
    vi.restoreAllMocks();
  });
  it('accepts a fresh requested reading and rejects future timestamps', async () => {
    await hydrate([doc('chiasso-brogeda', daysAgo(0))]);
    expect(document.querySelector('[data-bw-live-badge]')?.getAttribute('data-bw-live')).toBe('true');
    await hydrate([doc('chiasso-brogeda', daysAgo(-1))]);
    expect(document.querySelector('[data-bw-crossing]')?.getAttribute('data-bw-data-state')).toBe('unavailable');
  });
});
