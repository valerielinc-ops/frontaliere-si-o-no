# Sprint 2 — Content Expansion (Thin pages + Pillar creation)

**Goal:** Eliminate thin-content violations and create 5 high-value pillar pages to capture untapped keyword volume.
**Duration:** 5-7 days
**Expected impact:** +400 clicks/mo (90d horizon), unlock 12k+ monthly search volume
**Files touched:** `build-plugins/**`, new content pages under `components/`, `services/locales/*-*.ts`, `public/sitemap.xml`

---

## Part A — Fix 20 thin-content pages (CLAUDE.md blocker)

### Task 2.1 — Expand `/job-board/company/*` pages (≈10 pages)

**Current:** ~30 words, just title + list of jobs.
**Target:** ≥350 words with company context + hiring trends.

- [ ] Audit which companies have thin pages: run `node scripts/find-thin-pages.mjs`
- [ ] For each company, generate sections:
  - H1: "{Company} — Lavoro per frontalieri in Ticino"
  - Intro (80 words): company size, HQ, industry (pull from `jobs.json` metadata)
  - H2: "Posizioni aperte a {dates}" — job count + 3 most recent with snippets
  - H2: "Dove si trova {Company}" — address, distance from 3 main border crossings (Chiasso/Stabio/Gaggiolo), Leaflet map embed
  - H2: "Stipendi medi per ruolo" — aggregated from salary data
  - H2: "Come candidarsi" — CTA + process explanation
  - FAQPage: 4 questions ("Quanti dipendenti ha X?", "X assume frontalieri?", "Che contratti offre X?", "Dove mandare il CV?")
- [ ] Ensure content is not AI-boilerplate — fetch real data from `jobs.json` per company
- [ ] Test: `tests/seo/company-page-content.test.ts` — assert word count ≥350, FAQPage present, unique meta

**Files:**
- `build-plugins/weeklyEmployers.ts` (extend templates)
- `build-plugins/jobsSeoPages.ts` (company landing template)

### Task 2.2 — Expand `/job-board/city/*` pages (≈10 pages)

**Target:** ≥350 words with city-level labor market snapshot.

- [ ] Per city (Lugano, Chiasso, Mendrisio, Bellinzona, Locarno, Stabio, Balerna, Mendrisio, Canobbio, Paradiso):
  - H1: "Lavoro a {city} per frontalieri — {month} {year}"
  - Intro: city profile, commuting from Italy, major employers
  - H2: "Quante posizioni aperte a {city}" — live count + 7-day delta (from `jobs-stats-history.json`)
  - H2: "Stipendio medio a {city}" — from LAMal salary brackets / survey data
  - H2: "Settori che assumono" — top 5 sectors with counts
  - H2: "Distanza dai valici" — table: Chiasso X min, Stabio Y min, etc.
  - H2: "Costo della vita a {city}" — link to `/costo-della-vita/{city}/`
  - FAQPage: 4 questions
- [ ] Hreflang across IT/EN/DE/FR
- [ ] Test: content completeness + unique meta per locale

---

## Part B — New pillar pages (5 high-value targets)

### Task 2.3 — `/lavoro/lugano/` — "Lavoro a Lugano per frontalieri"

**Target keyword:** "lavoro lugano" (vol 2,400, KD 22, currently not ranked)
**Competitor benchmark:** carriera.ch #2 (850 words, 4 H2, outdated)

- [ ] Component `components/LavoroLuganoPage.tsx`
- [ ] Route: `/lavoro/lugano/` (IT), `/en/work/lugano/`, `/de/arbeit/lugano/`, `/fr/travail/lugano/`
- [ ] Content structure (aim 1,200 words):
  - Intro (100w): Lugano as Ticino's business center, frontalieri statistics
  - H2: "Quante posizioni aperte" — live count with date, auto-refresh weekly
  - H2: "Settori principali" — banking/finance, healthcare, logistics, retail (with counts)
  - H2: "Stipendi medi per settore" — table (CHF + EUR conversion)
  - H2: "Aziende che assumono a Lugano" — top 20 linking to `/aziende-che-assumono/lugano/{company}/`
  - H2: "Come arrivare da Italia" — distance from Chiasso/Stabio, transport options, parking
  - H2: "Permessi e burocrazia" — links to permesso G hub, fiscal hub
  - FAQPage: 8 questions
  - JSON-LD: `JobPostingsAggregate` (custom) + `FAQPage` + `BreadcrumbList`
- [ ] Internal links: from homepage, from `/guida/`, from `/job-board/`
- [ ] Register in sitemap
- [ ] Tests: content length, meta, structured data, internal links

### Task 2.4 — `/fisco/tasse-svizzere/` — "Tasse in Svizzera per frontalieri"

**Target keyword:** "tasse svizzere" (vol 1,300, KD 23, currently not ranked)

- [ ] Component `components/TasseSvizzerePage.tsx`
- [ ] Content (~1,000w):
  - Intro: Swiss tax system overview for frontalieri
  - H2: "Imposta alla fonte" — how it works + rates table (from 2026 new agreement)
  - H2: "Accordo Italia-Svizzera 2026" — tri-year phase-in details
  - H2: "Come si calcolano le tasse" — worked example with our calculator
  - H2: "Cantone di Ticino vs altri cantoni" — comparison
  - H2: "Dichiarazione dei redditi in Italia" — double-taxation avoidance
  - FAQPage: 10 questions
