# Hospital crawlers — pending work after batch 15 (2026-05-19)

> Self-contained handoff. A fresh agent can pick this up without prior conversation context.

## Required reading (in this order)

Before doing anything, read these docs to understand the full scope:

1. **`docs/HOSPITAL-CRAWLERS-INVENTORY-2026-05-19.md`** (576 lines, 41 sections) — **THIS IS THE MASTER PLAN**.
   - §1 sintesi (463 ospedali totali, 277 standalone uncovered al T0)
   - §2 parser esistenti al T0 (31 baseline; siamo passati a ~116)
   - §3 dettaglio cantoni frontaliere priority (TI, GR, VS, VD, GE, BS, BL) — 91 entries con ATS info
   - §4 dettaglio altri cantoni (ZH 34, SG 21, BE, AG, TG 10, LU, FR, SO, SZ, SH, NW, OW, ZG) — 186 entries
   - §5 note tecniche: ATS patterns, casi speciali (Cardiocentro→EOC, Vista Klinik, ti.ch/concorsi, Clinea/Emeis, Kliniken Valens)
   - §6 prossimi passi

2. **`docs/crawler-parametrizzazione-plan.md`** (38 KB) — design originale delle 15 ATS factories condivise (`prospective-ch-common`, `umantis-listing-common`, ecc.). Riferimento per come funzionano le factory che riusi.

3. **`docs/crawler-expansion-nazionale.md`** (25 KB) — piano espansione nazionale Apr 7, contesto di alto livello su cantoni e priorità.

4. **`data/swiss-hospitals.json`** — fonte dati canonica (463 entries da welches-spital.ch, scrape 2026-05-10). Per ogni ospedale: `name`, `canton`, `category` (Akutsomatische/Reha/Psichiatrici/Geburtshäuser), `_slug`.

5. **`docs/HOSPITAL-CRAWLERS-INVENTORY-2026-05-19.md` §3/§4** è il backlog effettivo — i ~161 ospedali standalone listati lì NON ANCORA coperti dopo batch 1-15 sono il long-tail.

## Context (read first)

Repo: `valerielinc-ops/frontaliere-si-o-no` (frontaliere job-board, IT/DE/FR/EN locales for Italian frontaliere audience).

**State at handoff:**
- ~116 dedicated crawlers + 15 ATS factories shipped
- Last merge: PR #392 (batch 15) — Refline PUK + Workday medtech + Prospective/Umantis tail
- ~3'360 jobs verified end-to-end
- Backlog stimato: ~161/277 ospedali standalone ancora non coperti (vedi inventory §3/§4)
- Aggregatori già coperti: Hirslanden SF (18 cliniche), Swiss Medical Network SR (17), Insel Gruppe Umantis 2624, LUKS Prospective 1003280 (4 sedi), HOCH SF (4)

## Sprint history (batch shippati)

| Batch | PR | Highlights |
|---|---|---|
| 1-12 | various | Setup factories + 90+ wrapper hospital base coverage |
| 13 | #388 | Umantis sweep + Refline factory + Spitex Zürich (~53 jobs) |
| 14 | #390 | Workday Stryker + Prospective discovery (PZM Münsingen 86, asana 35, GZ Dielsdorf, Pro Senectute TI) — ~153 jobs |
| 15 | #392 | Refline PUK Zürich 90 + CSL Behring 40 + Workday medtech (Abbott/Medtronic/Alcon) — ~200 jobs |
| fix-394 | #394 | Prospective shared-tenant filter (`acceptDirectlinkHosts`) + job-direct URL trust |
| fix-396 | #396 | 5 healthcare crawlers fixed (spital-sts SSR rewrite, ipw synthetic fallback, kliniken-valens trusted host, soH `needsRetranslation`, viva-luzern trusted host) |
| fix-397 | #397 | Sulzer Workday migration + Bobst detail-page enrichment |

### Post-fix validation (live workflow re-trigger, 2026-05-19 EOD)

All 9 broken crawlers re-triggered after merges; final job counts:

