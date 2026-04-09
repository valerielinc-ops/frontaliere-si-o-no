# NON-NEGOTIABLE RULES

These directives have the highest priority. No exceptions, workarounds, or "temporary solutions" may bypass them.

## Zero Tolerance on Quality

1. **NEVER lower quality thresholds, test tolerances, or validation criteria** as a workaround to pass a build or test. If a test fails, fix the root cause.
2. **NEVER downgrade errors to warnings** to unblock a deploy or pipeline. If something is an error, it stays an error until the underlying problem is fixed.
3. **All mandatory SEO parameters must always be present** on every job page in every locale: `baseSalary`, `postalCode`, `streetAddress`, `title`, `description`, `datePosted`, `hiringOrganization.name`, `jobLocation`, `employmentType`. If source data is missing, generate defaults — do not remove the check.
4. **Never accept thin content** (pages with <50 words in the body) as an acceptable solution. Every indexed page must have real content.

## Problem-Solving Approach

5. **Fix the root cause, not a workaround.** If a validation blocks the deploy, investigate why the data is non-conforming — do not disable the validation.
6. **If a test fails, the test is right until proven otherwise.** Do not modify the test to make it pass — fix the code the test verifies.
7. **If a parameter is documented as mandatory, it stays mandatory.** Do not make it optional for convenience.

## Workflow & Process

8. **Use Playwright for end-to-end tests**, not preview tools. Build + serve dist + Playwright.
9. **Linear tasks must reflect reality**: if a task is partially completed, close it and create a follow-up for what's missing.
10. **Always launch subagents with `model: "opus"`** (Claude Opus 4.6, max effort, 1M context). Never use Sonnet or Haiku for subagents — they need full codebase understanding and maximum reasoning capability.
11. **GitHub: always use `gh` CLI** for all GitHub operations (issues, PRs, repos, actions, API calls). Never use any MCP GitHub tools (`github-*`, `github-mcp-server-*`) — they route to GitHub Enterprise and will 404 on this repo. The `gh` CLI is pre-authenticated and targets `github.com` by default. Examples: `gh pr list`, `gh issue create`, `gh api repos/{owner}/{repo}`, `gh run list`.

---

# Project Overview

**Frontaliere Ticino** is an Italian-language React SPA that helps Swiss-Italian cross-border workers ("frontalieri") compare the financial impact of living in Switzerland (Permit B) vs commuting from Italy (Permit G). It covers fiscal simulation, pension planning, health insurance, currency exchange, transport costs, job board, and more.

- **Live site**: GitHub Pages — `https://frontaliereticino.ch` (no `www`)
- **Primary language**: Italian (UI and domain), with i18n support for EN/DE/FR
- **Domain context**: Swiss/Italian tax law (2026 New Agreement), LAMal health insurance, AVS/LPP pensions, CHF-EUR exchange
- **Task management**: Linear (team "Frontaliere Ticino")

---

# Architecture

## Single-file SPA — No Router Library

There is **no React Router**. All routing is hand-rolled in `services/router.ts`:

- `App.tsx` holds **all navigation state** as local `useState` hooks (no Redux, no Context, no Zustand).
- URL paths use locale-aware slugs: Italian has no prefix (`/comparatori/cambio-valuta`), others get `/{lang}/...` (`/en/comparators/currency-exchange`).
- Navigation: `pushRoute(route)` calls `history.pushState`; `popstate` listener re-parses URL.

**Navigation Limits — HARD CAPS**

| Level | Max | Enforcement |
|-------|-----|-------------|
| Top-level nav tabs | **6** | Do NOT add a 7th. New sections go as sub-tabs or footer-only links. |
| Sub-tabs per category | **8** | Before adding, verify the category isn't full. |

The 6 top-level tabs are fixed: **Calcolatore**, **Confronti**, **Fisco**, **Guida**, **Vita**, **Statistiche**. Additional tabs (`blog`, `job-board`, `forum`, `profile`, etc.) are accessible via footer links, search, or deep links only.

## Project Structure

```
App.tsx                 — Root component. All state lives here. ~2700 lines.
components/             — 116 React components across subdirectories
services/               — 40 service modules (stateless, exported functions)
  i18n.ts               — Translation orchestrator (lazy chunk loading)
  router.ts             — URL routing, slug tables, path building/parsing
  calculationService.ts — Swiss-Italian fiscal simulation engine
  firebase.ts           — Firebase init, Remote Config, App Check
  jobAlertService.ts    — Firestore CRUD for job alerts (feature-flagged)
  seoService.ts         — Meta tag management
scripts/                — 170+ Node.js scripts for CI/CD, crawling, data generation
  lib/                  — Shared infrastructure (ai-models, crawler-common, trigger-deploy)
data/                   — 34+ JSON data files (jobs, fuel prices, translations cache)
build-plugins/          — Vite build plugins (ogPages, jobsSeoPages, staticPages)
tests/                  — 163 test files (~21,842 LOC)
.github/workflows/      — 117 GitHub Actions workflows
```

