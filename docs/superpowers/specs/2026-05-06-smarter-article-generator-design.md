# Smarter Article Generator — Design & Implementation Spec

**Date**: 2026-05-06
**Owner**: orchestrator session (Valerie)
**Status**: APPROVED for autonomous execution

## Problem

`scripts/create-article.mjs` (6003 LOC) picks topics from two sources today:
1. News RSS scan (~25 sources) — reactive, every IT news site covers the same headline → low differentiation.
2. Hardcoded `PRIORITY_EVERGREEN_TOPICS` list (~37 entries) — manually curated, doesn't auto-update.

We have ~1854 IT blog articles already. Bottleneck is no longer **quantity** but **picking topics that match real demand AND that historically convert** (clicks × CTR × AdSense RPM × scroll depth).

Two missing capabilities:
- **Feedback loop**: we don't know which articles actually performed at the net of newsletter-induced traffic.
- **External demand mining**: no Google Trends, no Reddit, no Facebook, no PAA. Semrush trial expired.

## Goal

Make the generator's topic-selection AND prompt **data-driven**:
- Phase 1 — **Internal feedback loop**: weekly snapshot of article performance, fingerprint of winners injected as prior into LLM prompt, losers flagged for refresh (out of scope of this spec).
- Phase 2 — **External demand mining**: weekly scrape/API pull from GSC orphan queries + Google Trends + Reddit + Facebook public pages → ranked candidate list that competes with the hardcoded evergreen pool.

Success metric: composite (clicks + impressions + adsense_revenue + conversions) per published article climbs over time. Re-evaluate after 6 weeks of data.

## Non-goals

