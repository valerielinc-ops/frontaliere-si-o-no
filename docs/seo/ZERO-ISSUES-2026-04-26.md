# Zero-Issues Sweep — frontaliereticino.ch

**Date:** 2026-04-26 → 2026-04-27
**Trigger:** Semrush Site Audit campaign 29351097 — 8,982 pages with issues, Site Health 78%
**Goal:** Drive Semrush issues to ~0 across all severities (errors, warnings, notices)
**Branch:** `seo/zero-issues-2026-04-26` → merged to `main` via PR #34

---

## Baseline (Semrush 2026-04-26 audit)

| Severity | Count | Trend vs prior |
|---|---|---|
| Errors | 3,055 | -6,464 |
| Warnings | 3,286 | -848 |
| Notices | 8,982 | — |
| Pages with issues | 8,982 | -660 |
| Pages blocked | 759 | +728 (intentional Disallow added) |
| Pages broken | 5 | +2 |
| Site Health | 78% | -4 |

**Top issue families (Semrush IDs):**

| ID | Issue | Count | New |
|----|---|---|---|
| 8 | Broken internal links | 1,463 | +1,460 🔥 |
| 24 | Hreflang conflicts in source | 531 | +76 |
| 6 | Duplicate title tags | 450 | +427 🔥 |
| 40 | Meta refresh redirects | 426 | +427 🔥 |
| 4 | Pages blocked from Semrush crawler | 759 | +728 |
| 102 | Title too long (>60 char) | 954 | +300 |
| 105 | H1 = Title duplicate | 458 | +33 |
| 112 | Low text/HTML ratio | 1,208 | +86 |
| 117 | Low word count | 406 | +77 |
| 207 | Orphan pages in sitemap | 4,563 | +466 |
| 212 | Pages > 3 clicks from root | 8,835 | +8,798 🔥 |
| 213 | Single inbound internal link | 572 | +187 |
| 216 | Links without anchor text | 888 | +23 |
| 218 | External 403 links | 671 | +37 |
| 223 | AI Search not optimized | 496 | +480 🔥 |
| 45 | Invalid structured data | 148 | +16 |

---

## Phases shipped

### Phase 1 — Quick wins (parallel, 4 agents)

| Phase | Commit | Files | Resolves |
|---|---|---|---|
| 1A | `9212b3b64` | `services/adAnalytics.ts`, `tests/ad-analytics.test.ts` | AdSense AI-bot UA skip (RPM dilution from ChatGPT-User/ClaudeBot/PerplexityBot ecc.) |
| 1B | `63fdbe9ff` | `build-plugins/flatHtmlRedirectPlugin.ts`, `tests/flat-html-redirect.test.ts` | E3 (450 dup titles) + E4 (426 meta refresh) — per-URL title from sibling, drop meta-refresh |
| 1C | `d9e99dd6b` | `public/404.html`, `build-plugins/editorialContent.ts` | E9 (3 4XX) — drop noscript meta-refresh; fix EN/DE/FR tax-simulator anchors in editorial blocks |
| 1D | `5b4b20329` | `public/robots.txt`, `services/seoService.ts`, `tests/seo-noindex-filter-variants.test.ts` | W1 (-728) + E2 (-531) — replace `Disallow ?canton=*/?age=*/?q=*` with runtime noindex+canonical |
| 1E | _no-op_ | — | Probe revealed both 5XX URLs returned HTTP 200 live (stale Semrush data) |

### Phase 2 — Internal-link graph + hreflang gating

| Phase | Commit | Files | Resolves |
|---|---|---|---|
| 2-hreflang | `0707333b0` | `build-plugins/shared/hreflangGuard.ts`, `build-plugins/hreflangPostprocessPlugin.ts`, `vite.config.ts`, `tests/hreflang-no-broken.test.ts` | E1 (-1,460) + E8 (-6) — universal post-process strips broken hreflang alternates |
| 2-UI | `9363cf95a` | `build-plugins/seoHubsPlugin.ts`, `build-plugins/seoHubsData.ts`, `components/seo/SeoHubPages.tsx`, `services/router.ts`, `App.tsx`, `services/locales/{it,en,de,fr}-seo-links.ts`, `build-plugins/staticPagesPlugin.ts` | A1 (-8,798) + A2 (-4,563) + A5 (-572) — 4 hub pages × 4 locales × paginated (~1,188 HTML), footer enrichment, related-jobs pattern |

### Phase 3 — Content quality

