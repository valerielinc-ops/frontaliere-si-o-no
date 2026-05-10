# Cathedral CH-Wide — Status Report

**Last updated**: 2026-05-10 post-half-canton merge
**Live**: https://frontaliereticino.ch
**Safety tag**: `pre-cathedral-2026-05-10` (HEAD `58eb418c49` baseline)

---

## What's DONE ✅

### Phase 1 — Foundation (PR #54)
- TARGET_CANTONS expanded from `['TI', 'GR', 'VS']` to all 26 Swiss cantons
- `canton-quorum-gate.mjs` (BFS-strict + 2-of-3 + keep-as-is) protects SEO data integrity
- Slug-registry frozen-URL strategy preserves all existing TI URLs verbatim
- 6 ATS clients foundation: workday, greenhouse, lever, successfactors, smartrecruiters, playwright-runtime
- Sitemap-index + per-canton shards (italian-slug naming after Phase 2/6 fixes)
- `data/jobs-by-canton/{code}.json` sharding (deprecates monolithic data/jobs.json)
- 104 canton/aggregator index pages emit (initially noindex,follow)
- crawler-health-monitor.yml workflow (daily 06:30 UTC, GitHub auto-issue on stale)
- Cathedral-flip-simulation E2E regression test

### Phase 2 — 11 marquee crawlers + locale fix (PR #55)
- **Workday tier**: Roche, Novartis, Zurich Insurance, Nestlé
- **SmartRecruiters tier**: Schindler, Migros HQ
- **SuccessFactors tier**: Swiss Re
- **Custom tier**: ETH Zurich, EPFL, CHUV, Inselspital Bern
- Per-canton page renderer F4 (jobMarketSnapshot) + F5 (weeklyEmployers): 144 noindex pages
- MIN_JOBS_FOR_CANTON_PAGE=5 gate (CLAUDE.md non-negotiable #4)
- Locale variants emit (IT/EN/DE/FR) — DE was buggy, fixed in Phase 6

### Phase 3 — SR client extract + 5 hospitals (PR #56)
- `smartrecruiters-client.mjs` extracted from inline impls
- Schindler + Migros HQ + Avaloq migrated to shared client
- **Hospitals**: USZ, Unispital Basel (Prospective), KSSG (HOCH SF), Stadtspital Zürich + LUKS (placeholders)
- GSC brand dilution monitor (weekly, top-20 frontaliere queries baseline)
- Sitemap shard size monitor (40k warning / 45k critical)
- E2E test 10/10 pass (E9 frozen-URL fix)

### Phase 4 — Tier-2 + hospital wave 1 (PR #57)
- **Marquee**: Logitech (Workday), Holcim (SF), Sulzer (Workday), Givaudan (Phenom-Playwright)
- **Hospitals wave 1**: KSA (Umantis), KSW (Solique NEW), STGAG (Typo3 JSON), soH (custom HTML)

### Phase 5 — Hospital wave 2 + Avaloq SR (PR #58)
- **Hospitals wave 2**: Hirslanden (SF Mediclinic), Spital STS (Prospective), Lindenhofgruppe (Prospective), Spital Limmattal (Refline NEW)

### Phase 6 — Full close (PR #59)
- **DE locale 404 fix** (P7.1 root cause: SECTION_PREFIX_BY_LOCALE.de was 'jobs-im' instead of 'jobs-in')
- **Givaudan Phenom Playwright DOM scraper** (~225L impl, defensive selector cascade, anti-bot graceful degrade)
- **Stadtspital + LUKS unblocked** (Stadtspital uses Playwright runtime, LUKS uses Gatsby page-data + sitemap fallback)
- **Tier-3 marquee (5)**: Lombard Odier (Workday), Richemont/MSC Cargo/Bobst/Vaudoise (Playwright placeholders)
- **Hospital wave 3 (5)**: GZO Wetzikon (PastaHR NEW), Spital Männedorf (Umantis), Spital Uster (Prospective), KSB (Workday), See-Spital (Umantis)

### Phase 7 — Architectural hotfix (PR #60)
- **Canton hub pages = filtered JobBoard**, not thin landings:
  - `/cerca-lavoro-ticino/` now correctly filters to TI jobs only
  - `/cerca-lavoro-zurigo/`, `/cerca-lavoro-ginevra/`, etc. fetch only that canton's shard
  - `/cerca-lavoro-svizzera/` is the aggregator (top-N cantons)
  - `/cerca-lavoro-{canton}/{slug}` per-job URL pattern works via SPA hydration

### Phase 7.5 — Half-canton URL merge (2026-05-10) ✅
**Status**: DONE on branch `feat/cathedral-half-canton-merge`, awaiting user review.

- **AI + AR collapsed onto a single virtual URL group `APPENZELLO`** (slugs: it `appenzello`, en/de/fr `appenzell`)
- **BL + BS collapsed onto a single virtual URL group `BASILEA`** (slugs: it `basilea`, en/de `basel`, fr `bale`)
- Other 22 cantons untouched. Total = **22 single + 2 merged = 24 URL canton groups + svizzera aggregate**.
- New `data/canton-url-slugs.json` `cantonGroups` registry: `APPENZELLO -> [AI, AR]`, `BASILEA -> [BL, BS]`.
- New `resolveCantonGroup(code)` helper exported from `services/router.ts` and `scripts/lib/canton-url-slugs.mjs` (with TS twin inlined into `build-plugins/jobsSeoPagesPlugin.ts`, `build-plugins/jobMarketSnapshotChCantonPages.ts`, `build-plugins/weeklyEmployersChCantonPages.ts`). Internal BFS / canton-quorum logic unchanged: jobs are still tagged with the real BFS code; the URL/shard emission boundary applies the helper to collapse onto the group key.
- `build-plugins/jobsSeoPagesPlugin.ts`: `classifyCantonForUrl` returns the resolved group key, so `data/jobs-by-canton/APPENZELLO.json` + `data/jobs-by-canton/BASILEA.json` shards replace the four AI/AR/BL/BS shards. Sitemap shards similarly: `sitemap-jobs-appenzello.xml` + `sitemap-jobs-basilea.xml`.
- `build-plugins/weeklyEmployersChCantonPages.ts`: per-canton "aziende che assumono" hubs merge AI+AR and BL+BS buckets *before* the MIN_JOBS_FOR_CANTON_PAGE gate so combined totals can clear the threshold.
- `build-plugins/jobMarketSnapshotChCantonPages.ts`: cities + jobs collapse onto the URL group key.
- `services/router.ts`: `getJobBoardSlugForCanton` accepts either real BFS code or group key (idempotent). `parseJobBoardSlug` already iterates the JSON `cantons` keys, so /cerca-lavoro-appenzello/, /en/find-jobs-appenzell/, /de/jobs-in-appenzell/, /fr/trouver-emploi-appenzell/ all parse to `jobBoardCanton: 'APPENZELLO'`.
- Regression coverage: `tests/half-canton-merge.test.ts` (61 assertions) — `npx tsc --noEmit` clean, all targeted tests green.
- **No SEO regression risk**: AI/AR/BL/BS were brand-new in cathedral PRs #54-60; no live traffic depends on the per-half-canton URLs.

---

## Total cathedral output

- **35+ new crawlers** (5 ATS tiers + custom + Playwright)
- **7 ATS clients** (workday, greenhouse, lever, successfactors, smartrecruiters, playwright-runtime + scaffold)
- **3 monitoring workflows** (crawler-health daily, GSC brand monitor weekly, sitemap shard size weekly)
- **104 canton index pages** + **144 F4/F5 per-canton snapshot+employer pages**
- **NEW ATS patterns identified** (extract candidates when 2nd tenant lands):
  - Phenom People (Givaudan)
  - Refline (Spital Limmattal)
  - Solique (KSW)
  - PastaHR / publicjobs.ch widget (GZO Wetzikon)
  - Hireserve (CHUV)

---

## What's NOT DONE — manual or follow-up

### 🟢 Manual / strategic decisions (require user action)

1. **AdSense URL channels per canton** — manual UI work in AdSense dashboard. +18 nuovi cantoni, ~30 min totali.
2. **LinkedIn discovery** (D12 deferred per ToS) — strategic decision: accetti il rischio ToS o no? Se sì, c'è già `scripts/discover-marquee-companies-linkedin.mjs` da eseguire localmente con account autenticato.
3. **Brand monitor baseline bootstrap** — `gh workflow run gsc-frontaliere-monitor.yml -f update_baseline=true` dopo ~1 settimana di traffic stabilizzato post-cathedral.
4. **noindex→index flip** — dopo 7-14 giorni di data accumulation, valuta quali canton/F4/F5 pages hanno ≥5 jobs canonical e meritano flip da noindex,follow a index,follow. Già wired via MIN_JOBS_FOR_CANTON_PAGE gate, just needs data + verification.
5. **6 SEO content gates rebaseline** dopo cathedral data accumulation: text-html-ratio, orphan-pages, image-license, bfs-depth, title-length, title-no-disambig-hash. Run `npm run audit:{name}:rebaseline` per ognuno.

### 🟡 Code follow-ups (richiedono nuova sessione orchestrator)

6. **Sitemap submission to Google + IndexNow** — script esistono (`scripts/submit-google-indexing-jobs.js`, `scripts/submit-indexnow-batch.mjs`) ma NON sono wired in `deploy.yml`. Va aggiunto un step post-deploy. Deve usare auth Service Account + GSC ownership configurata.
7. **5 alreadyCrawled marquee** (UBS, Pictet, Mobiliar HQ, HUG, Syngenta) — verifica se la loro location filter è ancora TI-anchored e se va espansa a CH-wide tramite canton-quorum-gate.
8. **Tier-3 marquee Playwright DOM logic** (Richemont, MSC Cargo, Bobst, Vaudoise) — placeholder con `--playwright` flag ma DOM selectors non implementati. Richiedono CH-residential-proxy per anti-bot Cloudflare/Akamai.
9. **Hospital wave 3 runners + workflows** (gzo-wetzikon, spital-maennedorf, spital-uster, ksb, see-spital) — parser scaffolded ma `scripts/update-{slug}-jobs.mjs` + `.github/workflows/update-jobs-{slug}.yml` skippati. Quick fix: `node scripts/scaffold-crawler.mjs --finish-existing-parser {slug}` (~5 min ognuno).
10. **3 NEW ATS client extractions** (quando 2° tenant landa per ognuno):
    - `phenom-client.mjs` — quando trovi un secondo Phenom-using employer
    - `refline-client.mjs` — quando trovi un secondo Refline-using ospedale
    - `solique-client.mjs` — quando trovi un secondo Solique tenant
    - `pastahr-client.mjs` — quando trovi un secondo PastaHR tenant
11. **10 SF detail-page parser migration** (giorgio-armani, rapelli, sbb, heineken-ch, oerlikon, benteler, interdiscount, jumbo, prada, plus eventually agroscope) — debt cleanup. Richiede prima estensione `successfactors-client.mjs` (multi-search seed URLs, jobs2web row parser export).
12. **Job-alert geo subscription** — canton selector nel form `JobAlertForm`, ~3-5h CC.
13. **Cathedral retrospective** — analisi metriche dopo 4-6 settimane post-deploy: revenue impact, GSC ranking shift, new traffic acquisition, brand dilution check.

### 🔴 Live validation passive (1-2 cicli crawler)

14. **First-run live validation 24+ nuovi crawler** — Workday SWISS_LOCATION_IDS verifica per Roche/Novartis/Nestlé/Zurich Insurance, anti-bot tolerance, parser drift. Lascia girare 1-2 cicli + monitora `data/crawler-health.json` automated alerts. Fix reattivi se serve.
15. **Stadtspital geo-block resolution** — first dispatch valida se Azure CH egress IP funziona. Se no, valuta CH residential proxy o self-hosted CH runner.

---

## Pages overview — verifica manuale

### Pagine esistenti (legacy + cathedral)

#### Per locale (4 locales)

```
LEGACY (intoccato, frozen-URL):
  IT  /cerca-lavoro-ticino/                       → TI filtered JobBoard ✓
  EN  /en/find-jobs-ticino/                       → TI filtered JobBoard ✓
  DE  /de/jobs-im-tessin/                         → TI filtered JobBoard ✓
  FR  /fr/trouver-emploi-tessin/                  → TI filtered JobBoard ✓

CATHEDRAL (per canton, 25 nuovi cantoni):
  IT  /cerca-lavoro-{ag|ar|be|bl|bs|fr|ge|gl|gr|ju|lu|ne|nw|ow|sg|sh|so|sz|tg|ur|vd|vs|zg|zh}/
        canton-italian-slug values: argovia, appenzello-esterno, berna, basilea-campagna, basilea-citta,
        friburgo, ginevra, glarona, grigioni, giura, lucerna, neuchatel, nidvaldo, obvaldo, sangallo,
        sciaffusa, soletta, svitto, turgovia, uri, vaud, vallese, zugo, zurigo
  EN  /en/find-jobs-{anglicized-canton-slug}/     (anglicized: zurich, geneva, etc.)
  DE  /de/jobs-in-{anglicized-canton-slug}/       (anglicized: zurich, basel, etc.)
  FR  /fr/trouver-emploi-{anglicized-canton-slug}/

AGGREGATOR (1 svizzera-wide, 4 locales):
  IT  /cerca-lavoro-svizzera/                     → AGGREGATE filtered JobBoard
  EN  /en/find-jobs-switzerland/
  DE  /de/jobs-in-der-schweiz/
  FR  /fr/trouver-emploi-suisse/

PER-JOB URL (slug-registry frozen):
  /cerca-lavoro-{canton-slug}/{job-slug}          (job detail con canton ctx)
  EN/DE/FR equivalents

CITY HUBS (per Ticino, esistenti):
  /cerca-lavoro-ticino/{lugano|mendrisio|bellinzona|locarno|chiasso}/

SECTOR HUBS (per Ticino, esistenti):
  /cerca-lavoro-ticino/{infermieri|case-anziani|...}/
```

**Total nuove pagine create dal cathedral**:
- Canton index: 26 cantoni × 4 locales = 104
- F4 snapshot per-canton: 18 eligible × 4 locales = 72
- F5 employers per-canton: 18 eligible × 4 locales = 72
- Per-job dedicated (tutti slug-registry frozen): cresce a runtime con i nuovi job

### Lista crawler attivi (da Phase 1-6 cathedral, in aggiunta ai 220 pre-esistenti)

**Tier-1 marquee (Phase 2)**: roche, novartis, zurich-insurance, nestle, schindler, migros-hq, swiss-re, eth-zurich, epfl, chuv, inselspital
**Tier-2 marquee (Phase 4)**: logitech, holcim, sulzer, givaudan
**Tier-3 marquee (Phase 6)**: lombard-odier, richemont, msc-cargo, bobst, vaudoise
**Hospitals (Phase 3+5+6)**: usz, unispital-basel, kssg, stadtspital-zuerich, luks, ksa, ksw, spital-thurgau, solothurner-spitaeler, hirslanden, spital-sts, lindenhofgruppe, spital-limmattal, gzo-wetzikon, spital-maennedorf, spital-uster, ksb, see-spital

**Total**: ~38 nuovi crawlers in cathedral.

---

## Sitemap submission mechanism

### Scripts esistenti (NON wired in deploy)

Il progetto ha **4 script di submission** ma sono manuali — non eseguiti automaticamente da `deploy.yml`:

| Script | Cosa fa | Auth |
|---|---|---|
| `scripts/submit-google-indexing-jobs.js` | Google Indexing API per JobPosting URLs | Firebase SA o GSC OAuth |
| `scripts/submit-google-indexing.js` | Google Indexing API generic | Firebase SA |
| `scripts/submit-indexnow-batch.mjs` | IndexNow batch (Bing + Yandex) | API key |
| `scripts/submit-indexnow.js` | IndexNow single URL | API key |

### Cosa serve per attivare submission automatica

1. **Verifica auth Search Console**:
   - Service Account deve essere Owner del property `sc-domain:frontaliereticino.ch` su GSC
   - "Web Search Indexing API" deve essere abilitata su GCP
   - Memoria conferma che il SA `gsc-service-account@frontaliere-ticino.iam.gserviceaccount.com` ha già permessi GSC

2. **Wire in deploy.yml** post-build:
   - Dopo step `Validate dist`, aggiungi step "Submit indexed URLs":
     ```yaml
     - name: Submit changed URLs to Google Indexing API
       if: success() && github.event_name == 'push' && github.ref == 'refs/heads/main'
       env:
         GOOGLE_APPLICATION_CREDENTIALS: ${{ runner.temp }}/firebase-sa.json
       run: |
         echo "${{ secrets.FIREBASE_SERVICE_ACCOUNT_JSON }}" > "$GOOGLE_APPLICATION_CREDENTIALS"
         node scripts/submit-google-indexing-jobs.js --limit 50
     - name: Submit changed URLs to IndexNow
       if: success()
       env:
         INDEXNOW_KEY: ${{ secrets.INDEXNOW_API_KEY }}
       run: node scripts/submit-indexnow-batch.mjs --limit 200
     ```

3. **Sitemap auto-discovery via robots.txt**:
   - `public/robots.txt` deve avere `Sitemap: https://frontaliereticino.ch/sitemap-index.xml`
   - GSC poi crawl-discoverà tutti gli shard automaticamente

4. **Manual one-time GSC submission**:
   - Dopo deploy iniziale del cathedral, invia manualmente `sitemap-index.xml` da Google Search Console UI sotto "Sitemaps" → "Add sitemap"
   - Per IndexNow: visita `https://www.bing.com/indexnow?url=https://frontaliereticino.ch&key={key}` una volta

### Verifica corrente

- ✅ Sitemap accessibile: https://frontaliereticino.ch/sitemap-index.xml HTTP 200
- ⚠️ Sitemap submission auto in deploy.yml: NOT YET WIRED (presente solo in commenti)
- ⚠️ GSC manual submission del nuovo sitemap-index.xml: required dopo Phase 6 deploy
- ⚠️ IndexNow API key: verifica che `INDEXNOW_API_KEY` secret esista in GH Actions

### Recommendation

**Phase 8 quick task** (~1h CC):
- Aggiungi step submission a `deploy.yml`
- Documenta auth requirements in `docs/CATHEDRAL-IMPLEMENTATION-PLAN.md`
- Manual GSC sitemap-index resubmission post-cathedral merge

---

## Live verification (post Phase 7 hotfix deploy)

```
Pagine canton hub (devono mostrare JobBoard filtrato a quel canton):
  /cerca-lavoro-ticino/         → JobBoard with TI shard         (FIXED P7.1)
  /cerca-lavoro-zurigo/         → JobBoard with ZH shard         (FIXED P7.2+P7.3)
  /cerca-lavoro-ginevra/        → JobBoard with GE shard
  /cerca-lavoro-svizzera/       → JobBoard with AGGREGATE
  /en/find-jobs-zurich/         → English locale, ZH shard
  /de/jobs-in-zurich/           → German locale, ZH shard        (FIXED P6 jobs-im → jobs-in)
  /fr/trouver-emploi-zurich/    → French locale, ZH shard

Sitemap:
  /sitemap-index.xml            → list 23 shards
  /sitemap-jobs-zurigo.xml      → ZH-canton job URLs only
  /sitemap-jobs-svizzera.xml    → aggregator/uncertain jobs

Per verificare manualmente:
  curl -s https://frontaliereticino.ch/cerca-lavoro-zurigo/ | grep -i 'job\|annuncio' | head -3
  # Deve mostrare contenuto job-listing reale, non thin landing
```

---

## Branch state

- **Branches**: only `main` (after Phase 7 merge)
- **Stashes**: 0
- **Tags**: `pre-cathedral-2026-05-10` (global safety)
- **GitNexus**: re-indexed (27,720+ nodes / 59,300+ edges / 1,270+ clusters)

---

## Status: **DONE_WITH_DOCUMENTED_MANUAL_TODOS**

Cathedral CH-wide è SHIPPED su https://frontaliereticino.ch. La cattedrale architetturale (canton hubs come search engine pre-filtrati, frozen-URL slug strategy, 7 ATS clients, 3 monitoring workflows, 38 nuovi crawler) è completa e funzionante.

Le 15 manual/follow-up sono documentate sopra. Nessuna è blocker per funzionalità core. Aspettano:
- Decisioni strategiche (LinkedIn ToS, AdSense channels, brand baseline timing)
- Validation passive (first-run live + 4-6 settimane data accumulation)
- Quick implementation tasks (sitemap submission wire, hospital wave 3 runners, alreadyCrawled audit) — 1-2 sessioni totale
