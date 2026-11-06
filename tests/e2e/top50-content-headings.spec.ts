import { expect, test } from 'playwright/test';

const pages = [
  { path: '/tasse-e-pensione/simulazione-tasse-nuovi-frontalieri/', title: /simulazione|tasse/i },
  { path: '/dialetto-ticinese/', title: /dialetto ticinese/i },
  { path: '/vivere-in-ticino/comuni-di-frontiera/', title: /comuni.*frontalier/i },
];

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
  for (const entry of pages) {
    test(`${entry.path} preserves its heading after React renders at ${viewport.width}px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto(entry.path, { waitUntil: 'domcontentloaded' });
      // Headings inside the React root prove that the SSG fallback is no longer the only surface.
      const heading = page.locator('#root h1:visible');
      await expect(heading).toHaveCount(1, { timeout: 30000 });
      await expect(heading).toHaveText(entry.title);
      await expect(page.locator('h1:visible')).toHaveCount(1);
      await expect(page.locator('body')).not.toHaveText(/citt agrave/);
    });
  }
}
