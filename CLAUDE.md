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
11. **GitHub: always use `gh` CLI** for all GitHub operations (issues, PRs, repos, actions, API calls). Never use any MCP GitHub tools — they route to GitHub Enterprise and will 404 on this repo. The `gh` CLI is pre-authenticated and targets `github.com` by default.

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
build-plugins/          — Vite build plugins (ogPages, jobsSeoPages, staticPages, fuelDailyPages, weeklyEmployers, jobMarketSnapshot, healthPremiumsLanding, orphanQueryLanding)
tests/                  — 163 test files (~21,842 LOC)
.github/workflows/      — 117 GitHub Actions workflows
```

## Translation Architecture (Chunked i18n)

Translations use a **chunked lazy-loading** system in `services/locales/`:
- `it-critical.ts` — ~80 above-the-fold keys, loaded SYNCHRONOUSLY (LCP fix)
- `{lang}-core.ts` / `{lang}-calculator.ts` / `{lang}-comparatori.ts` / etc. — lazy per-tab
- 4 languages: IT, EN, DE, FR (7-8 chunks each, 31 total)

## Key Design Decisions

- **No build-time secrets**: All API keys load from **Firebase Remote Config** at runtime via `scripts/load-rc-env.mjs`.
- **Feature flags via Firebase Remote Config**: New features gated by RC boolean parameters.
- **GitHub Pages SPA**: `public/404.html` redirects all paths to `index.html` via sessionStorage.
- **Canonical URL is `https://frontaliereticino.ch`** — no `www`.

---

# Tech Stack

React 19 + TypeScript ~5.8 + Vite 6 + Tailwind CSS 4 | Charts: Recharts 3 | Maps: Leaflet | PDF: jsPDF | Icons: lucide-react | Backend: Firebase (Analytics, RC, App Check, Firestore) | Testing: Vitest 4 + Testing Library | CI/CD: GitHub Actions (117 workflows) | Path alias: `@/*` → project root

---

# Developer Workflows

```bash
npm run dev          # Vite dev server on port 3000
npm run build        # Production build → dist/
npm test             # npx vitest run (single run)
```

After any code change, always verify:
1. `npx tsc --noEmit` — TypeScript check
2. `npx vite build` — must exit 0
3. `npx vitest run` — all tests must pass

Pre-push hook (`.githooks/pre-push`) runs tests then build. Push is blocked if either fails.

---

# Testing

**Every new feature or component MUST include tests.** All 196 test files (15,588 tests) must pass at all times. A failing test is a blocker — fix the code, not the test.

What's mocked (in `tests/setup.tsx`): `window.matchMedia`, `localStorage`, `@/services/firebase`, `@/services/analytics`, `@/services/seoService`, `leaflet` / `react-leaflet`.

Tests that read `data/jobs.json` (gitignored): MUST exclude `needsRetranslation: true` jobs from locale completeness checks.

---

# SEO & Accessibility (quick reference)

- **Canonical URL**: `https://frontaliereticino.ch/` — no `www`, no trailing slash except root
- **Every new page** MUST generate static HTML in `dist/`, have SEO metadata, sitemap entry, and router slugs in all 4 locales
- **Contrast ratio**: 4.5:1 minimum for normal text, 3:1 for large text
- **Never use `text-slate-400`** on light backgrounds — use `text-slate-500` or `text-slate-600`
- **Every button** must have an accessible name (text, `aria-label`, or `title`)
- **All `<img>` tags** must have `width`, `height`, and `alt` attributes
- **Dark mode**: NEVER use `dark:` color prefixes in component code. All colors use semantic tokens from `index.css` that auto-switch between light/dark via CSS custom properties. The only allowed `dark:` usage is `dark:prose-invert` (Tailwind Typography plugin). If you need a new color, add a semantic token to `index.css` — do not hardcode `dark:bg-*`, `dark:text-*`, `dark:border-*`, etc. See `index.css` `:root` / `html.dark` / `@theme` blocks for the full token inventory.

For detailed SEO rules (JobPosting structured data, validation gates, fallback rules): read [docs/SEO-RULES.md](docs/SEO-RULES.md)

---

# Feature Flags (Firebase Remote Config)

