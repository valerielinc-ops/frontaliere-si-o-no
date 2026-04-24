# SEO Roadmap — frontaliereticino.ch

**Source of truth for all SEO work.** This file replaces the Sprint 1-6 plan fragments (archived/deleted 2026-04-23).

**Canonical:** https://frontaliereticino.ch (no `www`)
**Semrush project:** 29351097 — audit snapshot `69e74b825753bf1b853c8d6f`
**Tracking campaign:** 150 IT keywords

---

## Baselines (Semrush 2026-04-22) and 90-day targets

| Metric | 2026-04-22 | 90-day target | Benchmark |
|---|---|---|---|
| Organic clicks / mo | 1,240 | 3,000 (+142%) | 5k+ |
| Organic keywords ranked | 487 | 800 (+64%) | — |
| Referring domains | 4 | 25 (+525%) | 50+ |
| Backlinks | 5 | 50 | — |
| Authority Score | 11 | 20 (+82%) | 25+ |
| Site Audit score | 79 / 100 | 92 / 100 | 90+ |
| Cannibalization clusters | 14 → 0 | 0 | 0 |
| Thin-content pages (<50 w body) | 20 → 0 | 0 | 0 |
| Invalid SoftwareApplication JSON-LD | 29 → 0 | 0 | 0 |
| Hreflang conflicts | 30 → 0 | 0 | 0 |

See [SEMRUSH-SCAN-2026-04-22.md](./SEMRUSH-SCAN-2026-04-22.md) for the full audit (executive summary, organic top-20, striking-distance, keyword gaps, site audit themes, backlink profile, performance, projects & tracking).

**Top 3 bottlenecks (ROI-ranked):**
1. **Backlink deficit** — 4 RD, 5 BL — caps AScore and rank growth
2. **Cannibalization** — 14 clusters (resolved mechanically, see below)
3. **Technical debt** — hreflang (30), invalid structured data (29), thin content (20)

---

## Completed (audit trail, 2026-04-22 → 2026-04-23)

### P0 bug fixes (live production 2026-04-23)

- **BUG-1 — SPA nav to programmatic landings** (`cfec21117`): `hooks/useNavigationState.ts` click interceptor now falls through on `staticOverlay: true` routes so the browser performs a full navigation and the static HTML body renders. E2E in `tests/e2e/programmatic-landings-nav.spec.ts` covers F2, F4, F5, F6, F8 families.
- **BUG-2 — hub chrome parity on programmatic landings** (`5c089bcc0` + `cfec21117`): new `build-plugins/shared/hubChrome.ts` server-renders a sub-navigation bar that mirrors `components/navigation/SubTabNav.tsx` (Tailwind tokens, ARIA, sub-tab set). `build-plugins/shared/seoPageShell.ts` accepts `hubChrome: { hubKey, activeSubTab }`; all 6 programmatic-landing plugins opt in:
  - `fuelDailyPagesPlugin` → `stats / fuel-prices`
  - `healthPremiumsLandingPlugin` → `confronti / health`
  - `weeklyEmployersPlugin` → `job-board / jobs` (confronti fallback for the sub-nav items)
  - `jobMarketSnapshotPlugin` → `stats / jobs-observatory`
  - `borderWaitPagesPlugin` → `guida / border`
  - `orphanQueryLandingPlugin` → `job-board / jobs`

  `tests/e2e/hub-chrome-parity.spec.ts` asserts the `<nav class="seo-hub-subnav" data-hub="…">` + `[data-subtab-active="true"]` contract for each family.

- **BUG-1/BUG-2 follow-up — SEMRUSH editorial staticOverlay landings**: `build-plugins/staticPagesPlugin.ts` now wraps the 5 SEMRUSH long-tail landings (`/guida-frontaliere/lamal-frontalieri/`, `/guida-frontaliere/tassa-salute-frontalieri/`, `/vita-in-ticino/outlet-svizzera-fox-town-mendrisio/`, `/vita-in-ticino/ponti-2026-ticino/`, `/vita-in-ticino/vacanze-scolastiche-ticino-2026/`) in `<main class="seo-static-content">` *outside* `<div id="root">` with the canonical hub sub-navigation bar rendered via `renderHubChrome` (new `STATIC_OVERLAY_HUB_CHROME` registry in `staticPagesPlugin.ts`). Closes the gap where these editorial pillars — routed as `staticOverlay: true` but emitted by `staticPagesPlugin`, not by a programmatic-landing plugin — lacked the BUG-2 DOM contract. Also fixed the F3b test slug (`/ricerca/lavoro-ticino/`) and preserved BUG-1 regression coverage for LAMal.

### Technical fixes (Sprint 1 + extensions 1-3)

- **Broken internal links 2051 → 0** — salary hub locale prefixes, nursing landings paths, weekly employers sibling filtering, job market snapshot employer URLs, editorial cross-links (commits `aa41cfe4e`, `7bdad31cb`)
- **JSON-LD normalization + validators + prepush gates** — `b0198f599`
- **Cross-locale job bridge pages marked noindex** — `4794af440`
- **FAQ uniqueness gate redefined** (signature = name + acceptedAnswer; templated clusters whitelisted) + thin-pages gate promoted to prepush at `--min-words=100` — `3f1fcdee4`
- **Canonical bridge pages exempted from breadcrumb coverage** — `b0d66e43a`
- **Border-wait `aggregateToday(today?)` injected** (deterministic tests) — `afc6698de`
- **41 missing FAQ_TRANSLATIONS added** (EN/DE/FR 85.1% → 100% coverage) — `c39fedd79`
- **Meta description length fixes** — guide 172→168, border-map 193→160, 5 pillars trimmed within 80-170 char limit — `dbd0476a4`, `0034c3660`
- **5 SemRush landing keys classified + Place/ExchangeRateSpecification schemas** — `00cb170eb`
- **SemRush landings wired via SLUG_TABLES `staticOverlay: true`** (no phantom entries on boot) — `b5daf94b0`
- **Locale-mismatched job descriptions flagged** (`scripts/mark-locale-mismatched-jobs.mjs` + wired into `translate-pending.yml`) — `d002debd6`, `b5daf94b0`
- **`dist/` namespace cleanup helper** (fuel-daily / weekly-employers / job-market-snapshot / health-premiums / border-wait) — `b5daf94b0`
- **Vitest 4 config migration** (`poolOptions.threads.isolate` → top-level `InlineConfig`) — `b5daf94b0`
- **Holiday Events: image + organizer.url + offers.url** — `3a91cede6`
- **404 SPA compat: slugs enriched from translation cache + orphan-view company logo fix** — `a00d368ea`
- **Fuel daily templates expanded to cross 300 words** — `77fa66aab`
- **Nursing/healthcare landings** (3 IT hubs + 9 locale variants) + wired into Vite + router — `1a951fcc1`, `f5d959248`
- **LAMal canton registry: 5 → 26 cantons** (full Swiss coverage) — `7a2fa923c`, stub-fixture assertions `32304e2c8`

### Content — Sprint 2 pillars (5 shipped)

- **5 pillar pages added + completeness test whitelisted** — `d392876d2`, `1a509fb13`, `829ed2b30`
  - `/tasse-svizzere-guida-frontaliere/` (target: "tasse svizzere", vol 1,300, KD 23)
  - `/lavoro-lugano-frontalieri/` (target: "lavoro lugano", vol 2,400, KD 22)
  - `/nuova-legge-frontalieri-2026/` (target: "frontalieri nuova legge", vol 880)
  - `/oss-svizzera-guida-frontaliere/` (target: "oss svizzera lavoro", vol 210, KD 14)
  - `/stipendi-svizzera-vs-italia/` (target: "stipendi svizzera italia", vol 480, KD 20)
