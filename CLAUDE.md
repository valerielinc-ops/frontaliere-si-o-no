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
13. **Every NEW GitHub Actions workflow MUST be lanciato live after merge.** When a development introduces a workflow file (anything new in `.github/workflows/`), the task is NOT closed until: `gh workflow run <name>.yml --ref main` lanciato post-merge, `gh run view <id>` shows `conclusion: success`, side effects validated (committed files, Firestore payload, sitemap entries match expected shape), and any errors fixed with commit + re-run until clean. Type-check, vitest mock, Lighthouse CI, and deploy.yml DO NOT touch the custom workflow. Only live execution validates auth + endpoint + schema. Typical bug classes: User-Agent strict missing (Met.no 403), If-Modified-Since header missing, secret name typo, Firestore SA permissions, schema mismatch on real payload.
14. **Every static SSG page MUST use the SPA shell + hydration.** When a build plugin emits HTML to `dist/` (SEO landings, hub indexes, per-leaf static-overlay pages), it MUST wrap content via `build-plugins/shared/seoPageShell.ts` (`buildSeoPageHtml`). Standalone HTML without the shell renders without site nav/footer/theme/design-tokens/popup-newsletter/analytics/consent. The helper injects `<body class="bg-surface-alt text-heading overflow-x-hidden">`, the hashed entry JS/CSS, and `<div id="root"><main>` wrapper. Plugin contract: `apply: 'build'` + `enforce: 'post'` + emit in `closeBundle()`. Pass `distDir` to every `buildSeoPageHtml` call. For body styling use Tailwind utility classes inline — never custom class names that aren't in `index.css` (Tailwind purges them). Pair with `services/router.ts` `staticOverlay: true` so App.tsx doesn't replace the static content. **CRITICAL — Tailwind scan:** `tailwind.config.js` `content` array MUST include `./build-plugins/**/*.{js,ts}` (added 2026-05-07). Without this, Tailwind purges utilities and pages render unstyled. Test post-deploy with curl + Playwright snapshot. Exceptions: robots.txt, llms.txt, sitemap*.xml; 404/500/503 error pages.

## Mobile-First Content Positioning

15. **75% of traffic is mobile — design and verify mobile-first.** Real visitors come on small screens; the meaty content (job listings, calculator output, comparison tables, fiscal data) must be the first interactive element after the H1. Every new page must be checked at mobile viewport (≤414px) before declaring done.
16. **Editorial/SEO filler text must NEVER push real content below the fold.** AI-generated intros, "Cosa cercare quando…" sections, marketing copy, methodology paragraphs, FAQ blocks needed for the text-to-HTML ratio gate, and similar filler MUST be either:
    - **Below the main content** (full prose at the bottom for crawlers), or
    - **Collapsed in an accordion** ("Leggi di più" toggle, expanded only on user action), or
    - **Sidebar on desktop, bottom on mobile** (responsive split — mobile always sees content first).

    Acceptable mobile layout: `H1 → 1-line tagline (≤120 chars) → real content → filler`. Forbidden: `H1 → 80-word intro → content`. Applies to all new pages.

17. **SEO-landing UI/UX template — every static page emitted by a build plugin MUST follow this layout in this order:**

    1. `<nav>` breadcrumb
    2. `<header>`: eyebrow line · H1 · LEDE = **1-line tagline ≤120 chars** (NOT a 60-word intro with all the numbers — those go into the tiles below)
    3. **Stats tile grid** (3-5 tiles) right after the header, using only the shared OKLCH semantic tokens from `build-plugins/shared/seoContentTokens.ts`: `STAT_TILE_ACCENT` (headline metric), `STAT_TILE_SUCCESS` (good/cheap/improving), `STAT_TILE_WARNING` (moderate/yellow), `STAT_TILE_DANGER` (bad/expensive/regressing), `STAT_TILE_BASE` (neutral). **Never inline `background-color`/`border-color` hex values** — every tile binds to `var(--color-*-subtle)` + `var(--color-*-border)`.
    4. **"Consiglio" / actionable banner** (when applicable — when the page has data that translates into a recommendation): same `STAT_TILE_*` styling reused, with `<aside data-*-advice>` and a 1-2 sentence interpretation. Examples already shipped: border-wait `data-bw-advice`, health-premiums `data-hp-advice`, weekly-employers `data-we-advice`, fuel-daily editorial review.
    5. **Primary CTA** (link to comparator / job-board / calculator / next page in the funnel) immediately under the tile area, **above the fold on mobile**. Style: `CTA_PRIMARY_STYLE` from `seoContentTokens.ts`.
    6. The actual data area (table, list of cards, ranking, …)
    7. **Long prose** (intro paragraph, methodology, frontaliere context, FAQ): **always below the action area**. The text content is preserved for the Semrush text-to-HTML ratio gate but it never pushes the data below the mobile fold.

    **No new color values, ever.** If you need a colour, it must already exist as a `--color-*` token in `index.css`. The 5 tile variants + accent/link/heading/body/subtle covers every case shipped today.

    **Reference commits** for the canonical implementation: `2f845817eb` (border-wait), `74866f13b4` (health-premiums leaf), `cfde4aca6c` (weekly-employers city), `26421ccb6c` (fuel-daily root). Read those diffs before adding a new SEO landing.

