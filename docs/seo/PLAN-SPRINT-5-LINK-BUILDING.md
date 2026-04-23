# Sprint 5 — Link Building & Authority Growth

**Goal:** Grow referring domains from 4 → 25+ and Authority Score from 11 → 20+ via targeted, ethical outreach and linkable asset creation.
**Duration:** Ongoing (first sprint cycle: 3 weeks)
**Expected impact:** +20 RD, +50 editorial backlinks, AScore +9 points
**Files touched:** new content assets (data studies, tools), outreach tracker (external doc)

## Code-shippable assets — SHIPPED 2026-04-23

| Task | Deliverable | Path |
|---|---|---|
| 5.1 | Annual salary report page generator (4 locales) | `build-plugins/annualReportPlugin.ts` → `/report/frontalieri-2026/` + hub callout |
| 5.2 | Public salary aggregate CSV (CC BY 4.0) | `dist/data/jobs-salary-aggregate.csv` (emitted by 5.1 plugin) |
| 5.3 | Embeddable currency widget for external sites | `public/embed/currency-widget.html` + `widget-data.json` |
| 5.4 | Outreach tracker scaffold with 30 Tier A/B/C targets | `docs/seo/outreach-tracker.csv` |
| 5.5 | Press release drafts (IT primary + EN stub) | `docs/seo/press-releases/{annual-report-2026,2026-new-tax-agreement,health-insurance-trends}.md` |
| 5.6 | Broken-link scout script | `scripts/find-broken-competitor-links.mjs` → `data/seo/broken-competitor-links.json` |

The outreach tasks (Part B / C / D) below remain a running checklist — manual, ongoing work.

---

## Current state (baseline)

| Metric | Value |
|---|---|
| Referring domains | 4 |
| Backlinks | 5 |
| Authority Score | 11 |
| Follow / nofollow | 3 / 2 |
| Domain rating of RDs | 2-5 (effectively zero) |

**Diagnosis:** The site has no editorial links. Competitors (ocst.ch, beecare.ch) have 100-500 editorial links each.

---

## Strategy (ranked by ROI)

1. **Linkable data assets** — original research/data that journalists cite (highest ROI)
2. **Digital PR** — press releases to Italian+Swiss news on timely topics (fiscal reform, LAMal updates)
3. **Targeted outreach** — to frontalieri associations, unions (OCST, SIT), expat communities
4. **Niche guest posts** — on frontalieri/expat blogs with decent DA
5. **Broken link building** — find dead links on competitor citation pages → offer our page

---

## Part A — Build linkable assets (content investment)

### Task 5.1 — Annual salary report "Report Frontalieri {year}" — SHIPPED

- [x] Aggregate salary data from `jobs.json` across sectors — `build-plugins/annualReportPlugin.ts`
- [x] Produce web version `/report/frontalieri-{year}/` (IT) + `/en/` `/de/` `/fr/` locales
- [x] Key findings included:
  - Median salary by sector (top 10)
  - YoY delta (estimated; dataset-to-dataset comparison once 2027 snapshot exists)
  - Regional breakdown (Lugano / Chiasso / Mendrisio / Bellinzona / Locarno)
  - Purchasing power parity IT vs CH
- [ ] Shareable infographics (SVG + PNG) — followed up: placeholders in page, real artwork separate
- [x] CSV download of raw data (`/data/jobs-salary-aggregate.csv`, CC BY 4.0) — Sprint 5.2
- [x] Dataset JSON-LD + Article JSON-LD + BreadcrumbList emitted
- [x] Sitemap entry + hreflang
- [x] Internal link from /mercato-lavoro-ticino/ hub (all 4 locales) — idempotent callout patched by plugin
- [x] Press release copy — see `docs/seo/press-releases/annual-report-2026.md`

**Outreach target:** laregione.ch, tio.ch, cdt.ch, ticinonline, Corriere del Ticino, Il Sole 24 Ore (economia frontiera section) — see `docs/seo/outreach-tracker.csv`

### Task 5.2 — Data study "Costo della vita Lugano vs Milano"

- [ ] Extend existing `/costo-della-vita/` data with side-by-side comparison
- [ ] Interactive calculator: "Quanto risparmi/spendi vivendo di qua"
- [ ] Standalone page `/confronti/lugano-vs-milano/`
- [ ] Shareable results URL with query params
- [ ] Source data: official ISTAT (IT), UST (CH), rent portals

