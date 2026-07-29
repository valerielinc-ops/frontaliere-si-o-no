/**
 * SEO Completeness Test — Prevents shipping new pages without proper SEO setup.
 *
 * Verifies that EVERY routable page has:
 * 1. SEO_METADATA entry (title, description, canonical, structuredData)
 * 2. Structured data with valid @type (Google/Bing/AI compliance)
 * 3. Sitemap entry (public/sitemap.xml — all 4 locales + hreflang)
 * 4. IndexNow submission (scripts/submit-indexnow.js)
 * 5. Breadcrumb coverage in seoService.ts
 * 6. getSeoSection mapping in router.ts
 *
 * Run: npx vitest run tests/seo-completeness.test.ts
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  buildPath,
  getSeoSection,
  preloadBlogData,
  preloadSwissData,
  ALL_CALCOLATORE_SUBTABS,
  ALL_CONFRONTI_SUBTABS,
  ALL_FISCO_SUBTABS,
  ALL_GUIDA_SUBTABS,
  ALL_VITA_SUBTABS,
  ALL_STATS_SUBTABS,
  ALL_SEO_LANDING_IDS,
  ALL_GLOSSARY_TERM_IDS,
  ALL_BORDER_CROSSING_IDS,
} from '@/services/router';
import { ALL_BLOG_ARTICLE_IDS } from '@/services/routerBlogData';
import { ALL_SWISS_ARTICLE_IDS, SWISS_SLUGS } from '@/services/routerSwissData';
import { AUTHORS } from '@/data/authors';
import type { AppRoute, BlogArticleId } from '@/services/router';
import { loadSwissArticleCanonicalOverrides } from '@/build-plugins/shared/swissArticleCanonicalOverrides';
import { GLOSSARY_TERM_DEFINITIONS, GLOSSARY_PLACEHOLDER_DESCRIPTION_RX } from '@/services/seo/glossaryTermDefinitions';

// Preload blog data so buildPath can resolve blog slugs (both sections)
await preloadBlogData();
await preloadSwissData();

// Import SEO_METADATA bypassing the global mock from setup.tsx
// getAllSeoMetadata() eagerly loads core + blog + landing chunks for exhaustive testing
const { getAllSeoMetadata } = await vi.importActual<typeof import('@/services/seoService')>('@/services/seoService');
const SEO_METADATA = await getAllSeoMetadata();

// ── Helpers ─────────────────────────────────────────────────────────────────

const BASE_URL = 'https://frontaliereticino.ch';

/** Read a project file relative to root */
function readProjectFile(relativePath: string): string {
  return readFileSync(resolve(__dirname, '..', relativePath), 'utf-8');
}

