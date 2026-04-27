import { test, expect } from 'playwright/test';

/**
 * Regression guard for the 2026-04-27 autologin bug.
 *
 * Email job-alert and newsletter links use the no-trailing-slash form
 * (`/cerca-lavoro-ticino/{slug}?ne=&ac=`). GH Pages serves these from
 * `dist/{slug}.html` — a redirect bridge written by `flatHtmlRedirectPlugin`.
 *
 * Before the fix, the bridge did `location.replace(canonicalUrl)` with a
 * hardcoded URL, dropping `?ne=&ac=` before the SPA could consume them.
 * The autologin handler in App.tsx would silently bail (no email, no code),
 * leaving the user signed out.
 *
 * This test loads a no-slash URL with autologin params and asserts:
 *   1. The bridge redirects to the trailing-slash canonical
 *   2. `window.location.search` still contains `ne=` and `ac=` after redirect
 *
 * The bridge target is the production domain (`frontaliereticino.ch`); we
 * rewrite it to the local preview origin so the test runs against `dist/`
 * and stays hermetic in CI.
 */

const BRIDGE_TARGETS = ['/calcolatore', '/comparatori'];

const PROD_HOST = 'https://frontaliereticino.ch';
const PREVIEW_ORIGIN = 'http://localhost:4173';

for (const slugPath of BRIDGE_TARGETS) {
  test(`flat-html bridge preserves autologin params for ${slugPath}`, async ({ page, context }) => {
    // The bridge does `location.replace("https://frontaliereticino.ch/foo/" + search)`,
    // which would jump cross-origin to production. Intercept that navigation and
    // fulfill it as a 302 to the local preview equivalent so the test stays hermetic.
    await context.route(`${PROD_HOST}/**`, async (route) => {
      const rewritten = route.request().url().replace(PROD_HOST, PREVIEW_ORIGIN);
      await route.fulfill({ status: 302, headers: { Location: rewritten }, body: '' });
    });

    const fakeEmail = 'autologin-e2e@example.com';
    const fakeCode = 'fakehmac0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const startUrl = `${slugPath}?ne=${encodeURIComponent(fakeEmail)}&ac=${fakeCode}&utm_source=job_alert`;

    await page.goto(startUrl, { waitUntil: 'commit' });

    // The bridge issues `location.replace` synchronously inside <head>, so the
    // initial 'commit' navigation is immediately superseded. Wait for the URL
    // to settle on the trailing-slash canonical with the params preserved.
    await page.waitForURL(
      (url) => url.pathname.endsWith(`${slugPath}/`) && url.search.includes('ac='),
      { timeout: 10_000 },
    );

    const finalSearch = await page.evaluate(() => window.location.search);
    const finalPath = await page.evaluate(() => window.location.pathname);

    expect(finalPath, 'redirected to trailing-slash canonical').toBe(`${slugPath}/`);
    expect(finalSearch, 'autologin email param survived bridge').toContain(`ne=${encodeURIComponent(fakeEmail)}`);
    expect(finalSearch, 'autologin code param survived bridge').toContain(`ac=${fakeCode}`);
    expect(finalSearch, 'utm tracking survived bridge').toContain('utm_source=job_alert');
  });
}
