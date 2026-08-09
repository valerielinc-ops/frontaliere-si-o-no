import { test, expect } from 'playwright/test';

/**
 * Live parity guard for the daily brief's pipe tables (issue #5415 §6, criterio 1).
 *
 * THE WINDOW THIS GUARDS IS THE ONE THAT BROKE. On 2026-08-08 the edition's two
 * tables reached readers as raw pipes in all four locales, and no gate saw it,
 * because the failure needs three things that only meet in production on
 * PUBLICATION DAY:
 *
 *   1. the static engine renders the body (`articleSeoFallback.ts`);
 *   2. the SPA bundle deployed that morning does NOT contain an edition dated
 *      that same day — it cannot, it was built before the edition existed;
 *   3. so the SPA rebuilds the markdown FROM THE STATIC HTML
 *      (`runtimeArticleResolution.ts`) and re-renders it.
 *
 * A unit test can pin any one of those. Only the live page has all three at
 * once, which is why this runs against production and not `localhost:4173`.
 *
 * ASSERTED ON BOTH SURFACES, because the bug was a DISAGREEMENT between them:
 *   - the static HTML the browser received (the navigation response itself, not
 *     a second request — a second request can land on a different cache
 *     variant, and this file exists because surfaces disagree);
 *   - the DOM after hydration, i.e. what the reader actually looks at.
 *
 * ON RAW SEPARATORS RATHER THAN ON `<table>` ALONE. A `|---|` left in the
 * VISIBLE TEXT is the reader-facing symptom; counting tables alone would go
 * green on a page that renders one table and spills the other as pipes.
 * Visible text, not HTML: a `|` inside an attribute harms nobody.
 *
 * ON TODAY'S EDITION, NOT A PINNED DATE. A spec pinned to one date guards the
 * day it was written and nothing after. The edition id is
 * `bollettino-frontaliere-<YYYY-MM-DD>`; when this runs before the morning's
 * generation the URL 404s and the test SKIPS with the reason, the same way
 * post-deploy-rendering-live.spec.ts skips an expired job rather than failing
 * on a separate concern.
 *
 * ON THE PLAIN URL, NOT A CACHE-BUSTED ONE. What the edge serves IS what the
 * reader gets: measured 2026-08-08, the origin had already been fixed while
 * `cf-cache-status: HIT` kept serving the broken copy for the remainder of a
 * 4h `max-age`. Busting the cache here would turn a real reader-facing failure
 * into a green check. The live config's single CI retry absorbs genuine
 * propagation flap; a persistent failure means a purge is owed.
 */

const BASE = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/$/, '');

/** Per-locale hub path + edition slug prefix, as `dailyBriefSlugs` emits them. */
const LOCALES = [
  { locale: 'it', hub: '/articoli-frontaliere/', slug: 'bollettino-frontaliere' },
  { locale: 'en', hub: '/en/cross-border-articles/', slug: 'cross-border-daily-brief' },
  { locale: 'de', hub: '/de/grenzgaenger-artikel/', slug: 'grenzgaenger-tagesbulletin' },
  { locale: 'fr', hub: '/fr/articles-frontalier/', slug: 'bulletin-frontalier' },
] as const;

/** The edition is dated in UTC, the same clock `TODAY_ISO` uses in the generator. */
const editionDate = () => new Date().toISOString().slice(0, 10);

const RAW_SEPARATOR = /\|\s*:?-{2,}:?\s*\|/;

/** Visible text of a raw HTML document: script/style out, then tags to newlines. */
function visibleText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, '\n');
}

test.describe('daily brief — pipe tables survive both renders', () => {
  for (const { locale, hub, slug } of LOCALES) {
    test(`${locale}: table rendered statically and after hydration`, async ({ page }) => {
      const url = `${BASE}${hub}${slug}-${editionDate()}/`;

      // The navigation response body IS the static HTML the browser got. Read it
      // from the response rather than re-fetching, so both halves of the
      // comparison describe the same delivered document.
      let staticHtml = '';
      page.on('response', async (res) => {
        if (res.url() === url && res.request().resourceType() === 'document') {
          staticHtml = await res.text().catch(() => '');
        }
      });

      const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
      test.skip(
        response?.status() === 404,
        `edition for ${editionDate()} not published yet in ${locale} — generation runs at 05:05 UTC`,
      );
      expect(response?.status(), `${url} must serve 200`).toBe(200);
      if (!staticHtml) staticHtml = await response!.text();

      // ── static surface ──
      expect(staticHtml, 'static HTML must render the tables as <table>').toContain('<table');
      expect(
        RAW_SEPARATOR.test(visibleText(staticHtml)),
        'static HTML leaks a raw |---| separator into the visible text',
      ).toBe(false);

      // ── hydrated surface ──
      // Bounded like the other live specs (spa-hydration-contract-live.spec.ts,
      // job-company-link-visual-live.spec.ts): AdSense/analytics keep polling on
      // this site, so unbounded networkidle never resolves and eats the whole
      // 60s test timeout before the assertions below ever run.
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page
        .waitForFunction(() => !!document.querySelector('#root')?.textContent?.trim(), { timeout: 30_000 })
        .catch(() => {});

      const hydrated = await page.evaluate(() => {
        const root = (document.querySelector('#root') as HTMLElement | null) || document.body;
        // innerText, not textContent: only what is actually visible counts.
        return { tables: root.querySelectorAll('table').length, text: root.innerText || '' };
      });

      expect(hydrated.tables, 'hydrated DOM must still hold the tables').toBeGreaterThan(0);
      expect(
        RAW_SEPARATOR.test(hydrated.text),
        'hydrated DOM shows a raw |---| separator — the reconstruction lost the table',
      ).toBe(false);
    });
  }
});