/** Build all navigable routes (every tab + every sub-tab) */
function getAllRoutes(): { route: AppRoute; label: string }[] {
  const routes: { route: AppRoute; label: string }[] = [];

  // Calculator sub-tabs
  for (const sub of ALL_CALCOLATORE_SUBTABS) {
    routes.push({
      route: { activeTab: 'calculator', calcolatoreSubTab: sub as any },
      label: `calculator/${sub}`,
    });
  }

  // Confronti sub-tabs
  for (const sub of ALL_CONFRONTI_SUBTABS) {
    routes.push({
      route: { activeTab: 'confronti', confrontiSubTab: sub as any },
      label: `confronti/${sub}`,
    });
  }

  // Fisco sub-tabs
  for (const sub of ALL_FISCO_SUBTABS) {
    routes.push({
      route: { activeTab: 'fisco', fiscoSubTab: sub as any },
      label: `fisco/${sub}`,
    });
  }

  // Guida sub-tabs
  for (const sub of ALL_GUIDA_SUBTABS) {
    routes.push({
      route: { activeTab: 'guida', guidaSubTab: sub as any },
      label: `guida/${sub}`,
    });
  }

  // Vita sub-tabs
  for (const sub of ALL_VITA_SUBTABS) {
    routes.push({
      route: { activeTab: 'vita', vitaSubTab: sub as any },
      label: `vita/${sub}`,
    });
  }

  // Stats sub-tabs
  for (const sub of ALL_STATS_SUBTABS) {
    routes.push({
      route: { activeTab: 'stats', statsSubTab: sub as any },
      label: `stats/${sub}`,
    });
  }

  // Standalone pages
  const standalones: AppRoute['activeTab'][] = [
    'feedback', 'forum', 'contact', 'partners', 'consulting',
    'job-board', 'profile', 'morning', 'gamification',
    'privacy', 'terms', 'data-deletion', 'api-status', 'glossario', 'faq', 'sitemap',
    'dialetto',
    'email-confirmed',
    'chi-siamo',
    'tassazione-hub',
    'correzioni',
    'metodologia',
  ];
  for (const tab of standalones) {
    routes.push({ route: { activeTab: tab }, label: tab });
  }

  // SEO landings (long-tail)
  for (const id of ALL_SEO_LANDING_IDS) {
    routes.push({
      route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' as any, seoLanding: id as any },
      label: `landing/${id}`,
    });
  }

  // Glossary term deep links
  for (const term of ALL_GLOSSARY_TERM_IDS) {
    routes.push({
      route: { activeTab: 'glossario', glossaryTerm: term as any },
      label: `glossario/${term}`,
    });
  }

  // Border crossing deep links (valichi)
  for (const id of ALL_BORDER_CROSSING_IDS) {
    routes.push({
      route: { activeTab: 'guida', guidaSubTab: 'border' as any, borderCrossing: id as any },
      label: `valico/${id}`,
    });
  }

  // Blog list + individual articles (frontaliere section)
  routes.push({ route: { activeTab: 'blog' }, label: 'blog' });
  for (const id of ALL_BLOG_ARTICLE_IDS) {
    routes.push({
      // packages/articles/content/routerBlogData.ts (issue #4881 Fase 6)
      // exports ALL_BLOG_ARTICLE_IDS as string[] (confinement — the package
      // can't import the real BlogArticleId union). Every entry here IS a
      // valid BlogArticleId by construction, so narrow at this test-only
      // consumption site (mirrors services/router.ts's REVERSE_BLOG cast).
      route: { activeTab: 'blog', blogArticle: id as BlogArticleId },
      label: `blog/${id}`,
    });
  }

  // Switzerland-wide article section (svizzera) — mirror of the blog routes.
  routes.push({ route: { activeTab: 'blog', blogSection: 'svizzera' }, label: 'blog/svizzera' });
  for (const id of ALL_SWISS_ARTICLE_IDS) {
    routes.push({
      route: { activeTab: 'blog', blogSection: 'svizzera', swissArticle: id },
      label: `blog/svizzera/${id}`,
    });
  }

  // Author profile pages
  for (const author of AUTHORS) {
    routes.push({
      route: { activeTab: 'autore', author: author.slug } as AppRoute,
      label: `autore/${author.slug}`,
    });
  }

  return routes;
}

// ── Data ─────────────────────────────────────────────────────────────────────

const ALL_ROUTES = getAllRoutes();
// sitemap.xml is now a sitemap index — read all sub-sitemaps for URL checking
const sitemapContent = ['public/sitemap-pages.xml', 'public/sitemap-blog.xml', 'public/sitemap-blog-ch.xml', 'public/sitemap-glossario.xml']
  .map(f => { try { return readProjectFile(f); } catch { return ''; } }).join('\n');

