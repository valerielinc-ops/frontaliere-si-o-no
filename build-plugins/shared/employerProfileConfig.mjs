/**
 * Employer-profile floors — ONE definition shared by the dataset generator
 * (scripts/build-employer-profiles.mjs) and the SSG plugin
 * (build-plugins/employerProfilePagesPlugin.ts).
 *
 * The plugin re-gates indexability on the LIVE corpus count at build time
 * (auto-downgrade to noindex on drift); if the floor lived as a literal in
 * each file the two gates could silently diverge (reviewer finding, PR #4511).
 * Plain .mjs for the same dual-consumer reason as companyProfileSlug.mjs.
 */

/** Min active postings for a full, indexable employer profile page. */
export const MIN_ACTIVE_JOBS = 5;

/** Companies with >= this but < MIN_ACTIVE_JOBS get a noindex,follow bridge. */
export const BRIDGE_FLOOR = 2;

/*
 * ── WHY THE FLOOR IS STILL COUNTED IN ANNUNCI AND NOT IN DOMANDA ───────────
 *
 * Investigated 2026-08-07. The objection is sound on its face: a job count is
 * a proxy for "is there enough here to be a page", not for "does anyone want
 * this page". A company with 2 postings and 500 searches/month deserves a real
 * page; one with 6 postings and no searches does not. The floor should be
 * f(annunci, domanda). It isn't, and the reason is attribution, not data.
 *
 * A BUILD-TIME DEMAND SOURCE EXISTS. `data/evidence-index.json` is committed
 * (19.1 MB), refreshed daily by .github/workflows/build-evidence-and-tune.yml,
 * `windowDays: 90`, and already read synchronously at build start by
 * build-plugins/shared/trafficEvidenceFilter.ts. It carries
 * `gsc.pages` (93 918 path → impressions) and `gsc.queries` (23 111 query →
 * { imp, clicks, pos, ctr, topLandingPage }). So the blocker below is NOT
 * "no data" and NOT "not available at build time".
 *
 * `gsc.pages` CANNOT DRIVE THIS GATE — it is circular. A page we mark
 * noindex earns zero impressions by construction, so its own impression count
 * can never lift it back over the floor. Page-level evidence works as a
 * demotion signal (that is what TrafficEvidenceFilter uses it for) and is
 * useless as a promotion one.
 *
 * `gsc.queries` IS THE RIGHT SIGNAL — brand demand is measured on whatever URL
 * currently serves it, so it is not circular — BUT IT HAS NO COMPANY KEY, AND
 * BOTH WAYS OF ADDING ONE FAIL:
 *
 *   1. Match the company name inside the query string. Measurably wrong. Best
 *      below-floor candidate by this method is `bell-suisse-sa` (2 postings,
 *      2 668 "job-intent" impressions) — of which 1 464, i.e. 55 %, come from
 *      "bell language school switzerland strategy transformation jobs", an
 *      unrelated organisation. One token is enough to poison the top of the
 *      ranking; two tokens (["rituals","cosmetics"]) then miss the real query
 *      shape, which is brand + intent, never the full legal name.
 *
 *   2. Attribute via `topLandingPage` (exact: the URL already contains
 *      `azienda-<slug>` / `aziende/<slug>`). Precise, but the recall collapses:
 *      16 319 of 795 098 impressions attributable at all, 123 of 717 companies
 *      with any demand, and — the number that settles it — only 10 of the 208
 *      below-floor companies get a single attributable impression. The best of
 *      those ten is `axa-svizzera`: 3 postings, 247 impressions / 90 d ≈ 82 a
 *      month, 0 clicks. THE MOTIVATING CASE (2 postings, 500 impressions/month)
 *      HAS ZERO INSTANCES IN THIS CORPUS. A demand-lowered floor would have
 *      fired on nothing real, or on `bell-suisse-sa`, which is the false
 *      positive.
 *
 * A SECOND, STRUCTURAL BLOCKER, independent of the data. Below-floor companies
 * reach the plugin as `BelowFloorRecord` — { slug, name, activeJobs, sector,
 * canton }. scripts/build-employer-profiles.mjs never computes cantons[],
 * cities[], salaryMedianChf or trend for them, so employerProfilePagesPlugin
 * literally cannot render a full page for one without re-deriving the
 * generator's aggregates on the plugin side. That is the exact divergence this
 * file exists to prevent (see the header). Promoting on demand therefore means
 * changing the generator too, in the same change, not the plugin alone.
 *
 * AND THE DEMOTION HALF IS PREMATURE BY A WINDOW. On 2026-08-07 the titles for
 * this whole surface were rewritten off editorial phrasing onto the phrase GSC
 * says people type (see the block comment in employerProfilePagesPlugin.ts:
 * "working at" had literally zero queries in 90 days, "arbeiten bei" 182 with
 * zero clicks). "Zero demand" measured before that lands is a statement about
 * the old <title>, not about the company. Demoting on it would also be
 * self-defeating: a noindex page cannot earn the demand we just retitled it to
 * win.
 *
 * WHAT WOULD UNBLOCK EACH HALF, so this is a decision and not a shrug:
 *
 *   Promotion — needs a company-keyed demand table. The extractor already
 *   exists: scripts/identify-top-marquee-by-gsc.mjs pulls 90 d of queries and
 *   parses employer names out of "{company} jobs" / "lavoro {company}" /
 *   "{company} carriere" shapes, cross-referencing data/marquee-companies-list.json
 *   (which IS committed). Its output, data/gsc-top-marquee-candidates.json, is
 *   not committed and no workflow invokes it, so it is not build input today.
 *   Scheduling it and committing the artifact is a workflow change.
 *
 *   Demotion — do NOT hand-roll it here. build-plugins/shared/trafficEvidenceFilter.ts
 *   already exposes `FilterDecision.noindex`, gated on `noindexMinAgeDays`
 *   against data/url-first-seen.json precisely so a freshly emitted URL is not
 *   punished for being new, and sized by a one-number edit in
 *   data/url-pruning-approved-patterns.json. Registering an employer-profile
 *   `urlClass` there is a data edit with a documented revert, which is the
 *   right shape for a change that can silently deindex a few hundred URLs.
 *
 * Reproduce the measurements above:
 *   node -e "…" over data/evidence-index.json `gsc.queries` +
 *   data/employer-profiles.json (`profiles` 509, `belowFloor` 208 at
 *   generatedAt 2026-08-06). Both files are committed; note that a sparse
 *   worktree does not materialise data/, so read via `git show HEAD:<path>`.
 */
