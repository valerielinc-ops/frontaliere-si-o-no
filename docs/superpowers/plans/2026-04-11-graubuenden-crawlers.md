# Graubünden Region Job Crawlers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dedicated job crawlers for 20 new companies operating in Graubünden (canton GR), expanding job board coverage to Switzerland's largest canton and a major cross-border worker region (Grigioni italiani — Poschiavo, Brusio, Valposchiavo).

**Architecture:** Each crawler follows the standard 4-file pattern: parser (fetch+parse), runner (30-line entry point calling `runStandardCrawlerPipeline`), GitHub Actions workflow (dispatch-triggered), and Vitest unit tests. All parsers import shared utilities from `crawler-template.mjs` and `dedicated-crawler-common.mjs`. The scaffold generator (`scripts/scaffold-crawler.mjs`) creates the boilerplate; implementation work focuses on the parser's `fetchJobListings()` function — adapting it to each company's career page technology (JSON API, HTML scraping, Refline, Umantis, Teamtailor, rexx, etc.).

**Tech Stack:** Node.js 22, Vitest 4, GitHub Actions, `crawler-template.mjs` pipeline, `dedicated-crawler-common.mjs` utilities, `target-swiss-locations.mjs` for canton inference.

---

## Remote Verification Pattern (applies to every task)

Every crawler task includes a **trigger → verify → fix** loop after the local implementation. This is the critical quality gate — local tests validate code structure, but the remote workflow validates real-world data extraction.

### The Loop

```
commit+push → trigger workflow → wait for completion → pull results → validate output
    ↑                                                                       │
    └───── fix parser ◄──── read failed logs ◄──── validation failed? ──────┘
```

### Validation Script (reusable)

Save this as a local helper or run inline. Replace `{KEY}` with the company key:

```bash
git pull && node -e "
  const slug = '{KEY}';
  const fs = require('fs');
  const f = 'data/jobs/by-crawler/' + slug + '.json';
  if (!fs.existsSync(f)) { console.error('❌ File missing:', f); process.exit(1); }
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  const jobs = Array.isArray(d) ? d : d.jobs || [];
  console.log('📊 Total jobs:', jobs.length);
  if (jobs.length === 0) { console.error('❌ ZERO JOBS — parser needs fixing'); process.exit(1); }
  let issues = 0;
  jobs.forEach((j, i) => {
    const errs = [];
    if (!j.title || j.title.length < 3) errs.push('title<3');
    if (!j.url || !j.url.startsWith('http')) errs.push('bad URL');
    if (!j.description || j.description.length < 30) errs.push('desc<30');
    if (!j.location) errs.push('no location');
    if (!j.canton) errs.push('no canton');
    if (errs.length) { console.warn('⚠️ Job', i, j.title, '→', errs.join(', ')); issues++; }
  });
  console.log(issues ? '❌ ' + issues + ' jobs with issues' : '✅ All jobs valid');
  const cantons = {};
  jobs.forEach(j => { cantons[j.canton] = (cantons[j.canton]||0)+1; });
  console.log('Cantons:', JSON.stringify(cantons));
"
```

### When to check workflow logs

```bash
# List recent runs
gh run list --workflow=update-jobs-{KEY}.yml --limit 3

# View failed step logs
gh run view <RUN_ID> --log-failed

# Common failure patterns:
# - HTTP 403/429: rate limiting → add delay, reduce concurrency
# - HTTP 404: wrong API URL → re-research career page
# - 0 jobs returned: wrong location filter or API response format changed
# - Parse errors: field names don't match actual API response
# - url_not_{KEY}_domain: add ATS domain to isTrustedDomain()
```

---

## Existing GR Crawlers (already covered — DO NOT duplicate)

- `ferrovia-retica` → Rätische Bahn (RhB), rhb.ch
- `ems-chemie` → EMS-Chemie, Domat/Ems
- `cedes` → Cedes AG, Landquart
- `davos-klosters-bergbahnen` → Davos Klosters Bergbahnen AG
- `grace` / `grace-la-margna` → Grace Hotels, St. Moritz
- `ksgr` / `kantonsspital-graubuenden-ksgr` → Kantonsspital Graubünden, Chur
- `hoval` → Hoval AG, Vaduz/GR
- `hilcona` → Hilcona AG, Schaan/GR
- `rittmeyer` → Rittmeyer AG
- `interroll` → Interroll, Sant'Antonino/GR

Multi-canton crawlers that already pick up GR jobs: `ubs`, `swiss-life`, `swisscom`, `sunrise`, `migros`, `coop`, `sbb`, `aldi-suisse`, `lidl`, `denner`, `interdiscount`, `transgourmet`, `jumbo`, `mobiliar`, `axa`, `allianz`, `fielmann`, `postch`, `ruag`, `skyguide`, `srg-ssr`.

## Excluded Companies