- No vector DB / embedding store (Direzione 3 deferred).
- No SPA runtime change.
- No content rewrites of existing articles in this spec (loser-refresh is a follow-up).
- No paid APIs (PAA, Quora scraping deferred).
- No Facebook private group scraping. Public pages only via Graph API. Burner-account Playwright deferred.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ Job CI #1 — articles-performance-snapshot.yml (Mon 04:00 UTC)   │
│   scripts/fetch-article-performance.mjs                         │
│   Reads: GSC + GA4 (or PostHog) + AdSense                       │
│   Filters: utm_medium=newsletter (where applicable)             │
│   Output: data/article-performance.json                         │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ Job CI #2 — topic-candidates-mining.yml (Sun 22:00 UTC)         │
│   scripts/mine-topic-candidates.mjs                             │
│   Sources: GSC orphans + Google Trends (IT, IT-Lombardia, CH)   │
│            + Reddit JSON + Facebook Graph                       │
│   Output: data/topic-candidates.json                            │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│ scripts/create-article.mjs (existing, extended)                 │
│   - reads article-performance.json → prompt prior               │
│   - reads topic-candidates.json    → candidate pool             │
│   - selection: news → candidates → evergreen (weighted)         │
└─────────────────────────────────────────────────────────────────┘
```

**Resilience principle**: every external source must be wrapped in a `safe()` that returns `[]` on any failure (network, auth, parse). The workflow always succeeds (exit 0) and writes a partial JSON file. Bad inputs never block the generator.

---

## File schemas

### `data/article-performance.json`

```jsonc
{
  "generatedAt": "2026-05-06T04:00:00Z",
  "windowDays": 30,
  "articleCount": 1854,
  "articlesScored": 1500,                // articles with at least 1 metric
  "filters": {
    "newsletter": { "applied": true, "method": "utm_medium=newsletter" }
  },
  "sources": {
    "gsc":    { "ok": true,  "rows": 12000 },
    "ga4":    { "ok": false, "reason": "no GA4_PROPERTY_ID" },
    "posthog":{ "ok": true,  "rows": 4500 },
    "adsense":{ "ok": false, "reason": "no AdSense refresh token" }
  },
  "scoreFormula": "0.4*z(clicks) + 0.2*z(impressions) + 0.2*z(adsense_revenue||proxy) + 0.1*z(scroll_depth_p50) + 0.1*z(ctr)",
  "winners": [
    {
      "slugIt": "telelavoro-frontalieri-25-percento",
      "url": "https://frontaliereticino.ch/articoli-frontaliere/telelavoro-frontalieri-25-percento/",
      "score": 2.45,
      "metrics": { "clicks": 312, "impressions": 4800, "ctr": 0.065, "adsenseRevenue": 0.42, "scrollP50": 0.78 },
      "topic": "telelavoro",
      "cluster": "fiscale",
      "publishedAt": "2026-03-12"
    }
  ],
  "losers": [
    /* same shape, score < -1.0 */
  ],
  "winnerFingerprint": {
    "topClusters": [{ "cluster": "fiscale", "weight": 0.42 }, { "cluster": "pratico", "weight": 0.31 }],
    "topAngles": ["come funziona", "calcolo passo-passo", "confronto X vs Y", "quando conviene", "guida pratica"],
    "topKeywords": ["telelavoro", "permesso G", "tasse 2026", "LPP secondo pilastro", "cambio CHF EUR"],
    "averageWordCount": 1450,
    "topQuestionPatterns": ["quando", "quanto", "come", "cosa cambia"]
  }
}
```

### `data/topic-candidates.json`

```jsonc
{
  "generatedAt": "2026-05-06T22:00:00Z",
  "sources": {
    "gscOrphans":    { "ok": true,  "candidates": 42 },
    "googleTrendsIt":{ "ok": true,  "candidates": 18 },
    "googleTrendsItLombardia": { "ok": true, "candidates": 12 },
    "googleTrendsCh":{ "ok": true,  "candidates": 9 },
    "redditTicino":  { "ok": true,  "candidates": 7 },
    "redditItaly":   { "ok": true,  "candidates": 5 },
    "redditLugano":  { "ok": true,  "candidates": 3 },
    "redditSwitzerland": { "ok": true, "candidates": 4 },
    "facebookPages": { "ok": false, "reason": "no FB_PAGE_ACCESS_TOKEN" }
  },
  "candidates": [
    {
      "id": "fnv1a-stable-hash",
      "keyword": "frontalieri telelavoro 45 giorni 2026",
      "angle": "Nuova soglia 45 giorni telelavoro: chi può, come comunicarlo, esempio busta paga",
      "locale": "it",
      "sources": ["gscOrphans", "googleTrendsIt"],
      "demandSignals": {
        "gscImpressions": 240,
        "gscClicks": 4,
        "gscPosition": 18.4,
        "googleTrendsScore": 87,
        "redditMentions": 0,
        "facebookMentions": 0
      },
      "noveltyScore": 0.92,             // 1.0 = no existing article matches; 0 = strong dup
      "demandScore": 0.78,              // normalized 0–1 across all sources
      "totalScore": 0.85,                // 0.6 demand + 0.4 novelty
      "rationale": "GSC: 240 imps in last 30d at pos 18 → quick-win cluster"
    }
  ]
}
```

---

## Phase 1 — Article performance feedback (`scripts/fetch-article-performance.mjs`)

### Inputs (all optional via env, graceful)
- `FIREBASE_SERVICE_ACCOUNT_JSON` — already present; used for GSC + GA4 if same SA has perms.
- `GA4_PROPERTY_ID` — read existing usage in `scripts/seo-serp-autopilot.mjs`.
- `POSTHOG_PERSONAL_API_KEY` + `POSTHOG_PROJECT_ID` + `POSTHOG_HOST` — reuse `fetchPostHogCls()` pattern.
- `ADSENSE_*` — reuse `getAdSenseToken()` + `fetchAdSenseReport()` from `scripts/revenue-monitor.mjs`. Per-URL via URL channels (`blog-articles` channel from project memory).

### Logic
1. **Discover article URLs**: read `services/locales/blog-meta-it.ts` (and DE/EN/FR) → list of canonical URLs `/articoli-frontaliere/<slug>/` per locale.
2. **Pull last 30 days** from each available source for each URL:
   - **GSC**: `searchanalytics.query` with `dimensions=['page']` filter `page CONTAINS '/articoli-frontaliere/'`. Returns clicks/impressions/CTR/position. Naturally newsletter-free (organic only).
   - **GA4** (if configured): `runReport` with `dimensions=['pagePath']` + filter `sessionSource != 'newsletter'` AND `sessionMedium != 'newsletter'`. Metrics: `screenPageViews`, `engagementRate`, `averageSessionDuration`, `eventCount` (scroll).
   - **PostHog** (if configured): HogQL query — `$pageview` events filtering `properties.utm_medium != 'newsletter'`, group by `pathname`. Get pageviews + scroll depth (if instrumented).
   - **AdSense** (if configured): `accounts/<acct>/reports:generate?dimensions=URL_CHANNEL_NAME` for the `blog-articles` channel. Daily revenue → distributed per URL by pageview share.
3. **Score** each article with z-normalized composite (formula above). Articles with ≥1 metric eligible. Articles published <14 days ago: excluded (insufficient data).
4. **Cluster fingerprint**: top 20 winners → group by `cluster` (read from blog-meta `articleSection`), `tags`, common keywords (TF-IDF on titles), question patterns ("come/quando/quanto/perché"). Average word count from `body1+body2+body3`.
5. **Loser detection**: bottom 50 by score; only those with `impressions > 50` (so they HAD a chance and failed — the truly invisible ones aren't losers, they're just new/un-indexed).
6. Write `data/article-performance.json`.

### Workflow `articles-performance-snapshot.yml`
- Schedule: `0 4 * * 1` (Mon 04:00 UTC, before topic-candidates and before generator).
- Reuses `scripts/lib/git-push-with-retry.sh` rebase-retry pattern.
- Commits only `data/article-performance.json`.
- Timeout: 15 minutes.

### Tests
- Unit tests for scoring math (z-norm with mocked rows).
- Unit test for newsletter filter (mocked GA4 response with mixed sources).
- Unit test for fingerprint extraction.
- Snapshot test on output JSON shape.

---

## Phase 2 — Topic candidates mining (`scripts/mine-topic-candidates.mjs`)

### Source modules (each in `scripts/lib/topic-sources/`):

#### `gscOrphans.mjs`
- Reads `data/gsc-orphan-queries.json` (already in repo, refreshed by `sync-gsc-orphans.yml`).
- Filters: `impressions >= 20` AND `position BETWEEN 6 AND 30` (quick-win zone) AND not already covered by an existing article (BFS check against `services/locales/blog-meta-it.ts` titles).
- Output: candidates with `gscImpressions` and `gscClicks` in `demandSignals`.

#### `googleTrends.mjs`
- Library: `google-trends-api` (Node, free, ~50 req/IP/day before captcha). Add to package.json.
- Geos: `IT`, `IT-25` (Lombardia), `CH` — three pulls.
- Seed keywords: union of `winnerFingerprint.topKeywords` from Phase 1 output (if present) + a static fallback list (frontaliere, permesso G, tasse svizzera, LPP, telelavoro, ristorni, AVS, LAMal, CMI, IRPEF, busta paga svizzera).
- For each seed, fetch `relatedQueries` (rising) — these are the GOLD: things searched MORE recently than usual.
- Map response to candidates with `googleTrendsScore` (0-100).
- **Playwright fallback**: if `google-trends-api` returns 429 / error, retry via Playwright headless against `https://trends.google.com/trends/explore?q=<seed>&geo=<geo>` and parse the related-queries widget. Wrap in try/catch — never throw.

