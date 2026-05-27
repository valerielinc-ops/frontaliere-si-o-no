# Traffic-Quality Algorithm Design

**Date:** 2026-05-07
**Status:** Approved (brainstorming complete, ready for implementation)
**Author:** Claude Opus 4.7 (orchestrator session)
**Driver decisions:** D1-D6 confirmed by user (see § Decisions log)

---

## 1. Goal & non-goals

### Goal

Replace the current TF-IDF demand-vocabulary scorer with an evidence-grounded traffic-quality optimizer for `scripts/create-article.mjs`. The optimizer:

1. Selects article topics that maximize predicted GA4 sessions (traffic) at 14-day horizon.
2. Maintains a controlled discovery channel for topics not yet measured by GSC.
3. Auto-tunes the proven/discovery slot mix based on observed winner rates.
4. Surfaces quality regressions via a daily alerting workflow.

### Non-goals (explicitly excluded from this spec)

- Theme-coherence enforcement at selection time. Per user: "la coerenza con il tema frontaliere è il meno". A hockey article that drives traffic is acceptable; theme is no longer a hard constraint.
- Newsletter conversion as winner signal. Currently traffic-only (GA4 sessions). PostHog is ingested as metadata for future-evolution but does not enter the winner definition or scoring.
- Google Trends as a discovery source (deferred to v2 — no stable free API).
- Per-article canary alerts (deferred — generates ~30 alerts/day, noisy).
- Replacement of fact-check / thin-content / structured-data gates at generation time. Those keep working unchanged.

---

## 2. Decisions log (anchors for implementation)

| ID | Question | Decision | Reason |
|----|----------|----------|--------|
| D1 | Most expensive failure mode | "Optimize traffic + content quality. Theme coherence is least important." | User direct quote |
| D2 | Signal sources | GSC + GA4 + PostHog + discovery channel | User: "GSC, GA4, PostHog e in più una apertura alla discovery" |
| D3 | Candidate→evidence bridging | Cascaded: GSC keyword bridge primary → embedding similarity backup → cluster aggregate tiebreaker | User chose D |
| D4 | Discovery quota sizing | Adaptive — auto-tunes via 14-day winner hit-rate, bounded `[60, 95]% proven` | User chose D |
| D5 | Winner definition | Traffic-only: `sessions > p50_cluster` at 14-day horizon | User chose A |
| D6 | Pool composition | Two pools, separate scoring, slot assignment via quota | User chose A |
| Alert | Alert delivery channel | GitHub Actions workflow exit-1 (workflow failure → native GitHub email). NO Linear, NO Slack. | User direct correction |

---

## 3. Architecture overview

```
┌───────────────────────────────────────────────────────────────┐
│  EVIDENCE LAYER (daily ETL, read-only at decision time)       │
│  - GSC api  ──┐                                                │
│  - GA4 api  ──┼──► data/evidence-index.json (committed)       │
│  - PostHog ──┘                                                 │
│  - article-embeddings.bin (binary, committed via LFS-free     │
│    binary commit since <30MB)                                 │
│  - per-cluster percentiles (p10/p50/p90)                      │
└──────────────────────────┬────────────────────────────────────┘
                           │ (read at every slot)
                           ▼
┌───────────────────────────────────────────────────────────────┐
│  CANDIDATE LAYER                                               │
│                                                                │
│  PROVEN POOL                       DISCOVERY POOL              │
│  - existing news crawlers          - GSC orphan queries        │
│  - cascaded scoring:               - Google Suggest            │
│      step 1: term extraction       - Google News RSS           │
│      step 2: GSC keyword (×1.0)    - (Google Trends deferred)  │
│      step 3: embedding-sim (×0.8)  - per-source scoring        │
│      step 4: cluster median (×0.3) - confidence multipliers    │
└──────────────────────────┬────────────────────────────────────┘
                           │
                           ▼
┌───────────────────────────────────────────────────────────────┐
│  DECISION LAYER (per slot, every 15 min)                      │
│  1. quotaController reads data/quota-state.json               │
│  2. slotKind = (counter % 100) < quota ? proven : discovery   │
│  3. ranker picks top-1 from assigned pool (incl. dedup,       │
│     cluster diversity within pool)                            │
│  4. cross-pool fallback if assigned pool is empty             │
│  5. evergreen-fallback last resort (existing behavior)        │
└──────────────────────────┬────────────────────────────────────┘
                           │
                           ▼
            existing pipeline (fact-check, thin-content,
            sanitization, image, structured data, commit)
                           │
                           ▼
                       PUBLISHED with meta._pool tag
                           │
                           ▼
┌───────────────────────────────────────────────────────────────┐
│  FEEDBACK LOOP (daily, 14-day delay)                          │
│  - tune-discovery-quota.mjs reads data/evidence-index.json    │
│  - finds articles published 14-30d ago, grouped by _pool      │
│  - computes provenWinRate, discoveryWinRate                   │
│  - mutates data/quota-state.json within bounds [60, 95]       │
│  - appends decision to data/quota-history.jsonl               │
└──────────────────────────┬────────────────────────────────────┘
                           │
                           ▼
┌───────────────────────────────────────────────────────────────┐
│  QUALITY ALERTS (daily, 05:00 UTC)                            │
│  - quality-alerts.mjs runs ~20 detection rules                │
│  - exit 1 on P0/P1 → workflow fails → GitHub native email     │
│  - job summary as `$GITHUB_STEP_SUMMARY`                      │
│  - auto-snooze repeat alerts to prevent fatigue               │
│  - data/alert-snoozes.json (committed, auditable via git log) │
└───────────────────────────────────────────────────────────────┘
```

---

## 4. Phase 1 — Evidence layer (foundation)

**Branch suggestion:** `feat/evidence-layer`
**Owner:** Agent 1
**Deliverable:** evidence-index.json builds successfully on demand and via daily cron, contains valid GSC + GA4 + PostHog + clusterStats data. Embedding store builds incrementally.
**Dependencies:** none.
**Estimated LOC:** ~600 new + ~50 modified.

### 4.1 New files

```
scripts/build-evidence-index.mjs            (main ETL entrypoint, ~250 LOC)
scripts/build-article-embeddings.mjs        (incremental embedding builder, ~150 LOC)
scripts/lib/evidence/gscFetcher.mjs         (~80 LOC)
scripts/lib/evidence/ga4Fetcher.mjs         (~80 LOC)
scripts/lib/evidence/posthogFetcher.mjs     (~60 LOC)
scripts/lib/evidence/clusterStatsBuilder.mjs (~100 LOC)
.github/workflows/build-evidence-and-tune.yml (the daily orchestrator workflow,
                                                ~80 LOC YAML — adds tune step in Phase 4)
```

### 4.2 Data shape — `data/evidence-index.json`

