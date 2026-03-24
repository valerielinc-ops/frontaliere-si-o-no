# NON-NEGOTIABLE RULES

These directives have the highest priority. No exceptions, workarounds, or "temporary solutions" may bypass them.

## Zero Tolerance on Quality

1. **NEVER lower quality thresholds, test tolerances, or validation criteria** as a workaround to pass a build or test. If a test fails, fix the root cause.
2. **NEVER downgrade errors to warnings** to unblock a deploy or pipeline. If something is an error, it stays an error until the underlying problem is fixed.
3. **All mandatory SEO parameters must always be present** on every job page in every locale: `baseSalary`, `postalCode`, `streetAddress`, `title`, `description`, `datePosted`, `hiringOrganization.name`, `jobLocation`. If source data is missing, generate defaults — do not remove the check.
4. **Never accept thin content** (pages with <50 words in the body) as an acceptable solution. Every indexed page must have real content.

## Problem-Solving Approach

5. **Fix the root cause, not a workaround.** If a validation blocks the deploy, investigate why the data is non-conforming — do not disable the validation.
6. **If a test fails, the test is right until proven otherwise.** Do not modify the test to make it pass — fix the code the test verifies.
7. **If a parameter is documented as mandatory, it stays mandatory.** Do not make it optional for convenience.

## Workflow & Process

8. **Use Playwright for end-to-end tests**, not preview tools. Build + serve dist + Playwright.
9. **Linear tasks must reflect reality**: if a task is partially completed, close it and create a follow-up for what's missing.
10. **Always launch subagents with `model: "opus"`** (Claude Opus 4.6, max effort, 1M context). Never use Sonnet or Haiku for subagents — they need full codebase understanding and maximum reasoning capability.

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
| PWA | vite-plugin-pwa + Workbox | Offline support |
| Testing | Vitest 4 + Testing Library + jsdom | Separate `vitest.config.ts` |
| CI/CD | GitHub Actions (117 workflows) | Deploy to GitHub Pages |
| Task Management | Linear | Team "Frontaliere Ticino" |

---

# CI/CD & Workflows

## Deploy Pipeline

Push to `main` → `deploy.yml` → Load RC secrets → Assemble jobs dataset → Build → Validate JobPosting rich results → Deploy to GitHub Pages → Post-deploy actions (Facebook, LinkedIn, Google Indexing).

**Critical**: The validation step (`validate-jobs-rich-results-sample.mjs`) blocks deploy if ANY job page is missing mandatory structured data. This is intentional — see Rule #3.

## Workflow Categories (117 total)

| Category | Count | Trigger | Deploy trigger |
|----------|-------|---------|---------------|
| Deploy | 1 | push to main + dispatch | N/A (IS the deploy) |
| Article generation | 1 | cron (30min) | `trigger-deploy.sh` ✅ |
| Job crawlers | 103 | dispatch (via orchestrator) | `trigger-deploy.sh` (via `git-commit-data.sh`) ✅ |
| Crawler orchestrator | 1 | cron (2x/day) | Dispatches individual crawlers |
| Fuel prices | 1 | cron (hourly) | `trigger-deploy.sh` (local, needs push) |
| Traffic/border | 1 | cron (every 15min peak) | **MISSING** — needs implementation |
| Unemployment rate | 1 | cron (monthly) | `trigger-deploy.sh` ✅ |
| Newsletter | 1 | manual dispatch | No push needed |
| Job alerts | 1 | cron (daily) | Feature-flagged |
| Analytics/SEO | 3 | cron (weekly) | No deploy needed (internal data) |
| Other (relocalize, cleanup, parsers) | 3 | cron/dispatch | No deploy needed |

### GITHUB_TOKEN Limitation

Pushes made with the default `GITHUB_TOKEN` **do not trigger other workflows** (GitHub anti-loop rule). Workflows that push data and need a deploy must call `scripts/lib/trigger-deploy.sh` which uses the `GITHUB_PAT` (from Firebase Remote Config) to fire a `workflow_dispatch` event on `deploy.yml`.

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

Every active job page in every locale MUST have valid `JobPosting` JSON-LD with ALL fields:
- **Required**: `title`, `description`, `datePosted`, `hiringOrganization.name`, `jobLocation`
- **Mandatory (enforced as errors)**: `baseSalary`, `postalCode`, `streetAddress`

The validation script `scripts/validate-jobs-rich-results-sample.mjs` enforces this at deploy time. **Do not weaken it.**

Bridge/redirect pages for non-IT locales (detected by `__BRIDGE_TARGET_SLUG__` or `URL legacy`) are treated as warnings, not errors — but active job pages in all locales MUST have full JSON-LD.

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
