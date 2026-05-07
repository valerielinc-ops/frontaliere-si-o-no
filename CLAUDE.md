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
10. **Subagents inherit the current session model** — do not override the model when launching agents unless the task explicitly requires a specific model.
11. **GitHub: always use `gh` CLI** for all GitHub operations (issues, PRs, repos, actions, API calls). Never use any MCP GitHub tools — they route to GitHub Enterprise and will 404 on this repo. The `gh` CLI is pre-authenticated and targets `github.com` by default.
12. **NEVER run `send-newsletter.mjs --send` locally.** Real newsletter sends to subscribers MUST go through the `send-newsletter` GitHub Actions workflow (`gh workflow run send-newsletter.yml`). For local testing, use `--preview` (stdout, no Firebase) or `--test --target-email <email>` (sends only to that one address). Running `--send` locally bypasses the workflow guardrails and sends to all subscribers.
13. **Every NEW GitHub Actions workflow MUST be lanciato live after merge.** When a development introduces a workflow file (anything new in `.github/workflows/`), the task is NOT closed until: `gh workflow run <name>.yml --ref main` lanciato post-merge, `gh run view <id>` shows `conclusion: success`, side effects validated (committed files, Firestore payload, sitemap entries match expected shape), and any errors (auth, TOS bundle, schema parse, secret typo) fixed with commit + re-run until clean. Type-check (`tsc --noEmit`), vitest mock, Lighthouse CI, and deploy.yml DO NOT touch the custom workflow. Only live execution validates auth + endpoint + schema. Typical bug classes: User-Agent strict missing (Met.no 403), If-Modified-Since header missing, secret name typo, Firestore SA permissions, schema mismatch on real payload.
14. **Every static SSG page MUST use the SPA shell + hydration.** When a build plugin emits HTML to `dist/` (SEO landings, hub indexes, per-leaf static-overlay pages), it MUST wrap content via `build-plugins/shared/seoPageShell.ts` (`buildSeoPageHtml`). Standalone HTML without the shell renders without site nav/footer/theme/design-tokens/popup-newsletter/analytics/consent — pages look orphaned and don't React-hydrate. The helper injects `<body class="bg-surface-alt text-heading overflow-x-hidden">`, the hashed entry JS/CSS, and `<div id="root"><main>` wrapper. Plugin contract: `apply: 'build'` + `enforce: 'post'` + emit in `closeBundle()`. Pass `distDir` to every `buildSeoPageHtml` call. For body styling use Tailwind utility classes inline (`bg-surface rounded-2xl border border-edge`) — never custom class names that aren't in `index.css` (Tailwind purges them). Pair with `services/router.ts` `staticOverlay: true` so App.tsx doesn't replace the static content. Exceptions: robots.txt, llms.txt, sitemap*.xml; 404/500/503 error pages.

## Mobile-First Content Positioning

15. **75% of traffic is mobile — design and verify mobile-first.** Real visitors come on small screens; the meaty content (job listings, calculator output, comparison tables, fiscal data) must be the first interactive element after the H1. Every new page must be checked at mobile viewport (≤414px) before declaring done.
16. **Editorial/SEO filler text must NEVER push real content below the fold.** AI-generated intros, "Cosa cercare quando…" sections, marketing copy, methodology paragraphs, FAQ blocks needed for the text-to-HTML ratio gate, and similar filler MUST be either:
    - **Below the main content** (full prose at the bottom for crawlers), or
    - **Collapsed in an accordion** ("Leggi di più" toggle, expanded only on user action), or
    - **Sidebar on desktop, bottom on mobile** (responsive split — mobile always sees content first).

    Acceptable mobile layout: `H1 → 1-line tagline (≤120 chars) → real content → filler`. Forbidden: `H1 → 80-word intro → content`. This rule applies to **all new pages**: SEO landings, search clusters, comparator pages, blog articles with chart data, anything that has both filler and "ciccia" content.

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

## ⚠️ FAST_BUILD trap when verifying SEO landing pages