```json
{
  "version": 1,
  "builtAt": "2026-05-08T04:00:00Z",
  "windowDays": 90,
  "gsc": {
    "queries": {
      "<lowercased query string>": {
        "imp": <number>,
        "clicks": <number>,
        "pos": <number, 1-100>,
        "ctr": <number, 0-1>,
        "topLandingPage": "<absolute path including leading slash>"
      }
    },
    "orphanQueries": [
      {
        "query": "<lowercased>",
        "imp": <number>,
        "clicks": <number>,
        "pos": <number>,
        "topLandingPage": "<path>"
      }
    ]
  },
  "ga4": {
    "pages": {
      "<page path>": {
        "sessions": <number>,
        "engageTime": <number, seconds>,
        "publishedAt": "<ISO8601>",
        "cluster": "<cluster name>"
      }
    }
  },
  "posthog": {
    "pages": {
      "<page path>": {
        "newsletterSignups": <number>
      }
    }
  },
  "clusterStats": {
    "<cluster name>": {
      "p10": <number>,
      "p50": <number>,
      "p90": <number>,
      "n": <number, count of articles ≥14d old in this cluster>
    }
  },
  "publishedArticleEmbeddings": "data/article-embeddings.bin"
}
```

**Path conventions:**
- All page paths use leading slash, no trailing slash, no host. Example: `/articoli-frontaliere/nuovo-accordo-frontalieri-2026/` is wrong; we use `/articoli-frontaliere/nuovo-accordo-frontalieri-2026` (no trailing slash for canonical match).
  - **WAIT — verify against existing canonical scheme.** CLAUDE.md says canonical URL is `https://frontaliereticino.ch/` and other places use trailing-slash. Implementation MUST match what GA4 and GSC actually report. Agent 1 must inspect a sample of GA4 pages and replicate the convention exactly. Document the choice in code comment.

**Window:** 90 days (configurable via `EVIDENCE_WINDOW_DAYS` env var, default 90).

**Orphan query criteria** (in code, configurable via constants):
```js
const ORPHAN_MIN_IMP = 100;
const ORPHAN_MIN_POS = 10;
const ORPHAN_MAX_CTR = 0.02;
```
Move to `scripts/lib/evidence/constants.mjs` for tunability.

### 4.3 GSC fetcher (`gscFetcher.mjs`)

**Auth**: reuse `FIREBASE_SERVICE_ACCOUNT_JSON` (memory: it doubles as GSC credentials, no separate secret needed).

**API**: Search Console API v1 — `searchanalytics.query` endpoint.

**Strategy**:
- Single request with `dimensions: ['query']`, `rowLimit: 25000`, range = last 90 days
- If response has more than 25000 rows, paginate via `startRow`
- Optional second pass with `dimensions: ['query', 'page']` to identify `topLandingPage` per query (top 1 by impressions)
- Persist all queries with `imp >= 5` (filter out one-shot noise)
- Identify orphan queries: separate filter pass (`imp >= ORPHAN_MIN_IMP AND pos >= ORPHAN_MIN_POS AND ctr <= ORPHAN_MAX_CTR`)

**Function signature**:
```js
/**
 * Fetch GSC search analytics aggregated per query.
 * @param {object} options
 * @param {string} options.siteUrl - 'https://frontaliereticino.ch/'
 * @param {string} options.startDate - ISO8601 date
 * @param {string} options.endDate - ISO8601 date
 * @param {object} options.auth - Google auth client
 * @param {number} options.rowLimit - default 25000
 * @returns {Promise<{queries: object, orphanQueries: array}>}
 */
export async function fetchGscQueries({ siteUrl, startDate, endDate, auth, rowLimit = 25000 }) {...}
```

**Failure handling**: catch all errors, return `{ queries: {}, orphanQueries: [], error: <error.message> }`. The main builder script logs the error and continues — it does not crash the ETL.

### 4.4 GA4 fetcher (`ga4Fetcher.mjs`)

**Auth**: reuse `FIREBASE_SERVICE_ACCOUNT_JSON`. The agent MUST verify (via a one-shot `runReport` smoke call before writing the fetcher) that this credential has GA4 Data API access on `GA4_PROPERTY_ID`. If access is denied, the fetcher must catch the 403, log a clear error message, and return `{ pages: {}, error: 'GA4 access denied — service account needs Viewer role on property' }`. The orchestrator handles missing-permissions as a Phase 1 blocker requiring user action; do not attempt to grant permissions.

**API**: GA4 Data API v1 beta — `runReport` endpoint.

**Dimensions**: `pagePath`, `firstUserDefaultChannelGroup` (for organic vs other split — optional, can defer)
**Metrics**: `sessions`, `userEngagementDuration`, `screenPageViews`

**Strategy**:
- 90-day window, dimension=`pagePath`, paginate by 100k rows max
- For each page path, attach `cluster` from `services/locales/blog-meta-it.ts` if available (lookup by slug → cluster)
- Compute `engageTime = userEngagementDuration / sessions` for per-session average
- Persist pages with `sessions >= 3` (filter near-zero noise)

**Function signature**:
```js
export async function fetchGa4Pages({ propertyId, startDate, endDate, auth }) {
  // returns { pages: object, error?: string }
}
```

### 4.5 PostHog fetcher (`posthogFetcher.mjs`)

**Auth**: `POSTHOG_PERSONAL_API_KEY`, `POSTHOG_PROJECT_ID`, `POSTHOG_HOST` (already in env per workflow logs).

**API**: PostHog Query API or Insights API. Need event `newsletter_signup` aggregated by `$current_url` or page path.

**Strategy**:
- 90-day window
- Query: total `newsletter_signup` events grouped by source page path
- Persist pages with `newsletterSignups >= 1`

**Failure handling**: total tolerance — if PostHog fails, the entire `posthog` block in evidence-index becomes `{}`. Winner-def is traffic-only, so this does not block selection.

**Function signature**:
```js
export async function fetchPosthogPages({ apiKey, projectId, host, startDate, endDate }) {...}
```

### 4.6 Cluster stats builder (`clusterStatsBuilder.mjs`)

**Input**: `ga4.pages` from the GA4 fetcher + cluster mapping from `services/locales/blog-meta-it.ts`.

**Logic**:
- Filter to articles with `publishedAt <= now - 14d` (rampedup, mediana stable)
- Group by cluster
- For each cluster: compute p10, p50, p90 of `sessions` using simple sorted-array indexing (no statistical libraries)
- Skip clusters with `n < 5` (insufficient sample); record n for transparency

**Function signature**:
```js
/**
 * @param {object} ga4Pages - keyed by path, includes sessions+publishedAt+cluster
 * @returns {object} clusterStats - keyed by cluster name
 */
export function buildClusterStats(ga4Pages) {...}
```

