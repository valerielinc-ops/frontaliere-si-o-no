# NON-NEGOTIABLE RULES

Highest priority. No exceptions, workarounds, or "temporary solutions" bypass these.

## Zero Tolerance on Quality

1. **NEVER lower quality thresholds, test tolerances, or validation criteria** to pass a build/test. Fix the root cause.
2. **NEVER downgrade errors to warnings** to unblock a deploy. Errors stay errors until fixed.
3. **All mandatory SEO parameters must be present** on every job page in every locale: `baseSalary`, `postalCode`, `streetAddress`, `title`, `description`, `datePosted`, `hiringOrganization.name`, `jobLocation`, `employmentType`. Missing data → generate defaults, never remove the check.
4. **Never accept thin content** (<50 words body). Every indexed page must have real content.

## Problem-Solving Approach

5. **Fix the root cause, not a workaround.** If a validation blocks deploy, fix the data — don't disable the validation.
6. **If a test fails, the test is right until proven otherwise.** Fix the code, not the test.
7. **If a parameter is documented as mandatory, it stays mandatory.** No "optional for convenience".

## Workflow & Process

8. **Use Playwright for E2E**, not preview tools. Build + serve dist + Playwright.
9. **Linear tasks reflect reality**: partial completion → close + create follow-up.
10. **Subagents inherit the session model** — don't override unless the task explicitly requires it.
11. **GitHub: always `gh` CLI.** Never MCP GitHub tools (they route to Enterprise, 404 here). `gh` is pre-authenticated to github.com.
12. **NEVER run `send-newsletter.mjs --send` locally.** Real sends go through `send-newsletter.yml`. Local testing: `--preview` (stdout) or `--test --target-email <email>`.
13. **Every NEW GitHub Actions workflow MUST be run live after merge.** Task not closed until `gh workflow run <name>.yml --ref main` succeeds, side effects validated (committed files, Firestore, sitemap), errors fixed + re-run clean. Type-check / vitest mock / CI do NOT validate the workflow itself — only live execution validates auth + endpoint + schema. Typical bugs: missing UA (Met.no 403), missing If-Modified-Since, secret typo, SA permissions, schema mismatch.
14. **Every static SSG page MUST use the SPA shell + hydration.** Build plugins emitting HTML to `dist/` MUST wrap content via `build-plugins/shared/seoPageShell.ts` (`buildSeoPageHtml`). Standalone HTML loses nav/footer/theme/tokens/popup-newsletter/analytics/consent. Plugin contract: `apply: 'build'` + `enforce: 'post'` + emit in `closeBundle()`, pass `distDir` to every call. Body styling uses Tailwind utility classes inline only (no custom classes — Tailwind purges them). **`tailwind.config.js` `content` MUST include `./build-plugins/**/*.{js,ts}`** (added 2026-05-07) or utilities are purged. Exceptions: robots.txt, llms.txt, sitemap*.xml, error pages (404/500/503).

    **SPA-over-static handoff:** static body = crawler-facing fallback. User vs SPA driven by `services/router.ts`:
    - `parsePath(url).route.staticOverlay === true` → no SPA equivalent (fuel-daily, weekly-employers, health-premiums, border-wait, jobs-observatory, cost-of-living, salary-hub long-tail, `seoLanding` aliases). App.tsx skips React `<main>`; static body owns the page; nav + sub-tabs + footer hydrate.
    - `parsePath(url).route` resolves to a real sub-tab AND ships a static fallback → App.tsx renders React `<main>` AND `useEffect` hides `main.seo-static-content`. End users get the interactive view; crawlers get static HTML.

    Do NOT re-introduce DOM-based heuristics for `main.seo-static-content` — `hooks/useNavigationState.ts` reads `staticOverlay` from the router only. Regression coverage: `tests/app-lite-shell.test.tsx`, `tests/router.test.ts`.

## Mobile-First Content Positioning

