# Custom Instructions

## Project Overview

**Frontaliere Ticino** is an Italian-language React SPA that helps Swiss-Italian cross-border workers ("frontalieri") compare the financial impact of living in Switzerland (Permit B) vs commuting from Italy (Permit G). It covers fiscal simulation, pension planning, health insurance, currency exchange, transport costs, and more.

- **Live site**: Firebase Hosting (deployed via `main` branch push)
- **Primary language**: Italian (UI and domain), with i18n support for EN/DE/FR
- **Domain context**: Swiss/Italian tax law (2026 New Agreement), LAMal health insurance, AVS/LPP pensions, CHF-EUR exchange

---

## Architecture

### Single-file SPA — No Router Library

There is **no React Router**. All routing is hand-rolled in `services/router.ts`:

- `App.tsx` holds **all navigation state** as local `useState` hooks (no Redux, no Context, no Zustand).
- URL paths use locale-aware slugs: Italian has no prefix (`/comparatori/cambio-valuta`), others get `/{lang}/...` (`/en/comparators/currency-exchange`).
- Navigation: `pushRoute(route)` calls `history.pushState`; `popstate` listener re-parses URL.
- `ActiveTab` union type: `'calculator' | 'feedback' | 'stats' | 'pension' | 'guide' | 'comparatori' | 'privacy' | 'data-deletion' | 'api-status' | 'gamification'`
- Sub-tabs: `CalcolatoreSubTab` (8), `ConfrontiSubTab` (8), `FiscoSubTab` (7), `GuidaSubTab` (8), `VitaSubTab` (8), `StatsSubTab` (5)

**Navigation Limits — HARD CAPS**

| Level | Max items | Current | Enforcement |
|-------|-----------|---------|-------------|
| Top-level nav (header + mobile bar) | **6** | 6 (`calculator`, `confronti`, `fisco`, `guida`, `vita`, `stats`) | Do NOT add a 7th tab to the nav bar. New sections go as sub-tabs or footer-only links. |
| Sub-tabs per category | **8** | All at 8 except `FiscoSubTab` (7) and `StatsSubTab` (5) | Before adding a sub-tab, verify the category isn't already at 8. If full, consider a different category or combine features. |

- The 6 top-level nav tabs are fixed: **Calcolatore**, **Confronti**, **Fisco**, **Guida**, **Vita**, **Statistiche**. Adding more degrades mobile UX (the bottom bar has room for exactly 6 icons).
- Additional `ActiveTab` values (e.g., `forum`, `blog`, `contact`, `partners`, `consulting`, `job-board`, `morning`, `profile`) are **NOT in the nav bar** — they are accessible via footer links, search, or deep links only.
- Sub-tab menus use a horizontal scrollable pill bar. More than 8 pills become unreadable on mobile.

**When adding a new tab:**
1. Add value to the `ActiveTab` type union in `services/router.ts`
2. Add slugs to all 4 locale `SlugTable` objects in `services/router.ts`
3. Add the reverse lookup entry in `buildTopLevelReverse()`
4. Add `case` in `buildPath()` switch
5. Add the component rendering branch in `App.tsx`'s content switch

### Component Layout

```
App.tsx              — Root. All state lives here. Renders tab-based content.
components/          — 32 feature components, one per file, default-exported.
services/            — Stateless service modules (no classes, just exported functions/objects).
  calculationService.ts — Swiss-Italian fiscal simulation engine
  router.ts             — URL routing, slug tables, path building/parsing
  i18n.ts               — 4-locale translations (~9000 lines), t() function, hooks
  analytics.ts          — Firebase GA4 wrapper
  firebase.ts           — Firebase init, Remote Config, App Check
  seoService.ts         — Meta tag management
  exchangeRateService.ts — TwelveData + Firestore cache for CHF-EUR rates
  trafficService.ts     — Border crossing traffic data
  recaptchaService.ts   — reCAPTCHA v3 client
constants.ts         — Default simulation inputs, expense templates, tax parameters
types.ts             — SimulationInputs, SimulationResult, ExpenseItem interfaces
```

### Key Design Decisions

- **No build-time secrets**: All API keys (Google Maps, reCAPTCHA, Gemini, GitHub PAT) load from **Firebase Remote Config** at runtime. `.env` only has non-sensitive Firebase config. Never hardcode secrets.
- **Inline translations**: All i18n strings are in `services/i18n.ts` (not JSON files). Each locale is a flat `Record<string, string>` with dot-notation keys.
- **GitHub Pages SPA**: `public/404.html` redirects all paths to `index.html` via sessionStorage. `index.html` restores the path on load.

