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

---

## 🔴 P0 BUGS — found live 2026-04-23 (must fix before AE-N work)

Screenshots from user show two structural problems on production `https://frontaliereticino.ch/` affecting every programmatic SEO page shipped in 2026-04.

### BUG-1. SPA navigation to programmatic landings dead-ends on home

**Symptom**: Clicking the home page cards/links for `/prezzi-diesel/oggi/`, LAMal landings, `/aziende-che-assumono/...`, and similar programmatic URLs does NOT navigate. URL changes but content stays on home (React re-renders home component).

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

### BUG-2. Programmatic landing pages miss the SPA chrome / visual system

**Symptom**: When `/prezzi-diesel/oggi/` is opened in a new tab, the page renders with the generic top header (logo + 6 nav tabs + search/lang/theme/CTA) but is missing the **sub-navigation bar** that hub pages like `/confronti/cambio-valuta` have (Cambio Valuta / Conti Correnti / Assicurazione Sanitaria / Telefonia Mobile / Spesa / Costo / Offerte Lavoro / Ristrutturazione tabs). Content cards render, but without the hub integration the page feels like a detached static island.

**Screenshots**:
- `/prezzi-diesel/oggi/` — breadcrumb "Home / Diesel / Chiasso", three data cards, NO sub-nav, NO pattern-matched hero.
- `/confronti/cambio-valuta` (reference) — sub-nav with 8 hub tabs, big green hero, "Avviso Importante" callout, pattern comparatori.

**Root cause hypothesis**: Build plugins (`fuelDailyPagesPlugin`, `healthPremiumsLandingPlugin`, `weeklyEmployersPlugin`, `borderWaitPagesPlugin`, `jobMarketSnapshotPlugin`, `orphanQueryLandingPlugin`) emit their own HTML bodies with a simplified layout. They use the shared header + footer (good), but skip the sub-tab bar and the hero/hub visual system. SPA hubs read sub-tab config from `services/navigation.ts` (or equivalent); the plugins don't.

**Fix plan**:
1. Extract the hub-chrome layout used by `/confronti/*` into a reusable component (`components/HubLayout.tsx` or similar) OR identify the existing shared layout module.
2. Classify each programmatic-landing family into a parent hub:
   - Prezzi diesel → new hub `/prezzi-carburante/` under Vita Quotidiana (or nest under Confronti if more appropriate)
   - LAMal → under Confronti → Assicurazione Sanitaria (sub-tab already exists)
   - Aziende che assumono → under Statistiche or Vita → new sub-tab
   - Mercato lavoro → under Statistiche → sub-tab already exists
   - Traffico dogane → under Vita Quotidiana / Guida
3. Either (a) render the sub-tab bar + hero via shared layout in each plugin's HTML emission, OR (b) if BUG-1 is fixed by SPA routing, the SPA will render these pages with the standard chrome automatically — plugins only need to emit seed HTML for SEO/first paint.
4. Verify the 6-tab hard cap in CLAUDE.md is not exceeded — new sub-tabs are fine, new top-level tabs are NOT.

**End gates**: Visual diff test (Playwright screenshot-based) on one page per affected family vs `/confronti/cambio-valuta` layout parity; `npx vitest run` green.

**Commit**: `refactor(ui): unify programmatic landings under shared hub chrome`.

---

## Outstanding work — AGENT-EXECUTABLE

Each task below has a ready-to-run prompt. Tasks are atomic (1 agent = 1 deliverable). All must pass the standard gates: `npx tsc --noEmit`, `npx vite build`, `npx vitest run`, `node scripts/validate-internal-links.mjs`, `node scripts/find-thin-pages.mjs --min-words=100 --fail-on-any`, `node scripts/validate-canonical.mjs`, `node scripts/validate-hreflang.mjs`, `node scripts/validate-structured-data.mjs`, FAQ uniqueness test. Launch each subagent with `model: "opus"`.

**Execution order enforced**: BUG-1 and BUG-2 MUST land before AE-1..AE-9 — otherwise new landings will inherit the same broken chrome.

### AE-1. Striking-distance optimisation, 6 existing pages (F4-B)