Agent sessions inherit `FAST_BUILD=1` from `.claude/settings.json`. With that flag,
**vite.config.ts skips every SEO plugin** in the `if (!isFastBuild)` block at
line 112 — including `nursingLandingsPlugin`, `careerLandingsPlugin`,
`professionLandingsPlugin`, `costOfLivingLandingsPlugin`, `comparisonsHubPlugin`,
`faqHubPlugin`, `frSalaireNetLandingPlugin`, `staticPagesPlugin`, etc.

**Symptom:** you edit a build plugin, run `npx vite build`, the build exits 0,
but the generated HTML in `dist/` still has the old content (no log line for
the plugin appears either). It looks like the file write is being cached or
your edit didn't take — but the plugin literally never ran.

**Fix when you need to verify SEO pages locally:** run with `FAST_BUILD=` (empty)
explicitly to override the inherited flag:

```bash
FAST_BUILD= npx vite build
```

Combine with the per-feature `SKIP_*` env gates documented above to keep the
build fast while still exercising the specific plugin you're testing
(e.g. nursing landings):

```bash
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_WEEKLY_EMPLOYERS=1 SKIP_JOB_MARKET_SNAPSHOT=1 \
SKIP_HEALTH_PREMIUMS=1 SKIP_ORPHAN_LANDINGS=1 SKIP_BORDER_WAIT=1 \
npx vite build
```

CI runs the full pipeline (`build:ci`) without FAST_BUILD, so production output
is always correct — this is only a local-verification footgun.
3. `npx vitest run` — all tests must pass

Pre-push hook (`.githooks/pre-push`) runs tests then build. Push is blocked if either fails.

**First-time setup:** run `scripts/dev/local-ignore-cron.sh apply` once to hide ~600 cron-generated files from `git status`. After that, use `scripts/dev/local-ignore-cron.sh pull` instead of `git pull` (plain pull breaks against skip-worktree files). Full rationale: [docs/LOCAL-DEV.md](docs/LOCAL-DEV.md).

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

# SEO content gate — text-to-HTML ratio

**Why it exists.** Semrush flags any page with `visibleText / totalHTML ≤ 10 %`
as "low text-to-HTML ratio". The Apr 2026 audit caught 1,193 such pages
(mostly fuel-daily, weekly-employers, health-premiums, job-board, and the SPA
shell for non-IT locales). These pages rank worse — search engines see lots of
markup wrapping very little content.

**Where it runs.** Two places:
- Local: `npm run audit:text-html-ratio` (after `npm run build`).
- CI: `Gate — text-to-HTML ratio` step in `.github/workflows/deploy.yml`,
  blocking deploy on regression.

**The gate is a ratchet.** It compares the current dist/ offender count to
`data/text-html-ratio-baseline.json` and FAILS only when any feature bucket
goes UP. Improvements (count goes down) are always accepted.

**If the gate fails, here is the playbook:**

1. Reproduce locally: `npm run build && npm run audit:text-html-ratio`. The
   stderr names which feature bucket regressed.
2. Inspect the worst offenders for that bucket:
   ```
   node scripts/audit-text-html-ratio.mjs --feature=<name> --limit=20
   ```
3. Locate the build plugin that emits those pages (one per feature):

   | Feature bucket | Plugin / source |
   |---|---|
   | `fuel-daily` | `build-plugins/fuelDailyPagesPlugin.ts` |
   | `weekly-employers` / `weekly-employers-hub` | `build-plugins/weeklyEmployersPlugin.ts` |
   | `health-premiums` | `build-plugins/healthPremiumsLandingPlugin.ts` |
   | `job-board` | `build-plugins/jobsSeoPagesPlugin.ts` |
   | `blog` | `scripts/create-article.mjs` (article generator) |
   | `spa-locale` / `spa-other` | `build-plugins/htmlTemplate.ts` + SPA prerender shell |

4. Add **coherent, page-relevant** content — never filler. Acceptable kinds:
   methodology paragraph, FAQ block, scenario walk-through tied to the
   frontaliere use case, contextual cross-references to related comparators.
   **Never** add hidden text, repeated boilerplate, or invisible spans.
   Google penalises template-wide duplication and cloaking.