| Phase | Commit | Files | Resolves |
|---|---|---|---|
| 3A | `8d4628253` | `build-plugins/jobSectorLanding.ts`, `weeklyEmployersPlugin.ts`, `jobMarketSnapshotPlugin.ts`, `healthPremiumsLandingPlugin.ts`, `orphanQueryLandingPlugin.ts`, `fuelDailyPagesPlugin.ts`, `shared/seoContentTokens.ts`, 3 tests | W2 (-954) + W3 (-458) — `formatSeoTitle()` ≤60 char, `formatSeoH1()` narrative distinct |
| 3B | `dbb50de4b` | `build-plugins/jobSectorLanding.ts`, `jobsSeoPagesPlugin.ts`, `data/sector-descriptions.json`, `data/company-profiles.json`, 2 tests | W4 (-1,208) + W5 (-406) — 200-400-word sector prose; company enrichment + noindex 0-job stubs |
| 3C | `ce6798166` | `scripts/lib/ai-search-template.mjs`, `scripts/create-article.mjs`, `scripts/backfill-ai-search-optimization.mjs`, 2 tests | A6 (-496) — TL;DR + FAQPage template + retro-fill script for 902 IT articles |

### Phase 4 — Cleanup & polish

| Phase | Commit | Files | Resolves |
|---|---|---|---|
| 4A+5 | `3d3f17594` | `services/seoService.ts`, `build-plugins/jobsSeoPagesPlugin.ts`, `tests/url-max-length.test.ts`, `tests/seo-html-lang-sync.test.ts`, `package.json` | E5 + E7 + A8 + Phase 5 gates — sitemap-jobs alignment, hreflang lang sync, URL trunc gate |
| 4B-components | `8164d33a1` | `components/community/JobBoard.tsx`, `tests/job-board-nofollow.test.ts` | A4 (-671) — `rel="nofollow"` on outbound ATS links |
| 4C | `f5baa6c13` | `services/jobDataNormalization.ts`, `build-plugins/comparisonsHubPlugin.ts`, `faqHubPlugin.ts`, 4 dist-gate tests | A9 + W6 + A3 + A11 + E6 — slug trunc 180ch, multi-H1 fix in hub plugins, anchor-text gates |

### QA polish (post-implementation)

| Commit | Files | Reason |
|---|---|---|
| `808a77820` | `build-plugins/seoHubsPlugin.ts`, 4 tests | Hub `<title>` ≤60 (drop "| Frontaliere Ticino" suffix), narrative H1 templates |
| `613b49f1a` | `tests/noindex-builders.test.ts` | Align with Phase 3B legacy bridge `noindex: true` |
| `f41b69ef9` | `tests/no-js-redirects-in-build.test.ts`, `tests/company-landing-content.test.ts` | Phase 1B no-meta-refresh + company-vs-job-detail filter |

### Post-merge fixes

| Commit | Files | Reason |
|---|---|---|
| `30ef0108d` | `build-plugins/seoHubsPlugin.ts` | Sitemap validator failed: hub pages emitted different `totalPages` per locale because IT/EN/DE/FR slug lists differed. Use IT canonical list as master (fall back to IT path/title when locale missing) |
| `2fdc7f259` | `tests/calculator/calculator-paywall.test.tsx` | Test queried `container.querySelector('form')` but `CalculatorPaywall` renders via `createPortal` to `document.body`. Switched to `document.body.querySelector` |
| `50210a072` | `build-plugins/jobsSeoPagesPlugin.ts` | Slug collision: pre-existing GSC-imported tracking entry "infermieri" was overwriting the legitimate sector hub HTML at `/cerca-lavoro-ticino/infermieri/`. Added `RESERVED_HUB_SLUGS` filter to `expiredSlugs` |
| `744da57c4` + `cde361b66` | 11 test files | Add `getCantonI18nParams` to `vi.mock('@/services/i18n', ...)` calls — RelatedTools.tsx (transitively imported by many tests via App/Calculator) calls it; mocks without `importOriginal` were leaking the missing-export error across files in parallel batches |
| `a49c59a07` | `build-plugins/staticPagesPlugin.ts` | Locale-root SPA shells: hreflang alternates pointed to `/en/`, `/de/`, `/fr/` but no plugin emitted `dist/{en,de,fr}/index.html`. Mirror IT homepage with locale-aware `<html lang>` + canonical |
| `ed9088e08` | `scripts/backfill-ai-search-optimization.mjs` | Auto-commit + push every 25 articles (`BACKFILL_COMMIT_BATCH` env). Prevents loss of in-flight AI-generated content if orchestrator stashes/drops mid-run |
| `9f23ea9e2` | 403 article body files | **Recovered 403 backfill articles** from 6 dropped stash commits via `git fsck --unreachable`. Diff-extracted from `c4d0f59e1`, `4c2e1bef1`, `fa3608a28`, `9fd599fd3`, `efc21f7dd`, `8467d750a` |
| `587a69bfb` | 6 SEO landing plugins | **Recovered CSS color tweak** from autostash. Plugins were using `--color-success-border` etc as text color (invisible badges). Switched to `--color-success`/warning/danger text tokens |

