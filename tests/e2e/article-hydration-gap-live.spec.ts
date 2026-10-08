import { test, expect } from 'playwright/test';

/**
 * Live guard for issue 12421. The daily brief is intentionally newer than the
 * deployed bundle, so this exercises the runtime article-resolution path that
 * a local fixture cannot reproduce faithfully.
 *
 * This spec is selected automatically by playwright.live.config.ts because its
 * filename ends in -live.spec.ts. It must run after deployment: the current
 * production bundle predates this fix and is expected to show the gap.
 */

const BASE = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/+$/, '');

const LOCALES = [
  { locale: 'it', hub: '/articoli-frontaliere/', slug: 'bollettino-frontaliere' },
  { locale: 'en', hub: '/en/cross-border-articles/', slug: 'cross-border-daily-brief' },
  { locale: 'de', hub: '/de/grenzgaenger-artikel/', slug: 'grenzgaenger-tagesbulletin' },
  { locale: 'fr', hub: '/fr/articles-frontalier/', slug: 'bulletin-frontalier' },
] as const;

const editionDate = () => new Date().toISOString().slice(0, 10);

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  hasTouch: true,
  isMobile: true,
});

for (const { locale, hub, slug } of LOCALES) {
  test(`article hydration has no sampled gap (${locale})`, async ({ page }) => {
    await page.addInitScript(() => {
      const probe = {
        samplePeriodMs: 250,
        startedAt: null as number | null,
        hydratedAt: null as number | null,
        staticHiddenAt: null as number | null,
        exchangeAt: null as number | null,
        totalGapMs: 0,
        gapStartedAt: null as number | null,
        samples: [] as Array<{ at: number; staticVisible: boolean; spaVisible: boolean }>,
        violations: [] as Array<{ at: number; staticVisible: boolean; spaVisible: boolean }>,
        done: false,
        timedOut: false,
      };

      const visible = (element: Element | null): boolean => {
        if (!element || element.getClientRects().length === 0) return false;
        let current: Element | null = element;
        while (current) {
          const style = window.getComputedStyle(current);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
          current = current.parentElement;
        }
        return true;
      };

      const surfaceState = () => {
        const staticArticle = document.querySelector('main.seo-static-content article.ft-blog-article');
        const spaArticle = document.querySelector('#root article');
        const hasArticleContent = (article: Element | null) => Boolean(
          article
          && article.querySelector('h1')
          && (article.textContent || '').trim().length > 80,
        );
        return {
          staticVisible: visible(staticArticle) && hasArticleContent(staticArticle),
          spaVisible: visible(spaArticle) && hasArticleContent(spaArticle),
        };
      };

      let timer: number | undefined;
      let timeout: number | undefined;

      const finish = (timedOut: boolean) => {
        if (probe.done) return;
        if (probe.gapStartedAt !== null) {
          probe.totalGapMs += performance.now() - probe.gapStartedAt;
          probe.gapStartedAt = null;
        }
        probe.timedOut = timedOut;
        probe.done = true;
        if (timer !== undefined) window.clearInterval(timer);
        if (timeout !== undefined) window.clearTimeout(timeout);
      };

      const sample = () => {
        if (probe.done || probe.startedAt === null) return;
        const at = performance.now();
        const state = surfaceState();
        const sample = { at, ...state };
        probe.samples.push(sample);
        if (!state.staticVisible && !state.spaVisible) {
          probe.violations.push(sample);
          if (probe.gapStartedAt === null) probe.gapStartedAt = at;
        } else if (probe.gapStartedAt !== null) {
          probe.totalGapMs += at - probe.gapStartedAt;
          probe.gapStartedAt = null;
        }
        if (!state.staticVisible && probe.staticHiddenAt === null) probe.staticHiddenAt = at;
        if (state.spaVisible && probe.exchangeAt === null) probe.exchangeAt = at;
        if (state.spaVisible) {
          probe.hydratedAt = at;
          finish(false);
        }
      };

      const start = () => {
        if (probe.startedAt !== null || probe.done) return;
        probe.startedAt = performance.now();
        sample();
        timer = window.setInterval(sample, probe.samplePeriodMs);
        timeout = window.setTimeout(() => finish(true), 30_000);
      };

      (window as Window & { __articleHydrationProbe?: typeof probe }).__articleHydrationProbe = probe;

      try {
        const observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.name === 'first-paint' || entry.name === 'first-contentful-paint') start();
          }
          if (probe.startedAt !== null) observer.disconnect();
        });
        observer.observe({ type: 'paint', buffered: true });
      } catch {
        // The animation-frame fallback still starts after the first browser frame.
      }

      requestAnimationFrame(() => requestAnimationFrame(() => start()));
    });

    const url = `${BASE}${hub}${slug}-${editionDate()}/`;
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    test.skip(
      response?.status() === 404,
      `edition for ${editionDate()} not published yet in ${locale} — this check runs on the publication day,
and the first production execution is expected only after this fix is deployed`,
    );
    expect(response?.status(), `${url} must serve 200`).toBe(200);

    await page.waitForFunction(
      () => Boolean((window as Window & { __articleHydrationProbe?: { done: boolean } }).__articleHydrationProbe?.done),
      { timeout: 35_000 },
    );

    const result = await page.evaluate(() => {
      const probe = (window as Window & {
        __articleHydrationProbe?: {
          startedAt: number | null;
          hydratedAt: number | null;
          staticHiddenAt: number | null;
          exchangeAt: number | null;
          totalGapMs: number;
          samples: Array<{ at: number; staticVisible: boolean; spaVisible: boolean }>;
          violations: Array<{ at: number; staticVisible: boolean; spaVisible: boolean }>;
          done: boolean;
          timedOut: boolean;
        };
      }).__articleHydrationProbe;
      if (!probe) throw new Error('article hydration probe did not initialize');
      return {
        startedAt: probe.startedAt,
        hydratedAt: probe.hydratedAt,
        staticHiddenAt: probe.staticHiddenAt,
        exchangeAt: probe.exchangeAt,
        totalGapMs: probe.totalGapMs,
        samples: probe.samples,
        violations: probe.violations,
        done: probe.done,
        timedOut: probe.timedOut,
      };
    });

    const elapsed = (at: number | null) => (
      at === null || result.startedAt === null ? null : Math.round(at - result.startedAt)
    );
    console.log(
      `[article-hydration] ${locale} gapMs=${Math.round(result.totalGapMs)} `
      + `exchangeMs=${elapsed(result.exchangeAt) ?? 'n/a'} `
      + `staticHiddenMs=${elapsed(result.staticHiddenAt) ?? 'n/a'} `
      + `hydratedMs=${elapsed(result.hydratedAt) ?? 'n/a'} `
      + `samples=${result.samples.length}`,
    );

    expect(result.done, `${locale} probe must finish`).toBe(true);
    expect(result.timedOut, `${locale} article did not hydrate within 30s`).toBe(false);
    expect(result.hydratedAt, `${locale} must expose an SPA article before the probe ends`).not.toBeNull();
    expect(
      result.violations,
      `${locale} sampled a frame with neither visible static article nor visible SPA article`,
    ).toEqual([]);
  });
}