---

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Framework | React 19 | Function components only, hooks only |
| Language | TypeScript ~5.8 | `@/*` path alias → project root |
| Bundler | Vite 6 | Dev on port 3000 |
| Styling | Tailwind CSS 4 | Dark mode via class strategy |
| Charts | Recharts 3 | Used in ComparisonChart, ResultsView |
| Maps | Leaflet + react-leaflet | For TicinoCompanies, border crossings |
| PDF | jsPDF + jspdf-autotable | Client-side report generation |
| Icons | lucide-react | Tree-shakeable, import individually |
| Backend | Firebase (Analytics, Remote Config, App Check, Firestore) | No custom backend server |
| Testing | Vitest 4 + Testing Library + jsdom | `vitest.config.ts` separate from `vite.config.ts` |

---

## Developer Workflows

### Commands

```bash
npm run dev          # Vite dev server on port 3000
npm run build        # Production build → dist/
npm run preview      # Preview production build
npm test             # npx vitest run (single run)
npm run test:watch   # npx vitest (watch mode)
```

### Pre-push Hook

`.githooks/pre-push` runs `npm test` then `npx vite build --logLevel error`. Push is blocked if either fails. Activate with:
```bash
git config core.hooksPath .githooks
```

### Deployment

Push to `main` → GitHub Actions workflow (`.github/workflows/deploy.yml`) → validations + `npm run build` → deploy to Firebase Hosting.

### Build Verification

After any code change, always verify:
1. **TypeScript**: `npx tsc --noEmit` — pre-existing errors in ErrorBoundary/ShoppingCalculator/TaxCalendar are known, ignore those.
2. **Build**: `npx vite build` — must exit 0.
3. **Tests**: `npx vitest run` — all tests must pass.

---

## Testing Conventions

### Test Structure

```
tests/
  setup.tsx                    — Global mocks (matchMedia, localStorage, Firebase, Analytics, Leaflet)
  *.test.ts / *.test.tsx       — Test files
```

### Configuration (`vitest.config.ts`)

- `globals: true` — `vi`, `describe`, `it`, `expect` available without imports
- `environment: 'jsdom'`
- `@/` alias resolves to project root

### What's Mocked in Setup

- `window.matchMedia` — always returns `{ matches: false }`
- `localStorage` — in-memory store (cleared between tests via `localStorage.clear()` in `beforeEach`)
- `@/services/firebase` — `{ app: {}, analytics: null, db: {} }`
- `@/services/analytics` — all `Analytics` methods as `vi.fn()`
- `@/services/seoService` — `updateMetaTags`, `trackSectionView` as `vi.fn()`
- `leaflet` / `react-leaflet` — stub implementations

### Testing Rules

**Every new feature or component MUST include tests.** Follow this checklist:

1. **Write tests** for new logic/components in `tests/` directory
2. **Run tests**: `npx vitest run` — all must pass
3. **Check console**: Look for warnings or unexpected errors during test runs
4. **Run the application**: `npm run dev` — verify it works visually
5. **Fix bugs and warnings** before proceeding
6. **Build**: `npx vite build` — must succeed
7. **Commit and push**: Only after all above pass

### Test Patterns by Type

- **Pure logic** (calculation, gamification, health insurance): Import and test exported functions directly. See `calculationService.test.ts`, `gamification.test.ts`, `healthInsurance.test.ts`.
- **Router**: Test `buildPath`/`parsePath` roundtrips for all locales. See `router.test.ts`.
- **i18n**: `i18n-completeness.test.ts` auto-scans source for `t()` calls and verifies all keys exist in all 4 locales. Adding a `t('new.key')` without translations will fail this test.
- **Smoke tests**: `app-smoke.test.tsx` renders App with each tab and checks for crashes.
- **Security**: `no-secrets-in-build.test.ts` scans the `dist/` folder for leaked secrets.

---

## i18n — Adding Translations

All translations live in `services/i18n.ts` inside the `translations` object.

1. Choose a dot-notation key: `'section.subsection.label'`
2. Add the key+value to **all 4 locale blocks** (IT, EN, DE, FR) — they start at approximately:
   - IT: line ~105
   - EN: line ~2250
   - DE: line ~4500
   - FR: line ~6750
3. Use in components: `const { t } = useTranslation(); ... t('section.subsection.label')`
4. `t()` supports interpolation: `t('key', { name: 'value' })` replaces `{name}` in the string
5. Fallback chain: current locale → Italian → raw key string
6. **`i18n-completeness.test.ts` will catch missing keys** — run tests after adding `t()` calls