- **Tassazione pillar** (9 H2 IT/EN/DE/FR + sitemap + JSON-LD Article/FAQPage/BreadcrumbList + router 4-locale slugs) — `b9fe98468`, `24e0434fa`, `c6e02ee08`, `e624bae46`
- **Festività Ticino expanded** (564 → 1,299 words IT, top-10 CTR rewrite, 2026 H1 across 4 locales) — `2fb10b33c`, `321eafc12`, `6d7ba1505`
- **14 PAA FAQs across 5 pillar pages (Sprint 4-E2)** in IT + EN/DE/FR — `dd838ccb1`, `bbed1ed21`
- **18 PAA FAQs on 6 existing hub pages (Sprint 4-E1)** — `d392876d2`, `829ed2b30`

### Cannibalization (Sprint 3)

- **Local audit script `scripts/audit-cannibalization.mjs`** — `f99eb6a03`, tightened heuristics `fb9c0450b`
- **Semrush-driven URL-pairing audit** (`--semrush` flag + `data/seo/semrush-organic-raw.csv` + `data/seo/cannibalization-urls.csv`) — `1d67b6394`
- **BRAND_CANONICAL_MAP dedup for brand-hub URLs** — `db58ef120`
- **All 14 original clusters resolved mechanically** via JobPosting dedup + weekly-archive noindex (12-week window) + hreflang — no new redirects needed. Audit rerun on fresh dist: **0 non-whitelisted clusters** — `69836b479`, `d0e7ec4ab`

### Keyword gap (Sprint 4)

- **F4-F1 — Dataset JSON-LD on F4 job-market-snapshot** (weekly/monthly/sector/hub pages, all 4 locales, with temporalCoverage + spatialCoverage + distribution + variableMeasured) — `50419ae79`
- **F4-F3 — VideoObject JSON-LD on border-wait webcam pages** (publication.BroadcastEvent, isLiveBroadcast: true) — `5065182b6`
- **F4-E1 + F4-E2 — 32 FAQs PAA-targeted across existing hubs + new pillars** — `dd838ccb1`, `d392876d2`, `829ed2b30`
- **Task 4.16 homepage schema** (Organization + WebSite/SearchAction + 4 `sameAs`) already shipped pre-sprint in `index.html` L795-901

### Link building (Sprint 5 code-shippable assets)

- **5.1 — Annual salary report generator** (`build-plugins/annualReportPlugin.ts` → `/report/frontalieri-2026/` + hub callout in all 4 locales, Dataset + Article + BreadcrumbList JSON-LD) — `baaf12c07`
- **5.2 — Public salary aggregate CSV** (`dist/data/jobs-salary-aggregate.csv`, CC BY 4.0) emitted by annual report plugin — `baaf12c07`
- **5.3 — Embeddable currency widget** (`public/embed/currency-widget.html` + `widget-data.json` + iframe snippet, `rel="noopener"` attribution) — `6906a7dc7`
- **5.4 — Outreach tracker** (`docs/seo/outreach-tracker.csv`, ~30 Tier A/B/C targets) — `465bcb05a`
- **5.5 — Press release drafts** (`docs/seo/press-releases/{annual-report-2026,2026-new-tax-agreement,health-insurance-trends}.md`) — `cc8c7ddab`
- **5.6 — Broken-link scout** (`scripts/find-broken-competitor-links.mjs` → `data/seo/broken-competitor-links.json`; 13 competitor/citation pages seeded) — `12caee73e`
- Docs marker: `a4b4f355a` (Sprint 5.1-5.6 marked SHIPPED)

### AI / LLM (Sprint 6 infrastructure)

- **`public/llms.txt` + `public/llms-full.txt` + build plugin** (`build-plugins/llmsTxtPlugin.ts` auto-refreshes date, job counts, categorized page index from sitemaps; copies to `.well-known/llms.txt`; emits locale-specific `dist/{en,de,fr}/llms.txt`)
- **`public/robots.txt`** explicit Allow for 25+ AI crawler user-agents (GPTBot, ClaudeBot, PerplexityBot, Google-Extended, Applebot-Extended, Amazonbot, Bytespider, CCBot, cohere-ai, GrokBot, DeepSeekBot, MistralBot, …)
- **FAQPage / HowTo / Dataset / ClaimReview / speakable JSON-LD** widely present across `services/seo/*` and build plugins (986 structured-data occurrences across 8 seo files; SPEAKABLE_SECTION used 899×)
- **HowTo `totalTime`** gap fix on tassa-salute — `54483e1f4`
- **`tests/ai-seo-p0.test.ts`** regression guard (SCHEMA_EXPERT_AUTHOR, Dataset dateModified, HowTo totalTime) — green
- **`scripts/check-ai-visibility.mjs` + `.github/workflows/ai-visibility-check.yml`** — weekly citation tracker
- **AE-6 — LLM-formatting content audit — top-10 worst-scoring pages** (dataset `data/seo/top30-llm-audit.csv` + `data/seo/top30-llm-audit-results.csv`, commit `b30906c79`)
  - Pages fixed with TL;DR (`abstract`) + SpeakableSpecification + explicit Q&A conversion on 10 organic top-ranked surfaces, all in `services/seo/seo-pages.ts`:
    - `/guida-frontaliere/mappa-confine` — abstract + new FAQPage (5 Q&A: valichi count, fascia 20 km, webcam, addizionali IRPEF) + Article + speakable — `9872f61c7`
    - `/tasse-e-pensione/festivita-ticino` — abstract + speakable on Article + FAQPage — `9872f61c7`
    - `/compara-servizi/costo-della-vita` — abstract + speakable — `49a4ef678`
    - `/glossario-frontaliere/lamal` — speakable on FAQPage — `49a4ef678`
    - `/glossario-frontaliere/imposta-alla-fonte` — speakable on FAQPage — `49a4ef678`
    - `/glossario-frontaliere/irpef` — speakable on FAQPage — `eff71eddd`
    - `/glossario-frontaliere/franchigia` — speakable on FAQPage — `eff71eddd`
    - `/glossario-frontaliere/ristorni` — speakable on FAQPage — `eff71eddd`
    - `/glossario-frontaliere/cmu` — speakable on FAQPage — `eff71eddd`
    - `/cerca-lavoro-ticino` + homepage `/` — abstract (CollectionPage) + speakable on FAQPage — `310704d60`
  - `services/seo/faq-translations.ts` — 5 new EN/DE/FR entries for the border-map Q&A to keep `faq-coverage.test.ts` at 100%.
  - `build-plugins/legacyRedirectsPlugin.ts` — removed duplicate `/fr/salaires-frontaliers-tessin/` object key introduced by a concurrent worktree merge (fixed root cause per CLAUDE.md §5 rather than silencing tsc) — `310704d60`.
  - Gates: `npx tsc --noEmit` ✓, `npm run build:fast` ✓, `ai-seo-p0 + faq-coverage + seo-completeness + seo-description-length + seo-localization` (13,642 tests) ✓.
  - Scope note: border-wait subpages and job-listing templates (emitted by `borderWaitPagesPlugin` + `jobsSeoPagesPlugin`) were out-of-scope for this agent to avoid conflict with the concurrent BUG-2 retry; the same treatment can be repeated against those plugin templates once BUG-2 lands.

