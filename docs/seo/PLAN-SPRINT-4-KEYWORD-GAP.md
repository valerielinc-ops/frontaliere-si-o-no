# Sprint 4 — Keyword Gap Exploitation

**Status (2026-04-23):** Scope audit completed. Task 4.16 homepage portion
confirmed already shipped (`Organization` + `WebSite`/`SearchAction` +
`sameAs` in `index.html` ~L795-901). Remaining 16 tasks decomposed into
9 landable units in
[`PLAN-SPRINT-4-FOLLOWUP.md`](./PLAN-SPRINT-4-FOLLOWUP.md) — see
"Suggested landing order" there. Total remaining: ~8 days sequenceable,
~3 days blocked on Sprint 2 + data-source decision.

**Goal:** Capture high-volume keywords where competitors rank but we don't, via targeted content and on-page optimization.
**Duration:** 5-8 days
**Expected impact:** +1,200 clicks/mo (90-day horizon), +300 tracked keywords
**Files touched:** multiple new pages, existing page optimization, schema enhancements

---

## Data sources

- `domain_domains` gap analysis vs IT competitors: ocst.ch, beecare.ch (frontalieri-focused)
- `domain_domains` gap analysis vs CH competitors: lugano-lis.ch, carriera.ch (job-focused)
- `phrase_kdi` on 15 target keywords
- `phrase_these` on 12 strategic keywords
- `phrase_related` cluster expansion

---

## Part A — High-value quick wins (KD <20, vol >200)

### Task 4.1 — "agenzie del lavoro lugano" (vol 720, KD 18)