---

## Gamification System

### How It Works

- 20 achievements across 4 categories: `explorer`, `calculator`, `expert`, `social`
- State persisted to `localStorage('frontaliere_achievements')`
- Listener pattern: components call global `unlockAchievement(id)` from anywhere
- Each unlock awards 50 XP; 10-level progression system

### Adding a New Achievement

1. Add entry to `ACHIEVEMENTS` array in `components/GamificationWidget.tsx`
2. Add `unlockAchievement('new_id')` call at the appropriate trigger point
3. Add i18n keys: `gamification.achievement.new_id` and `gamification.achievementDesc.new_id` in all 4 locales
4. Add test in `tests/gamification.test.ts` verifying the ID exists in ACHIEVEMENTS

### Exported API (`components/GamificationWidget.tsx`)

```ts
unlockAchievement(achievementId: string)  // Call from any component
addXp(amount: number)                      // Direct XP addition
loadState(): GamificationState             // Read current state
getLevel(xp: number): { level, currentXp, nextLevelXp }
ACHIEVEMENTS: Achievement[]               // All achievement definitions
LEVEL_TITLES: string[]                     // Level name by index
```

---

## Health Insurance Comparator

The `components/HealthInsurance.tsx` module exports:
- `INSURERS` — 14 real Swiss LAMal insurer profiles
- `calculatePremium(insurerId, canton, model, franchise, ageGroup, withAccident)` — returns monthly CHF premium or null
- `FRANCHISES`, `FRANCHISES_CHILD`, `MODEL_DISCOUNT`, `FRANCHISE_ADJUSTMENT`, `CANTONS`

Premium calculation: `base × (1 - modelDiscount) × (1 + franchiseAdjustment) × ageMultiplier × (1 + accidentCover)`

Cantons with data: TI, GR, VS, ZH, GE, BE, LU.

---

## Fiscal Calculation Engine

`services/calculationService.ts` → `calculateSimulation(inputs: SimulationInputs): SimulationResult`

- Swiss social deductions: AVS (5.3%), AC (1.1%), LAA (0.7%), IJM (0.8%), LPP (age-bracketed)
- Ticino imposta alla fonte: interpolated from A/B/C/H tax tables based on marital status + children
- Italian IRPEF: 2026 scaglioni with €10,000 franchigia for new frontalieri, addizionale regionale
- Per-child discount on Swiss withholding tax
- CHF→EUR conversion for Italian tax calculations

---

## Critical Patterns

### Import Alias

All imports use `@/` which resolves to the project root:
```ts
import { calculateSimulation } from '@/services/calculationService';
import HealthInsurance from '@/components/HealthInsurance';
```

### Component Convention

- One component per file in `components/`
- Default export for page-level components
- Named exports for shared utilities
- Named exports for sub-components only when used by a single parent
- Tailwind classes directly in JSX — no CSS modules, no styled-components
- Dark mode: always include `dark:` variants for backgrounds, text, borders

### State Management

- **No global state library**. All state lives in `App.tsx` as `useState` hooks
- Child components receive state via props
- Side effects (analytics, SEO, routing) are in `useEffect` hooks in `App.tsx`
- Cross-component communication for gamification uses the global `unlockAchievement()` function pattern

### Error Handling

- `ErrorBoundary` component wraps content in `App.tsx`
- Firebase/API calls use try-catch with console warnings
- External API failures degrade gracefully (e.g., simulated traffic data when Google Maps API unavailable)

### Security Rules

- **Never** commit API keys, tokens, or secrets to source
- All sensitive values load from Firebase Remote Config at runtime
- `tests/no-secrets-in-build.test.ts` verifies the `dist/` folder is clean
- Firebase config in `.env` is considered non-sensitive (project identifiers only)

---

## File Reference Quick Guide

| What you need | Where to find it |
|--------------|-------------------|
| Add a new tab/page | `services/router.ts` (type + slugs) → `App.tsx` (rendering) |
| Add translations | `services/i18n.ts` (all 4 locale blocks) |
| Modify tax calculation | `services/calculationService.ts` + `constants.ts` |
| Add analytics event | `services/analytics.ts` (add method) → component (call it) |
| Add achievement | `components/GamificationWidget.tsx` → trigger point → i18n |
| Add test | `tests/*.test.{ts,tsx}` — follow existing patterns |
| Mock a new service | `tests/setup.tsx` |
| Border crossing data | `data/borderCrossings.ts` |
| Default expenses | `constants.ts` → `calculateDynamicExpenses()` |
| SEO/meta tags | `services/seoService.ts` + `index.html` (structured data) |