## Translation Architecture (Chunked i18n)

Translations are **NOT inline in a single file**. They use a **chunked lazy-loading** system:

```
services/locales/
  it-critical.ts          — ~80 above-the-fold keys, loaded SYNCHRONOUSLY in main bundle
  {lang}-core.ts          — Core UI strings (nav, consent, CTA, footer)
  {lang}-calculator.ts    — Calculator tab translations
  {lang}-comparatori.ts   — Comparators tab
  {lang}-fisco.ts         — Tax/fiscal tab
  {lang}-guide.ts         — Guide tab
  {lang}-stats.ts         — Statistics tab
  {lang}-vita.ts          — Life tab
  blog-meta-{lang}.ts     — Blog article metadata
  blog-body/{lang}/       — Per-article body content (lazy per article)
```

- 4 languages: IT, EN, DE, FR (7-8 chunks each, 31 total)
- `it-critical.ts` is imported synchronously to avoid the 3s skeleton delay on mobile (LCP fix)
- Other chunks load lazily per-tab via `loadTabTranslations()`

## Key Design Decisions

- **No build-time secrets**: All API keys load from **Firebase Remote Config** at runtime via `scripts/load-rc-env.mjs`. `.env` only has non-sensitive Firebase project config.
- **Feature flags via Firebase Remote Config**: New features (e.g., Job Alerts) are gated by RC boolean parameters that can be toggled without deploy.
- **GitHub Pages SPA**: `public/404.html` redirects all paths to `index.html` via sessionStorage.
- **Canonical URL is `https://frontaliereticino.ch`** — no `www`. All references in code, workflows, and sitemaps must use this form.

---

# Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Framework | React 19 | Function components + hooks only |
| Language | TypeScript ~5.8 | `@/*` path alias → project root |
| Bundler | Vite 6 | Dev on port 3000 |
| Styling | Tailwind CSS 4 | Dark mode via class strategy |
| Charts | Recharts 3 | ComparisonChart, ResultsView |
| Maps | Leaflet + react-leaflet | TicinoCompanies, border crossings |
| PDF | jsPDF + jspdf-autotable | Client-side report generation |
| Icons | lucide-react | Tree-shakeable |
| Backend | Firebase (Analytics, Remote Config, App Check, Firestore) | No custom server |
| Testing | Vitest 4 + Testing Library + jsdom | Separate `vitest.config.ts` |
| CI/CD | GitHub Actions (117 workflows) | Deploy to GitHub Pages |
| Task Management | Linear | Team "Frontaliere Ticino" |

---

# CI/CD & Workflows

## Job Crawler Pipeline — Full End-to-End Flow

The job board runs a **5-stage asynchronous pipeline**. Each stage is a separate GitHub Actions workflow. Understanding this pipeline is critical before touching any crawler, translation, or data file.

```
06:00 UTC ── cleanup-stale-jobs ──────────────────────────────────────────────────────
            Daily: remove 60+ day old jobs + dead URLs (per-slice URL validation)

08:00 / 20:00 UTC ── orchestrate-crawlers ────────────────────────────────────────────
            Discovers and volume-staggered-dispatches ~96 crawler workflows

08:xx–10:xx UTC ── update-jobs-{slug} (×96, concurrent) ─────────────────────────────
            Each crawler: crawl → write slice → scoped housekeeping → commit
            (skip_ai_translation=1: no AI calls, marks needsRetranslation=true)

12:00 UTC (or after orchestrate) ── translate-pending ────────────────────────────────
            Assemble dataset → AI-translate all pending jobs → validate completeness
            If validation passes: trigger deploy via GITHUB_PAT

            └─► deploy.yml ───────────────────────────────────────────────────────────
                Reassemble → validate → Vite build (~16k static pages) → validate
                → GitHub Pages → post-deploy indexing (Google, Bing, IndexNow)
```

For detailed pipeline stage documentation (Stages 1-5, GITHUB_TOKEN rules, step timeouts, Retry-After caps), see [docs/CI-CD-PIPELINE.md](docs/CI-CD-PIPELINE.md).

### Workflow Categories (117 total)