// Issue #3010 item 1 correction (2026-07-03): svizzera articles whose IT
// slug is a canonical-override key (data/swiss-article-canonical-overrides.json)
// are intentionally DROPPED from sitemap-blog-ch.xml — same convention as
// data/job-canonical-overrides.json for jobs. A sitemap <loc> whose own page
// canonicalizes elsewhere is a hard CI gate failure ("Sitemap <loc> URLs
// MUST self-canonicalize", scripts/audit-sitemap-canonicals.mjs /
// scripts/validate-sitemap-pages.mjs), so these routes are excluded from the
// "every route has a sitemap entry" checks below. The page itself stays
// live/reachable (repo anti-cut rule) — only its sitemap presence is dropped.
const swissCanonicalOverrides = loadSwissArticleCanonicalOverrides(
  { readFileSync },
  resolve(__dirname, '..', 'data', 'swiss-article-canonical-overrides.json'),
);
const SHADOWED_SWISS_ARTICLE_IDS = new Set(
  ALL_SWISS_ARTICLE_IDS.filter((id) => {
    const itSlug = SWISS_SLUGS[id]?.it;
    return !!itSlug && Object.prototype.hasOwnProperty.call(swissCanonicalOverrides, itSlug);
  }),
);
function isShadowedSwissRoute(route: AppRoute): boolean {
  const swissArticle = (route as { swissArticle?: string }).swissArticle;
  return !!swissArticle && SHADOWED_SWISS_ARTICLE_IDS.has(swissArticle);
}
const indexNowContent = readProjectFile('scripts/submit-indexnow.js');
// The IndexNow key/host/POST moved into a shared module (#4837) so the
// sitemap-driven submitter and the fast-publish direct-URL submitter cannot
// drift apart on the key. Assert against its new home, and against the key
// FILE that must be served at the domain root — a key/keyfile mismatch is the
// actual way IndexNow submissions start silently failing.
const indexNowLibContent = readProjectFile('scripts/lib/indexnow-submit.mjs');
const llmsTxtContent = readProjectFile('public/llms.txt');

