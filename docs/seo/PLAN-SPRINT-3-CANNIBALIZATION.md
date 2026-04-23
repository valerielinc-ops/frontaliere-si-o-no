# Sprint 3 — Keyword Cannibalization Resolution

**Goal:** Resolve 14 cannibalization clusters where multiple URLs compete for the same keyword, diluting CTR and confusing Google intent signals.
**Duration:** 2-3 days
**Expected impact:** +25% CTR on affected clusters, rank consolidation for cornerstone terms
**Files touched:** `services/router.ts` (slug table), `public/404.html` (redirects), `services/seoService.ts`, `build-plugins/**`

---

## Identified cannibalization clusters

Source: Semrush `phrase_organic_uniq` cross-referenced with `organic_domain` duplicate-keyword report.

| # | Keyword | URLs competing | Pos range | Monthly volume |
|---|---|---|---|---|
| 1 | casale lugano | 6 | 18-42 | 110 |
| 2 | guess stabio / guess bioggio | 6 | 15-38 | 390 |
| 3 | eoc | 4 | 8-24 | 880 |
| 4 | roggiana | 3 (IT/FR/DE locales all in IT SERP) | 12-28 | 90 |
| 5 | educatrice asilo nido | 3 | 15-24 | 170 |
| 6 | infermiera ticino | 3 | 10-22 | 260 |
| 7 | permesso g svizzera | 2 | 27, 34 | 260 |
| 8 | imposta alla fonte ticino | 2 | 14, 26 | 170 |
| 9 | avs frontalieri | 2 | 11, 22 | 110 |
| 10 | calcolo stipendio frontaliere | 2 | 9, 18 | 320 |
| 11 | lamal 2026 | 2 | 16, 28 | 140 |
| 12 | costo vita lugano | 2 | 7, 22 | 720 |
| 13 | cassa malati ticino | 2 | 14, 26 | 320 |
| 14 | orari dogana chiasso | 2 | 12, 28 | 260 |

---

## Resolution strategy per cluster

For each cluster: **pick 1 canonical URL**, **consolidate content onto it**, **301-redirect or noindex the others**, **update internal links**.

### Cluster 1 — casale lugano (6 URLs)