| Category | Count | Trigger | Deploy trigger |
|----------|-------|---------|---------------|
| Deploy | 1 | push to main + dispatch | N/A (IS the deploy) |
| Article generation | 1 | cron (30min) | `trigger-deploy.sh` ✅ |
| Job crawlers | 103 | dispatch (via orchestrator) | **None** — translate-pending handles it |
| Crawler orchestrator | 1 | cron (2x/day) | Dispatches crawlers |
| Crawler translation | 1 | workflow_run + cron | `trigger-deploy.sh` ✅ |
| Crawler cleanup | 1 | cron (daily 06:00) | None (runs before orchestration) |
| Fuel prices | 1 | cron (hourly) | `trigger-deploy.sh` ✅ |
| Traffic/border | 1 | cron (every 15min peak) | **MISSING** — needs implementation |
| Unemployment rate | 1 | cron (monthly) | `trigger-deploy.sh` ✅ |
| Newsletter | 1 | manual dispatch | No push needed |
| Job alerts | 1 | cron (daily) | Feature-flagged |
| Analytics/SEO | 3 | cron (weekly) | No deploy needed (internal data) |

---

### Key Data Files

| File/Directory | Written by | Purpose |
|---|---|---|
| `data/jobs/by-crawler/{slug}.json` | Individual crawlers + translate-pending | Per-crawler slice: active jobs |
| `data/jobs/expired/by-crawler/{slug}.json` | Cleanup + crawlers | Expired jobs for SEO soft-landings |
| `data/jobs.json` + `public/data/jobs.json` | Assemble step (translate-pending + deploy) | Monolithic global dataset |
| `data/translation-cache/{slug}.json` | Crawlers + translate-pending | SHA256-keyed AI translation cache (~90% hit rate) |
| `data/slug-registry.json` | Assemble step | Fingerprint → slug mapping for canonical URLs (immutable once written) |
| `data/jobs-crawler-config.json` | Assemble step | Crawler configuration registry |

---

### Slug Lifecycle & SEO Continuity

When a job's slug changes (via relocalize or hardenJobLocaleFields), the old slug is preserved in `previousSlugs[]` on the job object. The build plugin (`jobsSeoPagesPlugin`) uses `previousSlugs` to generate **bridge pages** (canonical redirect pages) so old indexed URLs don't 404.

When a job is **deleted**, the expired entry captures `slugByLocale` + `previousSlugs`. The build plugin indexes both current + previous slugs from expired entries in `expiredBySlug`, ensuring all old URLs get **enriched soft-landing pages** (title, company, salary visible) rather than generic 404 pages.

---

## Build Plugins (14)

| Plugin | Purpose |
|--------|---------|
| `prepareOutDirPlugin` | Clean dist/ safely (handles ENOBUFS with 40K+ files) |
| `buildIdPlugin` | Inject build ID and commit hash |
| `asyncCssPlugin` | Optimize CSS loading priority |
| `preloadLocalePlugin` | Preload locale chunks |
| `ogPagesPlugin` | Static OG landing pages for 524 blog articles |
| `jobsSeoPagesPlugin` | Static SEO pages: 548 company pages, 4396 job pages, 9507 expired soft-landings |
| `staticPagesPlugin` | Static pages for all sitemap URLs (~2431 pages) |

> **Note**: `public/sitemap-jobs.xml` is a seed file with a small initial set of URLs. The complete job sitemap (4000+ URLs covering all job pages, company pages, editorial landings, and expired soft-landings) is regenerated at every build by `jobsSeoPagesPlugin`. The static file in the repo reflects only the baseline and should not be used for manual SEO audits.
| `sitemapAliasPlugin` | Sitemap routing aliases |
| `legacyRedirectsPlugin` | Legacy URL redirects (1270+ compat pages) |
| `llmsTxtPlugin` | Generate llms.txt for AI crawlers |
| `adminDataPlugin` | Copy data files to dist/ |
| `crawlerRegistryPlugin` | Export crawler adapter registry |
| `localeJobsSplitPlugin` | Split job data by locale |

---

# Developer Workflows

## Commands

```bash
npm run dev          # Vite dev server on port 3000
npm run build        # Production build → dist/
npm run preview      # Preview production build
npm test             # npx vitest run (single run)
npm run test:watch   # npx vitest (watch mode)
```

## Build Verification

After any code change, always verify:
1. **TypeScript**: `npx tsc --noEmit`
2. **Build**: `npx vite build` — must exit 0
3. **Tests**: `npx vitest run` — all 163 test files must pass

## Pre-push Hook