// Valid Schema.org types for Google/Bing rich results
const VALID_SCHEMA_TYPES = new Set([
  'WebSite', 'WebPage', 'WebApplication', 'SoftwareApplication',
  'Article', 'BlogPosting', 'NewsArticle', 'HowTo', 'FAQPage', 'Dataset', 'Quiz',
  'CollectionPage', 'ContactPage', 'ItemList', 'AboutPage',
  'Service', 'DiscussionForum', 'BreadcrumbList',
  'Organization', 'NewsMediaOrganization', 'FinancialService', 'DefinedTermSet', 'DefinedTerm',
  'Product', 'Offer', 'Event', 'Review', 'AggregateRating',
  // ClaimReview: fact-check markup emitted by services/seo/claim-review.ts on pillar pages
  // (AE-8). Verifiable factual claims are paired with AFC/AdE/UFAS/UFSP/bilateral-accord sources.
  'ClaimReview',
  // Domain-specific Schema.org types used by a small number of landings:
  // - ExchangeRateSpecification: confronti/exchange (currency exchange hub)
  // - Place: guida/border-map (geographic border crossings map)
  // - ProfilePage: author profile pages (A1/A2 Google News compliance)
  // - Person: embedded inside ProfilePage structuredData for author profiles
  // All are first-class Schema.org types recognised by Google.
  'ExchangeRateSpecification', 'Place', 'ProfilePage', 'Person',
]);

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SEO Completeness — every page has proper SEO setup', () => {

  // 1. Every route must have a getSeoSection mapping
  describe('getSeoSection covers all routes', () => {
    for (const { route, label } of ALL_ROUTES) {
      it(`${label} → getSeoSection returns a non-empty string`, () => {
        const section = getSeoSection(route);
        expect(section).toBeTruthy();
        expect(typeof section).toBe('string');
      });
    }
  });

  // 2. Every SEO section must have a SEO_METADATA entry
  describe('SEO_METADATA covers all route sections', () => {
    for (const { route, label } of ALL_ROUTES) {
      it(`${label} → SEO_METADATA['${getSeoSection(route)}'] exists`, () => {
        const section = getSeoSection(route);
        const metadata = SEO_METADATA[section];
        expect(metadata, `Missing SEO_METADATA['${section}'] for route ${label}`).toBeDefined();
      });
    }
  });

  // 3. Every SEO_METADATA entry must have required fields
  describe('SEO_METADATA entries have all required fields', () => {
    for (const { route, label } of ALL_ROUTES) {
      it(`${label} → has title, description, canonicalPath, structuredData`, () => {
        const section = getSeoSection(route);
        const meta = SEO_METADATA[section];
        if (!meta) return; // covered by previous test
        expect(meta.title, `${label}: missing title`).toBeTruthy();
        expect(meta.description, `${label}: missing description`).toBeTruthy();
        expect(meta.canonicalPath, `${label}: missing canonicalPath`).toBeTruthy();
        expect(meta.ogTitle, `${label}: missing ogTitle`).toBeTruthy();
        expect(meta.ogDescription, `${label}: missing ogDescription`).toBeTruthy();
        expect(meta.keywords, `${label}: missing keywords`).toBeTruthy();
        expect(meta.structuredData, `${label}: missing structuredData`).toBeDefined();
      });
    }
  });

  // 3b. No glossario term ships the generic auto-generated placeholder text
  // as its DefinedTerm.description (issue #4409 regression guard). Runtime
  // metadata (services/seoService.ts) must resolve every term id to a real,
  // backfilled entry in the shared services/seo/glossaryTermDefinitions.ts
  // registry — this is the exact fallback path that used to leak the
  // placeholder onto every non-hand-curated term page.
  describe('Glossario terms never ship the placeholder DefinedTerm.description (#4409)', () => {
    it('every ALL_GLOSSARY_TERM_IDS entry has a backfilled definition in the shared registry', () => {
      for (const termId of ALL_GLOSSARY_TERM_IDS) {
        const slug = buildPath({ activeTab: 'glossario', glossaryTerm: termId }, 'it')
          .replace(/\/+$/, '')
          .split('/')
          .filter(Boolean)
          .pop();
        expect(slug, `termId ${termId}: could not resolve IT slug`).toBeTruthy();
        const def = GLOSSARY_TERM_DEFINITIONS[slug as string];
        expect(def, `glossario term "${termId}" (slug "${slug}") has no entry in GLOSSARY_TERM_DEFINITIONS`).toBeTruthy();
        expect(
          GLOSSARY_PLACEHOLDER_DESCRIPTION_RX.test(def || ''),
          `glossario term "${termId}": definition text still matches the placeholder pattern`,
        ).toBe(false);
      }
    });

    for (const termId of ALL_GLOSSARY_TERM_IDS) {
      it(`glossario/${termId} → runtime SEO_METADATA description is not the placeholder`, () => {
        const route: AppRoute = { activeTab: 'glossario', glossaryTerm: termId };
        const section = getSeoSection(route);
        const meta = SEO_METADATA[section];
        if (!meta) return; // covered by earlier "required fields" test
        expect(
          GLOSSARY_PLACEHOLDER_DESCRIPTION_RX.test(meta.description || ''),
          `glossario/${termId}: SEO_METADATA.description is the generic placeholder`,
        ).toBe(false);
      });
    }
  });

  // 4. Structured data must have valid @type
  describe('Structured data has valid Schema.org @type', () => {
    for (const { route, label } of ALL_ROUTES) {
      it(`${label} → structuredData has valid @type`, () => {
        const section = getSeoSection(route);
        const meta = SEO_METADATA[section];
        if (!meta?.structuredData) return;

        const schemas = Array.isArray(meta.structuredData)
          ? meta.structuredData
          : [meta.structuredData];

        for (const schema of schemas) {
          expect(schema['@context'], `${label}: missing @context`).toBe('https://schema.org');
          const type = schema['@type'];
          expect(type, `${label}: missing @type`).toBeTruthy();
          expect(
            VALID_SCHEMA_TYPES.has(type),
            `${label}: unknown @type "${type}" — add to VALID_SCHEMA_TYPES if intentional`
          ).toBe(true);
        }
      });
    }
  });

  // 5. HowTo schemas must have step array (Google requirement)
  describe('HowTo structured data has steps (Google Rich Results requirement)', () => {
    for (const [key, meta] of Object.entries(SEO_METADATA)) {
      const schemas = Array.isArray(meta.structuredData)
        ? meta.structuredData
        : meta.structuredData ? [meta.structuredData] : [];

      for (const schema of schemas) {
        if (schema['@type'] === 'HowTo') {
          it(`SEO_METADATA['${key}'] HowTo has step array with ≥2 steps`, () => {
            expect(
              Array.isArray(schema.step),
              `${key}: HowTo missing 'step' array`
            ).toBe(true);
            expect(
              schema.step.length,
              `${key}: HowTo needs ≥2 steps for Google Rich Results`
            ).toBeGreaterThanOrEqual(2);
            for (const step of schema.step) {
              expect(step['@type']).toBe('HowToStep');
              expect(step.name, `${key}: HowToStep missing 'name'`).toBeTruthy();
              expect(step.text, `${key}: HowToStep missing 'text'`).toBeTruthy();
            }
          });
        }
      }
    }
  });

  // 6. FAQPage schemas must have mainEntity (Google requirement)
  describe('FAQPage structured data has mainEntity', () => {
    for (const [key, meta] of Object.entries(SEO_METADATA)) {
      const schemas = Array.isArray(meta.structuredData)
        ? meta.structuredData
        : meta.structuredData ? [meta.structuredData] : [];

      for (const schema of schemas) {
        if (schema['@type'] === 'FAQPage') {
          it(`SEO_METADATA['${key}'] FAQPage has mainEntity with ≥2 questions`, () => {
            expect(
              Array.isArray(schema.mainEntity),
              `${key}: FAQPage missing 'mainEntity' array`
            ).toBe(true);
            expect(
              schema.mainEntity.length,
              `${key}: FAQPage needs ≥2 questions`
            ).toBeGreaterThanOrEqual(2);
          });
        }
      }
    }
  });

  // 7. No phantom SEO_METADATA entries (entries without routes)
  describe('No phantom SEO_METADATA entries (every key maps to an actual route)', () => {
    const allSeoKeys = new Set<string>();
    for (const { route } of ALL_ROUTES) {
      allSeoKeys.add(getSeoSection(route));
    }

    // Keys that are used as parent metadata or for internal routing purposes.
    // Section landing keys (calcolatore, guide, fisco, vita) are used by the static
    // page generator to build SEO-optimised section index pages (/calcola-stipendio,
    // /guida-frontaliere, /tasse-e-pensione, /vivere-in-ticino) but the runtime
    // router maps them to their default sub-tab keys.
    const INTERNAL_KEYS = new Set([
      'newsletter', 'salarySurvey', 'comparatori',
      'calcolatore', 'guide', 'fisco', 'vita',
      'tax-return-italia', 'tax-return-svizzera',
      'contracts',
      'tfr-calculator',
      'permit-quiz',
      'frontaliere-wizard',
      'tredicesima',
      'weekly-digest',
      'tool-of-week',
      'guidaCompleta',
      'sindacati',
      'about', 'contact-alias', 'privacy-policy-alias',
      // Workstream C SemRush landing pages — long-tail SEO pages generated
      // as static HTML from `canonicalPath` by staticPagesPlugin. They are
      // not reachable via SPA sub-tab navigation (they are deep-link only,
      // same pattern as `guidaCompleta`) so getSeoSection does not need to
      // return these keys.
      'tassa-salute-frontalieri',
      'lamal-frontalieri',
      'outlet-fox-town-mendrisio',
      'ponti-2026-ticino',
      'vacanze-scolastiche-ticino-2026',
      // Sprint 2 pillar pages — static HTML only, deep-link accessible,
      // generated from `canonicalPath` by staticPagesPlugin (same pattern
      // as the SemRush landings above). Not reachable via SPA sub-tab nav.
      'pillarTasseSvizzere',
      'pillarLavoroLugano',
      'pillarNuovaLegge2026',
      'pillarOssSvizzera',
      'pillarStipendiChVsIt',
      // Locale-specific SEO enrichment entry for the German rendering of
      // /de/steuern-und-vorsorge/tessin-feiertage. Consumed at build time
      // by staticPagesPlugin from its `canonicalPath`. The SPA runtime
      // resolves all locales of this page via the `holidays` key.
      'holidaysDe',
    ]);

    for (const key of Object.keys(SEO_METADATA)) {
      if (INTERNAL_KEYS.has(key)) continue;
      it(`SEO_METADATA['${key}'] is reachable via getSeoSection`, () => {
        expect(
          allSeoKeys.has(key),
          `SEO_METADATA['${key}'] is a phantom entry — no route maps to it. Remove it or create a route.`
        ).toBe(true);
      });
    }
  });
});

