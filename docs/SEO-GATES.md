# SEO Content Gates

Each gate is a **per-feature ratchet**: counts can only go DOWN. Improvements never auto-rebaseline — run the listed `:rebaseline` script after a deliberate drop and commit the new baseline together with the fix.

> **Hard rule (CLAUDE.md non-negotiables #1, #5):** Never widen a baseline as a workaround. Never set `noindex` to "fix" an orphan/deep page without explicit per-URL approval. Default fix is internal links, not de-index.

---

## Hard vs nice-to-have (issue #6462, VISION.md driver D9)

Every content-quality gate below falls into one of two buckets. The bucket
decides how a FAILURE behaves — never how a regression is measured, and
never the baseline itself (D2, unchanged: the ratchet still only shrinks).

- **hard** — verifies a datum/markup Google literally requires for
  indexing/rich-results: a structured-data mandatory field, canonical/
  hreflang, a status code, a broken redirect, or a rendering defect severe
  enough that the page does not actually serve (blank shell, broken JSON-LD
  parse). Stays **blocking**: a red run sequesters `publish` (the deploy's
  IndexNow / Google Indexing API / GSC notification), same as before.
- **nice-to-have** — an opportunistic internal heuristic Google does not
  require (text density, crawl depth, title cosmetics, near-duplicate
  content value, …). The page still renders and serves when the gate is
  red. Becomes **advisory**: the run stays RED and the failure issue still
  opens (nothing here silences a regression — D2's "the measure is
  corrected, never the threshold" still applies), but the gate no longer
  sequesters `publish`.

**Where the advisory behaviour actually lives.** `post-deploy-validate-dist.yml`
does not gate `publish` on its own job result — it gates on
`integrity-verdict`, which runs every failed gate name through
`scripts/ci/classify-validate-dist-failures.mjs`'s `QUALITY_GATES` table
(default-deny: unlisted = blocking). That mechanism already existed
(issues #4828/#5128) for most of the census below; this issue's concrete
delta was two gaps where the table had no entry at all — the auditor was
registered in `scripts/audit-all.mjs` but silently fell through
default-deny to blocking:

| Gate | Bucket before #6462 | Fix |
|---|---|---|
| `audit:all/breadcrumb-coverage` | blocking (unlisted) | added to `QUALITY_GATES` — BreadcrumbList is an optional rich-result enhancement, not a mandatory field |
| `audit:all/information-gain` | blocking (unlisted) | added to `QUALITY_GATES` — near-duplicate/thin-value heuristic (`docs/INFORMATION-GAIN.md`), not a Google requirement |

**Census — every gate registered in `scripts/audit-all.mjs` (18) plus the
2 that run outside it (BFS/orphan) plus the already report-only ones:**

| Gate | Bucket | Why |
|---|---|---|
| text-html-ratio | nice-to-have | Semrush heuristic (§1); already `QUALITY_GATES` |
| orphan-sitemap-pages | nice-to-have | internal-link crawl depth heuristic (§2); already `QUALITY_GATES` (`audit:orphan-sitemap-pages`) |
| image-object-license | **hard** | structured-data mandatory fields for licensable-image rich results (§3); zero-tolerance, no ratchet |
| max-bfs-depth | nice-to-have | crawl-depth heuristic (§4); already `QUALITY_GATES` (`audit:max-bfs-depth`) |
| title-length | nice-to-have | SERP display/CTR heuristic (§5); already `QUALITY_GATES` |
| title-no-disambig-hash | nice-to-have | CTR cosmetic, hash suffix (§6); already `QUALITY_GATES` |
| information-gain | nice-to-have | near-duplicate/thin-value heuristic (§8); **fixed by #6462**, see table above |
| footer-root-presence | **hard** | hydration-shell bug — page ships blank/buried content, does not actually serve |
| jsonld-no-nested-scripts | **hard** | breaks JSON-LD parsing entirely — Google cannot read the structured data at all |
| h1-title-duplicates | nice-to-have | Semrush "duplicate H1/title" style rule; already `QUALITY_GATES` |
| salary-landing-template | nice-to-have | UI/UX template drift, not a Google signal; already `QUALITY_GATES` |
| page-weight | nice-to-have | byte-size heuristic, not a literal Google requirement; already `QUALITY_GATES` |
| content-duplicates | nice-to-have | exact-duplicate body heuristic within locale; already `QUALITY_GATES` |
| faqpage-validity | **hard** | FAQPage structured-data validity — invalid markup, not eligible for rich results |
| no-literal-markdown | nice-to-have | leaked markdown syntax is a rendering blemish, page still serves; already `QUALITY_GATES` |
| breadcrumb-coverage | nice-to-have | optional BreadcrumbList rich-result enhancement, not mandatory; **fixed by #6462**, see table above |
| single-h1-per-page | nice-to-have | ambiguous page topic (a Discover-card *preference*, not an indexing requirement) — the page still serves and indexes; already `QUALITY_GATES` |
| duplicate-structured-data | nice-to-have | a duplicated JSON-LD `@type` costs that one rich-result feature, the page itself still serves and indexes; already `QUALITY_GATES` |
| link-anchor-text | nice-to-have (dual-purpose) | protects accessible-name/WCAG as well as Semrush A3; kept as `QUALITY_GATES` already — page serves regardless |
| duplicate-meta-description | nice-to-have | recycled `<meta description>`, Google just rewrites the snippet; already `QUALITY_GATES` |
| discover-eligibility (§7) | n/a — never a gate | `report()` hardcodes `passed: true`; was already report-only before #6462, no change needed |

**`cathedral-seo-gates-check.yml` — already fully advisory, no change needed.**
Item 2 of #6462 asked to verify whether this workflow blocks anything
downstream. It does not: it is a standalone weekly `schedule` job with no
`needs:` edge from any other workflow, it replays a past deploy's already-
published `dist/` artifact (it does not gate the deploy that produced it),
and its own header comment states the contract explicitly — "This workflow
NEVER mutates baselines" and only opens an issue (regression) or suggests a
rebaseline (improvement, never applied automatically, see driver D9). A red
run here fails the *workflow's own* GitHub Actions status, which nothing
else consumes. It is the one gate in this census that was advisory from the
day it was written; the delta introduced by #6462 is entirely in the
`post-deploy-validate-dist.yml` / `classify-validate-dist-failures.mjs`
pipeline documented above.

---

## 1. Text-to-HTML ratio

**Why.** Semrush flags pages with `visibleText / totalHTML ≤ 10 %` as "low text-to-HTML ratio". The Apr 2026 audit caught 1,193 such pages.

**Where.**
- Local: `npm run audit:text-html-ratio` (after `npm run build`)
- CI: `Gate — text-to-HTML ratio` step in `.github/workflows/deploy.yml`
- Baseline: `data/text-html-ratio-baseline.json`
- Rebaseline: `npm run audit:text-html-ratio:rebaseline`

**Playbook on regression:**

1. `npm run build && npm run audit:text-html-ratio` — stderr names the regressing feature bucket.
2. Inspect worst offenders: `node scripts/audit-text-html-ratio.mjs --feature=<name> --limit=20`
3. Find the emitter:

   | Feature bucket | Plugin / source |
   |---|---|
   | `fuel-daily` | `build-plugins/fuelDailyPagesPlugin.ts` |
   | `weekly-employers` / `weekly-employers-hub` | `build-plugins/weeklyEmployersPlugin.ts` |
   | `health-premiums` | `build-plugins/healthPremiumsLandingPlugin.ts` |
   | `job-board` | `build-plugins/jobsSeoPagesPlugin.ts` |
   | `blog` | `scripts/create-article.mjs` |
   | `spa-locale` / `spa-other` | `build-plugins/htmlTemplate.ts` + SPA prerender shell |

4. Add **coherent, page-relevant** content — methodology paragraph, FAQ, scenario walk-through, contextual cross-references. Never hidden text or boilerplate (Google penalises template-wide duplication and cloaking).
5. Rebuild + rerun + rebaseline + commit.

---

## 2. Orphaned pages in sitemaps

**Why.** Semrush flagged 4,936 "orphaned pages in sitemaps" — pages listed in any `sitemap-*.xml` but not reachable via internal `<a href>` BFS from the homepage.

**Where.**
- Local: `npm run audit:orphan-sitemap-pages`
- CI: `Gate — orphan pages in sitemaps` step in `.github/workflows/deploy.yml`
- Baseline: `data/orphan-pages-baseline.json`
- Rebaseline: `npm run audit:orphan-sitemap-pages:rebaseline`

**Playbook.** The cause is usually:
- **Static archive page lost an internal link** (e.g. nav widget removed) — fix the link source.
- **New auto-generated content** (cron-published article/job) with no static linker — add a link from the relevant index (`/articoli-frontaliere/` → `/articoli-frontaliere/tutti/`) or update the archive pagination.
- **Sitemap entry without HTML** (stale entry) — restore page or remove from sitemap.

---

## 3. ImageObject license fields (zero tolerance)

**Why.** Google Search Console flags every `ImageObject` in JSON-LD that omits any of the five licensable-image fields: `acquireLicensePage`, `copyrightNotice`, `license`, `creator`, `creditText`. Without ALL five, the image is ineligible for licensable-image rich results and surfaces as "Migliora l'aspetto degli elementi" in GSC.

**Where.**
- Helper: `services/seo/imageObjectLd.ts` — every new emitter MUST go through `imageObjectLd()` / `imageObjectLdDocument()`. Helper defaults to site Organization as creator + `/termini-di-servizio#licenza-immagini` license URL. `creditText` defaults to resolved `creator.name` or `"Frontaliere Ticino"`.
- Local audit: `npm run audit:image-object-license`
- CI: `audit:image-object-license` step in `.github/workflows/post-deploy-validation.yml`
- Vitest: `tests/seo/image-object-license-fields.test.ts` (runs in pre-push when `RUN_DIST_GATES=1`)

**Hard rule.** Zero tolerance — no ratchet/baseline. For third-party images (webcams, press photos), pass overrides to `imageObjectLd()`; never strip fields:

```ts
imageObjectLd({
  contentUrl: webcam.imageUrl,
  creator: { '@type': 'Organization', name: webcam.sourceName },
  license: webcam.license,
  copyrightNotice: `© ${webcam.sourceName}`,
})
```

---

## 4. BFS depth from `/` (MAX_DEPTH=4)

**Why.** Real crawlers (Ahrefs, Googlebot) cap their crawl depth. A URL only reachable at BFS depth ≥ 5 from `/` is effectively orphan even if `audit:orphan-sitemap-pages` accepts it. May 2026 Ahrefs audit caught 1,854 IT blog articles in this gap.

**Where.**
- Local: `npm run audit:max-bfs-depth`
- CI: `audit:max-bfs-depth` step in `.github/workflows/post-deploy-validation.yml`
- Baseline: `data/bfs-depth-baseline.json`
- Rebaseline: `npm run audit:max-bfs-depth:rebaseline`

**Depth schema (default MAX_DEPTH=4):** `0=/`, `1=tab`, `2=hub index`, `3=archive page`, `4=leaf URL` (articles, jobs). Running with a different `--max-depth` than the baseline refuses to compare.

**Playbook.** The cause is usually:
- **Compact pagination ate the link graph**: section index links only `page-1, current-1, current, current+1, last` — pages 3..N-2 reachable only via chained "next" clicks. Fix: emit a full page navigator linking every `page-N` directly. Reference: commit `aa987d38f7` for the `/articoli-frontaliere/` fix.
- **Hub page lost a child-list section**: e.g. `/mercato-lavoro-ticino/` stopped listing per-sector snapshots. Fix: add child-list `<section>` so each child is at depth 2 from `/`.

### 4b. Baseline justification — "registered" is not "covered" (#5545)

**Why.** The ratchet above compares each sitemap against **its own** baseline entry, so it can never judge that entry. `sitemap-health-facilities.xml` was registered at 388/436 (**88.99 %**) and stayed green for months — not an accepted trade-off but an undiagnosed defect: `pickFacilities()` capped the linked set at a constant 48 while the family grew with the corpus, so 380 emitted, sitemap-listed pages were linked from nothing (#5434, fixed by #5543). A constant cap against a growing family raises the buried share slowly and monotonically, which is exactly the shape a ratchet ignores.

Two paths could widen a baseline. **Drift** is now mostly covered — the `capSaturated` arm stops a >~87 % shard from being rate-immune — though above 53.33 % the relative term saturates at `maxDeltaPp`, leaving a flat **+13 pp** of slack whatever the baseline already is (4,015 further URLs across the high entries as shipped). **Rebaselining was not covered at all**: `audit:max-bfs-depth:rebaseline` overwrites every number with the current measurement and nothing compared the new file to the old, so a regression that happened to be rebaselined was accepted permanently.

**Where.**
- Gate: `tests/seo/bfs-baseline-justification.test.ts` — static, runs in the normal `tests` job on every PR, i.e. when a high baseline would be *registered* rather than post-deploy once it has shipped.
- Report: `npm run report:bfs-high-baselines` (also printed by `audit:max-bfs-depth` on every gated run).
- Logic + ledger: `scripts/lib/bfsBaselineJustification.mjs`.

**The rule.** An entry is *high* at ≥ 50 % of its URLs below crawl depth over ≥ 20 of them (50 % sits in the widest empty band of the shipped distribution, 39.62 %→61.50 %; 91 % of all registered buried URLs are above it). A high entry must either carry a written `reason` in the baseline JSON — on the model of the corpus's `loop-sync-manifest.json` — or appear in the frozen `UNJUSTIFIED_HIGH_BASELINES` ledger. The ledger is shrink-only: a new high entry fails, a grandfathered one that grows on **both** rate and count fails, and a line that has been fixed or since justified fails with "delete it".

**Playbook.** A failure here is never fixed by raising a frozen number or by writing a reason you cannot defend — both reproduce the defect with extra ceremony. Fix the internal linking so the rate drops below the threshold and delete the ledger line, or diagnose the family, decide the buried state is genuinely correct, and move that argument into the entry's `reason`. Reasons survive a rebaseline (`carryForwardReasons`) but are **dropped** if the rate regressed: the justification described the old number.

---

## 5. `<title>` length (60 + 10 % tolerance, max 66)

**Why.** Google's SERP-display budget is ~60 char; titles past it get visually truncated or rewritten by Google, costing keyword visibility. May 2026 Semrush audit flagged 2,740 indexable pages — almost all with the `" | Frontaliere Ticino"` brand suffix (22 char) appended on top of an already-near-cap headline.

**Where.**
- Helper: `build-plugins/shared/titleSuffix.ts` exports `TITLE_TARGET_CHARS = 60`, `TITLE_MAX_CHARS = 66`, and `buildTitleWithBrand()`. The helper **drops the brand suffix** when `headline + brand > 66` instead of truncating mid-headline.
- Local audit: `npm run audit:title-length`
- CI: shard 3 of `scripts/lib/post-build-tasks.sh`
- Baseline: `data/title-length-baseline.json`
- Rebaseline: `npm run audit:title-length:rebaseline`

**NEVER reintroduce mid-`…` truncation:** it tanked CTR on `/calcola-stipendio/` 4.8 % → 0.99 % during the cap=70 era.

**Job-board exception.** `composeJobPageTitle` in `build-plugins/jobsSeoPagesPlugin.ts` passes `JOB_TITLE_MAX = 70` to preserve city + (#hash) disambiguator structure. Job pages account for the bulk of the baseline by design.

**Playbook.** Cause is usually:
- **New template added a brand-preserving caller** that didn't go through `buildTitleWithBrand` — route through helper.
- **AI-generated headline drift**: `create-article.mjs` prompts started returning ~70-char headlines — fix prompt to target 50-60 char.
- **Cap intentionally raised**: someone bumped `TITLE_MAX_CHARS` past 66. Reject — never widen the cap.

Use `FAST_BUILD= npx vite build && npm run audit:title-length` to reproduce locally (FAST_BUILD env trap).

---

## 6. `(#hash)` disambiguator visible in `<title>`

**Why.** When two articles produce the same base `<title>`, the og-pages plugin appends a runtime disambiguator (`build-plugins/ogPagesPlugin.ts:articleHashFromSlug`). Disambiguator prefers a HUMAN-READABLE token (year `(2026)`, known city `— Bellinzona`, trailing slug word) and falls back to an FNV-1a 8-hex hash `(#abcd1234)` only as last resort. May 2026 Semrush audit caught **935 IT blog pages** with the hash visible in SERP — kills CTR. Goal: drive count to 0 by deduping at source.

**Where.**
- Local: `npm run audit:title-no-disambig-hash` (greps `dist/` for `\(#[0-9a-f]{8}\)` inside `<title>`)
- CI: shard 3 of `scripts/lib/post-build-tasks.sh`
- Baseline: `data/title-no-disambig-hash-baseline.json`
- Rebaseline: `npm run audit:title-no-disambig-hash:rebaseline`
- Preventive: `scripts/create-article.mjs:optimizeSeoMetadata` checks new article's IT title against existing `blog-meta-it.ts` titles AT CREATE TIME and auto-appends year/city. Hard-fails when year+city are insufficient.

**Playbook.**
1. `FAST_BUILD= npx vite build && npm run audit:title-no-disambig-hash` — stdout shows offending pages with hash + base title.
2. Find colliding pair: grep `services/locales/blog-meta-it.ts` for the base title (without brand suffix). Two articles with the same `'.title'` value will be the cause.
3. Fix at source by editing one article's `'.title'` in all four locale meta files (`blog-meta-{it,en,de,fr}.ts`). Add a year/city/source qualifier: `"Primo Maggio a Varese"` → `"Primo Maggio a Varese 2026: corteo CGIL"`.
4. NEVER widen the baseline as a workaround.

---

## 7. Discover eligibility (REPORT-ONLY — not a gate)

**Why.** Google Discover applies a hard prerequisite before a page can take a large-image card: `max-image-preview:large` in the robots meta. On 2026-08-05 one URL from each of the 87 sitemaps in `sitemap.xml` was fetched with a Googlebot UA; **50 of the 83 families that answered 200 shipped without it**. The gap had previously been recorded as "already present on every page" — a spot check on four article URLs, generalised. This report exists so the next such claim is a number CI produces on every deploy.

The root cause is fixed at the source (see below), so the directive is now true by construction. What the report still measures per family is the part that source code cannot assert: whether the emitted pages actually carry one `<h1>`, a canonical, and a crawlable image wide enough for the large card.

**Where.**
- Local: `npm run audit:discover-eligibility` (add `--strict` to exit 1 on findings, `--json` for machine output, `--dist=<path>` to point elsewhere)
- CI: inside the `Post-build validations + SEO audits (capped parallel)` step of `.github/workflows/post-deploy-validate-dist.yml`, job `validate-dist-postbuild` — search `DISCOVER ELIGIBILITY — REPORT, NOT A GATE`. Until #5440 it was a separate `continue-on-error: true` step running *after* that pool; it now runs *inside* it, concurrently, and its output is printed under a `Discover eligibility — REPORT ONLY` banner in that step's log. Non-gating is now structural rather than declarative: its row in the timings table carries a hard-coded `rc=0` and it never writes to `/tmp/post-build-failures.txt`, so it can reach neither `failed_gates` nor the default-deny classifier
- Report artifact: `dist/audit-reports/discover-eligibility.json` (`extra.perFamily` carries the per-family pass rates)
- Vitest: `tests/seo/audit-discover-eligibility.test.ts`

**In CI this report reads a 25 % rotating sample, not the whole of `dist/` (since #5432).** At 100 % it scanned ~2.07M indexable pages and took 35-42 min — 43-46 % of the entire `validate-dist-postbuild` job, serialised after the audit pool, for something that is not a gate. The step now sets `AUDIT_SAMPLE_RATE=0.25` and `AUDIT_SAMPLE_SALT=${{ github.run_number }}`, which `scripts/audit-discover-eligibility.mjs` already honoured via `resolveSamplingEnv()` / `sampleFiles()`.

Sampling is safe *here* for a reason that does not generalise: this script has no baseline and no ratchet, so there is no threshold for a smaller denominator to loosen — `report()` returns `passed: true` unconditionally, and the output is a per-family *rate*, which a 25 % slice of 2.07M pages estimates to well inside its own reporting precision. What it does cost is coverage latency: a family small enough to draw zero pages is absent from that run's table, and the slice rotates over `round(1/0.25)` = 4 consecutive runs — at the measured ~2 h `deploy-publish` cadence, up to ~8 h before a newly-broken family surfaces. That is acceptable only because the two *universal* checks are enforced on every run at the source (`tests/seo/discover-robots-directive.test.ts`, `tests/dist-single-h1-per-page.test.ts`). A local run without those env vars still scans 100 %.

Counter-example, so the rule is not over-applied: `audit:spa-bundle-injection` is deliberately **not** sampled. It ratchets on a zero-tolerance absolute count whose baseline headroom (~141 against 10 800) is smaller than the sampling noise a 25 % draw would introduce (σ ≈ ±180 after extrapolation), so sampling would make it flap red rather than merely loosen it.

**Checks.** `maxImagePreviewLarge`, `singleH1` (exactly one — zero fails too), `canonical` are *required*; `largeImage` (an `<img>` with a declared `width` ≥ 1200) is *advisory*. `noindex` and meta-refresh pages are excluded — they are outside Discover's universe by construction.

**Hard rule — this must NOT become a blocking gate by accident.** A red `validate-dist` skips the entire `publish` job (IndexNow, Google Indexing API, GSC sync). An eligibility report that blocks indexation costs more traffic than the gap it measures. `createAuditor().report()` therefore always returns `passed: true`, and `tests/seo/audit-discover-eligibility.test.ts` pins that. Promoting a check to blocking is a deliberate, per-check decision to be taken once that check's numbers are clean — not a side effect of tightening the script.

**Where the enforcement actually lives.** The universal half is enforced at the source, which is where it belongs:
- `build-plugins/constants.ts:normalizeRobotsDirective()` upgrades any indexable directive to `ROBOTS_INDEX_ENHANCED_CONTENT` at the single emission point in `build-plugins/htmlTemplate.ts`, so all ~59 `buildSeoPageHtml` families are covered without touching their 88 call sites.
- `packages/articles/engine/shared/robotsDirective.ts` carries the same value on the confined side of the package boundary.
- `tests/seo/discover-robots-directive.test.ts` scans `build-plugins/**` and `packages/articles/engine/**` and fails, with `file:line`, on any hand-rolled indexable robots meta that omits `max-image-preview:large`.

**Playbook.**
1. `npm run audit:discover-eligibility` — the table is one row per page family with a pass rate per check.
2. A family at 0% on `maxImagePreviewLarge` means its plugin hand-rolls a `<head>` and bypassed the normaliser. `tests/seo/discover-robots-directive.test.ts` will name the file and line.
3. A family at 0% on `largeImage` is usually correct-by-nature (data landings with no hero photograph). Treat it as a content decision, not a defect — and remember `max-image-preview:large` raises the CAP on preview size, it does not supply an image (that was the #5101 defect on article pages).

---

## 8. Information Gain per template cohort (floor 5 % median, inventory shrink-only)

**Why.** `audit-content-duplicates` catches only EXACT body collisions, and a
mail-merge family never collides: swap the place name and one figure and the
SHA-256 changes. Measured 2026-08-24 in production, `/tasse-frontalieri-comune/`
was green on content-duplicates while 29 of 30 sampled pages carried not one
sentence their siblings did not already have. This gate is the near-duplication
half.

**Where.**
- Local: `node scripts/audit-information-gain.mjs <dist>` (or `npm run audit:information-gain`)
- CI: registered in `scripts/audit-all.mjs`, so it rides the single sampled
  `dist/` walk in `post-deploy-validate-dist.yml`
- Baseline: no file — the inventory `KNOWN_LOW_GAIN_COHORTS` lives in the script
  with the measured value and the date next to each line

**What fails the run.** A cohort outside the inventory whose MEDIAN gain drops
below 5 %, or an inventoried cohort that gets more than 1,5 points worse than
its recorded value. Both are rates, never counts, so a sampled run and a full
run are comparable. Recovery prints a "remove this line" notice and does not
fail.

**Not the issue's 40 % target.** #5002 asked for IGS > 40 % on key pages; no
family reaches it today, and a threshold nothing meets is a threshold that gets
lowered. The distance from 40 % is reported (`cohortsBelowIssueTarget40`), the
gate bites at 5 %.

Metric definition, the two masks, the measured per-family baseline and the
procedure to re-measure on a live sample: `docs/INFORMATION-GAIN.md`.