`.githooks/pre-push` runs `npm test` then `npx vite build --logLevel error`. Push is blocked if either fails.

---

# Testing

## Structure

- **163 test files**, ~21,842 LOC
- **80+ crawler/parser tests**: one per company
- **Core tests**: i18n, router, auth, app-smoke
- **Feature tests**: jobs, newsletter, gamification, analytics
- **SEO tests**: completeness, soft-landing, structured data
- **Post-build tests**: no-secrets, no-js-redirects

## Testing Rules

**Every new feature or component MUST include tests.**

1. Write tests in `tests/` directory
2. Run `npx vitest run` — all must pass
3. Build: `npx vite build` — must succeed
4. Fix bugs before proceeding

## What's Mocked (in `tests/setup.tsx`)

- `window.matchMedia`, `localStorage` (in-memory)
- `@/services/firebase`, `@/services/analytics`, `@/services/seoService`
- `leaflet` / `react-leaflet`

## Tests Must Always Pass

**All 196 test files (15,588 tests) must pass at all times.** A failing test is a blocker — fix the code, not the test. No exceptions, no "pre-existing failures", no threshold adjustments to make tests green.

Tests that read `data/jobs.json` (gitignored, generated by `assemble-jobs-dataset.mjs`):
- Tests MUST exclude `needsRetranslation: true` jobs from locale completeness checks — these are in the translation pipeline queue, not bugs.
- Do NOT run `assemble-jobs-dataset.mjs` during debugging unless you intend to update the local dataset.

---

# SEO & Indexing

## Canonical URL

**Always use `https://frontaliereticino.ch/`** — no `www`, no trailing slash (except root). All sitemaps, hreflang, JSON-LD, and workflow scripts must use this form.

## Static Page Generation

This is a client-side SPA. Without static HTML, Google sees an empty `<div id="root">`. The build pipeline generates **~16,000+ static HTML files** via Vite plugins:

- `ogPagesPlugin` — 524 blog article pages
- `jobsSeoPagesPlugin` — 4396 active job pages + 9507 expired soft-landings + 548 company pages + 211 search pages
- `staticPagesPlugin` — 2431 content pages

**Every new page MUST generate a static HTML file in `dist/`.** If it doesn't, it will NOT be indexed.

## JobPosting Structured Data — ZERO TOLERANCE

Every active job page in every locale MUST have valid `JobPosting` JSON-LD with ALL fields. **Even "optional" fields must always be present using defaults/fallbacks — missing them is a deploy-blocking error.**

### Required fields (Google minimum for rich results)
`title`, `description`, `datePosted`, `hiringOrganization.name`, `jobLocation`

### Mandatory fields enforced as deploy-blocking errors
`baseSalary`, `postalCode`, `streetAddress`, `employmentType`

### Fallback rules — when source data is missing, generate defaults (never omit):
- **`baseSalary`**: Use `minValue: 41080, currency: CHF, unitText: YEAR` (Ticino minimum wage)
- **`postalCode`**: Use `6900` (Lugano) if lookup fails
- **`streetAddress`**: Use `addressLocality` value as fallback
- **`employmentType`**: Default to `OTHER` if contract type unknown
- **`jobLocation`**: Default to `addressLocality: Ticino, addressRegion: TI, addressCountry: CH`
- **`description`**: Use locale fallback chain (locale → Italian → raw description); skip JobPosting entirely if result < 30 chars

### Applies to all page types:
- Active job pages (all 4 locales) — validated by `validate-jobs-rich-results-sample.mjs`
- Expired job soft-landing pages — same rules apply, generate defaults
- Bridge pages (non-IT locale redirects, `__BRIDGE_TARGET_SLUG__`) — treated as warnings, not errors

### SPA runtime schema (JobBoard.tsx):
- The `JobBoard` component dynamically injects `JobPosting` JSON-LD via `useEffect`
- Same rules apply: description fallback chain, baseSalary always present
- Jobs with description < 30 chars must be excluded from the schema graph entirely

The validation script `scripts/validate-jobs-rich-results-sample.mjs` enforces this at deploy time. **Do not weaken it. `employmentType` is an error, not a warning.**

### Dataset schema (statistics pages):
Every `Dataset` schema.org block MUST include `description` and `creator` fields. These are validated by Google and missing fields appear in Search Console as warnings. All new Dataset schemas must follow the pattern used in `jobsObservatory` and `livability` entries in `seo-pages.ts`.

## Page-Level SEO Requirements (deploy-blocking)

