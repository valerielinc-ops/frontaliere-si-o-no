# Bing URL Submission Quota — Investigation (2026-04-06)

> Root-cause analysis of `DailyQuota=0` on Bing Webmaster URL Submission API
> and the broader Bing SEO recovery context. Follow-up to
> [seo-canonical-bing-migration.md](./seo-canonical-bing-migration.md).

## TL;DR

Bing's URL Submission API daily quota is exhausted because `scripts/submit-indexnow.js`
calls it **on every single deploy** with a 20-URL "recent news fallback" payload
(the last 5 news articles expanded across 4 locale hreflang alternates). With
60–70 deploys per day from the job crawler and article-generation pipelines,
the very first deploy of the day exhausts the default daily quota (typically
~10 URLs for a newly-verified site) and every subsequent deploy sees
`DailyQuota=0` and is silently skipped by the guard added in a recent PR.

Traffic loss on Bing (-80% WoW clicks) has a separate, already-documented
cause: the www→non-www canonical migration left Bing with stale www-registered
sitemaps for weeks. That part has been remediated (sitemap resubmitted for
the canonical domain, `Status: Success`, `LastCrawled` just today). Recovery
is proceeding — Bing has already crawled ~2,000+ pages into the index and
daily crawl rate is back to ~100 pages/day. **The quota issue is a
submission-pipeline bug, not the cause of the traffic crash.**

## Current state (as of 2026-04-06T09:10Z)

### `bing_url_submission_quota`

```json
{
  "DailyQuota": 0,
  "MonthlyQuota": 2400
}
```

The `MonthlyQuota: 2400` is Bing's standard allotment for verified sites (no
special grant). `DailyQuota: 0` means the daily budget is spent.

### `bing_sites_health`

```
status: critical
clicks: 5 (prev 26, -80.8%)
impressions: 80 (prev 425, -81.2%)
sitemaps.total: 0 (STALE — contradicted by bing_sitemaps_list below)
issues: [
  "Critical traffic drop: clicks down 80.8% week-over-week",
  "No sitemaps submitted to Bing"  // false positive, see below
]
```

The "No sitemaps submitted" entry is a **stale signal** from the health
endpoint and does not match `bing_sitemaps_list`. See the note on sitemap
registration below.

### `bing_sitemaps_list`

```json
[
  {
    "Url": "https://frontaliereticino.ch/sitemap.xml",
    "Type": "Sitemap Index",
    "Status": "Success",
    "Submitted": "2026-04-06T...",  // just resubmitted
    "LastCrawled": "2026-04-06T...", // crawled same day
    "FileSize": 1495,
    "UrlCount": 6
  }
]
```

Only the **canonical** (non-www) sitemap index is registered and it has
been successfully crawled. The recovery action from the canonical-migration
playbook worked. The `sites_health` "0 sitemaps" is an internal caching
lag and should be ignored.

### `bing_crawl_stats` (trend)

| Date window | CrawledPages/day | InIndex |
|---|---|---|
| 2026-02-18 → 02-24 | 1–4 | 0 |
| 2026-02-25 → 03-03 | 8–48 | 1–15 |
| 2026-03-04 → 03-10 | 100–1,500 | 80–1,700 |
| 2026-03-11 → 03-17 | 50–250 | 1,700–1,900 |
| 2026-03-18 → 03-24 | 50–150 | 1,950–2,039 |

Bing has indexed **~2,039 pages** as of the latest sample and the daily crawl
rate has stabilized around 50–150 pages/day. This is healthy — recovery is in
progress.

### `bing_crawl_issues` / `bing_sitemaps_list` transient errors

During investigation, `bing_crawl_issues` and `bing_sitemaps_list` returned
`503 Bing Webmaster services could not be reached` on first call. This is a
**Bing-side outage**, not a config issue. A retry on the same session
succeeded. Flag this as operational noise — do not chase it.

## Root cause of `DailyQuota=0`

### Deploy volume vs quota arithmetic

- **Deploys per day**: ~60–70 (measured from `gh run list --workflow=deploy.yml`
  on 2026-04-05: 70 runs; 2026-04-06 by 09:10Z: already 27 runs)
- **Per-deploy Bing URL Submission API call**: yes, every deploy that includes
  the "Submit to IndexNow (Bing, Yandex)" step triggers `submit-indexnow.js`,
  which in turn calls `submitToBingApi()`.
- **URLs submitted per call**: the script uses `getBingUrlsSubset()`, which
  falls back to `recent-news-fallback` because the deploy step does not pass
  an `ARTICLE_URL` env var. This returns the **last 5 news articles** and
  expands each one's sitemap `<url>` block to include all hreflang alternates
  (IT + EN + DE + FR = 4 URLs per article). Final payload: **~20 URLs per
  deploy**.