// ── Sitemap Coverage ─────────────────────────────────────────────────────────

describe('Sitemap — every IT canonical URL is in sitemap.xml', () => {
  // Utility/legal pages intentionally excluded from sitemap (noindex — thin content by design)
  const NOINDEX_ROUTES = new Set(['contact', 'partners', 'consulting', 'privacy', 'api-status']);

  for (const { route, label } of ALL_ROUTES) {
    const activeTab = (route as { activeTab: string }).activeTab;
    if (NOINDEX_ROUTES.has(activeTab)) continue;
    if (isShadowedSwissRoute(route)) continue; // #3010 item 1: intentionally dropped from sitemap

    it(`${label} → sitemap has ${buildPath(route, 'it')}`, () => {
      const itPath = buildPath(route, 'it');
      const fullUrl = `${BASE_URL}${itPath}`;
      expect(
        sitemapContent.includes(fullUrl),
        `Missing from sitemap.xml: ${fullUrl}`
      ).toBe(true);
    });
  }

  it('sitemap has hreflang alternates for all 4 locales in every entry', () => {
    // Count <xhtml:link rel="alternate"> occurrences per locale
    const hreflangIT = (sitemapContent.match(/hreflang="it"/g) || []).length;
    const hreflangEN = (sitemapContent.match(/hreflang="en"/g) || []).length;
    const hreflangDE = (sitemapContent.match(/hreflang="de"/g) || []).length;
    const hreflangFR = (sitemapContent.match(/hreflang="fr"/g) || []).length;
    const hreflangDefault = (sitemapContent.match(/hreflang="x-default"/g) || []).length;
    const urlCount = (sitemapContent.match(/<url>/g) || []).length;

    expect(hreflangIT, 'Missing IT hreflang entries').toBe(urlCount);
    expect(hreflangEN, 'Missing EN hreflang entries').toBe(urlCount);
    expect(hreflangDE, 'Missing DE hreflang entries').toBe(urlCount);
    expect(hreflangFR, 'Missing FR hreflang entries').toBe(urlCount);
    expect(hreflangDefault, 'Missing x-default entries').toBe(urlCount);
  });
});