---

## PageSpeed & Accessibility Rules

These rules prevent performance and accessibility regressions. **All new code MUST comply.**

### Color Contrast (WCAG AA)

- **Minimum contrast ratio**: 4.5:1 for normal text, 3:1 for large text (≥18px or ≥14px bold)
- **Never use `text-slate-400`** on light backgrounds (white, slate-50, etc.) — it fails at ~3.0:1. Use `text-slate-500` (4.6:1) or `text-slate-600` (5.7:1) instead
- **Never use `text-[color]-400`** for visible text — reserve `-400` for icons or dark mode only
- **Colored text on colored backgrounds** must pass contrast:
  - `text-[color]-500` on `bg-[color]-50` often FAILS (3.3–3.9:1). Use `text-[color]-700` instead
  - Examples: `text-blue-700` on `bg-blue-50` (7.0:1 ✓), `text-red-700` on `bg-red-50` (5.5:1 ✓)
- **Dark mode**: `dark:text-slate-400` or `dark:text-[color]-400` on dark backgrounds IS acceptable

### Accessible Buttons & Forms

- **Every button** must have an accessible name: visible text content, `aria-label`, or `title` attribute
- **Icon-only buttons** (e.g., `<button><X size={16}/></button>`) MUST have `aria-label` describing the action
- **All form inputs** must have associated `<label>` elements via `htmlFor`/`id`, or use `aria-label`
- **All `<select>` elements** must have associated labels
- **Do not use `user-scalable=no`** or `maximum-scale=1.0` in the viewport meta tag

### Images

- **All `<img>` tags** must have `width` and `height` attributes (prevents layout shift / CLS)
- **All `<img>` tags** must have meaningful `alt` attributes
- External images should use `loading="lazy"` when below the fold

### Performance

- **Lazy-load non-critical components** with `React.lazy()` + `Suspense` (see `App.tsx` pattern)
- **Vendor chunking**: large deps (firebase, recharts, leaflet, jspdf) are in `manualChunks` in `vite.config.ts`
- **Defer non-critical scripts**: Use `async` or `defer` attributes for analytics/tracking scripts (gtag, reCAPTCHA)
- **Font loading**: Always use `font-display: swap` for custom fonts. Google Fonts URLs should include `&display=swap`
- **Preload critical fonts**: Add `<link rel="preload">` for above-the-fold font files
- **Source maps**: Enable `sourcemap: true` in Vite build config for debugging deployed code

### Site Search

- **When adding a new tab or sub-tab**, also add it to the `searchIndex` in `components/SiteSearch.tsx`
- Every `ActiveTab`, `ComparatoriSubTab`, and `GuideSection` value must have a corresponding entry in `SiteSearch.tsx`

### CSS & Styling Quick Reference

| Need | Use | Don't use |
|------|-----|-----------|
| Muted text (light mode) | `text-slate-500` or `text-slate-600` | `text-slate-400` |
| Muted text (dark mode) | `dark:text-slate-400` or `dark:text-slate-500` | `dark:text-slate-300` |
| Colored label on colored bg | `text-[color]-700` on `bg-[color]-50` | `text-[color]-500` on `bg-[color]-50` |
| Icon-only button | Add `aria-label="Action description"` | Leave button without text/label |
| Form input | Add `id` + matching `<label htmlFor>` | Unlabeled input |
| Image | Add `width`, `height`, `alt` | `<img>` without dimensions |

---

## SEO & Indexing

This is a client-side SPA on GitHub Pages. SEO requires extra care because search engines see only the initial HTML until JavaScript hydrates.

### Architecture

- **`index.html`** — Static meta tags, OG tags, hreflang links, JSON-LD structured data (WebSite + WebApplication schemas). This is what crawlers see before JS runs.
- **`services/seoService.ts`** — Dynamic SEO via `updateMetaTags(section)`. Sets document title, meta description, keywords, canonical URL, OG tags, Twitter cards, hreflang alternates, and JSON-LD breadcrumbs at runtime.
- **`public/sitemap.xml`** — Sitemap index referencing 4 sub-sitemaps: `sitemap-pages.xml` (~107 URLs), `sitemap-blog.xml` (~124), `sitemap-glossario.xml` (~42), `sitemap-news.xml` (~46). Each URL has hreflang alternates for all 4 locales (it/en/de/fr + x-default).
- **`public/robots.txt`** — Allows all crawlers, includes sitemap location, blocks `/api/` and debug params.
- **`public/404.html`** — SPA redirect: stores path in sessionStorage, redirects to `/index.html`, which restores the path on load.