#### `reddit.mjs`
- Subreddits: `Ticino`, `italy` (search `frontalieri OR grenzgaenger`), `Lugano`, `Switzerland` (search `frontalieri OR cross-border`).
- Endpoint (no auth): `https://www.reddit.com/r/<sub>/new.json?limit=100` and `https://www.reddit.com/r/<sub>/search.json?q=<query>&sort=new&limit=50&restrict_sr=1`.
- User-Agent: `frontaliereticino-bot/1.0 (https://frontaliereticino.ch)` — required by Reddit ToS.
- Rate-limit: 60 req/min un-authed. Sleep 1s between calls. Total ~10 req/run.
- Filter: posts with `score >= 5` AND `num_comments >= 3` AND title is a question (ends in `?` OR matches `^(come|quando|quanto|perché|chi|cosa|dove|qualcuno sa|consigli|domanda)`).
- Extract `title` as candidate keyword. `num_comments + score` as demand proxy.
- **Playwright fallback**: if 429, switch to `https://old.reddit.com/r/<sub>/new` HTML scrape. Reddit blocks bot UA on `.json` sometimes; old.reddit usually works.

#### `facebookPages.mjs`
- **Public pages only** via Graph API.
- Hardcoded list: pages of public news outlets (Tio.ch, CdT, RSI, La Regione, Varesenews) — fetch via `https://graph.facebook.com/v19.0/<page_id>/posts?fields=message,created_time,reactions.summary(total_count),comments.summary(total_count)&access_token=<FB_PAGE_ACCESS_TOKEN>`.
- We need `pages_read_engagement` permission. If `FB_PAGE_ACCESS_TOKEN` only has `pages_manage_posts` (existing for posting), engagement read may fail → graceful skip.
- Filter posts mentioning `frontalier|frontaliere|grenzgänger|permesso G|svizzera-italia|tasse 2026` AND with `reactions+comments >= 20`.
- Extract candidate from post text (LLM-summarize to a short keyword if needed — but for v1 just use the first 80 chars of message as raw_text candidate).
- **No private group scraping in this phase.** Document burner-account approach in TODO.md for phase 2b consideration after 4 weeks.

