# Sprint 4 — Keyword Gap: Follow-up decomposition

**Status:** Sprint 4 auto-execution (2026-04-23) deferred to this follow-up after
a scope/quality audit. The original plan (`PLAN-SPRINT-4-KEYWORD-GAP.md`) asks
for ~17 tasks spanning new build plugins, 40+ new static pages across 4 locales,
20 FAQ additions × 4 locales, and schema work — with the non-negotiable
constraint that every new page ships ≥300 words of real content (CLAUDE.md §4),
`find-thin-pages.mjs --fail-on-any` stays green, and all 26.9k tests stay
green. That is multi-day work and cannot be landed in a single autonomous
session at quality.

This follow-up slices the plan into landable units. Each unit is independently
shippable and keeps the test baseline green.

---

## Already complete (audit findings 2026-04-23)

- **Task 4.16 — homepage Organization + WebSite/SearchAction + sameAs** — shipped.
  See `index.html` lines ~795-901:
  - `Organization` with `@id`, logo, `sameAs` (Facebook ×2, LinkedIn, GitHub),
    `contactPoint`, `areaServed`, `knowsAbout`.
  - `WebSite` with `potentialAction` → `SearchAction` + `query-input`.
  - `isBasedOn` linking to Canton Ticino DFE + GU Italiana law sources.
  No further action required on the homepage. Sprint 4 plan can mark 4.16(a) done.

---

## Unit F4-A — Part A quick-win static pages (4 pages × 4 locales = 16 HTML outputs)

**Scope:** Tasks 4.1, 4.2, 4.3, 4.4 from the original plan.

**Blockers before implementation:**
- Each page needs ≥800 words IT + ≥400 words EN/DE/FR of domain-true copy
  (agenzie interinali list, CCNL/GAV per sector, concorsi pubblici Lugano
  portal data, stage retribuzioni). Copy must be authored — no AI generation
  without fact-checking, because the content includes regulated claims
  ("agenzie non possono far pagare il candidato" is a legal assertion).
- Needs a live data source for Task 4.2 (Lugano concorsi portal scrape) —
  currently no crawler exists. Either add a Cheerio crawler under
  `scripts/crawlers/` or freeze a snapshot into `data/concorsi-lugano.json`.

**Implementation pattern:** extend `nursingLandingsPlugin` pattern — create
`build-plugins/careerLandingsPlugin.ts` + `careerLandingsData.ts` +
`careerLandingsCopy.ts`. Wire into `vite.config.ts`, router
(`NURSING_LANDING_ROUTES`-style readonly string[]), sitemap via
`sitemapAliasPlugin` auto-discovery.

**Acceptance:**
- 16 files in `dist/{locale}/.../index.html` + `.html` flat twin.
- Each file ≥300 words body copy measured by `countHtmlBodyWords`.
- Hreflang across 4 locales + x-default.
- BreadcrumbList + FAQPage + Article JSON-LD.
- `node scripts/validate-internal-links.mjs` and
  `node scripts/find-thin-pages.mjs --min-words=100 --fail-on-any` both exit 0.
- FAQ uniqueness test stays green — every Q/A pair distinct from existing
  FAQPage blocks project-wide.

**Estimated effort:** 1.5 days (copywriting is the bottleneck).

---

## Unit F4-B — Part B striking-distance optimisation (6 existing pages)

**Scope:** Tasks 4.6, 4.7, 4.8, 4.9, 4.10, 4.11.

**Per-page task:** for each existing page, author new title/H1/meta/intro/FAQ
across 4 locales. This is 6 × 4 = 24 text surgeries plus i18n chunk updates
in `services/locales/{lang}-{tab}.ts` files.

**Pre-work required (ideally one script):**
- GSC API integration to pull current position per URL so before/after is
  measurable. Currently there is no script that reads GSC for per-URL
  position; add `scripts/gsc-position-snapshot.mjs` that writes to
  `data/gsc-positions.json`, run it once to capture baseline, run it weekly
  for regression tracking.

**Acceptance per task:**
- H1 / `<title>` / `<meta description>` contain the exact target keyword.
- Body ≥600 words (was ≥500 for Task 4.9 specifically, per plan).
- FAQPage JSON-LD updated with new Q/A pairs; FAQ uniqueness test green.
- Translations shipped in all 4 locales before commit.
- `npx tsc --noEmit` + `npx vite build` + `npx vitest run` green.

**Estimated effort:** 0.5 day per task × 6 = 3 days.

---

## Unit F4-C — Programmatic profession landings (10 professions × 4 locales = 40 pages)

**Scope:** Task 4.12.

**Design:** mirror `nursingLandingsPlugin` exactly.
- `build-plugins/professionLandingsPlugin.ts`
- `build-plugins/professionLandingsData.ts` — slug tables, locale prefixes,
  parse/build/isXxxxPath helpers.
- `build-plugins/professionLandingsCopy.ts` — per-profession per-locale copy
  bundle. ~600w IT canonical, ~400w EN/DE/FR.
