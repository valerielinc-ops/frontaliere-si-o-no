# SEO — Canonical Domain Migration & Bing Recovery

> Documentation of the www→non-www canonical migration and the Bing index recovery actions
> Last updated: 2026-04-06

## Canonical domain

**Authoritative**: `https://frontaliereticino.ch/` (no `www`, no trailing slash except root)

All references in source code, sitemaps, hreflang, JSON-LD, workflow scripts, and Bing/Google webmaster tools MUST use this form. Enforced in CLAUDE.md.

## DNS / GitHub Pages configuration

### Current state (verified working)

- **CNAME file**: `public/CNAME` → `frontaliereticino.ch` (apex, non-www)
- **GitHub Pages**: serves from apex domain; `Enforce HTTPS` enabled
- **Apex DNS**: A records pointing to GitHub Pages IPs (185.199.108-111.153)
- **www CNAME**: `www.frontaliereticino.ch` → `<owner>.github.io` (or apex)
- **Redirect chain** (verified 2026-04-06):
  - `https://www.frontaliereticino.ch/<path>` → **301** → `https://frontaliereticino.ch/<path>` (path preserved)
  - `https://frontaliereticino.ch/<path>` → **200**

### Verification commands

```bash
curl -sI https://www.frontaliereticino.ch/                  # Expect 301 → frontaliereticino.ch/
curl -sI https://www.frontaliereticino.ch/sitemap.xml       # Expect 301 → frontaliereticino.ch/sitemap.xml
curl -sI https://frontaliereticino.ch/                      # Expect 200
curl -sI https://frontaliereticino.ch/sitemap.xml           # Expect 200
```

### Why this matters

GitHub Pages handles the www→non-www redirect at the edge (Fastly/Varnish). It is **path-preserving** — clients hitting `www.foo.ch/bar/baz` get redirected to `foo.ch/bar/baz`, not the homepage. This is crucial for search engines that have indexed www URLs and need to discover the canonical replacement.

If the redirect breaks (e.g. CNAME changed to www, A records re-pointed), all SEO equity from indexed www pages is lost. Verify with the curl commands above before any DNS change.

---

## Bing index crash — root cause and recovery

### Symptoms (April 2026)

- Bing Webmaster Tools reports `status: critical`
- Week-over-week clicks: -80.8% (26 → 5 clicks)
- Week-over-week impressions: -81.2% (425 → 80)
- Crawl stats: ~1 page crawled per day (extremely low)
- Bing's `bing_get_top_pages` API returned ALL indexed URLs as `https://www.frontaliereticino.ch/*` (with www) — but the site profile is registered as `https://frontaliereticino.ch/` (no www)

### Root cause

**Sitemap mismatch**: Bing had a sitemap registered at `https://www.frontaliereticino.ch/sitemap.xml`, while the canonical sitemap lives at `https://frontaliereticino.ch/sitemap.xml`. When Bing fetched the www URL, it received a 301 redirect to the non-www path. This created confusion in Bing's index migration logic — old www entries were being retired faster than new non-www entries were being added.

**Contrast with Google**: GSC had been re-verified for the non-www domain weeks earlier and is showing healthy growth (+42.5% week-over-week, 1273→1814 clicks). The migration succeeded for Google but failed for Bing because Bing's sitemap submission was never updated.

### Recovery actions executed (2026-04-06)

Performed via `mcp__search-console-mcp__bing_*` tools:

1. **Removed stale sitemap**:
   ```
   bing_sitemaps_delete sitemapUrl=https://www.frontaliereticino.ch/sitemap.xml
   ```

2. **Submitted canonical sitemap**:
   ```
   bing_sitemaps_submit sitemapUrl=https://frontaliereticino.ch/sitemap.xml
   ```
   Status: `Pending` — Bing will crawl on next pass.

3. **Confirmed only canonical sitemap is registered**:
   ```
   bing_sitemaps_list → 1 entry, https://frontaliereticino.ch/sitemap.xml
   ```

### Recovery actions still pending

- **Wait for Bing to recrawl**: typically 7-14 days for re-indexation to begin showing in Webmaster Tools
- **Monitor IndexNow daily quota**: `bing_url_submission_quota` reports `DailyQuota: 0` — investigate if exhausted or never granted. The newly-deployed IndexNow integration (`feat(seo): add IndexNow batch submission`) should be feeding fresh URLs daily; if quota is 0 the submissions may be silently dropped.
- **Watch crawl stats** for `CrawledPages` to climb back from 1/day to a healthy number
- **Re-verify the site at the non-www domain** in Bing if needed (currently verified)

---

## Google Search Console — status

GSC is healthy and growing:

| Metric | 2026-03-22→28 | 2026-03-29→04-04 | Change |
|--------|---------------|-------------------|--------|
| Clicks | 1273 | 1814 | **+42.5%** |
| Impressions | 40892 | 54707 | **+33.8%** |
| Average position | 6.18 | 5.89 | **+0.29 (better)** |

Top queries (last 30 days, by clicks):

| Query | Clicks | Position |
|-------|--------|----------|
| lavoro ticino | 100 | 2.95 |
| offerte lavoro ticino | 92 | 2.74 |
| offerte di lavoro ticino | 60 | 3.37 |
| case anziani ticino offerte di lavoro | 47 | 1.47 |
| simulazione tasse nuovi frontalieri | 43 | 4.42 |

The site dominates "lavoro ticino" head terms (positions 2-3 across the board) — the recent SEO optimizations on listing pages and category hubs (PR `0a613dac4` and predecessors) appear to be paying off.

---

## Operational checklist — when changing canonical domain in the future

1. **Never remove www CNAME** — keeping it as a 301 source preserves SEO equity
2. **Update Bing sitemap submission immediately** after canonical change (use `bing_sitemaps_submit` MCP tool)
3. **Verify GSC has both versions registered** so the migration data is captured
4. **Update IndexNow URL submitter** to use the new canonical
5. **Update all 117 GitHub Actions workflows** that reference the canonical (search for hardcoded URLs)
6. **Update sitemap.xml generator** in `build-plugins/jobsSeoPagesPlugin.ts` and others
7. **Update hreflang tags** in `services/seoService.ts`
8. **Test the redirect** with `curl -sI` for: `/`, `/sitemap.xml`, `/it/...`, `/en/...`, a deep job URL
9. **Update Bing/Google verified site profile** if changing the apex
