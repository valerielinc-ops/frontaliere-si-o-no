// @vitest-environment jsdom
/**
 * Runs the real border-wait hydration IIFE against the real emitted markup of
 * the root hub table, a per-crossing leaf page and the live map landing.
 *
 * Regression: the IIFE used to toggle class `bw-live` on every hydrated
 * `[data-bw-crossing]` container, but `.bw-live` is the live badge pill in
 * `public/assets/seo-static.css` (inline-flex, uppercase, rounded, green). As
 * soon as the live feed returned fresh readings, every hub row, the leaf
 * status card, the comparison rows and the map cards rendered as pills.
 * Hydration must replace field text and data attributes only — never the
 * container's class.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BORDER_WAIT_HYDRATION_JS } from '../build-plugins/borderWaitHydrationScript';
import { generateBorderWaitPages, type BorderWaitCurrent } from '../build-plugins/borderWaitPagesPlugin';
import { buildOggiPath, buildRegionalHubPath, buildRootHubPath } from '../build-plugins/borderWaitData';
import { renderPage } from '../build-plugins/borderWaitMapPlugin';
import { BORDER_READING_MAX_AGE_MS } from '../services/dataFreshness';

const SNAPSHOT_AT = new Date(Date.now() - 60_000).toISOString();

const FIXTURE_CURRENT: BorderWaitCurrent = {
  updatedAt: SNAPSHOT_AT,
  perCrossing: {
    'chiasso-brogeda': { waitTimeMinutes: 21, source: 'tomtom', lastUpdate: SNAPSHOT_AT, status: 'red' },
    gaggiolo: { waitTimeMinutes: 7, source: 'tomtom', lastUpdate: SNAPSHOT_AT, status: 'yellow' },
  },
};

const pages = generateBorderWaitPages({ current: FIXTURE_CURRENT });

function liveDoc(slug: string, minutes: number) {
  return {
    name: `projects/frontaliere-ticino/databases/(default)/documents/trafficCurrent/${slug}`,
    fields: {
      waitTimeMinutes: { integerValue: String(minutes) },
      totalCrossingMinutes: { integerValue: String(minutes) },
      status: { stringValue: 'green' },
      source: { stringValue: 'tomtom' },
      lastUpdate: { timestampValue: new Date().toISOString() },
    },
  };
}

async function hydrate(html: string, documents = [liveDoc('chiasso-brogeda', 3), liveDoc('gaggiolo', 4)]) {
  document.documentElement.innerHTML = new DOMParser().parseFromString(html, 'text/html').documentElement.innerHTML;
  // jsdom can discard the entire CSS declaration list for a border shorthand
  // containing var(). Its per-property parser accepts the same declarations.
  // Restore that fixture parsing before testing that hydration preserves layout.
  for (const element of document.querySelectorAll<HTMLElement>('[style]')) {
    const rawStyle = element.getAttribute('style') ?? '';
    if (!rawStyle || element.style.cssText) continue;
    for (const declaration of rawStyle.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon > 0) element.style.setProperty(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
    }
  }
  const containers = [...document.querySelectorAll<HTMLElement>('[data-bw-crossing]')];
  const classesBefore = containers.map((el) => el.className);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ documents }) }));
  new Function(BORDER_WAIT_HYDRATION_JS)();
  await vi.waitFor(() => {
    expect(document.querySelector('[data-bw-crossing]')?.getAttribute('data-bw-hydrated')).toBe('true');
  });
  return { containers, classesBefore };
}

const swapHost = (kind: 'hub' | 'advice') => document.querySelector<HTMLElement>(`[data-bw-swap="${kind}"]`);
const swapShown = (kind: 'hub' | 'advice') =>
  swapHost(kind)?.querySelector('[data-bw-swap-out]')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const slotText = (kind: 'hub' | 'advice', slot: string) =>
  swapHost(kind)?.querySelector(`[data-bw-swap-out] [data-bw-slot="${slot}"]`)?.textContent;

afterEach(() => {
  clearTimeout((window as unknown as { __bwTimer?: ReturnType<typeof setTimeout> }).__bwTimer);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.documentElement.innerHTML = '';
});

describe('border-wait mobile labels survive live updates', () => {
  it.each(['it', 'en', 'de', 'fr'] as const)('%s preserves all column labels and a single row per crossing', async (locale) => {
    await hydrate(pages[buildRegionalHubPath(locale, 'argovia-germania')], []);
    const table = document.querySelector('table[aria-labelledby="crossingTable"]')!;
    const headers = [...table.querySelectorAll('th[scope="col"]')].map((th) => th.textContent?.trim());
    const rows = [...table.querySelectorAll('[data-bw-crossing]')];
    expect(headers).toHaveLength(4);
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((row) => row.getAttribute('data-bw-crossing'))).size).toBe(rows.length);
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      expect(cells).toHaveLength(4);
      for (let column = 1; column < 4; column++) {
        const label = cells[column].querySelector('[aria-hidden="true"]');
        expect(label?.textContent?.replace(/:$/, '').trim()).toBe(headers[column]);
      }
      // Clearing unavailable readings must not erase their mobile labels.
      expect(cells[2].querySelector('[data-bw-field="lastUpdate"]')?.textContent).toBe('—');
    }
  });
});

describe('border-wait hydration — container classes stay untouched', () => {
  const cases: Array<[string, () => string]> = [
    ['root hub table rows', () => pages[buildRootHubPath('it')]],
    ['regional hub table rows', () => pages[buildRegionalHubPath('en', 'ticino-como')]],
    ['leaf status card and comparison rows', () => pages[buildOggiPath('it', 'chiasso-brogeda')]],
    ['live map crossing cards', () => renderPage({ locale: 'it', dateStamp: SNAPSHOT_AT.slice(0, 10), current: FIXTURE_CURRENT }).html],
  ];

  it.each(cases)('%s keep their markup classes after a live hydration', async (_label, html) => {
    const { containers, classesBefore } = await hydrate(html());

    expect(containers.length).toBeGreaterThan(0);
    expect(containers.map((el) => el.className)).toEqual(classesBefore);
    expect(document.querySelectorAll('[data-bw-crossing].bw-live')).toHaveLength(0);

    const live = document.querySelector('[data-bw-crossing="chiasso-brogeda"]');
    expect(live?.getAttribute('data-bw-hydrated')).toBe('true');
    expect(live?.getAttribute('data-bw-data-state')).toBe('live');
    expect(live?.querySelector('[data-bw-field="totalCrossingMinutes"]')?.textContent).toBe('3 min');
  });
});

/**
 * The hub hero/banner, the leaf advice, the minute colours and the
 * «dati live non disponibili» notice are present-tense claims computed from
 * the build snapshot. Before this, hydration refreshed only the numbers: the
 * hub kept «Tempi di attesa non disponibili» over a table full of live
 * readings, and a live 20 min stayed in the green pill painted for 0 min.
 */
