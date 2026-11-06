# Salary-intent landing (profession × canton) — post-floor count + canonical plan

Analysis for issue #4460 (epic #4459, "stipendio {professione} {cantone}" salary-intent
family). No pages are emitted by this doc — it is the input for the plugin sub-issue
(#4461). Methodology and numbers below are computed from the real build corpus
(`data/jobs.json`, 18686 active jobs at analysis time), reusing the SAME aggregation
the live `/lavoro-{canton}-{role}/` family uses (`aggregateProfessionJobsByCanton`),
not a fresh heuristic.

## 1. Post-floor count

Two independent floors must both clear for a (profession, canton) pair to get a
salary-intent page:

1. **Median confidence** — `data/profession-salary-medians.json` only ships a
   real, TI-scoped median for **8 of the 29** professions in
   `ALL_CANTON_PROFESSION_IDS` (`minLiveCount: 5` in Ticino at generation time):
   `ingegnere, infermiere, farmacista, ostetrica, educatore, cuoco, psicologo,
   assistente-sociale`. The other 21 (including all 5 `CANTON_ONLY_PROFESSION_IDS`)
   have no profession-specific real median — only these 8 are in scope for the new
   family. Showing a canton's all-jobs median under a profession-specific headline
   for the other 21 would misrepresent the page's own premise (a generic number
   badged as "stipendio {professione}").
2. **Real job count** — same `MIN_JOBS = 3` floor `professionCantonLandings.ts`
   already uses for the sibling job-intent family, applied per (canton, profession)
   via `aggregateProfessionJobsByCanton`.

Reproducible via `scripts/report-salary-intent-floor.mjs` (`npx tsx
scripts/report-salary-intent-floor.mjs`, added in this PR):

| Metric | Value |
|---|---|
| Cantons in scope (excl. TI — see §3) | 23 |
| Professions with real median preset | 8 / 29 |
| Theoretical max pairs (23 × 8) | 184 |
| **Post-floor pairs (≥ 3 real jobs)** | **105** |
| Pages per locale | 105 |
| **Total URLs (× 4 locales)** | **420** |

By profession (cantons clearing the floor):

| Profession | Cantons |
|---|---|
| infermiere | 22 |
| farmacista | 17 |
| ingegnere | 15 |
| psicologo | 15 |
| cuoco | 13 |
| educatore | 10 |
| assistente-sociale | 9 |
| ostetrica | 4 |

