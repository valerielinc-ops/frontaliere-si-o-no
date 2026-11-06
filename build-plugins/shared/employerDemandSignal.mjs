/**
 * Company-keyed search demand, as a set of slugs the employer-profile floor is
 * allowed to HOLD indexable when the job count alone would demote them.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * `employerProfileConfig.mjs` counts the indexability floor in ANNUNCI and its
 * block comment says, with the measurements, why it could not yet count
 * DOMANDA: `gsc.pages` in data/evidence-index.json is circular as a promotion
 * signal (a noindex page earns zero impressions by construction) and
 * `gsc.queries` — the non-circular half — carries no company key. That comment
 * names exactly one missing piece: a company-keyed demand table, produced by
 * scripts/identify-top-marquee-by-gsc.mjs, committed by
 * .github/workflows/refresh-gsc-marquee-demand.yml. That artifact now has a
 * scheduled producer, so this module is its first consumer.
 *
 * ── THE ONE DIRECTION THIS SIGNAL IS ALLOWED TO MOVE ───────────────────────
 * It can only ever ADD a page to the indexable set, never remove one. The
 * caller composes it as `liveActive >= MIN_ACTIVE_JOBS || heldByDemand`, so
 * every degradation in this file — missing artifact, unparseable artifact,
 * stale artifact, truncated pull, empty table — collapses to the SAME empty
 * set, and an empty set reduces that expression to exactly today's floor.
 *
 * That property is not a convenience, it is the safety argument. A missing
 * demand reading is ABSENCE OF SIGNAL, not a measurement of zero demand, and
 * the difference matters because the failure modes are not symmetric: holding
 * a thin page indexable for one build costs a little crawl budget, while
 * demoting a few hundred earning URLs on a transient bad read costs rankings
 * that take months to come back. So this module never demotes anything, and
 * `employerProfileConfig.mjs` already records where the demotion half belongs
 * when someone wants it: registering an employer-profile `urlClass` in
 * build-plugins/shared/trafficEvidenceFilter.ts, which is gated on
 * `noindexMinAgeDays` and revertible by a one-number data edit.
 *
 * ── WHY `in_marquee_list` IS MANDATORY, AND NOT A NICETY ───────────────────
 * Measured on a real 90-day pull (2026-05-10 → 2026-08-08, 78 796 query rows):
 * the extractor produced 1 706 candidates, of which only 373 cross-reference
 * data/marquee-companies-list.json. The top of the OTHER 1 333, by clicks:
 *
 *     Basel · Valais · Salute · Logistica · Crans Montana · Psychologie ·
 *     Etudiant
 *
 * Cantons, regions and professions — not employers. The extractor's stop-list
 * cannot catch these because they occupy the same grammatical slot a brand
 * does ("lavoro Basel" parses exactly like "lavoro Roche"). This is the same
 * false-positive class `employerProfileConfig.mjs` measured on `bell-suisse-sa`
 * (55 % of its impressions came from an unrelated language school). The
 * hand-curated list is the only thing in the pipeline that knows what a company
 * IS, so a row that is not on it does not get to move a floor.
 *
 * ── AND WHY DEMAND IS SUMMED PER SLUG ──────────────────────────────────────
 * The table is keyed by extracted NAME, and one employer produces many: the
 * same pull carries 33 rows folding onto `migros`, 32 onto `coop`, 18 onto
 * `hopital-du-valais`. They are distinct query groups for one page, so their
 * demand adds. Taking the max instead would under-read the biggest brands by
 * roughly the factor they are fragmented by.
 */

import fs from 'node:fs';
import path from 'node:path';

import { canonicalCompanyProfileSlug } from './companyProfileSlug.mjs';

/** Where refresh-gsc-marquee-demand.yml commits the table. */
export const DEMAND_TABLE_PATH = 'data/gsc-top-marquee-candidates.json';

/**
 * Demand bar, over the extractor's 90-day window, summed per canonical slug.
 *
 * Calibrated on the pull described above, against data/employer-profiles.json
 * (509 profiles / 208 below-floor). Sensitivity, in profiles cleared:
 *
 *     clicks >=  5 || impressions >=  100  →  32
 *     clicks >= 10 || impressions >=  250  →  20
 *     clicks >= 25 || impressions >=  500  →  12
 *     clicks >= 50 || impressions >= 1000  →   7
 *
 * The first is chosen: ~33 impressions/month is a low bar in absolute terms,
 * but every row that reaches it has already survived the marquee
 * cross-reference, and the only thing clearing it buys is keeping a page that
 * ALREADY EXISTS out of noindex while its employer is between hiring rounds.
 * Moving the bar is a one-line edit here, and the numbers above say what it
 * costs.
 */
export const DEMAND_MIN_CLICKS = 5;
export const DEMAND_MIN_IMPRESSIONS = 100;

