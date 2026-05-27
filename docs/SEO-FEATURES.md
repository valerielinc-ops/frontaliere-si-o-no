# SEO Feature Reference

Reference for F2–F8 SEO feature pages: page counts, data sources, cron pipelines, and operational policies.

## Feature page catalog

| Feature | Path | Pages (approx) | Data source |
|---|---|---|---|
| F2 LAMal | `/premi-cassa-malati/{canton}/{age}/` | 144 (5 cantoni × 6 età × 4 locali) + YoY delta vs 2025 | BAG opendata `Praemien_CH.csv` |
| F3a Title/meta CTR | existing job pages | ~15k imp/mese existing pages | `job-board-titles.ts` + live counts |
| F3b Orphan landings | `/ricerca/{cluster}/` | 17 cluster × 4 locali | `data/gsc-orphan-queries-clusters.json` (GSC 18-mo window) |
| F4 Job market snapshot | `/mercato-lavoro-ticino/` + weekly/monthly + `/settore/{sector}/` | 24 hub + 56 sector | `jobs-stats-history.json` |
| F5 Weekly employers | `/aziende-che-assumono/{city}/{company}/settimana-corrente/` | 28 city + 800+ company×city | `jobs.json` weekly delta |
| F6 Fuel daily | `/prezzi-diesel/{zone}/oggi/` + `/stazioni/{slug}/` + `/italia/{city}/` | 48 regional/zone + 560 Swiss stations + 88 IT cities | TCS Firestore + TomTom |
| F8 Border wait | `/traffico-dogane/{crossing}/oggi/` + webcam embeds | 108 (24 crossings × 4 locali + hubs) | TomTom API → Firestore + ASTRA/PolCa webcam |

## Cron workflows (SEO data pipelines)

- `update-fuel-prices.yml` + `snapshot-fuel-history.mjs` — daily fuel snapshot (90g retention)
- `update-health-premiums.yml` — annual BAG fetch (Sept)
- `update-exchange-history.yml` — daily CHF/EUR (reserved for future F1)
- `traffic-scheduler.yml` + `collect-traffic.mjs` — 15min peak-hour TomTom→Firestore traffic collection (F8 consumer)
- `snapshot-jobs-weekly.yml` — Monday 06:00 UTC weekly jobs snapshot (F5 delta source, 12-week retention)
- `refresh-keyword-config.yml` — weekly orphan clustering re-run (F3b)
- `evergreen-refresh-audit.yml` — content freshness audit

## Build config

- Heap: `NODE_OPTIONS='--max-old-space-size=12288'` (12GB) in all build scripts — LAMal dataset grew to 4.7MB post YoY archive, 8GB caused rollup/zlib OOM
- Vite entry: `/assets/index-{hash}.js` + `/assets/index-{hash}.css` resolved by `build-plugins/shared/seoPageShell.ts` for SPA hydration on statically-emitted SEO pages

## Webcam hotlink policy (F8)

- **ASTRA** (federal): hotlink accepted with attribution link in `<figcaption>` (`rel="nofollow noopener"`)
- **Polizia Cantonale Ticino**: same
- **Autostrade per l'Italia**: ToS restrictive — external link only, NO embed hotlink
- `onerror` fallback hides `<figure>` if URL returns 403/404 at runtime
- Nightly health check via `scripts/validate-webcam-urls.mjs`