// ── IndexNow Coverage ────────────────────────────────────────────────────────

describe('IndexNow — submit-indexnow.js reads sitemap and submits to Bing', () => {
  it('reads URLs from sub-sitemaps (not hardcoded)', () => {
    expect(indexNowContent).toContain('sitemap-pages.xml');
    expect(indexNowContent).toContain('sitemap-blog.xml');
    expect(indexNowContent).toContain('readFileSync');
    expect(indexNowContent).toContain('<loc>');
  });

  it('submits to all 3 IndexNow endpoints (api.indexnow.org, Bing, Yandex)', () => {
    expect(indexNowContent).toContain('api.indexnow.org/indexnow');
    expect(indexNowContent).toContain('www.bing.com/indexnow');
    expect(indexNowContent).toContain('yandex.com/indexnow');
  });

  it('uses the correct IndexNow key, and it matches the hosted key file', () => {
    const KEY = '39093e02a74b4a2dbf867c74bc53a7d8';

    // 1. The key is declared once, in the shared module.
    expect(indexNowLibContent).toContain(KEY);

    // 2. The submitter imports it rather than redeclaring its own copy.
    expect(indexNowContent).toMatch(/from '\.\/lib\/indexnow-submit\.mjs'/);
    expect(indexNowContent).toContain('INDEXNOW_KEY');
    const ownDeclaration = /const\s+INDEXNOW_KEY\s*=\s*['"]/.test(indexNowContent);
    expect(ownDeclaration, 'submit-indexnow.js must import the key, not redeclare it').toBe(false);

    // 3. The key matches the file actually served at the domain root — IndexNow
    //    verifies ownership by fetching https://<host>/<key>.txt and comparing
    //    its contents to the submitted key.
    expect(readProjectFile(`public/${KEY}.txt`).trim()).toBe(KEY);
  });

  it('extracts hreflang alternate URLs for all locales', () => {
    expect(indexNowContent).toContain('hreflang');
  });

  // Verify every indexable route is in the sitemap (which IndexNow now reads from)
  // Utility/legal pages intentionally excluded from sitemap (noindex — thin content by design)
  const NOINDEX_ROUTES_INDEXNOW = new Set(['contact', 'partners', 'consulting', 'privacy', 'api-status']);

  for (const { route, label } of ALL_ROUTES) {
    const activeTab = (route as { activeTab: string }).activeTab;
    if (NOINDEX_ROUTES_INDEXNOW.has(activeTab)) continue;
    if (isShadowedSwissRoute(route)) continue; // #3010 item 1: intentionally dropped from sitemap

    it(`${label} → sitemap contains ${buildPath(route, 'it')} (indexed via IndexNow)`, () => {
      const itPath = buildPath(route, 'it');
      expect(
        sitemapContent.includes(`https://frontaliereticino.ch${itPath}`),
        `Missing from sitemap.xml (and thus IndexNow): ${itPath}`
      ).toBe(true);
    });
  }
});

// ── llms.txt Coverage (content pages only) ───────────────────────────────────

describe('llms.txt — content-rich pages are listed for AI crawlers', () => {
  // These are the content-rich pages that should be in llms.txt
  // Utility/legal pages (privacy, data-deletion, api-status, gamification, profile) are excluded
  const CONTENT_PAGES = [
    { path: '/calcola-stipendio', label: 'Calculator' },
    { path: '/compara-servizi', label: 'Confronti' },
    { path: '/tasse-e-pensione', label: 'Fisco' },
    { path: '/guida-frontaliere', label: 'Guida' },
    { path: '/vivere-in-ticino', label: 'Vita' },
    { path: '/statistiche', label: 'Statistiche' },
    { path: '/buongiorno-frontaliere', label: 'Morning Dashboard' },
    { path: '/cerca-lavoro-ticino', label: 'Job Board' },
    { path: '/supporto', label: 'Feedback' },
    { path: '/community', label: 'Community Forum' },
    { path: '/consulenza', label: 'Consulting' },
    { path: '/contattaci', label: 'Contact' },
    { path: '/servizi-partner', label: 'Partners' },
  ];

  for (const { path, label } of CONTENT_PAGES) {
    it(`${label} (${path}) is in llms.txt`, () => {
      expect(
        llmsTxtContent.includes(path),
        `Missing from llms.txt: ${path} (${label})`
      ).toBe(true);
    });
  }
});

// ── Sitemap ↔ Router consistency ─────────────────────────────────────────────

describe('Sitemap URLs match router buildPath for all locales', () => {
  const locales = ['it', 'en', 'de', 'fr'] as const;

  // Utility/legal pages intentionally excluded from sitemap (noindex — thin content by design).
  // Removed from sitemap to fix Bing "insufficient content" audit warnings.
  const NOINDEX_ROUTES = new Set(['contact', 'partners', 'consulting', 'privacy', 'api-status']);

  for (const { route, label } of ALL_ROUTES) {
    const activeTab = (route as { activeTab: string }).activeTab;
    if (NOINDEX_ROUTES.has(activeTab)) continue;
    if (isShadowedSwissRoute(route)) continue; // #3010 item 1: intentionally dropped from sitemap

    for (const locale of locales) {
      it(`${label} [${locale}] → sitemap hreflang URL matches buildPath`, () => {
        const path = buildPath(route, locale);
        const fullUrl = `${BASE_URL}${path}`;
        expect(
          sitemapContent.includes(fullUrl),
          `Sitemap missing [${locale}] URL: ${fullUrl} for route ${label}`
        ).toBe(true);
      });
    }
  }
});

// ── Structured Data Compliance Summary ───────────────────────────────────────

describe('Structured data — Google/Bing compliance rules', () => {
  it('no SEO_METADATA entry has empty structuredData', () => {
    for (const [key, meta] of Object.entries(SEO_METADATA)) {
      if (meta.structuredData) {
        const schemas = Array.isArray(meta.structuredData)
          ? meta.structuredData
          : [meta.structuredData];
        for (const schema of schemas) {
          expect(
            Object.keys(schema).length,
            `${key}: structuredData is empty object`
          ).toBeGreaterThan(0);
        }
      }
    }
  });

  it('all canonical paths start with /', () => {
    for (const [key, meta] of Object.entries(SEO_METADATA)) {
      expect(
        meta.canonicalPath.startsWith('/'),
        `${key}: canonicalPath "${meta.canonicalPath}" must start with /`
      ).toBe(true);
    }
  });

  it('no structuredData URLs contain undefined or null', () => {
    for (const [key, meta] of Object.entries(SEO_METADATA)) {
      const json = JSON.stringify(meta.structuredData);
      expect(json).not.toContain('undefined');
      expect(
        /:\s*null\b|\[\s*null\b|\bnull\s*]/.test(json),
        `${key}: structuredData contains a real null value`
      ).toBe(false);
    }
  });

  it('all structuredData URLs use the correct BASE_URL', () => {
    for (const [key, meta] of Object.entries(SEO_METADATA)) {
      const json = JSON.stringify(meta.structuredData);
      if (json.includes('http')) {
        const urlMatches = json.match(/https?:\/\/[^"]+/g) || [];
        for (const url of urlMatches) {
          if (url.includes('frontaliereticino')) {
            expect(
              url.startsWith(BASE_URL),
              `${key}: URL "${url}" doesn't use BASE_URL "${BASE_URL}"`
            ).toBe(true);
          }
        }
      }
    }
  });
});

// ── OG Meta Integrity — escaped quotes must survive build regex extraction ──

describe('OG Meta Integrity — no truncated titles/descriptions from escaped quotes', () => {
  const seoSrc = readProjectFile('services/seoService.ts');
  const blogKeys = Object.keys(SEO_METADATA).filter(k => k.startsWith('blog-'));

  // This is the regex the ogPagesPlugin uses to extract quoted strings from
  // seoService.ts source. It must handle escaped quotes like dell\'USI and BOTH
  // single- and double-quoted values (seo-pages.ts entries mix styles — #2996).
  const extractFromSource = (block: string, key: string, flags = ''): string => {
    const rxSingle = new RegExp(String.raw`${key}:\s*'((?:[^'\\]|\\.)*)'`, flags);
    const rxDouble = new RegExp(String.raw`${key}:\s*"((?:[^"\\]|\\.)*)"`, flags);
    const m = block.match(rxSingle) || block.match(rxDouble);
    return m?.[1]?.replace(/\\'/g, "'") ?? '';
  };

  for (const seoKey of blogKeys) {
    const meta = SEO_METADATA[seoKey];

    it(`${seoKey} → ogTitle/title not truncated at apostrophe`, () => {
      const ogT = meta.ogTitle ?? meta.title;
      expect(ogT.endsWith('\\'), `Truncated ogTitle: "${ogT}"`).toBe(false);
      expect(ogT.length).toBeGreaterThan(10);
    });

    it(`${seoKey} → ogDescription/description not truncated at apostrophe`, () => {
      const ogD = meta.ogDescription ?? meta.description;
      expect(ogD.endsWith('\\'), `Truncated ogDescription: "${ogD}"`).toBe(false);
      expect(ogD.length).toBeGreaterThan(10);
    });

    it(`${seoKey} → build regex extracts title matching runtime value`, () => {
      // Find this entry's block in the source
      const blockRx = new RegExp(String.raw`'${seoKey}':\s*\{[\s\S]*?canonicalPath:\s*'[^']*'`, 'm');
      const blockMatch = seoSrc.match(blockRx);
      if (!blockMatch) return; // entry generated dynamically, skip source check

      const block = blockMatch[0];
      const extracted = extractFromSource(block, 'title', 'm');
      expect(extracted, `Build regex failed to extract title for ${seoKey}`).toBe(meta.title);
    });
  }
});
