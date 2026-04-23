# Sprint 3 — Cannibalization Follow-up

Date: 2026-04-23
Status: infrastructure landed, per-URL consolidation deferred (needs SERP data).

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

### Audit baseline (after whitelist tuning)

`node scripts/audit-cannibalization.mjs` on current dist flags 5
clusters (down from 13k before whitelists, 80 before templated-cluster
prefix list). None are among the Sprint 3 plan's original 14 — they're
new local-only findings:

| # | Cluster (normalized phrase) | URLs | Suggested winner |
|---|---|---|---|
| A | "voto cruciale in ticino l iniziativa anti" | 3 IT blog articles | `iniziativa-anti-dumping-ticino-2026` (latest, 2026-03-02) |
| B | "construction on the a9 disruptions for cross" | 2 EN blog articles | `cantieri-traffico-a9-ticino` (more specific) |
| C | "tax returns at risk ticino" | 2 EN blog articles | Likely NOT duplicate — Lombardy-clash vs Bern-dispute are distinct intents; keep both with tighter titles |
| D | "g permit pros and cons for cross" | 2 EN blog articles | `permesso-g-vantaggi-svantaggi` (Apr 3, evergreen) over `permesso-g-pro-contro-2026` (Feb 23) |
| E | "gasoline price eni via cantonale 36 in caslano 2026" | 2 EN station pages | Data dedup — keep the non-suffixed station, drop `-4` variant upstream in `fetch-fuel-data` |

These deserve their own mini-consolidation PR (not this sprint —
introducing blog redirects is a content-quality decision that needs
editorial review; see `docs/seo/PLAN-SPRINT-3-CANNIBALIZATION.md`
acceptance criteria about preserving unique content).

## What did NOT land (deferred)

### Sprint 3 plan's original 14 clusters

Resolving each cluster requires a **URL-to-position pairing** per
keyword that the current codebase cannot reconstruct:

- `SEMRUSH-SCAN-2026-04-22.md` lists keywords + positions but not the
 per-cluster loser URLs.
- GSC exports (`scripts/discover-404s-via-inspection.mjs`,
 `scripts/find-orphan-indexed-jobs.mjs`) focus on 404/indexation, not
 cannibalization pairing.
- Semrush duplicate-keyword report (§ Sprint 3 plan source) was not
 checked into the repo.

**Recommended next step**: extend `scripts/audit-cannibalization.mjs`
to pull Semrush `phrase_organic` rows for a provided keyword list via
MCP Semrush tool (available in this workspace), match domain URLs
per keyword, and emit a CSV so a human can pick winners.

### Tasks 3.4 (internal link audit) and 3.6 (content consolidation)

Depend on URL pairings from the deferred work above. Without the list,
they cannot be executed without risking arbitrary redirects.

### Task 3.7 (GSC re-indexing)

Gated on Tasks 3.4/3.6 actually changing URLs. Nothing to re-submit
yet.

## Action items owners

- [ ] **Eng**: extend audit script to call Semrush MCP (`mcp__semrush__*`)
 and emit `data/seo/cannibalization-urls.csv`.
- [ ] **Content/SEO**: pick canonical winner for each of the 14 Semrush
 clusters using that CSV, then extend the `redirects` map in
 `build-plugins/legacyRedirectsPlugin.ts`.
- [ ] **Content**: review the 5 local clusters (A–E above) and decide
 which to consolidate (A, B, D likely yes; C no; E is a data bug).

## Monitoring

`node scripts/audit-cannibalization.mjs` runs cleanly today (5 known
clusters). Wire it into CI once the 5 are resolved so future blog
duplicates are caught at build time.