- [ ] New page `/lavoro/agenzie-del-lavoro/lugano/`
- [ ] Content (~800w):
  - H1: "Agenzie del lavoro a Lugano: guida completa 2026"
  - H2: "Le principali agenzie interinali a Lugano" — table with Adecco, Manpower, Randstad, Kelly, Synergie + Swiss-specific ones
  - H2: "Come funziona l'agenzia del lavoro in Svizzera" — contract types (temporaneo, fisso tramite agenzia, a tempo determinato)
  - H2: "Costi: le agenzie fanno pagare il candidato?" — clarify (no, it's illegal in CH)
  - H2: "Frontaliere tramite agenzia: diritti e doveri"
  - H2: "Agenzie specializzate per settore" — IT, sanità, logistica
  - FAQPage: 6 questions
- [ ] Internal links from `/lavoro/lugano/` (Sprint 2), `/job-board/`

### Task 4.2 — "concorsi lugano" (vol 720, KD 15)

- [ ] New page `/lavoro/concorsi-pubblici-lugano/`
- [ ] Content (~800w):
  - H2: "Concorsi pubblici aperti a Lugano" — list with live sync from city of Lugano portal + cantonal offers
  - H2: "Come partecipare ai concorsi cantonali"
  - H2: "Frontalieri possono partecipare?" — eligibility rules (generally yes for federal/cantonal, varies per role)
  - H2: "Concorsi ospedalieri EOC" — link to EOC hub (Sprint 3 consolidation)
  - FAQPage: 5 questions

### Task 4.3 — "stage lugano" (vol 260, KD 16)

- [ ] New page `/lavoro/stage/lugano/`
- [ ] Target: young audience, future frontaliere pipeline
- [ ] Content (~700w): stage types, retribuzione media, settori che offrono stage
- [ ] FAQPage: 4 questions

### Task 4.4 — "contratto nazionale frontalieri" (vol 390)

- [ ] New page `/guida/contratti-lavoro-frontalieri/`
- [ ] Content: GAV/CCNL in different sectors, minimum wage per sector, overtime rules
- [ ] Link from `/guida/` hub

### Task 4.5 — "accordo fiscale italia svizzera" (vol 590, currently pos 18)

- [ ] Optimize existing page → rewrite if thin, or add dedicated H2 stack on `/guida/frontalieri-nuova-legge-2026/` (Sprint 2.5)
- [ ] Cross-link to calculator

---

## Part B — Striking-distance optimization (pos 11-30)

### Task 4.6 — "medacta international sa rancate" (1,300 vol, pos 24)

- [ ] This is a branded query — means Medacta's own site ranks #1; we're competing for "jobs at Medacta" intent
- [ ] Optimize existing Medacta company page:
  - Title: "Lavoro Medacta Rancate 2026 | Posizioni aperte per frontalieri"
  - Add H2: "Come candidarsi a Medacta"
  - Add H2: "Stipendi medi in Medacta"
  - Expand to 800+ words
  - Internal links from `/job-board/company/medacta/`, `/lavoro/mendrisio/`
- [ ] Target: pos 24 → top 10 (+130 clicks/mo)

### Task 4.7 — "festivi in ticino" (720 vol, pos 19)

- [ ] Optimize `/vita/festivi/` page:
  - Verify current-year calendar table is present
  - Add H2: "Festività cantonali Ticino vs federali"
  - Add downloadable ICS calendar
  - Add prev/next year links for evergreen + current-year signal
  - Target: pos 19 → top 5 (+150 clicks/mo)

### Task 4.8 — "valico brogeda" (480 vol, pos 22)

- [ ] F8 border wait page for Brogeda likely exists — verify
- [ ] Ensure content richness: opening hours, webcam, live wait time, distance to Lugano
- [ ] Internal link from `/traffico-dogane/` hub
- [ ] Target: pos 22 → top 5 (+95 clicks/mo)

### Task 4.9 — "permesso g svizzera" (260 vol, pos 27)

- [ ] Optimize `/guida/permesso-g/`:
  - Expand to 1,200+ words (currently likely ~500)
  - Add H2: "Costi, rinnovo, tempi di rilascio"
  - Add HowTo JSON-LD (request → submit → renewal)
  - FAQPage expansion to 10 questions
- [ ] Target: pos 27 → top 10

### Task 4.10 — "avs frontalieri" (110 vol, pos 11)

- [ ] Optimize `/fisco/avs/`:
  - Add fresh 2026 contribution rates
  - Add H2: "Recupero contributi AVS al rientro in Italia"
  - Cross-link LPP secondo pilastro page
  - Add calculator integration
- [ ] Target: pos 11 → top 5

### Task 4.11 — "calcolo stipendio frontaliere" (320 vol, pos 9-18)

- [ ] Already tackled in Sprint 3 Cluster 10 (consolidation)
- [ ] Additionally, optimize H1 + meta on `/calcolatore/` to include this exact phrase

---

## Part C — Long-tail cluster expansion

### Task 4.12 — "frontaliere {profession}" programmatic pages

Target patterns (vol 40-200 each, collectively 1,500+ vol):
- frontaliere infermiere
- frontaliere ingegnere
- frontaliere impiegato
- frontaliere operaio
- frontaliere badante
- frontaliere muratore
- frontaliere elettricista
- frontaliere autista
- frontaliere cameriere
- frontaliere parrucchiere

- [ ] Create build plugin `build-plugins/professionLandings.ts`
- [ ] Per profession (10 pages):
  - Title: "Lavoro {profession} per frontalieri in Ticino | {year}"
  - Content (~600w): salary range, open positions count, typical employers, CH qualification equivalence
  - FAQPage: 4 questions
- [ ] Register in sitemap + router
- [ ] Hreflang to EN/DE/FR

### Task 4.13 — "costo vita {city}" programmatic pages

Target 6 cities (vol 90-720 each):
- costo vita lugano (720)
- costo vita mendrisio (170)
- costo vita chiasso (140)
- costo vita bellinzona (110)
- costo vita locarno (90)
- costo vita ticino (210)

- [ ] Extend existing `/costo-della-vita/` page OR create per-city sub-pages
- [ ] Per-city content: rent median, groceries basket, transport, utilities — with Italian city comparison (Milano, Varese, Como)

### Task 4.14 — "orari dogana {crossing}" programmatic

- [ ] Already covered by F8 plugin — verify all 24 crossings have dedicated pages
- [ ] Audit: are they ranking? If not, check titles/meta for keyword match

---

## Part D — Questions & featured-snippet hunting

### Task 4.15 — FAQ/PAA capture on 20 existing pages

For each of these question keywords, find the most relevant existing page and add a direct Q&A paragraph (featured-snippet optimized: 40-60 word answer, H3 question, `<p>` answer):

| Question | Volume | Target page |
|---|---|---|
| quanto guadagna un frontaliere | 480 | / |
| come diventare frontaliere | 320 | /guida/ |
| chi è il frontaliere | 210 | /guida/ |
| conviene fare il frontaliere | 260 | /calcolatore/ |
| frontaliere quanto paga di tasse | 170 | /fisco/ |
| frontaliere si o no forum | 140 | / (link to community) |
| quanto costa vivere a lugano | 720 | /costo-della-vita/ |
| stipendio medio svizzera | 390 | /confronti/stipendi-svizzera-italia/ (Sprint 2.7) |
| permesso g costo | 110 | /guida/permesso-g/ |
| lamal frontalieri obbligatoria | 90 | /premi-cassa-malati/ |
| contributi avs frontalieri | 90 | /fisco/avs/ |
| assicurazione sanitaria frontalieri | 320 | /premi-cassa-malati/ |
| casa lugano affitto | 390 | /costo-della-vita/lugano/ |
| stipendio minimo ticino | 210 | /guida/contratti-lavoro-frontalieri/ |
| tfr frontalieri | 170 | /fisco/ |
| indennità disoccupazione frontaliere | 140 | /guida/disoccupazione/ |
| pensione frontaliere | 140 | /fisco/pensione/ |
| assegni familiari frontalieri | 90 | /fisco/assegni-familiari/ |
| iscrizione aire obbligatoria | 70 | /guida/iscrizione-aire/ |
| naspi frontalieri | 70 | /guida/disoccupazione/ |

- [ ] 20 optimizations, each 40-60 words under an H3 question
- [ ] Each gets a distinct entry in FAQPage JSON-LD for the parent page

---

## Part E — Schema markup for richer SERP features

### Task 4.16 — Review schema on job aggregator pages

- [x] Add `SearchAction` schema to homepage (enables sitelinks searchbox) — **done** (`index.html` L888, `WebSite` + `potentialAction`)
- [x] Add `Organization` schema with `sameAs` links to social profiles — **done** (`index.html` L795-811, 4 sameAs entries: FB×2, LinkedIn, GitHub)
- [ ] Add `Dataset` schema on `/mercato-lavoro-ticino/` (F4) — tracked as follow-up F4-F1
- [ ] Add `Place` schema on `/costo-della-vita/{city}/` pages — tracked as follow-up F4-F2 (blocked by F4-D data source)

### Task 4.17 — VideoObject schema

- [ ] If webcam pages have video-like embed → add `VideoObject` schema (live broadcast)
- [ ] Specifically: `/traffico-dogane/{crossing}/oggi/` pages with webcam → `VideoObject` with `publication` = ongoing

---

## Acceptance criteria

- [ ] All Part A pages live in 4 locales
- [ ] All Part B pages optimized + measured (before/after position)
- [ ] Part C programmatic plugins shipped (20+ profession + city pages)
- [ ] Part D: 20 FAQ/PAA optimizations shipped
- [ ] Part E: 4 schema additions, validated in Rich Results Test
- [ ] Semrush tracking campaign updated with 30+ new target keywords
- [ ] `npx vitest run` passes
- [ ] `npm run build` exits 0

---

## Execution order

**Week 1:**
- Tasks 4.6-4.11 (striking distance) — highest ROI per hour, pages already exist
- Tasks 4.1-4.5 (quick wins) — new pages with low KD

**Week 2:**
- Task 4.12 (programmatic profession landings) — plugin work
- Task 4.15 (FAQ/PAA) — 20 parallel micro-tasks
- Tasks 4.13, 4.14 (programmatic geo)
- Tasks 4.16, 4.17 (schema enhancements)

Total estimate: **5-8 working days**.

---

## Monitoring (weekly)

- Semrush position tracking: 30 added keywords
- GSC queries report: track impressions per added cluster
- Rich Results report: validate structured data indexing
- After 4 weeks, compute clicks gain per cluster → re-invest in what works
