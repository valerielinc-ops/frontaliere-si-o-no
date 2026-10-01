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

const SNAPSHOT_AT = '2026-04-29T06:00:00.000Z';

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

async function hydrate(html: string) {
  document.documentElement.innerHTML = new DOMParser().parseFromString(html, 'text/html').documentElement.innerHTML;
  const containers = [...document.querySelectorAll<HTMLElement>('[data-bw-crossing]')];
  const classesBefore = containers.map((el) => el.className);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ documents: [liveDoc('chiasso-brogeda', 3), liveDoc('gaggiolo', 4)] }),
    }),
  );
  new Function(BORDER_WAIT_HYDRATION_JS)();
  await vi.waitFor(() => {
    expect(document.querySelector('[data-bw-crossing="chiasso-brogeda"]')?.getAttribute('data-bw-data-state')).toBe(
      'live',
    );
  });
  return { containers, classesBefore };
}

afterEach(() => {
  clearTimeout((window as unknown as { __bwTimer?: ReturnType<typeof setTimeout> }).__bwTimer);
  vi.unstubAllGlobals();
  document.documentElement.innerHTML = '';
});

describe('border-wait hydration — container classes stay untouched', () => {
  const cases: Array<[string, () => string]> = [
    ['root hub table rows', () => pages[buildRootHubPath('it')]],
    ['regional hub table rows', () => pages[buildRegionalHubPath('en', 'ticino-como')]],
    ['leaf status card and comparison rows', () => pages[buildOggiPath('it', 'chiasso-brogeda')]],
    ['live map crossing cards', () => renderPage({ locale: 'it', dateStamp: '2026-04-29', current: FIXTURE_CURRENT }).html],
  ];

  it.each(cases)('%s keep their markup classes after a live hydration', async (_label, html) => {
    const { containers, classesBefore } = await hydrate(html());

    expect(containers.length).toBeGreaterThan(0);
    expect(containers.map((el) => el.className)).toEqual(classesBefore);
    expect(document.querySelectorAll('[data-bw-crossing].bw-live')).toHaveLength(0);

    const live = document.querySelector('[data-bw-crossing="chiasso-brogeda"]');
    expect(live?.getAttribute('data-bw-hydrated')).toBe('true');
    expect(live?.querySelector('[data-bw-field="totalCrossingMinutes"]')?.textContent).toBe('3 min');
  });
});