- Router: register readonly `PROFESSION_LANDING_ROUTES` for staticOverlay
  matching in `services/router.ts` like the nursing one.
- Sitemap: auto-discovered by `sitemapAliasPlugin` if written to
  `dist/sitemap-professions.xml`.

**Data needed per profession (per locale):**
- Salary range CH — source from `data/ticino-jobs-salary-bands.json` (exists)
  plus Federal Stats FSO `lohnstrukturerhebung` if available per profession
  code.
- Typical employers — derive from `data/jobs.json` top companies per
  sector tag + hand-curate 3 anchor employers per profession (not all 10
  have 3 obvious anchors in Ticino — `frontaliere badante` is not posted
  on job boards, needs different copy angle).
- Open positions count — generated at build time from `data/jobs.json`
  filtered by sector tag. Must keep a stable snapshot otherwise page word
  count flickers and thin-content gate fails on low-job days.
- Qualification equivalence — needs per-profession research (MEBEKO for
  infermiere, Federal Office for Professional Education and Technology for
  others).

**Blockers:**
- Profession-to-sector-tag mapping in `data/jobs.json` is partial; some
  professions (`parrucchiere`, `cameriere`, `muratore`) don't have clean
  sector tags today. Either extend the AI sector classifier or accept
  that these profession pages pull a broader "services" bucket.
- Translation cache for EN/DE/FR profession names must be seeded before
  first build or the copy bundle fails compile. Add entries to
  `services/locales/{lang}-*.ts` chunks.

**Acceptance:**
- 40 HTML files + 40 flat-twin files = 80 outputs in `dist/`.
- Thin-content gate exits 0 at `--min-words=300`.
- Hreflang × 4 + x-default on every canonical.
- JSON-LD: BreadcrumbList + FAQPage + Article + ItemList of top 5 open
  positions per profession in that city (requires wiring build-time data
  injection from `data/jobs.json`).

**Estimated effort:** 2.5 days including copy authorship for 10 professions
× 4 locales (~24,000 words total).

---

## Unit F4-D — Geo cost-of-living landings (6 cities)

**Scope:** Task 4.13.

**Design question:** extend `/costo-della-vita/` with per-city sub-routes
(`/costo-della-vita/lugano/`) vs. create new top-level slugs. The plan says
"extend existing OR create per-city sub-pages" — recommendation is
sub-routes, canonicalised under the existing page. That preserves the
ranking of the parent while capturing the long-tail city variant.

**Blockers:**
- No current dataset for rent medians per Ticino city at the
  zip/neighbourhood level. Possible sources: `comparis.ch` scrape (ToS
  risk), Federal Stats FSO rent index (cantonal-level only, not
  municipal), Homegate API (paid). Need a decision before building the
  plugin.
- Italian-side comparison prices (Milano/Varese/Como baskets) — need a
  stable data file; Istat has city-level CPI but not grocery basket.

**Recommendation:** defer this unit until the data source question is
resolved in a separate spike. Do not ship template-filled pages with
fabricated numbers — CLAUDE.md §4 forbids thin content, and fabricated
numbers are worse than thin.

---

## Unit F4-E — FAQ/PAA capture on 20 existing pages (Part D)

**Scope:** Task 4.15 — 20 Q/A pairs added to existing hub pages, each
propagated to 4 locales + FAQPage JSON-LD update.

**Per-target-page task:**
1. Author 40-60-word answer to the target question in IT.
2. Translate to EN/DE/FR (human-quality — the FAQ uniqueness gate will
   reject near-duplicates across locales; each locale must be genuinely
   written, not machine-translated).
3. Insert an `<h3>` + `<p>` block in the page's static HTML generator
   (varies per page — some are React components rendering into `#root`,
   some are build-plugin static pages, some are blog posts).
4. Append the Q/A to the page's FAQPage `mainEntity` array.
5. Run FAQ uniqueness test — fail means rewrite.

**Blockers:**
- Several target URLs in the Sprint 4 table don't exist yet (Sprint 2
  pillar pages haven't landed): `/confronti/stipendi-svizzera-italia/`,
  `/guida/contratti-lavoro-frontalieri/`, `/costo-della-vita/lugano/`,
  `/guida/disoccupazione/`, `/fisco/pensione/`, `/fisco/assegni-familiari/`,
  `/guida/iscrizione-aire/`. Only 6 of 20 target pages exist today
  (`/`, `/guida/`, `/calcolatore/`, `/fisco/`, `/costo-della-vita/`,
  `/premi-cassa-malati/`, `/fisco/avs/`, `/guida/permesso-g/`). The
  remaining 14 FAQ additions depend on Sprint 2 shipping first.
- FAQ uniqueness test is strict: 20 × 4 locales = 80 new Q/A pairs, each
  must be textually distinct from all 200+ existing Q/A pairs sitewide.
  This is authorial effort, not a codegen task.