- **Waldhaus Flims** — Hotel closed for renovation, reopening Winter 2026-2027. No career page available.
- **Savognin Bergbahnen** — Career page returns 403 (WAF blocked). Cannot crawl.
- **GVG (Gebäudeversicherung GR)** — Career page returns 429 (Vercel rate limiting). Cannot crawl.
- **PHGR (Pädagogische Hochschule)** — Power Apps Portal with Dynamics 365 backend, 0 current jobs. Too complex for no payoff.
- **EWD Davos** — ColdFusion site, 0 current jobs. Too low volume.
- **Bergbahnen Scuol** — 0 current jobs, Drupal+Vue SPA.
- **EKW (Engadiner Kraftwerke)** — Only apprenticeship via Yousty widget, ~1 listing.
- **Engadin St. Moritz Mountains AG** — Only ~2 jobs as PDF uploads in TYPO3 accordion. Too low volume, PDF-only.
- **Arosa/Lenzerheide Bergbahnen** — ~1 job, links to professional.ch. Too low volume.
- **IBC Energie Wasser Chur** — WordPress, ~1 job. Too low volume.
- **Suvretta House** — Jobs only on external HotelCareer.com, 0 on own site.
- **ewz (Elektrizitätswerk Zürich)** — AEM microfrontend, primarily Zurich employer. Too complex.
- **Gemeinde Davos** — iCMS (Abraxas) JS-rendered, unknown job count. Too complex for likely low volume.
- **KHR (Kraftwerke Hinterrhein)** — SiteHub/Webcard CMS, unknown job count. Too niche.

---

## Companies To Implement (20)

Ordered by estimated job volume (highest first) to maximize impact early.

| # | Company Key | Company Name | Jobs | Career URL | Source Lang | Source Type |
|---|-------------|-------------|------|-----------|-------------|-------------|
| 1 | `pdgr` | Psychiatrische Dienste Graubünden | ~61 | pdgr.ch/jobs-uebersicht/offene-stellen/ | de | WordPress SSR HTML |
| 2 | `kanton-gr` | Kantonale Verwaltung Graubünden | ~42 | apply.refline.ch/514915/search.html | de | Refline HTML |
| 3 | `kulm-hotel` | Kulm Hotel St. Moritz | ~31 | careers.kulm.com/en/vacancies | en | Custom Laravel (sitemap) |
| 4 | `weisse-arena` | Weisse Arena Gruppe (LAAX) | ~20-50 | weissearena.com/jobs/ | de | Lumesse TalentLink |
| 5 | `flury-stiftung` | Flury Stiftung | ~20 | flurystiftung.ch/de/jobs | de | Drupal + PDF links |
| 6 | `hochgebirgsklinik-davos` | Hochgebirgsklinik Davos | ~10-27 | karriere.hochgebirgsklinik.ch | de | Connectoor/job-shop Nuxt |
| 7 | `badrutts-palace` | Badrutt's Palace Hotel | ~13 | jobs.badruttscareers.com | en | Teamtailor RSS |
| 8 | `rss-surselva` | Regionalspital Surselva | ~10-17 | rss.ch/jobs-und-karriere/offene-stellen/ | de | Ostendis JobPublisher |
| 9 | `integra-biosciences` | INTEGRA Biosciences | ~10-15 | integra-biosciences.com/careers | en | Cloudflare-protected |
| 10 | `spital-thusis` | Spital Thusis | ~11 | spitalthusis.ch/karriere-jobs/offene-stellen/ | de | Rukzuk CMS static HTML |
| 11 | `gkb` | Graubündner Kantonalbank | ~10-20 | gkb.ch/offene-stellen | de | Umantis (tenant 2607) |
| 12 | `tschuggen` | Tschuggen Collection | ~9 | recruitingapp-2904.umantis.com/Jobs/All | de | Umantis iframe HTML |
| 13 | `cseb` | Center da Sanadad Engiadina Bassa | ~10-15 | jobs.cseb.ch | de | Abacus Job Portal SPA |
| 14 | `somedia` | Somedia AG | ~6 | jobs.somedia.ch | de | rexx systems HTML |
| 15 | `spital-davos` | Spital Davos | ~6 | spitaldavos.ch/de/offene-stellen | de | Umantis (tenant 2966) |
| 16 | `fhgr` | Fachhochschule Graubünden | ~5-10 | jobs.fhgr.ch/Jobs/All | de | Umantis |
| 17 | `wuerth-international` | Würth International | ~5-10 | wurth-international.com/Job-Portal/ | de | Custom DataTables |
| 18 | `heineken-ch` | Heineken Switzerland (Calanda) | ~5-9 | careers.theheinekencompany.com/Switzerland | de | SuccessFactors |
| 19 | `giardino` | Giardino Group | ~3 | giardinohotels.ch/en/giardino-group/jobs/ | en | WordPress + FacetWP |
| 20 | `gemeinde-st-moritz` | Gemeinde St. Moritz | ~2 | gemeinde-stmoritz.ch/aktuelles/offene-stellen | de | TYPO3 static HTML |

---

## Implementation Phases

### Phase 1: High-Volume Crawlers (Tasks 1-8) — Companies with 10+ jobs
### Phase 2: Medium-Volume Crawlers (Tasks 9-15) — Companies with 5-15 jobs
### Phase 3: Low-Volume Crawlers (Tasks 16-20) — Companies with 2-10 jobs

Each task follows the identical pattern below. The scaffold generates ~90% of the code; the remaining work is implementing `fetchJobListings()` in the parser to match each company's career page technology.

---

## Pre-Implementation Setup

### Task 0: Register Graubünden Company Locations

**Files:**
- Modify: `scripts/lib/crawler-location-config.mjs` (GR section, after existing entries around line 157)

- [ ] **Step 1: Add all 20 company HQ entries to the GR section**