For scale/RAM context: the existing `/lavoro-{canton}-{role}/` family (all 29
professions × 23 cantons, same `MIN_JOBS` floor) emits **268 post-floor pairs ×
4 locales = 1072 pages** today, well inside the ~9.8GB build budget. Adding 420
pages (~39% of that family's size) is a bounded, comparable increment, not a
new order of magnitude.

## 2. Ticino excluded from this family (inherited precedent)

`professionCantonData.ts` already excludes TI from `PROFESSION_CANTON_KEYS` for
the job-intent family "so it doesn't collide with the dedicated legacy profession
landings at the identical slugs" (`/lavoro-ticino-{role}/`). The same exclusion
applies here, for a stronger reason — the TI job-intent pages **already carry the
salary-intent content**:

- `professionCantonLandings.ts` (the job-intent renderer used for TI via
  `professionLandingsPlugin.ts`) renders a **median-salary stat tile** per
  profession, sourced from the exact same corpus aggregation this new family
  would use.
- `professionLandingsCopy.ts:1692` already answers **"Quanto guadagna un/una
  {role} in Ticino nel 2026?"** as an FAQ item on that same page.

A `/stipendio-{professione}-ticino/` page would duplicate both, on day one, for
all 8 eligible professions. TI is out of scope for #4461; its salary-intent need
is already served.

## 3. Existing content this family must not cannibalize (non-TI)

| Existing page/system | Intent | Overlap risk | Required handling |
|---|---|---|---|
| `/lavoro-{canton}-{role}/` (`professionCantonLandings.ts`) | Job search (transactional) | Renders a median-salary stat tile for the SAME (canton, profession) pair, using the same aggregation → same number likely to appear on both pages | Not competing keywords (H1 is `"Lavoro come {role} nel Canton {canton}"`, no "stipendio"), so no title/H1 duplicate — but MUST cross-link explicitly both ways (see §4). The stat tile stays (supporting fact on a jobs page); it must not become the reason a crawler treats the two pages as duplicate content. |
| `/stipendi-{cantone}/` (`salaryStatsChCantonPages.ts`) | Salary search, canton-wide (all professions blended) | Same salary vertical, broader granularity — legitimate hub, not a duplicate | New family is the **spoke**: canton-wide page stays the hub; profession pages link up to it, canton page links down to the professions that clear the floor for it (same "*LinksPlugin" pattern as `professionCantonLandingsLinksPlugin.ts`). |
| Salary Hub evergreen articles (`salaryHubArticles.ts`) + scenario pages (`salaryHubScenarios.ts`) | Frontaliere net-salary calculator content, keyed by **gross-salary bracket** (`CHF 60'000` etc.), not profession/canton | Different keyword universe — "stipendio netto frontaliere CHF 80'000" vs "stipendio infermiere zurigo" | No canonical action needed; only a soft CTA cross-link to `/calcola-stipendio/` is appropriate (same CTA pattern already used across the site), not a hub relationship. |
| `data/blog-articles/*` | News/editorial | Grepped for "quanto guadagna" / "guadagna" — no dedicated per-profession salary articles exist there (only incidental mentions in unrelated news pieces) | No overlap found; nothing to cross-link. |

## 4. Canonical / hub-spoke rule (binding for #4461)

1. **No `Closes`/merge of pages** — job-intent and salary-intent are different
   search intent for the same entity (Google does not require canonicalizing
   distinct-intent pages targeting the same entity); both stay indexable.
2. **Explicit bidirectional cross-link, not implicit proximity:**
   - Salary-intent page → job-intent page: primary CTA "Vedi le offerte attive di
     {role} in {canton}" linking to `buildProfessionCantonPath(locale, cantonKey, id)`
     (jobs live there, not on the new page).
   - Job-intent page → salary-intent page: where the pair clears the new floor,
     upgrade the existing canton-wide CTA (`buildSalaryStatsPath`) to point at the
     profession-specific salary page instead (more precise target); fall back to
     the canton-wide page where the pair is below the salary-intent floor.
   - Canton-wide `/stipendi-{cantone}/` hub → salary-intent spokes: add a links
     block listing the professions that clear the floor for that canton (same
     mechanism as `professionCantonLandingsLinksPlugin.ts`, which also solves BFS
     reachability — the new pages need an equivalent injector or they ship
     unreachable, per that plugin's own rationale).
3. **Content must not restate the job-intent stat tile verbatim** — the
   salary-intent page's unique value is the **netto estimate** (via
   `data/swiss-canton-tax-burden.json`) and **cross-canton context** for the same
   profession, not a re-print of the lordo median already shown elsewhere.
4. **Below-floor pairs**: per `AGENTS.md` → "Static SEO Pages", any below-floor
   (canton, profession) pair among the 8 eligible professions MUST still get a
   `noindex,follow` bridge page (not a silent skip) plus the corresponding
   `searchConsoleCompat.ts` self-map entry, in the SAME PR that ships #4461.

## 5. Recommended URL pattern

Mirrors the existing per-locale "salary" word already used by
`SALARY_STATS_SECTION` (`stipendi`/`salaries`/`gehaelter`/`salaires`), singularized
to signal "one profession" vs. that family's "all professions in a canton":

| Locale | Prefix | Pattern |
|---|---|---|
| it | (none) | `/stipendio-{professione}-{cantone}/` |
| en | `/en` | `/en/salary-{profession}-{canton}/` |
| de | `/de` | `/de/gehalt-{beruf}-{kanton}/` |
| fr | `/fr` | `/fr/salaire-{profession}-{canton}/` |

Slugs for profession and canton should reuse `professionRoleKeywordAny` /
`SALARY_STATS_CANTON_SLUGS` respectively — no new slug tables, same principle
`professionCantonData.ts` already documents for the job-intent family ("no new
slug data to keep in sync").

## Non implementato (ancora)

Nessuno per lo scope di questa issue (#4460: solo conteggio + piano, "Nessuna
pagina emessa in questa issue" per vincolo esplicito). Il piano sopra è l'intero
criterio di accettazione richiesto ed è pronto come input diretto per #4461, che
implementerà il plugin.