**Recommendation:** ship the 6 FAQ additions for pages that exist today
as unit F4-E1, and defer the Sprint-2-dependent 14 as F4-E2.

**Estimated effort:** F4-E1 = 1 day, F4-E2 = 1.5 days (post-Sprint-2).

---

## Unit F4-F — Schema enhancements (Part E remainder)

**Scope:** Task 4.16 (Dataset on F4, Place on cost-of-living) + 4.17
(VideoObject on webcam pages).

**Sub-tasks:**
- F4-F1: Add `Dataset` JSON-LD to `/mercato-lavoro-ticino/` (F4 plugin
  output). Property set: name, description, creator, distribution (link
  to the canonical JSON the plugin emits at
  `dist/mercato-lavoro-ticino/snapshot.json` if emitted — verify), temporal
  coverage, spatial coverage, license, keywords.
  Effort: 2 hours.
- F4-F2: Add `Place` JSON-LD to `/costo-della-vita/` — but only once the
  city sub-pages from Unit F4-D land, because at that point each page is
  about a specific `Place` (addressLocality). The parent page is not a
  single place, so `Place` there is wrong; better to add `ItemList` of
  the 6 cities.
  Effort: 1 hour, blocked by F4-D.
- F4-F3: Add `VideoObject` JSON-LD to `/traffico-dogane/{crossing}/oggi/`
  pages that embed a live webcam. Review `borderWaitPagesPlugin.ts` to
  see which crossings have webcam embeds today; only those get the
  VideoObject. Required fields: `name`, `description`, `thumbnailUrl`
  (screenshot from webcam vendor), `uploadDate` (build date),
  `contentUrl` (webcam stream URL if hotlink policy allows — most vendors
  forbid deep-link to the raw stream so this field may need to be
  omitted, leaving only `embedUrl`). `publication` → `BroadcastEvent`
  with `isLiveBroadcast: true`.
  Effort: 0.5 day, includes hotlink-policy audit per vendor.

---

## Suggested landing order (smallest risk first)

1. **F4-F1** (Dataset schema on F4) — 2h, self-contained, one file.
2. **F4-F3** (VideoObject on border-wait pages) — 0.5d, one plugin edit.
3. **F4-E1** (6 FAQ additions on existing pages) — 1d, authorial.
4. **F4-B** (6 striking-distance optimisations, one at a time) — 0.5d each.
5. **F4-A** (4 quick-win static pages via new careerLandings plugin) — 1.5d.
6. **F4-C** (professionLandings plugin + 40 pages) — 2.5d.
7. **F4-E2** (remaining 14 FAQ additions) — blocked by Sprint 2.
8. **F4-D** (cost-of-living cities) — blocked on data-source decision.
9. **F4-F2** (Place/ItemList on cost-of-living hub) — blocked by F4-D.

Total sequencable-now work: ~8 working days. Total blocked work: ~3 days
waiting on Sprint 2 + 1 data-source spike.

---

## Test-baseline guarantees

Every unit must pass before merge:
- `npx tsc --noEmit`
- `npx vite build`
- `npx vitest run` — 26.9k tests stay green (Sprint 1-Ext2 baseline).
- `node scripts/validate-internal-links.mjs`
- `node scripts/find-thin-pages.mjs --min-words=100 --fail-on-any`
- `node scripts/validate-canonical.mjs`
- `node scripts/validate-hreflang.mjs`
- `node scripts/validate-structured-data.mjs`
- FAQ uniqueness test (in `tests/`, wired to `pretest`).

No shortcut is acceptable. If a unit can't pass the thin-content or
FAQ-uniqueness gate, it stays in this follow-up — it does not ship.

---

## Parallelism note

Sprint 2 (content sprint) is running in parallel and owns:
- 5 pillar pages (slug list in `PLAN-SPRINT-2-CONTENT.md`).
- 20 thin-content expansions on existing pages.

Sprint 4 follow-up must not touch those slugs. Striking-distance
optimisations in F4-B that overlap (notably Task 4.11 which Sprint 3
Cluster 10 already touched, and Task 4.5 which Sprint 2.5 is authoring)
should coordinate via commit messages — if Sprint 2 lands first, F4-B's
on-page changes rebase on top; if F4-B lands first, Sprint 2 rebases.

---

## Open questions for operator

1. Is Sprint 2 on schedule? F4-E2 and several pillar-dependent FAQ targets
   block until it lands.
2. Budget for copy: ~60,000 words of new IT content + translations.
   Authored manually or with LLM + human fact-check? CLAUDE.md §4 says
   "real content" — LLM drafts are fine if human-reviewed, not fine if
   rubber-stamped.
3. Data-source decision for Unit F4-D (rent medians per Ticino city).
   Pick one of: FSO cantonal-level (thin), comparis scrape (ToS risk),
   Homegate paid API (cost), freeze a 2026-Q1 snapshot by hand (one-time
   effort, no ongoing fresh signal).