15. **75% of traffic is mobile — design and verify mobile-first.** Meaty content (listings, calc output, tables, fiscal data) must be the first interactive element after H1. Verify ≤414px before declaring done.
16. **Editorial/SEO filler must NEVER push real content below the fold.** AI intros, "Cosa cercare…", methodology, FAQ for text-to-HTML gate must be:
    - **Below the main content**, or
    - **Collapsed in an accordion** ("Leggi di più"), or
    - **Sidebar on desktop, bottom on mobile**.

    OK: `H1 → 1-line tagline (≤120c) → real content → filler`. Forbidden: `H1 → 80-word intro → content`.

17. **SEO-landing UI/UX template — every static page emitted by a build plugin MUST follow this order:**

    1. `<nav>` breadcrumb
    2. `<header>`: eyebrow · H1 · LEDE = 1-line tagline ≤120c (NOT a 60-word intro; numbers go in tiles)
    3. **Stats tile grid** (3-5 tiles) using only `build-plugins/shared/seoContentTokens.ts` tokens: `STAT_TILE_ACCENT` / `SUCCESS` / `WARNING` / `DANGER` / `BASE`. Never inline hex; bind to `var(--color-*-subtle)` + `var(--color-*-border)`.
    4. **"Consiglio" banner** (when applicable): same tile styling, `<aside data-*-advice>`, 1-2 sentence interpretation.
    5. **Primary CTA** above mobile fold. Style: `CTA_PRIMARY_STYLE`.
    6. Data area (table, cards, ranking).
    7. **Long prose** (intro, methodology, FAQ): always below the action area.

    **No new color values, ever.** Use existing `--color-*` tokens in `index.css`. Reference commits: `2f845817eb` (border-wait), `74866f13b4` (health-premiums), `cfde4aca6c` (weekly-employers), `26421ccb6c` (fuel-daily).

18. **Every dedicated crawler MUST key merge on stable-id, not source URL.** Vendor APIs (PwC/Workday/Prospective/Greenhouse) rewrite slugs while keeping UUIDs. URL-keyed `jobMatchKey` treats rename as delete+add → old slug falls out, soft-landing takes over → live job becomes "Offerta non più disponibile".

    - Use `extractStableJobId(job.url)` from `scripts/lib/job-match-key.mjs`.
    - When slug changes, push prior slugs into `previousSlugs` + `previousSlugsByLocale` so the build emits a bridge page.
    - Truncate via `truncateSlugAtWordBoundary` from `scripts/lib/slug-truncate.mjs`, never `.slice(0, MAX)` raw.
    - Reference: PR #161 (2026-05-13). Full context: `project_seo_rename_drift_may13.md`.