- **Source:** PLAN-SPRINT-4-KEYWORD-GAP Tasks 4.6-4.11, decomposed in PLAN-SPRINT-4-FOLLOWUP unit F4-B
- **Deliverable:** New H1/`<title>`/meta + intro + FAQ for `/job-board/company/medacta/`, `/vita/festivi/`, `/traffico-dogane/brogeda/`, `/guida/permesso-g/`, `/fisco/avs/`, `/calcolatore/` — 6 pages × 4 locales. Also: new script `scripts/gsc-position-snapshot.mjs` for baseline/regression.
- **Why agent-executable:** Semrush `organic_research` (IT DB) gives current position per URL; `url_research` gives before/after. No new data source needed.
- **Data inputs:** `data/seo/semrush-organic-raw.csv`, Semrush MCP `organic_research` + `url_research`, existing page content in `dist/`.
- **End gates:** H1 + `<title>` + meta contain exact target keyword. Body ≥600 words (≥500 for 4.9 specifically). FAQPage updated; uniqueness green. All 4 locales ship together.
- **Estimated agent time:** 40 min per page × 6 = 4 hours total.
- **Prompt to dispatch:**
  ```
  Read /Users/saggesel/Projects/frontaliere-si-o-no/CLAUDE.md (non-negotiables 1-11).
  Read docs/seo/ROADMAP.md task AE-1.
  Use Semrush MCP organic_research (DB=it) to snapshot current positions for these 6 URLs: /job-board/company/medacta/, /vita/festivi/, /traffico-dogane/brogeda/, /guida/permesso-g/, /fisco/avs/, /calcolatore/.
  For each URL, rewrite H1 + <title> + <meta description> + intro paragraph + add 3 FAQ Q/A pairs in IT, EN, DE, FR. Target keywords: medacta international sa rancate, festivi in ticino, valico brogeda, permesso g svizzera, avs frontalieri, calcolo stipendio frontaliere.
  Body ≥600 words per locale. FAQ uniqueness gate must stay green.
  Also create scripts/gsc-position-snapshot.mjs that pulls per-URL position from GSC Search Analytics API and writes data/gsc-positions.json; use the GOOGLE_APPLICATION_CREDENTIALS already wired for other scripts.
  Commit per-page with format `feat(seo): striking-distance optimisation for {slug} (AE-1)`.
  Final gates: npx tsc --noEmit && npx vite build && npx vitest run && node scripts/validate-internal-links.mjs && node scripts/find-thin-pages.mjs --min-words=100 --fail-on-any.
  Auto-push on green per CLAUDE.md.
  ```

### AE-2. Career landing pages — 4 quick-wins (F4-A)

- **Source:** PLAN-SPRINT-4 Tasks 4.1-4.4, decomposed in PLAN-SPRINT-4-FOLLOWUP unit F4-A
- **Deliverable:** 4 new pages × 4 locales = 16 HTML outputs + flat twins. New plugin `build-plugins/careerLandingsPlugin.ts` + `careerLandingsData.ts` + `careerLandingsCopy.ts`.
  - `/lavoro/agenzie-del-lavoro/lugano/` — "agenzie del lavoro lugano" (720, KD 18)
  - `/lavoro/concorsi-pubblici-lugano/` — "concorsi lugano" (720, KD 15)
  - `/lavoro/stage/lugano/` — "stage lugano" (260, KD 16)
  - `/guida/contratti-lavoro-frontalieri/` — "contratto nazionale frontalieri" (390)
- **Why agent-executable (unblock):** use **concorsi.ti.ch public portal scrape** (Cheerio, polite rate-limit) for concorsi — public data, citeable. For agenzie: list is publicly verifiable from REG (Registro delle agenzie autorizzate SECO/USAM). For CCNL/GAV: cite Ticino DFE + SECO official sector tables. Every regulated claim must cite the primary source inline (satisfies CLAUDE.md §6 + §3).
- **Data inputs:** concorsi.ti.ch crawler output → `data/concorsi-lugano.json`; SECO agency registry; existing `data/ticino-jobs-salary-bands.json`.
- **End gates:** Each page ≥800 words IT + ≥400 words EN/DE/FR, every legal assertion carries `[fonte: …](url)` citation. Hreflang × 4 + x-default. BreadcrumbList + FAQPage + Article JSON-LD. Thin-pages + internal-links validators pass.
- **Estimated agent time:** 2.5 hours (crawler + copy + plugin).
- **Prompt to dispatch:**
  ```
  Read /Users/saggesel/Projects/frontaliere-si-o-no/CLAUDE.md.
  Read docs/seo/ROADMAP.md task AE-2.
  Mirror the nursingLandingsPlugin pattern exactly. Create build-plugins/careerLandingsPlugin.ts + careerLandingsData.ts + careerLandingsCopy.ts.
  Add a Cheerio scraper scripts/crawl-concorsi-lugano.mjs that fetches concorsi.ti.ch (respect robots.txt, 2s pause between requests) and writes data/concorsi-lugano.json with deduplicated active concorsi.
  Author IT canonical copy ≥800w per page + EN/DE/FR ≥400w. Every regulated claim must cite primary source inline (SECO registry, Ticino DFE, CCNL/GAV per sector). Use format: [fonte: AFC](https://...).
  Wire into vite.config.ts, services/router.ts (CAREER_LANDING_ROUTES readonly string[]), sitemap via sitemapAliasPlugin auto-discovery.
  Gates: npx tsc --noEmit && npx vite build && npx vitest run && node scripts/find-thin-pages.mjs --min-words=100 --fail-on-any && node scripts/validate-internal-links.mjs && node scripts/validate-hreflang.mjs && node scripts/validate-structured-data.mjs.
  Commit atomically per page. Auto-push on green.
  ```