Every static HTML page MUST have:
- **Exactly 1 `<h1>` tag** — not 0, not 2+. H1 must not be empty or inside `<noscript>`.
- **Valid `lang` attribute** on the `<html>` tag matching the page locale (`it`, `en`, `de`, `fr`).
- **Valid schema markup** — all `<script type="application/ld+json">` blocks must be parseable JSON with no conflicting primary schemas on the same object. BreadcrumbList is supplementary and can coexist with any primary schema.
- **Meta viewport** — `<meta name="viewport">` must be present.

These are enforced by `scripts/validate-page-seo-quality.mjs` at deploy time.

## SEO Checklist for New Pages

1. Add `SEO_METADATA` entry in `services/seoService.ts` with `canonicalPath`
2. Add to appropriate sitemap with hreflang for all 4 locales + x-default
3. Add router slugs in all 4 locale `SlugTable` objects
4. Verify static HTML generated: `dist/{slug}/index.html` exists with correct `<title>` and `<meta>`
5. Add to `SiteSearch.tsx` search index

---

# PageSpeed & Accessibility

- **Contrast ratio**: 4.5:1 minimum for normal text, 3:1 for large text
- **Never use `text-slate-400`** on light backgrounds — use `text-slate-500` or `text-slate-600`
- **Every button** must have an accessible name (text, `aria-label`, or `title`)
- **All `<img>` tags** must have `width`, `height`, and `alt` attributes
- **Dark mode**: EVERY visual element must have a `dark:` variant
- **LCP**: Italian critical translations loaded synchronously via `it-critical.ts` — no skeleton gate

---

# Job Crawlers

## Architecture

- **103 dedicated crawlers**, one per company
- Each has: workflow (`update-jobs-{slug}.yml`), script (`scripts/update-{slug}-jobs.mjs`), parser (`scripts/lib/{slug}-job-parser.mjs`)
- Shared infrastructure in `scripts/lib/dedicated-crawler-common.mjs` (~2000 lines)
- AI translation via `scripts/lib/ai-models.mjs` with Firestore-backed scoring, 429 tracking, and multi-model fallback chain

## Slug Stability — Jaccard Token Similarity

**Never regenerate slugs unconditionally on every crawl run.** Minor title wording changes (e.g. "per la Ricerca" → "di ricerca") must NOT produce a new slug, as this orphans the old indexed URL and creates an endless `previousSlugs` chain.

**The correct check** is `isSlugStable(existingSlug, newSlug)` exported from `dedicated-crawler-common.mjs`. It uses Jaccard token similarity (threshold 0.80) to distinguish minor wording from genuinely different roles:

- Tokenizes slug into meaningful words (filters stop words: IT/EN/DE/FR connectives)
- Computes `|intersection| / |union|` — ≥ 0.80 → keep existing slug
- Fallback: if either slug has < 4 meaningful tokens, uses 4-token prefix match

**Why not 50-char prefix?** The prefix heuristic has two failure modes:
1. False negative: different roles that share a long common prefix get merged
2. False positive: em-dash vs hyphen variations or reordered words produce a new slug unnecessarily

Only **USI, SUPSI, LIS** had real ongoing slug churn. Other crawlers either fill-only or have their own guards. When auditing a new crawler, check whether it unconditionally regenerates slugs — it should use `isSlugStable()` instead.

## Translation Cache (SHA256)

- `data/translation-cache/{company-slug}.json` stores translated titles/descriptions
- Hash-based skip: if `SHA256(title|description)` matches cache and <30 days old, skip AI call
- ~90% cache hit rate after first run
- Jobs with `needsRetranslation: true` flag bypass cache and get priority

## Crawler Orchestration

`orchestrate-crawlers.yml` dispatches all 103 crawlers with volume-based staggering:
- Large (>50 jobs): 300s delay
- Medium (10-50 jobs): 60s delay
- Small (<10 jobs): 30s delay

---

# Feature Flags (Firebase Remote Config)

New features are gated by boolean parameters in Firebase Remote Config:

| Flag | Purpose | Default |
|------|---------|---------|
| `ENABLE_JOB_ALERTS` | Job Alert Form UI + email sending | `false` |

To test a feature: set the flag to `true` in Firebase Console → refresh the page. To disable: set back to `false`. No deploy needed.

---

# Structured Data Completeness

## Validation Gate

`scripts/validate-structured-data-completeness.mjs` runs at deploy time and **blocks deploy** (exit 1) if any structured data schema has missing or invalid mandatory fields. It samples pages across all types: active jobs, expired soft-landings, company pages, statistics, and blog.

## Rules

### Dataset schemas (statistics pages)