### SEO Rules — MANDATORY

1. **Every new page/sub-tab MUST have a `SEO_METADATA` entry** in `services/seoService.ts` with: `title`, `description`, `keywords`, `ogTitle`, `ogDescription`, `canonicalPath`. The `seo-completeness.test.ts` test will catch missing entries.
2. **Every new page MUST be added to `public/sitemap.xml`** with:
   - `<loc>` for the Italian URL
   - `<xhtml:link rel="alternate">` for all 4 locales + x-default
   - Appropriate `<lastmod>`, `<changefreq>`, and `<priority>`
3. **Hreflang consistency**: Every URL in the sitemap must have matching hreflang entries. If locale `X` links to locale `Y`, locale `Y` must link back to `X`.
4. **Canonical URLs**: Always use `https://frontaliereticino.ch/` (NO `www`, with trailing path, no trailing slash except root).
5. **Meta descriptions**: 150–160 characters, include primary keyword, in the page's locale language.
6. **Titles**: Format `Keyword Phrase | Frontaliere Ticino`. Max 60 characters.
7. **Structured data**: Add JSON-LD `structuredData` to `SEO_METADATA` entries for tool/calculator pages (use `WebApplication` or `FAQPage` schema as appropriate).
8. **No duplicate content**: Each page must have a unique title and description. Never copy-paste between entries.
9. **Image SEO**: OG image is set globally (`/images/og-frontaliere.png`, 1200×630). If a page has a specific image, set `og:image` in its metadata.

### Updating the Sitemap

When adding a new page:
```xml
<url>
  <loc>https://frontaliereticino.ch/{italian-slug}</loc>
  <xhtml:link rel="alternate" hreflang="it" href="https://frontaliereticino.ch/{it-slug}" />
  <xhtml:link rel="alternate" hreflang="en" href="https://frontaliereticino.ch/en/{en-slug}" />
  <xhtml:link rel="alternate" hreflang="de" href="https://frontaliereticino.ch/de/{de-slug}" />
  <xhtml:link rel="alternate" hreflang="fr" href="https://frontaliereticino.ch/fr/{fr-slug}" />
  <xhtml:link rel="alternate" hreflang="x-default" href="https://frontaliereticino.ch/{it-slug}" />
  <lastmod>YYYY-MM-DD</lastmod>
  <changefreq>weekly|monthly</changefreq>
  <priority>0.8</priority>
</url>
```
- Get the slug values from the `SlugTable` objects in `services/router.ts`
- High-traffic pages (calculator, main comparators): `priority 0.9`, `changefreq weekly`
- Content pages (guide sections, articles): `priority 0.7`, `changefreq monthly`
- Utility pages (privacy, API status): `priority 0.3`, `changefreq yearly`

### Static Page Generation — CRITICAL for Indexing

This is a client-side SPA. Without static HTML, Google sees an empty `<div id="root">` and **will not index the page**. The build pipeline generates static HTML pages for every URL in the sitemaps via two Vite plugins in `vite.config.ts`:

- **`ogPagesPlugin()`** — Generates static HTML for blog article URLs (from `sitemap-blog.xml`)
- **`staticPagesPlugin()`** — Generates static HTML for all other sitemap URLs (from `sitemap-pages.xml`, `sitemap-glossario.xml`). It reads `canonicalPath` values from `BASE_SEO_METADATA` in `services/seoService.ts` and matches them against sitemap URLs. **If a URL has no matching SEO entry, its static page is SKIPPED.**

Each generated page includes:
- Full `<title>` and `<meta name="description">` from SEO metadata
- Open Graph and Twitter Card meta tags
- `<link rel="canonical">` and hreflang `<link rel="alternate">` tags
- JSON-LD BreadcrumbList structured data
- Inline critical CSS + async main CSS loading
- `<nav>` with internal links for crawler discoverability
- `<article>` with the page title and description as visible HTML text
- SPA bundle `<script>` tags for client-side hydration

**Every new page MUST generate a static HTML file in `dist/`.** After `npx vite build`, verify with:
```bash
ls dist/{your-italian-slug}/index.html          # Must exist
head -30 dist/{your-italian-slug}/index.html     # Must have <title>, <meta>, <link rel="canonical">
```

### Indexability Checklist — MANDATORY for Every New Page

When adding a new page, sub-tab, or feature with its own URL, complete **ALL** of the following steps to ensure Google can discover, crawl, and index it:

1. **`SEO_METADATA` entry** in `services/seoService.ts` → `BASE_SEO_METADATA` object:
   - `title` (max 60 chars, format: `Keyword Phrase | Frontaliere Ticino`)
   - `description` (150–160 chars, include primary keyword, in page locale)
   - `keywords` (comma-separated, 5–10 relevant terms)
   - `ogTitle`, `ogDescription`
   - `canonicalPath` (Italian URL path, e.g., `/calcola-stipendio/simula-busta-paga`)
   - `structuredData` (JSON-LD array — use `WebApplication` for tools, `FAQPage` for Q&A, `CollectionPage` for indexes, `HowTo` for guides)

2. **Sitemap entry** in the appropriate sub-sitemap (`public/sitemap-pages.xml` for pages, `sitemap-blog.xml` for articles):
   - `<loc>` with Italian URL
   - `<xhtml:link rel="alternate">` for all 4 locales + x-default
   - `<lastmod>` set to today's date
   - `<changefreq>` and `<priority>` based on content type

3. **Router slugs** in `services/router.ts` — all 4 locale `SlugTable` objects

4. **Build verification** — run `npx vite build` and confirm:
   - The new page appears in the static page count (logged as `Generated N static pages`)
   - `dist/{italian-slug}/index.html` exists and has correct `<title>` and `<meta>`
   - The static HTML includes `<link rel="canonical">` pointing to the correct URL

5. **Test verification** — run `npx vitest run`:
   - `seo-completeness.test.ts` verifies every route has SEO metadata, sitemap entry, and structured data
   - If the new SEO key is a section-level landing (used by `staticPagesPlugin` but not returned by `getSeoSection()`), add it to `INTERNAL_KEYS` in the test

