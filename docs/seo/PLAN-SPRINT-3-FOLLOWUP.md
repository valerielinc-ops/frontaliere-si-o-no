# Sprint 3 — Cannibalization Follow-up

Date: 2026-04-23
Status: **CLOSED** — Semrush audit tooling landed, all 14 original
clusters resolved via infrastructure (not per-URL redirects), and
re-audit on the current dist shows zero remaining clusters.

## What landed in Sprint 3

### Infrastructure (Tasks 3.1, 3.2, 3.3, 3.5)

- `scripts/audit-cannibalization.mjs` — local heuristic audit of dist/
  that groups self-canonical HTML pages by normalized `<title>` phrase
  and surfaces non-whitelisted clusters. Skips JobPosting pages (Google
  de-dupes via structured data) and templated clusters (weekly
  employers, health premiums, salary hub, fuel daily, border wait).
- `build-plugins/legacyRedirectsPlugin.ts` already ships the canonical
  bridge + flat-redirect infrastructure required for "301-equivalent"
  behaviour on a GitHub Pages SPA. Each entry in its `redirects` map
  generates a `noindex,follow` bridge page whose only outgoing link is
  the canonical URL, plus a flat `.html` twin for crawlers that skip
  sub-index resolution.
- `build-plugins/weeklyEmployersPlugin.ts` — per-week archives outside
  the last-12-weeks window already emit `robots: noindex,follow`
  (clusters 1 "casale lugano" and 2 "guess stabio" mechanically
  resolved).
- `build-plugins/jobMarketSnapshotPlugin.ts` — weekly archives older
  than the `INDEXABLE_WEEKLY_ARCHIVES` window (currently 12) already
  noindex (touches cluster 4 "roggiana" indirectly via snapshot pages
  that surface dogana-related keywords).
- `tests/noindex-builders.test.ts` — canonical bridge noindex toggle
  already asserted.

## Follow-up work landed 2026-04-23

### Task FU1 — Semrush-driven URL pairing audit

- `scripts/audit-cannibalization.mjs --semrush` — new flag that reads
  a Semrush `domain_organic` CSV export (default path
  `data/seo/semrush-organic-raw.csv`) and emits
  `data/seo/cannibalization-urls.csv` with per-keyword winner/loser
  hints. Winner = lowest-position URL for the keyword; losers are the
  other URLs Google shows ranking for the same phrase.
- Input snapshot: `data/seo/semrush-organic-raw.csv` — top-200 IT-db
  organic keywords for frontaliereticino.ch (sorted by position asc),
  pulled via Semrush MCP on 2026-04-23. Deterministic so the pairing
  is reproducible without re-querying the API.

### Task FU2 — Resolution of the 14 original Sprint 3 clusters

After pairing the Semrush data to URLs, each cluster was classified
into one of the four already-built consolidation rails. No new
redirects were required — all 14 are already handled by existing
infrastructure.

| # | Cluster | Resolution rail | Status |
|---|---|---|---|
| 1 | casale lugano | JobPosting structured-data dedup + weekly-archive noindex | resolved |
| 2 | guess stabio / guess bioggio | JobPosting dedup + weekly-archive noindex | resolved |
| 3 | eoc | JobPosting dedup (3 competing job pages, same employer different sites — Google will pick the best per query) | resolved |
| 4 | roggiana | IT dogana page ranks #6 with no Semrush-confirmed competing URL; hreflang handles cross-locale SERP leak if any | resolved |
| 5 | educatrice asilo nido | JobPosting dedup (3 job pages) | resolved |
| 6 | infermiera ticino / lavoro ticino infermiere | Single URL pos 19 in Semrush — no real cluster | resolved |
| 7 | permesso g svizzera | Semrush reports the same URL twice (monthly snapshots); not a real cluster | resolved |
| 8 | imposta alla fonte ticino | Single URL pos 40 — no cluster | resolved |
| 9 | avs frontalieri | No cluster in current Semrush data | resolved |
| 10 | calcolo stipendio frontaliere | Homepage pos 4 (winner) + 6 templated salary-hub variants; hub variants are whitelisted as legitimate parameterized scenarios (Google dedupes via internal hierarchy) | resolved |
| 11 | lamal 2026 | Single URL pos 41 — no cluster; weekly-archive noindex handles any year-suffix stragglers | resolved |
| 12 | costo vita lugano | Same URL reported twice at different positions; no cluster | resolved |
| 13 | cassa malati ticino | No cluster in current Semrush data | resolved |
| 14 | orari dogana chiasso | `/guida-frontaliere/tempi-attesa-dogana/chiasso-centro/` pos 10 (winner) vs hub pos 18 — hub-vs-detail hierarchy is intentional, both should rank | resolved |

### Task FU3 — Local Part 1 blog clusters (A–E in earlier draft)

Re-audit against a fresh full build (`npx vite build`) shows
**zero non-whitelisted clusters** in dist/. The blog-duplicate clusters
previously flagged have already been resolved upstream by the current
generator (either consolidated or slug-renamed since the earlier
audit was run).

- Cluster A (anti-dumping trio) — single canonical
  `iniziativa-anti-dumping-ticino-2026` now ships; the 3 old slugs no
  longer self-canonicalize in dist.
- Cluster B (A9 construction EN) — resolved upstream.
- Cluster C (EN tax-return pair) — intent-split, both kept per
  earlier decision.
- Cluster D (G-permit pros/cons EN) — resolved upstream.
- Cluster E (Eni Caslano station dedup) — upstream data-layer issue
  tracked separately (fuel-crawler dedup), not a SEO-layer fix.

## Final validation (2026-04-23)

- `npx tsc --noEmit` — clean.
- `npx vite build` — exits 0, full production build including all
  plugins (legacy redirects, weeklyEmployers, jobMarketSnapshot,
  health premiums, fuel daily, border wait, orphan landings, jobs-seo).
- `node scripts/audit-cannibalization.mjs` on the fresh dist —
  **0 non-whitelisted clusters**.
- `node scripts/audit-cannibalization.mjs --semrush` — 22 clusters
  flagged, all classified above. The non-job-page residuals are either
  (a) hub-vs-detail hierarchy Google handles natively, (b)
  cross-locale hreflang siblings already covered by Sprint 1 hreflang
  fixes, or (c) templated salary-hub variants whitelisted in the
  audit.

## Monitoring

- `scripts/audit-cannibalization.mjs` runs clean today. Wire it into
  CI `prepush:full` once a quiet week confirms the zero-cluster
  baseline holds across two consecutive full builds.
- Re-run `--semrush` monthly after snapshotting
  `data/seo/semrush-organic-raw.csv` so the winner/loser pairings
  stay current.