describe('border-wait hydration — present-tense blocks follow the live readings', () => {
  it('keeps an expired observation visible without using it as the fastest current crossing', async () => {
    const stale = liveDoc('chiasso-brogeda', 1);
    stale.fields.lastUpdate.timestampValue = new Date(Date.now() - BORDER_READING_MAX_AGE_MS - 60_000).toISOString();
    await hydrate(pages[buildRootHubPath('it')], [stale, liveDoc('gaggiolo', 4)]);

    const row = document.querySelector('[data-bw-crossing="chiasso-brogeda"]');
    expect(row?.getAttribute('data-bw-data-state')).toBe('stale');
    expect(row?.querySelector('[data-bw-field="totalCrossingMinutes"]')?.textContent).toBe('1 min');
    expect(row?.querySelector('[data-bw-field="lastUpdate"]')?.textContent).toContain('Dato scaduto');
    expect(row?.querySelector('[data-bw-tone-bg]')?.getAttribute('style')).toContain('var(--color-surface-alt)');
    expect(slotText('hub', 'minutes')).toBe('4 min');
    expect(slotText('hub', 'link')).toContain('Gaggiolo');
  });

  it.each(['hub', 'advice'] as const)('%s stops giving current advice when cached readings expire during a failed refresh', async (kind) => {
    vi.useFakeTimers();
    const html = pages[kind === 'hub' ? buildRootHubPath('it') : buildOggiPath('it', 'chiasso-brogeda')];
    await hydrate(html, [liveDoc('chiasso-brogeda', 3)]);
    expect(swapHost(kind)?.getAttribute('data-bw-swap-state')).toBe(kind === 'hub' ? 'fastest' : 'ok');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    vi.setSystemTime(Date.now() + BORDER_READING_MAX_AGE_MS + 60_000);
    await vi.advanceTimersByTimeAsync(15 * 60_000);

    expect(document.querySelector('[data-bw-live-badge]')?.getAttribute('data-bw-fetch-state')).toBe('offline');
    expect(swapHost(kind)?.getAttribute('data-bw-swap-state')).toBe('unavailable');
    const row = document.querySelector('[data-bw-crossing="chiasso-brogeda"]');
    expect(row?.getAttribute('data-bw-data-state')).toBe('stale');
    expect(row?.querySelector('[data-bw-field="totalCrossingMinutes"]')?.textContent).toBe('3 min');
    expect(row?.querySelector('[data-bw-tone-bg]')?.getAttribute('style')).toContain('var(--color-surface-alt)');
  });

  it('hub: the fastest-crossing card moves to the live minimum', async () => {
    const html = pages[buildRootHubPath('it')];
    // Snapshot: brogeda 21, gaggiolo 7 → build-time card names Gaggiolo.
    expect(html).toMatch(/data-bw-swap=["']?hub["']? data-bw-swap-state=["']?fastest/);
    await hydrate(html, [liveDoc('chiasso-brogeda', 3), liveDoc('gaggiolo', 4)]);

    expect(swapHost('hub')?.getAttribute('data-bw-swap-state')).toBe('fastest');
    const rowLink = document.querySelector('[data-bw-crossing="chiasso-brogeda"] a[href]');
    const link = swapHost('hub')?.querySelector('[data-bw-swap-out] [data-bw-slot="link"]');
    expect(link?.textContent).toBe(rowLink?.textContent?.trim());
    expect(link?.getAttribute('href')).toBe(rowLink?.getAttribute('href'));
    expect(slotText('hub', 'minutes')).toBe('3 min');
  });

  it('hub: all-zero live readings on partial coverage say how many were measured', async () => {
    await hydrate(pages[buildRootHubPath('it')], [liveDoc('chiasso-brogeda', 0), liveDoc('gaggiolo', 0)]);

    expect(swapHost('hub')?.getAttribute('data-bw-swap-state')).toBe('fluid-measured');
    expect(swapShown('hub')).toContain('Traffico fluido sui valichi misurati');
    expect(slotText('hub', 'measured')).toBe('2');
    expect(slotText('hub', 'total')).toBe(String(document.querySelectorAll('tr[data-bw-crossing]').length));
    expect(swapShown('hub')).not.toContain('Tempi di attesa non disponibili');
  });

  it('hub: no fresh reading at all falls back to the unavailable banner', async () => {
    await hydrate(pages[buildRootHubPath('it')], []);

    expect(swapHost('hub')?.getAttribute('data-bw-swap-state')).toBe('unavailable');
    expect(swapShown('hub')).toContain('Tempi di attesa non disponibili');
  });

  it('hub: minute pills repaint with the live tone', async () => {
    const pill = (slug: string) =>
      document.querySelector(`[data-bw-crossing="${slug}"] [data-bw-field="totalCrossingMinutes"]`)?.getAttribute('style') ?? '';
    // Snapshot: brogeda 21 (bad), gaggiolo 7 (warn). Live flips both.
    await hydrate(pages[buildRootHubPath('it')], [liveDoc('chiasso-brogeda', 2), liveDoc('gaggiolo', 20)]);

    expect(pill('chiasso-brogeda')).toContain('var(--color-success-subtle)');
    expect(pill('chiasso-brogeda')).not.toContain('var(--color-danger-subtle)');
    expect(pill('gaggiolo')).toContain('var(--color-danger-subtle)');
    expect(pill('gaggiolo')).toContain('var(--color-danger)');
    expect(pill('gaggiolo')).not.toContain('var(--color-warning-subtle)');
    expect(pill('gaggiolo')).toContain('white-space');
  });

  it('leaf: advice and status tile follow the live tone', async () => {
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    expect(html).toMatch(/data-bw-swap=["']?advice["']? data-bw-swap-state=["']?bad/);
    await hydrate(html, [liveDoc('chiasso-brogeda', 3)]);

    expect(swapHost('advice')?.getAttribute('data-bw-swap-state')).toBe('ok');
    expect(swapHost('advice')?.querySelector('[data-bw-swap-out] [data-bw-advice-status]')?.getAttribute('data-bw-advice-status')).toBe('ok');
    const tile = document.querySelector('section[data-bw-crossing="chiasso-brogeda"] [data-bw-tone-bg]');
    expect(tile?.getAttribute('style')).toContain('var(--color-success-subtle)');
  });

  it('leaf: a swapped advice is the build-time advice of that tone and prints no minutes', async () => {
    // Snapshot 21 min → the build renders the «bad» advice with the real wait.
    // A live 20 min swaps to the «bad» template: same text, because the advice
    // depends on the tone and the historical hours only, never on the minutes.
    const html = pages[buildOggiPath('it', 'chiasso-brogeda')];
    document.documentElement.innerHTML = new DOMParser().parseFromString(html, 'text/html').documentElement.innerHTML;
    const buildTime = swapShown('advice');
    await hydrate(html, [liveDoc('chiasso-brogeda', 20)]);

    expect(swapHost('advice')?.getAttribute('data-bw-swap-state')).toBe('bad');
    expect(swapShown('advice')).toBe(buildTime);
    expect(swapShown('advice')).not.toMatch(/\d+\s*min\b/);
  });

  it('a non-numeric live wait counts as a missing reading', async () => {
    const broken = liveDoc('chiasso-brogeda', 0);
    broken.fields.waitTimeMinutes = { integerValue: 'n/a' };
    broken.fields.totalCrossingMinutes = { integerValue: 'n/a' };
    await hydrate(pages[buildRootHubPath('it')], [broken]);

    const row = document.querySelector('[data-bw-crossing="chiasso-brogeda"]');
    expect(row?.querySelector('[data-bw-field="totalCrossingMinutes"]')?.textContent).toBe('non disponibile');
    expect(row?.querySelector('[data-bw-field="totalCrossingMinutes"]')?.getAttribute('style')).toContain('var(--color-surface-alt)');
    expect(swapHost('hub')?.getAttribute('data-bw-swap-state')).toBe('unavailable');
  });

  it('leaf: the snapshot-only notice hides once a live reading arrives', async () => {
    // crociale-dei-mulini has no snapshot reading → static fallback notice.
    const html = pages[buildOggiPath('it', 'crociale-dei-mulini')];
    await hydrate(html, [liveDoc('crociale-dei-mulini', 2)]);

    const notice = document.querySelector<HTMLElement>('[data-bw-unless-live]');
    expect(notice).not.toBeNull();
    expect(notice?.hidden).toBe(true);
    expect(swapHost('advice')?.getAttribute('data-bw-swap-state')).toBe('ok');
  });

  it('leaf: without a fresh reading the notice stays and the advice says unavailable', async () => {
    await hydrate(pages[buildOggiPath('it', 'crociale-dei-mulini')], []);

    expect(document.querySelector<HTMLElement>('[data-bw-unless-live]')?.hidden).toBe(false);
    expect(swapHost('advice')?.getAttribute('data-bw-swap-state')).toBe('unavailable');
  });
});
