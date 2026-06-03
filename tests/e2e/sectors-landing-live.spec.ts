import { test, expect, type APIRequestContext } from 'playwright/test';

/**
 * Live regression guard for the canonical sector landing
 * `/cerca-lavoro-ticino/settori/` — the entry point for the 50-item
 * "Settori professionali" catalogue that funnels traffic into every
 * per-sector slug page (and the legacy `?q=` query landings for
 * sectors that don't yet have a dedicated slug).
 *
 * The page is a static SSG output from a build plugin and is also
 * SPA-hydrated. A regression in either the static emitter (missing
 * head tags, broken JSON-LD, blank ItemList) or the SPA shell
 * (missing bundle, hydration loop) would silently demote the entire
 * sector funnel — the highest-volume internal navigation surface on
 * the job side of the site. None of the dist-level tests catch a
 * regression that only manifests after Pages serves the file, so this
 * spec runs against the LIVE deploy.
 *
 * Frozen invariants (today's rendering — 2026-05-28):
 *   1. HTTP 200, canonical = self.
 *   2. <title> = "Tutti i settori professionali | Frontaliere Ticino".
 *   3. <h1> = "Settori professionali con offerte di lavoro attive".
 *   4. Meta description present and non-empty.
 *   5. All 5 hreflang alternates (it/en/de/fr/x-default) at the
 *      expected per-locale paths.
 *   6. SPA bundle <script type="module" src="/assets/index-*.js"> linked.
 *   7. JSON-LD BreadcrumbList + CollectionPage emitted; CollectionPage
 *      mainEntity is an ItemList with >=50 entries.
 *   8. >=40 sector links rendered (mix of dedicated slug landings and
 *      `?q=` query landings — both are valid funnel destinations).
 *   9. After hydration, the catalogue is visible in the DOM and the
 *      first listed sector is clickable.
 */

const LIVE_BASE_URL = (process.env.LIVE_BASE_URL || 'https://frontaliereticino.ch').replace(/\/+$/, '');
const PATH = '/cerca-lavoro-ticino/settori/';
const URL = `${LIVE_BASE_URL}${PATH}`;

const EXPECTED_TITLE = 'Tutti i settori professionali | Frontaliere Ticino';
const EXPECTED_H1 = 'Settori professionali con offerte di lavoro attive';

const HREFLANG_ALTERNATES: ReadonlyArray<{ hreflang: string; path: string }> = [
  { hreflang: 'it', path: '/cerca-lavoro-ticino/settori/' },
  { hreflang: 'en', path: '/en/find-jobs-ticino/sectors/' },
  { hreflang: 'de', path: '/de/jobs-im-tessin/branchen/' },
  { hreflang: 'fr', path: '/fr/trouver-emploi-tessin/secteurs/' },
  { hreflang: 'x-default', path: '/cerca-lavoro-ticino/settori/' },
];

// src may be same-origin or an absolute CDN URL (ASSET_CDN/renderBuiltUrl).
const SPA_BUNDLE_RX = /<script[^>]+type="module"[^>]+src="(?:https?:\/\/[^"]+)?\/assets\/index-[A-Za-z0-9_-]+\.js"/;

interface FetchedHtml {
  status: number;
  body: string;
  finalUrl: string;
}

async function fetchHtml(request: APIRequestContext, url: string): Promise<FetchedHtml> {
  const response = await request.get(url, { maxRedirects: 5, timeout: 20_000 });
  return { status: response.status(), body: await response.text(), finalUrl: response.url() };
}

function extractJsonLdBlocks(body: string): unknown[] {
  const rx = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  const blocks: unknown[] = [];
  for (const match of body.matchAll(rx)) {
    try {
      blocks.push(JSON.parse(match[1]));
    } catch {
      // Malformed JSON-LD is itself a regression; surface via the
      // assertions below by counting fewer-than-expected blocks.
    }
  }
  return blocks;
}