```javascript
// ── Graubünden / Grisons (GR) — new employers ──
'pdgr':                         { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
'kanton-gr':                    { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
'kulm-hotel':                   { city: 'St. Moritz',         canton: 'GR', postalCode: '7500', addressRegion: 'GR' },
'weisse-arena':                 { city: 'Laax',               canton: 'GR', postalCode: '7031', addressRegion: 'GR' },
'flury-stiftung':               { city: 'Schiers',            canton: 'GR', postalCode: '7220', addressRegion: 'GR' },
'hochgebirgsklinik-davos':      { city: 'Davos',              canton: 'GR', postalCode: '7270', addressRegion: 'GR' },
'badrutts-palace':              { city: 'St. Moritz',         canton: 'GR', postalCode: '7500', addressRegion: 'GR' },
'rss-surselva':                 { city: 'Ilanz',              canton: 'GR', postalCode: '7130', addressRegion: 'GR' },
'integra-biosciences':          { city: 'Zizers',             canton: 'GR', postalCode: '7205', addressRegion: 'GR' },
'spital-thusis':                { city: 'Thusis',             canton: 'GR', postalCode: '7430', addressRegion: 'GR' },
'gkb':                          { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
'tschuggen':                    { city: 'Arosa',              canton: 'GR', postalCode: '7050', addressRegion: 'GR' },
'cseb':                         { city: 'Scuol',              canton: 'GR', postalCode: '7550', addressRegion: 'GR' },
'somedia':                      { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
'spital-davos':                 { city: 'Davos',              canton: 'GR', postalCode: '7270', addressRegion: 'GR' },
'fhgr':                         { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
'wuerth-international':         { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
'heineken-ch':                  { city: 'Chur',               canton: 'GR', postalCode: '7000', addressRegion: 'GR' },
'giardino':                     { city: 'Champfèr',           canton: 'GR', postalCode: '7512', addressRegion: 'GR' },
'gemeinde-st-moritz':           { city: 'St. Moritz',         canton: 'GR', postalCode: '7500', addressRegion: 'GR' },
```

- [ ] **Step 2: Verify no duplicates exist**

```bash
grep -c "pdgr\|kanton-gr\|kulm-hotel\|weisse-arena\|flury-stiftung\|hochgebirgsklinik\|badrutts-palace\|rss-surselva\|integra-biosciences\|spital-thusis\|gkb\|tschuggen\|cseb\|somedia\|spital-davos\|fhgr\|wuerth-international\|heineken-ch\|giardino\|gemeinde-st-moritz" scripts/lib/crawler-location-config.mjs
```

Expected: only the lines we just added (no pre-existing entries for these keys).

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/crawler-location-config.mjs
git commit -m "feat(crawler): register 20 Graubünden company locations"
```

---

## Phase 1: High-Volume Crawlers (10+ jobs)

### Task 1: PDGR — Psychiatrische Dienste Graubünden (~61 jobs)

**Career page tech:** WordPress with server-side rendered job listings. Each job card has structured `data-filter` attributes for category, location, and specialty. 61 job cards with class `jobs-post grid-item`. Detail pages at `/jobs/{slug}/`.

**ATS:** WordPress custom post type, no external ATS. All content SSR.

**Files:**
- Create: `scripts/lib/pdgr-job-parser.mjs`
- Create: `scripts/update-pdgr-jobs.mjs`
- Create: `.github/workflows/update-jobs-pdgr.yml`
- Create: `tests/pdgr-crawler.test.ts`

- [ ] **Step 1: Scaffold the crawler**

```bash
node scripts/scaffold-crawler.mjs pdgr \
  --name "Psychiatrische Dienste Graubünden" \
  --domain "pdgr.ch" \
  --lang de \
  --source html \
  --url "https://www.pdgr.ch/jobs-uebersicht/offene-stellen/"
```

- [ ] **Step 2: Implement the parser**

The listing page at `https://www.pdgr.ch/jobs-uebersicht/offene-stellen/` renders all ~61 jobs server-side in HTML. Each job card has class `jobs-post grid-item` with `data-filter` attributes for category/location. Job detail pages at `/jobs/{slug}/`.

Parser strategy:
1. Fetch listing page HTML
2. Parse all `<div class="jobs-post grid-item">` elements
3. Extract title, link to detail page, location, category from data attributes
4. Fetch each detail page for full description
5. Build ParsedJob objects

Key selectors:
- Job card: `div.jobs-post.grid-item`
- Title: `<h3>` or `<a>` within the card
- Detail link: `<a href="/jobs/{slug}/">`
- Location: `data-filter` attribute containing location
- Pensum: `data-efrom` and `data-eto` attributes

**Important:** `isTrustedDomain()` must trust `pdgr.ch`.

- [ ] **Step 3: Run scaffolded tests**

```bash
npx vitest run tests/pdgr-crawler.test.ts
```

- [ ] **Step 4: Commit + push + trigger + verify**

```bash
git add scripts/lib/pdgr-job-parser.mjs scripts/update-pdgr-jobs.mjs .github/workflows/update-jobs-pdgr.yml tests/pdgr-crawler.test.ts
git commit -m "feat(crawler): add PDGR job crawler (WordPress SSR)"
git push
gh workflow run update-jobs-pdgr.yml
# Wait ~2 min, then:
gh run list --workflow=update-jobs-pdgr.yml --limit 1
# If failed: gh run view <ID> --log-failed → fix → re-push → re-trigger
```

---

