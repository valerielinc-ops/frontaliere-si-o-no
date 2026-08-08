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
 * ── STATUS, 2026-08-08: HALF OF THIS IS NOW DONE ───────────────────────────
 *
 * The numbers below are unchanged and still worth reading — they are why the
 * obvious implementation is wrong. What HAS changed is that the one missing
 * piece they name, a company-keyed demand table, now has a scheduled producer
 * (.github/workflows/refresh-gsc-marquee-demand.yml) and a consumer:
 * build-plugins/shared/employerDemandSignal.mjs, read by
 * employerProfilePagesPlugin.ts.
 *
 * Exactly one of the two halves is live, and the split follows the blockers
 * below rather than convenience:
 *
 *   HOLD (live). An employer already in `profiles` whose LIVE count has
 *   drifted into the bridge band keeps its indexable page if it has proven
 *   demand. This is the drift auto-downgrade at employerProfilePagesPlugin.ts,
 *   and it is safe because it only ever ADDS to the indexable set: with no
 *   demand table — the state until the weekly producer first runs — the gate
 *   is byte-identical to what it was.
 *
 *   PROMOTE (still blocked). A BelowFloorRecord still cannot become a full
 *   page, for the structural reason spelled out further down: the generator
 *   never computes cantons[]/cities[]/salaryMedianChf for it. Unchanged, and
 *   still a generator-and-plugin change made together.
 *
 *   DEMOTE (still deliberately absent). "Many postings, no demand" does NOT
 *   noindex anything here. See the last section: it belongs in
 *   trafficEvidenceFilter.ts, gated on `noindexMinAgeDays`, as a data edit
 *   with a documented revert — not as a second gate in this file.
 *
 * The measured reason `in_marquee_list` is mandatory in the new consumer is
 * the same false-positive class as the `bell-suisse-sa` case below: on a real
 * 90-day pull, 1 333 of 1 706 extracted candidates are not on the curated
 * list, and the top of that group is Basel / Valais / Salute / Logistica —
 * cantons and professions in the grammatical slot a brand occupies.
 *
 * ── WHY THE FLOOR WAS COUNTED IN ANNUNCI AND NOT IN DOMANDA ────────────────
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
 *   Promotion — needs a company-keyed demand table. DONE for the HOLD half
 *   (see the status block at the top): scripts/identify-top-marquee-by-gsc.mjs
 *   is now scheduled by refresh-gsc-marquee-demand.yml and its output,
 *   data/gsc-top-marquee-candidates.json, is committed and read at build time
 *   by employerDemandSignal.mjs. What that table still cannot do is turn a
 *   BelowFloorRecord into a full page — that is the structural blocker above,
 *   not a data one, and it is still open.
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
