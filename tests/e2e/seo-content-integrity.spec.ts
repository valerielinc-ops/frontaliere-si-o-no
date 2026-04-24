import { test, expect } from 'playwright/test';
import { wordCount } from './helpers/wordCount';

const SEO_URLS = [
  '/traffico-dogane/',
  '/traffico-dogane/chiasso-centro/',
  '/prezzi-benzina-oggi/',
  '/aziende-che-assumono/',
  '/assicurazione-malattia/',
];

for (const url of SEO_URLS) {
  test(`SEO page has real content: ${url}`, async ({ page }) => {
    const resp = await page.goto(url, { waitUntil: 'networkidle' });
    expect(resp?.status(), `HTTP status for ${url}`).toBe(200);
    const main = page.locator('main, article, #root').first();
    const text = (await main.innerText()).trim();
    expect(wordCount(text), `Word count on ${url}`).toBeGreaterThan(50);
    // No "not found" indicator
    await expect(page.locator('text=/404|not found|non trovata/i')).toHaveCount(0);
  });
}
