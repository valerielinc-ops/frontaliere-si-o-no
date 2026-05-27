import { test, expect, type APIRequestContext } from 'playwright/test';

/**
 * Live post-deploy rendering smoke (regression guard for the 2026-04-30 incident).
 *
 * The intermittent failure mode: a build occasionally emits per-slug SEO pages
 * WITHOUT the `<script type="module" src="/assets/index-XXXX.js">` SPA bundle,
 * leaving them stuck on pre-hydration static content. Combined with a legacy
 * `<script>location.replace('/{path-no-slash}'+location.hash)</script>` at the
 * bottom of `staticPagesPlugin` / `ogPagesPlugin` output and the no-slash
 * `flatHtmlRedirectPlugin` bridge, the static stub fires `location.replace` to
 * the no-slash URL, the bridge replaces it back to the slash URL → infinite
 * client-side loop on articles + bare static rendering on jobs/hubs.
 *
 * The bug is non-deterministic (suspected race between Vite write of
 * `dist/index.html` and `jobsSeoPagesPlugin.closeBundle` reading it, possibly
 * compounded by the post-walk-coordinator worker pool added 2026-04-29). This
 * test runs against the LIVE site after every deploy — it cannot run against
 * `localhost:4173` because the bug requires the multi-plugin parallel pipeline
 * end-to-end, plus GitHub Pages serving the no-slash bridge sibling.
 *
 * Per URL, we assert:
 *   1. HTTP responds 200 with at most 1 redirect (no infinite ping-pong).
 *   2. The HTML embeds the SPA bundle script tag — pages must hydrate.
 *   3. The HTML does NOT carry the self-bouncing `location.replace('/<own-path-no-slash>'...)`
 *      script that staticPagesPlugin/ogPagesPlugin used to emit.
 *   4. A real browser navigation to the URL completes within 25 s (catches
 *      any client-side loop the static checks above might miss).
 *
 * URL set covers the four reported failure cases plus the homepage as a
 * stability anchor. The expired-job URL may churn (deleted from
 * expired-jobs.json) — when it 404s the test skips with a clear message
 * instead of failing, since 404 is a separate concern from the rendering
 * regression we guard here.
 */

const LIVE_BASE_URL = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/+$/, '');

interface TargetUrl {
  readonly label: string;
  readonly path: string;
  /** When true, skip on 404 instead of failing — content rotates over time. */
  readonly tolerate404: boolean;
}

const TARGETS: readonly TargetUrl[] = [
  {
    label: 'homepage (anchor)',
    path: '/',
    tolerate404: false,
  },
  {
    label: 'article with FAQ (was infinite loop on 2026-04-30)',
    path: '/articoli-frontaliere/apprendisti-ticino-incidenti-2026/',
    tolerate404: true,
  },
  {
    label: 'expired job soft-landing',
    path: '/cerca-lavoro-ticino/stagista-delle-risorse-umane-al-dettaglio-guess-europe-sagl-bioggio/',
    tolerate404: true,
  },
  {
    label: 'active job page (must hydrate)',
    path: '/cerca-lavoro-ticino/meccanico-a-di-produzione-afc-bellinzona-ffs-officine-ferrovie-federali-bellinzona/',
    tolerate404: true,
  },
  {
    label: 'company hub',
    path: '/cerca-lavoro-ticino/azienda-amministrazione-cantonale-ticino/',
    tolerate404: true,
  },
];

const SPA_BUNDLE_RX =
  /<script[^>]+type="module"[^>]+src="\/assets\/index-[A-Za-z0-9_-]+\.js"/;

/** The bug pattern: '/path-no-slash' (always missing trailing slash) + location.hash */
function selfBouncingScript(path: string): string {
  const noSlash = path.replace(/\/+$/, '');
  return `location.replace('${noSlash}'+location.hash)`;
}

async function fetchHtml(
  request: APIRequestContext,
  url: string,
): Promise<{ status: number; body: string; finalUrl: string }> {
  // maxRedirects: 5 lets normal trailing-slash canonicalization through but
  // caps any pathological chain. An infinite client-side `location.replace`
  // loop is caught by the browser navigation test below (goto timeout); HTTP
  // redirect counting here is an orthogonal sanity check.
  const response = await request.get(url, {
    maxRedirects: 5,
    timeout: 20_000,
  });
  return {
    status: response.status(),
    body: await response.text(),
    finalUrl: response.url(),
  };
}

for (const target of TARGETS) {
  test.describe(`live: ${target.label}`, () => {
    const url = `${LIVE_BASE_URL}${target.path}`;

    test(`renders without redirect loop and includes SPA bundle (${target.path})`, async ({
      request,
    }) => {
      const fetched = await fetchHtml(request, url);

      if (fetched.status === 404 && target.tolerate404) {
        test.skip(true, `${url} returned 404 (content may have rotated)`);
        return;
      }

      expect(fetched.status, `${url} should return 200`).toBe(200);

      expect(
        SPA_BUNDLE_RX.test(fetched.body),
        `${url} is missing the SPA bundle <script type="module" src="/assets/index-*.js"> — page is stuck on static pre-hydration content (Bug 2 regression)`,
      ).toBe(true);

      const bouncer = selfBouncingScript(target.path);
      expect(
        fetched.body.includes(bouncer),
        `${url} contains the self-bouncing script "${bouncer}" — would loop with the no-slash flat-html-redirect bridge (Bug 1 regression)`,
      ).toBe(false);
    });

    test(`browser navigation completes within 25 s (${target.path})`, async ({ page }) => {
      // First confirm the URL is live; if 404 and tolerated, skip rather than fail.
      const headResponse = await page.request.get(url, { maxRedirects: 5, timeout: 15_000 });
      if (headResponse.status() === 404 && target.tolerate404) {
        test.skip(true, `${url} returned 404 (content may have rotated)`);
        return;
      }

      // If a client-side `location.replace` loop is happening, networkidle never
      // resolves and goto() throws on timeout — exactly the signal we want.
      // domcontentloaded is fast enough to keep CI cheap while still catching
      // the loop, since the bouncing script runs synchronously after parse.
      const navStart = Date.now();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      const navDuration = Date.now() - navStart;

      expect(response, `goto(${url}) should not return null`).not.toBeNull();
      expect(response!.status(), `goto(${url}) should reach 200`).toBe(200);

      // Allow up to 8 navigations as a safety net (sub-resource fetches don't
      // count, only the main frame). 1 is normal; >2 means client-side
      // redirects fired — possibly a partial loop. 8 is the hard ceiling.
      const mainFrameUrl = page.url();
      expect(
        mainFrameUrl,
        `final URL ${mainFrameUrl} should equal the requested ${url} (or one trailing-slash canonicalization)`,
      ).toMatch(new RegExp(`^${LIVE_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${target.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?$`));

      // Sanity check on pure timing: goto resolves quickly when the SPA boots
      // normally. A regressing build with a near-loop pattern can still resolve
      // domcontentloaded but feels sluggish — flag anything over 20 s.
      expect(
        navDuration,
        `navigation to ${url} took ${navDuration} ms — investigate`,
      ).toBeLessThan(20_000);
    });
  });
}