**Outreach target:** Immobiliare.it blog, Idealista magazine, local Lugano/Milano real estate sites

### Task 5.3 — Tax reform timeline & impact infographic

- [ ] Already have data for `/guida/frontalieri-nuova-legge-2026/` (Sprint 2.5)
- [ ] Produce professional infographic (SVG + PDF) summarizing impacts
- [ ] Embed-friendly: iframe/HTML snippet for bloggers
- [ ] Companion Twitter/LinkedIn thread template

**Outreach target:** Italian fiscal blogs, commercialisti associations, Italian unions

### Task 5.4 — Interactive calculator widget embed — SHIPPED (5.3 in execution order)

- [x] Lightweight embed widget at `public/embed/currency-widget.html` (no React dependency)
- [x] Attribution link back to `frontaliereticino.ch` with `rel="noopener"` (NOT nofollow — editorial link is the point)
- [x] Data snapshot in `public/embed/widget-data.json` — widget degrades gracefully when missing
- [x] Copy-paste `<iframe>` embed snippet documented inline in the HTML comment block
- [ ] Fiscal calculator embed (richer) — followed up as separate task; starts with the currency/stats teaser

**Outreach target:** commercialisti, expatriate blogs, union websites

### Task 5.5 — Yearly LAMal premium study

- [ ] Extend F2 LAMal pages with annual trend analysis
- [ ] "How LAMal premiums changed {year} vs {year-1}" — already partly built in tri-year tool
- [ ] Press release timed with BAG annual premium announcement (September)

**Outreach target:** Swiss health press, consumer protection associations, Italian health ministry press contacts

---

## Part B — Outreach pipeline

### Task 5.6 — Build prospect database — SHIPPED (scaffold)

- [x] Outreach tracker at `docs/seo/outreach-tracker.csv` with ~30 pre-populated Tier A/B/C targets
- [x] Columns: date, target_domain, contact_name, contact_email, topic, asset_offered, status, link_url, notes
- [x] Status values documented in CSV header: `new | sent | replied | link_acquired | declined | bounced`
- [ ] Continue populating with additional targets as outreach progresses (ongoing, human task)
- [ ] Create Airtable/Notion outreach tracker (optional upgrade — CSV is source of truth today)
- [ ] Seed with:
  - All Italian regional newspapers within 100km of border (Varese, Como, Lecco, Verbano-Cusio-Ossola, Piemonte border)
  - Swiss Italian newspapers (Corriere del Ticino, La Regione, tio.ch, ticinonline)
  - Frontalieri-specific blogs (~20 identified)
  - Unions (OCST, SIT, SIT-SEV, Unia Ticino)
  - Associations (Comitato Frontalieri, Associazione Frontalieri)
  - Commercialisti with frontaliere focus (~30)
  - Expat / move-abroad blogs in Italian (~15)
  - Swiss municipal websites (28 cities) — link to border wait pages / job aggregator
- [ ] Categorize by tier: A (priority), B (secondary), C (long tail)

### Task 5.7 — Outreach templates

- [ ] 4 email templates:
  1. Tier A press outreach (cold) — pitching annual report
  2. Resource page pitch — pitching calculator widget
  3. Guest post pitch — offering original content
  4. Broken link replacement — polite notification
- [ ] Italian + French + German versions
- [ ] A/B test subject lines

### Task 5.8 — Execute outreach wave 1

- [ ] 50 outreaches in week 1 (20 A-tier, 20 B-tier, 10 C-tier)
- [ ] Track open/reply rate in tracker
- [ ] 2 follow-ups per cold target (day 4, day 10)
- [ ] Target: 10% reply rate, 5% link placement → 5 new RDs from wave 1

### Task 5.9 — Broken link building campaign — SHIPPED (scout)

- [x] Scout script at `scripts/find-broken-competitor-links.mjs`
- [x] Hardcoded seed list of ~13 competitor/citation pages (OCST, SIT, beecare, laregione, cdt, tio, rsi, varesenews, Wikipedia IT/DE, Agenzia Entrate frontalieri)
- [x] HEAD + GET fallback probe per outbound link with 10s timeout, polite 2s pause between sources
- [x] Keyword-matched replacement suggestions drawing from our asset inventory (report, calcolatori, guide, LAMal, fuel, border wait)
- [x] Output: `data/seo/broken-competitor-links.json` — machine-readable pipeline for outreach copy
- [ ] Outreach: "Hi, noticed link X on page Y is broken. We have similar content at Z, if useful." (human task, use scout output)
- [ ] Target: 20 broken-link outreaches → 3-5 conversions