---

# Project Overview

**Frontaliere Ticino** is an Italian-language React SPA that helps Swiss-Italian cross-border workers ("frontalieri") compare the financial impact of living in Switzerland (Permit B) vs commuting from Italy (Permit G). It covers fiscal simulation, pension planning, health insurance, currency exchange, transport costs, job board, and more.

- **Live site**: GitHub Pages — `https://frontaliereticino.ch` (no `www`)
- **Primary language**: Italian (UI and domain), with i18n support for EN/DE/FR
- **Domain context**: Swiss/Italian tax law (2026 New Agreement), LAMal health insurance, AVS/LPP pensions, CHF-EUR exchange
- **Task management**: Linear (team "Frontaliere Ticino")
- **Crawler scope**: as of 2026-05-10 the cathedral expansion covers **all 26 Swiss cantons** (was TI/GR/VS only). Per-canton URL architecture + slug-registry frozen URLs + canton-quorum gate. See [docs/CATHEDRAL-IMPLEMENTATION-PLAN.md](docs/CATHEDRAL-IMPLEMENTATION-PLAN.md) and [docs/CATHEDRAL-ROLLBACK.md](docs/CATHEDRAL-ROLLBACK.md).

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

**First-time setup:** run `scripts/dev/local-ignore-cron.sh apply` once to hide ~600 cron-generated files from `git status`. After that, use `scripts/dev/local-ignore-cron.sh pull` instead of `git pull`. Full rationale: [docs/LOCAL-DEV.md](docs/LOCAL-DEV.md).

## ⚠️ FAST_BUILD trap when verifying SEO landing pages

Agent sessions inherit `FAST_BUILD=1` from `.claude/settings.json`. With that flag, `vite.config.ts` skips every SEO plugin in the `if (!isFastBuild)` block — including `nursingLandingsPlugin`, `careerLandingsPlugin`, `professionLandingsPlugin`, `costOfLivingLandingsPlugin`, `comparisonsHubPlugin`, `faqHubPlugin`, `frSalaireNetLandingPlugin`, `staticPagesPlugin`, etc.

**Symptom:** edit a build plugin, run `npx vite build`, exits 0, but generated HTML in `dist/` still has old content (no log line for the plugin appears) — the plugin literally never ran.

**Fix.** Override the inherited flag explicitly:

```bash
FAST_BUILD= npx vite build
```

Combine with per-feature `SKIP_*` env gates to keep the build fast while exercising one plugin:

```bash
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_WEEKLY_EMPLOYERS=1 SKIP_JOB_MARKET_SNAPSHOT=1 \
SKIP_HEALTH_PREMIUMS=1 SKIP_ORPHAN_LANDINGS=1 SKIP_BORDER_WAIT=1 \
npx vite build
```

CI runs full pipeline (`build:ci`) without FAST_BUILD, so production output is always correct — this is only a local-verification footgun.

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
- **Dark mode**: NEVER use `dark:` color prefixes in component code. All colors use semantic tokens from `index.css` that auto-switch via CSS custom properties. Only allowed `dark:` usage is `dark:prose-invert` (Tailwind Typography). If you need a new color, add a semantic token to `index.css` — do not hardcode `dark:bg-*`, `dark:text-*`, etc.

For detailed SEO rules (JobPosting structured data, validation gates, fallback rules): [docs/SEO-RULES.md](docs/SEO-RULES.md).

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

Page catalog, cron pipelines, build config, and webcam hotlink policy: [docs/SEO-FEATURES.md](docs/SEO-FEATURES.md).

---

# SEO Content Gates (per-PR)

