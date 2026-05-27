import { test, expect, type Page } from 'playwright/test';

/**
 * E2E regression test for BUG-1 (docs/seo/ROADMAP.md):
 *
 * Symptom: clicking a home-page card or any internal <a> link to a
 * programmatic SEO landing (`/prezzi-diesel/oggi/`, `/lamal-frontalieri/`,
 * `/aziende-che-assumono/<city>/...`, `/mercato-lavoro-ticino/`,
 * `/traffico-dogane/<crossing>/oggi/`) does NOT navigate. The URL changes
 * but the React shell re-renders the home view because pushRoute()
 * early-returns on `staticOverlay: true` routes — leaving the user
 * stranded on home.
 *
 * Fix (hooks/useNavigationState.ts): the global click interceptor now
 * detects `staticOverlay` routes and falls through to the native
 * full-page navigation, which fetches the canonical static HTML for
 * that exact URL.
 *
 * What this test asserts: starting from the home page, navigating to
 * each programmatic-landing URL via SPA history pushState (which
 * exercises the same click→pushRoute→applyRoute path) results in the
 * correct URL AND a non-home page body. The DOM marker
 * `main.seo-static-content` confirms the static SEO content was loaded
 * (either via real anchor click or via direct full-page load).
 */

const PROGRAMMATIC_LANDINGS: ReadonlyArray<{ name: string; path: string; expectedH1Substring: RegExp }> = [
  {
    name: 'Prezzi Diesel (F6)',
    path: '/prezzi-diesel/oggi/',
    expectedH1Substring: /diesel/i,
  },
  {
    name: 'LAMal Frontalieri (F2)',
    path: '/guida-frontaliere/lamal-frontalieri/',
    expectedH1Substring: /lamal|cassa malati|premi/i,
  },
  {
    name: 'Aziende che assumono Ticino (F5)',
    path: '/aziende-che-assumono/ticino/settimana-corrente/',
    expectedH1Substring: /aziende|assumono|lavoro/i,
  },
  {
    name: 'Mercato lavoro Ticino (F4)',
    path: '/mercato-lavoro-ticino/',
    expectedH1Substring: /mercato|lavoro|ticino/i,
  },
  {
    name: 'Traffico dogane (F8)',
    path: '/traffico-dogane/',
    expectedH1Substring: /traffico|dogan|valic/i,
  },
];

async function gotoHome(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'load' });
  // Allow React to hydrate and the click interceptor to mount.
  await page.waitForTimeout(2_000);
}

test.describe('BUG-1: programmatic SEO landings navigate from home', () => {
  for (const landing of PROGRAMMATIC_LANDINGS) {
    test(`clicking link to ${landing.name} does not dead-end on home`, async ({ page }) => {
      await gotoHome(page);

      // Inject a probe link to the target URL, then click it. This exercises
      // the global click interceptor in hooks/useNavigationState.ts the same
      // way a SeoDailyBanner card or any other in-page <a> would.
      await page.evaluate((href) => {
        const a = document.createElement('a');
        a.href = href;
        a.id = '__bug1_probe__';
        a.textContent = 'probe';
        document.body.appendChild(a);
      }, landing.path);

      // Click via real DOM dispatch so the global click handler runs.
      await Promise.all([
        page.waitForURL(`**${landing.path}`, { timeout: 15_000 }),
        page.click('#__bug1_probe__'),
      ]);

      // The static SEO content must be present in the DOM — that's the
      // signature that the browser performed a full navigation to the
      // generated static HTML, NOT that the SPA re-rendered home.
      const staticMain = page.locator('main.seo-static-content');
      await expect(staticMain).toBeVisible({ timeout: 15_000 });

      // H1 (or the main heading) should match the landing topic — proves
      // we're on the actual landing page, not on home with a swapped URL.
      const h1Text = await page.locator('main.seo-static-content h1').first().textContent();
      expect(h1Text || '').toMatch(landing.expectedH1Substring);

      // Final URL check — must be the target path (trailing-slash tolerant).
      const url = new URL(page.url());
      const normalize = (p: string) => p.replace(/\/+$/, '');
      expect(normalize(url.pathname)).toBe(normalize(landing.path));
    });
  }
});
