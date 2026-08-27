import { describe, expect, it } from 'vitest';

import {
  adDelivery,
  allocateSampleSlots,
  auditPage,
  bucketForUrl,
  checkAdsTxt,
  checkRobotsTxt,
  extractLocs,
  isLikelyUtilityOrErrorPage,
  isSitemapIndex,
  pageSelfDescription,
  stratifiedSample,
} from '../scripts/adsense-prereview-audit.mjs';

/**
 * Regression cover for issue #4943. Each block pins one invariant that was
 * BROKEN in production and whose breakage was invisible: the checklist reported
 * 140/140 PASS while auditing only blog articles, and the one blocking rule it
 * did evaluate fired on a false positive.
 */

const withText = (words: number, extra = '') =>
  `<html><head><title>Una pagina</title></head><body><main><h1>Titolo</h1><p>${'parola '.repeat(words)}</p></main>${extra}</body></html>`;

const AUTO_ADS = '<script src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"></script>';
const STATIC_SLOT = '<ins class="adsbygoogle" data-ad-client="ca-pub-8628054934855353"></ins>';

describe('sitemap discovery', () => {
  it('recognises a <sitemapindex> so its <loc>s are not mistaken for pages', () => {
    const index = '<sitemapindex><sitemap><loc>https://frontaliereticino.ch/sitemap-blog.xml</loc></sitemap></sitemapindex>';
    const urlset = '<urlset><url><loc>https://frontaliereticino.ch/blog/x/</loc></url></urlset>';
    expect(isSitemapIndex(index)).toBe(true);
    expect(isSitemapIndex(urlset)).toBe(false);
    expect(extractLocs(index)).toEqual(['https://frontaliereticino.ch/sitemap-blog.xml']);
  });
});

describe('stratified sampling (the bug that made the audit blind)', () => {
  /**
   * Production evidence: the last green run (2026-07-07) sampled 139 blog
   * articles + the homepage out of 140, because the old sampler sorted by score
   * and sliced the top N — one big high-score bucket took every slot. With
   * 367k URLs dominated by one family, a plain sort still yields one bucket.
   */
  it('never lets a single dominant page family monopolise the sample', () => {
    const entries = [
      ...Array.from({ length: 5000 }, (_, i) => ({ url: `https://frontaliereticino.ch/blog/post-${i}/`, bucket: 'blog' })),
      ...Array.from({ length: 39000 }, (_, i) => ({ url: `https://frontaliereticino.ch/cerca-lavoro-svizzera/ricerca-${i}/`, bucket: 'search-clusters' })),
      ...Array.from({ length: 40 }, (_, i) => ({ url: `https://frontaliereticino.ch/statistiche/s-${i}/`, bucket: 'statistiche' })),
      { url: 'https://frontaliereticino.ch/', bucket: 'home' },
    ];
    const picked = stratifiedSample(entries, 140, 0);
    const families = new Set(picked.map((p) => p.bucket));

    expect(picked).toHaveLength(140);
    expect(families).toEqual(new Set(['blog', 'search-clusters', 'statistiche', 'home']));
    // Every family present, and none swallowing the whole budget.
    for (const f of families) {
      expect(picked.filter((p) => p.bucket === f).length).toBeGreaterThan(0);
    }
    expect(picked.filter((p) => p.bucket === 'blog').length).toBeLessThan(140);
  });

  it('guarantees at least one slot per non-empty family', () => {
    const buckets = new Map<string, string[]>([
      ['home', ['https://frontaliereticino.ch/']],
      ['blog', Array.from({ length: 900 }, (_, i) => `https://frontaliereticino.ch/blog/${i}/`)],
      ['glossario', Array.from({ length: 3 }, (_, i) => `https://frontaliereticino.ch/glossario/${i}/`)],
    ]);
    const alloc = allocateSampleSlots(buckets, 30);
    for (const [, n] of alloc) expect(n).toBeGreaterThanOrEqual(1);
    expect([...alloc.values()].reduce((a, b) => a + b, 0)).toBe(30);
  });

  it('never allocates a family more slots than it has URLs', () => {
    const buckets = new Map<string, string[]>([
      ['tiny', ['https://frontaliereticino.ch/a/', 'https://frontaliereticino.ch/b/']],
      ['big', Array.from({ length: 500 }, (_, i) => `https://frontaliereticino.ch/big/${i}/`)],
    ]);
    const alloc = allocateSampleSlots(buckets, 100);
    expect(alloc.get('tiny')!).toBeLessThanOrEqual(2);
    expect(alloc.get('big')!).toBeLessThanOrEqual(500);
  });

  it('buckets locale variants of one family together', () => {
    expect(bucketForUrl('https://frontaliereticino.ch/en/find-jobs-zurich/x/'))
      .toBe(bucketForUrl('https://frontaliereticino.ch/find-jobs-zurich/x/'));
    expect(bucketForUrl('', 'sitemap-search-clusters-003.xml')).toBe('search-clusters');
  });
});