- [ ] CTA to `/calcolatore/` throughout

### Task 2.5 — `/guida/frontalieri-nuova-legge-2026/` — "Nuova legge frontalieri 2026"

**Target keyword:** "frontalieri nuova legge" (vol 880, KD 19)

- [ ] Component `components/NuovaLeggePage.tsx`
- [ ] Content (~1,100w):
  - Timeline: 2020 agreement signed → 2024 ratification → 2025 effective → 2026 full application
  - H2: "Cosa cambia" — bullet list of concrete changes
  - H2: "Tabella fiscale 2024 vs 2025 vs 2026" — already built in LAMal/fisco
  - H2: "Impatto sullo stipendio" — worked example with calculator
  - H2: "Cosa fare ora" — action list per situation (nuovo/vecchio frontaliere)
  - H2: "Fonti ufficiali" — AFC, Agenzia Entrate, testo accordo
  - FAQPage: 8 questions
  - Structured data: `NewsArticle` + `FAQPage`

### Task 2.6 — `/lavoro/oss-svizzera/` — "OSS in Svizzera per italiani"

**Target keyword:** "oss svizzera lavoro" (vol 210, KD 14, very low competition)

- [ ] Component reuses nursing landings plugin (already shipped B-cont-5)
- [ ] Content (~900w):
  - H2: "Cos'è un OSS in Svizzera" — equivalence table with Italian qualifications
  - H2: "Stipendi OSS in Ticino" — from salary data
  - H2: "Riconoscimento titolo di studio" — SRK procedure
  - H2: "Offerte attive" — live job count in healthcare sector
  - H2: "Formazione per diventare OSS" — links to institutes
  - FAQPage: 6 questions

### Task 2.7 — `/confronti/stipendi-svizzera-italia/` — "Stipendi Svizzera vs Italia"

**Target keyword:** "stipendi svizzera italia" (vol 480, KD 20)

- [ ] Content (~950w):
  - Intro: purchasing power parity, cost of living adjustment
  - H2: "Stipendi medi per settore" — table: IT vs CH (infermiere, ingegnere, impiegato banca, etc.)
  - H2: "Tasse: impatto sullo stipendio netto" — link to calculator
  - H2: "Costo della vita Lugano vs Milano" — table
  - H2: "Vale la pena fare il frontaliere?" — decision matrix with CTA to calculator
  - FAQPage: 8 questions

---

## Part C — Question-driven FAQ expansion

### Task 2.8 — FAQPage markup on 15 existing pillar pages

Using question keywords from Sprint research:

- [ ] `/` homepage → "Quanto guadagna un frontaliere?" (480), "Chi è il frontaliere?" (210), "Frontaliere si o no?" (140)
- [ ] `/calcolatore/` → "Quanto costa vivere a Lugano?" (720), "Conviene fare il frontaliere?" (260)
- [ ] `/fisco/` → "Frontaliere quanto paga di tasse?" (170), "Come funziona l'imposta alla fonte?" (90)
- [ ] `/guida/permesso-g/` → "Come diventare frontaliere?" (320), "Cosa serve per il permesso G?" (110)
- [ ] `/premi-cassa-malati/` → "Cassa malati obbligatoria per frontalieri?" (90), "Quanto costa LAMal?" (70)
- [ ] Each FAQPage: 5-8 questions, 50-120 word answers, unique per locale

### Task 2.9 — HowTo schema on calculator + guide pages

- [ ] Add `HowTo` JSON-LD for:
  - `/calcolatore/` — "Come calcolare lo stipendio netto da frontaliere"
  - `/guida/permesso-g/` — "Come richiedere il permesso G"
  - `/guida/iscrizione-aire/` — "Come iscriversi all'AIRE"

---

## Part D — Internal linking from existing content

### Task 2.10 — Contextual links from hub pages

- [ ] Add 3-5 contextual links from each existing hub page to new pillars:
  - `/guida/` → Sprint pillars 2.3-2.7
  - `/job-board/` → /lavoro/lugano/, /lavoro/oss-svizzera/
  - `/fisco/` → /fisco/tasse-svizzere/, /guida/frontalieri-nuova-legge-2026/
- [ ] Use descriptive anchors (no "clicca qui")

### Task 2.11 — Breadcrumbs on every new page

- [ ] BreadcrumbList JSON-LD + visual breadcrumb on all Sprint-2 pages

---

## Acceptance criteria

- [ ] Zero pages with <300 words in `dist/` (CI gate)
- [ ] 5 new pillar pages live in all 4 locales
- [ ] 15 FAQPage markups validated via Rich Results Test
- [ ] All new pages appear in sitemap.xml
- [ ] `npx vitest run` passes
- [ ] `npm run build` exits 0
- [ ] Manual Playwright check: all new pages render in browser, no layout bugs
- [ ] Semrush position tracking campaign updated with new target keywords

---

## Execution order

**Week 1:** Tasks 2.1-2.2 (thin content, unblocks CLAUDE.md violation)
**Week 2:** Tasks 2.3-2.7 (new pillars, ordered by volume descending)
**Parallel:** Tasks 2.8-2.11 (can ship independently per page)

Total estimate: **5-7 working days** plus copy review.

---

## Post-launch monitoring (2-4 weeks after deploy)

- Track impressions + clicks per new pillar in GSC
- Track Semrush position tracking for the 7 target keywords
- Adjust content based on what SERPs reward (add/remove sections)