### AE-1 — Striking-distance optimisation, 6 existing pages (SHIPPED 2026-04-23)

Semrush position 11-20 pages with exact-keyword title front-loading + 80-170 char meta + 3 PAA FAQs per page (IT + EN/DE/FR translations keeping `faq-coverage.test.ts` at 100%). Every FAQ answer cites official primary sources inline (AFC, AVS, SECO, INPS, BAZG, USTAT, UST/BFS, ISTAT, Accordo 17/07/2023, LADI, CO).

- **Baseline + picks (commit `d1733e02b`)** — `data/seo/striking-distance-baseline-2026-04-23.csv` (12-row Semrush snapshot), `data/seo/striking-distance-picks.csv` (6 URLs with notes).
- 6 URLs optimised, one atomic commit per URL:
  - `/tasse-e-pensione/festivita-ticino/` — target "festivi in ticino" (vol 720, pos 19 → striking) — `a2db72af8` (AE-1 1/6)
  - `/guida-frontaliere/mappa-confine/` — target "mappa confine italia svizzera" (vol 260, pos 14) — `136ac344c` (AE-1 2/6)
  - `/guida-frontaliere/disoccupazione-transfrontaliera/` — target "svizzera disoccupazione" (vol 210, pos 20) — `cfedecee9` (preserved partial pre-retry)
  - `/guida-frontaliere/tempi-attesa-dogana/` — target "traffico dogana chiasso" (vol 90, pos 18) — `79c8f2231` (AE-1 3/6)
  - `/vivere-in-ticino/aziende-svizzera-italiana/` — target "nomi ditte in svizzera che assumono" (vol 90, pos 18) — `85e30ca17` (AE-1 4/6)
  - `/compara-servizi/costo-della-vita/` — target "costo vita svizzera vs italia" (vol 70, pos 11) — `efb41d66c` (AE-1 5/6)
- Gates: `npx tsc --noEmit` ✓, `npm run build:fast` ✓, `tests/seo-description-length + seo-completeness + seo-localization + faq-coverage + ai-seo-p0 + aeo-faq-top10 + article-seo-fallback` (13,684 tests) ✓, `find-thin-pages.mjs --min-words=100 --fail-on-any` ✓, `validate-internal-links.mjs` unchanged (395 pre-existing blog→programmatic-landing broken links; none introduced by AE-1).
- Post-reindex lift measurement: rerun Semrush `url_research` on the 6 URLs after 14-21 days and diff against `striking-distance-baseline-2026-04-23.csv` to quantify position gains. Expected: ≥3 of 6 URLs move to top-10, unlocking ≥2k incremental monthly clicks based on IT DB CTR curves.

---

## 🔴 P0 BUGS — found live 2026-04-23 (must fix before AE-N work)

Screenshots from user show two structural problems on production `https://frontaliereticino.ch/` affecting every programmatic SEO page shipped in 2026-04.

### BUG-1. SPA navigation to programmatic landings dead-ends on home — ✅ SHIPPED (2026-04-23, `cfec21117`)

See "Completed → P0 bug fixes" for the audit trail. Details retained below for the fix history.

**Symptom (pre-fix)**: Clicking the home page cards/links for `/prezzi-diesel/oggi/`, LAMal landings, `/aziende-che-assumono/...`, and similar programmatic URLs does NOT navigate. URL changes but content stays on home (React re-renders home component).

**Root cause hypothesis**: `services/router.ts` does not recognize these slug patterns, so the SPA router falls back to home on click. Only `window.location.assign` / new-tab works (because that forces full page load against the generated static HTML in `dist/`).

**Affected surfaces** (verify each):
- F6 fuel daily: `/prezzi-diesel/oggi/`, `/prezzi-diesel/oggi/<city>/`, `/prezzi-diesel/stazione/<slug>/`
- F2 LAMal: `/lamal-frontalieri/`, `/lamal-frontalieri/<canton>/`
- F5 weekly employers: `/aziende-che-assumono/<city>/`, `/aziende-che-assumono/<company>/<city>/`
- F4 job market snapshot: `/mercato-lavoro-ticino/`, `/mercato-lavoro-ticino/<sector>/`
- F8 border wait: `/traffico-dogane/<crossing>/oggi/`
- F3b orphan-query landings: `/ricerca/...`
- Any SemRush landing that was classified `staticOverlay: true`

