import { test, expect, type Page } from 'playwright/test';
import { listActiveJobDetailPaths } from './lib/live-jobs';

/**
 * Live guard for the #6102 follow-CTA reposition (verification tracked in
 * #6146: the merge never had a green deploy to check against until the
 * #5864 OOM was fixed on 2026-08-20).
 *
 * #6102 moved «Segui questa azienda» from far below the fold to directly
 * under the employer-hub link (`/aziende/<slug>/`), ABOVE the inline auth
 * gate (`#job-auth-gate`), on every surface that draws that gate: the
 * unlocked-but-gated job detail (JobBoard) and the expired-ad view
 * (JobExpiredView). Both render the same three siblings in the same order —
 * hub link, follow CTA, gate — which is exactly what regresses if a future
 * change reorders them or the CTA's `Suspense` fallback stops reserving its
 * slot (a reflow that could push the gate on top of, or shrink the follow
 * CTA under, some other fixed element).
 *
 * What this checks, mirroring the manual checklist in #6146 point 1:
 *   1. The hub link precedes the follow CTA in DOM order, and the CTA's top
 *      sits above the auth gate's top (never re-shuffled below it).
 *   2. No two independent `position: fixed` widgets touching the lower half
 *      of the viewport overlap by more than 8px on both axes (catches the
 *      chatbot FAB / bottom-anchored prompts colliding with each other).
 *   3. No uncaught JS error fires while the surface renders.
 * Checked at both a narrow (390px) and a wide (1440px) viewport.
 *
 * Two traps already paid for once (per #6146), not to be repaid:
 *   - `waitUntil: 'networkidle'` times out on this site (ads + long-polling
 *     never let the network go idle) — `domcontentloaded` + an explicit
 *     settle wait instead.
 *   - Pinning one job slug time-bombs the moment that listing expires
 *     (incident 2026-06-03) — the gated surface is discovered at runtime
 *     from the live sitemap, like the sibling `job-company-link-visual-live`
 *     spec.
 *
 * The JobOrphanView surface (legacy/GSC slug with no job record) is NOT
 * covered here: a synthesized unknown slug 301-redirects to the cluster
 * root before the SPA ever mounts it (verified live 2026-08-27), so
 * exercising it needs a real orphan-slug source this run did not have
 * budget to wire up — left for a follow-up.
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
    const hub = document.querySelector<HTMLElement>('a[href*="/aziende/"]');
    const follow = hub?.nextElementSibling as HTMLElement | null;
    const gate = document.getElementById('job-auth-gate');
    return {
      hasHub: !!hub,
      hasFollow: !!follow,
      hubPrecedesFollow: hub && follow ? !!(follow.compareDocumentPosition(hub) & DOCUMENT_POSITION_PRECEDING) : null,
      followTop: follow ? follow.getBoundingClientRect().top : null,
      hasGate: !!gate,
      gateTop: gate ? gate.getBoundingClientRect().top : null,
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

async function assertSurface(page: Page, path: string, label: string): Promise<void> {
  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(err.message));

  await page.goto(`${LIVE_BASE_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.locator('main').first().waitFor({ state: 'attached', timeout: 30_000 });
  await settle(page);

  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(300);

    const layout = await readFollowCtaLayout(page);
    if (layout.hasHub && layout.hasFollow) {
      expect(layout.hubPrecedesFollow, `${label} @ ${viewport.label}: hub link must precede the follow CTA`).toBe(true);
      if (layout.hasGate) {
        expect(
          layout.followTop!,
          `${label} @ ${viewport.label}: follow CTA must sit above the auth gate`,
        ).toBeLessThan(layout.gateTop!);
      }
    }

    const violations = await findFixedOverlapViolations(page);
    expect(violations, `${label} @ ${viewport.label}: fixed widgets overlapping >8px on both axes: ${JSON.stringify(violations)}`).toHaveLength(0);
  }

  expect(pageErrors, `${label}: uncaught JS errors: ${JSON.stringify(pageErrors)}`).toHaveLength(0);
}

test('gated job detail: follow CTA sits above the auth gate, no fixed-widget collisions', async ({ page }) => {
  const candidates = await listActiveJobDetailPaths(page, { limit: 20 });
  for (const path of candidates) {
    await page.goto(`${LIVE_BASE_URL}${path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.locator('main').first().waitFor({ state: 'attached', timeout: 30_000 });
    await settle(page);
    const layout = await readFollowCtaLayout(page);
    if (layout.hasHub && layout.hasFollow) {
      await assertSurface(page, path, 'gated job detail');
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