Every `Dataset` JSON-LD block MUST include:
- `description` — non-empty string describing the dataset
- `creator` — `{ "@type": "Organization", "name": "...", "url": "..." }`

Dataset schemas MUST be emitted as **top-level** JSON-LD objects (separate `<script type="application/ld+json">` blocks), NOT nested inside a WebPage's `about` property. Google does not reliably extract nested Dataset schemas.

### JobPosting schemas (all job page types)

Every `JobPosting` JSON-LD block MUST include ALL of:
- `title`, `description` (>= 30 chars), `datePosted`, `hiringOrganization.name`
- `employmentType` — fallback to `OTHER` if unknown
- `jobLocation.address` with `addressLocality`, `postalCode`, `streetAddress` — all with fallbacks
- `baseSalary` with `currency`, `value.minValue`, `value.unitText` — fallback to Ticino minimum wage (CHF 41,080/year)

This applies to:
- Active job pages (all 4 locales)
- Expired job soft-landing pages
- Bridge pages (previousSlugs redirects) — validated but treated as warnings, not errors
- SPA runtime schema injection (JobBoard.tsx `@graph`)

### Future schema additions

When adding any new schema.org type, include ALL fields from Google's documentation for that type. Check Google Search Console's documentation for the specific rich result type. Every field marked "Required" or "Recommended" by Google MUST be present with a fallback value.

---

# Completion Checklist — Before Every PR

- [ ] All tests pass: `npx vitest run`
- [ ] Build succeeds: `npx vite build`
- [ ] If `t()` keys were added, all 4 locales have the translation
- [ ] No secrets in source code
- [ ] Accessibility rules followed (contrast, aria-labels, image dimensions)
- [ ] New pages have SEO metadata + sitemap entry + static HTML generated
- [ ] Dark mode variants included
- [ ] If user-facing feature, new release entry in `WhatsNewModal.tsx`

## Auto-push Rule

**Every time a task is completed successfully** (tests pass + build succeeds), **automatically commit and push to the remote repository** (`git push`). Do not wait for explicit user confirmation. If the push fails for a non-network reason, report the error.

---

# Superpowers Skills (`.agents/skills/`)

This project uses the **Superpowers** skill system. 103 skills are available in `.agents/skills/`. Skills are invoked via the `Skill` tool in Claude Code — never read skill files directly with the Read tool.

**If there is even a 1% chance a skill applies, invoke it before acting.**

## Key Skills for This Project

| Skill | When to use |
|-------|-------------|
| `brainstorm` | **Before any creative work** — creating features, building components, modifying behavior |
| `tdd` | **Before writing implementation code** — write failing test first |
| `write-plan` | When you have specs/requirements for a multi-step task |
| `execute-plan` | When executing a written implementation plan |
| `verify` | **Before claiming work is complete** — run verification commands, confirm output |
| `review` | When completing tasks or before merging — verify work meets requirements |
| `receive-review` | When receiving code review feedback — technical rigor before implementing suggestions |
| `investigate` | When tests fail — systematic root cause analysis |
| `finish-branch` | When implementation is complete and tests pass — decide merge/PR/cleanup |
| `dispatch-agents` | When facing 2+ independent tasks that can run in parallel |
| `worktree` | When starting feature work that needs isolation from current workspace |
| `subagent-dev` | When executing plans with independent tasks in the current session |
| `search-first` | When exploring the codebase — search before acting |
| `write-skill` | When creating or editing skills |
| `security-review` | When reviewing code for security issues |
| `e2e-testing` | When writing end-to-end tests |

## Marketing & SEO Skills (for content/SEO tasks)

`seo-audit`, `ai-seo`, `schema-markup`, `programmatic-seo`, `content-strategy`, `page-cro`, `analytics-tracking`, `site-architecture`, `copywriting`, `article-writing`

## Skill Priority

1. **Process skills first** (brainstorm, investigate, tdd) — determine HOW to approach
2. **Implementation skills second** (frontend-patterns, e2e-testing) — guide execution

"Build X" → brainstorm first, then implementation skills.
"Fix this bug" → investigate first, then domain-specific skills.

---

# Design Context

## Users
A mix of three overlapping audiences:
- **Stressed decision-makers**: People facing a major life/career decision (move to Switzerland vs. commute from Italy). High stakes, need clarity, confidence, and trust in the numbers.
- **Curious researchers**: Casually exploring options, not yet committed. Need to be engaged and informed without overwhelm.
- **Daily tool users**: Frontalieri who already decided and use the app as a recurring reference for calculations, exchange rates, and job hunting.