19. **SEO automation moratorium until 7-day GSC avg position ≤ 7.5.** No new build-plugin SEO landings (`build-plugins/*Landing*.ts`, `*Pages.ts`, `*Hub.ts`, or expansions) while `data/gsc-position-rolling.json` shows 7d avg > 7.5. **Exempt:** bug fixes (no new files), consolidation refactors that NET-REDUCE pages, redirect/bridge emitters, `JobOrphanBridgePlugin` variants. CI gate: `scripts/refresh-gsc-position-rolling.mjs` + `scripts/check-seo-moratorium.mjs` in `deploy.yml`. Do NOT lower the threshold (rule #1).

---

# Project Overview

**Frontaliere Ticino** — Italian-language React SPA helping Swiss-Italian cross-border workers compare Permit B (live in CH) vs Permit G (commute from IT). Covers fiscal simulation, pension, health insurance, FX, transport, jobs.

- **Live**: `https://frontaliereticino.ch` (no `www`) on GitHub Pages
- **Primary language**: Italian; i18n for EN/DE/FR
- **Domain**: Swiss/Italian tax law (2026 New Agreement), LAMal, AVS/LPP, CHF-EUR
- **Tasks**: Linear ("Frontaliere Ticino")
- **Crawler scope** (since 2026-05-10): all 26 Swiss cantons. See [docs/CATHEDRAL-IMPLEMENTATION-PLAN.md](docs/CATHEDRAL-IMPLEMENTATION-PLAN.md), [docs/CATHEDRAL-ROLLBACK.md](docs/CATHEDRAL-ROLLBACK.md).

---

# Architecture

## Single-file SPA — No Router Library

No React Router. Routing hand-rolled in `services/router.ts`:
- `App.tsx` holds all nav state as local `useState` (~2700 lines, no Redux/Context/Zustand).
- Locale-aware slugs: Italian = no prefix; others = `/{lang}/...`.
- `pushRoute(route)` → `history.pushState`; `popstate` re-parses URL.

**Navigation HARD CAPS:**

| Level | Max |
|-------|-----|
| Top-level nav tabs | **6** (Calcolatore, Confronti, Fisco, Guida, Vita, Statistiche — fixed) |
| Sub-tabs per category | **8** |

`blog`, `job-board`, `forum`, `profile` etc. → footer/search/deep links only.

## Project Structure

```
App.tsx          — Root, all state (~2700 lines)
components/      — 116 React components
services/        — 40 stateless modules (i18n, router, calculationService, firebase, jobAlertService, seoService)
scripts/         — 170+ Node scripts (CI/CD, crawlers, data gen)
  lib/           — Shared (ai-models, crawler-common, trigger-deploy)
data/            — 34+ JSON files
build-plugins/   — Vite build plugins (ogPages, jobsSeoPages, staticPages, fuelDailyPages, weeklyEmployers, jobMarketSnapshot, healthPremiumsLanding, orphanQueryLanding)
tests/           — 163 files (~21,842 LOC)
.github/workflows/ — 117 workflows
```

## Translations (Chunked i18n)

In `services/locales/`:
- `it-critical.ts` — ~80 above-the-fold keys, SYNC load (LCP fix)
- `{lang}-core.ts` / `-calculator.ts` / `-comparatori.ts` — lazy per-tab
- 4 langs (IT/EN/DE/FR), 7-8 chunks each, 31 total

## Key Decisions

- **No build-time secrets** — Firebase Remote Config at runtime via `scripts/load-rc-env.mjs`.
- **GitHub Pages SPA** — `public/404.html` redirects to `index.html` via sessionStorage.
- **Canonical URL** — `https://frontaliereticino.ch` (no `www`).

---

# Tech Stack

React 19 + TS ~5.8 + Vite 6 + Tailwind 4 | Recharts 3 | Leaflet | jsPDF | lucide-react | Firebase (Analytics/RC/App Check/Firestore) | Vitest 4 + Testing Library | GitHub Actions (117 workflows) | Path alias: `@/*` → root

---

# Developer Workflows

```bash
npm run dev    # Vite dev on :3000
npm run build  # → dist/
npm test       # vitest run
```

**First-time setup:** `scripts/dev/local-ignore-cron.sh apply` (hides ~600 cron files from git status). Then `scripts/dev/local-ignore-cron.sh pull` instead of `git pull`. See [docs/LOCAL-DEV.md](docs/LOCAL-DEV.md).

## ⚠️ FAST_BUILD trap

Agent sessions inherit `FAST_BUILD=1` from `.claude/settings.json` → `vite.config.ts` skips all SEO plugins. Symptom: edit a plugin, `npx vite build` exits 0, but `dist/` HTML still old.

Override:
```bash
FAST_BUILD= npx vite build
```

Keep other plugins skipped:
```bash
FAST_BUILD= SKIP_FUEL_DAILY=1 SKIP_WEEKLY_EMPLOYERS=1 SKIP_JOB_MARKET_SNAPSHOT=1 \
SKIP_HEALTH_PREMIUMS=1 SKIP_ORPHAN_LANDINGS=1 SKIP_BORDER_WAIT=1 \
npx vite build
```

CI (`build:ci`) never uses FAST_BUILD.

---

# Testing

**Every new feature/component MUST include tests.**

Mocked in `tests/setup.tsx`: `window.matchMedia`, `localStorage`, `@/services/firebase`, `@/services/analytics`, `@/services/seoService`, `@/services/posthog`, `leaflet` / `react-leaflet`.

Tests reading `data/jobs.json` (gitignored): MUST exclude `needsRetranslation: true` from locale checks.

## CI gate: `.github/workflows/tests.yml`

Full `npm test` runs as blocking gate on every PR + push to `main`. Wall ~7 min (~100s vitest + ~2m npm ci + ~1m assemble/migrate).

Steps: `npm ci` → `node scripts/assemble-jobs-dataset.mjs --stats` (materializes `data/jobs.json`) → `node scripts/migrate-all-known-job-slugs-canton-aware.mjs` → `npm test`.

**`vitest.config.ts: isolate: true` is mandatory** — without it ~10 files fail from leaked `vi.mock` state. Empirically faster too (116s → 99s).

**Branch protection caveat** (2026-05-19): main has no `required_status_checks` — squash-merge can outrun the in_progress check. Configure via `gh api -X PUT repos/.../branches/main/protection` if strict gating needed.

**Known skip:** `tests/job-locale-consistency.test.ts` `.skip` pending re-run of `translate-pending-jobs.yml` for ~84 jobs.

**Adding a new vitest regression gate:** verify locally (`npx vitest run <path>`), trust `tests.yml` auto-globbing — DO NOT add per-test workflows (PR #321 added `unit-tests.yml`, PR #328 removed it).

---

# SEO & Accessibility (quick reference)

- **Canonical**: `https://frontaliereticino.ch/` — no `www`, no trailing slash except root
- **Every new page**: static HTML in `dist/`, SEO metadata, sitemap entry, router slugs in all 4 locales
- **Contrast**: 4.5:1 normal, 3:1 large
- **Never `text-slate-400`** on light backgrounds — use 500/600
- **Every button**: accessible name (text / `aria-label` / `title`)
- **Every `<img>`**: `width`, `height`, `alt`
- **Dark mode**: NEVER use `dark:` color prefixes — semantic tokens in `index.css` auto-switch. Only allowed: `dark:prose-invert`. New color → add semantic token to `index.css`.

Detailed SEO rules: [docs/SEO-RULES.md](docs/SEO-RULES.md).

---

# Feature Flags (Firebase Remote Config)

| Flag | Purpose | Default |
|------|---------|---------|
| `ENABLE_JOB_ALERTS` | Job Alert Form UI + email | `false` |
| `KILL_FUEL_DAILY_LINKS` | Hide F6 SPA links | `false` |
| `KILL_HEALTH_PREMIUMS_LINKS` | Hide F2 SPA links | `false` |
| `KILL_JOB_MARKET_LINKS` | Hide F4 SPA links | `false` |
| `KILL_WEEKLY_EMPLOYERS_LINKS` | Hide F5 SPA links | `false` |
| `KILL_ORPHAN_LANDINGS_LINKS` | Hide F3b SPA links | `false` |

`KILL_*_LINKS` close the SPA link graph in ~1 min (RC cache). Static HTML stays (Google doesn't de-index immediately). Full kill → `SKIP_*` + redeploy.

## Build-time env gates (local only — never in CI)

| Env var | Skips plugin |
|---------|--------------|
| `SKIP_FUEL_DAILY=1` | F6 fuel-daily |
| `SKIP_WEEKLY_EMPLOYERS=1` | F5 weekly-employers |
| `SKIP_JOB_MARKET_SNAPSHOT=1` | F4 job-market-snapshot |
| `SKIP_HEALTH_PREMIUMS=1` | F2 health-premiums |
| `SKIP_ORPHAN_LANDINGS=1` | F3b orphan-landings |
| `SKIP_BORDER_WAIT=1` | F8 border-wait |

Feature catalog: [docs/SEO-FEATURES.md](docs/SEO-FEATURES.md).

---

# SEO Content Gates (per-PR)

Every PR must pass these ratchet audits. Baselines (`data/*-baseline.json`) only go DOWN. **Never widen as workaround. Never noindex without per-URL approval** (rules #1, #5). Full playbooks: [docs/SEO-GATES.md](docs/SEO-GATES.md).

| Gate | Script | Where | Baseline |
|---|---|---|---|
| Text-to-HTML ≥10% | `audit:text-html-ratio` | `deploy.yml` | `text-html-ratio-baseline.json` |
| Orphan pages in sitemaps | `audit:orphan-sitemap-pages` | `deploy.yml` | `orphan-pages-baseline.json` |
| ImageObject license (0-tol) | `audit:image-object-license` | `post-deploy-validation.yml` | must be 0 |
| BFS depth ≤4 from `/` | `audit:max-bfs-depth` | `post-deploy-validation.yml` | `bfs-depth-baseline.json` |
| `<title>` ≤66 | `audit:title-length` | `post-build-tasks.sh` s3 | `title-length-baseline.json` |
| `(#hash)` in `<title>` | `audit:title-no-disambig-hash` | `post-build-tasks.sh` s3 | `title-no-disambig-hash-baseline.json` |
| `<div id="footer-root">` on every `main.seo-static-content` (0-tol) | `audit:footer-root-presence` | `post-deploy-validate-dist.yml` s3 | must be 0 |
| `<title>` ≠ `<h1>` (0-tol) | `audit:h1-title-duplicates` | `post-deploy-validate-dist.yml` s3 | `h1-title-duplicates-baseline.json` |
| No nested JSON-LD script (0-tol) | `audit:jsonld-no-nested-scripts` | `post-deploy-validate-dist.yml` s3 | must be 0 |

Each has a `:rebaseline` script — commit new baseline together with fix in same PR.

## Unified runner (`npm run audit:all`)

10 dist-walking audits run via single Node process (`scripts/audit-all.mjs` + `scripts/lib/audit-runner.mjs`). Walks `dist/` ONCE, dispatches to each Auditor. Wrapped: `footer-root-presence`, `jsonld-no-nested-scripts`, `title-length`, `title-no-disambig-hash`, `h1-title-duplicates`, `text-html-ratio`, `salary-landing-template`, `page-weight`, `content-duplicates`, `faqpage-validity`. Standalone CLI preserved per audit. `AUDIT_STRICT=1` in CI detects accidental html-mutation. Speedup: 209s → 54s (-74%).

## Verification harnesses (`scripts/verify-*.mjs`)

Use before merging changes to `precomputeCache.ts` / `htmlMinify.ts` / `audit-runner.mjs`:
- `verify-l1-equivalence.mjs` — byte-diff for L1 precompute-cache. Bar: byte-identical.
- `verify-l2-equivalence.mjs` — DOM + visible-text + JSON-LD diff for L2 minifier. Bar: DOM + content equivalent.
- `verify-l3-report-equivalence.mjs` — per-audit JSON report diff legacy vs unified runner.
- `measure-l2-distribution.mjs` — predict CI-wide minifier savings without full build.

## Verifying audit fixes without local build

**Never run `FAST_BUILD= npx vite build` locally** — OOMs >8 GB, FAST_BUILD trap silently skips plugins.

Use audit-replay (PR #295):
```bash
gh workflow run audit-dist-from-run.yml \
  -f deploy_run_id=<completed_run_id> \
  -f audits=text-html-ratio,page-weight
```

Pulls `github-pages` artifact (~1.8 GB), restores to `dist/`, runs selected audits, uploads reports. Use for: rebaseline regression check, new gate against historical dist, bisecting audit regressions, validating audit-only paths. Limit: only reads `dist/`; source-only audits need a real build.

**`<title>` critical context:** never reintroduce mid-`…` truncation — tanked CTR on `/calcola-stipendio/` 4.8% → 0.99% during cap=70 era. `buildTitleWithBrand()` (`build-plugins/shared/titleSuffix.ts`) drops brand suffix instead. Job-board exception: `composeJobPageTitle` uses `JOB_TITLE_MAX = 70`.

**ImageObject critical context:** every emitter MUST go through `services/seo/imageObjectLd.ts`. Third-party images (webcams): pass `license` / `creator` / `copyrightNotice` / `creditText` overrides — never strip fields.

---

# Completion Checklist — Before Every PR

- [ ] New `t()` keys → all 4 locales
- [ ] No secrets in source
- [ ] Accessibility (contrast, aria-labels, image dimensions)
- [ ] New pages: SEO metadata + sitemap entry + static HTML
- [ ] No `dark:` color prefixes (enforced by `no-dark-color-classes.test.ts`)
- [ ] User-facing feature → new entry in `WhatsNewModal.tsx`
- [ ] All SEO content gates pass ([docs/SEO-GATES.md](docs/SEO-GATES.md))

## Auto-push Rule

**Every successful task → auto commit + push.** No confirmation needed. Report only non-network failures.

## Worktree-First Rule (parallel-agent safety)

Multiple parallel agents share the primary worktree + a local cron touches 600+ files. `git stash -u` blanket on the shared tree is unsafe — silently captures foreign WIP.

**Isolate non-trivial work in its own worktree before starting** when (a) the task needs commit+push AND (b) the tree has foreign unstaged changes OR other agents may be active OR the cron is running.

In practice: at the start of any code-modification task, `EnterWorktree` on a new branch → edit/commit/push there → merge per Auto-merge Rule below → `ExitWorktree`.

If you must rebase on the shared tree, use `git config rebase.autoStash true` and stage only your own files first.

Dispatching parallel subagents via `Agent`: **always pass `isolation: "worktree"`**.

Exceptions: pure read/grep, single-file doc tweaks scoped "in place", the orchestrator session itself.

## Auto-merge Rule (orchestrator mode)

Pre-authorized in orchestrator mode (durable across sessions):
- Merge open PRs to `main` without human review (CI green not required)
- Delete merged feature branches and worktrees
- Drop or apply leftover stashes
- Merge stale-but-useful branches, leave only `main` working

Other destructive actions (force push, history rewrite, prod data delete) still require explicit confirmation.

### PR-as-merge-vehicle (no review ceremony)

PR = merge vehicle, not review unit. To land on `main`:
1. Push feature branch.
2. `gh pr create --fill` — reuse commit message as title/body. NO multi-section bodies/problem statements/test plans.
3. Squash-merge immediately same turn: `gh pr merge <number> --squash`.
4. `git push origin --delete <branch>` (gh `--delete-branch` fails silently when worktree blocks local cleanup — see `feedback_cleanup_remote_branch_after_squash_merge.md`).
5. `ExitWorktree` with `action: remove, discard_changes: true`.

PR lives seconds, never left open. If review is needed, ask first — default is direct-to-`main`.

API merges without PR (`gh api .../merges`) NOT required — open-then-merge is canonical.

---

# Skill routing

When a request matches a skill, invoke via Skill tool FIRST.

- Ideas, brainstorming → `office-hours`
- Bugs, "why is this broken" → `investigate`
- Ship, deploy, PR → `ship`
- QA → `qa`
- Code review → `review`
- Design system → `design-consultation`
- Visual audit → `design-review`
- Architecture review → `plan-eng-review`
- Checkpoint, resume → `checkpoint`
- Code quality → `health`

---

# Reference Docs

| Topic | File |
|-------|------|
| CI/CD pipeline | [docs/CI-CD-PIPELINE.md](docs/CI-CD-PIPELINE.md) |
| SEO rules / structured data | [docs/SEO-RULES.md](docs/SEO-RULES.md) |
| SEO gate playbooks | [docs/SEO-GATES.md](docs/SEO-GATES.md) |
| SEO feature catalog | [docs/SEO-FEATURES.md](docs/SEO-FEATURES.md) |
| Job crawlers | [docs/CRAWLERS.md](docs/CRAWLERS.md) |
| Cathedral plan | [docs/CATHEDRAL-IMPLEMENTATION-PLAN.md](docs/CATHEDRAL-IMPLEMENTATION-PLAN.md) |
| Cathedral rollback | [docs/CATHEDRAL-ROLLBACK.md](docs/CATHEDRAL-ROLLBACK.md) |
| Design context | [docs/DESIGN-CONTEXT.md](docs/DESIGN-CONTEXT.md) |
| Local dev hygiene | [docs/LOCAL-DEV.md](docs/LOCAL-DEV.md) |
| GitNexus guide | [docs/GITNEXUS.md](docs/GITNEXUS.md) |
| Cache experiment | [docs/CACHE-EXPERIMENT.md](docs/CACHE-EXPERIMENT.md) |

---

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

Indexed as **frontaliere-si-o-no** (28982 symbols, 61573 relationships, 300 flows). If a tool warns stale → `npx gitnexus analyze`.

## Always Do

- **MUST `gitnexus_impact({target, direction: "upstream"})` before editing any symbol** — report blast radius (callers, processes, risk) to user.
- **MUST `gitnexus_detect_changes()` before committing.**
- **MUST warn** on HIGH/CRITICAL risk before proceeding.
- Exploring unfamiliar code → `gitnexus_query({query: "concept"})` (process-grouped, ranked).
- Full 360° on a symbol → `gitnexus_context({name})`.

## Debugging

1. `gitnexus_query({query: "<symptom>"})` — find flows
2. `gitnexus_context({name: "<suspect>"})` — callers/callees/processes
3. `READ gitnexus://repo/frontaliere-si-o-no/process/{name}` — trace flow
4. Regression → `gitnexus_detect_changes({scope: "compare", base_ref: "main"})`

## Refactoring

- **Renaming** → `gitnexus_rename({symbol_name, new_name, dry_run: true})` first. Review preview, then `dry_run: false`.
- **Extracting/splitting** → `gitnexus_context` then `gitnexus_impact` before moving code.
- After refactor → `gitnexus_detect_changes({scope: "all"})`.

## Never Do

- NEVER edit without `gitnexus_impact` first.
- NEVER ignore HIGH/CRITICAL warnings.
- NEVER rename with find-and-replace.
- NEVER commit without `gitnexus_detect_changes()`.

## Tools

| Tool | Use |
|------|-----|
| `query` | Find by concept |
| `context` | 360° on one symbol |
| `impact` | Blast radius before editing |
| `detect_changes` | Pre-commit scope check |
| `rename` | Safe multi-file rename |
| `cypher` | Custom graph queries |

## Risk Levels

| d | Meaning | Action |
|---|---------|--------|
| 1 | WILL BREAK (direct) | MUST update |
| 2 | LIKELY AFFECTED (indirect) | Should test |
| 3 | MAY NEED TESTING (transitive) | Test if critical |

## Resources

`gitnexus://repo/frontaliere-si-o-no/{context|clusters|processes|process/{name}}`

## Self-Check Before Finishing

1. `gitnexus_impact` run for all modified symbols
2. No HIGH/CRITICAL ignored
3. `gitnexus_detect_changes()` matches expected scope
4. All d=1 dependents updated

## Index Freshness

After commits the index goes stale:
```bash
npx gitnexus analyze
```

Preserve embeddings:
```bash
npx gitnexus analyze --embeddings
```

Check `.gitnexus/meta.json` → `stats.embeddings`. Without `--embeddings`, prior embeddings are deleted.

> Claude Code: PostToolUse hook handles this after `git commit` / `git merge`.

## CLI Skill Files

| Task | File |
|------|------|
| Understand architecture | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Debugging | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Refactoring | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools/resources/schema | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
