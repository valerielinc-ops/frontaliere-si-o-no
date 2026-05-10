# Cathedral — SuccessFactors parser migration audit

**Date:** 2026-05-10
**Branch:** `feat/cathedral-sf-migration`
**Scope:** evaluate whether the 10 (+3) SF-using detail-page parsers in
`scripts/lib/*-job-parser.mjs` can be migrated onto the shared
`scripts/lib/ats-clients/successfactors-client.mjs` (cathedral PR #54-60).
**Outcome:** **0/13 parsers migrated** — all classified `NOT_APPLICABLE_BYTE_IDENTICAL`
or `REQUIRES_CLIENT_EXTENSION`. The shared client stays at v1 (transport +
identity); the audit explains why and lists the exact extensions the client
would need before any migration becomes safe under the
speed-only-no-behavior-change rule.

## Why the speed-only rule blocks migration

CLAUDE.md's "no behavior change" memory (`feedback_speed_only_no_behavior_change.md`)
says: *Speed optimizations must preserve every output byte-identical; no
smart-skip, no SSG→runtime, no feature removal.* The shared
`successfactors-client.mjs` exports an **identity-only** shape:

```ts
SuccessFactorsJobIdentity = {
  jobReqId, slug, title, location, company, postedAt, applyUrl
}
```

The 13 audited parsers each emit a far richer `ParsedJob` object: full
description (HTML→text with h2 section preservation), requirements arrays,
employment-percentage strings, department/sector classification,
postal-code+city splits, fallback-prose generation per tenant, and many
tenant-specific category dictionaries (Italian/German/French keyword maps).

Replacing the bespoke extraction with the shared client today would drop
fields that the `assemble-jobs` pipeline (and SEO content gates downstream)
depend on. That is a behavior change — not a refactor — so the per-parser
diffs are deferred until the shared client grows the missing capabilities.

## Classification table (13 parsers audited, 10 in original scope + 3 nearby)

| # | Parser | LOC | SF flavor used | Classification | Reason | Action |
|---|---|---|---|---|---|---|
| 1 | `giorgio-armani-job-parser` | 256 | `html-career` (detail) | NOT_APPLICABLE_BYTE_IDENTICAL | JSDOM-based richer extraction: keeps `description` (h2-split + ul/ol→bullets), `applyHref` from `a#applyButton_top`, `area`/`country` from `div[tabindex="0"]`. Shared `parseHtmlCareerDetail` is internal, regex-only, drops description + applyHref. | Add `parseSuccessFactorsCareerDetailRich(html)` to client (export + JSDOM-or-cheerio path) before migrating. |
| 2 | `rapelli-job-parser` | 237 | `html-jobreq` (jobs2web on `careers.orior.ch`) | NOT_APPLICABLE_BYTE_IDENTICAL | Custom listing scraper: extracts city from URL path (`/job/{City}-...-TI/{id}/`), maps Italian department keywords (Produzione/Logistica/...). Detail parser uses depth-counted `<div class="jobdescription">` walker (not regex). | Shared `parseJobs2WebSearchRows` parses `<tr>` table rows — Rapelli listing is a flat link list, not a table. Needs `parseJobs2WebLinkList(html, options)` variant. |
| 3 | `sbb-job-parser` | 312 | `html-jobreq` (`jobs.sbb.ch/v2/offene-stellen`) | NOT_APPLICABLE_BYTE_IDENTICAL | Pure detail-page parser. Contains regression-fix logic (commit history): when JSON-LD `description` is short, falls back to `extractSbbHtmlSections` (h2/h3 section walker) + body location extraction. Shared `extractJsonLdJobPosting` returns only the JSON-LD teaser → would re-introduce the documented regression. | Promote `extractSbbHtmlSections` to client as `extractJsonLdJobPostingWithHtmlFallback(html, { minDescLength })`. |
| 4 | `heineken-ch-job-parser` | 486 | `html-jobreq` (jobs2web on `careers.theheinekencompany.com`) | NOT_APPLICABLE_BYTE_IDENTICAL | Listing strips language-prefix titles (`Bezeichnung:`, `Titre:`, `Titolo:`), parses `Ergebnisse N–M von TOTAL` pagination header, builds rich German fallback description >50 words. Detail parser has garbage filter ("Suche nach Stichwort", "Create Alert") + Ort/Standort/Location regex on stripped HTML. | Shared client's row parser drops language prefix already, but lacks: pagination total parser, fallback prose generator, content garbage-filter list. |
| 5 | `oerlikon-job-parser` | 327 | `html-jobreq` (CSB on `careers.oerlikon.com`) | NOT_APPLICABLE_BYTE_IDENTICAL + **pre-existing bug** | HTML fallback path has corrupted `try { try { } catch }` block (lines 240-247) → `html` is never assigned → `parseSearchPageHtml` always receives `''`. Migrating would either fix or preserve the bug. Per non-negotiable #1 ("fix root cause, not workaround") — this should be a SEPARATE bug-fix PR, not a migration. | (a) File bug PR to restore HTML fallback fetch. (b) Then re-evaluate migration once `fetchSuccessFactorsJobs` covers `careers.oerlikon.com` CSB JSON sidecar (`/api/apply/v2/jobs`). |
| 6 | `benteler-job-parser` | 322 | `html-jobreq` (SPA on `career.benteler.com`) | NOT_APPLICABLE_BYTE_IDENTICAL + **pre-existing bug** | Same corrupted `try { try { } catch }` block as Oerlikon (lines 234-247). Listing is SPA-only → shared client already returns `null` for SPA + tells caller to use `playwright-runtime.mjs`. Migration cannot happen until SPA crawl path lands. | Same as oerlikon. Both Benteler + Oerlikon need a separate bug-fix PR. |
| 7 | `interdiscount-job-parser` | 428 | **NOT SF** — Prospective.ch JSON API | NOT_APPLICABLE | Listing crawled from `ohws.prospective.ch/public/v1/medium/1000103/jobs`. The single `successfactors.eu` reference is a substring in `isTrustedDomain()` allow-list (apply URLs only). No SF detail fetch. | No migration applicable. Remove from "SF parser" list in CATHEDRAL-STATUS #11. |
| 8 | `jumbo-job-parser` | 421 | **NOT SF** — Prospective.ch JSON API | NOT_APPLICABLE | Same as Interdiscount. SF reference is allow-list only. | No migration applicable. |
| 9 | `prada-job-parser` | 362 | `html-jobreq` (jobs2web on `jobs.pradagroup.com`) | NOT_APPLICABLE_BYTE_IDENTICAL | Two-pattern listing parser: (1) `<a class="jobTitle-link" href="/job/.../{id}/">`, (2) generic `href="/job/.../{id}/"` fallback. URL contains `{City}-{Title}` with underscore variants (`St_-Moritz`). Custom city-from-slug logic. | Shared `parseJobs2WebSearchRows` is `<tr>`-based; Prada is `<table>`-with-cells AND link-only fallback. Needs `parseJobs2WebSearchCells(html)` (current logic) + `parseJobs2WebLinkList(html)` (Prada fallback / Rapelli). |
| 10 | `agroscope-job-parser` | 193 | **NOT SF** — Prospective.ch JSON API; SF only in apply links (`career74.sapsf.eu/career?company=bundesamtf`) | NOT_APPLICABLE | Same shape as Interdiscount/Jumbo. SF is reference-only for apply URL construction. | No migration applicable. |
| 11 | `aldi-suisse-job-parser` (bonus, T6.4 prior session) | 209 | **NOT SF listing** — own SSR on `jobs.aldi.ch`; SF only as one of three link-discovery patterns | NOT_APPLICABLE | `parseAldiListingPage` extracts `/job/{numericId}` AND `career5.successfactors.eu` links AND generic anchors with percentage hint. Detail parser hits `jobs.aldi.ch` (NOT career5). | No migration applicable. |
| 12 | `alpiq-job-parser` (bonus, T6.4 prior session) | 259 | **NOT SF listing** — `alpiq.com/career/open-jobs` HTML | NOT_APPLICABLE | Listing crawled from alpiq.com (custom `<a href="/career/open-jobs/your-application/{id}">` block split). SF reference is `applyUrl` template string — never fetched. | No migration applicable. |
| 13 | `mobiliar-job-parser` (bonus, T6.4 prior session) | 378 | `html-jobreq` (sitemap-driven on `jobs.mobiliar.ch`) | NOT_APPLICABLE_BYTE_IDENTICAL | Listing comes from `sitemap.xml` (not search API/HTML), filtered by Valais city keywords in URL slug. Detail parser does h2-section walker + requirements bullet extraction + employment-percentage regex + postal code regex. | Shared client has no sitemap-discovery primitive. Detail parser too rich for client's `extractJsonLdJobPosting`. |

## Summary

| Bucket | Count | Parsers |
|---|---|---|
| MIGRATABLE | **0** | (none) |
| NOT_APPLICABLE — not actually SF | 4 | interdiscount, jumbo, agroscope, aldi-suisse |
| NOT_APPLICABLE — SF-adjacent but listing is non-SF | 2 | alpiq, mobiliar |
| NOT_APPLICABLE_BYTE_IDENTICAL — would drop fields | 5 | giorgio-armani, rapelli, sbb, heineken-ch, prada |
| NOT_APPLICABLE + pre-existing bug | 2 | oerlikon, benteler |

**LOC delta:** 0 (no code change to parsers, no extension to shared client).

## Recommended next steps (in order)

1. **Bug PR for oerlikon + benteler corrupted `try`-blocks** (1 PR, ~10 LOC).
   Pre-existing bugs that have been silently swallowing HTML-fallback fetches.
   Should be fixed and verified live before any migration is attempted.

2. **Shared-client v2 — add the four missing primitives** (separate PR, all
   thin pure functions, byte-identical to current parser internals):

   ```
   parseSuccessFactorsCareerDetailRich(html)       → { title, reqId, area, country, description, applyHref }
   parseJobs2WebSearchCells(html, baseUrl)         → richer row parser (lang-prefix strip + pagination total)
   parseJobs2WebLinkList(html, baseUrl)            → flat link variant (Rapelli, Prada fallback)
   extractJsonLdJobPostingWithHtmlFallback(html, { minDescLength })
                                                   → JSON-LD + h2 sections + body Ort/Standort
   ```

   None of these add behavior — they extract existing per-parser code into
   shared module-level helpers, then re-import in the parser. The parser
   output stays byte-identical.

3. **One migration PR per parser** (after step 2 lands), gated on:
   - parser unit tests stay green on identical fixtures
   - `npx vitest run tests/parsers/{parsername}*` exits 0
   - `crawler-health.json` shows no drop in job count on next live cron

4. **Update CATHEDRAL-STATUS.md #11** to drop the 4 non-SF parsers
   (interdiscount, jumbo, agroscope, aldi-suisse), reducing the migration
   scope from 10 to 6 parsers.

## Verification commands

```bash
# Spot-check current SF references per parser
rg -l "successfactors|jobs2web|career5|sapsf|jobreqcareer|career_job_req_id" scripts/lib/

# Inventory shared client exports (current v1)
rg -n "^export" scripts/lib/ats-clients/successfactors-client.mjs

# Affected parser tests
npx vitest run tests/alpiq-crawler.test.ts tests/interdiscount-crawler.test.ts tests/heineken-ch-crawler.test.ts tests/prada-crawler.test.ts tests/jumbo-crawler.test.ts tests/oerlikon-crawler.test.ts tests/mobiliar-crawler.test.ts tests/aldi-suisse-crawler.test.ts tests/rapelli-crawler.test.ts tests/benteler-crawler.test.ts tests/sbb-crawler.test.ts tests/sbb-login-localization.test.ts
```

## References

- Speed-only rule: `feedback_speed_only_no_behavior_change.md` (user memory)
- Non-negotiable #1, #5: `/Users/saggesel/Projects/frontaliere-si-o-no/CLAUDE.md`
- Cathedral status item #11: `docs/CATHEDRAL-STATUS.md`
- Shared client: `scripts/lib/ats-clients/successfactors-client.mjs`
- Cathedral PR series: #54-60 (ATS-client extraction wave)