All three need: clear information hierarchy, trustworthy data presentation, and a sense that this tool was built for *them* specifically.

## Brand Personality
**Smart companion** — modern fintech energy (helpful, friendly, slightly playful) meets domain credibility. Think Revolut meets a Swiss tax consultant. Not corporate cold, not community-forum casual — confidently approachable.

Three-word personality: **Precise. Warm. Trustworthy.**

## Aesthetic Direction
**Mediterranean warmth** — lean into the Italian side of the Swiss-Italian identity. Push toward:
- Warmer neutral tones (not pure slate/gray — subtle warm undertones)
- Friendlier, more expressive typography (custom fonts, not system defaults)
- Breathing room and progressive disclosure to combat density
- Richer visual hierarchy so longer pages feel navigable, not overwhelming

**Anti-references**: Avoid pure "Swiss banking" coldness, avoid AI slop (cyan-on-dark, purple gradients, hero metric cards, identical card grids).

## Design Principles
1. **Clarity first** — Every page should have one clear job. When content is dense, use progressive disclosure, not compression.
2. **Warm precision** — Numbers and data deserve clean structure; the surrounding chrome should feel human, not clinical.
3. **Legible hierarchy** — Font size range should be wider; `text-xs` should be reserved for metadata, not primary content.
4. **Breathe** — Generous spacing between sections; tighter grouping within them. Rhythm > uniformity.
5. **Italian warmth, Swiss rigor** — The brand lives at the intersection. Neither purely cold nor purely expressive.
 vs hyphen variations or reordered words produce a new slug unnecessarily

Only **USI, SUPSI, LIS** had real ongoing slug churn. Other crawlers either fill-only or have their own guards. When auditing a new crawler, check whether it unconditionally regenerates slugs — it should use `isSlugStable()` instead.

## Translation Cache (SHA256)

- `data/translation-cache/{company-slug}.json` stores translated titles/descriptions
- Hash-based skip: if `SHA256(title|description)` matches cache and <30 days old, skip AI call
- ~90% cache hit rate after first run
- Jobs with `needsRetranslation: true` flag bypass cache and get priority

## Crawler Orchestration

`orchestrate-crawlers.yml` dispatches all 103 crawlers with volume-based staggering:
- Large (>50 jobs): 300s delay
- Medium (10-50 jobs): 60s delay
- Small (<10 jobs): 30s delay

---

# Feature Flags (Firebase Remote Config)

New features are gated by boolean parameters in Firebase Remote Config:

| Flag | Purpose | Default |
|------|---------|---------|
| `ENABLE_JOB_ALERTS` | Job Alert Form UI + email sending | `false` |

To test a feature: set the flag to `true` in Firebase Console → refresh the page. To disable: set back to `false`. No deploy needed.

---

# Structured Data Completeness

## Validation Gate

`scripts/validate-structured-data-completeness.mjs` runs at deploy time and **blocks deploy** (exit 1) if any structured data schema has missing or invalid mandatory fields. It samples pages across all types: active jobs, expired soft-landings, company pages, statistics, and blog.

## Rules

### Dataset schemas (statistics pages)

Every `Dataset` JSON-LD block MUST include:
- `description` — non-empty string describing the dataset
- `creator` — `{ "@type": "Organization", "name": "...", "url": "..." }`

Dataset schemas MUST be emitted as **top-level** JSON-LD objects (separate `<script type="application/ld+json">` blocks), NOT nested inside a WebPage's `about` property. Google does not reliably extract nested Dataset schemas.

### JobPosting schemas (all job page types)

Every `JobPosting` JSON-LD block MUST include ALL of:
- `title`, `description` (>= 30 chars), `datePosted`, `hiringOrganization.name`
- `employmentType` — fallback to `OTHER` if unknown
- `jobLocation.address` with `addressLocality`, `postalCode`, `streetAddress` — all with fallbacks
- `baseSalary` with `currency`, `value.minValue`, `value.unitText` — fallback to Ticino minimum wage (CHF 41,080/year)

This applies to:
- Active job pages (all 4 locales)
- Expired job soft-landing pages
- Bridge pages (previousSlugs redirects) — validated but treated as warnings, not errors
- SPA runtime schema injection (JobBoard.tsx `@graph`)

### Future schema additions

When adding any new schema.org type, include ALL fields from Google's documentation for that type. Check Google Search Console's documentation for the specific rich result type. Every field marked "Required" or "Recommended" by Google MUST be present with a fallback value.

---

# Completion Checklist — Before Every PR