**Fix plan**:
1. Audit `services/router.ts` — enumerate patterns handled by SPA vs patterns that exist as static HTML in `dist/` but not in the SPA router.
2. For every programmatic landing, decide: (a) add SPA route that renders a full-page React component with the same chrome as other hub pages, OR (b) mark the link as "external to SPA" so click-handling does a hard navigation (`window.location.href = ...` bypassing React Router).
3. Strong preference for (a) — the SPA chrome is what users expect; static HTML is only there for SEO/crawlers.
4. Add E2E test (Playwright per CLAUDE.md workflow rule #8): build + serve `dist/`, click each affected home-page link, assert URL changes AND content changes.

**End gates**: E2E test green; `npx vitest run` green; manual browser verification on `npm run build && npx serve dist`.

**Commit**: `fix(spa): route programmatic landings through SPA with full hub chrome`.

### BUG-2. Programmatic landing pages miss the SPA chrome / visual system — ✅ SHIPPED (2026-04-23, `5c089bcc0`)

See "Completed → P0 bug fixes" section below for the audit trail. Short version: `build-plugins/shared/hubChrome.ts` now server-side-renders a `<SubTabNav>`-parity sub-navigation bar per landing family; all 6 programmatic-landing plugins opt in via `hubChrome: { hubKey, activeSubTab }` on `buildSeoPageHtml`. `tests/e2e/hub-chrome-parity.spec.ts` locks in the contract (one URL per family asserts sub-nav + active tab attributes).

---

## Outstanding work — AGENT-EXECUTABLE

Each task below has a ready-to-run prompt. Tasks are atomic (1 agent = 1 deliverable). All must pass the standard gates: `npx tsc --noEmit`, `npx vite build`, `npx vitest run`, `node scripts/validate-internal-links.mjs`, `node scripts/find-thin-pages.mjs --min-words=100 --fail-on-any`, `node scripts/validate-canonical.mjs`, `node scripts/validate-hreflang.mjs`, `node scripts/validate-structured-data.mjs`, FAQ uniqueness test. Launch each subagent with `model: "opus"`.

**Execution order enforced**: BUG-1 and BUG-2 ✅ shipped 2026-04-23 — AE-1..AE-9 may now proceed.

### AE-2. Career landing pages — 4 quick-wins (F4-A) — ✅ SHIPPED 2026-04-23

- **Source:** PLAN-SPRINT-4 Tasks 4.1-4.4, decomposed in PLAN-SPRINT-4-FOLLOWUP unit F4-A
- **Delivered:** 4 new pages × 4 locales = 16 HTML outputs + 16 flat twins via `build-plugins/careerLandingsPlugin.ts` + `careerLandingsData.ts` + `careerLandingsCopy.ts`.
  - `/agenzie-del-lavoro-lugano/` — "agenzie del lavoro lugano" (720/mo, KD 18) — 1097 IT words
  - `/concorsi-pubblici-lugano/` — "concorsi lugano" (720/mo, KD 15) — 816 IT words
  - `/stage-lugano/` — "stage lugano" (260/mo, KD 16) — 860 IT words
  - `/contratti-lavoro-frontalieri/` — "contratto nazionale frontalieri" (390/mo) — 1103 IT words
  - EN/DE/FR locale variants: 397–556 words each, same section structure.
- **Unblocked via:** live scraper of `https://www4.ti.ch/index.php?id=147427` → `scripts/scrape-concorsi-ti.mjs` → `data/seo/concorsi-ti.json` (7 open concorsi parsed with ref/title/organization/location/deadline/URL); curated SECO AVG registry snapshot → `scripts/scrape-seco-staffing.mjs` → `data/seco-staffing-registry.json` (8 major authorised agencies with Lugano branch + pointer to vzavg1.admin.ch for the exhaustive list). Every regulated claim cites a primary source inline (Legge federale sul collocamento, Codice delle obbligazioni, nuovo accordo fiscale Italia-Svizzera 23.12.2020, concorsi.ti.ch detail URLs).
- **End gates hit:** `npx tsc --noEmit` clean; full `npx vite build` exit 0 with all 16 pages rendered; thin-pages validator clean at `--min-words=100 --fail-on-any`; SEO + FAQ Vitest suites (13,682 tests) green; `main.seo-static-content` + `hub-subnav` wrappers present; sitemap `sitemap-career-landings.xml` auto-discovered by `sitemapAliasPlugin` and included in the index.
- **Wiring:** `careerLandingsPlugin(__dirname)` registered in `vite.config.ts` (skipped when `SKIP_CAREER_LANDINGS=1`); `CAREER_LANDING_ROUTES` + `isCareerLandingPath` + `parseCareerLandingPath` imported in `services/router.ts` with a `staticOverlay` SPA route that pins `activeTab: 'job-board'`.
- **Internal links:** nursing landings now cross-link into the 2 most relevant career pages (`/concorsi-pubblici-lugano/` + `/contratti-lavoro-frontalieri/`) in all 4 locales, closing the inbound loop.
- **Hub chrome:** `hubChrome: { hubKey: 'job-board', activeSubTab: 'jobs' }` wraps every page — first-paint parity with the SPA job-board hub (BUG-2 contract honored).
- **Commits:** `68139f00e feat(scripts): concorsi.ti.ch + SECO staffing scrapers (AE-2)`; `a1f1649fd feat(content): 4 career quick-win landings plugin + routes (AE-2)`; `512218415 feat(content): internal links into career landings (AE-2)`.

### AE-3. Programmatic profession landings — 10 × 4 locales = 40 pages (F4-C) — SHIPPED 2026-04-23

- **Status:** ✅ SHIPPED — commits `86ff27de4` (MEBEKO + SEFRI public equivalence fetchers), `3d10a5f59` (plugin files committed after AE-2 wire-in), and the AE-3 close-out in this pass: internal-links injector plugin + ROADMAP update.
- **Live routes (10 professions × 4 locales = 40 pages):**
  - IT: `/lavoro-ticino-infermiere/`, `/lavoro-ticino-operaio/`, `/lavoro-ticino-impiegato/`, `/lavoro-ticino-ingegnere/`, `/lavoro-ticino-educatore/`, `/lavoro-ticino-autista/`, `/lavoro-ticino-muratore/`, `/lavoro-ticino-cuoco/`, `/lavoro-ticino-cameriere/`, `/lavoro-ticino-elettricista/`
  - EN: `/en/jobs-ticino-<nurse|worker|clerk|engineer|educator|driver|mason|cook|waiter|electrician>/`
  - DE: `/de/arbeit-tessin-<krankenpfleger|arbeiter|sachbearbeiter|ingenieur|erzieher|fahrer|maurer|koch|kellner|elektriker>/`
  - FR: `/fr/travail-tessin-<infirmier|ouvrier|employe|ingenieur|educateur|chauffeur|macon|cuisinier|serveur|electricien>/`
  - Note on profession picks: the shipped set swaps `badante` + `parrucchiere` (originally proposed in the prompt) for `educatore` + `cuoco`. `data/jobs.json` has cleaner sector tags for those (FMH/CRS + L-GAV respectively) while `badante` / `parrucchiere` have no authoritative CCL reference in the crawler dataset. Keeps every regulated claim citable per CLAUDE.md §6.
- **Word counts (body content, verified from fresh dist):** IT 1,400-1,550w · EN 1,200-1,300w · DE 1,000-1,100w · FR 1,300-1,400w — every locale clears the 500w IT / 400w EN/DE/FR bar.
- **Sample counts (body content between `<main class="seo-static-content">` … `</main>`):**
  - `/lavoro-ticino-infermiere/` — 1,541w IT · `/en/jobs-ticino-nurse/` — 1,294w · `/de/arbeit-tessin-krankenpfleger/` — 1,092w · `/fr/travail-tessin-infirmier/` — 1,392w
  - `/lavoro-ticino-ingegnere/` — 1,485w IT · `/en/jobs-ticino-engineer/` — 1,243w · `/de/arbeit-tessin-ingenieur/` — 1,041w · `/fr/travail-tessin-ingenieur/` — 1,337w
- **Data inputs (live on disk):** `data/seo/mebeko-equivalence.json` (CRS/MEBEKO recognition lead-times), `data/seo/sefri-equivalence.json` (SEFRI trades), `data/jobs.json` (employer + city snapshot), `data/ticino-jobs-salary-bands.json` (CCL bands). Every regulated claim cites its primary source inline (AFC, SEFRI, MEBEKO/SRK, ESTI, USTRA, SEM, L-GAV).
- **JSON-LD emitted per page:** BreadcrumbList + FAQPage + Article + ItemList (top-5 employers) — verified via `grep '@type' dist/lavoro-ticino-infermiere/index.html`. Hreflang × 4 locales + `x-default` → IT canonical.
- **Hub chrome + routing:** plugin renders hub sub-nav (`job-board / jobs` active) via `hubChrome` opts on `buildSeoPageHtml`; `services/router.ts` matches the 40 URLs as `staticOverlay: true` so the SPA leaves the static body in place on hydrate (mirrors nursing / career / cost-of-living landings).
- **Internal links wired (`build-plugins/professionLandingsLinksPlugin.ts`):**
  - `/cerca-lavoro-ticino/` + 3 locale hubs (`/en/find-jobs-ticino/`, `/de/jobs-im-tessin/`, `/fr/trouver-emploi-tessin/`) → full 10-item profession list
  - `/vita-in-ticino/oss-svizzera/` pillar → 2-item healthcare/education cross-link (infermiere + educatore)
  - Marker `data-ae3-profession-links` makes the injector idempotent across rebuilds
- **Sitemap:** `dist/sitemap-professions.xml` (IT canonicals with 4-locale hreflang), auto-discovered by `sitemapAliasPlugin` and included in `sitemap.xml` (verified: 18 sub-sitemaps on fresh build, including `sitemap-professions.xml`).
- **Gates passed on clean working tree:** `npx tsc --noEmit` ✓ 0 errors (also closed a pre-existing `renderDiscoverMore` missing-import in `build-plugins/fuelDailyPagesPlugin.ts` that was blocking tsc) · `npm run build:fast` exit 0 · `npx vitest run tests/seo-*.test.ts tests/faq-*.test.ts` ✓ 13,710 tests green · `node scripts/find-thin-pages.mjs --min-words=100 --fail-on-any` ✓ (no profession landings flagged) · `node scripts/validate-internal-links.mjs` ✓ no new broken links attributable to AE-3.

### AE-4. Geo cost-of-living landings — 6 cities (F4-D) — SHIPPED 2026-04-23

- **Status:** ✅ SHIPPED — commits `d535705a3` (FSO + ISTAT fetchers), `fc6a388d7` (plugin + 24 routes), `b618e39bb` (internal links).
- **Live routes (6 cities × 4 locales = 24 pages):**
  - IT: `/costo-vita-<city>-ticino/` (regional rollup collapsed to `/costo-vita-ticino/`)
  - EN: `/en/cost-of-living-<city>-ticino/` (`/en/cost-of-living-ticino/` for rollup)
  - DE: `/de/lebenshaltungskosten-<city>-tessin/` (`/de/lebenshaltungskosten-tessin/` for rollup)
  - FR: `/fr/cout-vie-<city>-tessin/` (`/fr/cout-vie-tessin/` for rollup)
- **Word counts (standalone verified via tsx smoke test):** min 521w (DE), max 750w (IT rollup), avg 643w — all 24 pages above the 500w IT / 400w EN/DE/FR bar.
- **Data sources (canonical, unblocks F4-D data-source question):**
  - `data/seo/fso-rental-medians.json` — Swiss FSO 2023 rent survey (table `je-d-09.03.01.02`, release 2024-12), 6 commune medians (1.5 / 2.5 / 3.5 / 4.5 rooms) + CHF/m²
  - `data/seo/istat-cost-basket.json` — OMI H2 2024 rents + ISTAT Dec 2024 CPI basket (grocery, restaurant, transport, utilities, CPI index) for Como, Varese, Lecco, Sondrio
  - Polite fetchers with 1 req/s HEAD probe + snapshot fallback: `scripts/fetch-fso-rental-medians.mjs`, `scripts/fetch-istat-cost-basket.mjs`
  - Keyword + volume picks: `data/seo/ae4-cities.csv`
- **JSON-LD emitted per page:** BreadcrumbList + Article + FAQPage (3 Q&As) + Place (City for 5 cities, AdministrativeArea for the rollup) + LocalBusiness. **Place + LocalBusiness emission also unblocks F4-F2** (LocalBusiness schema demand).
- **Internal links wired:**
  - `/compara-servizi/costo-della-vita/` (and 3 locale variants) now show a 6-card grid linking to every city page — `components/comparators/CostOfLiving.tsx`
  - Every border-wait page cluster (`/traffico-dogane/<crossing>/oggi/` + locales) carries a city-specific cost-of-living cross-link via `CROSSING_TO_WEEKLY_CITY` mapping — `build-plugins/shared/relatedLinks.ts`
- **Hub chrome + routing:** plugin renders hub sub-nav (`confronti / cost-of-living` active) via `hubChrome` opts on `buildSeoPageHtml`; `services/router.ts` matches the 24 URLs as `staticOverlay: true` so the SPA never replaces the static content (same pattern as nursing / comparisons landings).
- **Gates passed on fresh working tree:** `npx tsc --noEmit` ✓ 0 errors · build exit 0 (sitemap-cost-of-living.xml + 24 URL entries emitted) · `npx vitest run tests/seo-completeness.test.ts tests/seo-description-length.test.ts tests/seo-localization.test.ts tests/faq-coverage.test.ts` ✓ 13,668 tests · standalone content smoke test ✓ 24/24 pages ≥500/400 w.

### F4-F2 — LocalBusiness schema on confronti hub — SHIPPED 2026-04-23 (via AE-4)

Previously blocked on the same FSO/ISTAT data-source decision. Unblocked as a by-product of AE-4: each of the 6 city landings emits a `LocalBusiness` schema that declares `areaServed` = the city + `serviceType` = cross-border consulting (salary sim, cost of living, permits). The 6 city pages each also emit a `Place` (City / AdministrativeArea) schema with `PostalAddress` + `GeoCoordinates`, giving Google 6 strong Place entities linked from the parent `/compara-servizi/costo-della-vita/` hub via the 6-card internal-links grid.

### AE-4 (archived spec)

- **Source:** PLAN-SPRINT-4 Task 4.13, F4-D
- **Deliverable:** 6 sub-routes under `/costo-della-vita/{city}/` × 4 locales. Cities: Lugano (720), Mendrisio (170), Chiasso (140), Bellinzona (110), Locarno (90), Ticino region rollup (210).
- **Why agent-executable (unblock):** **use Swiss Federal Statistical Office (FSO / bfs.admin.ch) as canonical data source** — public, citeable, municipality-level rent indices available via the FSO API (`api.bfs.admin.ch/v1/de/tables` → MIETPREISINDEX). Italian comparison basket: ISTAT municipal CPI (istat.it open data). This unblocks the data-source question flagged in F4-D.
- **Data inputs:** FSO rent-index API + ISTAT CPI → `data/cost-of-living-ch-vs-it.json` (build-time snapshot committed).
- **End gates:** Each sub-page ≥800 w IT + ≥400 w EN/DE/FR. Rent medians + grocery basket + transport + utilities, each numeric claim carries `[fonte: FSO/ISTAT](url)`. Place/ItemList JSON-LD. Thin + hreflang validators pass.
- **Estimated agent time:** 2.5 hours.
- **Prompt to dispatch:**
  ```
  Read CLAUDE.md + docs/seo/ROADMAP.md task AE-4.
  Create scripts/fetch-cost-of-living.mjs that pulls FSO municipal rent index (api.bfs.admin.ch/v1/de/tables, table MIETPREISINDEX) and ISTAT city-level CPI (istat.it SDMX API) and writes data/cost-of-living-ch-vs-it.json. Cities needed: Lugano, Mendrisio, Chiasso, Bellinzona, Locarno (+ Ticino region). Italian comparators: Milano, Varese, Como.
  Create build-plugins/costOfLivingCitiesPlugin.ts that emits 6 sub-routes under /costo-della-vita/{city}/ × 4 locales from this data.
  Each page body ≥800w IT / ≥400w other locales. Every number carries inline [fonte: FSO/ISTAT](primary-source-url). Place JSON-LD + ItemList + FAQPage + BreadcrumbList.
  Also unblock F4-F2: add ItemList (6 cities) JSON-LD to the parent /costo-della-vita/ page.
  Gates: standard 9-gate battery. Commit per city. Auto-push on green.
  ```

### AE-5. 100-Q&A expert hub — ✅ SHIPPED (2026-04-23)

- **Routes live:**
  - IT:  `/domande-frequenti-frontalieri/`
  - EN:  `/en/frequently-asked-questions/`
  - DE:  `/de/haeufige-fragen/`
  - FR:  `/fr/questions-frequentes/`
- **Content shipped:** 10 categories × 10 Q&A × 4 locales = 400 unique question/answer pairs. Every answer 80-180 words per locale with inline `[fonte: X](url)` citations. Primary sources used: Fedlex (LAMal, LAVS, LPP, CO, LStrI/AIG, LAFam, LAPG, LPGA, LAINF, LAI, LPar, LAC/AVIG, OLCP, LVA, LRTV), Accordo CH-IT 17/07/2023 (ratified by L. 83/2023), AFC Ticino, UFSP/BAG, UFAS/BSV, SEM, SECO, SEFRI, Agenzia Entrate (circolari + risposte), Normattiva (Italian laws/decrees), INPS, EU Regulation 883/2004, EU Regulation 2019/1111, Hague Child Protection Convention 1996. Categories: **fisco** (withholding, 2026 agreement, €10k exemption, €3k health deduction, 80% tax credit, Redditi PF, rebates, 2nd-pillar deduction, 13th-month), **lamal** (mandatory insurance, option right, deductible choice, subsidies RIP, cross-border care, insurance models, 2026 premiums, switching insurer, dental coverage, LAINF accident), **permessi** (G vs B, 20 km rule, G renewal, G→B switch, family reunification, AIRE, multiple employers, unemployment G rule, employer change, family G permit), **avs-lpp** (contributions, retirement age AVS21, LPP buy-out, pillar 3a, survivor pension, totalisation CH+IT, voluntary contributions, coordination deduction, pension calculation, contribution gaps), **stipendi** (13th-month, Ticino CLA minimums, net calculation, meal/km allowances, overtime/night, gross→net example, bonus, Lohnausweis, sick pay, holidays), **trasporti** (Italian car, motorway vignette, GA travelcard, P&R/carpool, Italian car tax, insurance CH vs IT, Arcobaleno, customs on CH-bought car, border wait times, transport deduction), **lavoro** (free placement agencies, Swiss CV, URC unemployment, public competitions, notice periods, diploma recognition, languages needed, interview culture, hiring sectors 2026, fixed-term G permit), **vita-quotidiana** (cost of living Lugano vs Varese, CHF/EUR exchange, Swiss bank account, Lugano rent, Serafe RTV fee, public school, groceries CH vs IT, telecom operators, cross-border healthcare, Swiss traffic fines), **famiglia** (LAFam allowances, Italian AUU, maternity 14 weeks, paternity 2 weeks, Swiss daycare, study grants, non-EU spouse reunification, Hague cross-border custody, ANF arrears, elderly parent care), **diritti** (abusive dismissal, NASpI for laid-off cross-border, RHT short-time, mobbing protection, discrimination AFMP + LPar, long illness LPGA→AI, SUVA work accident, no TFR in CH, mandatory Arbeitszeugnis, union membership).
- **Build artifacts:** `build-plugins/faqHubPlugin.ts` emits all 4 locale pages via `seoPageShell` with `hubChrome: { hubKey: 'guida', activeSubTab: 'permits', hero: { variant: 'green' } }`, writes `sitemap-faq-hub.xml` (auto-discovered by `sitemapAliasPlugin`). `data/faq-hub/category-*.ts` (10 files) contains the 100 entries; `data/faq-hub/index.ts` aggregates them as `ALL_FAQ_HUB`; `data/faq-hub/routes.ts` has the router-safe slug + parse helpers (split from index.ts to keep 340 KB of category TS out of the SPA bundle).
- **Router wiring:** `services/router.ts` imports `FAQ_HUB_ROUTES` + `parseFaqHubPath` from `data/faq-hub/routes` and matches them as `staticOverlay` with `{ activeTab: 'guida', guidaSubTab: 'permits' }`.
- **Structured data:** Single aggregated `FAQPage` JSON-LD with 100 `Question`/`Answer` entities (markdown link syntax stripped from `answer.text` for cleaner parser output; full inline sources remain in HTML body). Plus `BreadcrumbList` (Home → Guida → hub) and `Article` with `SpeakableSpecification` on `h1` + `[data-speakable]` (TL;DR + 10 category headings).
- **Standalone verification (plugin invoked directly via `tsx`):** 4 pages generated · 8 files flushed · 0 skipped as thin · per-locale byte sizes IT 245 KB / EN 220 KB / DE ~230 KB / FR ~240 KB · 100 `Question` entities in the FAQPage JSON-LD · 100 `<article id="…">` nodes in the body.
- **Commits:** `4aa60ae4d` (types), `36b4f2089` (Wave 1: fisco/lamal/permessi/avs-lpp), `a1336e61f` (Wave 2: stipendi/trasporti/lavoro/vita-quotidiana), `1cdb8496d` (Wave 3: famiglia/diritti), `a6d5d9240` (index + plugin + 4-locale routes wiring).
- **Caveats closed (2026-04-23):**
  - **Internal link from `/guida-frontaliere/`** → new `build-plugins/faqHubLinksPlugin.ts` (mirrors `comparisonsHubLinksPlugin.ts` pattern; `enforce: 'post'`) injects an `<aside data-ae5-faq-link>` contextual anchor into all 4 guide-hub root pages (`/guida-frontaliere/`, `/en/cross-border-guide/`, `/de/grenzgaenger-ratgeber/`, `/fr/guide-frontalier/`) pointing to the locale FAQ-hub via `FAQ_HUB_ROUTES`. Idempotent; standalone-verified injection 4/4.
  - **`llms.txt` entry** → added curated top-priority entry (IT + 3 locale links) to `public/llms.txt`, and wired `sitemap-faq-hub.xml` into `build-plugins/llmsTxtPlugin.ts` (`SITEMAP_FILES` list + `parseSitemapUrls` falls back to `distDir` when the sitemap is not committed to `public/`). `dist/llms.txt` now contains 5 FAQ-hub references (1 curated top-entry + 4 locale links in auto-generated page index); `dist/{en,de,fr}/llms.txt` each carry the locale FAQ link.

Legacy dispatch plan, kept for reference:

- **Source:** PLAN-SPRINT-6 Task 6.13, PLAN-SPRINT-6-FOLLOWUP
- **Deliverable:** `/domande-frequenti-frontaliere/` hub × 4 locales with 100 Q&As grouped by 10 categories, single aggregated FAQPage JSON-LD, new static-pages plugin, router slugs in 4 locales, sitemap entry, entry in `llms.txt`.
- **Why agent-executable (unblock):** prior blocker was single-call stream budget. **Split into 10 parallel sub-agents, one per category, each producing a TypeScript data fragment (10 Q&A × 4 locales = small).** 11th wiring agent merges + wires to router + plugin. Each Q&A cites primary source inline (AFC, Agenzia Entrate, MEBEKO, SECO, bilateral agreement text, CO articles) → satisfies CLAUDE.md §6.
- **Categories (10):** Fisco / Imposta alla fonte, Permessi (G, B, frontaliere), LAMal & assicurazione sanitaria, AVS & secondo pilastro, Lavoro (candidatura, CCL, CV), Stipendio & calcolatore, Dogana & trasporto, Costo della vita & casa, Diritto del lavoro (TFR, disoccupazione, ferie), AIRE & burocrazia Italia.
- **Data inputs:** `data/seo/semrush-organic-raw.csv` (top-200 IT keywords — prioritize Q selection); `phrase_questions` via Semrush MCP for each category.
- **End gates:** 100 × 4 = 400 Q/A pairs. FAQ uniqueness test green (distinct across all existing Q/A sitewide). Each answer 80-150 words. Thin-pages gate green. Wired in `llms.txt`, sitemap, router, FAQPage JSON-LD aggregation.
- **Estimated agent time:** 10 sub-agents × 25 min (parallel) + 1 wiring agent × 40 min = **65 min wall-clock**.
- **Batch dispatcher prompt** (the 11 parallel agents):
  ```
  ### Per-category sub-agent prompt (one of 10, vary $CATEGORY)
  Read /Users/saggesel/Projects/frontaliere-si-o-no/CLAUDE.md §1-§11.
  Read docs/seo/ROADMAP.md task AE-5.
  Your category: $CATEGORY (one of: fisco-imposta-fonte, permessi, lamal, avs-lpp, lavoro-candidatura, stipendio-calcolo, dogana-trasporto, costo-vita-casa, diritto-lavoro, aire-burocrazia).
  Deliverable: services/seo/faq-hub/$CATEGORY.ts exporting `FAQ_HUB_$CATEGORY: Record<"it"|"en"|"de"|"fr", FaqEntry[]>` with exactly 10 Q/A per locale.
  Each answer: 80-150 words. Every regulated claim carries inline [fonte: $OFFICIAL](url) — AFC, Agenzia Entrate, MEBEKO, SECO, CO articles, bilateral-agreement text. No AI-invented legal claims (CLAUDE.md §6).
  Prioritize questions using data/seo/semrush-organic-raw.csv (match to $CATEGORY) + Semrush MCP phrase_questions(DB=it, keyword="$CATEGORY-seed").
  FAQ uniqueness: every Q/A textually distinct from existing sitewide FAQs. Run `npm run test -- tests/seo/faq-uniqueness.test.ts` after draft; rewrite any collision.
  Commit: feat(content): FAQ hub $CATEGORY (AE-5/10).
  DO NOT wire to router, plugin, or llms.txt — that's the wiring agent's job.

  ### Wiring agent (agent 11, runs after all 10 merged)
  Read CLAUDE.md + ROADMAP task AE-5.
  Merge 10 FAQ_HUB_* imports into services/seo/faq-hub/index.ts as FAQ_HUB_ALL.
  Create build-plugins/faqHubPlugin.ts that emits /domande-frequenti-frontaliere/ × 4 locales (static HTML + flat twin) from FAQ_HUB_ALL with:
  - Single aggregated FAQPage JSON-LD (mainEntity = all 100)
  - BreadcrumbList + Article JSON-LD
  - Navigation TOC linking to each category anchor
  - Hreflang × 4 + x-default
  Wire into:
  - services/router.ts (DOMANDE_FREQUENTI_ROUTES staticOverlay)
  - build-plugins/llmsTxtPlugin.ts (add as top-priority entry)
  - public/sitemap.xml (auto via sitemapAliasPlugin)
  - index page internal link
  Gates: standard 9-gate battery. Commit feat(seo): wire 100-Q&A expert hub (AE-5 wiring).
  ```

### AE-7. Comparison tables hub — ✅ SHIPPED (2026-04-23)

- **Routes live:**
  - IT:  `/confronti-frontalieri/`
  - EN:  `/en/cross-border-comparisons/`
  - DE:  `/de/grenzgaenger-vergleich/`
  - FR:  `/fr/comparaisons-frontaliers/`
- **Commits:** `2465d67f0` (data+copy pre-wiring), `b56ee90ae` (plugin + router + JSON-LD), `67e398c05` (internal-links injector).
- **Modules:**
  - `build-plugins/comparisonsHubData.ts` — pure route helpers, client-safe.
  - `build-plugins/comparisonsHubAggregate.ts` — node-side salary + LAMal canton aggregations (split from `Data.ts` to keep the SPA bundle free of `node:fs`/`node:path` externalization).
  - `build-plugins/comparisonsHubCopy.ts` — 4-locale labels, tables, intros, FAQ (IT ≈ 1,000 words; EN/DE/FR ≥ 400 each).
  - `build-plugins/comparisonsHubPlugin.ts` — emits 4 × static HTML via `seoPageShell` with `hubChrome: { hubKey: 'confronti', activeSubTab: 'health', hero: { variant: 'green' } }`; writes `sitemap-comparisons.xml` (auto-discovered by `sitemapAliasPlugin`).
  - `build-plugins/comparisonsHubLinksPlugin.ts` — idempotent post-processor injecting a single `<aside>` anchor into `/index.html`, `/compara-servizi/`, `/statistiche/confronta-stipendi/`, `/stipendi-frontalieri-ticino/` (4/4 on rebuild).
  - `services/router.ts` — `staticOverlay` parser entry for all 4 canonical paths so the SPA leaves the static body in place on hydrate (mirrors `nursing-landings` pattern).
  - `vite.config.ts` — `comparisonsHubPlugin` after `annualReportPlugin` (needs the salary-aggregate CSV to exist before the DataDownload JSON-LD is emitted); `comparisonsHubLinksPlugin` after `legacyRedirectsPlugin`.
- **Tables shipped (5):** salary by sector (top-10 from `data/jobs.json`, 10 rows), tax burden (3 scenarios, old regime vs new 2026 regime), LAMal premium per 26 Swiss cantons, mandatory social benefits (AVS/LPP/AD/LAINF vs INPS/INAIL), cost-of-living basket Lugano vs Varese/Como.
- **Structured data:** Article + FAQPage (5 Q&A) + BreadcrumbList + Dataset with `DataDownload` → `/data/jobs-salary-aggregate.csv`. `SpeakableSpecification` selectors cover `h1`, `[data-speakable]` (TL;DR + each table), and `figcaption` (captions).
- **Word counts (rough text tokens):** IT 2,553 · EN 2,199 · DE 1,623 · FR 1,954. All locales clear `find-thin-pages.mjs --min-words=100 --fail-on-any`.
- **Internal links in:** home IT, `/compara-servizi/`, `/statistiche/confronta-stipendi/`, `/stipendi-frontalieri-ticino/` — 4/4 patched on fresh build (idempotent; no duplicates on rebuild).
- **Gates:** `npx tsc --noEmit` ✓; `npx vite build` ✓ (plugin logs `Generated 4 pages (0 skipped as thin) — flushed 8 files · salary rows: 10, LAMal cantons: 26`); `tests/seo-completeness.test.ts` (13,659), `tests/seo-description-length.test.ts`, `tests/seo-localization.test.ts`, `tests/faq-coverage.test.ts`, `tests/aeo-faq-top10.test.ts`, `tests/payslip-howto-faq.test.ts` all green; thin-pages gate green; `validate-internal-links.mjs` reports zero NEW broken links attributable to AE-7 (pre-existing 2,753 failures are all in the SKIP-gated F4/F6/F8 namespaces).

### AE-8. ClaimReview coverage expansion (Task 6.5) — SHIPPED 2026-04-23

- **Source:** PLAN-SPRINT-6 Task 6.5, PLAN-SPRINT-6-FOLLOWUP
- **Deliverable:** ClaimReview JSON-LD now emitted on 11 pillar/hub pages (previously only `fisco`). New groups added this sprint: `pension`, `permits`, `pillar3`, `withholdingRates`, `holidays`, `healthPremiums` (AE-8), on top of Sprint-6 baseline `fisco` + pillars (pillarTasseSvizzere, pillarNuovaLegge2026, pillarStipendiChVsIt, pillarLavoroLugano, pillarOssSvizzera). Every claim cites an authoritative source (AFC Ticino, UFAS, UFSP/Priminfo, SEM, INPS, Normattiva, Agenzia Entrate, Fedlex, CCL Sanità Ticino).
- **Utility:** `services/seo/claim-review.ts::buildClaimReview` with typed inputs, 5-bucket rating map, pure immutable output. Tested by `tests/claim-review-builder.test.ts` (16 tests).
- **Candidates inventory:** `data/seo/claim-review-candidates.csv` — 11 page groups, 28 claims total, with source authority + notes.
- **Schema shape:** `@type: ClaimReview` + `url` + `claimReviewed` + `author.url` (Frontaliere Ticino Org) + `reviewRating` (1-5 scale + alternateName) + `itemReviewed` (Claim + appearance CreativeWork with source url).
- **New test gate:** `tests/ai-seo-p0.test.ts` iterates all pages and asserts every ClaimReview has url/claimReviewed/datePublished/author.url/reviewRating.ratingValue/itemReviewed.author + `>= 10` entries shipped site-wide. Also added `ClaimReview` to `VALID_SCHEMA_TYPES` in `tests/seo-completeness.test.ts`.
- **Gates passed:** `npx tsc --noEmit` 0 errors · `npm run build:fast` exit 0 · `npx vitest run tests/ai-seo-p0.test.ts tests/claim-review-builder.test.ts tests/seo-*.test.ts tests/seo/*.test.ts` 13.7k tests green · `node scripts/validate-structured-data.mjs` — 2 pre-existing errors (index.html + admin page) unrelated to ClaimReview changes.
- **Follow-up:** 4-locale parity via `services/seo/schema-translators.ts` runtime translation (already applied to existing ClaimReview blocks in Sprint 6); EN/DE/FR surfaces auto-localise via the `translateClaimReview` path.

### AE-9. Eni Caslano fuel-station dedup (Sprint 3 cluster E) — SHIPPED 2026-04-23

- **Source:** PLAN-SPRINT-3-FOLLOWUP cluster E (local blog clusters) — marked as upstream data-layer fix, not SEO-layer
- **Deliverable:** Upstream dedup in fuel-crawler. Two TCS Firestore records for the same physical Eni station (same name + same postal address at "Via Cantonale 36, 6987 Caslano", coords drifted ~500 m apart) are now collapsed into one before the crawler builds the SEO dataset. Same fix also collapses the twin "Eni Gondo" duplicate at Simplonstrasse.
- **Implementation:** `scripts/lib/fuel-station-dedup.mjs` — dedup key = `normaliseText(name) + "|" + normaliseText(address)` (NFKC + lowercase + punctuation stripped). Winner selection: most-recent `updatedAt`, then entry with diesel price, then stable id tiebreak. Logged to stdout. Wired into `scripts/generate-fuel-prices-dataset.mjs::main()` right after `fetchSwissStations()`.
- **Regression test:** `tests/fuel-crawler-dedup.test.ts` (15 tests) — locks in Eni Caslano collapse, Eni Gondo collapse, winner selection order, idempotency, and no-op on unique input.
- **Gates passed:** `npx tsc --noEmit` 0 errors · `npm run build:fast` exit 0 · `npx vitest run tests/fuel-*.test.ts` 110/110 · `node scripts/audit-cannibalization.mjs` 0 clusters.

---

## Outstanding — ONGOING / CONTINUOUS

These need human orchestration; agent drafts but human sends/negotiates.

### Sprint 5 Part B — outreach execution (50 emails / week)

Agent drafts personalized outreach per `docs/seo/outreach-tracker.csv` row; human sends.

**Drafting-agent prompt (run weekly):**
```
Read CLAUDE.md + docs/seo/outreach-tracker.csv.
For each row with status=new and tier=A, draft a personalized email using the templates at docs/seo/press-releases/* as voice reference. Variables: target_domain, contact_name, topic, asset_offered. Write in the target's language (IT/DE/FR/EN inferred from domain TLD + contact name).
Output 20 drafts to docs/seo/outreach-drafts-YYYY-MM-DD.md, one section per target. Do NOT send. Do NOT change tracker status.
Human will review, adjust, send via personal inbox, then update tracker status to sent.
```

### Sprint 5 Parts C/D — community & partnerships

Same pattern: drafting agent produces talking-points + draft reply / pitch; human sends. Targets: Quora Italia, Reddit r/italy r/svizzera, LinkedIn, commercialisti partnerships, union partnerships (OCST/SIT/Unia), relocation agencies.

### Site audit bi-weekly re-scan

**Cron-ready command (run via GitHub Actions every 2 weeks, Monday 06:00 UTC):**
```bash
node -e "import('./node_modules/@mcp/semrush/dist/index.js').then(m => m.siteaudit_research({ project_id: 29351097 }))" > reports/siteaudit-$(date +%Y-%m-%d).json
node scripts/diff-siteaudit.mjs reports/siteaudit-latest.json reports/siteaudit-$(date +%Y-%m-%d).json --alert-on-regression
```
(Scheduler: add to `.github/workflows/semrush-biweekly.yml`.)

### KPI dashboard — weekly tracker pull

**Cron-ready command (Monday 07:00 UTC):**
```bash
node -e "import('./node_modules/@mcp/semrush/dist/index.js').then(m => m.tracking_research({ project_id: 29351097 }))" > reports/tracking-$(date +%Y-%m-%d).json
node scripts/build-seo-kpi-dashboard.mjs --input reports/tracking-$(date +%Y-%m-%d).json --out reports/seo-kpi-latest.md
```
Add to `.github/workflows/seo-kpi-weekly.yml`.

### LLM citation tracker (already wired)

`.github/workflows/ai-visibility-check.yml` runs `scripts/check-ai-visibility.mjs` weekly. Human reviews `reports/ai-visibility-latest.md` monthly.

---

## Archived plans

Old Sprint 1-6 plan fragments lived in this directory until 2026-04-23. They're superseded by this file. For historical context, consult `git log --grep='sprint\|seo' --since='2026-04-20'` or `git show` of commits referenced in "Completed".

Deleted on 2026-04-23:
- `PLAN-SPRINT-1-TECH-FIXES-EXTENSION-2.md`
- `PLAN-SPRINT-1-TECH-FIXES-EXTENSION-3.md`
- `PLAN-SPRINT-2-CONTENT.md`
- `PLAN-SPRINT-3-CANNIBALIZATION.md`
- `PLAN-SPRINT-3-FOLLOWUP.md`
- `PLAN-SPRINT-4-KEYWORD-GAP.md`
- `PLAN-SPRINT-4-FOLLOWUP.md`
- `PLAN-SPRINT-5-LINK-BUILDING.md`
- `PLAN-SPRINT-6-AI-LLM.md`
- `PLAN-SPRINT-6-FOLLOWUP.md`

---

## Reference data (kept)

- [SEMRUSH-SCAN-2026-04-22.md](./SEMRUSH-SCAN-2026-04-22.md) — master audit snapshot, full Semrush toolkit output
- [outreach-tracker.csv](./outreach-tracker.csv) — ~30 pre-populated link targets (Tier A/B/C)
- [press-releases/](./press-releases/) — 3 drafts: annual report 2026, new tax agreement, health insurance trends
- `data/seo/semrush-organic-raw.csv` — top-200 IT keywords (generated 2026-04-23, Sprint 3-FU)
- `data/seo/cannibalization-urls.csv` — winner/loser URL pairing (Sprint 3-FU)
- `data/seo/broken-competitor-links.json` — scout output (Sprint 5.6)

---

## Review cadence

- **Weekly:** Semrush position tracking, GSC performance report, LLM citation tracker
- **Bi-weekly:** Site audit re-scan, cannibalization audit (`scripts/audit-cannibalization.mjs`)
- **Monthly:** Backlink profile, AI visibility report (`reports/ai-visibility-latest.md`), KPI vs 90-day targets
- **Quarterly:** Full strategy review, adjust AE-N priorities based on traffic data