Every PR must pass these per-feature ratchet audits. Each gate has a baseline (`data/*-baseline.json`) that can only go DOWN. **Never widen a baseline as a workaround. Never noindex without explicit per-URL approval (CLAUDE.md non-negotiables #1, #5).** Full playbooks per gate: [docs/SEO-GATES.md](docs/SEO-GATES.md).

| Gate | Audit script | Where it runs | Baseline |
|---|---|---|---|
| Text-to-HTML ratio (≥10 %) | `npm run audit:text-html-ratio` | `deploy.yml` | `data/text-html-ratio-baseline.json` |
| Orphan pages in sitemaps | `npm run audit:orphan-sitemap-pages` | `deploy.yml` | `data/orphan-pages-baseline.json` |
| ImageObject license fields (zero tolerance) | `npm run audit:image-object-license` | `post-deploy-validation.yml` | none — must be 0 |
| BFS depth ≤ 4 from `/` | `npm run audit:max-bfs-depth` | `post-deploy-validation.yml` | `data/bfs-depth-baseline.json` |
| `<title>` length ≤ 66 (60 + 10 % tolerance) | `npm run audit:title-length` | `post-build-tasks.sh` shard 3 | `data/title-length-baseline.json` |
| `(#hash)` disambiguator visible in `<title>` | `npm run audit:title-no-disambig-hash` | `post-build-tasks.sh` shard 3 | `data/title-no-disambig-hash-baseline.json` |

Each audit has a matching `:rebaseline` script (e.g. `npm run audit:title-length:rebaseline`). After a deliberate improvement, run rebaseline and commit the new baseline together with the fix in the same PR.

**Critical context for `<title>`:** never reintroduce mid-`…` truncation — it tanked CTR on `/calcola-stipendio/` 4.8 % → 0.99 % during the cap=70 era. The `buildTitleWithBrand()` helper (`build-plugins/shared/titleSuffix.ts`) drops the brand suffix instead. Job-board exception: `composeJobPageTitle` uses `JOB_TITLE_MAX = 70` for city + (#hash) disambiguator structure.

**Critical context for ImageObject:** every emitter MUST go through `services/seo/imageObjectLd.ts`. For third-party images (webcams), pass `license` / `creator` / `copyrightNotice` / `creditText` overrides; never strip fields.

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
- [ ] All 6 SEO content gates pass (see table above + [docs/SEO-GATES.md](docs/SEO-GATES.md))

## Auto-push Rule

**Every time a task is completed successfully** (tests pass + build succeeds), **automatically commit and push to the remote repository** (`git push`). Do not wait for explicit user confirmation. If the push fails for a non-network reason, report the error.

## Worktree-First Rule (parallel-agent safety)

This repo is regularly worked on by **multiple parallel agents** sharing the same primary working tree, plus a local cron that touches 600+ files (see `scripts/dev/local-ignore-cron.sh`). Stashing the working tree to unblock `git pull --rebase` is unsafe: it silently captures other agents' WIP into a stash that may never be popped → lost work + orphan stashes.

**Always isolate non-trivial work in its own git worktree before starting**, in either of these cases:
1. You're about to make changes that will require `git commit && git push` (i.e. anything beyond pure reading/analysis), AND
2. Either (a) the working tree already has unstaged changes that aren't yours, OR (b) you may be running alongside other agents, OR (c) the local cron is active.

In practice this means: at the start of any code-modification task, call `EnterWorktree` to spawn a fresh worktree on a new branch. Do all edits, commits, and pushes there. When done, open a PR (or merge via orchestrator mode) and `ExitWorktree`.

**Never use `git stash -u` blanket** to unblock a rebase on the shared tree — it captures foreign WIP. If you must rebase on the shared tree, enable `git config rebase.autoStash true` (atomic stash+rebase+pop, surfaces conflicts explicitly) and stage only your own files before rebasing.

When dispatching parallel subagents via the `Agent` tool, **always pass `isolation: "worktree"`** so each agent runs in its own isolated copy of the repo. The harness auto-cleans empty worktrees and returns path+branch for ones with commits.

Exceptions (no worktree needed): pure read/grep/research turns, single-file doc tweaks the user explicitly scopes to "in place", and the orchestrator session itself (which spawns the worktrees for its children).

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
| CI/CD pipeline, workflows, data files | [docs/CI-CD-PIPELINE.md](docs/CI-CD-PIPELINE.md) — includes `snapshot-jobs-weekly.yml` (Mon 06:00 UTC) feeding F4 + F5 |
| SEO rules, structured data, validation | [docs/SEO-RULES.md](docs/SEO-RULES.md) |
| SEO content gate playbooks (6 ratchets) | [docs/SEO-GATES.md](docs/SEO-GATES.md) |
| SEO feature catalog (F2/F3b/F4/F5/F6/F8) | [docs/SEO-FEATURES.md](docs/SEO-FEATURES.md) |
| Job crawlers, slugs, translation cache | [docs/CRAWLERS.md](docs/CRAWLERS.md) |
| Cathedral CH-wide expansion master plan | [docs/CATHEDRAL-IMPLEMENTATION-PLAN.md](docs/CATHEDRAL-IMPLEMENTATION-PLAN.md) |
| Cathedral rollback runbook | [docs/CATHEDRAL-ROLLBACK.md](docs/CATHEDRAL-ROLLBACK.md) |
| Design context, brand, users, principles | [docs/DESIGN-CONTEXT.md](docs/DESIGN-CONTEXT.md) |
| Local dev hygiene (hide cron noise) | [docs/LOCAL-DEV.md](docs/LOCAL-DEV.md) |
| GitNexus code-intelligence MCP guide | [docs/GITNEXUS.md](docs/GITNEXUS.md) |
| Build-plugin cache experiment | [docs/CACHE-EXPERIMENT.md](docs/CACHE-EXPERIMENT.md) |

---

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **frontaliere-si-o-no** (27977 symbols, 59764 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/frontaliere-si-o-no/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/frontaliere-si-o-no/context` | Codebase overview, check index freshness |
| `gitnexus://repo/frontaliere-si-o-no/clusters` | All functional areas |
| `gitnexus://repo/frontaliere-si-o-no/processes` | All execution flows |
| `gitnexus://repo/frontaliere-si-o-no/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
