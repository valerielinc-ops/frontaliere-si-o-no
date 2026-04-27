import { test, expect } from 'playwright/test';
import { createHmac } from 'node:crypto';

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
 * Two layers of coverage:
 *   1. Bridge-only smoke (always runs): no-slash URL → trailing-slash canonical
 *      with search+hash preserved. Hermetic, no external services.
 *   2. Full autologin (CI only, gated on NEWSLETTER_SECRET): generate a real
 *      HMAC, hit the production cloud function, expect Firebase Auth
 *      `onAuthStateChanged` to fire with hasUser=true and the test email.
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

/**
 * Full E2E: clicking an autologin link signs the user in via Firebase Auth.
 *
 * Requires NEWSLETTER_SECRET (loaded from Firebase Remote Config in CI). The
 * deploy workflow runs `scripts/load-rc-env.mjs` before `npx playwright test`
 * so the secret is in `process.env`. Locally, the test skips when missing.
 *
 * Flow exercised:
 *   1. Visit /calcolatore?ne=<test-email>&ac=<real-hmac> (no-slash form, hits
 *      the bridge stub).
 *   2. Bridge redirects to /calcolatore/?ne=&ac= preserving params (the bug
 *      we're guarding against).
 *   3. SPA's autologin useEffect reads `ne` + `ac`, POSTs to the live cloud
 *      function `newsletterManageSubscription?action=exchange_auth_code`.
 *   4. Cloud function verifies HMAC, mints a Firebase custom token.
 *   5. SPA calls `signInWithCustomToken`. `onAuthStateChanged` fires with
 *      hasUser=true and our test email — captured here from `[AuthDebug]`
 *      console events emitted by services/authService.ts.
 *
 * Test email is a stable, dedicated address so we don't accumulate Firebase
 * Auth users across runs (the cloud function reuses the existing UID).
 */
const TEST_EMAIL = 'e2e-autologin-test@frontaliereticino.ch';

test('autologin link signs the user into Firebase Auth', async ({ page, context }) => {
  const secret = process.env.NEWSLETTER_SECRET;
  test.skip(!secret, 'NEWSLETTER_SECRET not available — local dev or missing RC load step');

  // Bridge fix preserves search; the hop goes prod-canonical → localhost preview.
  await context.route(`${PROD_HOST}/**`, async (route) => {
    const rewritten = route.request().url().replace(PROD_HOST, PREVIEW_ORIGIN);
    await route.fulfill({ status: 302, headers: { Location: rewritten }, body: '' });
  });

  // The cloud function lives at europe-west6 and is HMAC-authenticated. We
  // must let it through to mint a real custom token — otherwise the rest of
  // the chain can't run.

  // Capture [AuthDebug] payloads so we can detect the sign-in event.
  type AuthEvent = { event?: string; hasUser?: boolean; email?: string | null };
  const authEvents: AuthEvent[] = [];
  page.on('console', async (msg) => {
    if (!msg.text().startsWith('[AuthDebug]')) return;
    try {
      const args = msg.args();
      if (args.length < 2) return;
      const payload = await args[1].jsonValue();
      if (payload && typeof payload === 'object') authEvents.push(payload as AuthEvent);
    } catch { /* JSHandle disposed or non-serialisable, ignore */ }
  });

  const code = createHmac('sha256', secret!)
    .update('autologin:' + TEST_EMAIL.toLowerCase().trim())
    .digest('hex');

  const startUrl = `/calcolatore?ne=${encodeURIComponent(TEST_EMAIL)}&ac=${code}&utm_source=e2e_test`;
  await page.goto(startUrl, { waitUntil: 'commit' });

  // Wait for the bridge redirect AND for `onAuthStateChanged` to fire with
  // hasUser=true and matching email. Sign-in involves: bridge hop → SPA boot
  // → fetch cloud function → loadFirebase/auth → signInWithCustomToken →
  // auth state listener. Allow up to 30s in CI.
  await expect.poll(
    () => authEvents.find(
      (e) => e.event === 'useAuth:onAuthStateChanged'
        && e.hasUser === true
        && (e.email ?? '').toLowerCase() === TEST_EMAIL.toLowerCase(),
    ),
    { timeout: 30_000, message: 'Expected onAuthStateChanged with our test email after autologin' },
  ).toBeDefined();

  // Sanity: URL ended up on the canonical with autologin params already
  // stripped by App.tsx (the SPA replaces history once it processes them).
  await expect.poll(
    () => page.url(),
    { timeout: 5_000 },
  ).not.toContain('ac=');
});
