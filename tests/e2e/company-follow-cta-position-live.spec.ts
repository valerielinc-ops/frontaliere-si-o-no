import { test, expect, type Page } from 'playwright/test';
import { listActiveJobDetailPaths, resolveActiveJobDetailPath } from './lib/live-jobs';
import { JOB_DESCRIPTION_PREVIEW_LENGTH } from '../../services/jobs/descriptionPreview';

/**
 * Bounded public previews precede the free-access gate and follow CTA on
 * active job details. Expired listings retain hub → follow CTA → gate order.
 * Also guard fixed-widget overlap and uncaught errors on mobile and desktop.
 * Discover live jobs at runtime so expiring fixtures do not break the guard.
 * Use domcontentloaded: ads and polling prevent a reliable networkidle.
 */

const LIVE_BASE_URL = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/+$/, '');

const VIEWPORTS = [
  { label: '390px (mobile)', width: 390, height: 844 },
  { label: '1440px (desktop)', width: 1440, height: 900 },
] as const;

// Known-expired listing, tolerated if it has rotated out of expired-jobs.json
// by the time this runs (mirrors post-deploy-rendering-live.spec.ts).
const EXPIRED_JOB_PATH = '/cerca-lavoro-ticino/stagista-delle-risorse-umane-al-dettaglio-guess-europe-sagl-bioggio/';

interface FollowCtaLayout {
  hasHub: boolean;
  hasFollow: boolean;
  hubPrecedesFollow: boolean | null;
  followTop: number | null;
  hasGate: boolean;
  gateTop: number | null;
  publicDescriptionTop: number | null;
}

interface FixedOverlap {
  a: { tag: string; cls: string };
  b: { tag: string; cls: string };
  overlapW: number;
  overlapH: number;
}

async function readFollowCtaLayout(page: Page): Promise<FollowCtaLayout> {
  return page.evaluate(() => {
    const DOCUMENT_POSITION_PRECEDING = 2;
    // Scoped to `<main>`: the footer's "Tutte le aziende →" hub-index link
    // (`hubs.companiesAll`, e.g. `/cerca-lavoro-ticino/aziende/`) also matches
    // `a[href*="/aziende/"]` and always renders AFTER `<main>` in the DOM
    // (App.tsx), so an unscoped query would silently swap in the footer link
    // whenever EmployerHubCta itself does not render.
    const hub = document.querySelector<HTMLElement>('main a[href*="/aziende/"]');
    // Identity-based, not position-based: `hub?.nextElementSibling` made
    // `hubPrecedesFollow` tautologically true (a `nextElementSibling` cannot
    // NOT follow its reference node) and silently pointed at whatever
    // happened to sit next to the hub link, not necessarily the follow CTA
    // (flagged in the #6146 PR review). CompanyFollowButton renders one of
    // several DOM shapes depending on `status`, so match on what is actually
    // on screen: the reserving placeholder's own testid, or the CTA's visible
    // label (idle/follow and following states, all four locales — see
    // `jobAlert.companyFollow.cta`/`.following` in services/locales/*-core.ts).
    const FOLLOW_TEXT_RE =
      /Segui questa azienda|Stai seguendo questa azienda|Follow this company|You are following this company|Diesem Unternehmen folgen|Du folgst diesem Unternehmen|Suivre cette entreprise|Vous suivez cette entreprise/;
    const follow =
      Array.from(document.querySelectorAll<HTMLElement>('main [data-testid="company-follow-placeholder"], main button')).find(
        (el) => el.matches('[data-testid="company-follow-placeholder"]') || FOLLOW_TEXT_RE.test(el.textContent || ''),
      ) ?? null;
    const gate = document.getElementById('job-auth-gate');
    return {
      hasHub: !!hub,
      hasFollow: !!follow,
      hubPrecedesFollow: hub && follow ? !!(follow.compareDocumentPosition(hub) & DOCUMENT_POSITION_PRECEDING) : null,
      followTop: follow ? follow.getBoundingClientRect().top : null,
      hasGate: !!gate,
      gateTop: gate ? gate.getBoundingClientRect().top : null,
      publicDescriptionTop: document.querySelector('[data-testid="job-public-description"]')?.getBoundingClientRect().top ?? null,
    };
  });
}

// Fixed-position widgets whose rect touches the lower half of the viewport,
// deduped to outermost (skips a fixed element whose ancestor is also fixed —
// that ancestor already represents the same widget).
async function findFixedOverlapViolations(page: Page): Promise<FixedOverlap[]> {
  return page.evaluate(() => {
    const viewportH = window.innerHeight;
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('body *')).filter((el) => {
      const cs = window.getComputedStyle(el);
      if (cs.position !== 'fixed') return false;
      if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
      let p = el.parentElement;
      while (p) {
        if (window.getComputedStyle(p).position === 'fixed') return false;
        p = p.parentElement;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > viewportH / 2;
    });
    const boxes = candidates.map((el) => ({
      tag: el.tagName,
      cls: (el.getAttribute('class') || '').slice(0, 80),
      rect: el.getBoundingClientRect(),
    }));
    const violations: FixedOverlap[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i].rect;
        const b = boxes[j].rect;
        const overlapW = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const overlapH = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (overlapW > 8 && overlapH > 8) {
          violations.push({
            a: { tag: boxes[i].tag, cls: boxes[i].cls },
            b: { tag: boxes[j].tag, cls: boxes[j].cls },
            overlapW,
            overlapH,
          });
        }
      }
    }
    return violations;
  });
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(6_000);
}