describe('Auto Ads are ad delivery (AGENTS.md #7 — ~95% of revenue)', () => {
  /**
   * Measured on 200 live search-cluster pages: 200/200 carry the AdSense
   * loader, 3/200 have a static <ins>. Gating ad detection on static markup
   * therefore exempted almost the whole real ad surface.
   */
  it('counts the loader/meta as ads even with zero static <ins> slots', () => {
    const ads = adDelivery(`<html><head><meta name="google-adsense-account" content="ca-pub-8628054934855353"></head><body>${AUTO_ADS}</body></html>`);
    expect(ads.staticSlots).toBe(0);
    expect(ads.clientTags).toBe(0);
    expect(ads.autoAds).toBe(true);
    expect(ads.servesAds).toBe(true);
  });

  it('reports a thin Auto-Ads page as a warning, not a blocking failure', () => {
    const page = auditPage('https://frontaliereticino.ch/cerca-lavoro-svizzera/ricerca-x/', '', withText(120, AUTO_ADS));
    expect(page.metrics!.autoAdsThin).toBe(true);
    expect(page.status).toBe('warn');
    expect(page.issues).toHaveLength(0);
    expect(page.warnings.some((w) => w.startsWith('thin_content_with_auto_ads'))).toBe(true);
  });

  it('keeps the pre-existing static-slot rule blocking (never downgraded)', () => {
    const page = auditPage('https://frontaliereticino.ch/x/', '', withText(30, STATIC_SLOT));
    expect(page.status).toBe('fail');
    expect(page.issues).toContain('ads_on_thin_content_page');
  });

  it('blocks an indexed ad-serving page below the 50-word floor (AGENTS.md #4)', () => {
    const page = auditPage('https://frontaliereticino.ch/x/', '', withText(10, AUTO_ADS));
    expect(page.status).toBe('fail');
    expect(page.issues.some((i) => i.startsWith('ads_below_indexed_content_floor'))).toBe(true);
  });

  it('does not apply the indexed floor to a noindex page', () => {
    const html = `<html><head><meta name="robots" content="noindex,follow"></head><body><p>${'parola '.repeat(10)}</p>${AUTO_ADS}</body></html>`;
    const page = auditPage('https://frontaliereticino.ch/x/', '', html);
    expect(page.issues.some((i) => i.startsWith('ads_below_indexed_content_floor'))).toBe(false);
  });

  it('does not apply the indexed floor to a noindex page whose meta attributes were unquoted by htmlMinify (issue #6585)', () => {
    // htmlMinify's unquoteSafeAttributes() drops quotes from HTML5-safe
    // attribute values on every emitted page, so the meta tag actually served
    // reads `<meta name=robots content=noindex,follow>`, not the quoted form
    // above. A quote-mandatory regex never matches it.
    const html = `<html><head><meta name=robots content=noindex,follow></head><body><p>${'parola '.repeat(10)}</p>${AUTO_ADS}</body></html>`;
    const page = auditPage('https://frontaliereticino.ch/x/', '', html);
    expect(page.issues.some((i) => i.startsWith('ads_below_indexed_content_floor'))).toBe(false);
  });
});