### Task 2: Kantonale Verwaltung Graubünden (~42 jobs)

**Career page tech:** Redirects to **Refline** (Swiss ATS) at `https://apply.refline.ch/514915/search.html?lang=de`. Tenant ID: 514915. Static HTML table with `class="position"` rows. Each job links to `https://apply.refline.ch/514915/{jobId}/pub/{n}/index.html`.

**ATS:** Refline — server-side rendered HTML table. No JS needed.

**Files:**
- Create: `scripts/lib/kanton-gr-job-parser.mjs`
- Create: `scripts/update-kanton-gr-jobs.mjs`
- Create: `.github/workflows/update-jobs-kanton-gr.yml`
- Create: `tests/kanton-gr-crawler.test.ts`

- [ ] **Step 1: Scaffold the crawler**

```bash
node scripts/scaffold-crawler.mjs kanton-gr \
  --name "Kantonale Verwaltung Graubünden" \
  --domain "gr.ch" \
  --lang de \
  --source html \
  --url "https://apply.refline.ch/514915/search.html?lang=de"
```

- [ ] **Step 2: Implement the parser**

Fetch `https://apply.refline.ch/514915/search.html?lang=de`. Parse the HTML table rows with `class="position"`. Columns: Position (title + link), Amt (department), Arbeitsort (location), Pensum (workload%). Each row links to a detail page for description.

Also check `https://apply.refline.ch/514915/apprentice.html` and `https://apply.refline.ch/514915/stage.html` for apprenticeship/internship listings.

**Important:** `isTrustedDomain()` must trust both `gr.ch` and `refline.ch` domains.

- [ ] **Step 3: Run scaffolded tests, commit, push, trigger, verify**

Same pattern as Task 1.

---

### Task 3: Kulm Hotel St. Moritz (~31 jobs)

**Career page tech:** Custom Laravel/Vite SPA at `careers.kulm.com`. The listing page is a JS SPA, but **individual detail pages ARE server-rendered**. The sitemap at `https://careers.kulm.com/sitemap.xml` lists all 31 vacancy URLs across EN/DE/IT locales (pattern: `/en/vacancies/{id}`).

**ATS:** Custom Laravel portal. No standard ATS.

**Files:**
- Create: `scripts/lib/kulm-hotel-job-parser.mjs`
- Create: `scripts/update-kulm-hotel-jobs.mjs`
- Create: `.github/workflows/update-jobs-kulm-hotel.yml`
- Create: `tests/kulm-hotel-crawler.test.ts`

- [ ] **Step 1: Scaffold the crawler**

```bash
node scripts/scaffold-crawler.mjs kulm-hotel \
  --name "Kulm Hotel St. Moritz" \
  --domain "kulm.com" \
  --lang en \
  --source html \
  --url "https://careers.kulm.com/sitemap.xml"
```

- [ ] **Step 2: Implement the parser**

Strategy: sitemap-driven crawling.
1. Fetch `https://careers.kulm.com/sitemap.xml`
2. Extract all `/en/vacancies/{id}` URLs (ignore `/de/` and `/it/` duplicates)
3. Fetch each detail page (server-rendered HTML with full job description)
4. Parse title, description, location from the detail page
5. Build ParsedJob objects

**Important:** `isTrustedDomain()` must trust `kulm.com` and `careers.kulm.com`.

- [ ] **Step 3: Run tests, commit, push, trigger, verify**

---

### Task 4: Weisse Arena Gruppe / LAAX (~20-50 jobs)

**Career page tech:** WordPress landing page at `weissearena.com/offene-stellen/` links to `weissearena.com/jobs/` which loads a **Lumesse TalentLink** (now Cegid TalentLink) widget. Site tech ID: `PD6FK026203F3VBQBLO8NV79D`. Host: `emea3.recruitmentplatform.com`.

**ATS:** Lumesse/Cegid TalentLink — JS widget, requires API reverse-engineering or headless browser.

**Files:**
- Create: `scripts/lib/weisse-arena-job-parser.mjs`
- Create: `scripts/update-weisse-arena-jobs.mjs`
- Create: `.github/workflows/update-jobs-weisse-arena.yml`
- Create: `tests/weisse-arena-crawler.test.ts`

- [ ] **Step 1: Scaffold the crawler**

```bash
node scripts/scaffold-crawler.mjs weisse-arena \
  --name "Weisse Arena Gruppe" \
  --domain "weissearena.com" \
  --lang de \
  --source api \
  --url "https://emea3.recruitmentplatform.com"
```

- [ ] **Step 2: Research the TalentLink API**

Open `https://www.weissearena.com/jobs/` in browser DevTools → Network tab. The Lumesse widget loads from `emea3.recruitmentplatform.com`. Look for:
- JSON/XML API calls the widget makes
- Site tech ID: `PD6FK026203F3VBQBLO8NV79D`
- Standard TalentLink API patterns: `/api/jobs`, `/feed/`, RSS endpoints
- Try: `https://emea3.recruitmentplatform.com/syndicated/lay4T2PD6FK026203F3VBQBLO8NV79D/syndication/xml`

If no public API found, use the Weglot-translated HTML page at `/offene-stellen/` which may have some job data server-rendered.

**Important:** `isTrustedDomain()` must trust `weissearena.com` and `recruitmentplatform.com`.

- [ ] **Step 3: Implement parser, run tests, commit, push, trigger, verify**

