# Crawler Output Normalization — Upstream "Best Match" Compatibility

How crawler output is shaped so it natively matches what
`scripts/assemble-jobs-dataset.mjs` expects, and the convergence study for the
job-identity keys.

## Pipeline recap

```
crawler parser  ──►  writeJobsCrawlerSlice()  ──►  data/jobs/by-crawler/<key>.json
 (hand-rolled         (single funnel; every               │
  ParsedJob literal)   crawler routes here via             ▼
                       runStandardCrawlerPipeline)   assembleJobs()  ──► data/jobs.json
                                                     (dedup + filter + drop)
```

Every sanctioned crawler funnels through `writeJobsCrawlerSlice`
(`scripts/assemble-jobs-dataset.mjs`), called by `runStandardCrawlerPipeline`
(`scripts/lib/crawler-template.mjs`). That makes the writer the one place where
write-time normalization applies to all ~350 crawlers without touching each
parser.

## What the assembler drops, and why (root causes)

1. **Location shape — the highest-volume dropper.** The Swiss-municipality
   whitelist (`assembleJobs`, ~`:1004-1037`) drops a job when `location` /
   `addressLocality` is leaked prose, empty, or a canton-only label without a
   Swiss anchor. Parsers that strip a "Location:" label from inline paragraph
   text leak the whole paragraph tail into `location`. The assembler had a
   *post-dedup* safety net (`sanitizeJobLocationField`) whose own comment said
   it is "the safety net for the other 177 parsers **until each one is
   hardened**" — i.e. the upstream fix was always the intent.

2. **Identity-key divergence — silent dedup / lost SEO continuity.** The same
   job URL was normalized **three different ways**:
   - `extractStableJobId` (crawl-time merge, `job-match-key.mjs`) — extracts a
     stable token (UUID / ≥6-digit numeric / ≥10-char hex) so vendor slug
     renames don't fragment the match.
   - `assemblerIdentity` (assemble-time dedup, `assemble-jobs-dataset.mjs`) —
     full raw URL, **hash preserved** (Galenica encodes positions in `#job.id=`).
   - `normalizeIdentityUrl` (stats/diff/firstSeenAt, `job-identity.mjs`) —
     parses the URL and **strips the hash** + default ports.
   When these disagree, a job matched at crawl time can split into two
   identities at assemble time and lose one copy to the slug-dedup pass.

3. **Per-parser drift.** Each parser hand-rolls the job literal, so `id`
   formula, `needsRetranslation` initial state, and recommended-field defaults
   vary. `postalCode` / `streetAddress` are often absent (JobPosting schema
   non-negotiable #3).

## What this change implemented

### A. Write-time location hardening + safe metadata defaults
`normalizeParsedJobsForSlice(jobs)` (exported from `assemble-jobs-dataset.mjs`)
runs at the **top of `writeJobsCrawlerSlice`**, before any downstream gate:

- `location` / `addressLocality` → `sanitizeJobLocationField` (same logic as
  the assemble-time net, so that net becomes a no-op for new slices). Corrupted
  locations no longer reach the Swiss whitelist.
- `addressLocality` backfilled from the cleaned `location` when missing.
- `addressCountry` / `country` default to `CH`; `addressRegion` defaults to the
  canton code.

**Deliberately NOT done:** it never invents `postalCode` or `streetAddress` —
forging an HQ postal code is exactly what slipped foreign jobs past the
whitelist (the Swatch incident). Postal-code enrichment stays in the assembler
(derived from a city table). Job `id` backfill stays in the assembler
(`buildStableId`) to avoid a second, divergent id formula.

Idempotent and additive: only future crawler runs rewrite their slice; no mass
re-write of existing data.

### B. Identity-key consolidation (behavior-preserving)
The three URL normalizations now live in one module,
`scripts/lib/job-url-key.mjs`:

| Export | Variant | Hash | Token extraction |
|--------|---------|------|------------------|
| `mergeUrlKey` | crawl-time merge | n/a (decodes `&amp;`) | UUID → numeric → hex → URL |
| `assembleUrlKey` | assemble-time dedup | **preserved** | none (raw URL) |
| `identityUrlKey` | stats/diff/firstSeenAt | **stripped** | none (parsed URL) |

The three call sites delegate to these. **Observable output is unchanged** —
pinned byte-for-byte by `tests/job-url-key.test.ts` (incl. the intentional
hash-handling divergence). This is a no-op refactor: it does **not** re-key any
existing job. Its value is that the divergences are now visible and documented
in one place, which is the prerequisite for the convergence study below.

## Convergence study — toward a single written identity (NOT yet done)

Goal: make merge-key and assemble-key **agree** so a job matched at crawl time
keeps the same identity at assemble time, eliminating the silent slug-dedup
drops. Why it is gated rather than shipped:

- **Re-key risk.** These keys are persisted dedup/merge keys. Changing any
  variant's output value re-keys every existing job and can cause mass slug
  churn — the opposite of the SEO continuity we want to protect.
- **Over-merge risk.** If `assembleUrlKey` adopted `mergeUrlKey`'s token
  extraction, two genuinely different jobs sharing a 6-digit number in their
  URL (a year, a category id) would collapse into one and the loser would be
  dropped. The assembler kept the raw URL precisely to stay conservative.
- **Intentional divergence.** Galenica's hash fragments must stay distinct in
  the assemble key; the identity key must drop them for stats/diff. A single
  function cannot serve both without a mode flag.

**Proposed gated rollout (future PR):**
1. Add a dry-run script that, over the live `data/jobs/by-crawler/*.json`,
   computes both the current and the candidate-unified keys and reports:
   how many jobs would change identity, how many distinct jobs would collapse
   (over-merge), and which crawlers are affected.
2. Ship the unified key only if the dry-run shows zero over-merge and an
   acceptable, attributable re-key set — behind the same kind of regression
   test that pins outputs today.
3. Persist the chosen identity on the job record (a written `identityKey`
   field) so future key-logic changes never silently re-key history.

Until then, `job-url-key.mjs` keeps the three variants explicit and tested, and
the write-time normalization (A) delivers the high-volume drop reduction
without any re-key risk.

## Tests
- `tests/job-url-key.test.ts` — pins all three variants + the intentional
  hash-handling divergence.
- `tests/scripts/normalize-parsed-jobs-for-slice.test.ts` — write-time
  location hardening, safe defaults, no postalCode/streetAddress forging,
  idempotency.
