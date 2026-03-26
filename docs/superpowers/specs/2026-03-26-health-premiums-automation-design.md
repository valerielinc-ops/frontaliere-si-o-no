# Health Insurance Premiums Automation

**Date:** 2026-03-26
**Status:** Approved

## Problem

The health insurance comparison page (`confronta-casse-malati`) has 98 hardcoded premium values in `HealthInsurance.tsx`. No automated update mechanism exists — it's the only comparator with fully manual data. The default value in the calculator (400 CHF) is outdated (already changed to 450).

## Design

### Data Source

- **Primary:** UFSP/BAG priminfo.admin.ch (official Swiss health insurance premiums)
- **Fallback:** Previously committed JSON in `data/health-premiums.json`; current hardcoded values as ultimate fallback
- **Update frequency:** Weekly cron + manual dispatch

### Coverage

- **Insurers:** All insurers available per canton/commune (auto-discovered from UFSP data, no manual list)
- **Cantons:** All 26 Swiss cantons
- **Geographic granularity:**
  - TI + GR: per-commune premiums (exact UFSP data)
  - Other 24 cantons: aggregated by premium region

### Data File: `data/health-premiums.json`

```json
{
  "fetchedAt": "2026-03-26T06:00:00Z",
  "year": 2026,
  "insurers": [
    { "id": "assura", "name": "Assura", "website": "https://www.assura.ch" }
  ],
  "premiums": {
    "6900-Lugano": {
      "canton": "TI",
      "region": 0,
      "bfsNr": 5192,
      "insurers": {
        "assura": { "standard": 367, "hausarzt": 341, "hmo": 323, "telmed": 330 }
      }
    },
    "TI": {
      "type": "canton",
      "region": null,
      "insurers": { "assura": { "standard": 367 } }
    }
  },
  "rankings": {
    "cheapest": [{ "municipality": "6900-Lugano", "avgPremium": 385 }],
    "mostExpensive": [{ "municipality": "6600-Locarno", "avgPremium": 428 }]
  }
}
```

Premiums stored are base values: adult 26+, franchise 300, without accident. Component applies multipliers for model/franchise/age as today.

### Components

#### 1. Fetch Script (`scripts/fetch-health-premiums.mjs`)

- Fetches CSV/data from priminfo.admin.ch
- Processes per-commune for TI/GR, per-canton-aggregate for others
- Auto-discovers all insurers present in data
- Computes rankings (cheapest/most expensive communes)
- Writes `data/health-premiums.json`
- Copies to `public/data/health-premiums.json`

#### 2. GitHub Actions Workflow (`update-health-premiums.yml`)

- Cron: weekly (Sunday night)
- Manual dispatch supported
- Runs fetch script
- Commits if data changed
- Triggers deploy via `trigger-deploy.sh`
- Pattern: identical to `update-fuel-prices.yml`

#### 3. HealthInsurance.tsx Refactor

- Loads `data/health-premiums.json` at runtime (like FuelPrices)
- Replaces hardcoded `BASE_PREMIUMS` and `INSURERS`
- For TI/GR: adds commune selector (dropdown grouped by canton)
- For other cantons: keeps canton selector as today
- `DataFreshness` shows actual `fetchedAt` date from JSON
- Fallback: if JSON fails to load, uses embedded default data

#### 4. Commune Rankings — Comparator Section

- New collapsible section at bottom of HealthInsurance page
- Shows top 10 cheapest + top 10 most expensive communes
- Filter by canton (TI/GR only, since others are aggregated)
- Links to stats page for full ranking

#### 5. Stats Page (`stats > health-premiums`)

- New subTab in Statistics
- Full commune ranking table with sorting
- Canton filter
- Average premium by canton bar chart
- Year-over-year comparison (when historical data accumulates)

#### 6. Evergreen Article

- Generated/updated by fetch script or dedicated article script
- Title: "Classifica Comuni: Premi Cassa Malati più Economici e Cari"
- Auto-updated data: top/bottom 10, cantonal averages
- SEO target: "premi cassa malati comune più economico"

### Default Value Change

- `constants.ts`: `healthInsuranceCHF` 400 → 450 ✅ (already done)
- `RalComparator.tsx`: `useState(400)` → `useState(450)` ✅ (already done)

### Navigation

- Stats subTab `health-premiums` added to `StatsSubTab` type
- Router slugs added for all 4 locales
- SEO metadata entry added
- Static HTML generated via `staticPagesPlugin`
- Added to sitemap and search index

### Tests

- Fetch script: test JSON output structure, fallback behavior
- HealthInsurance: adapt existing 22 tests to use JSON data
- Stats page: rendering, filtering, sorting
- Rankings: correct ordering