6. **Internal linking** — ensure the new page is reachable:
   - From at least one other page via a visible `<a href>` link
   - From `SiteSearch.tsx` search index
   - From `public/llms.txt` (if it's a major page)
   - Optionally from the static page nav links in `vite.config.ts` `staticPagesPlugin` (for top-level sections)

7. **After deployment**, submit the URL for indexing via IndexNow (`scripts/submit-indexnow.js`) and Google Search Console URL Inspection.

### Common Indexing Pitfalls — AVOID THESE

| Pitfall | Why it breaks indexing | Prevention |
|---------|----------------------|------------|
| Missing `canonicalPath` in SEO metadata | `staticPagesPlugin` skips the URL → no HTML for crawlers | Always include `canonicalPath` |
| URL in sitemap but no SEO entry | Static page skipped, Google finds empty SPA shell | Add SEO entry BEFORE adding to sitemap |
| SEO entry exists but URL not in sitemap | Google doesn't know the page exists | Add to sitemap simultaneously |
| New section with no section landing page | Parent URL (e.g., `/calcola-stipendio`) returns empty shell | Add section-level SEO entries with `CollectionPage` structured data |
| Orphan page (no internal links to it) | Low crawl priority, may never be discovered | Link from related pages + SiteSearch |
| Missing hreflang on sitemap entry | Google may see duplicate content across locales | Always add all 4 locales + x-default |
| CLS > 0.1 on the page | Google penalizes pages with poor Core Web Vitals | Reserve space for dynamic content with `min-h-*` classes |

### Google Indexing & Discoverability

- The site is registered on **Google Search Console** and **Bing Webmaster Tools** (verification meta tags in `index.html`).
- After deploying new pages, request indexing via Google Search Console's URL Inspection tool.
- The `robots.txt` allows all bots. Do not add restrictive rules for content pages.
- The SPA 404→redirect pattern means Google may see a 200 for all URLs. This is expected and works with the hreflang setup.
- **Static page generation is the ONLY reliable way to get pages indexed.** Do not rely on client-side rendering for SEO. If a page doesn't have a static HTML file in `dist/`, it will NOT be indexed.

---

## Blog & Articles

### How It Works

Articles are stored **entirely in code** — there is no external CMS, no markdown files, no API.

- **`components/BlogArticles.tsx`** — Contains the `ARTICLES: Article[]` array with metadata: `id`, `category`, `image`, `readingMinutes`
- **All text is in i18n** — Translation keys: `blog.article.{id}.title`, `blog.article.{id}.excerpt`, `blog.article.{id}.content` (plus section keys for long articles)
- **Routed as**: `ActiveTab = 'blog'`, Italian slug: `/articoli-frontaliere`
- **Categories**: Each article has a category used for filtering in the UI

### Adding a New Article

1. Add an entry to the `ARTICLES` array in `BlogArticles.tsx` with a unique `id`
2. Add translation keys in all 4 locales: `blog.article.{id}.title`, `blog.article.{id}.excerpt`, `blog.article.{id}.content`
3. Update `<lastmod>` in `sitemap.xml` for the blog URL to today's date
4. Keep article content **accurate and up-to-date** with current Swiss/Italian regulations (2026 New Agreement)

### Content Quality Rules

- Articles must provide **actionable, accurate information** for cross-border workers
- Reference **current tax rates, deadlines, and regulations** — update when laws change
- Content should target **long-tail SEO keywords** relevant to frontalieri (e.g., "tassazione frontalieri 2026", "nuovo accordo frontalieri", "permesso G vantaggi")
- Each article should answer a specific question that frontalieri commonly search for
- Keep content in **professional Italian** as primary, then translate to EN/DE/FR

---

## UI Consistency & User Engagement

### Visual Consistency Rules

- **Color palette**: Use Tailwind's `slate` for neutrals, `blue` for primary actions, `violet` for gamification/premium features, `emerald` for positive indicators, `red` for warnings/errors. Do not introduce new color families.
- **Card pattern**: All content sections use rounded cards (`rounded-xl` or `rounded-2xl`) with consistent padding (`p-4` to `p-6`), white/dark background (`bg-white dark:bg-slate-800`), and subtle borders (`border border-slate-200 dark:border-slate-700`).
- **Section headers**: Icon (from lucide-react) + title in `text-lg font-bold` + optional subtitle in `text-sm text-slate-600`. Consistent across all tabs.
- **Interactive elements**: All buttons use rounded corners (`rounded-lg`), consistent padding (`px-4 py-2`), and hover/focus states. Primary actions use `bg-blue-600 hover:bg-blue-700 text-white`.
- **Spacing**: Use `space-y-4` or `space-y-6` between sections. Cards within a grid use `gap-4` or `gap-6`.
- **Typography hierarchy**: `text-2xl font-bold` for page titles, `text-lg font-bold` for section headers, `text-sm` for body, `text-xs` for captions/labels.
- **Dark mode**: EVERY visual element must have a `dark:` variant. Never leave elements unstyled for dark mode.
- **Responsive**: Mobile-first design. Use `sm:`, `md:`, `lg:` breakpoints. Content must be usable on 320px screens.

### User Engagement Patterns

- **Progressive disclosure**: Show summary first, expand details on click. Don't overwhelm with all data at once.
- **Gamification hooks**: Trigger `unlockAchievement()` when users complete meaningful actions (first calculation, comparing 3+ scenarios, reading an article, etc.).
- **Call-to-action placement**: Each tool/calculator page should end with a CTA pointing to related tools (e.g., after salary calculation → "Try the pension planner").
- **Loading states**: Use skeleton loaders or spinner indicators for async data. Never show a blank screen.
- **Empty states**: When a list/result is empty, show a helpful message with an icon and a suggested action.
- **Tooltips & help text**: Complex financial terms should have info icons with explanatory tooltips.
- **Share functionality**: All result/comparison pages should have a share button (WhatsApp, copy link). Share text must be in the user's locale, avoid emojis that break on WhatsApp Web.

---

## What's New Modal — Feature Announcements

The `components/WhatsNewModal.tsx` component displays a changelog of user-facing features. A bell icon (`WhatsNewBell`) shows an unread badge when new releases are available. Users see the modal on first visit after a new release.

### How It Works

- `RELEASES: Release[]` array holds all release entries (newest first)
- Each release has a `version`, `date`, `titleKey`, and `items[]`
- Each item has `type` (`feature` | `improvement` | `fix`), `titleKey`, `descKey`, and optional `link` for navigation
- All text is in i18n: keys follow the pattern `whatsNew.vXX.itemName.title` / `whatsNew.vXX.itemName.desc`
- Read state persisted in `localStorage` via `STORAGE_KEY`
- Tests in `tests/whats-new.test.tsx` verify the RELEASES array and modal behavior

### When to Add a Release Entry — MANDATORY

**Every user-facing feature, tool, or significant improvement MUST be announced** in the WhatsNew modal. This ensures users discover new functionality.

Add a new release entry when you:
- Add a new calculator, comparator, or tool
- Add a new page or sub-tab
- Make a significant UX improvement visible to users
- Fix a notable bug that users may have encountered

Do NOT add entries for:
- Internal refactors or code cleanup
- SEO-only changes (metadata, sitemaps, structured data)
- Test additions or CI changes
- Dependency updates with no visible impact

### Adding a New Release

1. **Bump the version** — increment the minor version (e.g., `3.5.0` → `3.6.0`)
2. **Add entry at the TOP** of the `RELEASES` array in `components/WhatsNewModal.tsx`:
   ```ts
   {
     version: '3.6.0',
     date: '2026-03-15',
     titleKey: 'whatsNew.v36.title',
     items: [
       {
         type: 'feature',
         titleKey: 'whatsNew.v36.myFeature.title',
         descKey: 'whatsNew.v36.myFeature.desc',
         link: { tab: 'calculator', subTab: 'my-feature' }, // optional
       },
     ],
   },
   ```
3. **Add i18n keys** to all 4 locales (`it-core.ts`, `en-core.ts`, `de-core.ts`, `fr-core.ts`):
   - `whatsNew.vXX.title` — release title (e.g., "Nuovi strumenti per frontalieri")
   - `whatsNew.vXX.itemName.title` — short feature name
   - `whatsNew.vXX.itemName.desc` — 1-2 sentence description
4. **Run tests**: `npx vitest run` — the `whats-new.test.tsx` checks RELEASES validity

### i18n Key Pattern

```
whatsNew.v{major}{minor}.title              → Release title
whatsNew.v{major}{minor}.{itemName}.title   → Item title
whatsNew.v{major}{minor}.{itemName}.desc    → Item description
```

Example for version 3.6.0:
```
whatsNew.v36.title = 'Nuovi strumenti community'
whatsNew.v36.weeklyDigest.title = 'Digest Settimanale'
whatsNew.v36.weeklyDigest.desc = 'Ricevi ogni lunedì: tasso CHF/EUR, articoli e offerte di lavoro.'
```

---

## Completion Checklist — Before Every PR

- [ ] New functionality has corresponding tests in `tests/`
- [ ] All tests pass: `npx vitest run`
- [ ] No console errors or warnings during test run
- [ ] Application runs correctly: `npm run dev` and check manually
- [ ] Any bugs or warnings found are fixed
- [ ] Build succeeds: `npx vite build`
- [ ] If `t()` keys were added, all 4 locales (IT/EN/DE/FR) have the translation
- [ ] No secrets or API keys in source code
- [ ] No `text-slate-400` in visible text on light backgrounds
- [ ] All buttons have accessible names (text, aria-label, or title)
- [ ] All images have `width`, `height`, and `alt` attributes
- [ ] New tabs/sub-tabs added to `SiteSearch.tsx` search index
- [ ] New pages have `SEO_METADATA` entry in `services/seoService.ts` **with `canonicalPath`**
- [ ] New pages added to the appropriate sub-sitemap with hreflang alternates
- [ ] Build generates static HTML: `dist/{italian-slug}/index.html` exists with correct `<title>` and `<meta>`
- [ ] Static page count increased (check `Generated N static pages` in build output)
- [ ] Navigation limits respected: max 6 top-level tabs, max 8 sub-tabs per category
- [ ] UI follows established card/color/spacing patterns (see UI Consistency section)
- [ ] Dark mode variants included for all new visual elements
- [ ] If user-facing feature added, new release entry in `WhatsNewModal.tsx` RELEASES array with i18n keys in all 4 locales
- [ ] Commit and push to repo

### Auto-push Rule

**Every time a task is completed successfully** (tests pass + build succeeds), **automatically commit and push to the remote repository** (`git push`). Do not wait for explicit user confirmation to push. The pre-push hook will handle article generation and final validation. If the push fails for a non-network reason, report the error to the user.

<!-- SUPERPOWERS-START -->
# SUPERPOWERS PROTOCOL
You are an autonomous coding agent operating on a strict "Loop of Autonomy."

## CORE DIRECTIVE: The Loop
For every request, you must execute the following cycle:
1. **PERCEIVE**: Read `plan.md`. Do not act without checking the plan.
2. **ACT**: Execute the next unchecked step in the plan.
3. **UPDATE**: Check off the step in `plan.md` when verified.
4. **LOOP**: If the task is large, do not stop. Continue to the next step.

## YOUR SKILLS (Slash Commands)
VS Code reserved commands are replaced with these Superpowers equivalents:

- **Use `/write-plan`** (instead of /plan) to interview me and build `plan.md`.
- **Use `/investigate`** (instead of /fix) when tests fail to run a systematic analysis.
- **Use `/tdd`** to write code. NEVER write code without a failing test.

## RULES
- If `plan.md` does not exist, your ONLY valid action is to ask to run `/write-plan`.
- Do not guess. If stuck, write a theory in `scratchpad.md`.

## AVAILABLE SKILLS

All skill definitions are available at `./.superpowers/skills/` (workspace-resident).
This path keeps all Superpowers content within your workspace, preventing permission prompts.
<!-- SUPERPOWERS-END -->