- [ ] All tests pass: `npx vitest run`
- [ ] Build succeeds: `npx vite build`
- [ ] If `t()` keys were added, all 4 locales have the translation
- [ ] No secrets in source code
- [ ] Accessibility rules followed (contrast, aria-labels, image dimensions)
- [ ] New pages have SEO metadata + sitemap entry + static HTML generated
- [ ] Dark mode variants included
- [ ] If user-facing feature, new release entry in `WhatsNewModal.tsx`

## Auto-push Rule

**Every time a task is completed successfully** (tests pass + build succeeds), **automatically commit and push to the remote repository** (`git push`). Do not wait for explicit user confirmation. If the push fails for a non-network reason, report the error.

---

# Superpowers Skills (`.agents/skills/`)

This project uses the **Superpowers** skill system. 103 skills are available in `.agents/skills/`. Skills are invoked via the `Skill` tool in Claude Code — never read skill files directly with the Read tool.

**If there is even a 1% chance a skill applies, invoke it before acting.**

## Key Skills for This Project

| Skill | When to use |
|-------|-------------|
| `brainstorm` | **Before any creative work** — creating features, building components, modifying behavior |
| `tdd` | **Before writing implementation code** — write failing test first |
| `write-plan` | When you have specs/requirements for a multi-step task |
| `execute-plan` | When executing a written implementation plan |
| `verify` | **Before claiming work is complete** — run verification commands, confirm output |
| `review` | When completing tasks or before merging — verify work meets requirements |
| `receive-review` | When receiving code review feedback — technical rigor before implementing suggestions |
| `investigate` | When tests fail — systematic root cause analysis |
| `finish-branch` | When implementation is complete and tests pass — decide merge/PR/cleanup |
| `dispatch-agents` | When facing 2+ independent tasks that can run in parallel |
| `worktree` | When starting feature work that needs isolation from current workspace |
| `subagent-dev` | When executing plans with independent tasks in the current session |
| `search-first` | When exploring the codebase — search before acting |
| `write-skill` | When creating or editing skills |
| `security-review` | When reviewing code for security issues |
| `e2e-testing` | When writing end-to-end tests |

## Marketing & SEO Skills (for content/SEO tasks)

`seo-audit`, `ai-seo`, `schema-markup`, `programmatic-seo`, `content-strategy`, `page-cro`, `analytics-tracking`, `site-architecture`, `copywriting`, `article-writing`

## Skill Priority

1. **Process skills first** (brainstorm, investigate, tdd) — determine HOW to approach
2. **Implementation skills second** (frontend-patterns, e2e-testing) — guide execution

"Build X" → brainstorm first, then implementation skills.
"Fix this bug" → investigate first, then domain-specific skills.

---

# Design Context

## Users
A mix of three overlapping audiences:
- **Stressed decision-makers**: People facing a major life/career decision (move to Switzerland vs. commute from Italy). High stakes, need clarity, confidence, and trust in the numbers.
- **Curious researchers**: Casually exploring options, not yet committed. Need to be engaged and informed without overwhelm.
- **Daily tool users**: Frontalieri who already decided and use the app as a recurring reference for calculations, exchange rates, and job hunting.

All three need: clear information hierarchy, trustworthy data presentation, and a sense that this tool was built for *them* specifically.

## Brand Personality
**Smart companion** — modern fintech energy (helpful, friendly, slightly playful) meets domain credibility. Think Revolut meets a Swiss tax consultant. Not corporate cold, not community-forum casual — confidently approachable.

Three-word personality: **Precise. Warm. Trustworthy.**

## Aesthetic Direction
**Mediterranean warmth** — lean into the Italian side of the Swiss-Italian identity. Push toward:
- Warmer neutral tones (not pure slate/gray — subtle warm undertones)
- Friendlier, more expressive typography (custom fonts, not system defaults)
- Breathing room and progressive disclosure to combat density
- Richer visual hierarchy so longer pages feel navigable, not overwhelming

**Anti-references**: Avoid pure "Swiss banking" coldness, avoid AI slop (cyan-on-dark, purple gradients, hero metric cards, identical card grids).

## Design Principles
1. **Clarity first** — Every page should have one clear job. When content is dense, use progressive disclosure, not compression.
2. **Warm precision** — Numbers and data deserve clean structure; the surrounding chrome should feel human, not clinical.
3. **Legible hierarchy** — Font size range should be wider; `text-xs` should be reserved for metadata, not primary content.
4. **Breathe** — Generous spacing between sections; tighter grouping within them. Rhythm > uniformity.
5. **Italian warmth, Swiss rigor** — The brand lives at the intersection. Neither purely cold nor purely expressive.

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