### AE-3. Programmatic profession landings — 10 × 4 locales = 40 pages (F4-C)

- **Source:** PLAN-SPRINT-4 Task 4.12, decomposed in F4-C
- **Deliverable:** `build-plugins/professionLandingsPlugin.ts` + data + copy, 10 professions × 4 locales, each ~600 w IT / ~400 w EN/DE/FR.
- **Why agent-executable (unblock):** use `data/jobs.json` existing profession/sector tags + MEBEKO public equivalence tables (scraped from mebeko.admin.ch) for healthcare + SECO/SEFRI for non-health + CCL sector salary bands from `data/ticino-jobs-salary-bands.json`. Professions with no clean sector tag (badante, parrucchiere, cameriere, muratore) pull broader "services" bucket — acceptable if copy honestly acknowledges the bucketing.
- **Data inputs:** `data/jobs.json` (profession tags), `data/ticino-jobs-salary-bands.json`, MEBEKO scrape → `data/mebeko-equivalences.json`.
- **End gates:** 40 HTML + 40 flat twins in `dist/`. Thin-content gate exits 0 at `--min-words=300`. Each page: BreadcrumbList + FAQPage + Article + ItemList of top-5 jobs for that profession. Hreflang × 4 + x-default.
- **Estimated agent time:** 3 hours (plugin + copy + translation cache).
- **Prompt to dispatch:**
  ```
  Read CLAUDE.md + docs/seo/ROADMAP.md task AE-3.
  Mirror nursingLandingsPlugin exactly. Create build-plugins/professionLandingsPlugin.ts + professionLandingsData.ts + professionLandingsCopy.ts for these 10 professions: infermiere, ingegnere, impiegato, operaio, badante, muratore, elettricista, autista, cameriere, parrucchiere.
  For healthcare: scrape MEBEKO public equivalence tables (scripts/crawl-mebeko.mjs → data/mebeko-equivalences.json). For non-health: SECO/SEFRI equivalences where available; otherwise cite Italian professional-equivalence guide URL.
  Build-time inject top-5 open positions from data/jobs.json filtered by profession tag; include as ItemList JSON-LD + visible table. Keep a stable snapshot of position count per profession (services/seo/profession-counts.json) updated via a prepare step to avoid word-count flicker.
  Seed translation cache entries in services/locales/{en,de,fr}-*.ts before first build.
  Gates: tsc + vite build + vitest + thin-pages (--min-words=300) + internal-links + hreflang + structured-data.
  Commit per profession. Auto-push on green.
  ```

### AE-4. Geo cost-of-living landings — 6 cities (F4-D)

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

### AE-5. 100-Q&A expert hub — 10 parallel sub-agents (batch dispatcher)

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

### AE-6. LLM-formatting content audit — top 30 pages (Task 6.8)

- **Source:** PLAN-SPRINT-6 Task 6.8, PLAN-SPRINT-6-FOLLOWUP "Content audit"
- **Deliverable:** Edits on 30 existing pages (content structure only, no copy inversion). Each: first-para 1-2-sentence topic definition, long paras (>100 w) broken into bullets, `<AiExtractableTable>` where applicable, "Key facts" callout via existing `SeoContentBlock` component.
- **Why agent-executable:** the top-30 set is knowable (Semrush `organic_research` top-30 by traffic). Each page edit is mechanical restructuring, not new copy — agent-safe.
- **Data inputs:** Semrush `organic_research` (DB=it, display_limit=30) for the URL list.
- **End gates:** Thin-pages gate unchanged (no word-count regression). Manual Playwright render check. FAQ uniqueness green.
- **Estimated agent time:** 3 hours (30 × 5 min edits + final build).
- **Prompt to dispatch:**
  ```
  Read CLAUDE.md + ROADMAP task AE-6.
  Pull top-30 URLs by organic traffic via Semrush MCP organic_research(domain=frontaliereticino.ch, database=it, display_limit=30). Save list to data/seo/top-30-urls.csv.
  For each of the 30 URLs, edit the corresponding React component or build-plugin template:
  1. First paragraph must define the topic in 1-2 sentences ("Il X è Y.").
  2. Break any paragraph >100 words into bullets or sub-paragraphs.
  3. Add a <SeoContentBlock variant="keyfacts"> (existing component) at top with 3-5 bullet key facts.
  4. Convert comparison prose into <AiExtractableTable> where the prose lists 3+ items with same shape.
  Do NOT reduce word count. Do NOT change factual claims. Run FAQ uniqueness + thin-pages validators.
  Commit atomically per URL: refactor(content): LLM-format {slug} (AE-6).
  Auto-push on green.
  ```