---

### Task 5: Flury Stiftung (~20 jobs)

**Career page tech:** Drupal CMS at `flurystiftung.ch/de/jobs`. Jobs are listed as **PDF file downloads** in `<span class="file file--mime-application-pdf">` elements. ~20 unique PDF job listings.

**ATS:** None — Drupal CMS with PDF attachments.

**Files:**
- Create: `scripts/lib/flury-stiftung-job-parser.mjs`
- Create: `scripts/update-flury-stiftung-jobs.mjs`
- Create: `.github/workflows/update-jobs-flury-stiftung.yml`
- Create: `tests/flury-stiftung-crawler.test.ts`

- [ ] **Step 1: Scaffold the crawler**

```bash
node scripts/scaffold-crawler.mjs flury-stiftung \
  --name "Flury Stiftung" \
  --domain "flurystiftung.ch" \
  --lang de \
  --source html \
  --url "https://www.flurystiftung.ch/de/jobs"
```

- [ ] **Step 2: Implement the parser**

Strategy:
1. Fetch `https://www.flurystiftung.ch/de/jobs`
2. Extract all PDF links from `<span class="file file--mime-application-pdf">` → `<a>` elements
3. Use the `<a>` text as the job title (PDF filename is the job posting)
4. Categorize listings (Lehrstellen, Unterassistenzstellen, regular positions) from surrounding HTML structure
5. Build description from title + company + location (PDF content is not parseable at scale)

The job URL should point to the PDF file at `/sites/default/files/{path}`. Location defaults to Schiers (Prättigau) but check surrounding HTML for location hints.

**Important:** `isTrustedDomain()` must trust `flurystiftung.ch`.

- [ ] **Step 3: Run tests, commit, push, trigger, verify**

---

### Task 6: Hochgebirgsklinik Davos (~10-27 jobs)

**Career page tech:** **Connectoor / job-shop.com** Nuxt.js SPA at `karriere.hochgebirgsklinik.ch`. Job shop ID: `9c3b04cb-7265-5acb-a208-199c8a9d547a`. Uses Typesense for search. The page is 1.3MB due to embedded `__NUXT_DATA__` that may contain serialized job data.

**ATS:** Connectoor/job-shop.com — Nuxt SSR with possible NUXT_DATA extraction.

**Files:**
- Create: `scripts/lib/hochgebirgsklinik-davos-job-parser.mjs`
- Create: `scripts/update-hochgebirgsklinik-davos-jobs.mjs`
- Create: `.github/workflows/update-jobs-hochgebirgsklinik-davos.yml`
- Create: `tests/hochgebirgsklinik-davos-crawler.test.ts`

- [ ] **Step 1: Scaffold the crawler**

```bash
node scripts/scaffold-crawler.mjs hochgebirgsklinik-davos \
  --name "Hochgebirgsklinik Davos" \
  --domain "hochgebirgsklinik.ch" \
  --lang de \
  --source html \
  --url "https://karriere.hochgebirgsklinik.ch/"
```

- [ ] **Step 2: Implement the parser**

Strategy: Parse the `__NUXT_DATA__` JSON blob from the page source. The Nuxt SSR embeds all job data in a serialized format within `<script id="__NUXT_DATA__">` tags. Extract job listings from this data.

Alternative: Use the Typesense search API if API key is embedded in the NUXT data.

Company vanity: `hochgebirgsklinik-davos`. Static assets from `tc-media.job-shop.com`.

**Important:** `isTrustedDomain()` must trust `hochgebirgsklinik.ch` and `job-shop.com`.

- [ ] **Step 3: Run tests, commit, push, trigger, verify**

---

### Task 7: Badrutt's Palace Hotel (~13 jobs)

**Career page tech:** **Teamtailor** at `jobs.badruttscareers.com`. Provides an RSS feed at `https://jobs.badruttscareers.com/en-GB/jobs.rss` with all job listings. Company ID: `2ca556c7-896b-4764-aca7-ed8ce3a91b49`.

**ATS:** Teamtailor — RSS feed available. Easiest crawler in this plan.

**Files:**
- Create: `scripts/lib/badrutts-palace-job-parser.mjs`
- Create: `scripts/update-badrutts-palace-jobs.mjs`
- Create: `.github/workflows/update-jobs-badrutts-palace.yml`
- Create: `tests/badrutts-palace-crawler.test.ts`

- [ ] **Step 1: Scaffold the crawler**

```bash
node scripts/scaffold-crawler.mjs badrutts-palace \
  --name "Badrutt's Palace Hotel" \
  --domain "badruttscareers.com" \
  --lang en \
  --source api \
  --url "https://jobs.badruttscareers.com/en-GB/jobs.rss"
```

- [ ] **Step 2: Implement the parser**

Fetch `https://jobs.badruttscareers.com/en-GB/jobs.rss`. Parse the RSS XML feed to extract `<item>` entries with `<title>`, `<link>`, `<description>`, `<pubDate>`.

This is identical to the `csd-engineers` crawler pattern which uses Teamtailor RSS at `jobs.csd.ch/jobs.rss`. Reference `scripts/lib/csd-engineers-job-parser.mjs` for the RSS parsing approach.

Job detail URLs follow pattern `/en-GB/jobs/{id}-{slug}`.

**Important:** `isTrustedDomain()` must trust `badruttscareers.com` and `teamtailor.com`.