#### `noveltyCheck.mjs`
- For every candidate, compute Jaccard similarity vs existing IT article titles (read `blog-meta-it.ts`).
- `noveltyScore = 1 - max(jaccard_similarities)`.
- Drop candidates with `noveltyScore < 0.3` (strong duplicate).

### Aggregation & ranking
1. Each source returns `Candidate[]`.
2. Merge by `keyword` (lower-cased, normalized) — multi-source candidates get `sources: ["gscOrphans", "googleTrends"]` and **boosted** demandScore.
3. Normalize each demand signal to 0-1:
   - `gsc`: `min(impressions / 500, 1)` 
   - `googleTrends`: `score / 100`
   - `reddit`: `min((score + comments*2) / 100, 1)`
   - `facebook`: `min(reactions / 100, 1)`
4. `demandScore = weighted avg(present signals)` with weights `gsc:0.4, trends:0.3, reddit:0.2, facebook:0.1`.
5. `totalScore = 0.6 * demandScore + 0.4 * noveltyScore`.
6. Sort by `totalScore` desc, keep top 100.

### Workflow `topic-candidates-mining.yml`
- Schedule: `0 22 * * 0` (Sun 22:00 UTC).
- Same rebase-retry commit pattern.
- Commits only `data/topic-candidates.json`.
- Timeout: 20 minutes (Playwright fallback may be slow).

### Tests
- Each source module: unit test with mocked fetch / file system.
- Aggregation logic: unit test with synthetic multi-source candidates.
- Novelty check: unit test with known dup pair.
- Snapshot test on output JSON shape.

---

## Phase 3 — Generator integration (`scripts/create-article.mjs`)

### New imports + reads (top of file, ~line 700 area)
```js
import { readFileSync, existsSync } from 'node:fs';

function loadJsonSafe(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    console.warn(`[generator] could not load ${path}: ${e.message}`);
    return null;
  }
}

const articlePerformance = loadJsonSafe('data/article-performance.json');
const topicCandidates    = loadJsonSafe('data/topic-candidates.json');
```

### Selection logic change

Currently the generator decides between news vs evergreen via Monday-bias. Replace with explicit ranked source pool:

```
priority order on each run:
  1. Fresh news (< 24h, score > NEWS_THRESHOLD)            — unchanged
  2. Top topic-candidate (score > 0.6) — NEW               — pick #1 unused
  3. Evergreen from PRIORITY_EVERGREEN_TOPICS              — unchanged
```