### Task 5.10 — HARO / Italian press equivalents

- [ ] Register with:
  - HARO (Help A Reporter Out) — English market, secondary
  - Italian equivalents: Qwoted, press agency mailing lists
  - Newspaper `expert voices` lists: contact editorial secretaries directly for inclusion
- [ ] Respond to 5 relevant journalist queries per week
- [ ] Target: 2-3 press mentions per month

---

## Part C — Community & social proof

### Task 5.11 — Forum and Q&A presence

- [ ] Create (or reuse) author accounts on:
  - Quora Italia — answer 3 questions/week in `frontaliere`, `lavoro svizzera`, `vita ticino` topics; include branded URL only when strictly value-adding
  - Reddit r/italy, r/svizzera, r/commercialisti — participate authentically, no spam
  - ExpatForum — Italy to Switzerland threads
- [ ] Target: 5 nofollow but traffic-driving links + brand awareness

### Task 5.12 — LinkedIn presence for the brand

- [ ] Company page active with 2 posts/week
- [ ] Share annual report, data updates, new features
- [ ] Target: 500 followers in 3 months, backlinks from reposts

### Task 5.13 — Wikipedia contribution (long-term)

- [ ] Find Wikipedia articles missing citations for frontalieri topic (IT, DE, FR versions)
- [ ] Offer our data-backed content as citation source (editorial contribution, not self-promotion)
- [ ] Requires established editor account — slow-burn

---

## Part D — Partnerships

### Task 5.14 — Commercialisti partnership program

- [ ] Offer free/discounted calculator embed + branded landing page for participating commercialisti
- [ ] In exchange: backlink from their site to frontaliereticino.ch
- [ ] Target: 10 partnerships → 10 RDs (AScore 10-25 typically)

### Task 5.15 — Union partnership

- [ ] Pitch OCST, SIT, Unia for data collaboration
- [ ] Offer co-branded annual report
- [ ] Target: 2-3 partnership RDs (high-authority, DA 40+)

### Task 5.16 — Relocation agencies & real estate

- [ ] Target relocation agencies serving IT→CH movers
- [ ] Offer: resource library mention → backlink
- [ ] Target: 5 RDs

---

## Part E — Foundation hygiene

### Task 5.17 — Disavow toxic backlinks

- [ ] Export current 5 backlinks via Semrush
- [ ] If any (e.g., scraper-news.md) are toxic/spammy, add to disavow file
- [ ] Submit to GSC

### Task 5.18 — Directory listings (quick wins)

- [ ] Submit to Swiss/Italian business directories:
  - local.ch (Swiss)
  - pagine gialle Svizzera
  - Italian regional commerce chambers (Varese, Como)
- [ ] Ensure NAP (Name/Address/Phone) consistency
- [ ] Target: 8 quick RDs

---

## Monthly targets

| Month | New RDs | New BLs | AScore target |
|---|---|---|---|
| Month 1 | +5 | +8 | 13 |
| Month 2 | +7 | +12 | 16 |
| Month 3 | +8 | +15 | 20 |

---

## Acceptance criteria (3-month horizon)

- [ ] 25+ referring domains (from 4)
- [ ] 50+ backlinks (from 5)
- [ ] Authority Score 20+ (from 11)
- [ ] 5+ backlinks from DA 30+ domains
- [ ] Linkable assets 5.1-5.5 all published
- [ ] Outreach tracker shows 150+ attempts logged

---

## Tools & budget

- **Semrush Backlink Analytics** — monitor gains (existing license)
- **Outreach tool** (Pitchbox / Respona / Lemlist) — ~€150/mo
- **Airtable** for prospect tracker — free tier
- **Canva Pro** for infographics — €12/mo
- **Press release distribution** (Italian press agencies) — €200 per release
- **Estimated monthly budget:** €500-800 for outreach + content investment
- **Time:** 10-15h/week sustained (can be part-time contractor)

---

## Risks & mitigations

- **Low reply rate risk:** Outreach is numbers game; plan for 2-3% conversion
- **Penalty risk:** Avoid paid links entirely, avoid link schemes
- **Burnout risk:** Systemize outreach with templates + tooling; don't rely on heroics
- **Content quality risk:** Every linkable asset must be genuinely useful, not SEO-bait