**Edge cases**:
- Article with `publishedAt = null` → skip (no way to know if it's ramped)
- Article with `cluster = null` → bucket as `generic`
- Cluster `'generic'` may have huge n → still compute, used for cluster fallback floor

### 4.7 Embedding builder (`build-article-embeddings.mjs`)

**Provider chain**: Mistral primary, Cohere fallback. Both already in Firebase Remote Config (`SERVER_MISTRAL_API_KEY`, `SERVER_COHERE_API_KEY`) — no new GitHub secrets to add.

- **Mistral** `mistral-embed` (1024 dim, EU-hosted, $0.10/1M tokens via Mistral La Plateforme)
- **Cohere** `embed-multilingual-v3.0` (1024 dim, free tier 100k req/month) — drop-in fallback (same dim)

For 2300 articles × ~512 tokens = 1.2M tokens, full refresh costs ~$0.12 on Mistral.

**File format**: `data/article-embeddings.bin`
- Header (32 bytes): magic `EMBV1` + count uint32 + dim uint32 + reserved
- Per-record (1024 × 4 bytes float32 + 32 bytes slug-hash): ~4KB per article
- For 5000 articles: ~20 MB — OK for git commit.

**Incremental strategy**:
- Read existing `article-embeddings.bin` if present, build set of slug-hashes
- Read all articles from `services/locales/blog-meta-it.ts`
- For each article whose hash is NOT in the existing set, compute embedding (batched 100/request)
- Write new combined file (atomic rename)

**Auth**: `embeddingClient.mjs` selects the first provider whose API key is in env. If neither key is present, the build script logs a warning and writes a meta-only sidecar so downstream tools know embeddings were skipped (cascadedScore falls through to cluster-median for unembedded articles).

**Function signature**:
```js
export async function buildIncrementalEmbeddings({ articlesMap, existingFile, outputFile }) {...}
```

**Sidecar JSON**: also produce `data/article-embeddings-meta.json` for human-debuggability:
```json
{
  "model": "mistral-embed",
  "dim": 1024,
  "count": 2300,
  "builtAt": "...",
  "perArticle": { "<slug>": { "hash": "...", "byteOffset": 32 } }
}
```

### 4.8 Main ETL (`build-evidence-index.mjs`)

**Sequence**:
1. Validate auth env vars present
2. Fetch GSC (90d) — capture errors, continue
3. Fetch GA4 (90d) — capture errors, continue
4. Fetch PostHog (90d) — capture errors, continue
5. Compute clusterStats from GA4 pages
6. Build incremental embeddings if `--embeddings` flag passed (default: skip on CI fast path)
7. Atomic write to `data/evidence-index.json` (write to .tmp then rename)
8. Log summary: `<query count>, <ga4 page count>, <posthog page count>, <cluster count>, <embedding count>`
9. Exit 0 on success, 1 only if **all three** fetchers fail (catastrophic data unavailable)

**Failure semantics**:
- 1 fetcher failed → log, set that block to `{}` in output, log warning, exit 0
- 2 fetchers failed → log, exit 0 still (degraded mode is acceptable)
- 3 fetchers failed → exit 1 (full data outage)

### 4.9 Workflow `build-evidence-and-tune.yml`

```yaml
name: Build evidence + tune quota
on:
  schedule:
    - cron: '0 4 * * *'  # daily 04:00 UTC
  workflow_dispatch:

jobs:
  build-evidence:
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - name: Prepare Firebase credentials
        run: echo '${{ secrets.FIREBASE_SERVICE_ACCOUNT_JSON }}' > /tmp/firebase-sa.json
        env:
          GOOGLE_APPLICATION_CREDENTIALS: /tmp/firebase-sa.json
      - name: Load secrets from Remote Config
        run: node scripts/load-rc-env.mjs
      - name: Build evidence index
        run: node scripts/build-evidence-index.mjs
        env:
          GA4_PROPERTY_ID: ${{ secrets.GA4_PROPERTY_ID }}
          POSTHOG_PERSONAL_API_KEY: ${{ secrets.POSTHOG_PERSONAL_API_KEY }}
          POSTHOG_PROJECT_ID: ${{ secrets.POSTHOG_PROJECT_ID }}
          POSTHOG_HOST: ${{ secrets.POSTHOG_HOST }}
      - name: Build article embeddings (incremental)
        run: node scripts/build-article-embeddings.mjs --incremental
      - name: Commit evidence
        run: |
          git config user.name "evidence-bot"
          git config user.email "evidence-bot@frontaliereticino.ch"
          git add data/evidence-index.json data/article-embeddings.bin data/article-embeddings-meta.json
          git diff --cached --quiet || git commit -m "chore(evidence): refresh $(date -u +%Y-%m-%d)"
          git push origin main
```

(The `tune-quota` job is added in Phase 4.)

### 4.10 Tests

```
tests/scripts/build-evidence-index.test.ts
tests/scripts/lib/evidence/gscFetcher.test.ts        (mock the API, verify request shape + parse)
tests/scripts/lib/evidence/ga4Fetcher.test.ts
tests/scripts/lib/evidence/posthogFetcher.test.ts
tests/scripts/lib/evidence/clusterStatsBuilder.test.ts
```

**Acceptance criteria for Phase 1**:
- [ ] `node scripts/build-evidence-index.mjs` runs locally with real credentials and produces a valid `data/evidence-index.json` with all 4 sections populated (or empty `{}` for failed fetchers)
- [ ] All 5 unit test files pass (`npx vitest run tests/scripts/build-evidence-index.test.ts tests/scripts/lib/evidence/`)
- [ ] Workflow `.github/workflows/build-evidence-and-tune.yml` runs successfully when triggered manually (`gh workflow run "Build evidence + tune quota" --ref <branch>`)
- [ ] Embedding build completes in <5 min for full rebuild, <30s for incremental
- [ ] Embedding store + meta JSON committed to repo (one-time large diff acknowledged)

---

## 5. Phase 2 — Cascaded scoring on proven pool

**Branch suggestion:** `feat/cascaded-scoring`
**Owner:** Agent 2
**Deliverable:** `cascadedScore()` function replaces TF-IDF demand-vocab scoring in the proven pool. Feature-flagged for gradual rollout.
**Dependencies:** Phase 1 (evidence index must exist).
**Estimated LOC:** ~400 new + ~150 modified.

### 5.1 New files

```
scripts/lib/scoring/cascadedScore.mjs          (~250 LOC, main scoring)
scripts/lib/scoring/termExtractor.mjs          (~100 LOC, n-gram extraction)
scripts/lib/scoring/embeddingMatcher.mjs       (~100 LOC, cosine sim against article-embeddings.bin)
scripts/lib/scoring/constants.mjs              (~30 LOC, all tunable thresholds)
```

### 5.2 Modified files

```
scripts/lib/article-topic-selector.mjs   (replace TF-IDF call with cascadedScore)
scripts/create-article.mjs                (drop demand-vocab loading, gate via env flag)
```

### 5.3 Term extraction (`termExtractor.mjs`)

**Input**: a headline string
**Output**: array of candidate terms (proper nouns, bigrams, trigrams, unigrams)

**Implementation**:
1. Lowercase, strip diacritics
2. Tokenize on whitespace + punctuation
3. Remove only short stopwords: `['il','la','i','le','un','una','di','da','del','della','dello','dei','delle','degli','a','al','alla','allo','ai','agli','alle','in','nel','nella','nello','nei','nelle','negli','con','su','sul','sulla','sullo','sui','sulle','sugli','per','tra','fra','e','o','che','non']` — articles + prepositions only. NO extended categories.
4. Build:
   - `unigrams[]`: tokens with length ≥3
   - `bigrams[]`: adjacent token pairs joined by space (length ≥6)
   - `trigrams[]`: 3-grams joined by space
   - `properNouns[]`: tokens that were originally capitalized (before lowercase); also proper noun pairs (2+ consecutive capitals)
5. Apply Italian stemmer (Snowball — `npm:wink-lemmatizer` or equivalent) to unigrams to get `stems[]`. Bigrams/trigrams left intact (multi-token stem is fragile)

**Function signature**:
```js
/**
 * @param {string} headline
 * @returns {{
 *   unigrams: string[], bigrams: string[], trigrams: string[],
 *   properNouns: string[], stems: string[]
 * }}
 */
export function extractTerms(headline) {...}
```

### 5.4 GSC keyword bridge (step 2 of cascade)

**Logic**:
1. Build a single sorted query list from `evidence.gsc.queries` keys
2. For each extracted term, attempt match strategies in order:
   - **Exact**: `term === query.toLowerCase()`
   - **Substring**: `query.includes(term)` (term is contained in any GSC query)
   - **Stem**: stem the GSC query, match if `stem(term) === stem(query)` for stems

3. For every matched query, compute `predictedSessions = (imp / 90) * ctr * posDecay`
   - `posDecay = max(0.1, (11 - pos) / 10)`
4. Take `max` across all matched queries for this headline → `gscScore`
5. Apply minimum signal threshold: if `max(gscScore) > 5/day`, return `gscScore × 14d = predictedSessionsForArticle`

**Output**: `{ stage: 'gsc', rawScore: <num>, confidence: 1.0, finalScore: rawScore }` or `null` if no signal.

### 5.5 Embedding similarity (step 3 of cascade)

**Logic**:
1. Compute embedding for headline (single API call via `embeddingClient.mjs`, currently routed to Mistral `mistral-embed`)
2. Read `article-embeddings.bin` into memory (cached across slot calls in same process)
3. Compute cosine similarity headline_emb vs each stored article emb
4. Take top 5 by cosine sim
5. If `cosine_top1 < 0.4`, return `null` (signal too weak)
6. Lookup `sessions` for top-5 from `ga4.pages` (via slug)
7. `predictedSessions = sum(top5.sessions * top5.cosine) / sum(top5.cosine)`
8. `finalScore = predictedSessions × cosine_top1` (quality-weighted)
9. Confidence multiplier: 0.8

**Output**: `{ stage: 'embedding', rawScore: <num>, confidence: 0.8, finalScore: rawScore × 0.8 }` or `null`.

**Performance**: 5k articles × 1536 dim = ~30M float ops per call. <50ms with simple loop, <10ms with SIMD. Acceptable.

### 5.6 Cluster fallback (step 4 of cascade)

**Logic**:
1. Run existing `classifyByRegex()` from `cluster-classifier-prompt.mjs`
2. Lookup `evidence.clusterStats[cluster].p50`
3. If `cluster === 'generic'`, use `clusterStats.generic.p50 / 2` as floor (penalize unclassifiable)
4. If `clusterStats[cluster]` is undefined (unknown cluster), use `clusterStats.global.p50 / 2`
5. Confidence multiplier: 0.3

**Output**: `{ stage: 'cluster', rawScore: <num>, confidence: 0.3, finalScore: rawScore × 0.3 }`

### 5.7 Cascade orchestration (`cascadedScore.mjs`)

```js
/**
 * @param {string} headline
 * @param {object} evidence - evidence-index.json contents
 * @returns {object} score breakdown { stage, rawScore, confidence, finalScore }
 */
export async function cascadedScore(headline, evidence) {
  const terms = extractTerms(headline);

  // Step 2 — GSC bridge
  const gsc = scoreFromGsc(terms, evidence.gsc);
  if (gsc && gsc.rawScore > 5) return { ...gsc, finalScore: gsc.rawScore * 14 };

  // Step 3 — embedding similarity (cosine ≥0.4 required)
  const emb = await scoreFromEmbedding(headline, evidence);
  if (emb) return emb;

  // Step 4 — cluster fallback
  const cluster = scoreFromCluster(headline, evidence.clusterStats);
  return cluster;
}
```

NB: `scoreFromEmbedding` is async because it calls the embedding API for the headline. Add a per-process LRU cache for embedded headlines (size 200) to avoid re-embedding the same headline across multiple slots.

### 5.8 Integration into `article-topic-selector.mjs`

The existing ranker has a function `rankAndSelectHeadlines` with signature:
```js
function rankAndSelectHeadlines(headlines, opts) {
  // current TF-IDF scoring per headline
  // returns top picks
}
```

Replace the inner per-headline scoring with `await cascadedScore(headline, evidence)`. The diversity bonus, cluster cap, MIN_DEMAND_SCORE floor logic must be reviewed:

- **MIN_DEMAND_SCORE**: DROP. The confidence multiplier replaces the floor. A confidence-0.3 cluster-fallback score effectively capped at `~clusterStats.generic.p50 × 0.5 × 0.3 ≈ 50 sessions`. That's the new effective floor.
- **Cluster diversity malus**: KEEP. Operate on `picksByCluster` over the last 25 publications.
- **Cluster max cap**: KEEP at 25 hard cap per current code.
- **Novelty bonus**: REMOVE. Replaced by the GSC-based prediction (GSC already accounts for click volume regardless of novelty).

### 5.9 Feature flag

Env var `USE_CASCADED_SCORING`:
- `1` (or unset): use new cascaded scoring (default after merge)
- `0`: use legacy TF-IDF demand-vocab path

Both code paths coexist for ONE phase to enable backtest-driven A/B. After Phase 2 successful validation, the legacy path is dropped in Phase 3 (DROP).

### 5.10 Backtest harness

**Critical gate before merging Phase 2.**

`scripts/backtest-scoring.mjs`:
- Input: list of historical headlines (last 60 days). Source: parse the workflow logs of `Generate Blog Article` runs from the last 60 days via `gh run view --log` (we have plenty in `data/article-performance.json` already too — pick the cheaper source).
- For each historical headline, run `cascadedScore` against the *current* evidence index
- Sort headlines by new score; top-1 is the "would-have-picked" headline for that slot
- Compare with the actually-picked headline (slug visible in `data/blog-articles/`)
- For both, look up actual `sessions` from `ga4.pages`
- Output: comparison table — avg sessions of new-algo picks vs old-algo picks. New must be ≥10% better to merge.

Acceptance criterion: backtest report committed to `docs/backtests/2026-05-XX-cascaded.md` showing **`new ≥ old × 1.10`** in average sessions across the 60-day window.

If backtest fails, agent must report and STOP — do NOT merge a regression.

### 5.11 Tests

```
tests/scripts/lib/scoring/cascadedScore.test.ts
tests/scripts/lib/scoring/termExtractor.test.ts
tests/scripts/lib/scoring/embeddingMatcher.test.ts
tests/scripts/backtest-scoring.test.ts          (smoke test on small fixture)
```

Each test file ≥80% line coverage on its target module.

**Acceptance criteria for Phase 2**:
- [ ] All test files pass
- [ ] Backtest report shows new-algo ≥10% improvement
- [ ] Feature flag `USE_CASCADED_SCORING=0` still produces identical behavior to pre-merge (no regression)
- [ ] Live run of `create-article.mjs` with `USE_CASCADED_SCORING=1` and a real evidence index produces a top-1 pick with valid `_score_breakdown` field in meta

---

## 6. Phase 3 — Discovery pool

**Branch suggestion:** `feat/discovery-pool`
**Owner:** Agent 3
**Deliverable:** Discovery pool with 3 sources (orphan + suggest + news RSS), discovery-side scoring, integrated alongside proven pool with slot-based assignment.
**Dependencies:** Phase 1 (evidence index), Phase 2 (cascaded scoring patterns).
**Estimated LOC:** ~500 new + ~200 modified.

### 6.1 New files

```
scripts/lib/discovery/discoveryPool.mjs          (~200 LOC, orchestrates the 3 sources)
scripts/lib/discovery/sources/orphanQuerySource.mjs (~80 LOC)
scripts/lib/discovery/sources/googleSuggestSource.mjs (~80 LOC, wraps existing googleSuggest.mjs)
scripts/lib/discovery/sources/googleNewsRssSource.mjs (~80 LOC, wraps existing googleNewsRss.mjs)
scripts/lib/discovery/discoveryScore.mjs         (~100 LOC, source-specific scoring)
scripts/lib/scheduler/quotaController.mjs        (~150 LOC, slot assignment logic)
```

### 6.2 Modified files

```
scripts/create-article.mjs   (top-level: read quota state, call quotaController, dispatch to pool)
```

### 6.3 Discovery sources

#### 6.3.1 Orphan queries (`orphanQuerySource.mjs`)

**Input**: `evidence.gsc.orphanQueries`
**Output**: array of `{ headline: <query string>, url: <topLandingPage>, source: 'orphan', meta: { imp, pos, ctr } }`

Convert each orphan query into a synthetic headline candidate. The headline IS the query — when published, the article addresses that exact query. The `topLandingPage` informs which existing article was a near-miss (useful for cross-link).

#### 6.3.2 Google Suggest (`googleSuggestSource.mjs`)

Wrap existing `scripts/lib/topic-sources/googleSuggest.mjs`. Seed with cluster keywords from `evidence.clusterStats` (ranked by p50). Output candidate suggestions, dedup against `evidence.gsc.queries` keys (if a suggested query is already in GSC, it's NOT discovery — promote to proven pool input).

#### 6.3.3 Google News RSS (`googleNewsRssSource.mjs`)

Wrap existing `scripts/lib/topic-sources/googleNewsRss.mjs`. Each news article = candidate. Add `freshnessFactor = 1 + 0.3 * (1 - age_hours / 48)` (cap at 48h, after that no boost).

### 6.4 Discovery scoring (`discoveryScore.mjs`)

```js
/**
 * @param {object} candidate - { headline, source, meta }
 * @param {object} evidence
 * @returns {object} { rawScore, confidence, freshnessFactor, finalScore, source }
 */
export function discoveryScore(candidate, evidence) {
  switch (candidate.source) {
    case 'orphan': {
      const cluster = classify(candidate.headline);
      const clusterMultiplier = (evidence.clusterStats[cluster]?.p50 ?? 100) / 400;
      const rawScore = (candidate.meta.imp / 90) * clusterMultiplier;
      return { rawScore, confidence: 1.0, freshnessFactor: 1.0, finalScore: rawScore, source: 'orphan' };
    }
    case 'suggest': {
      const cluster = classify(candidate.headline);
      const rawScore = (evidence.clusterStats[cluster]?.p50 ?? 100) * 0.5;
      return { rawScore, confidence: 0.6, freshnessFactor: 1.0, finalScore: rawScore * 0.6, source: 'suggest' };
    }
    case 'news': {
      const cluster = classify(candidate.headline);
      const rawScore = (evidence.clusterStats[cluster]?.p50 ?? 100);
      const freshnessFactor = 1 + 0.3 * Math.max(0, 1 - candidate.meta.ageHours / 48);
      return { rawScore, confidence: 0.7, freshnessFactor, finalScore: rawScore * 0.7 * freshnessFactor, source: 'news' };
    }
  }
}
```

### 6.5 Cross-pool dedup

When discovery pool is assembled, every candidate's headline is checked against the proven pool's headline list. Slug-similarity ≥ 0.7 (Levenshtein-based or simple Jaccard on tokens) → drop from discovery.

Reverse direction (proven→discovery dedup) is NOT done; proven always wins.

### 6.6 Quota controller (`quotaController.mjs`)

```js
/**
 * Decides whether next slot is 'proven' or 'discovery'.
 * Uses a deterministic counter modulo 100 so behavior is reproducible.
 *
 * @param {object} state - read from data/quota-state.json
 * @returns {object} { slotKind: 'proven'|'discovery', counterValue, currentQuota }
 */
export function decideSlot(state) {
  const counter = (state.runCounter ?? 0) % 100;
  const slotKind = counter < state.currentQuota ? 'proven' : 'discovery';
  return { slotKind, counterValue: counter, currentQuota: state.currentQuota };
}

/**
 * Increments counter after a successful slot assignment, persists state.
 */
export function incrementCounter(state) {
  return { ...state, runCounter: (state.runCounter ?? 0) + 1 };
}
```

**Quota state file** `data/quota-state.json`:
```json
{
  "version": 1,
  "runCounter": 142,
  "currentQuota": 80,
  "lastTune": "2026-05-08T04:00:00Z",
  "history": []
}
```

### 6.7 Cross-pool fallback

If `slotKind === 'proven'` but proven pool yields nothing (post-dedup, post-cluster-cap), fall to discovery pool. If both empty, fall to evergreen (existing behavior). Log every fallback transition for observability.

### 6.8 Integration into `create-article.mjs`

Approximate structure (replace the existing pool selection logic):

```js
const quotaState = loadQuotaState();
const evidence = loadEvidenceIndex();
const { slotKind, counterValue, currentQuota } = decideSlot(quotaState);

let pickedCandidate = null;
let chosenPool = slotKind;

// Try assigned pool first
if (slotKind === 'proven') {
  const provenCandidates = await fetchProvenPool(evidence);
  pickedCandidate = await selectTopFromProvenPool(provenCandidates, evidence);
} else {
  const discoveryCandidates = await fetchDiscoveryPool(evidence);
  pickedCandidate = await selectTopFromDiscoveryPool(discoveryCandidates, evidence);
}

// Cross-pool fallback
if (!pickedCandidate) {
  chosenPool = (slotKind === 'proven') ? 'discovery' : 'proven';
  // ... fetch + select from the other pool
}

// Evergreen last resort (existing)
if (!pickedCandidate) {
  chosenPool = 'evergreen-fallback';
  // ... existing evergreen logic
}

// Tag picked candidate with provenance
pickedCandidate._pool = chosenPool;
pickedCandidate._pool_source = pickedCandidate.source ?? 'news-scan';
pickedCandidate._score_breakdown = pickedCandidate._scoreBreakdown;

// Increment counter and persist
saveQuotaState(incrementCounter(quotaState));
```

### 6.9 Tagging at meta-write time

When the article meta JSON is written (existing flow), inject:
```json
{
  "publishedAt": "...",
  "cluster": "...",
  "_pool": "proven",
  "_pool_source": "tio.ch",
  "_score_breakdown": { ... }
}
```

### 6.10 Tests

```
tests/scripts/lib/discovery/discoveryPool.test.ts
tests/scripts/lib/discovery/discoveryScore.test.ts
tests/scripts/lib/scheduler/quotaController.test.ts
tests/scripts/lib/discovery/sources/*.test.ts
```

**Acceptance criteria for Phase 3**:
- [ ] Discovery pool returns valid candidates from at least 2 of 3 sources in a real run
- [ ] Quota controller: 100 deterministic runs at quota=80 produce exactly 80 'proven' + 20 'discovery'
- [ ] Slug-similarity dedup catches 'frontaliere ticino' and 'frontalieri in ticino' as duplicates
- [ ] Cross-pool fallback transitions logged
- [ ] All tests pass

---

## 7. Phase 4 — Auto-tune feedback loop

**Branch suggestion:** `feat/quota-autotune`
**Owner:** Agent 4
**Deliverable:** Daily tune job that mutates `quota-state.json` based on observed 14-day winner rates.
**Dependencies:** Phase 1, Phase 3 (`_pool` tagging).
**Estimated LOC:** ~250 new + ~50 modified.

### 7.1 New files

```
scripts/tune-discovery-quota.mjs          (~200 LOC main entrypoint)
scripts/lib/scheduler/winnerEvaluator.mjs (~100 LOC)
data/quota-history.jsonl                  (append-only audit log; created on first run)
```

### 7.2 Modified files

```
.github/workflows/build-evidence-and-tune.yml  (add tune-quota job depending on build-evidence)
```

### 7.3 Winner evaluator

```js
/**
 * For each article published 14-30d ago, decide if it's a winner.
 *
 * @param {object} evidence
 * @returns {{ proven: { winners, total }, discovery: { winners, total }, perCluster: object }}
 */
export function evaluateWinners(evidence) {
  const articles = loadAllPublishedArticleMetas();  // reads blog-articles/*.json
  const now = Date.now();
  const minAgeMs = 14 * 24 * 3600 * 1000;
  const maxAgeMs = 30 * 24 * 3600 * 1000;

  const proven = { winners: 0, total: 0 };
  const discovery = { winners: 0, total: 0 };

  for (const article of articles) {
    const ageMs = now - new Date(article.publishedAt).getTime();
    if (ageMs < minAgeMs || ageMs > maxAgeMs) continue;

    const path = `/articoli-frontaliere/${article.slug}/`;
    const ga4 = evidence.ga4.pages[path];
    if (!ga4) continue;
    const cluster = article.cluster ?? 'generic';
    const p50 = evidence.clusterStats[cluster]?.p50 ?? 100;
    const isWinner = ga4.sessions > p50;

    const bucket = (article._pool === 'discovery') ? discovery : proven;
    bucket.total++;
    if (isWinner) bucket.winners++;
  }

  return { proven, discovery };
}
```

### 7.4 Tune logic

```js
function decideTune(state, winnerStats) {
  const { proven, discovery } = winnerStats;

  // Statistical sanity
  if (Math.min(proven.total, discovery.total) < 30) {
    return { decision: 'hold', reason: 'insufficient sample', newQuota: state.currentQuota };
  }

  const provenRate = proven.winners / proven.total;
  const discoveryRate = discovery.winners / discovery.total;
  const ratio = discoveryRate / Math.max(provenRate, 0.01);

  let newQuota = state.currentQuota;
  let decision = 'hold';

  if (ratio >= 1.2) {
    newQuota = Math.max(60, state.currentQuota - 5);
    decision = 'more discovery';
  } else if (ratio <= 0.7) {
    newQuota = Math.min(95, state.currentQuota + 5);
    decision = 'less discovery';
  }

  return { decision, reason: `ratio=${ratio.toFixed(2)}`, newQuota, provenRate, discoveryRate };
}
```

### 7.5 Workflow `build-evidence-and-tune.yml` (add second job)

```yaml
  tune-quota:
    needs: build-evidence
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: npm ci
      - run: node scripts/tune-discovery-quota.mjs
      - name: Commit tune state
        run: |
          git config user.name "tune-bot"
          git config user.email "tune-bot@frontaliereticino.ch"
          git add data/quota-state.json data/quota-history.jsonl
          git diff --cached --quiet || git commit -m "chore(tune): quota update $(date -u +%Y-%m-%d)"
          git push origin main
```

### 7.6 Tests

```
tests/scripts/tune-discovery-quota.test.ts
tests/scripts/lib/scheduler/winnerEvaluator.test.ts
```

Acceptance criteria for Phase 4:
- [ ] Tune job runs successfully when triggered manually
- [ ] Cold start: with no published-with-_pool articles, decides hold + logs warning
- [ ] Bounds enforced: quota cannot exceed 95 or fall below 60
- [ ] Statistical sanity check rejects samples < 30
- [ ] All tests pass

---

## 8. Phase 5 — Quality alerts

**Branch suggestion:** `feat/quality-alerts`
**Owner:** Agent 5
**Deliverable:** Daily quality-alerts workflow detecting algorithm health, data pipeline, output quality, and cost regressions. Failures surface via workflow exit-1 (GitHub native email).
**Dependencies:** Phase 1, Phase 3 (`_pool` field), Phase 4 (`quota-state.json`).
**Estimated LOC:** ~400 new.

### 8.1 New files

```
scripts/quality-alerts.mjs                 (~250 LOC main runner)
scripts/lib/alerts/detectors/algorithm.mjs (~80 LOC, A.1-A.5)
scripts/lib/alerts/detectors/pipeline.mjs  (~80 LOC, B.1-B.6)
scripts/lib/alerts/detectors/output.mjs    (~80 LOC, C.1-C.5)
scripts/lib/alerts/detectors/cost.mjs      (~50 LOC, D.1-D.4)
scripts/lib/alerts/snoozer.mjs             (~50 LOC, dedup + auto-snooze)
data/alert-config.json                     (committed; thresholds)
data/alert-snoozes.json                    (committed; snooze state)
data/quality-alerts-history.jsonl          (append-only history)
.github/workflows/quality-alerts.yml       (~30 LOC YAML)
```

### 8.2 Detection categories

(See Section 8 of brainstorming output for full table — 20 detection rules. Implementation follows the table.)

Each detector is a function returning `{ id, severity, message, mitigation, evidence }[]`. The main runner aggregates all results and decides the exit code.

### 8.3 Runner pseudocode

```js
async function main() {
  const evidence = loadEvidenceIndex();
  const quotaState = loadQuotaState();
  const config = loadAlertConfig();
  const snoozes = loadSnoozes();

  const allAlerts = [];
  allAlerts.push(...detectAlgorithm({evidence, quotaState, config}));
  allAlerts.push(...detectPipeline({evidence, config}));
  allAlerts.push(...detectOutput({evidence, config}));
  allAlerts.push(...detectCost({evidence, config}));

  // Apply auto-snooze
  const { activeAlerts, snoozedAlerts } = applySnoozer(allAlerts, snoozes, config);

  // Update snooze state (consecutive-day tracking)
  const newSnoozes = updateSnoozeState(snoozes, allAlerts, config);
  saveSnoozes(newSnoozes);

  // Append to history
  appendHistory(allAlerts);

  // Meta-alert
  const p0p1Count = activeAlerts.filter(a => a.severity === 'P0' || a.severity === 'P1').length;
  if (p0p1Count > config.meta_alert_count_threshold) {
    activeAlerts.push({
      id: 'meta',
      severity: 'P0',
      message: `${p0p1Count} alerts triggered simultaneously — system in distress`,
      mitigation: 'Pause article generation, run /investigate'
    });
  }

  // Write GitHub job summary
  writeJobSummary(activeAlerts, snoozedAlerts);

  // Exit code
  const hasP0OrP1 = activeAlerts.some(a => a.severity === 'P0' || a.severity === 'P1');
  process.exit(hasP0OrP1 ? 1 : 0);
}
```

### 8.4 Workflow

```yaml
name: Quality alerts
on:
  schedule:
    - cron: '0 5 * * *'  # 05:00 UTC, after evidence + tune
  workflow_dispatch:

jobs:
  detect:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: node scripts/quality-alerts.mjs
      - name: Commit alert state
        if: always()  # commit even on failure (history must be persisted)
        run: |
          git config user.name "alerts-bot"
          git config user.email "alerts-bot@frontaliereticino.ch"
          git add data/alert-snoozes.json data/quality-alerts-history.jsonl
          git diff --cached --quiet || git commit -m "chore(alerts): $(date -u +%Y-%m-%d)"
          git push origin main || true
```

### 8.5 Tests

```
tests/scripts/quality-alerts.test.ts
tests/scripts/lib/alerts/detectors/*.test.ts
tests/scripts/lib/alerts/snoozer.test.ts
```

Each detector module needs ≥80% line coverage.

Acceptance criteria for Phase 5:
- [ ] All 20 detection rules implemented and individually testable
- [ ] Auto-snooze logic prevents repeat alerts after 3 consecutive days
- [ ] Meta-alert triggers when 5+ P0/P1 detected
- [ ] Workflow exits 1 on P0/P1, 0 on P2/P3
- [ ] Job summary renders in GitHub UI
- [ ] All tests pass

---

## 9. Migration plan (REPLACE / DROP)

**KEEP** (no changes):
- News crawlers
- Fact-check consensus + thin-content gate + structured-data validation
- Cluster classifier
- Evergreen pool as last-resort fallback
- LinkedIn / newsletter / Indexing API hooks
- Image generation pipeline
- Existing `data/article-performance.json` (used by other workflows; we read it but don't replace it)

**REPLACE** (Phase 2-3):
- `scripts/lib/perf-sources/scoring.mjs` (TF-IDF) → `scripts/lib/scoring/cascadedScore.mjs`
- TF-IDF demand-vocab loading in `create-article.mjs` → cascadedScore call
- `MIN_DEMAND_SCORE` floor → confidence multipliers
- `RANKER_MAX_PER_CLUSTER=25` hardcoded → per-pool cluster diversity (25 still enforced)
- Hardcoded source-quality multiplier → emerges from auto-tune (data-driven)

**DROP** (after Phase 2 backtest validation):
- `scripts/lib/perf-sources/scoring.mjs::tfidfTopN`
- `data/demand-vocabulary.json` (gitignored)
- `scripts/refresh-demand-vocabulary.mjs` (if exists)
- demand-vocab tests in `tests/scripts/`
- `_shouldForceEvergreen` / `loadEvergreenCounter` / `persistEvergreenCounter` helpers if no longer referenced
  - **Caveat:** `loadEvergreenCounter` and `persistEvergreenCounter` are KEPT — they back the new `quota-state.json` (renamed concept, same persistence pattern)

---

## 10. Testing strategy

### 10.1 Unit
Vitest, ≥80% coverage per new module.

### 10.2 Integration
- `evidence-index-builder.test.ts`: mock GSC/GA4/PostHog responses, verify output shape
- `pool-selection.integration.test.ts`: end-to-end slot → pool → scoring → top-1 pick

### 10.3 Backtest (CRITICAL — Phase 2 gate)
`scripts/backtest-scoring.mjs`. Must show ≥10% improvement vs current algo on 60-day window of historical headlines.

### 10.4 Regression
All existing tests in `tests/scripts/article-topic-selector.test.ts` (33 tests) must continue to pass after refactor. Modify expectations only when behavior intentionally changed.

### 10.5 Live validation
After full merge:
- `gh workflow run "Build evidence + tune quota" --ref main` → verify exit 0, evidence-index commit appears
- `gh workflow run "Generate Blog Article" --ref main` → manually trigger 2 runs, inspect generated articles for topical coherence and quality
- `gh workflow run "Quality alerts" --ref main` → verify exit 0 (no P0/P1 detected on healthy system)

---

## 11. Observability / logging

Each significant decision logs a structured line (single line, JSON-friendly) to stderr:

```js
console.error(`SLOT_DECISION pool=proven counter=42 quota=80`);
console.error(`SCORE_BREAKDOWN headline="Frontalieri Ticino..." stage=gsc rawScore=60 confidence=1.0 finalScore=60`);
console.error(`POOL_FALLBACK from=proven to=discovery reason=empty`);
console.error(`EVIDENCE_LOAD path=data/evidence-index.json mtimeMin=42`);
```

These lines are grep-able from workflow logs, no external infra needed.

---

## 12. Cost analysis

### 12.1 API call costs

| Source | Daily cost (USD) | Notes |
|---|---|---|
| GSC API | $0 | Free quota: 1200 queries/day per site, we use ~5/day |
| GA4 Data API | $0 | Free quota: 200k tokens/day per project, we use ~50k/day |
| PostHog API | $0 | Self-hosted or free tier sufficient |
| Mistral embeddings | ~$0.001-$0.12 | $0.10/1M tokens via Mistral La Plateforme; 2.3k articles × 512 tokens = 1.2M tokens = ~$0.001 daily incremental, ~$0.12 full refresh weekly |
| **Total** | **~$0.001/day** | <$1/month |

### 12.2 GitHub Actions minutes

| Workflow | Frequency | Minutes/run | Daily total |
|---|---|---|---|
| build-evidence-and-tune.yml | 1×/day | ~5 min | 5 min |
| quality-alerts.yml | 1×/day | ~1 min | 1 min |
| **Total new** | | | **~6 min/day** = ~180 min/month |

Free tier: 2000 min/month for public repos → comfortable margin.

### 12.3 Storage

| Asset | Size | Notes |
|---|---|---|
| `data/evidence-index.json` | 5-15 MB | Daily diff small (~10% turnover) |
| `data/article-embeddings.bin` | ~30 MB | Refreshed incrementally; large diffs only on full rebuild |
| `data/quota-history.jsonl` | <1 MB/year | Append-only |
| `data/quality-alerts-history.jsonl` | <5 MB/year | Append-only |

Total ~45 MB additional repo bloat at steady state. Acceptable.

---

## 13. Rollback plan

### 13.1 Phase 2 rollback (if cascaded scoring shipped is degraded)

- Set env var `USE_CASCADED_SCORING=0` in workflow secrets → reverts to TF-IDF
- Workflow auto-picks up next run (15 min delay)
- Investigate via `data/quality-alerts-history.jsonl` and workflow logs
- Fix or revert PR

### 13.2 Phase 3 rollback (if discovery pool produces noise)

- Set env var `DISCOVERY_QUOTA_OVERRIDE=100` (forces quota to 100% proven) → discovery effectively disabled
- Or set per-source kill switches: `DISABLE_DISCOVERY_ORPHAN=1`, `DISABLE_DISCOVERY_SUGGEST=1`, etc.

### 13.3 Phase 4 rollback (auto-tune misbehaving)

- Disable workflow: `gh workflow disable "Build evidence + tune quota"`
- Manually edit `data/quota-state.json` to reset `currentQuota=80, runCounter=0`
- Commit + push

### 13.4 Phase 5 rollback (alerts noisy)

- Edit `data/alert-config.json` thresholds
- If alerts cascade-fail (e.g., evidence-index failed → all alerts trigger), `gh workflow disable "Quality alerts"` until fix

---

## 14. Acceptance criteria summary (per-phase gate)

### Phase 1 — Evidence layer
- [ ] `data/evidence-index.json` builds successfully with all 4 sections (or empty objects on fetcher failure)
- [ ] `data/article-embeddings.bin` builds in <5min full, <30s incremental
- [ ] Workflow `build-evidence-and-tune.yml` runs successfully via `workflow_dispatch`
- [ ] All Phase 1 unit tests pass

### Phase 2 — Cascaded scoring
- [ ] Backtest report shows ≥10% improvement
- [ ] All Phase 2 unit tests pass
- [ ] Feature flag verified: `USE_CASCADED_SCORING=0` produces same behavior as before merge
- [ ] Live `Generate Blog Article` run with flag=1 produces valid output

### Phase 3 — Discovery pool
- [ ] All 3 sources produce candidates
- [ ] Quota controller deterministic (100 runs = exactly proven:discovery split per quota)
- [ ] Cross-pool dedup catches paraphrased headlines
- [ ] All Phase 3 unit tests pass

### Phase 4 — Auto-tune
- [ ] Tune job runs and produces valid `quota-state.json`
- [ ] Cold start handled (insufficient sample → hold)
- [ ] Bounds enforced
- [ ] All Phase 4 unit tests pass

### Phase 5 — Quality alerts
- [ ] All 20 detection rules implemented and tested
- [ ] Auto-snooze logic verified
- [ ] Meta-alert triggers correctly
- [ ] Workflow exits 1 only on P0/P1
- [ ] All Phase 5 unit tests pass

### Final validation (orchestrator)
- [ ] All branches merged to main, no leftover feature branches
- [ ] No leftover stashes
- [ ] Full local build passes (`FAST_BUILD= npx vite build`)
- [ ] All tests pass (`npx vitest run`)
- [ ] Pre-push hook passes
- [ ] Deploy workflow succeeds on main
- [ ] Live curl `https://frontaliereticino.ch/` returns 200
- [ ] Manual trigger of `Generate Blog Article` produces 2 articles with valid `_pool`, `_score_breakdown`, and on-topic content
- [ ] Manual trigger of `Build evidence + tune quota` produces evidence index with all sections
- [ ] Manual trigger of `Quality alerts` exits 0 (no P0/P1 on healthy system)

---

## 15. Out-of-scope (future work)

- Google Trends source (no stable free API)
- PostHog event-based winner definition (currently traffic-only)
- Per-article canary alerts (deferred — too noisy)
- Embedding model upgrade to a higher-dim provider (Mistral `mistral-embed-large`, Cohere `embed-multilingual-v4.0`) — only if current 1024-dim Mistral chain proves insufficient on cosine quality
- Multi-language (DE/FR/EN) winner tracking (current scope: IT articles only)
- A/B testing framework for cluster scoring weights (after Phase 2 stabilizes)