5. Rebuild and rerun the audit. Once the bucket count is lower, regenerate
   the baseline so the gate locks in the new floor:
   ```
   npm run audit:text-html-ratio:rebaseline
   ```
   Commit the updated `data/text-html-ratio-baseline.json` together with the
   template change in the same PR.

**Hard rule.** The baseline numbers must only ever **decrease**. Raising any
number means new pages have dropped below the 10 % threshold — fix that, do
not ratchet up.

---

# SEO content gate — orphaned pages in sitemaps

**Why it exists.** Semrush flagged 4,936 "orphaned pages in sitemaps" — pages
listed in any sitemap-*.xml but not reachable via internal `<a href>` BFS from
the homepage. Crawlers waste budget on these pages, and they tend to rank
worse since they lack site-structure support.

**Where it runs.** Two places:
- Local: `npm run audit:orphan-sitemap-pages` (after `npm run build`).
- CI: `Gate — orphan pages in sitemaps` step in `.github/workflows/deploy.yml`,
  blocking deploy on regression.

**The gate is a ratchet.** It compares the current dist/ orphan count to
`data/orphan-pages-baseline.json` and FAILS only when any sitemap's orphan
count goes UP. Improvements (count drops) are always accepted but do NOT
auto-rebaseline; run `npm run audit:orphan-sitemap-pages:rebaseline` after
a deliberate improvement and commit the new baseline together with the fix.

**If the gate fails, here is the playbook:**

1. Reproduce locally: `npm run build && npm run audit:orphan-sitemap-pages`.
   Stdout names which sitemap regressed and shows top-10 newly-orphan URLs.
2. The cause is almost always one of:
   - **Static archive page lost an internal link** (e.g. nav widget removed).
     Fix the link source.
   - **New auto-generated content** (cron-published article/job) that no
     existing static page links to. Add a link from the relevant index
     (e.g. `/articoli-frontaliere/` → `/articoli-frontaliere/tutti/`) or
     update the archive pagination so the new content is reachable.
   - **Sitemap entry without HTML** (stale entry). Either restore the page
     or remove from the sitemap.
3. Rebuild and rerun the audit. Once the regression is gone:
   ```
   npm run audit:orphan-sitemap-pages:rebaseline
   ```
   Commit the updated baseline together with the fix in the same PR.

**Hard rule.** Per CLAUDE.md non-negotiable rule #5, **never** "fix" an
orphan by setting `noindex` without explicit approval. The default fix is
to **add internal links**.

---

# SEO content gate — ImageObject license fields

**Why it exists.** Google Search Console flags every `ImageObject` in
JSON-LD that omits any of the five licensable-image fields:
`acquireLicensePage`, `copyrightNotice`, `license`, `creator`, `creditText`.
The May 2026 audit caught 3,871 offending ImageObjects on the four-field
quartet, then a follow-up audit on 2026-05-07 caught a further wave of
"Campo mancante: creditText" warnings on Organization-logo ImageObjects
(`logo-192.png`, `logo-512.png`, `icon-512x512.png`) across blog articles,
SPA shells (de/en/fr), and SEO landing pages. Without ALL five fields the
image is ineligible for licensable-image rich results and the page surfaces
as "Migliora l'aspetto degli elementi" in GSC.

**Where it runs.** Three places:
- Helper: `services/seo/imageObjectLd.ts` — every new emitter MUST go through
  `imageObjectLd()` / `imageObjectLdDocument()`. The helper always populates
  the four fields (defaults to the site Organization as creator + the
  `/termini-di-servizio#licenza-immagini` license URL).
- Local audit: `npm run audit:image-object-license` (after a build).
  Exits 1 if any ImageObject in `dist/` is missing one of the four.
- CI: `audit:image-object-license` step in
  `.github/workflows/post-deploy-validation.yml` (capped-parallel pool with
  the other dist gates), blocking deploy on regression.