- **Bing default daily quota** for non-premium sites: ~10 URLs (confirmed by
  the quota response and matched by behavior — one deploy exhausts it).

**Math**: 20 URLs submitted × 1 deploy > 10 URL daily cap → quota exhausted on
the first deploy of the day. All subsequent deploys correctly see
`DailyQuota=0` and skip the call thanks to the guard on
`scripts/submit-indexnow.js:313-316`. But the first deploy still wastes quota
re-submitting the same 5 news articles that Bing already indexed.

### Evidence from workflow logs

Successful Bing submission at 00:04Z (first deploy after midnight UTC reset):

```
📨 Bing Webmaster API: invio subset (recent-news-fallback) — 20 URL
✅ Bing Webmaster API: 20 URLs submitted
```

All subsequent deploys (e.g., 03:54Z, 07:20Z, 08:26Z) report:

```
⚠️  Bing Webmaster API: quota giornaliera esaurita (DailyQuota=0) — skip
```

This pattern has been stable for weeks — every day the first post-midnight
deploy consumes the quota for news URLs that Bing already has, while actually
useful signals (new job pages, new articles) never get submitted through this
channel because the quota is already spent.

## Why this matters (and why it does NOT explain the traffic crash)

The traffic crash (-80% WoW) is explained by the www→non-www canonical
migration that left Bing with a stale `www.frontaliereticino.ch/sitemap.xml`
for weeks. This has already been fixed (sitemap resubmitted, crawled,
`InIndex` climbing). The quota issue is a **separate** pipeline bug — it
wastes a small signal channel on duplicate content, but Bing is still
crawling from the sitemap (~100 pages/day) and that is what drives the
bulk of indexation.

Fixing the quota issue makes the URL Submission API useful again (it will
push *actual new URLs* — new articles + new jobs — into Bing's priority
crawl queue), but on its own it is not expected to move the traffic needle
dramatically. The primary recovery lever remains: wait for Bing to re-crawl
the non-www sitemap and promote the non-www canonical URLs.

## Remediation

### Safe to apply now (bundled in this PR)

1. **Pass `ARTICLE_URL` env to the IndexNow step in `deploy.yml`.** When a
   workflow-dispatch deploy carries `github.event.inputs.article_url`, forward
   it so `submit-indexnow.js` knows which URL is truly new.
2. **Disable `recent-news-fallback` by default.** Change
   `BING_RECENT_NEWS_FALLBACK` to default to `0` so that when no `ARTICLE_URL`
   is passed, the script skips the Bing URL Submission API entirely. The
   IndexNow endpoints (`api.indexnow.org`, `www.bing.com/indexnow`,
   `yandex.com/indexnow`) are unaffected — they remain quota-free and keep
   receiving the full sitemap-diff list.
3. **Keep the existing `DailyQuota=0` guard in place** — it's the correct
   second line of defense.

Net effect:
- Article-generation deploys (which DO pass `ARTICLE_URL`) will submit the
  single new article's hreflang alternates (~4 URLs) to Bing URL Submission
  API — well within the daily quota.
- Non-article deploys (job crawler, hot fixes, routine rebuilds) will NOT
  call Bing URL Submission API at all. Quota stays available for the next
  article.

### Requires human approval

None. The changes above are pure safety improvements and do not alter the
set of URLs that get crawled — they only stop us from spending Bing quota on
already-indexed news articles. The IndexNow fan-out (which is the primary
quota-free submission path) is untouched.

### Monitoring after merge

1. Run `bing_url_submission_quota` in 24h — expect `DailyQuota` to return to
   its normal daily allotment (~10).
2. Watch the next article-generation deploy logs for the Bing block:
   ```
   📨 Bing Webmaster API: invio subset (new-article) — 4 URL
   ✅ Bing Webmaster API: 4 URLs submitted
   ```
3. Run `bing_crawl_stats` weekly and track `InIndex` growth. Target: ≥ 2,500
   within 14 days (+25% from current 2,039).
4. Run `bing_sites_health` weekly. The "critical" status should flip to
   "healthy" once WoW clicks recover; expected 14–28 days after the canonical
   sitemap resubmit (2026-04-20 → 2026-05-04 window).

## Non-issues discovered during investigation

- **`scripts/submit-indexnow-batch.yml`**: never-run catch-up workflow for
  one-shot full sitemap pushes. Harmless; leave as-is.
- **Bing Content Submission API calls** (llms-full.txt, llms.txt): these run
  on every deploy but are not quota-bound and are correctly scoped. No action.
- **`sites_health` reporting "0 sitemaps"**: stale cache. Real state confirmed
  via `bing_sitemaps_list`. No action.
