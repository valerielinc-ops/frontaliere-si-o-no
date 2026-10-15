# Visual regression Playwright suite — design doc

**Status**: Designed, not implemented. Captured as actionable TODO.

## Goal

Detect any visual regression introduced by the L2 HTML minifier (or future
HTML-emitting changes) on a representative set of pages. Vincolo C1 rilassato
allows DOM-equivalent + content-equivalent changes, but renders should
remain visually identical.

## Why not implemented now (2026-05-19)

The L2 minifier was integrated in PR #336 and has passed:
- DOM-equivalence verification via `scripts/verify-l2-equivalence.mjs`
  (cheerio.load() + .html() normalization on 1000 sample pages: all match)
- Content equivalence: visible text byte-equal on every sample
- Unit tests in `tests/seo/html-minify.test.ts` (19 tests) covering whitespace
  collapse, comment handling, safe-block preservation
- Live production measurement: 1000-file sample shows 0.87 % mean reduction
  with no visual content change (only whitespace + HTML comments)

For these guarantees, a full Playwright visual regression suite adds
infrastructure (browser, screenshot service, snapshot storage) without
catching anything the existing test layer doesn't already catch.

The suite becomes valuable when we ship:
- L2 aggressive mode (attribute quote stripping, optional close-tag
  stripping) — where rendering could plausibly differ
- New page templates that haven't been verified against L2

## Architecture (when needed)

### Playwright config: `playwright.visual.config.ts`

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e/visual',
  use: {
    baseURL: process.env.VISUAL_BASE_URL || 'http://localhost:4173',
    viewport: { width: 414, height: 896 }, // mobile-first per CLAUDE.md #15
    deviceScaleFactor: 2,
  },
  expect: {
    toHaveScreenshot: {
      // Allow 0.5 % per-pixel + 0.1 % total diff — covers font-rendering
      // jitter without missing real regressions.
      maxDiffPixelRatio: 0.001,
      threshold: 0.005,
    },
  },
  projects: [
    { name: 'mobile-it', use: { viewport: { width: 414, height: 896 } } },
    { name: 'desktop-it', use: { viewport: { width: 1280, height: 800 } } },
  ],
});
```

### Sample selection: 20 representative URLs

| Page-type | URL (IT) | Why representative |
|---|---|---|
| home | / | LCP path, common templates |
| salary-landing | /calcola-stipendio/ | Main funnel page |
| salary-landing leaf | /calcola-stipendio/stipendio-netto-80000-chf/ | Long-tail page |
| job-board hub | /cerca-lavoro-ticino/ | Listing template |
| job-detail (active) | /cerca-lavoro-ticino/<recent>/ | JSON-LD-heavy template |
| job-detail (expired) | /cerca-lavoro-ticino/<expired>/ | Soft-landing template |
| cost-of-living city | /costo-vita-lugano-ticino/ | Stat-tile + table layout (the page-type fixed in PR #355) |
| fuel-daily | /prezzi-benzina-svizzera/lugano/ | Inline SVG chart |
| weekly-employers | /aziende-che-assumono/lugano/eoc-ente-ospedaliero-cantonale/settimana-corrente/ | Detailed employer card layout |
| health-premiums | /premi-cassa-malati/ticino/ | Hub page |
| border-wait | /tempi-attesa-frontiera/chiasso-brogeda/oggi/ | Real-time data + map |
| weather | /meteo-frontalieri/lugano/ | Inline SVG-heavy |
| article (blog) | /articoli-frontaliere/<recent>/ | Long-form prose |
| career landing | /cerca-lavoro-ticino/azienda-eoc-ente-ospedaliero-cantonale/ | Brand hub |
| profession landing | /lavoro-infermieri-svizzera/ | Profession hub |
| nursing landing | /lavoro-oss-svizzera/ | Profession hub variant |
| FAQ hub | /faq/ | FAQ-heavy template |
| comparisons hub | /confronti/ | Hub index |
| about | /chi-siamo/ | Static brand page |
| 404 (informational) | /this-does-not-exist/ | Error template |

Add `/en/...`, `/de/...`, `/fr/...` variants of 4-5 representative pages
for cross-locale coverage — total ~30-40 snapshots.

### Test skeleton: `tests/e2e/visual/snapshot.spec.ts`

```ts
import { test, expect } from '@playwright/test';

const PAGES = [
  { name: 'home-it', url: '/' },
  { name: 'salary-landing-it', url: '/calcola-stipendio/' },
  // ... see table above
];

for (const { name, url } of PAGES) {
  test(`${name}`, async ({ page }) => {
    await page.goto(url, { waitUntil: 'networkidle' });
    // Wait for any seo-static-content overlay to render
    await page.waitForSelector('main', { state: 'attached' });
    // Hide non-deterministic elements (e.g. timestamps, ad iframes)
    await page.evaluate(() => {
      document.querySelectorAll('.timestamp, ins.adsbygoogle').forEach((el) => {
        (el as HTMLElement).style.visibility = 'hidden';
      });
    });
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true });
  });
}
```

### CI integration

`.github/workflows/visual-regression.yml`:

```yaml
on:
  workflow_dispatch:
  workflow_run:
    workflows: ['Post-deploy Validate (dist)']
    types: [completed]

jobs:
  visual:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
      - run: npm ci
      - run: npx playwright install chromium
      - name: Serve dist
        run: |
          # Download github-pages artifact from the deploy run
          # ... (mirror audit-dist-from-run.yml's artifact download step)
          npx vite preview --port 4173 &
          sleep 5
      - run: npx playwright test --config=playwright.visual.config.ts
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: visual-regression-diffs
          path: test-results/
```

Baseline snapshots committed to `tests/e2e/visual/__screenshots__/` — first
run generates them; subsequent runs diff against committed baselines.

## Estimated effort

- Playwright config + sample URLs: 1 h
- Per-page test cases (handle timestamps/ads/dynamic content): 2-3 h
- Baseline capture + commit: 30 min
- CI workflow + artifact upload: 1 h
- First-pass debugging (font-rendering jitter, locale display): 1-2 h

**Total: 5-8 hours** of focused work.

## Why this design is captured but deferred

- L2 minifier rendering equivalence is already covered by:
  - `tests/seo/html-minify.test.ts` (19 unit tests including DOM serialization)
  - `scripts/verify-l2-equivalence.mjs` (DOM + visible-text + JSON-LD diff
    on 1000 sample pages)
- Visual regression's main value is for L2 aggressive mode, not current L2
- 5-8 h infrastructure cost vs ~0 expected regressions on current L2 surface

When L2 aggressive mode lands (attribute quote stripping, optional close-tag
stripping), this suite becomes necessary and the design above is ready.

## Open questions for the implementer

- Where to host baseline snapshots? Repo (git LFS) vs S3-style external store?
- Snapshot stability vs locale: do we capture each of 4 locales separately
  or just IT? Probably IT-only first, then per-locale as needed.
- Handling of cron-updated content (fuel prices, border wait): mock the
  data at build time OR exclude from visual regression OR use a frozen
  dist snapshot.
- AdSense/PostHog iframes: hide via CSS in test setup (done in skeleton above).