| Crawler | Bug fixed | Final jobs | Status |
|---|---|---|---|
| **spital-sts** | API tenant dead → SSR rewrite | 10 | ✅ |
| **ipw** | Cloudflare blocks Umantis detail → synthetic fallback (factory) | 10 | ✅ |
| **kliniken-valens** | `jobs.valens.ch` sibling not trusted | **105** | ✅ |
| **solothurner-spitaeler** | missing `needsRetranslation: true` | **128** | ✅ |
| **viva-luzern** | sibling domain `jobs.vivaluzern.ch` not trusted | 14 | ✅ |
| **sulzer** | Workday migration `sulzer.wd502.myworkdayjobs.com` not trusted | 40 | ✅ |
| **bobst** | parser never fetched detail page | **42** | ✅ |
| **benteler** | SAP SuccessFactors JS-rendered portal — needs Playwright | — | ⏸️ deferred |
| **nestle** | Workday tenant retired — needs ATS re-discovery | — | ⏸️ deferred |

**Net unlock from fix-396/397:** 349 jobs that were silently failing every cron cycle now flow into the dataset.

## Cumulative numbers (2026-05-19 EOD)

- **118 parser files added in single day** (`scripts/lib/*-job-parser.mjs`)
- **109 dedicated workflows** (`update-jobs-{key}.yml`) — each parser has its own
- **14 shared ATS factories** added today (`*-common.mjs`)
- **3'360+ jobs** verified end-to-end across all crawlers
- 4 crawlers still failing — 2 fixable (Benteler/Nestle SAP SF / Workday-retired) deferred as >1h rework

## Lessons learned (2026-05-19) — REQUIRED READING before changes

These are repeatable failure modes we hit today. Pre-check parsers against them:

### L1 — `needsRetranslation: true` is non-negotiable
Every new ParsedJob MUST set `needsRetranslation: true`. Factory-based parsers
(Prospective/Umantis/Refline/Workday-client) inherit it; custom parsers (anything
NOT calling `create*Parser`) must set it explicitly. Without it:
- AI localization step doesn't fill IT/EN/FR locales
- `translate-pending.yml` skips the job (it filters by the flag)
- Boilerplate guard sees source-locale-only descriptions and may trip
- A SINGLE locale-incomplete job → entire crawl fails with `localization validation failed`