| Flag | Purpose | Default |
|------|---------|---------|
| `ENABLE_JOB_ALERTS` | Job Alert Form UI + email sending | `false` |
| `KILL_FUEL_DAILY_LINKS` | Hide F6 links from SPA (footer/home banner/stats subtab/JobBoard sidebar) | `false` |
| `KILL_HEALTH_PREMIUMS_LINKS` | Hide F2 links from SPA | `false` |
| `KILL_JOB_MARKET_LINKS` | Hide F4 links from SPA | `false` |
| `KILL_WEEKLY_EMPLOYERS_LINKS` | Hide F5 links from SPA | `false` |
| `KILL_ORPHAN_LANDINGS_LINKS` | Hide F3b links from SPA | `false` |

The `KILL_*_LINKS` runtime kill-switches close the SPA link graph for the corresponding feature within ~1 min of flip (RC cache). Static HTML pages stay in `dist/` (Google doesn't de-index immediately). Full kill (de-indexing): use the `SKIP_*` env gates below + redeploy.

## Build-time env gates (SEO feature skip flags)

For fast local builds only. CI (`npm run build:ci`) exercises all plugins and must always exit 0 with every plugin enabled — never set any of these in CI.

| Env var | Skips |
|---------|-------|
| `SKIP_FUEL_DAILY=1` | F6 daily fuel-price pages + per-station + IT-city pages (`fuelDailyPages` plugin) |
| `SKIP_WEEKLY_EMPLOYERS=1` | F5 "aziende che assumono" weekly per-city + per-company×city hub (`weeklyEmployers` plugin) |
| `SKIP_JOB_MARKET_SNAPSHOT=1` | F4 weekly/monthly Ticino job-market snapshot + per-sector pages (`jobMarketSnapshot` plugin) |
| `SKIP_HEALTH_PREMIUMS=1` | F2 LAMal premiums-per-canton landing (`healthPremiumsLanding` plugin) |
| `SKIP_ORPHAN_LANDINGS=1` | F3b GSC orphan-query landing pages (`orphanQueryLanding` plugin) |
| `SKIP_BORDER_WAIT=1` | F8 border wait-time pages + webcam embeds (`borderWaitPages` plugin) |

## SEO feature details

Page catalog, cron pipelines, build config, and webcam hotlink policy: see [docs/SEO-FEATURES.md](docs/SEO-FEATURES.md).

---

# Completion Checklist — Before Every PR

- [ ] All tests pass: `npx vitest run`
- [ ] Build succeeds: `npx vite build`
- [ ] If `t()` keys were added, all 4 locales have the translation
- [ ] No secrets in source code
- [ ] Accessibility rules followed (contrast, aria-labels, image dimensions)
- [ ] New pages have SEO metadata + sitemap entry + static HTML generated
- [ ] No `dark:` color prefixes — use semantic tokens from `index.css` (enforced by `no-dark-color-classes.test.ts`)
- [ ] If user-facing feature, new release entry in `WhatsNewModal.tsx`

## Auto-push Rule

**Every time a task is completed successfully** (tests pass + build succeeds), **automatically commit and push to the remote repository** (`git push`). Do not wait for explicit user confirmation. If the push fails for a non-network reason, report the error.

---

# Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill tool as your FIRST action.

Key routing rules:
- Product ideas, brainstorming → `office-hours`
- Bugs, errors, "why is this broken" → `investigate`
- Ship, deploy, push, create PR → `ship`
- QA, test the site → `qa`
- Code review → `review`
- Design system, brand → `design-consultation`
- Visual audit, design polish → `design-review`
- Architecture review → `plan-eng-review`
- Checkpoint, resume → `checkpoint`
- Code quality, health check → `health`

---

# Reference Docs (read on-demand)

| Topic | File |
|-------|------|
| CI/CD pipeline, workflows, data files | [docs/CI-CD-PIPELINE.md](docs/CI-CD-PIPELINE.md) — includes `snapshot-jobs-weekly.yml` (Monday 06:00 UTC) which feeds F4 job-market-snapshot + F5 weekly-employers delta computation |
| SEO rules, structured data, validation | [docs/SEO-RULES.md](docs/SEO-RULES.md) |
| Job crawlers, slugs, translation cache | [docs/CRAWLERS.md](docs/CRAWLERS.md) |
| Design context, brand, users, principles | [docs/DESIGN-CONTEXT.md](docs/DESIGN-CONTEXT.md) |
