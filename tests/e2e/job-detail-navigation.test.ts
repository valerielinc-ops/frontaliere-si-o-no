import { test, expect } from 'playwright/test';

/**
 * E2E regression test: clicking a job in the listing must navigate to
 * a working detail page, NOT show the "non è più disponibile" orphan view.
 *
 * Root cause (fixed): deriveLocalizedJobSlug() ignored the flattened `slug`
 * field from the slim locale index and instead computed a fallback from
 * title-company-location, producing a different slug when the company name
 * differs from the companyKey used during crawl-time slug generation.
 *
 * Note: navigates via the SPA root (/) to avoid stale asset hashes in
 * static HTML pages. Waits for 'load' event and explicit element visibility
 * instead of 'networkidle' (Firebase keeps connections alive).
 */

test.describe('Job detail navigation from listing', () => {
  test('clicking a job card navigates to a valid detail page', async ({ page }) => {
    // Go to SPA root and wait for load (not networkidle — Firebase keeps sockets open)
    await page.goto('/', { waitUntil: 'load' });
    await page.waitForTimeout(3_000);

    // Trigger SPA navigation to job board
    await page.evaluate(() => {
      window.history.pushState(null, '', '/cerca-lavoro-ticino/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    // Wait for job cards to render (article elements with links)
    const firstJobLink = page.locator('article a[href*="/cerca-lavoro-ticino/"]').first();
    await expect(firstJobLink).toBeVisible({ timeout: 30_000 });

    // Capture the href before clicking
    const href = await firstJobLink.getAttribute('href');
    expect(href).toBeTruthy();
    expect(href).not.toBe('/cerca-lavoro-ticino/');

    // Click the job card link
    await firstJobLink.click();
    await page.waitForTimeout(3_000);

    // The detail page should NOT show the orphan/expired "not available" banner
    const orphanBanner = page.locator('text=Questo annuncio non è più disponibile');
    await expect(orphanBanner).not.toBeVisible({ timeout: 5_000 });

    // Verify the URL changed to a job detail slug
    const url = page.url();
    expect(url).toContain('/cerca-lavoro-ticino/');
    const slug = url.split('/cerca-lavoro-ticino/')[1]?.replace(/\/$/, '');
    expect(slug?.length).toBeGreaterThan(0);
  });

  test('first 5 job card hrefs resolve to valid detail pages', async ({ page }) => {
    await page.goto('/', { waitUntil: 'load' });
    await page.waitForTimeout(3_000);

    // Navigate to job board
    await page.evaluate(() => {
      window.history.pushState(null, '', '/cerca-lavoro-ticino/');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    const jobLinks = page.locator('article a[href*="/cerca-lavoro-ticino/"]');
    await expect(jobLinks.first()).toBeVisible({ timeout: 30_000 });

    const count = await jobLinks.count();
    const hrefs: string[] = [];
    for (let i = 0; i < Math.min(count, 5); i++) {
      const href = await jobLinks.nth(i).getAttribute('href');
      if (href && href !== '/cerca-lavoro-ticino/') hrefs.push(href);
    }
    expect(hrefs.length).toBeGreaterThan(0);

    // Navigate to each detail URL via SPA routing
    for (const href of hrefs) {
      await page.evaluate((path) => {
        window.history.pushState(null, '', path);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, href);
      await page.waitForTimeout(2_000);

      const orphanBanner = page.locator('text=Questo annuncio non è più disponibile');
      const isOrphan = await orphanBanner.isVisible().catch(() => false);
      expect(isOrphan, `Job at ${href} shows orphan view`).toBe(false);
    }
  });
});