// Discovery-loop probe: 'gated job detail' below re-navigates through up to
// 20 sitemap candidates looking for one that renders both the hub link and
// the follow CTA. `settle()`'s `networkidle` wait NEVER resolves on this site
// (ads + long-polling, see file header) — it burns its full 10s timeout on
// every single call — and its extra 6s exists to let the follow CTA's
// Suspense fallback finish swapping to real content before the geometric
// assertions run. Neither cost is needed just to DETECT the CTA: the
// placeholder (`[data-testid="company-follow-placeholder"]`) that
// `readFollowCtaLayout` matches on is present as soon as Suspense reserves
// its slot, before the swap. Paying the full `settle()` tax per candidate
// made the loop scale past the config's 60s test timeout well before it
// reached the geometry check (observed: both attempts of #6845 timed out at
// exactly 60000ms). Probe with a light wait; pay the full `settle()` once,
// only for the candidate that actually matches.
async function probeSettle(page: Page): Promise<void> {
  await page.waitForTimeout(1_000);
}

// Attached before the FIRST navigation of a test (not per-candidate inside
// `navigateToSurface`), so it covers the entire navigate → probeSettle →
// settle → assertSurfaceLayout window, matching the "no uncaught JS error
// fires while surface renders" guarantee (file header, point 3) even though
// `navigateToSurface` may run several times against different candidates
// before the one that gets asserted.
function collectPageErrors(page: Page): string[] {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));
  return pageErrors;
}

async function navigateToSurface(page: Page, path: string): Promise<void> {
  await page.goto(`${LIVE_BASE_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('main').first().waitFor({ state: 'attached', timeout: 30_000 });
}

async function assertSurfaceLayout(page: Page, label: string, pageErrors: string[]): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(300);

    const layout = await readFollowCtaLayout(page);
    if (layout.hasHub && layout.hasFollow) {
      expect(layout.hubPrecedesFollow, `${label} @ ${viewport.label}: hub link must precede the follow CTA`).toBe(true);
      if (layout.hasGate) {
        if (layout.publicDescriptionTop !== null) {
          expect(layout.publicDescriptionTop).toBeLessThan(layout.gateTop!);
          expect(layout.gateTop!).toBeLessThan(layout.followTop!);
        } else {
          expect(layout.followTop!, `${label}: expired surface keeps the follow CTA before its gate`).toBeLessThan(layout.gateTop!);
        }
      }
    }

    const violations = await findFixedOverlapViolations(page);
    expect(violations, `${label} @ ${viewport.label}: fixed widgets overlapping >8px on both axes: ${JSON.stringify(violations)}`).toHaveLength(0);
  }

  expect(pageErrors, `${label}: uncaught JS errors: ${JSON.stringify(pageErrors)}`).toHaveLength(0);
}

async function assertSurface(page: Page, path: string, label: string): Promise<void> {
  const pageErrors = collectPageErrors(page);
  await navigateToSurface(page, path);
  await settle(page);
  await assertSurfaceLayout(page, label, pageErrors);
}

test('gated job detail: preview precedes access and follow, no fixed-widget collisions', async ({ page }) => {
  // Bounded discovery across up to 20 live candidates (see probeSettle above)
  // plus the full settle+assertion on the match — above the default 60s.
  test.setTimeout(120_000);
  const pageErrors = collectPageErrors(page);
  const candidates = await listActiveJobDetailPaths(page, { limit: 20 });
  for (const path of candidates) {
    await navigateToSurface(page, path);
    await probeSettle(page);
    const layout = await readFollowCtaLayout(page);
    if (layout.hasHub && layout.hasFollow) {
      await settle(page);
      await assertSurfaceLayout(page, 'gated job detail', pageErrors);
      return;
    }
  }
  test.skip(true, 'No active job detail among the sampled candidates renders both an employer hub link and the follow CTA.');
});

test('expired job detail: follow CTA sits above the auth gate, no fixed-widget collisions', async ({ page }) => {
  const res = await page.request.get(`${LIVE_BASE_URL}${EXPIRED_JOB_PATH}`, { maxRedirects: 5, timeout: 15_000 }).catch(() => null);
  if (!res || res.status() === 404) {
    test.skip(true, `${EXPIRED_JOB_PATH} is no longer in expired-jobs.json (rotated out) — content churns over time.`);
    return;
  }
  await assertSurface(page, EXPIRED_JOB_PATH, 'expired job detail');
});


test('anonymous job descriptions stay bounded before and after hydration', async ({ browser, page }) => {
  test.setTimeout(120_000);
  const path = await resolveActiveJobDetailPath(page);
  const staticContext = await browser.newContext({ javaScriptEnabled: false });
  try {
    const staticPage = await staticContext.newPage();
    await staticPage.goto(`${LIVE_BASE_URL}${path}`, { waitUntil: 'domcontentloaded' });
    const staticPreview = staticPage.locator('[data-job-description-preview]');
    await expect(staticPreview).toHaveCount(1);
    await expect(staticPreview).not.toHaveText('');
    expect((await staticPreview.innerText()).trim().length).toBeLessThanOrEqual(JOB_DESCRIPTION_PREVIEW_LENGTH + 1);
    await expect(staticPage.locator('.proposal .timeline, .proposal .highlights')).toHaveCount(0);
  } finally {
    await staticContext.close();
  }

  await navigateToSurface(page, path);
  const preview = page.locator('#main-content [data-job-description-preview]');
  // An attached but empty loading skeleton is not a successful check.
  await expect(preview).toBeVisible({ timeout: 30_000 });
  await expect(preview).not.toHaveText('', { timeout: 30_000 });
  expect((await preview.innerText()).trim().length).toBeLessThanOrEqual(JOB_DESCRIPTION_PREVIEW_LENGTH + 1);
  await expect(page.locator('#main-content #job-auth-gate')).toBeVisible();
  await expect(page.locator('main.seo-static-content')).toBeHidden();
});