### AE-7. Comparison tables hub (Task 6.15)

- **Source:** PLAN-SPRINT-6 Task 6.15, PLAN-SPRINT-6-FOLLOWUP
- **Deliverable:** New page `/confronti-rapidi/` × 4 locales with dense comparison tables.
- **Why agent-executable:** all data already in codebase.
  - Permit B vs Permit G → `services/seo/pillars/nuovaLegge2026.ts` + existing permit guide
  - LAMal vs SSN → LAMal premiums data + Italian SSN article stub
  - Old vs new (2026) tax regime → `calculationService.ts` + nuova-legge pillar
  - Ticino cities for frontalieri → Sprint 2 `lavoro-lugano` pillar + cost-of-living
  - Swiss cantons LAMal costs → existing 26-canton LAMal dataset
- **Data inputs:** all local (no external fetch).
- **End gates:** 5 AiExtractableTable blocks. ≥800 w IT / ≥400 w other locales. Full JSON-LD suite (Article + FAQPage + BreadcrumbList). Router slug + sitemap + llms.txt entry.
- **Estimated agent time:** 90 min.
- **Prompt to dispatch:**
  ```
  Read CLAUDE.md + ROADMAP task AE-7.
  Create components/ConfrontiRapidiPage.tsx + add router slugs in all 4 locales + static HTML build plugin.
  Sections (each a <AiExtractableTable>):
  1. Permesso B vs Permesso G (pull from services/seo/pillars/nuovaLegge2026 + permesso-g guide)
  2. LAMal vs SSN italiano (LAMal 26-canton dataset + SSN stub)
  3. Regime fiscale vecchio vs nuovo 2026 (calculationService worked examples)
  4. Città Ticino per frontalieri (Lugano/Mendrisio/Chiasso/Bellinzona/Locarno) — salario medio, affitto, distanza valico
  5. Cantoni Svizzera LAMal costs — 26-canton table
  Body ≥800w IT + ≥400w EN/DE/FR. Article + FAQPage + BreadcrumbList JSON-LD. Wire into llms.txt + sitemap + internal links from homepage/guide hub.
  Gates: 9-gate battery + manual Playwright render check.
  Commit: feat(seo): comparison tables hub (AE-7). Auto-push on green.
  ```

### AE-8. ClaimReview coverage expansion (Task 6.5)

- **Source:** PLAN-SPRINT-6 Task 6.5, PLAN-SPRINT-6-FOLLOWUP
- **Deliverable:** `ClaimReview` JSON-LD on 10 pages stating verifiable tax/fiscal claims, each citing AFC / Agenzia Entrate / bilateral-agreement text as the authoritative source.
- **Why agent-executable:** claims are already in the pages; agent inventories and emits schema.
- **Data inputs:** existing pillar pages (`/fisco/*`, `/guida/frontalieri-nuova-legge-2026/`, `/premi-cassa-malati/`).
- **End gates:** New assertion in `tests/ai-seo-p0.test.ts` that ClaimReview JSON-LD validates against schema.org spec (itemReviewed.author.url + reviewRating + url). All 10 pages ship. Validator + structured-data gates pass.
- **Estimated agent time:** 70 min.
- **Prompt to dispatch:**
  ```
  Read CLAUDE.md + ROADMAP task AE-8.
  Inventory 10 pages making verifiable claims (tax rates, law references, LAMal premium changes). Suggested seed: /fisco/, /fisco/avs/, /fisco/secondo-pilastro/, /guida/frontalieri-nuova-legge-2026/, /premi-cassa-malati/, /guida/permesso-g/, /calcolatore/, /stipendi-svizzera-vs-italia/, /tasse-svizzere-guida-frontaliere/, /nuova-legge-frontalieri-2026/.
  For each, add ClaimReview JSON-LD: claimReviewed (the text claim), author (frontaliereticino.ch Organization), itemReviewed.author.url (AFC/Agenzia Entrate/bilateral-agreement URL), reviewRating (5/5 for verified claims), url (page URL).
  Add assertion in tests/ai-seo-p0.test.ts that ClaimReview entries validate schema.org-required fields.
  Gates: validate-structured-data + vitest + build. Commit: feat(ai-seo): ClaimReview coverage on 10 fiscal pages (AE-8). Auto-push on green.
  ```

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