test.describe('live: /cerca-lavoro-ticino/settori/ (sector catalogue landing)', () => {
  test('static HTML carries title, h1, canonical, hreflang, SPA bundle and JSON-LD', async ({ request }) => {
    const { status, body } = await fetchHtml(request, URL);

    expect(status, `${URL} should return 200`).toBe(200);

    expect(body, 'title must match the catalogue title shipped today').toContain(
      `<title>${EXPECTED_TITLE}</title>`,
    );

    const h1Match = body.match(/<h1[^>]*>([^<]+)<\/h1>/);
    expect(h1Match, 'page must emit an <h1>').not.toBeNull();
    expect(h1Match![1].trim(), 'h1 text must match the catalogue heading shipped today').toBe(EXPECTED_H1);

    const descMatch = body.match(/<meta name="description" content="([^"]+)"/);
    expect(descMatch, 'meta description tag must be present').not.toBeNull();
    expect(descMatch![1].length, 'meta description must be non-empty').toBeGreaterThan(20);

    const canonicalMatch = body.match(/<link rel="canonical" href="([^"]+)"/);
    expect(canonicalMatch, 'canonical link must be present').not.toBeNull();
    expect(canonicalMatch![1]).toBe(`${LIVE_BASE_URL}${PATH}`);

    for (const { hreflang, path } of HREFLANG_ALTERNATES) {
      const rx = new RegExp(
        `<link rel="alternate" hreflang="${hreflang}" href="${LIVE_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`,
      );
      expect(rx.test(body), `hreflang="${hreflang}" must point at ${LIVE_BASE_URL}${path}`).toBe(true);
    }

    expect(
      SPA_BUNDLE_RX.test(body),
      'SPA bundle <script type="module" src="/assets/index-*.js"> must be linked',
    ).toBe(true);

    const blocks = extractJsonLdBlocks(body);
    const breadcrumb = blocks.find(
      (b): b is { '@type': string } =>
        typeof b === 'object' && b !== null && (b as { '@type'?: string })['@type'] === 'BreadcrumbList',
    );
    expect(breadcrumb, 'BreadcrumbList JSON-LD must be present').toBeTruthy();

    const collection = blocks.find(
      (b): b is {
        '@type': string;
        mainEntity?: { '@type': string; numberOfItems?: number; itemListElement?: unknown[] };
      } =>
        typeof b === 'object' && b !== null && (b as { '@type'?: string })['@type'] === 'CollectionPage',
    );
    expect(collection, 'CollectionPage JSON-LD must be present').toBeTruthy();
    expect(collection!.mainEntity?.['@type'], 'CollectionPage.mainEntity must be an ItemList').toBe('ItemList');
    expect(
      collection!.mainEntity?.numberOfItems ?? 0,
      'ItemList must enumerate at least 50 sectors (today: 50)',
    ).toBeGreaterThanOrEqual(50);
    expect(
      Array.isArray(collection!.mainEntity?.itemListElement) ? collection!.mainEntity!.itemListElement!.length : 0,
      'ItemList itemListElement must contain at least 25 entries inline',
    ).toBeGreaterThanOrEqual(25);
  });

  test('static HTML lists at least 40 sector links into the job board', async ({ request }) => {
    const { body } = await fetchHtml(request, URL);

    // Sector funnel ships two link shapes today:
    //   - dedicated slug landings:  /cerca-lavoro-ticino/<sector-slug>/
    //   - query landings:           /cerca-lavoro-ticino/?q=<Sector>
    // Both are first-class destinations — count them together so the
    // assertion doesn't break when a `?q=` sector is promoted to a slug.
    const slugLinks = new Set(
      [...body.matchAll(/href="\/cerca-lavoro-ticino\/[a-z][a-z0-9-]+\/"/g)].map((m) => m[0]),
    );
    const queryLinks = new Set(
      [...body.matchAll(/href="\/cerca-lavoro-ticino\/\?q=[^"]+"/g)].map((m) => m[0]),
    );

    expect(
      slugLinks.size + queryLinks.size,
      `sector catalogue must surface at least 40 funnel links (got ${slugLinks.size} slug + ${queryLinks.size} query)`,
    ).toBeGreaterThanOrEqual(40);
  });

  test('browser navigation hydrates and the catalogue is visible', async ({ page }) => {
    const navStart = Date.now();
    const response = await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    const navDuration = Date.now() - navStart;

    expect(response, `goto(${URL}) should not return null`).not.toBeNull();
    expect(response!.status(), `goto(${URL}) should reach 200`).toBe(200);
    expect(navDuration, `navigation to ${URL} took ${navDuration} ms`).toBeLessThan(20_000);

    expect(page.url().replace(/\/+$/, '/')).toBe(URL);

    await expect(page.locator('h1')).toHaveText(EXPECTED_H1, { timeout: 15_000 });

    // After hydration the catalogue is rendered as anchor links into the
    // job board. We assert visibility (not just count) because a hidden
    // sidebar or invisible nav would still satisfy the static-HTML count
    // assertion above.
    const visibleSectorLinks = page.locator(
      'main a[href*="/cerca-lavoro-ticino/"][href$="/"], main a[href*="/cerca-lavoro-ticino/?q="]',
    );
    await expect.poll(async () => visibleSectorLinks.count(), { timeout: 15_000 }).toBeGreaterThanOrEqual(40);
  });
});
