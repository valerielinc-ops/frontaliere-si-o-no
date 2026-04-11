# Valais Region Job Crawlers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dedicated job crawlers for 28 new companies operating in Valais (canton VS), expanding job board coverage from Ticino-only to include Switzerland's second-largest cross-border worker region.

**Architecture:** Each crawler follows the standard 4-file pattern: parser (fetch+parse), runner (30-line entry point calling `runStandardCrawlerPipeline`), GitHub Actions workflow (dispatch-triggered), and Vitest unit tests. All parsers import shared utilities from `crawler-template.mjs` and `dedicated-crawler-common.mjs`. The scaffold generator (`scripts/scaffold-crawler.mjs`) creates the boilerplate; implementation work focuses on the parser's `fetchJobListings()` function — adapting it to each company's career page technology (JSON API, HTML scraping, Workday, Greenhouse, etc.).

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
  // Show summary
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
```

---

## Excluded Companies

- **SBB CFF FFS** — Already crawled as `ffs-officine-ferrovie-federali` (existing crawler)
- **API SA** — No official career page found; jobs only listed on third-party boards (jobup.ch). Cannot build a dedicated crawler without a stable source URL.

## Companies To Implement (28)

Ordered by estimated job volume (highest first) to maximize impact early.

| # | Company Key | Company Name | Jobs | Career URL | Source Lang | Source Type |
|---|-------------|-------------|------|-----------|-------------|-------------|
| 1 | `marriott` | Marriott International | ~51 | careers.marriott.com/jobs | en | JSON API |
| 2 | `reboot-monkey` | Reboot Monkey | ~38 | rebootmonkey.com/en/jobs | en | HTML |
| 3 | `arxada` | Arxada | ~22 | arxada.com/en/careers | en | HTML/API |
| 4 | `ubs` | UBS | ~10 | ubs.com/global/en/careers | en | JSON API |
| 5 | `interdiscount` | Interdiscount | ~8 | jobs.interdiscount.ch | de | JSON API |
| 6 | `matterhorn-gotthard-bahn` | Matterhorn Gotthard Bahn | ~8 | jobs.bvzholding.ch | de | HTML |
| 7 | `swiss-life` | Swiss Life | ~6 | swisslife.ch careers | de | JSON API |
| 8 | `siegfried` | Siegfried | ~6 | siegfried.ch/careers | en | HTML/API |
| 9 | `vaxcyte` | Vaxcyte | ~5 | vaxcyte.com/job-listings | en | HTML |
| 10 | `srg-ssr` | SRG SSR | ~4 | jobs.srgssr.ch | de | JSON API |
| 11 | `huntsman` | Huntsman Corporation | ~4 | huntsman.com/careers | en | Workday |
| 12 | `fielmann` | Fielmann Group | ~4 | jobs.fielmann.com | de | JSON API |
| 13 | `fusalp` | Fusalp | ~4 | fusalp.welcomekit.co | fr | Welcomekit API |
| 14 | `localsearch` | localsearch | ~3 | karriere.localsearch.ch | de | JSON API |
| 15 | `tally-weijl` | TALLY WEiJL | ~3 | tally-weijl.com/jobs | en | HTML |
| 16 | `transgourmet` | Transgourmet/Prodega | ~2 | jobs.transgourmet.ch | de | JSON API |
| 17 | `bcvs` | BCVs/WKB | ~2 | bcvs.ch careers | fr | HTML |
| 18 | `coopers` | Coopers Group AG | ~2 | coopers.ch/en/about/join-us | en | HTML |
| 19 | `kone` | KONE | ~2 | careers.kone.com | en | JSON API |
| 20 | `mobiliar` | die Mobiliar | ~2 | jobs.mobiliar.ch | de | JSON API |
| 21 | `bms-building` | BMS Building Materials | ~2 | jobs.bmsuisse.ch | de | HTML |
| 22 | `bls` | BLS AG | ~2 | bls.ch/en careers | de | HTML/API |
| 23 | `berner-montage` | Montagetechnik BERNER AG | ~2 | shop.berner.eu/ch-de/vacancies | de | HTML |
| 24 | `siemens-healthineers` | Siemens Healthineers | ~2 | careers.siemens-healthineers.com | en | JSON API |
| 25 | `csd-engineers` | CSD ENGINEERS | ~2 | jobs.csd.ch | fr | HTML |
| 26 | `fondation-domus` | Fondation Domus | ~2 | fondation-domus.ch/emploi | fr | HTML |
| 27 | `jumbo` | JUMBO | ~2 | jumbo.ch/de/stellen | de | HTML/API |
| 28 | `omega` | OMEGA SA | ~1 | omegawatches.com/careers | en | HTML |

---

## Implementation Phases

### Phase 1: High-Volume Crawlers (Tasks 1-6) — Companies with 8+ jobs
### Phase 2: Medium-Volume Crawlers (Tasks 7-14) — Companies with 3-6 jobs
### Phase 3: Low-Volume Crawlers (Tasks 15-28) — Companies with 1-2 jobs

Each task follows the identical pattern below. The scaffold generates ~90% of the code; the remaining work is implementing `fetchJobListings()` in the parser to match each company's career page technology.

---

## Pre-Implementation Setup

### Task 0: Register Valais Company Locations

**Files:**
- Modify: `scripts/lib/crawler-location-config.mjs:167-176` (Valais section)

- [ ] **Step 1: Add all 28 company HQ entries to the Valais section**

```javascript
// ── Valais / Wallis (VS) — major employers ──
// ... existing entries ...
'marriott':                     { city: 'Zermatt',            canton: 'VS', postalCode: '3920', addressRegion: 'VS' },
'reboot-monkey':                { city: 'Visp',               canton: 'VS', postalCode: '3930', addressRegion: 'VS' },
'arxada':                       { city: 'Visp',               canton: 'VS', postalCode: '3930', addressRegion: 'VS' },
'ubs':                          { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
'interdiscount':                { city: 'Naters',             canton: 'VS', postalCode: '3904', addressRegion: 'VS' },
'matterhorn-gotthard-bahn':     { city: 'Brig',               canton: 'VS', postalCode: '3900', addressRegion: 'VS' },
'swiss-life':                   { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
'siegfried':                    { city: 'Zofingen',            canton: 'AG', postalCode: '4800', addressRegion: 'AG' },
'vaxcyte':                      { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
'srg-ssr':                      { city: 'Bern',               canton: 'BE', postalCode: '3000', addressRegion: 'BE' },
'huntsman':                     { city: 'Monthey',            canton: 'VS', postalCode: '1870', addressRegion: 'VS' },
'fielmann':                     { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
'fusalp':                       { city: 'Annecy',             canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
'localsearch':                  { city: 'Zurich',             canton: 'ZH', postalCode: '8001', addressRegion: 'ZH' },
'tally-weijl':                  { city: 'Basel',              canton: 'BS', postalCode: '4001', addressRegion: 'BS' },
'transgourmet':                 { city: 'Basel',              canton: 'BS', postalCode: '4002', addressRegion: 'BS' },
'bcvs':                         { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
'coopers':                      { city: 'Visp',               canton: 'VS', postalCode: '3930', addressRegion: 'VS' },
'kone':                         { city: 'Luzern',             canton: 'LU', postalCode: '6003', addressRegion: 'LU' },
'mobiliar':                     { city: 'Bern',               canton: 'BE', postalCode: '3001', addressRegion: 'BE' },
'bms-building':                 { city: 'Naters',             canton: 'VS', postalCode: '3904', addressRegion: 'VS' },
'bls':                          { city: 'Bern',               canton: 'BE', postalCode: '3001', addressRegion: 'BE' },
'berner-montage':               { city: 'Visp',               canton: 'VS', postalCode: '3930', addressRegion: 'VS' },
'siemens-healthineers':         { city: 'Zurich',             canton: 'ZH', postalCode: '8047', addressRegion: 'ZH' },
'csd-engineers':                { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
'fondation-domus':              { city: 'Sion',               canton: 'VS', postalCode: '1950', addressRegion: 'VS' },
'jumbo':                        { city: 'Dietlikon',          canton: 'ZH', postalCode: '8305', addressRegion: 'ZH' },
'omega':                        { city: 'Biel/Bienne',        canton: 'BE', postalCode: '2502', addressRegion: 'BE' },
```

> **Note:** Companies like UBS, SRG SSR, KONE have national HQ outside Valais but were found offering on-site jobs in the Valais region. The location config stores HQ info; `inferSwissTargetCanton()` resolves actual job locations from the listing data.

- [ ] **Step 2: Verify no duplicates exist**

```bash
grep -c "marriott\|reboot-monkey\|arxada\|ubs\|interdiscount\|matterhorn-gotthard-bahn" scripts/lib/crawler-location-config.mjs
```

Expected: only the lines we just added (no pre-existing entries for these keys).

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/crawler-location-config.mjs
git commit -m "feat(crawler): register 28 Valais company locations"
```

---

## Phase 1: High-Volume Crawlers (8+ jobs)

### Task 1: Marriott International (~51 jobs)

**Career page tech:** Marriott uses a custom JSON API at `careers.marriott.com`. The search endpoint returns structured job listings with location, title, and description.

**Files:**
- Create: `scripts/lib/marriott-job-parser.mjs`
- Create: `scripts/update-marriott-jobs.mjs`
- Create: `.github/workflows/update-jobs-marriott.yml`
- Create: `tests/marriott-crawler.test.ts`

- [ ] **Step 1: Scaffold the crawler**

```bash
node scripts/scaffold-crawler.mjs marriott \
  --name "Marriott International" \
  --domain "careers.marriott.com" \
  --lang en \
  --source api \
  --url "https://careers.marriott.com/api/jobs"
```

- [ ] **Step 2: Research the career page API**

Open `https://careers.marriott.com/jobs?location=Valais%2C%20Switzerland` in browser DevTools → Network tab. Identify the JSON API endpoint, request format, pagination parameters, and response schema. Document findings in the parser file header comment.

Key questions to answer:
- What is the search API URL? (likely `/api/jobs` or similar)
- Does it accept `location` as a query parameter?
- How is pagination handled? (offset, cursor, page number)
- What fields are returned per job? (title, location, description, URL, date)

- [ ] **Step 3: Implement `fetchJobListings()` in the parser**

Replace the TODO placeholder in `scripts/lib/marriott-job-parser.mjs` with the actual API call logic. Filter by Valais/Switzerland location. Handle pagination.

```javascript
async function fetchJobListings() {
  const allListings = [];
  let offset = 0;
  const PAGE_SIZE = 25;

  while (true) {
    const url = `https://careers.marriott.com/api/jobs?location=Switzerland&offset=${offset}&limit=${PAGE_SIZE}`;
    console.log(`  📄 Fetching page at offset ${offset}...`);
    const res = await fetch(url, {
      headers: {
        'User-Agent': process.env.JOBS_CRAWLER_USER_AGENT ||
          'Mozilla/5.0 (compatible; FrontaliereTicinoBot/1.0; +https://frontaliereticino.ch/)',
        'Accept': 'application/json',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const items = data?.results || data?.jobs || [];
    if (!Array.isArray(items) || items.length === 0) break;
    allListings.push(...items);
    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
    await new Promise((r) => setTimeout(r, 500));
  }

  // Filter to Valais region
  return allListings.filter(j => {
    const loc = (j.location || '').toLowerCase();
    return /valais|wallis|zermatt|visp|brig|sion|sierre|martigny|monthey|naters|crans|verbier|saas/i.test(loc);
  });
}
```

> **Important:** The exact API structure will vary — adapt field names (`data.results`, `data.jobs`, etc.) based on Step 2 research. The code above is a starting template.

- [ ] **Step 4: Run scaffolded tests**

```bash
npx vitest run tests/marriott-crawler.test.ts
```

Expected: PASS (scaffolded tests validate constants, matchers, slug format).

- [ ] **Step 5: Test crawler locally**

```bash
node scripts/update-marriott-jobs.mjs
```

Expected: Jobs fetched and written to `data/jobs/by-crawler/marriott.json`.

- [ ] **Step 6: Add to orchestrator config**

Add `"marriott"` to `data/jobs-crawler-config.json`.

- [ ] **Step 7: Commit and push**

```bash
git add scripts/lib/marriott-job-parser.mjs scripts/update-marriott-jobs.mjs \
  .github/workflows/update-jobs-marriott.yml tests/marriott-crawler.test.ts \
  data/jobs-crawler-config.json
git commit -m "feat(crawler): add Marriott International dedicated crawler"
git push
```

- [ ] **Step 8: Trigger remote workflow**

```bash
gh workflow run update-jobs-marriott.yml
```

Wait for completion (~5-10 min):

```bash
gh run list --workflow=update-jobs-marriott.yml --limit 1
# When status is "completed", proceed. If "failure", check logs:
gh run view <run-id> --log-failed
```

- [ ] **Step 9: Verify remote results**

```bash
# Pull the data committed by the workflow
git pull

# Check output file exists and has jobs
cat data/jobs/by-crawler/marriott.json | node -e "
  const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
  const jobs = Array.isArray(d) ? d : d.jobs || [];
  console.log('Total jobs:', jobs.length);
  if (jobs.length === 0) { console.error('❌ ZERO JOBS — parser needs fixing'); process.exit(1); }
  // Spot-check first 3 jobs
  jobs.slice(0, 3).forEach((j, i) => {
    console.log(\"\n--- Job\", i+1, \"---\");
    console.log('Title:', j.title);
    console.log('Location:', j.location, '| Canton:', j.canton);
    console.log('URL:', j.url);
    console.log('Description length:', (j.description || '').length, 'chars');
    const issues = [];
    if (!j.title || j.title.length < 3) issues.push('title too short');
    if (!j.url || !j.url.startsWith('http')) issues.push('invalid URL');
    if (!j.description || j.description.length < 30) issues.push('description too short');
    if (!j.location) issues.push('missing location');
    if (!j.canton) issues.push('missing canton');
    if (issues.length) console.warn('⚠️ Issues:', issues.join(', '));
  });
"
```

**Validation checklist:**
- [ ] Job count > 0 (matches expected ~51)
- [ ] Titles are real job titles (not HTML artifacts or empty strings)
- [ ] URLs point to actual job detail pages (not the listing page)
- [ ] Descriptions have meaningful content (>30 chars, not boilerplate)
- [ ] Locations are in Valais region (Zermatt, Visp, Brig, etc.)
- [ ] Canton is `VS` for Valais jobs

- [ ] **Step 10: Fix parser if needed (iterate)**

If any validation check fails:
1. Read the workflow logs: `gh run view <run-id> --log-failed`
2. Identify the issue (wrong API endpoint, bad field mapping, missing location filter, HTML not parsed correctly)
3. Fix the parser: `scripts/lib/marriott-job-parser.mjs`
4. Re-run tests locally: `npx vitest run tests/marriott-crawler.test.ts`
5. Test locally: `node scripts/update-marriott-jobs.mjs`
6. Commit, push, and re-trigger:
```bash
git add scripts/lib/marriott-job-parser.mjs
git commit -m "fix(crawler): fix Marriott parser — [describe issue]"
git push
gh workflow run update-jobs-marriott.yml
```
7. Repeat Step 9 until all checks pass.

---

### Task 2: Reboot Monkey (~38 jobs)

**Career page tech:** Standard website HTML. Likely static or CMS-rendered job listing page.

**Files:**
- Create: `scripts/lib/reboot-monkey-job-parser.mjs`
- Create: `scripts/update-reboot-monkey-jobs.mjs`
- Create: `.github/workflows/update-jobs-reboot-monkey.yml`
- Create: `tests/reboot-monkey-crawler.test.ts`

- [ ] **Step 1: Scaffold the crawler**

```bash
node scripts/scaffold-crawler.mjs reboot-monkey \
  --name "Reboot Monkey" \
  --domain "rebootmonkey.com" \
  --lang en \
  --source generic \
  --url "https://www.rebootmonkey.com/en/jobs"
```

- [ ] **Step 2: Research the career page**

Fetch `https://www.rebootmonkey.com/en/jobs` and inspect the HTML structure. Identify the DOM pattern for job listings (likely `<div>`, `<li>`, or `<article>` elements with title, location, link). Check if there's a hidden JSON API (check Network tab for XHR requests).

- [ ] **Step 3: Implement `fetchJobListings()`**

Parse the HTML response to extract job title, location, URL, and description for each listing. Use regex or string matching (no cheerio dependency — keep it lightweight like other parsers).

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/reboot-monkey-crawler.test.ts
```

- [ ] **Step 5: Test locally**

```bash
node scripts/update-reboot-monkey-jobs.mjs
```

- [ ] **Step 6: Add to orchestrator config, commit, and push**

```bash
git add scripts/lib/reboot-monkey-job-parser.mjs scripts/update-reboot-monkey-jobs.mjs \
  .github/workflows/update-jobs-reboot-monkey.yml tests/reboot-monkey-crawler.test.ts \
  data/jobs-crawler-config.json
git commit -m "feat(crawler): add Reboot Monkey dedicated crawler"
git push
```

- [ ] **Step 7: Trigger remote workflow and verify**

```bash
gh workflow run update-jobs-reboot-monkey.yml
# Wait for completion, then:
gh run list --workflow=update-jobs-reboot-monkey.yml --limit 1
git pull
```

Validate output: job count > 0 (~38 expected), titles are real, URLs valid, descriptions >30 chars, locations in Valais. See Task 1 Step 9 for full validation script.

- [ ] **Step 8: Fix parser if needed** — Read logs (`gh run view <id> --log-failed`), fix parser, re-test locally, commit+push, re-trigger. Iterate until all checks pass.

---

### Task 3: Arxada (~22 jobs)

**Career page tech:** Corporate website, likely uses an ATS (Applicant Tracking System).

**Files:**
- Create: `scripts/lib/arxada-job-parser.mjs`
- Create: `scripts/update-arxada-jobs.mjs`
- Create: `.github/workflows/update-jobs-arxada.yml`
- Create: `tests/arxada-crawler.test.ts`

- [ ] **Step 1: Scaffold**

```bash
node scripts/scaffold-crawler.mjs arxada \
  --name "Arxada" \
  --domain "arxada.com" \
  --lang en \
  --source generic \
  --url "https://www.arxada.com/en/careers"
```

- [ ] **Step 2: Research API — look for Workday, SuccessFactors, or custom JSON endpoints**
- [ ] **Step 3: Implement `fetchJobListings()` — filter to Visp/Valais location**
- [ ] **Step 4: Run tests** — `npx vitest run tests/arxada-crawler.test.ts`
- [ ] **Step 5: Test locally** — `node scripts/update-arxada-jobs.mjs`
- [ ] **Step 6: Add to config, commit, and push**

```bash
git add scripts/lib/arxada-job-parser.mjs scripts/update-arxada-jobs.mjs \
  .github/workflows/update-jobs-arxada.yml tests/arxada-crawler.test.ts \
  data/jobs-crawler-config.json
git commit -m "feat(crawler): add Arxada dedicated crawler"
git push
```

- [ ] **Step 7: Trigger remote workflow and verify**

```bash
gh workflow run update-jobs-arxada.yml
# Wait → verify: ~22 jobs, Visp/Valais locations, valid URLs/descriptions
```

- [ ] **Step 8: Fix parser if needed** — Iterate until remote run produces valid results.

---

### Task 4: UBS (~10 jobs)

**Career page tech:** UBS uses a sophisticated JSON API for job search. The career site at `ubs.com/global/en/careers` typically loads jobs via an API endpoint.

**Files:**
- Create: `scripts/lib/ubs-job-parser.mjs`
- Create: `scripts/update-ubs-jobs.mjs`
- Create: `.github/workflows/update-jobs-ubs.yml`
- Create: `tests/ubs-crawler.test.ts`

- [ ] **Step 1: Scaffold**

```bash
node scripts/scaffold-crawler.mjs ubs \
  --name "UBS" \
  --domain "ubs.com" \
  --lang en \
  --source api \
  --url "https://www.ubs.com/global/en/careers/search-jobs.html"
```

- [ ] **Step 2: Research API — UBS likely uses Avature or Phenom People as ATS. Inspect network requests on the career page to find the JSON endpoint. Filter by location "Valais" or specific cities (Sion, Brig, Visp).**
- [ ] **Step 3: Implement `fetchJobListings()` — paginated API with Valais filter**
- [ ] **Step 4: Run tests** — `npx vitest run tests/ubs-crawler.test.ts`
- [ ] **Step 5: Test locally** — `node scripts/update-ubs-jobs.mjs`
- [ ] **Step 6: Add to config, commit, and push**

```bash
git commit -m "feat(crawler): add UBS dedicated crawler"
git push
```

- [ ] **Step 7: Trigger remote workflow and verify**

```bash
gh workflow run update-jobs-ubs.yml
# Wait → verify: ~10 jobs, Sion/Brig/Visp locations
```

- [ ] **Step 8: Fix parser if needed** — Iterate until remote run produces valid results.

---

### Task 5: Interdiscount (~8 jobs)

**Career page tech:** `jobs.interdiscount.ch` — likely Coop Group infrastructure (Interdiscount is a Coop subsidiary). May share the same ATS as existing Coop crawler.

**Files:**
- Create: `scripts/lib/interdiscount-job-parser.mjs`
- Create: `scripts/update-interdiscount-jobs.mjs`
- Create: `.github/workflows/update-jobs-interdiscount.yml`
- Create: `tests/interdiscount-crawler.test.ts`

- [ ] **Step 1: Scaffold**

```bash
node scripts/scaffold-crawler.mjs interdiscount \
  --name "Interdiscount" \
  --domain "jobs.interdiscount.ch" \
  --lang de \
  --source api \
  --url "https://jobs.interdiscount.ch/"
```

- [ ] **Step 2: Research — check if it shares Coop's ATS (`coop-job-parser.mjs` pattern). Compare API endpoints.**
- [ ] **Step 3: Implement `fetchJobListings()` — filter to Valais/Naters**
- [ ] **Step 4: Run tests** — `npx vitest run tests/interdiscount-crawler.test.ts`
- [ ] **Step 5: Test locally** — `node scripts/update-interdiscount-jobs.mjs`
- [ ] **Step 6: Add to config, commit, and push**

```bash
git commit -m "feat(crawler): add Interdiscount dedicated crawler"
git push
```

- [ ] **Step 7: Trigger remote workflow and verify**

```bash
gh workflow run update-jobs-interdiscount.yml
# Wait → verify: ~8 jobs, Naters/Valais locations
```

- [ ] **Step 8: Fix parser if needed** — Iterate until remote run produces valid results.

---

### Task 6: Matterhorn Gotthard Bahn (~8 jobs)

**Career page tech:** `jobs.bvzholding.ch` — BVZ Holding group career portal. Likely HTML or simple CMS.

**Files:**
- Create: `scripts/lib/matterhorn-gotthard-bahn-job-parser.mjs`
- Create: `scripts/update-matterhorn-gotthard-bahn-jobs.mjs`
- Create: `.github/workflows/update-jobs-matterhorn-gotthard-bahn.yml`
- Create: `tests/matterhorn-gotthard-bahn-crawler.test.ts`

- [ ] **Step 1: Scaffold**

```bash
node scripts/scaffold-crawler.mjs matterhorn-gotthard-bahn \
  --name "Matterhorn Gotthard Bahn" \
  --domain "bvzholding.ch" \
  --lang de \
  --source generic \
  --url "https://jobs.bvzholding.ch/"
```

- [ ] **Step 2: Research the HTML structure of the career page**
- [ ] **Step 3: Implement `fetchJobListings()` — all jobs are Valais-based (railway company)**
- [ ] **Step 4: Run tests** — `npx vitest run tests/matterhorn-gotthard-bahn-crawler.test.ts`
- [ ] **Step 5: Test locally** — `node scripts/update-matterhorn-gotthard-bahn-jobs.mjs`
- [ ] **Step 6: Add to config, commit, and push**

```bash
git commit -m "feat(crawler): add Matterhorn Gotthard Bahn dedicated crawler"
git push
```

- [ ] **Step 7: Trigger remote workflow and verify**

```bash
gh workflow run update-jobs-matterhorn-gotthard-bahn.yml
# Wait → verify: ~8 jobs, all Valais locations (Brig-based railway)
```

- [ ] **Step 8: Fix parser if needed** — Iterate until remote run produces valid results.

---

## Phase 2: Medium-Volume Crawlers (3-6 jobs)

### Task 7: Swiss Life (~6 jobs)

- [ ] **Step 1: Scaffold**
```bash
node scripts/scaffold-crawler.mjs swiss-life --name "Swiss Life" --domain "swisslife.ch" --lang de --source api --url "https://www.swisslife.ch/en/about-us/job-careers/our-vacancies.html"
```
- [ ] **Step 2: Research API** — Swiss Life likely uses SAP SuccessFactors. Check network tab for JSON endpoints.
- [ ] **Step 3: Implement `fetchJobListings()` — filter to Valais**
- [ ] **Step 4: Run tests** — `npx vitest run tests/swiss-life-crawler.test.ts`
- [ ] **Step 5: Test locally** — `node scripts/update-swiss-life-jobs.mjs`
- [ ] **Step 6: Commit and push** — `git commit -m "feat(crawler): add Swiss Life dedicated crawler" && git push`
- [ ] **Step 7: Trigger remote workflow** — `gh workflow run update-jobs-swiss-life.yml` → verify ~6 jobs, Valais locations
- [ ] **Step 8: Fix parser if needed** — Iterate until remote results valid

---

### Task 8: Siegfried (~6 jobs)

- [ ] **Step 1: Scaffold**
```bash
node scripts/scaffold-crawler.mjs siegfried --name "Siegfried" --domain "siegfried.ch" --lang en --source generic --url "https://www.siegfried.ch/careers/"
```
- [ ] **Step 2: Research** — Check if Siegfried uses SmartRecruiters, Workday, or custom ATS.
- [ ] **Step 3: Implement `fetchJobListings()` — Siegfried has a manufacturing site in Evionnaz (VS)**
- [ ] **Step 4: Run tests** — `npx vitest run tests/siegfried-crawler.test.ts`
- [ ] **Step 5: Test locally, commit and push**
- [ ] **Step 6: Trigger remote workflow** — `gh workflow run update-jobs-siegfried.yml` → verify ~6 jobs, Evionnaz (VS) location
- [ ] **Step 7: Fix parser if needed** — Iterate until remote results valid

---

### Task 9: Vaxcyte (~5 jobs)

- [ ] **Step 1: Scaffold**
```bash
node scripts/scaffold-crawler.mjs vaxcyte --name "Vaxcyte" --domain "vaxcyte.com" --lang en --source generic --url "https://vaxcyte.com/job-listings/"
```
- [ ] **Step 2: Research** — Check for Greenhouse or Lever ATS (common for biotech companies). If Greenhouse: `GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs`.
- [ ] **Step 3: Implement parser**
- [ ] **Step 4: Run tests, test locally, commit and push**
- [ ] **Step 5: Trigger remote workflow** — `gh workflow run update-jobs-vaxcyte.yml` → verify ~5 jobs
- [ ] **Step 6: Fix parser if needed** — Iterate until remote results valid

---

### Task 10: SRG SSR (~4 jobs)

- [ ] **Step 1: Scaffold**
```bash
node scripts/scaffold-crawler.mjs srg-ssr --name "SRG SSR" --domain "srgssr.ch" --lang de --source api --url "https://jobs.srgssr.ch/"
```
- [ ] **Step 2: Research API** — `jobs.srgssr.ch` likely has a JSON endpoint. Inspect network traffic.
- [ ] **Step 3: Implement `fetchJobListings()` — filter to Valais offices**
- [ ] **Step 4: Run tests, test locally, commit and push**
- [ ] **Step 5: Trigger remote workflow** — `gh workflow run update-jobs-srg-ssr.yml` → verify ~4 jobs
- [ ] **Step 6: Fix parser if needed** — Iterate until remote results valid

---

### Task 11: Huntsman Corporation (~4 jobs)

- [ ] **Step 1: Scaffold**
```bash
node scripts/scaffold-crawler.mjs huntsman --name "Huntsman Corporation" --domain "huntsman.com" --lang en --source generic --url "https://www.huntsman.com/careers"
```
- [ ] **Step 2: Research** — Huntsman likely uses Workday. If Workday: `POST /wday/cxs/{tenant}/External/jobs` with JSON body. Check for Monthey (VS) location filter.
- [ ] **Step 3: Implement parser for Workday API or HTML scraping**
- [ ] **Step 4: Run tests, test locally, commit and push**
- [ ] **Step 5: Trigger remote workflow** — `gh workflow run update-jobs-huntsman.yml` → verify ~4 jobs, Monthey (VS)
- [ ] **Step 6: Fix parser if needed** — Iterate until remote results valid

---

### Task 12: Fielmann Group (~4 jobs)

- [ ] **Step 1: Scaffold**
```bash
node scripts/scaffold-crawler.mjs fielmann --name "Fielmann Group" --domain "jobs.fielmann.com" --lang de --source api --url "https://jobs.fielmann.com/"
```
- [ ] **Step 2: Research JSON API on jobs.fielmann.com**
- [ ] **Step 3: Implement parser with Valais filter**
- [ ] **Step 4: Run tests, test locally, commit and push**
- [ ] **Step 5: Trigger remote workflow** — `gh workflow run update-jobs-fielmann.yml` → verify ~4 jobs
- [ ] **Step 6: Fix parser if needed** — Iterate until remote results valid

---

### Task 13: Fusalp (~4 jobs)

- [ ] **Step 1: Scaffold**
```bash
node scripts/scaffold-crawler.mjs fusalp --name "Fusalp" --domain "fusalp.com" --lang fr --source api --url "https://fusalp.welcomekit.co/"
```
- [ ] **Step 2: Research** — Welcomekit (Welcome to the Jungle) has a public API: `GET https://www.welcomekit.co/api/v1/embed?organization_slug=fusalp`. Check if it returns structured JSON.
- [ ] **Step 3: Implement using Welcomekit API**
- [ ] **Step 4: Run tests, test locally, commit and push**
- [ ] **Step 5: Trigger remote workflow** — `gh workflow run update-jobs-fusalp.yml` → verify ~4 jobs
- [ ] **Step 6: Fix parser if needed** — Iterate until remote results valid

---

### Task 14: localsearch (~3 jobs)

- [ ] **Step 1: Scaffold**
```bash
node scripts/scaffold-crawler.mjs localsearch --name "localsearch" --domain "localsearch.ch" --lang de --source api --url "https://karriere.localsearch.ch/en/"
```
- [ ] **Step 2: Research JSON API** — karriere.localsearch.ch likely uses an ATS with API.
- [ ] **Step 3: Implement parser with Valais filter**
- [ ] **Step 4: Run tests, test locally, commit and push**
- [ ] **Step 5: Trigger remote workflow** — `gh workflow run update-jobs-localsearch.yml` → verify ~3 jobs
- [ ] **Step 6: Fix parser if needed** — Iterate until remote results valid

---

## Phase 3: Low-Volume Crawlers (1-2 jobs)

For Phase 3 companies (2 or fewer jobs), the scaffold + research + implement cycle is the same. Each task follows the identical pattern. These are listed compactly since the implementation is mechanical.

> **Parallel execution:** Phase 3 tasks are independent — up to 3-4 can be implemented in parallel by subagents (see feedback memory: max 3-4 parallel agents).

**Every Phase 3 task follows this full cycle:**
1. Scaffold → 2. Research career page → 3. Implement parser → 4. Run tests locally → 5. Test crawler locally → 6. Commit and push → 7. **Trigger remote workflow** (`gh workflow run update-jobs-{key}.yml`) → 8. **Pull and verify results** (job count, titles, URLs, descriptions, locations) → 9. **Fix parser if needed** (read logs, fix, re-test, commit+push, re-trigger — iterate until valid)

### Task 15: TALLY WEiJL (~3 jobs)
```bash
node scripts/scaffold-crawler.mjs tally-weijl --name "TALLY WEiJL" --domain "tally-weijl.com" --lang en --source generic --url "https://www.tally-weijl.com/jobs"
```
- [ ] Scaffold → Research → Implement → Test → Commit+Push
- [ ] Trigger: `gh workflow run update-jobs-tally-weijl.yml` → Verify ~3 jobs → Fix if needed

### Task 16: Transgourmet/Prodega (~2 jobs)
```bash
node scripts/scaffold-crawler.mjs transgourmet --name "Transgourmet" --domain "transgourmet.ch" --lang de --source api --url "https://jobs.transgourmet.ch/"
```
- [ ] Scaffold → Research → Implement → Test → Commit+Push
- [ ] Trigger: `gh workflow run update-jobs-transgourmet.yml` → Verify ~2 jobs → Fix if needed

### Task 17: BCVs/WKB (~2 jobs)
```bash
node scripts/scaffold-crawler.mjs bcvs --name "Banque Cantonale du Valais" --domain "bcvs.ch" --lang fr --source generic --url "https://www.bcvs.ch/la-bcvs/carriere/ressources-humaines/offres-demploi"
```
- [ ] Scaffold → Research → Implement → Test → Commit+Push
- [ ] Trigger: `gh workflow run update-jobs-bcvs.yml` → Verify ~2 jobs, Sion location → Fix if needed

### Task 18: Coopers Group AG (~2 jobs)
```bash
node scripts/scaffold-crawler.mjs coopers --name "Coopers Group AG" --domain "coopers.ch" --lang en --source generic --url "https://www.coopers.ch/en/about/join-us.php"
```
- [ ] Scaffold → Research → Implement → Test → Commit+Push
- [ ] Trigger: `gh workflow run update-jobs-coopers.yml` → Verify ~2 jobs, Visp location → Fix if needed

### Task 19: KONE (~2 jobs)
```bash
node scripts/scaffold-crawler.mjs kone --name "KONE" --domain "kone.com" --lang en --source api --url "https://careers.kone.com/en/find-jobs/"
```
- [ ] Scaffold → Research → Implement → Test → Commit+Push
- [ ] Trigger: `gh workflow run update-jobs-kone.yml` → Verify ~2 jobs → Fix if needed

### Task 20: die Mobiliar (~2 jobs)
```bash
node scripts/scaffold-crawler.mjs mobiliar --name "die Mobiliar" --domain "mobiliar.ch" --lang de --source api --url "https://jobs.mobiliar.ch/"
```
- [ ] Scaffold → Research → Implement → Test → Commit+Push
- [ ] Trigger: `gh workflow run update-jobs-mobiliar.yml` → Verify ~2 jobs → Fix if needed

### Task 21: BMS Building Materials (~2 jobs)
```bash
node scripts/scaffold-crawler.mjs bms-building --name "BMS Building Materials" --domain "bmsuisse.ch" --lang de --source generic --url "https://jobs.bmsuisse.ch/"
```
- [ ] Scaffold → Research → Implement → Test → Commit+Push
- [ ] Trigger: `gh workflow run update-jobs-bms-building.yml` → Verify ~2 jobs, Naters location → Fix if needed

### Task 22: BLS AG (~2 jobs)
```bash
node scripts/scaffold-crawler.mjs bls --name "BLS AG" --domain "bls.ch" --lang de --source generic --url "https://www.bls.ch/en/unternehmen/jobs-und-karriere/offene-stellen"
```
- [ ] Scaffold → Research → Implement → Test → Commit+Push
- [ ] Trigger: `gh workflow run update-jobs-bls.yml` → Verify ~2 jobs → Fix if needed

### Task 23: Montagetechnik BERNER AG (~2 jobs)
```bash
node scripts/scaffold-crawler.mjs berner-montage --name "Montagetechnik BERNER AG" --domain "berner.eu" --lang de --source generic --url "https://shop.berner.eu/ch-de/vacancies/"
```
- [ ] Scaffold → Research → Implement → Test → Commit+Push
- [ ] Trigger: `gh workflow run update-jobs-berner-montage.yml` → Verify ~2 jobs, Visp location → Fix if needed

### Task 24: Siemens Healthineers (~2 jobs)
```bash
node scripts/scaffold-crawler.mjs siemens-healthineers --name "Siemens Healthineers" --domain "siemens-healthineers.com" --lang en --source api --url "https://careers.siemens-healthineers.com/"
```
- [ ] Scaffold → Research → Implement → Test → Commit+Push
- [ ] Trigger: `gh workflow run update-jobs-siemens-healthineers.yml` → Verify ~2 jobs → Fix if needed

### Task 25: CSD ENGINEERS (~2 jobs)
```bash
node scripts/scaffold-crawler.mjs csd-engineers --name "CSD ENGINEERS" --domain "csd.ch" --lang fr --source generic --url "https://jobs.csd.ch/"
```
- [ ] Scaffold → Research → Implement → Test → Commit+Push
- [ ] Trigger: `gh workflow run update-jobs-csd-engineers.yml` → Verify ~2 jobs, Sion location → Fix if needed

### Task 26: Fondation Domus (~2 jobs)
```bash
node scripts/scaffold-crawler.mjs fondation-domus --name "Fondation Domus" --domain "fondation-domus.ch" --lang fr --source generic --url "https://www.fondation-domus.ch/emploi-formation/offres-d-emploi"
```
- [ ] Scaffold → Research → Implement → Test → Commit+Push
- [ ] Trigger: `gh workflow run update-jobs-fondation-domus.yml` → Verify ~2 jobs, Sion location → Fix if needed

### Task 27: JUMBO (~2 jobs)
```bash
node scripts/scaffold-crawler.mjs jumbo --name "JUMBO" --domain "jumbo.ch" --lang de --source generic --url "https://www.jumbo.ch/de/stellen"
```
- [ ] Scaffold → Research → Implement → Test → Commit+Push
- [ ] Trigger: `gh workflow run update-jobs-jumbo.yml` → Verify ~2 jobs → Fix if needed
- Note: JUMBO is a Coop subsidiary, may share ATS with existing Coop crawler.

### Task 28: OMEGA SA (~1 job)
```bash
node scripts/scaffold-crawler.mjs omega --name "OMEGA SA" --domain "omegawatches.com" --lang en --source generic --url "https://www.omegawatches.com/careers/list"
```
- [ ] Scaffold → Research → Implement → Test → Commit+Push
- [ ] Trigger: `gh workflow run update-jobs-omega.yml` → Verify ~1 job → Fix if needed
- Note: OMEGA is part of Swatch Group. Check if career page uses Swatch Group's ATS.

---

## Post-Implementation

### Task 29: Update Orchestrator and Verify

- [ ] **Step 1: Verify all 28 crawlers are registered in `data/jobs-crawler-config.json`**

```bash
for key in marriott reboot-monkey arxada ubs interdiscount matterhorn-gotthard-bahn swiss-life siegfried vaxcyte srg-ssr huntsman fielmann fusalp localsearch tally-weijl transgourmet bcvs coopers kone mobiliar bms-building bls berner-montage siemens-healthineers csd-engineers fondation-domus jumbo omega; do
  grep -q "\"$key\"" data/jobs-crawler-config.json && echo "✅ $key" || echo "❌ $key MISSING"
done
```

- [ ] **Step 2: Run full test suite**

```bash
npx vitest run
```

Expected: All test files pass including 28 new crawler test files.

- [ ] **Step 3: Run TypeScript type check**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Run production build**

```bash
npx vite build
```

- [ ] **Step 5: Commit final verification**

```bash
git commit -m "chore: verify all 28 Valais crawlers registered and passing"
```

### Task 30: Final Translation and End-to-End Verification

> Each crawler was already triggered and verified individually in its own task (Steps 7-10). This task runs the full pipeline end-to-end.

- [ ] **Step 1: Pull all remote changes from individual crawler runs**

```bash
git pull
```

- [ ] **Step 2: Verify all 28 crawler slices exist**

```bash
MISSING=0
for key in marriott reboot-monkey arxada ubs interdiscount matterhorn-gotthard-bahn swiss-life siegfried vaxcyte srg-ssr huntsman fielmann fusalp localsearch tally-weijl transgourmet bcvs coopers kone mobiliar bms-building bls berner-montage siemens-healthineers csd-engineers fondation-domus jumbo omega; do
  if [ -f "data/jobs/by-crawler/${key}.json" ]; then
    JOBS=$(node -e "const d=JSON.parse(require('fs').readFileSync('data/jobs/by-crawler/${key}.json','utf8')); console.log((Array.isArray(d)?d:d.jobs||[]).length)")
    echo "✅ ${key}: ${JOBS} jobs"
  else
    echo "❌ ${key}: MISSING — re-trigger workflow"
    MISSING=$((MISSING+1))
  fi
done
echo "---"
echo "Missing: ${MISSING}/28"
```

If any are missing, re-trigger their workflow: `gh workflow run update-jobs-{key}.yml`

- [ ] **Step 3: Trigger full translation pipeline**

```bash
gh workflow run translate-pending.yml
```

Wait for completion (~20-30 min for 28 new crawlers):

```bash
gh run list --workflow=translate-pending.yml --limit 1
```

- [ ] **Step 4: Verify 4-locale coverage after translation**

```bash
git pull
# Check a sample of crawlers for all 4 locales
for key in marriott arxada ubs matterhorn-gotthard-bahn; do
  echo "=== ${key} ==="
  node -e "
    const d = JSON.parse(require('fs').readFileSync('data/jobs/by-crawler/${key}.json','utf8'));
    const jobs = Array.isArray(d) ? d : d.jobs || [];
    const locales = ['it','en','de','fr'];
    let missing = 0;
    jobs.forEach(j => {
      locales.forEach(l => {
        if (!j.titleByLocale?.[l] && !j.needsRetranslation) {
          console.log('  ⚠️', j.title, '— missing locale:', l);
          missing++;
        }
      });
    });
    if (missing === 0) console.log('  ✅ All', jobs.length, 'jobs have 4 locales');
    else console.log('  ❌', missing, 'missing locale entries');
  "
done
```

- [ ] **Step 5: Verify no overlaps between new crawlers and existing ones**

```bash
node -e "
  const fs = require('fs');
  const path = require('path');
  const dir = 'data/jobs/by-crawler';
  const allUrls = new Map();
  let overlaps = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const slug = f.replace('.json','');
    const d = JSON.parse(fs.readFileSync(path.join(dir,f),'utf8'));
    const jobs = Array.isArray(d) ? d : d.jobs || [];
    for (const j of jobs) {
      if (allUrls.has(j.url)) {
        console.log('⚠️ OVERLAP:', j.url, '→', allUrls.get(j.url), 'vs', slug);
        overlaps++;
      } else {
        allUrls.set(j.url, slug);
      }
    }
  }
  console.log(overlaps === 0 ? '✅ No overlaps found' : '❌ ' + overlaps + ' overlaps detected');
"
```

- [ ] **Step 6: Trigger deploy**

```bash
gh workflow run deploy.yml
```

- [ ] **Step 7: Post-deploy — verify new job pages are indexed**

After deploy completes, spot-check that job pages render correctly:

```bash
# Check a Marriott job page exists in production
curl -s -o /dev/null -w "%{http_code}" "https://frontaliereticino.ch/lavoro/$(node -e "
  const d=JSON.parse(require('fs').readFileSync('data/jobs/by-crawler/marriott.json','utf8'));
  const jobs=Array.isArray(d)?d:d.jobs||[];
  console.log(jobs[0]?.slugByLocale?.it || jobs[0]?.slug || 'NOT-FOUND');
")"
```

Expected: HTTP 200

---

## Research Checklist Per Company

When implementing each crawler, follow this research checklist:

1. **Fetch the career page** — `curl -s URL | head -100` or open in browser
2. **Check for JSON API** — Browser DevTools → Network → XHR filter → search/load
3. **Identify ATS platform** — Look for Workday, SuccessFactors, Greenhouse, Lever, SmartRecruiters, Personio, BambooHR, Ashby in page source or network requests
4. **Test location filter** — Does the career page support filtering by Valais/Wallis/canton VS?
5. **Check rate limiting** — Add 300-500ms delay between requests
6. **Verify Swiss jobs exist** — Ensure the career page actually has Swiss/Valais positions (LinkedIn counts may include nearby regions)

## Common ATS Patterns (Reference)

| ATS | API Pattern | Example |
|-----|-------------|---------|
| Workday | `POST /wday/cxs/{tenant}/External/jobs` | Body: `{searchText:"",locations:[{descriptor:"Switzerland"}]}` |
| Greenhouse | `GET /v1/boards/{board}/jobs` | `boards-api.greenhouse.io` — fully public, no auth |
| SuccessFactors | `GET /odata/v2/JobRequisitionLocale?$filter=...` | Varies by tenant |
| Welcomekit | `GET /api/v1/embed?organization_slug={slug}` | Public JSON, no auth |
| SmartRecruiters | `GET /api/v1/companies/{id}/postings?location=...` | Public API |
| Personio | `GET /xml?language=en` | RSS/XML feed of open positions |
| Custom JSON | Varies | Inspect Network tab for XHR calls |
| Static HTML | `GET /careers` → parse DOM | Regex-based extraction |