/**
 * How old the table may be before it stops counting as a reading.
 *
 * The producer is weekly (`cron: '55 2 * * 1'`), so this tolerates four missed
 * runs. Past that the table is unattended rather than merely old, and an
 * unattended table is not evidence — it degrades to the empty set, which is
 * today's floor. Generous on purpose: the GSC window behind the file is 90
 * days, so a three-week-old reading still describes real demand, and the cost
 * of expiring it too eagerly is paid in the only direction this signal moves.
 */
export const DEMAND_MAX_AGE_DAYS = 35;

/**
 * The whole decision as a pure function of the parsed table, so the rule is
 * unit-testable without a filesystem.
 *
 * Returns an EMPTY SET — never null, never a throw — for every case it cannot
 * prove: not an object, no `candidates` array, `_truncated`, missing or
 * unparseable `_generatedAt`, or a `_generatedAt` older than
 * DEMAND_MAX_AGE_DAYS.
 *
 * @param {unknown} table Parsed contents of DEMAND_TABLE_PATH.
 * @param {{ now?: Date, maxAgeDays?: number }} [opts]
 * @returns {Set<string>} canonical employer slugs with proven demand
 */
export function selectDemandBackedSlugs(table, opts = {}) {
  const empty = new Set();
  if (!table || typeof table !== 'object') return empty;

  const candidates = /** @type {{ candidates?: unknown }} */ (table).candidates;
  if (!Array.isArray(candidates)) return empty;

  // A truncated pull hit the pagination cap with pages still full. GSC orders
  // rows by clicks descending, so what a truncated set is missing is precisely
  // the low-click tail — where the employers this file exists to find live.
  // Reading it anyway would silently treat "we stopped fetching" as "no more
  // demand"; the extractor sets this flag so a consumer can refuse instead.
  if (/** @type {{ _truncated?: unknown }} */ (table)._truncated === true) return empty;

  const generatedAt = Date.parse(String(/** @type {{ _generatedAt?: unknown }} */ (table)._generatedAt ?? ''));
  if (!Number.isFinite(generatedAt)) return empty;
  const now = (opts.now instanceof Date ? opts.now : new Date()).getTime();
  const maxAgeDays = typeof opts.maxAgeDays === 'number' ? opts.maxAgeDays : DEMAND_MAX_AGE_DAYS;
  const ageDays = (now - generatedAt) / 86_400_000;
  // A table from the future is a clock problem, not a reading. Both ends fail
  // closed, and closed here means "today's floor".
  if (!(ageDays >= 0) || ageDays > maxAgeDays) return empty;

  /** @type {Map<string, { clicks: number, impressions: number }>} */
  const bySlug = new Map();
  for (const row of candidates) {
    if (!row || typeof row !== 'object') continue;
    // Not on the hand-curated company list ⇒ not proven to be a company at
    // all. See the header: the majority of unmatched rows are cantons and
    // professions.
    if (row.in_marquee_list !== true) continue;
    const name = typeof row.company_name === 'string' ? row.company_name : '';
    if (!name) continue;
    // The ONE normalisation the hub URL, the dataset and the CompanyAlert key
    // all share. Re-slugifying here is the drift employerProfileConfig.mjs
    // exists to prevent.
    const slug = canonicalCompanyProfileSlug(name);
    if (!slug) continue;
    const clicks = Number(row.estimated_clicks);
    const impressions = Number(row.estimated_impressions);
    const acc = bySlug.get(slug) || { clicks: 0, impressions: 0 };
    if (Number.isFinite(clicks) && clicks > 0) acc.clicks += clicks;
    if (Number.isFinite(impressions) && impressions > 0) acc.impressions += impressions;
    bySlug.set(slug, acc);
  }

  const proven = new Set();
  for (const [slug, { clicks, impressions }] of bySlug) {
    if (clicks >= DEMAND_MIN_CLICKS || impressions >= DEMAND_MIN_IMPRESSIONS) proven.add(slug);
  }
  return proven;
}

/**
 * Read the committed demand table and reduce it to proven slugs.
 *
 * Never throws and never blocks a build: a missing file is the NORMAL state
 * until the weekly producer has run once, and it has to be indistinguishable
 * from "no employer cleared the bar".
 *
 * @param {string} rootDir Repo root.
 * @param {{ now?: Date, maxAgeDays?: number }} [opts]
 * @returns {Set<string>}
 */
export function loadEmployerDemandSlugs(rootDir, opts = {}) {
  try {
    const p = path.resolve(rootDir, DEMAND_TABLE_PATH);
    if (!fs.existsSync(p)) return new Set();
    return selectDemandBackedSlugs(JSON.parse(fs.readFileSync(p, 'utf-8')), opts);
  } catch {
    return new Set();
  }
}