- Vitest: `tests/seo/image-object-license-fields.test.ts` runs in pre-push
  when `RUN_DIST_GATES=1` is set.

**Hard rule.** Zero tolerance — any single offending ImageObject fails the
gate. There is no ratchet/baseline because the helper makes 0 the only
acceptable count. If you need a third-party license URL (webcam feeds,
press photos), pass `license` / `creator` / `copyrightNotice` / `creditText`
overrides to `imageObjectLd()`; never strip the fields. `creditText`
defaults to the resolved `creator.name` (so third-party webcams credit the
source automatically) or `"Frontaliere Ticino"` for site-owned images.

**If the gate fails:**

1. Run `npm run audit:image-object-license` locally to see the offending
   pages, missing fields, and current keys.
2. Find the emitter — usually a build plugin or `services/seo/seo-blog*.ts`
   entry that emits an inline `'@type': 'ImageObject'` literal.
3. Either route through the helper (`imageObjectLd({ url, width, height })`)
   or, for auto-generated blog entries, regenerate via `create-article.mjs`
   which already injects the four fields.
4. For third-party images (webcams), pass explicit overrides:
   ```ts
   imageObjectLd({
     contentUrl: webcam.imageUrl,
     creator: { '@type': 'Organization', name: webcam.sourceName },
     license: webcam.license,
     copyrightNotice: `© ${webcam.sourceName}`,
   })
   ```

---

# SEO content gate — BFS depth from `/`

**Why it exists.** Real crawlers (Ahrefs, Googlebot) cap their crawl depth.
A URL only reachable at BFS depth ≥ 5 from `/` is effectively orphan from
their perspective even if our `audit:orphan-sitemap-pages` gate (which
walks transitively through "next" pagination) accepts it. The May 2026
Ahrefs audit caught 1,854 IT blog articles in this exact gap: linked from
`/articoli-frontaliere/tutti/page-3..21/` chain, passing the existing
gate, flagged orphan by Ahrefs.

**Where it runs.** Two places:
- Local: `npm run audit:max-bfs-depth` (after `npm run build`).
- CI: `audit:max-bfs-depth` step in `.github/workflows/post-deploy-validation.yml`,
  blocking deploy on regression.

**The gate is a ratchet.** It compares the current dist/ per-sitemap
"URLs at depth > MAX_DEPTH" count to `data/bfs-depth-baseline.json` and
FAILS only when any sitemap's count goes UP. Improvements (count drops)
are accepted but do NOT auto-rebaseline; run
`npm run audit:max-bfs-depth:rebaseline` after a deliberate improvement
and commit the new baseline together with the linking change.

**MAX_DEPTH** is baked into the baseline. Default is 4 (depth 0=`/`,
1=tab, 2=hub index, 3=archive page, 4=leaf URL — articles, jobs, etc.).
Running with a different `--max-depth` than the baseline refuses to
compare.

**If the gate fails, here is the playbook:**

1. Reproduce locally: `npm run build && npm run audit:max-bfs-depth`.
   Stdout names which sitemap regressed and shows the deepest URLs.
2. The cause is almost always:
   - **Compact pagination ate the link graph**: the section index links
     only `page-1, current-1, current, current+1, last` — pages 3..N-2
     end up reachable only via chained "next" clicks (depth ≥ 5). Fix:
     emit a full page navigator on the section index that links every
     `page-N` directly. See commit `aa987d38f7` for the
     `/articoli-frontaliere/` fix as a reference pattern.
   - **Hub page lost a child-list section**: e.g. `/mercato-lavoro-ticino/`
     stopped listing per-sector snapshot pages. Fix: add a child-list
     `<section>` to the hub render function so each child page is at
     depth 2 from `/`.
3. Rebuild and rerun the audit. Once the regression is gone:
   ```
   npm run audit:max-bfs-depth:rebaseline
   ```
   Commit the updated `data/bfs-depth-baseline.json` together with the
   linking change in the same PR.