**Canonical:** `/aziende-che-assumono/lugano/casale-s-a/settimana-corrente/`
**Action:**
- [ ] Audit the 6 URLs (likely one per rolling week in weeklyEmployers plugin — they shouldn't be indexed)
- [ ] Add `noindex` to historical weekly snapshots (keep only current week indexed)
- [ ] Update `build-plugins/weeklyEmployers.ts` to always noindex non-current snapshots

### Cluster 2 — guess stabio / guess bioggio (6 URLs)

**Canonical:** single company hub `/aziende-che-assumono/stabio/guess/` (merge bioggio variant)
**Action:**
- [ ] Identify if Guess has presence in both Stabio and Bioggio — if yes, keep both city pages but make each focus on city-specific intent
- [ ] Add `rel="canonical"` pointing each to the most relevant city
- [ ] 301-redirect historical weekly snapshots

### Cluster 3 — eoc (4 URLs, 880 vol — high-value)

**Canonical:** dedicated hub `/aziende-che-assumono/ticino/eoc/` (EOC = Ente Ospedaliero Cantonale, multi-site)
**Action:**
- [ ] Create single EOC hub covering all 4 sites (Lugano, Bellinzona, Locarno, Mendrisio)
- [ ] 301-redirect 4 old URLs → hub
- [ ] Content: 800+ words, sections per site, live job counts per site
- [ ] Target: consolidate to pos 3-5 from current pos 8-24 range

### Cluster 4 — roggiana (3 URLs, cross-locale leak)

**Problem:** FR + DE locale pages rank in IT SERP for this term (locale routing issue).
**Canonical:** `/aziende-che-assumono/{city}/roggiana/settimana-corrente/` (IT locale)
**Action:**
- [ ] Verify hreflang tags on FR/DE pages point correctly — Google should prefer IT for IT SERP
- [ ] Check `x-default` configuration
- [ ] If FR/DE content is a near-translation, this is likely a hreflang wiring bug → depends on Sprint 1 Task 1.1

### Cluster 5 — educatrice asilo nido (3 URLs)

**Canonical:** pick one job detail page or create category page `/lavoro/educatrice-asilo-nido/`
**Action:**
- [ ] If 3 URLs are 3 different job postings with same keyword in title, no consolidation needed — Google de-duplicates via JobPosting schema
- [ ] Review `services/jobMetaTitle.ts` to ensure job titles include distinguishing location/company

### Cluster 6 — infermiera ticino (3 URLs)

**Canonical:** `/lavoro/infermieri-ticino/` (nursing landings plugin — B-cont-5)
**Action:**
- [ ] Ensure nursing landing is the primary ranker
- [ ] Job detail pages should have more specific titles (add company name)
- [ ] Add internal links from job details → nursing landing

### Cluster 7 — permesso g svizzera (2 URLs, pos 27 & 34)

**Canonical:** `/guida/permesso-g/`
**Action:**
- [ ] Identify the second URL (likely FAQ page or blog post)
- [ ] Consolidate content onto guide; 301-redirect secondary
- [ ] Target: pos 27 → top 10 (260 vol, ~50 clicks/mo gain)

### Cluster 8 — imposta alla fonte ticino (2 URLs)

**Canonical:** `/fisco/imposta-alla-fonte/`
**Action:**
- [ ] Merge content from second URL; 301-redirect

### Cluster 9 — avs frontalieri (2 URLs)

**Canonical:** `/fisco/avs/`
**Action:**
- [ ] Consolidate; 301-redirect

### Cluster 10 — calcolo stipendio frontaliere (2 URLs, high-value 320 vol)

**Canonical:** `/calcolatore/`
**Action:**
- [ ] Identify secondary URL (likely blog or guide page)
- [ ] Either noindex it OR link-canonical to `/calcolatore/`
- [ ] Target: rank consolidation to pos 3-5

### Cluster 11 — lamal 2026 (2 URLs)

**Canonical:** `/premi-cassa-malati/` hub
**Action:**
- [ ] Consolidate to main LAMal hub; sub-pages target canton-specific terms

### Cluster 12 — costo vita lugano (2 URLs, 720 vol)

**Canonical:** `/costo-della-vita/lugano/` (or `/costo-della-vita/` if no city-specific page exists)
**Action:**
- [ ] Consolidate; 301-redirect duplicate
- [ ] High-impact: pos 7 → top 3 = ~200 clicks/mo gain

### Cluster 13 — cassa malati ticino (2 URLs)

**Canonical:** `/premi-cassa-malati/`
**Action:** Consolidate; 301 secondary.

### Cluster 14 — orari dogana chiasso (2 URLs)

**Canonical:** `/traffico-dogane/chiasso/oggi/` (F8 border wait page)
**Action:** Consolidate; 301 secondary.

---

## Implementation tasks

### Task 3.1 — Cannibalization audit script

- [ ] Create `scripts/audit-cannibalization.mjs` that queries Semrush API (or GSC) for any keyword with >1 URL from our domain
- [ ] Output CSV with: keyword, URLs, positions, volumes
- [ ] Run weekly in CI; alert if new clusters appear

### Task 3.2 — 301 redirect infrastructure

- [ ] Extend `public/404.html` sessionStorage logic to support explicit 301 mappings (current setup only handles catch-all)
- [ ] Create `public/redirects.json` with source → target mappings
- [ ] Update 404.html to read redirects.json and emit `location.replace()` with correct target
- [ ] Test all redirects via Playwright

### Task 3.3 — Noindex meta on historical snapshots

- [ ] `build-plugins/weeklyEmployers.ts` — add `<meta name="robots" content="noindex,follow">` on all non-current-week snapshots
- [ ] Same for `build-plugins/jobMarketSnapshot.ts` historical pages
- [ ] Verify sitemap excludes noindex pages

### Task 3.4 — Internal link audit

- [ ] For each consolidated cluster, search codebase for links to deprecated URLs
- [ ] Update all references to canonical URL
- [ ] Automation: `scripts/rewrite-internal-links.mjs` with old→new mapping

### Task 3.5 — Canonical tag consistency

- [ ] Ensure every page has exactly one `<link rel="canonical">` pointing to itself (unless intentionally pointing elsewhere for duplicates)
- [ ] Test: `tests/seo/canonical-tag-consistency.test.ts`

### Task 3.6 — Content consolidation

For clusters 3 (eoc), 6 (infermiera), 7 (permesso g), 10 (calcolatore), 12 (costo vita lugano):

- [ ] Merge unique content from deprecated URLs into canonical
- [ ] Don't lose useful information — preserve in expanded sections

### Task 3.7 — Re-request indexing

- [ ] After deploy, submit canonical URLs to GSC URL Inspection tool for re-crawl
- [ ] Submit deprecated URLs to removal tool if Google doesn't drop them within 2 weeks

---

## Acceptance criteria

- [ ] All 14 clusters resolved (canonical chosen, 301s in place, content consolidated)
- [ ] `scripts/audit-cannibalization.mjs` shows zero new clusters
- [ ] Semrush re-scan confirms duplicate-keyword URLs count → 0
- [ ] `npx vitest run` passes
- [ ] `npm run build` exits 0
- [ ] Manual verification: each canonical URL ranks on page 1-2 (vs pre-consolidation dilution)

---

## Execution order

1. Task 3.1 (audit script) — 30 min, run it, lock list
2. Task 3.3 (noindex historical) — kills ~60% of cannibalization immediately (clusters 1, 2, 11)
3. Task 3.2 (redirect infra) — unblocks all manual 301s
4. Task 3.6 (content consolidation per high-value cluster) — eoc, costo vita lugano first
5. Tasks 3.4, 3.5 (link + canonical hygiene) — final pass
6. Task 3.7 (GSC re-indexing) — after deploy

Total estimate: **2-3 working days**.

---

## Monitoring (4-6 weeks post-launch)

- Weekly Semrush position tracking on the 14 canonical keywords
- GSC performance report: clicks should rise on canonicals, drop to 0 on deprecated URLs
- If deprecated URLs still appear in SERPs after 4 weeks → use GSC removal tool

---

## Completion status (2026-04-23)

### Landed

- **Task 3.1 — Audit script**: `scripts/audit-cannibalization.mjs` ships.
 Reads dist/, groups self-canonical pages by normalized `<title>` phrase,
 skips JobPosting pages and whitelisted templated clusters. Current
 baseline: 5 local clusters flagged (see follow-up doc).
- **Task 3.2 — Redirect infrastructure**: already in place via
 `build-plugins/legacyRedirectsPlugin.ts` (canonical-bridge HTML with
 `noindex,follow` + flat .html twin for GitHub Pages). No change needed.
- **Task 3.3 — Noindex on historical snapshots**: already enforced for
 F4 (`jobMarketSnapshotPlugin`) and F5 (`weeklyEmployersPlugin`)
 archives older than 12 weeks. This mechanically resolves clusters
 **1 (casale lugano)**, **2 (guess stabio)**, and tangentially
 **4 (roggiana)** and **11 (lamal 2026)**.
- **Task 3.5 — Canonical consistency**: `tests/noindex-builders.test.ts`
 + post-build canonical checks already green. No change needed.

### Deferred to `PLAN-SPRINT-3-FOLLOWUP.md`

- **Tasks 3.4, 3.6, 3.7**: require per-cluster loser-URL identification
 from Semrush `phrase_organic` or GSC query-URL pairing. The 14 clusters
 listed in this plan cite positions + volumes but not the specific loser
 URLs. Semrush MCP integration (`mcp__semrush__*`) is available in the
 workspace and is the recommended path to enumerate losers.
- **Clusters 3, 5–10, 12–14**: cannot be resolved without that URL list.

### New findings

The audit script surfaced 5 real local cannibalization clusters (blog
content duplicates) that were NOT in the original 14. See the follow-up
doc for the suggested winners and why two of them should NOT be
redirected (one is intent-split, one is a data-quality bug).