- [ ] **Step 3: Run tests, commit, push, trigger, verify**

---

### Task 8: Regionalspital Surselva (~10-17 jobs)

**Career page tech:** WordPress site at `rss.ch` (rebranded from Spital Ilanz). Job listings loaded via **Ostendis JobPublisher** widget. The Ostendis script at `https://odm.ostendis.com/ojp/assets/loader` populates a `#ostendisJobs` div.

**ATS:** Ostendis JobPublisher — JS widget, requires API reverse-engineering or headless browser.

**Files:**
- Create: `scripts/lib/rss-surselva-job-parser.mjs`
- Create: `scripts/update-rss-surselva-jobs.mjs`
- Create: `.github/workflows/update-jobs-rss-surselva.yml`
- Create: `tests/rss-surselva-crawler.test.ts`

- [ ] **Step 1: Scaffold the crawler**

```bash
node scripts/scaffold-crawler.mjs rss-surselva \
  --name "Regionalspital Surselva" \
  --domain "rss.ch" \
  --lang de \
  --source html \
  --url "https://www.rss.ch/jobs-und-karriere/offene-stellen/"
```

- [ ] **Step 2: Research the Ostendis API**

Open `https://www.rss.ch/jobs-und-karriere/offene-stellen/` in browser DevTools → Network tab. The Ostendis loader fires `ostendisLoaderReady` event and populates `#ostendisJobs`. Look for:
- XHR/fetch calls to `odm.ostendis.com` API endpoints
- JSON responses with job data
- API patterns: `/ojp/api/jobs`, `/ojp/api/positions`

If no public API found, fallback to headless browser (Playwright).

**Important:** `isTrustedDomain()` must trust `rss.ch` and `ostendis.com`.

- [ ] **Step 3: Implement parser, run tests, commit, push, trigger, verify**

---

## Phase 2: Medium-Volume Crawlers (5-15 jobs)

### Task 9: INTEGRA Biosciences (~10-15 jobs)

**Career page tech:** Drupal site behind **Cloudflare** bot protection at `integra-biosciences.com`. All automated requests return 403 challenge pages.

**ATS:** Unknown — Cloudflare blocks curl. Requires headless browser with Cloudflare bypass.

**Files:**
- Create: `scripts/lib/integra-biosciences-job-parser.mjs`
- Create: `scripts/update-integra-biosciences-jobs.mjs`
- Create: `.github/workflows/update-jobs-integra-biosciences.yml`
- Create: `tests/integra-biosciences-crawler.test.ts`

- [ ] **Step 1: Scaffold the crawler**

```bash
node scripts/scaffold-crawler.mjs integra-biosciences \
  --name "INTEGRA Biosciences" \
  --domain "integra-biosciences.com" \
  --lang en \
  --source html \
  --url "https://www.integra-biosciences.com/global/en/careers/open-positions"
```

- [ ] **Step 2: Research bypass strategy**

Try these approaches:
1. Check if `integra-biosciences.com/switzerland/de/careers/open-positions` works better
2. Look for a JSON API or sitemap that isn't Cloudflare-protected
3. Check if they post to jobs.ch, LinkedIn, or another aggregator with a stable API
4. As last resort: build a Playwright-based crawler (reference existing patterns)

**Important:** `isTrustedDomain()` must trust `integra-biosciences.com`.

- [ ] **Step 3: Implement parser, run tests, commit, push, trigger, verify**

---

### Task 10: Spital Thusis (~11 jobs)

**Career page tech:** **Rukzuk CMS** at `spitalthusis.ch`. Static HTML pages, no JS needed. 11 unique job pages under `/karriere-jobs/offene-stellen/{slug}/`. Each page is a standalone CMS page with job description.

**ATS:** None — Rukzuk CMS static pages. Very straightforward.

**Files:**
- Create: `scripts/lib/spital-thusis-job-parser.mjs`
- Create: `scripts/update-spital-thusis-jobs.mjs`
- Create: `.github/workflows/update-jobs-spital-thusis.yml`
- Create: `tests/spital-thusis-crawler.test.ts`

- [ ] **Step 1: Scaffold the crawler**

```bash
node scripts/scaffold-crawler.mjs spital-thusis \
  --name "Spital Thusis" \
  --domain "spitalthusis.ch" \
  --lang de \
  --source html \
  --url "https://www.spitalthusis.ch/karriere-jobs/offene-stellen/"
```

- [ ] **Step 2: Implement the parser**

Fetch listing page, extract all `<a href="/karriere-jobs/offene-stellen/{slug}/">` links. Fetch each detail page for title and description. Job slugs include pensum percentage info.

**Important:** `isTrustedDomain()` must trust `spitalthusis.ch`.

- [ ] **Step 3: Run tests, commit, push, trigger, verify**

---

### Task 11: Graubündner Kantonalbank / GKB (~10-20 jobs)

**Career page tech:** AEM website with **Haufe Umantis** (Abacus-Umantis) widget. Umantis tenant: `recruitingapp-2607.umantis.com`. Job listings load via client-side JS.

**ATS:** Umantis — JS widget. Needs headless browser or Umantis API.

**Files:**
- Create: `scripts/lib/gkb-job-parser.mjs`
- Create: `scripts/update-gkb-jobs.mjs`
- Create: `.github/workflows/update-jobs-gkb.yml`
- Create: `tests/gkb-crawler.test.ts`