describe('error-page detection must not fire on job-listing text', () => {
  /**
   * Live false positive that turned the checklist red on 2026-08-05:
   * /aziende/sfs-group/ has 394 words of real content, but listed the job
   * "Operatore automatico/in manutenzione (m/f/d)". The old detector did a bare
   * `includes('in manutenzione')` over the whole body.
   */
  it('does not classify an employer page listing a maintenance job as an error page', () => {
    const html = `<html><head><title>Lavorare in SFS Group: posizioni aperte e stipendi</title></head><body>`
      + `<main><h1>Lavorare in SFS Group</h1>`
      + `<p>SFS Group ha attualmente 17 posizioni aperte pubblicate su Frontaliere Ticino.</p>`
      + `<li>Operatore automatico/in manutenzione (m/f/d) SFS Group · Laufen (BL)</li></main>${AUTO_ADS}</body></html>`;
    expect(isLikelyUtilityOrErrorPage('https://frontaliereticino.ch/aziende/sfs-group/', html)).toBe(false);
    expect(auditPage('https://frontaliereticino.ch/aziende/sfs-group/', '', html).issues)
      .not.toContain('ads_on_utility_or_error_page');
  });

  it('still detects a genuine error page that announces itself in title/h1', () => {
    const html = '<html><head><title>Pagina non trovata — Frontaliere Ticino</title></head><body><h1>Pagina non trovata</h1></body></html>';
    expect(pageSelfDescription(html)).toContain('pagina non trovata');
    expect(isLikelyUtilityOrErrorPage('https://frontaliereticino.ch/nope/', html)).toBe(true);
  });

  it('still blocks ads served on a genuine error page', () => {
    const html = `<html><head><title>Pagina non trovata</title></head><body><h1>Pagina non trovata</h1>${AUTO_ADS}</body></html>`;
    expect(auditPage('https://frontaliereticino.ch/nope/', '', html).issues)
      .toContain('ads_on_utility_or_error_page');
  });

  it('detects an error page from its path even without the phrase', () => {
    expect(isLikelyUtilityOrErrorPage('https://frontaliereticino.ch/404/', '<html><body>x</body></html>')).toBe(true);
  });
});

describe('site-level revenue checks', () => {
  const PUB = 'pub-8628054934855353';

  it('accepts an ads.txt that lists the deployed publisher id as DIRECT', () => {
    const body = `# comment\ngoogle.com, ${PUB}, DIRECT, f08c47fec0942fa0\n33across.com, 0014, RESELLER, bbea\n`;
    expect(checkAdsTxt(body, PUB).issues).toHaveLength(0);
  });

  it('flags an ads.txt missing the publisher id (the "earnings at risk" outage)', () => {
    const body = `google.com, pub-0000000000000000, DIRECT, f08c47fec0942fa0\n`;
    expect(checkAdsTxt(body, PUB).issues).toContain(`ads_txt_missing_publisher_id:${PUB}`);
  });

  it('flags the publisher id present but not DIRECT', () => {
    expect(checkAdsTxt(`google.com, ${PUB}, RESELLER, f08c\n`, PUB).issues)
      .toContain(`ads_txt_publisher_id_not_direct:${PUB}`);
  });

  it('ignores the publisher id when it only appears in a comment', () => {
    expect(checkAdsTxt(`# google.com, ${PUB}, DIRECT, f08c\n`, PUB).issues)
      .toContain(`ads_txt_missing_publisher_id:${PUB}`);
  });

  it('flags robots.txt blocking an ad crawler', () => {
    const robots = 'User-agent: *\nAllow: /\n\nUser-agent: Mediapartners-Google\nDisallow: /\n';
    expect(checkRobotsTxt(robots).issues).toContain('robots_txt_blocks_ad_crawler:mediapartners-google');
  });

  it('accepts the production robots.txt shape (ad crawlers not blocked)', () => {
    const robots = 'User-agent: *\nAllow: /\nDisallow: /api/\n\nUser-agent: Googlebot\nAllow: /\n';
    expect(checkRobotsTxt(robots).issues).toHaveLength(0);
  });
});
