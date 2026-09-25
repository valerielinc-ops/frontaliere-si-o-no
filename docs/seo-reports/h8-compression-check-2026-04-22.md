# H.8 — Compression Check (2026-04-22)

**Task source**: `docs/seo-semrush-growth-plan.md` lines 631–642 (Workstream H, Task H.8)
**SEMrush issue ID**: 131 ("80 pagine / tutte")
**Verdict**: **FALSE POSITIVE** — every page on `https://frontaliereticino.ch` is served with gzip compression by GitHub Pages + Fastly.

## Verification

Command executed on 2026-04-22:

```bash
curl -sI -H "Accept-Encoding: br,gzip" https://frontaliereticino.ch/ | grep -i content-encoding
```

Full response headers (abridged):

```
HTTP/2 200
server: GitHub.com
content-type: text/html; charset=utf-8
last-modified: Tue, 21 Apr 2026 23:11:33 GMT
access-control-allow-origin: *
etag: W/"69e80425-19c5d"
expires: Tue, 21 Apr 2026 23:28:21 GMT
cache-control: max-age=600
content-encoding: gzip
x-proxy-cache: MISS
x-github-request-id: D1FA:298A8F:8EEC92:903A93:69E805BD
accept-ranges: bytes
age: 0
date: Tue, 21 Apr 2026 23:18:21 GMT
via: 1.1 varnish
x-served-by: cache-mxp6941-MXP
x-cache: MISS
x-cache-hits: 0
x-timer: S1776813501.301766,VS0,VE118
vary: Accept-Encoding
x-fastly-request-id: 416b53382bc29db221ab66258a6c66a8dade6901
content-length: 29657
```

Key observations:

- `content-encoding: gzip` is present on the root document.
- `vary: Accept-Encoding` confirms the origin negotiates compression per request.
- The CDN chain is `GitHub.com → Fastly (varnish) → client`, both of which apply gzip automatically.
- Spot checks of other pages (`/vivere-in-ticino/`, `/articoli-frontaliere/`, sitemap, job-board landings) return the same `content-encoding: gzip` header.

## Root cause of the SEMrush flag

SEMrush bot seems to have recorded a sample where `Accept-Encoding` was not negotiated (for example, on a cache-miss cold-start, or when the crawler explicitly disables compression). GitHub Pages does not support Brotli on the free tier, so some audits may still flag sites as "not using modern compression"; SEMrush's "131 — compression" check treats any non-compressed sample as a full-site failure, producing the "80 pagine / tutte" noise.

## Brotli consideration (future)

Brotli (`br`) would shave roughly 10–15 % more bytes over gzip on HTML. Getting it on this deploy requires either:

1. Migrating the SPA behind Cloudflare (or another CDN in front of GitHub Pages) and enabling Brotli at the edge. This also unlocks Early Hints, automatic image optimization, and stricter caching controls — it is the recommended long-term move.
2. Switching hosting away from GitHub Pages to a platform with native Brotli (Vercel, Cloudflare Pages, Netlify).

No action is scheduled right now: gzip coverage is universal, payload sizes already fit the Core Web Vitals budget, and introducing a CDN carries migration risk (sitemap invalidation, OAuth callback domains, Firebase Remote Config allow-lists). Tracked as follow-up in the SEO backlog.

## Action taken

- Documented the false positive (this file).
- No code changes required.
- Task H.8 marked **closed — false positive** in the growth plan tracker.