- [ ] **Step 1: Scaffold + implement + verify** (same pattern)

Try Umantis direct URL: `https://recruitingapp-2607.umantis.com/Jobs/All?lang=ger` — if it returns server-rendered HTML (like Tschuggen), parse directly. If client-side, use headless browser.

**Important:** `isTrustedDomain()` must trust `gkb.ch` and `umantis.com`.

---

### Task 12: Tschuggen Collection (~9 jobs)

**Career page tech:** **Umantis** iframe at `https://recruitingapp-2904.umantis.com/Jobs/All?lang=eng`. The iframe content is **server-rendered HTML** — directly parseable. Confirmed 9 jobs: Reservation Agent, Chef de Rang, Hoteltechniker, F&B Manager, Chef de Partie ×2, Outdoor Butler, Reservation/Revenue Manager, Sous Chef.

**ATS:** Umantis — SSR iframe HTML. Easy.

**Files:**
- Create: `scripts/lib/tschuggen-job-parser.mjs`
- Create: `scripts/update-tschuggen-jobs.mjs`
- Create: `.github/workflows/update-jobs-tschuggen.yml`
- Create: `tests/tschuggen-crawler.test.ts`

- [ ] **Step 1: Scaffold + implement + verify**

Fetch `https://recruitingapp-2904.umantis.com/Jobs/All?lang=ger` directly. Parse the server-rendered HTML table for job listings. Detail pages at `/Vacancies/{id}/Description`.

Search filters available: department (Finance, Marketing, HR, Rooms, F&B, etc.), location (St. Moritz, Arosa, Ascona/Tessin).

**Important:** `isTrustedDomain()` must trust `tschuggencollection.ch` and `umantis.com`.

---

### Task 13: CSEB Scuol (~10-15 jobs)

**Career page tech:** **Abacus Job Portal** SPA at `jobs.cseb.ch`. Portal ID: `d9c5a048-f665-4e64-a2c7-cdd8231bac77`. Vue.js SPA that authenticates via Keycloak for API calls to `api.jobportal.abaservices.ch`.

**ATS:** Abacus Job Portal — complex SPA with auth. Requires headless browser.

**Files:**
- Create: `scripts/lib/cseb-job-parser.mjs`
- Create: `scripts/update-cseb-jobs.mjs`
- Create: `.github/workflows/update-jobs-cseb.yml`
- Create: `tests/cseb-crawler.test.ts`

- [ ] **Step 1: Scaffold + implement + verify**

Research the Abacus Job Portal API flow:
1. Check if `https://api.jobportal.abaservices.ch/api/jobportals/d9c5a048-f665-4e64-a2c7-cdd8231bac77/jobs` works with any public/anonymous token
2. If auth required: use headless browser to load `jobs.cseb.ch`, wait for JS to render, extract job data from DOM
3. Alternative: check if CSEB also posts to jobs.ch or suedostschweizjobs.ch

**Important:** `isTrustedDomain()` must trust `cseb.ch` and `abaservices.ch`.

---

### Task 14: Somedia AG (~6 jobs)

**Career page tech:** **rexx systems** ATS at `jobs.somedia.ch`. Server-rendered HTML with clean job listing page at `https://jobs.somedia.ch/stellenangebote.html`. Detail pages follow pattern `https://jobs.somedia.ch/{Title}-de-j{ID}.html`.

**ATS:** rexx systems — server-rendered HTML. Easy.

**Files:**
- Create: `scripts/lib/somedia-job-parser.mjs`
- Create: `scripts/update-somedia-jobs.mjs`
- Create: `.github/workflows/update-jobs-somedia.yml`
- Create: `tests/somedia-crawler.test.ts`

- [ ] **Step 1: Scaffold + implement + verify**

Fetch `https://jobs.somedia.ch/stellenangebote.html`. Parse job listing entries with links to detail pages. Detail page URL pattern: `/{Title}-de-j{ID}.html`. Fetch each detail page for full description.

Reference: similar to `matterhorn-gotthard-bahn-job-parser.mjs` which scrapes HTML listing + detail pages.

**Important:** `isTrustedDomain()` must trust `somedia.ch` and `jobs.somedia.ch`.

---

### Task 15: Spital Davos (~6 jobs)

**Career page tech:** Drupal site with **Haufe Umantis** (Abacus-Umantis) widget. Tenant: `recruitingapp-2966.umantis.com`. Drupal Views block `view-jobs` embeds umantis data.

**ATS:** Umantis — likely client-side rendered. Same approach as GKB (Task 11).

**Files:**
- Create: `scripts/lib/spital-davos-job-parser.mjs`
- Create: `scripts/update-spital-davos-jobs.mjs`
- Create: `.github/workflows/update-jobs-spital-davos.yml`
- Create: `tests/spital-davos-crawler.test.ts`

- [ ] **Step 1: Scaffold + implement + verify**

Try Umantis direct URL: `https://recruitingapp-2966.umantis.com/Jobs/All?lang=ger`. If SSR, parse directly. Also try Drupal JSONAPI at `https://www.spitaldavos.ch/jsonapi/` or `?_format=json`.

**Important:** `isTrustedDomain()` must trust `spitaldavos.ch` and `umantis.com`.

---

## Phase 3: Low-Volume Crawlers (2-10 jobs)

### Task 16: FHGR — Fachhochschule Graubünden (~5-10 jobs)