Real cases: Fielmann (PR #374), Solothurner Spitäler (#396), Sulzer (#397), Bobst (#397).

### L2 — `trustedHosts` is exact-match; subdomain mismatches break ALL jobs
`isTrustedDomain` uses `Set.has(host)` (exact match) plus `endsWith('.${corporateHost}')`.
A `valens.ch` apex does NOT trust `jobs.valens.ch` if corporateHost is
`kliniken-valens.ch`. Common breakage:
- ATS lives on sibling domain (`jobs.{brand}.ch` vs `{brand}.ch`)
- Hyphenated vs non-hyphenated (`viva-luzern.ch` vs `vivaluzern.ch`)
- Workday migrations (`{brand}.wd{N}.myworkdayjobs.com` sibling host)

**Always probe live URLs:** before assuming, run:
```bash
node -e "import('./scripts/lib/{key}-job-parser.mjs').then(async m => {
  const j = await m[Object.keys(m).find(k => k.startsWith('fetchAll'))]();
  console.log('hosts:', [...new Set(j.map(x => new URL(x.url).hostname))]);
});"
```

Real cases (today): Kliniken Valens (jobs.valens.ch missing), Viva Luzern (sibling
domain), Sulzer (Workday migration).

### L3 — Prospective tenants can be SHARED across multiple employers
Tenant 1008606 (PZM Münsingen) actually serves 86 jobs: 25 PZM + 61 UPD Bern.
Tenant 1003280 (LUKS) serves 4 sites. Tenant 122706 (KSA) is a single employer.

**Detection:** check `links.directlink` hostnames. If multiple distinct corporate
domains appear, the tenant is shared.

**Fix:** use `acceptDirectlinkHosts: ['jobs.{my-domain}.ch']` in
`createProspectiveChParser` config. New feature added in PR #394.

### L4 — Prospective sometimes returns `/public/v1/jobs/{viewkey}` (NOT `/medium/{ID}/`)
When a tenant has NO custom job-page URL configured, the API returns
`links.directlink` as `https://ohws.prospective.ch/public/v1/jobs/{viewkey}`.
The original `isTrustedDomain` only accepted `/medium/{mediumId}/` URLs.

**Fixed in factory (PR #394):** `isTrustedDomain` now accepts both formats. No
per-tenant config change needed.

### L5 — Umantis detail pages can be Cloudflare-blocked
Tenant `recruitingapp-2906.umantis.com` (IPW) issues 302 → `www.ipw.ch` which has
Cloudflare JS challenge. ALL UA values (Chrome, bot, full Sec-Fetch-*) return the
22.5KB challenge page. Detail enrichment yields empty → "ultra_thin".

**Fix in factory (PR #396):** when both detail AND listing snippet produce
<80 chars, synthesise structured German fallback from
`title + company + location + dept/art/befristung + boilerplate`. Pattern from
`diakoniewerk-neumuenster-job-parser.mjs:199`. Benefits all future Umantis tenants.

### L6 — Prospective API tenant IDs can be deprecated
Spital STS tenant 1000717 returns HTTP 400 (deprecated). Career page still alive
with SSR rendered jobs.

**Fix:** abandon API, scrape `<div class="job job-N">` from career HTML +
fetch `/public/v1/jobs/{viewkey}` (job-direct endpoint) for rich descriptions.
Pattern reusable for any tenant where `/medium/{ID}/jobs` returns 400.

### L7 — Workday tenants get retired
Nestle's `nestle.wd{1,3,5,501,502,103}.myworkdayjobs.com/` all redirect to a
maintenance page. The employer migrated to another ATS. Workday tenants are NOT
permanent — periodic re-validation needed.

### L8 — `acceptDirectlinkHosts` filter applied AFTER fetch, not before
Reduces job count visibly but doesn't reduce API load. Acceptable for now since
even 86-job tenants page in ~1s.

### L9 — Discovery sweep results (exhausted, don't re-do)
- **Umantis 1000-30000** range fully swept → only KZU (1251) added beyond known set
- **Prospective 1009000-1012000** → zero healthcare hits
- **Workday medtech** 14 tenants probed → 4 with ≥5 CH jobs (Abbott/CSL/Medtronic/Alcon)
- Sandoz `wd103`, BD `bdx`, Sonova/J&J/BostonScientific → tenant blocked OR site_path missing
- Most large employers in CH have moved to SAP SuccessFactors, SmartRecruiters, or
  niche ATS (Recruitee, Personio, Teamtailor) — **batch 16 should sweep these**

## Memory anchors (`~/.claude/projects/.../memory/`)

Rilevanti per questo lavoro:
- `project_hospital_crawlers_may19_status.md` — stato sprint corrente
- `feedback_no_ci_wait_agent_finish.md` — merge immediato post-typecheck, non attendere CI
- `feedback_regression_gates_need_ci_runner.md` — vitest senza CI wiring = gate finto
- `feedback_parallel_agents.md` — max 3-4 agent paralleli (7 caused OOM)
- `feedback_verify_via_live_deploy.md` — verifica via curl prod, no full build locale

**Conventions (CRITICAL):**
- ALL new `ParsedJob` records must set `needsRetranslation: true`. Factory-based parsers (Refline / Prospective / Umantis / Workday-client) inherit it; check each new wrapper anyway.
- NEVER modify `scripts/lib/crawler-location-config.mjs` — it has `git update-index --skip-worktree`. Manual edits get auto-overwritten by cron.
- NEVER commit `data/known-company-slugs.json` (also skip-worktree).
- Crawler template: `scripts/lib/crawler-template.mjs` `runStandardCrawlerPipeline` (7-step: Init/Snapshot/Fetch/Merge/Diff/AI-Localize/Validate/Assemble).
- Boilerplate guard: `MIN_UNIQUE_WORDS = 30` in `scripts/assemble-jobs-dataset.mjs`. Bypass via `SKIP_BOILERPLATE_GUARD=1` env var in workflow.
- Workflow template: copy `.github/workflows/update-jobs-bethesda-spital.yml`, rename env/slice-file/key.
- Worktree at: `/Users/saggesel/Projects/frontaliere-si-o-no/.claude/worktrees/fix-postdeploy-audits` (shared with main; verify `git branch --show-current` before commit).

## Tasks (in priority order)

### Task 1 — Verify batch 15 live runs (BLOCKING)

8 workflows triggered from PR #392 (2026-05-19). For each:

```
gh run list --workflow=update-jobs-<key>.yml --limit 1 --json status,conclusion,databaseUrl
```

Keys to verify (with expected job counts from agent smoke-tests):
| Key | Expected jobs | Canton |
|---|---|---|
| `update-jobs-abbott` | 21 | BS/ZH/FR |
| `update-jobs-alcon` | 5 | FR |
| `update-jobs-csl-behring` | 40 (cap, see Task 3) | BE/ZH |
| `update-jobs-gesundheitsnetz-kuesnacht` | 22 | ZH |
| `update-jobs-klinik-sgm` | 9 | BE |
| `update-jobs-kzu` | 6 | ZH |
| `update-jobs-medtronic` | 7 | VD/BE |
| `update-jobs-puk-zuerich` | 90 | ZH |

For any failure: read the workflow log, identify root cause (most common: boilerplate-guard < 30 unique words OR untrusted host in `isTrustedDomain`). Fix in parser. Re-trigger.

Acceptance: all 8 workflows green with job counts within ±20% of expected.

---

### Task 2 — Fielmann backfill script

**Problem:** Jobs already in `data/jobs.json` from old crawls (Fielmann + ~20 other parsers) lack `needsRetranslation: true`. `translate-pending.yml` skips them so they stay locale-incomplete forever.

**Fix:** Write `scripts/backfill-needs-retranslation.mjs`:

```javascript
#!/usr/bin/env node
// One-shot: scan data/jobs.json + data/jobs/<lang>/*.json
// For each job that has only sourceLang locale (no IT/EN/FR if sourceLang=de, etc.)
// AND no `needsRetranslation` flag → set needsRetranslation: true.
// Rewrite jobs.json + slice files. Print count touched per company.
```

Run locally first against a copy. Once verified, commit + push as `fix(crawlers): backfill needsRetranslation on legacy locale-incomplete jobs`. Then watch `translate-pending.yml` pick them up over next cycles.

Acceptance: script outputs touched-count per company; subsequent `translate-pending` run translates first 50.

---

### Task 3 — CSL Behring maxPages bump

File: `scripts/lib/csl-behring-job-parser.mjs:172` — `maxPages: 8` → `maxPages: 10`. Returns 40/55 jobs currently; bump unlocks remaining 15. One-line PR + workflow re-trigger.

---

### Task 4 — Batch 16 discovery sweep (parallel agents)

Spawn 4 parallel sub-agents (NOT more — memory `feedback_parallel_agents` says max 3-4, 7 caused OOM):

#### Agent A: SmartRecruiters tenants
- Already covered: Swiss Medical Network (1 tenant covers 17 cliniche)
- API: `https://api.smartrecruiters.com/v1/companies/{slug}/postings`
- Candidates to probe:
  - `clinica-luganese-moncucco`, `clinica-santanna`, `clinica-sant-anna-sorengo` (already?), `klinik-arlesheim`, `klinikgut`, `hospizimpark` (private CH clinics)
  - `genolier-swiss-medical-network` (alias?), `medbase`, `centramed`, `permanence` (medical chains)
  - Google: `site:smartrecruiters.com spital OR klinik OR pflege CH`

#### Agent B: Greenhouse / Lever / Workable
- API patterns:
  - Greenhouse: `https://boards.greenhouse.io/{slug}` + `https://api.greenhouse.io/v1/boards/{slug}/jobs`
  - Lever: `https://api.lever.co/v0/postings/{slug}?mode=json`
  - Workable: `https://www.workable.com/api/v3/accounts/{slug}/jobs`
- Candidates: CH medtech startups + telehealth — `cequr`, `diametos`, `oviva`, `mindmaze`, `sophia-genetics`, `nucleix`, `dexcom-swiss`, `lifemed-id`, `aleva-neurotherapeutics`, `medartis`, `straumann`

#### Agent C: SAP SuccessFactors deep range
- Already covered: ZURZACH Care, HOCH Health, Hirslanden
- URL pattern: `https://career5.successfactors.eu/career?company={CompanyID}&site=...`
- Strategy: Google `site:career5.successfactors.eu OR jobs.successfactors.com "Schweiz" OR "Suisse"` healthcare keywords. Probe `careers.sap.com/{slug}` patterns. Try direct probe of common abbreviations.

#### Agent D: Personio / Recruitee / Teamtailor / softgarden / onlyfy
- Patterns:
  - Personio: `https://{tenant}.jobs.personio.de/`, `https://{tenant}.jobs.personio.com/`
  - Recruitee: `https://{tenant}.recruitee.com/`
  - Teamtailor: `https://career.{tenant}.com/`
  - softgarden: `https://{tenant}.softgarden.io/`
  - onlyfy: `https://{tenant}.onlyfy.jobs/`
- Already covered: Vitrea Gesundheit (softgarden). Probe healthcare CH variants.

**For each agent (constraints):**
- Cap = 4 wrappers per agent (max 16 new crawlers if all hit)
- Skip employers already covered (check `git ls-files scripts/lib/`)
- Skip non-healthcare (insurers, retail, banking, manufacturing not medtech)
- Require ≥5 jobs to implement
- ParsedJob must include `needsRetranslation: true`
- NO commits — leave files untracked
- NO `crawler-location-config.mjs` edits
- Smoke-test each parser live before finalising

---

### Task 5 — After batch 16 implementation
1. Create branch `feat/crawlers-batch-16-<summary>`
2. Verify with `git diff origin/main --name-only` shows only new `.mjs`/`.yml` files
3. Verify each parser `node --check`
4. Run `npx tsc --noEmit` — confirm any TS errors are pre-existing on origin/main (not from new files)
5. `git add` only the new parser/runner/workflow files (not data files)
6. Commit with message format used in PRs #390 #392 (table of new crawlers with ATS + Canton + Jobs columns)
7. `git push -u origin <branch>`
8. `gh pr create` with summary + test plan
9. Per memory `feedback_no_ci_wait_agent_finish`: merge immediately with `gh pr merge <N> --squash --delete-branch` once typecheck+vitest pass locally — DO NOT wait for CI
10. Trigger each new workflow via `gh workflow run update-jobs-<key>.yml --ref main`

---

### Task 6 — Optional long-tail
- Cantonal psychiatric clinics: SH, GL (small populations, may not have separate ATS)
- Spitex local (many sites; ~50% via Concara aggregator — verify)
- Pharmacy chains: Sun Store, Amavita, TopPharm (some have ATS — Personio likely)
- Schutz & Rettung Zürich, REGA, croce rossa cantonale

Each is low-volume (<10 jobs typical) but completes the funnel.

---

## Reference

**Existing factories** (`scripts/lib/*-common.mjs`):
- `prospective-ch-job-parser-common.mjs` — `createProspectiveChParser({ mediumId, ... })`
- `umantis-listing-common.mjs` — `createUmantisListingParser({ tenantId, customBaseUrl?, ... })`
- `vd-emploi-platform-common.mjs`
- `jobup-ch-feed-common.mjs`
- `successfactors-shared-common.mjs`
- `beehire-common.mjs` / `erecruit-common.mjs` / `rexx-systems-common.mjs`
- `breezy-hr-common.mjs` / `johdisuite-common.mjs` / `jobpublish-ch-common.mjs`
- `jobalino-common.mjs` / `solique-common.mjs` / `refline-common.mjs`
- `workday-client.mjs` (for myworkdayjobs.com)

**Already covered (DO NOT duplicate):**
- 116 dedicated crawlers visible via `ls scripts/lib/*-job-parser.mjs`
- Aggregators: Hirslanden SF (18 cliniche), Swiss Medical Network SR (17), Insel Gruppe Umantis 2624 (6+ sites), LUKS Prospective 1003280 (4 sedi), HOCH SF (4)

**Discovery exhaustion notes:**
- Umantis 1000-30000 sweep DONE — only KZU 1251 was new healthcare. Don't re-sweep.
- Prospective 1000273-1012000 sweep DONE in major ranges. Tail extremely sparse.
- Workday medtech 14 tenants probed — 4 ≥5 CH jobs implemented; others under threshold.

**Useful commands:**
```bash
# Check what's already covered
ls scripts/lib/*-job-parser.mjs | wc -l

# Probe Prospective
curl -sL --max-time 5 "https://ohws.prospective.ch/public/v1/medium/{ID}/jobs?lang=de&offset=0&limit=5" | jq '.total'

# Probe Umantis
curl -sL --max-time 5 "https://recruitingapp-{N}.umantis.com/Jobs/All?lang=ger" | head -c 5000

# Probe Workday
curl -sIL --max-time 8 "https://{tenant}.{wdN}.myworkdayjobs.com/Careers"

# Sync main
git fetch origin main && git status
```