Mark candidates as "used" by appending their `id` to `data/topic-candidates-consumed.json` (a thin tracker, gitignored or committed — committed is fine, it's small). Generator never picks a consumed candidate twice.

If a candidate is structurally similar to an existing article (Jaccard > 0.7 against blog-meta titles), skip and try next — defense in depth on top of Phase 2 novelty check.

### Prompt enrichment

In every generation run (regardless of source), inject `winnerFingerprint` as a system message in the LLM prompt:

```
Per riferimento, gli articoli con più traffico organico storicamente:
- coprono questi cluster: ${topClusters.map(c => c.cluster).join(', ')}
- usano angoli concreti tipo: ${topAngles.join('; ')}
- includono parole chiave: ${topKeywords.join(', ')}
- hanno una lunghezza media di ~${averageWordCount} parole
- rispondono spesso a domande tipo: ${topQuestionPatterns.join(', ')}

Mantieni questi pattern QUANDO sono pertinenti al topic in input. Non
forzarli se il topic non li richiede.
```

If `articlePerformance` is null (file missing), skip injection — back to current behavior.

### Backward compatibility
- If both new files are missing, generator behaves exactly as today.
- All existing tests must still pass. Add new tests for selection-with-candidates path.

### Tests
- Selection with all three sources present: candidate beats evergreen.
- Selection with only evergreen: unchanged from today.
- Prompt injection: verify the system message is present when fingerprint exists, absent when missing.
- Consumed-tracker: same candidate is not picked twice.

---

## Phase 4 — Validation, merge, push

After all worktree branches land in an integration branch:
1. `npx tsc --noEmit` — must exit 0.
2. `FAST_BUILD= npx vite build` — must exit 0 (full SEO plugin run).
3. `npx vitest run` — all tests pass.
4. Run new audits if any: text-html-ratio, image-object-license, max-bfs-depth, title-length, title-no-disambig-hash. None should regress.
5. Squash-merge integration branch into `main` with descriptive commit message.
6. Push.

---

## Phase 5–7 — Live verification

After deploy:
1. `gh run watch` on deploy.yml — must finish green.
2. `curl -sI https://frontaliereticino.ch/` — 200 OK.
3. `curl -sI https://frontaliereticino.ch/articoli-frontaliere/` — 200 OK.
4. Spot-check sample article URL — 200 OK and HTML body has expected structure.
5. `gh workflow run articles-performance-snapshot.yml` → wait → verify `data/article-performance.json` exists in main with `generatedAt` recent.
6. `gh workflow run topic-candidates-mining.yml` → wait → verify `data/topic-candidates.json` exists in main with non-empty `candidates[]`.
7. `gh workflow run generate-article.yml` → wait for next cron OR trigger manually → check the generated article exists, the workflow log mentions reading the new files, and the article shape is correct.

---

## Phase 8 — Repo hygiene

- `git branch -a` — should show only `main` + remotes/origin/main + the worktree branches we created.
- All worktree branches: merge if useful, delete after.
- `git stash list` — should be empty.
- `git worktree list` — should be only the original repo path.

---

## Agent execution plan

### Worktree strategy
Each implementation phase gets its own worktree branch off `main`. Agents commit with `--no-verify` (skip pre-push tests/build) — ONLY the orchestrator runs full validation at the end.

### Branches
- `agent/1a-perf-fetcher` — Phase 1 (article-performance fetcher + workflow + tests)
- `agent/1b-topic-miner` — Phase 2 (topic-candidates miner + sub-modules + workflow + tests)
- `agent/2-generator-integration` — Phase 3 (create-article changes + tests). Depends on 1A schema (article-performance.json) and 1B schema (topic-candidates.json).

### Parallelism
- Phase 1A + Phase 1B in parallel (different files, only conflict point would be `package.json` for new deps — coordinate via documenting required deps in this spec, both add to their own commit, orchestrator resolves).
- Phase 2 depends on 1A + 1B → sequential after both land.
- Phase 3 (tests + final validation) can begin in parallel with Phase 2 (tests only need schema, not impl).

### Hand-off contract
Each agent output must include:
- Branch name pushed (or just committed in worktree if local-only).
- New/modified files list.
- Required env vars and graceful fallbacks documented in script comments.
- Test command that proves their part works in isolation.
- Any deps added to package.json (orchestrator merges).

### Forbidden
- No `--send` newsletter test (per CLAUDE.md NON-NEGOTIABLE rule #12).
- No baseline ratchet widening for any audit (rule #1).
- No `noindex` as a fix for orphan/depth issues (rule #5).
- No deleting code that looks unused without verifying (memory: "investigate before deleting").

---

## Required deps to add

- `google-trends-api` — Node Google Trends client (free).
- That's it. Reddit uses native fetch. Facebook uses native fetch. Playwright is already installed.

---

## Open follow-ups (NOT in scope of this spec)

- Loser refresh pipeline (rewrite under-performing articles).
- Burner-FB-account Playwright group scrape (after 4 weeks, if FB pages signal too thin).
- Quora/Telegram/forum scrape.
- Embedding-store winner-similarity ranker (Direzione 3).
- Newsletter A/B on candidate-sourced articles vs evergreen.

---

## Known limitations after the first CI run (2026-05-06 21:00 UTC)

Documented at orchestration end after running both workflows on real GH Actions IPs
with whatever secrets were actually configured.

### Quality / signal bugs

1. **Winner `cluster` is `null` for every article** → fingerprint topClusters
   collapses to `[{cluster:"unknown", weight:1.0}]`, removing the cluster prior.
   Root cause: `scripts/lib/perf-sources/articleDiscovery.mjs` doesn't read
   `articleSection` from `services/seo/seo-blog-*.ts` per slug — it only parses
   blog-meta titles. Fix: add a second parse pass that maps slug → articleSection
   from the seo-blog files (already discovered, just not joined with winner data).
   Impact: medium — fingerprint loses cluster guidance but still has angles +
   keywords + question patterns + averageWordCount.

2. **Top-keywords are news-y rather than evergreen frontalieri terms**
   (`angeli`, `grandine`, `pastori`, `posata`, `mutuo`, `pastori`, `contatto`,
   `dichiarazione`, `onore`). Root cause: TF-IDF runs over ALL article titles,
   so news-of-the-day articles that briefly ranked dominate. Fix: weight by
   article age (recency-decay), and/or restrict TF-IDF input to the top-20
   winners only (already do this for fingerprint compute, but the IDF normalizer
   uses the full corpus — re-check).

3. **Reddit returns 403 for every subreddit on the GitHub Actions IP range.**
   The Playwright fallback exists but hasn't engaged for 403 (only for 429).
   Fix: extend the fallback trigger to include 403, AND consider rotating
   User-Agent header to a recent Chrome on Linux instead of `frontaliereticino-bot`.
   Without Reddit, candidate quality drops noticeably (Reddit was the highest
   per-source candidate count locally: 23/1/9 IT/Lugano/Switzerland).

### Secrets to add (graceful skip today, signal will lift when added)

The fetcher / miner gracefully skip these. Adding them via `gh secret set …` 
turns each on:

- `GA4_PROPERTY_ID` — turns on GA4 metrics (pageviews, engagement, scroll depth).
- `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID` (`POSTHOG_HOST` defaults to
  `https://eu.posthog.com`) — adds PostHog event-based metrics.
- `ADSENSE_REFRESH_TOKEN` (+ `ADSENSE_CLIENT_ID`, `ADSENSE_CLIENT_SECRET`) —
  enables per-channel revenue distribution per article. See
  `scripts/revenue-monitor.mjs:122` for the OAuth setup.
- `FB_PAGE_ACCESS_TOKEN` for `pages_read_engagement` permission — enables
  Facebook public-page mining (already used for `post-to-facebook.mjs`, may
  need a permission scope upgrade).

### Verified working in CI

- ✅ GSC pulled 1390 rows with the existing `FIREBASE_SERVICE_ACCOUNT_JSON`
  (the same SA also has Search Console permissions).
- ✅ 540 articles scored, 20 winners + 50 losers identified.
- ✅ Google Trends Italy-Lombardia + Switzerland each returned 18 candidates.
- ✅ GSC orphan queries contributed 2 candidates.
- ✅ Both workflows committed their artifacts (`data/article-performance.json`
  + `data/topic-candidates.json`) via `git-push-with-retry.sh` rebase pattern.
- ✅ `create-article.mjs` integration is wired but a generate-article CI run
  must observe the candidate path being exercised (news takes priority and
  is plentiful — Phase 1.5 exercise may need a slow-news day to fire).