**Career page tech:** **Abacus-Umantis** at `jobs.fhgr.ch/Jobs/All?lang=ger`. Meta tag confirms: `<meta name="ATS" content="Abacus-Umantis">`. Client-side rendered with `globalUmantisParams` config. Multilingual (ger/eng).

**ATS:** Umantis — same approach as Tasks 11, 12, 15.

**Files:**
- Create: `scripts/lib/fhgr-job-parser.mjs` + runner + workflow + test

- [ ] **Step 1: Scaffold + implement + verify**

Fetch `https://jobs.fhgr.ch/Jobs/All?lang=ger`. Parse Umantis HTML if SSR, or headless browser if client-side.

---

### Task 17: Würth International (~5-10 jobs)

**Career page tech:** Custom PHP site with jQuery **DataTables** at `wurth-international.com/.../Jobs.php`. Table ID: `sortableTable9375499`. Jobs load via AJAX/JSON into DataTables. Bilingual (DE/EN).

**ATS:** Custom DataTables — need to find AJAX data source.

**Files:**
- Create: `scripts/lib/wuerth-international-job-parser.mjs` + runner + workflow + test

- [ ] **Step 1: Scaffold + implement + verify**

Research: Open the Jobs.php page in browser DevTools → Network tab. Find the AJAX endpoint that feeds DataTables (look at `configDataTables["9375499"]` in JS). Parse the JSON response.

---

### Task 18: Heineken Switzerland / Calanda (~5-9 jobs)

**Career page tech:** **SAP SuccessFactors** global career portal at `careers.theheinekencompany.com`. Switzerland filter: `?location=Switzerland&locale=de_DE`. JS-heavy page using j2w framework.

**ATS:** SuccessFactors — global portal, requires Switzerland location filter.

**Files:**
- Create: `scripts/lib/heineken-ch-job-parser.mjs` + runner + workflow + test

- [ ] **Step 1: Scaffold + implement + verify**

Research the SuccessFactors search API:
1. Open `https://careers.theheinekencompany.com/fs/search?keywords=&location=Switzerland` in DevTools
2. Find the XHR/fetch calls that return job JSON
3. Filter to Switzerland/Chur results
4. Standard SuccessFactors OData API patterns may apply

---

### Task 19: Giardino Group (~3 jobs)

**Career page tech:** **WordPress 6.9.4 + Elementor + FacetWP** at `giardinohotels.ch`. 3 jobs server-rendered with FacetWP filtering. WordPress REST API likely available.

**ATS:** WordPress — easy, SSR.

**Files:**
- Create: `scripts/lib/giardino-job-parser.mjs` + runner + workflow + test

- [ ] **Step 1: Scaffold + implement + verify**

Fetch `https://giardinohotels.ch/en/giardino-group/jobs/`. Parse server-rendered job cards. Try WordPress REST API at `/wp-json/wp/v2/` for structured data. Detail pages at `/en/jobs/{slug}/`.

---

### Task 20: Gemeinde St. Moritz (~2 jobs)

**Career page tech:** **TYPO3 CMS** at `gemeinde-stmoritz.ch`. 2 jobs listed with detail page links at `/aktuelles/aktuelles/offene-stellen/detail/{slug}`. Server-rendered HTML.

**ATS:** TYPO3 — static HTML pages. Easy.

**Files:**
- Create: `scripts/lib/gemeinde-st-moritz-job-parser.mjs` + runner + workflow + test

- [ ] **Step 1: Scaffold + implement + verify**

Fetch listing page. Parse `<a>` links to `/detail/{slug}` pages. Fetch each detail for title and description.

---

## Post-Implementation

### Task 21: Trigger All Workflows + Translation Pipeline

- [ ] **Step 1: Trigger all 20 crawler workflows**

```bash
for key in pdgr kanton-gr kulm-hotel weisse-arena flury-stiftung hochgebirgsklinik-davos badrutts-palace rss-surselva integra-biosciences spital-thusis gkb tschuggen cseb somedia spital-davos fhgr wuerth-international heineken-ch giardino gemeinde-st-moritz; do
  echo "Triggering $key..."
  gh workflow run "update-jobs-${key}.yml" 2>/dev/null || echo "  ⚠️ Failed to trigger $key"
  sleep 2
done
```

- [ ] **Step 2: Monitor completion**

```bash
gh run list --limit=30 --json displayTitle,status,conclusion | python3 -c "
import json,sys
runs = json.load(sys.stdin)
for r in runs:
    t = r['displayTitle']
    if 'Update' in t and 'Jobs' in t:
        c = r.get('conclusion','')
        s = r['status']
        icon = '✅' if c == 'success' else ('🔄' if s == 'in_progress' else '❌')
        print(f'{icon} {t}: {c or s}')
"
```

- [ ] **Step 3: Fix any failures**

For each failed workflow:
1. `gh run view <ID> --log-failed` — read error
2. Fix parser (common issues: wrong selectors, missing trusted domain, wrong API URL)
3. Re-push and re-trigger

- [ ] **Step 4: Trigger translation pipeline**

```bash
gh workflow run translate-pending.yml
```

- [ ] **Step 5: Verify deployment**

After `translate-pending` completes and triggers deploy:
1. Check `https://frontaliereticino.ch/lavoro/` for new GR jobs
2. Verify job pages render with correct JobPosting structured data
3. Check all 4 locales have translations