---

## Bot AI vs AdSense USA strategy (per request)

`robots.txt` **stays fully open** to all AI bots (ChatGPT-User, ClaudeBot, PerplexityBot, GPTBot, Google-Extended, Applebot-Extended, etc.) — no Disallow.

The AdSense skip is **client-side only**, in `services/adAnalytics.ts::isLikelyBot()`:

- 31 AI bot UA patterns added to `BOT_UA_PATTERNS`: gptbot, chatgpt-user, oai-searchbot, claudebot, claude-web, claude-user, claude-searchbot, anthropic-ai, perplexitybot, perplexity-user, google-extended, googleother, applebot-extended, amazonbot, bytespider, cohere-ai, meta-externalagent, youbot, ccbot, mistralbot, qwenbot, grokbot, phindbot, exabot, kagibot, iaskbot, deepseekbot, copilotbot, bravebot, neevabot, diffbot
- AI bot impressions no longer dilute USA RPM
- Content remains crawlable for citation
- Telemetry: `ad_bot_skip` event in PostHog measures impact

---

## Test gates (pre-push enforced)

`package.json` script `test:seo-gates` runs:
- `tests/title-length.test.ts` — every `<title>` ≤60 char (with documented exclusions)
- `tests/h1-not-equal-title.test.ts` — H1 textually different from title
- `tests/url-max-length.test.ts` — canonical paths ≤215 char (5 legacy exceptions)
- `tests/hreflang-no-broken.test.ts` — every hreflang resolves on disk
- `tests/dist-single-h1-per-page.test.ts` — max 1 H1 per page
- `tests/dist-link-anchor-text.test.ts` — all `<a>` carry text or aria-label
- `tests/seo-html-lang-sync.test.ts` — `<html lang>` matches locale
- `tests/seo/software-application-jsonld.test.ts` — schema mandatory fields

---

## Live verification post-deploy

- `robots.txt` — `Disallow ?canton=*/?age=*` removed, `?q=*` added ✅
- `404.html` — no `<meta http-equiv="refresh">` ✅
- `/articoli-frontaliere/{slug}` (flat redirect bridge) — per-URL title, canonical+noindex+JS replace, **no meta-refresh** ✅
- `/cerca-lavoro-ticino/case-anziani/` — title 51ch `Lavoro Case Anziani Ticino 2026 — 999 offerte attive`, narrative H1 ✅
- `/cerca-lavoro-ticino/tutti/` (NEW hub) — HTTP 200 ✅
- `/aziende-che-assumono/tutte/` (NEW hub) — HTTP 200 ✅
- `/articoli-frontaliere/tutti/` (NEW hub) — HTTP 200 ✅
- `/en/`, `/de/`, `/fr/` (locale roots) — HTTP 200 ✅

---

## Quantitative impact

| Plugin output | Pages emitted |
|---|---|
| Total dist files | ~178k |
| Flat redirect bridges | 94k |
| Hub pages (jobs/sectors/companies/articles × 4 locales paginated) | 1,188 |
| Sector landings (3 sectors × 4 locales) | 12 |
| Locale-root SPA shells | 3 |
| Hreflang alternates kept | ~566k (0 broken after Phase 2-hreflang) |

**Sub-sitemaps in `sitemap.xml`:** 28 (was 6 before Phase 2-UI added `sitemap-seo-hubs.xml` and Phase 3A's content fixes)

---

## Open / manual follow-ups

1. **Re-audit Semrush** (manual UI trigger) ~24h after the latest deploy stabilizes. Expected drop: 8.9k → < 200 issues.
2. **Backfill remaining articles** — `node scripts/backfill-ai-search-optimization.mjs --apply` is now self-committing in batches of 25; final run handles whatever the previous loss recovery missed (currently 785/928 articles marked).
3. **Translate Pending Jobs cron** will fix the single EFG `project-management-intern-efg-luxembourg` translation gap flagged by `tests/job-locale-completeness.test.ts`.
4. **Test pollution flake** — 7 test files (errorReporter, analytics-seo, useSeoPageTracking, calculator/consulting-cta, ecc.) pass in isolation but fail in the parallel suite. Polluter not yet identified; my mock fixes cut the count from 17 to 9 files. Pre-existing structural issue.
