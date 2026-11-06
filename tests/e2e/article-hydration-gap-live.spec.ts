import { test, expect, type Page } from 'playwright/test';
import {
  installStaticHandoffProbe,
  judgeStaticHandoff,
  type HandoffProbeOptions,
  type HandoffRecord,
} from '../helpers/staticHandoffProbe';

/**
 * Live guard for issue 12421: an article page, and a canton topic hub, went
 * blank for seconds between the static HTML and the SPA view.
 *
 * WHY LIVE. The gap needs the page the shard serves, the bundle that was
 * deployed, and the runtime payloads, all at once. The daily brief adds the
 * case that broke hardest: an edition dated today is by construction newer than
 * the bundle, so the SPA has to resolve it at runtime.
 *
 * WHAT IS ASSERTED is in `judgeStaticHandoff` and unit-tested in
 * tests/article-hydration-handoff.test.ts: from the first paint of the static
 * snapshot until the SPA copy has settled (or a version-skewed canton payload
 * leaves the fail-closed snapshot in charge), a reader sees exactly one body,
 * the snapshot does not move while it is on screen, and the SPA `<main>` is
 * not painted above it. Sampled every animation frame, not on a 250 ms tick: a
 * blank that lasts 100 ms is still a blank.
 *
 * ON THE PLAIN URL, like daily-brief-table-parity-live.spec.ts: what the edge
 * serves is what the reader gets.
 *
 * Selected by playwright.live.config.ts (`*-live.spec.ts`), so it runs after a
 * deploy. Until this fix is live it is red, which is the point.
 */

const BASE = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/+$/, '');

const BRIEFS = [
  { locale: 'it', hub: '/articoli-frontaliere/', slug: 'bollettino-frontaliere' },
  { locale: 'en', hub: '/en/cross-border-articles/', slug: 'cross-border-daily-brief' },
  { locale: 'de', hub: '/de/grenzgaenger-artikel/', slug: 'grenzgaenger-tagesbulletin' },
  { locale: 'fr', hub: '/fr/articles-frontalier/', slug: 'bulletin-frontalier' },
] as const;

/** The edition is dated in UTC, the same clock the generator uses. */
const editionDate = (daysBack: number) => new Date(Date.now() - daysBack * 86_400_000).toISOString().slice(0, 10);

const ARTICLE_PROBE: HandoffProbeOptions = {
  snapshotSelector: 'main.seo-static-content article.ft-blog-article',
  settleMs: 1500,
  limitMs: 30_000,
};
const TOPIC_HUB_PROBE: HandoffProbeOptions = { ...ARTICLE_PROBE, snapshotSelector: 'main.seo-static-content' };

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
});

async function openWithProbe(page: Page, url: string, probe: HandoffProbeOptions): Promise<number | undefined> {
  await page.addInitScript(installStaticHandoffProbe, probe);
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  return response?.status();
}

async function readHandoff(page: Page, probe: HandoffProbeOptions): Promise<HandoffRecord> {
  await page.waitForFunction(
    () => (window as unknown as { __staticHandoff?: HandoffRecord }).__staticHandoff?.endedAt,
    undefined,
    { timeout: probe.limitMs + 10_000 },
  );
  return page.evaluate(() => (window as unknown as { __staticHandoff: HandoffRecord }).__staticHandoff);
}

function expectCleanHandoff(
  label: string,
  url: string,
  record: HandoffRecord,
  { allowStableSnapshot = false }: { allowStableSnapshot?: boolean } = {},
): void {
  const verdict = judgeStaticHandoff(record, { allowStableSnapshot });
  // One line a red check can be read from, without reopening a browser.
  console.log(
    `[static-handoff] ${label} snapshotMs=${verdict.firstSnapshotMs ?? 'n/a'} swapMs=${verdict.swapMs ?? 'n/a'} `
    + `gapMs=${verdict.gapMs} bothMs=${verdict.bothMs} spaMainOverSnapshotMs=${verdict.spaMainOverSnapshotMs} `
    + `snapshotShiftPx=${verdict.snapshotShiftPx} layoutShift=${record.layoutShift.toFixed(4)} `
    + `outcome=${record.settled ? 'spa' : 'static-fallback'} samples=${record.samples} `
    + `longestSampleGapMs=${record.longestSampleGapMs} url=${url}`,
  );
  expect(verdict.violations, `${label}: ${url}`).toEqual([]);
}

test.describe('static article → SPA handoff', () => {
  for (const { locale, hub, slug } of BRIEFS) {
    test(`${locale}: the daily brief is on screen from first paint to hydration`, async ({ page }) => {
      // Before the morning's generation today's edition is a 404: yesterday's
      // is the same handoff (by then it may be in the bundle, which is the
      // other class this guards), so the check still has a subject at any hour.
      let url = `${BASE}${hub}${slug}-${editionDate(0)}/`;
      let status = await openWithProbe(page, url, ARTICLE_PROBE);
      if (status === 404) {
        url = `${BASE}${hub}${slug}-${editionDate(1)}/`;
        status = (await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 }))?.status();
      }
      test.skip(status === 404, `no edition published for ${editionDate(0)} or ${editionDate(1)} in ${locale}`);
      expect(status, `${url} must serve 200`).toBe(200);

      expectCleanHandoff(`brief-${locale}`, url, await readHandoff(page, ARTICLE_PROBE));
    });
  }

  // Same class, different snapshot: the hub is drawn from a runtime payload,
  // and its static HTML sits in the build-time rail grid.
  test('it: a canton topic hub is on screen from first paint to hydration', async ({ page }) => {
    const url = `${BASE}/articoli-ticino/fisco/`;
    const status = await openWithProbe(page, url, TOPIC_HUB_PROBE);
    expect(status, `${url} must serve 200`).toBe(200);

    const record = await readHandoff(page, TOPIC_HUB_PROBE);
    // The runtime contract rejects a canton-hub payload whose commit differs
    // from the edge registry. In that fail-closed state the complete corpus
    // snapshot deliberately remains the only page body; it is a valid handoff
    // outcome as long as the probe saw no blank, duplicate or moving frame.
    expectCleanHandoff('topic-hub-it', url, record, { allowStableSnapshot: true });
    if (record.settled) {
      // Removed at the swap, not hidden: left behind, the rail grid is an empty
      // band after the footer and the snapshot a second copy of the page.
      expect(await page.locator('main.seo-static-content').count()).toBe(0);
      expect(await page.locator('body > .ft-rail-grid').count()).toBe(0);
    } else {
      await expect(page.locator('main.seo-static-content')).toBeVisible();
      expect(await page.locator('body > .ft-rail-grid').count()).toBe(1);
    }
  });
});
