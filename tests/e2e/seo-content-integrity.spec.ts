import { test, expect } from 'playwright/test';
import { wordCount } from './helpers/wordCount';

const SEO_URLS = [
  '/traffico-dogane/',
  '/traffico-dogane/chiasso-centro/oggi/',
  '/prezzi-benzina/oggi/',
  '/aziende-che-assumono/ticino/settimana-corrente/',
  '/premi-cassa-malati/',
];

for (const url of SEO_URLS) {
  test(`SEO page has real content: ${url}`, async ({ page }) => {
    // Use domcontentloaded to read the static HTML shell BEFORE SPA hydration
    // replaces the SEO content with client-side rendering.
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded' });
    expect(resp?.status(), `HTTP status for ${url}`).toBe(200);
    // Read raw HTML to count words in the SEO static shell, not the SPA DOM.
    const html = await page.content();
    // Strip tags + scripts + styles, then count words in body text.
    const bodyText = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z#0-9]+;/gi, ' ');
    expect(wordCount(bodyText), `Word count on ${url}`).toBeGreaterThan(100);
    // No "not found" indicator in the rendered DOM
    await expect(page.locator('text=/page not found|non trovata|404 error/i')).toHaveCount(0);
  });
}