**Hard rule.** Per CLAUDE.md non-negotiable rule #5, **never** "fix" a
deep URL by setting `noindex` without explicit approval. The default
fix is to **add internal links** from a hub at depth ≤ MAX_DEPTH-1.

---

# SEO content gate — `<title>` length (60 + 10 % tolerance)

**Why it exists.** Google's SERP-display budget is ~60 char on most
queries; titles past it get visually truncated or rewritten by Google,
costing keyword visibility. The May 2026 Semrush audit flagged 2 740
indexable pages above the 60-char floor — almost all with the
`" | Frontaliere Ticino"` brand suffix (22 char) appended on top of an
already-near-cap headline.

**Where it runs.**
- Helper: `build-plugins/shared/titleSuffix.ts` exports
  `TITLE_TARGET_CHARS = 60`, `TITLE_MAX_CHARS = 66` (target + 10 %
  tolerance), and `buildTitleWithBrand()`. The helper **drops the
  brand suffix** when `headline + brand > 66` instead of truncating
  mid-headline. NEVER reintroduce mid-`…` truncation: it tanked CTR on
  `/calcola-stipendio/` 4.8 % → 0.99 % during the cap=70 era.
- Local audit: `npm run audit:title-length` (after a build). Threshold
  66, per-feature ratchet against `data/title-length-baseline.json`.
- CI: `audit:title-length` step in shard 3 of
  `scripts/lib/post-build-tasks.sh`, blocking deploy on regression.

**The gate is a ratchet.** Counts can only go DOWN per feature bucket.
Improvements never auto-rebaseline; run
`npm run audit:title-length:rebaseline` after an intentional drop and
commit the new baseline together with the template change.

**Job-board exception.** `composeJobPageTitle` in
`build-plugins/jobsSeoPagesPlugin.ts` passes `JOB_TITLE_MAX = 70`
explicitly to `buildTitleWithBrand` to preserve the city-preserving
job-detail structure (job title + company + city + (#hash)
disambiguator). Job pages account for the bulk of the baseline by
design.

**If the gate fails:**

1. Reproduce locally: `FAST_BUILD= npx vite build && npm run audit:title-length`
   (FAST_BUILD env trap — see *Developer Workflows* in this file).
   Stdout names which feature bucket regressed and shows the worst
   offenders.
2. The cause is almost always:
   - **A new template added a brand-preserving caller**: a build plugin
     copied the old "always append brand and truncate" pattern instead
     of going through `buildTitleWithBrand`. Fix: route through the
     helper so the brand drops automatically.
   - **AI-generated headline drift**: blog `create-article.mjs` AI
     prompts started returning ~70-char headlines. Fix the prompt to
     target 50-60 char (see `scripts/create-article.mjs` headline
     guidance section).
   - **Cap intentionally raised**: someone bumped `TITLE_MAX_CHARS`
     past 66. Reject — never widen the cap to mute the audit.
3. Rebuild and rerun. Once regression cleared:
   ```
   npm run audit:title-length:rebaseline
   ```

---

# SEO content gate — `(#hash)` disambiguator visible in `<title>`

**Why it exists.** When two articles produce the same base `<title>`,
the og-pages plugin appends a runtime disambiguator
(`build-plugins/ogPagesPlugin.ts:articleHashFromSlug`). The disambiguator
prefers a HUMAN-READABLE token (year `(2026)`, known city
`— Bellinzona`, trailing slug word) and falls back to an FNV-1a
8-hex hash `(#abcd1234)` only as last resort. The May 2026 Semrush audit
caught **935 IT blog pages** with the hash visible in SERP — kills CTR
and brand perception. Goal: drive the count to 0 by deduping at source.

**Where it runs.**
- Local: `npm run audit:title-no-disambig-hash` (after a build). Greps
  `dist/` for `\(#[0-9a-f]{8}\)` inside `<title>`. Per-feature ratchet
  vs `data/title-no-disambig-hash-baseline.json`.
- CI: shard 3 of `scripts/lib/post-build-tasks.sh`.
- Preventive: `scripts/create-article.mjs:optimizeSeoMetadata` checks
  the new article's IT title against existing `blog-meta-it.ts` titles
  AT CREATE TIME and auto-appends year/city to the headline if a
  collision is detected. Hard-fails (per CLAUDE.md rule #1) when
  year+city are insufficient — the author must manually add a more
  specific qualifier (source, sub-topic, edition) to `content.it.title`.

**If the gate fails:**

1. Reproduce: `FAST_BUILD= npx vite build && npm run audit:title-no-disambig-hash`.
   Stdout shows offending pages with their hash and base title.
2. Find the colliding pair: grep `services/locales/blog-meta-it.ts`
   for the base title (without the brand suffix). Two articles with
   the same `'.title'` value will be the cause.
3. Fix at source by editing one article's `'.title'` in all four
   locale meta files (`blog-meta-{it,en,de,fr}.ts`). Add a year, city,
   or source qualifier that makes the title self-explaining
   (e.g. `"Primo Maggio a Varese"` →
   `"Primo Maggio a Varese 2026: corteo CGIL"`). NEVER widen the
   `audit:title-no-disambig-hash` baseline as a workaround — the
   ratchet only goes DOWN.
4. Rebuild and rerun. Once gone:
   ```
   npm run audit:title-no-disambig-hash:rebaseline
   ```

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
- [ ] Text-to-HTML ratio gate passes: `npm run audit:text-html-ratio` (see *SEO content gate* above for the playbook on regression)
- [ ] ImageObject license-fields gate passes: `npm run audit:image-object-license` (zero tolerance — every ImageObject in JSON-LD must have `acquireLicensePage`, `copyrightNotice`, `license`, `creator`, `creditText`; route through `services/seo/imageObjectLd.ts`)
- [ ] BFS-depth gate passes: `npm run audit:max-bfs-depth` (per-sitemap ratchet — every URL must be reachable from `/` at BFS depth ≤ 4 via `<a href>` chain. Fix regressions by adding internal links from a hub at depth ≤ 3, never noindex)
- [ ] Title-length gate passes: `npm run audit:title-length` (per-feature ratchet at threshold 66 = 60 SERP-display target + 10 % tolerance. `buildTitleWithBrand` drops the brand suffix when headline + brand > 66 instead of truncating mid-headline. Never re-introduce mid-`…` truncation — it tanked CTR on `/calcola-stipendio/` 4.8 % → 0.99 % during the 70-cap era)
- [ ] Title-no-disambig-hash gate passes: `npm run audit:title-no-disambig-hash` (per-feature ratchet — flags `(#abcdef12)` disambiguators visible in `<title>`. Fix at source by renaming colliding articles with a year/city/source qualifier so the base title is unique without the hash, never widen the cap)

## Auto-push Rule

**Every time a task is completed successfully** (tests pass + build succeeds), **automatically commit and push to the remote repository** (`git push`). Do not wait for explicit user confirmation. If the push fails for a non-network reason, report the error.

## Auto-merge Rule (orchestrator mode)

When operating in orchestrator mode (parallel agents dispatching tasks via worktrees), the agent is **pre-authorized** to:
- Merge open PRs into `main` without explicit human review, provided CI is green
- Delete merged feature branches and their worktrees
- Drop or apply git stashes left over from completed work
- Merge stale-but-useful branches and clean up the rest, leaving only `main` in a working state

This authorization is durable across sessions and overrides the default "confirm before destructive shared-state actions" guardrail for these specific operations only. All other destructive actions (force push, history rewrite, dropping tables, deleting prod data) still require explicit confirmation.

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
| Local dev hygiene (hide cron noise from `git status`) | [docs/LOCAL-DEV.md](docs/LOCAL-DEV.md) — `scripts/dev/local-ignore-cron.sh` |
| Build-plugin cache experiment (why we tried it, why we removed it) | [docs/CACHE-EXPERIMENT.md](docs/CACHE-EXPERIMENT.md) — `assemble-jobs` cache stays; plugin-level cache cost ~11 min/deploy more than fresh regen |
