/**
 * professionJobsFloor.ts — the SINGLE producer of the "does this profession
 * page have enough real openings to deserve a full, indexable page?" decision.
 *
 * Two page families ask that question and, until #5322, only one of them
 * actually asked it:
 *
 *   - `professionCantonLandings.ts`  → `/lavoro-{canton}-{role}/`  (23 cantons)
 *     gated on a real job count since day one.
 *   - `professionLandingsPlugin.ts`  → `/lavoro-ticino-{role}/`    (legacy TI)
 *     gated ONLY on `MIN_INDEXABLE_WORDS`, i.e. on the word count of templated
 *     prose that is present whether or not a single opening exists. The result
 *     was live pages titled "Lavoro Cameriere Ticino — offerte e stipendio"
 *     answering with zero `JobPosting`, no `<meta name="robots">` (so indexable
 *     by default) and body copy that literally says "nessuna offerta" (#5322).
 *
 * The floor lived inside the per-canton emitter as private module state, so the
 * legacy family could not reuse it without copying it — and a copied floor is
 * how the two sides drifted apart in the first place. It lives here now;
 * neither emitter owns a private threshold or a private bridge renderer.
 *
 * ## Why the legacy family additionally gets a grace window
 *
 * The two families are NOT symmetric in what flipping costs:
 *
 *   - A per-canton pair below floor has (almost always) never had a full page:
 *     the emitter bridges it from the first build. Nothing is lost by bridging
 *     it again.
 *   - Every legacy TI page is already live, already crawled and already
 *     ranking. Flipping one to `noindex` on the strength of a single build's
 *     count trades a thin-content defect for a ranking loss — and a job feed is
 *     exactly the kind of input that dips for reasons that have nothing to do
 *     with the market (a crawler failing one round, a source rate-limiting, a
 *     weekend with no new postings).
 *
 * So the legacy family measures "seen active in the last N days", not "active
 * in this build". `expiredJobsWithin` supplies the second half of that union
 * from `data/expired-jobs.json`, where every job that leaves the active set
 * lands with `expiredAt = now` (`scripts/lib/expired-jobs-archive.mjs`). A
 * crawler that fails a round therefore pushes its jobs into the archive rather
 * than out of existence, and they keep counting for the whole window.
 *
 * The per-canton family keeps `graceDays: 0` — same floor, same bridge, no
 * behaviour change for the 667 pairs it emits (#5323 is explicitly not a code
 * defect). The asymmetry is a parameter, not a fork.
 */
import { getCantonDisplayName, type CantonDisplayLocale } from './cantonDisplay';
import { renderSalaryStatsBridge } from './salaryStatsBridge';
import {
  professionRoleKeywordAny,
  type AnyProfessionId,
  type ProfessionLocale,
} from '../professionLandingsData';

/**
 * Minimum real active openings for a (canton, profession) page to be emitted
 * as a full indexable page. Shared by both families — CLAUDE.md non-negotiable
 * #1 (never lower a threshold) applies to this constant.
 */
export const MIN_JOBS = 3;

/**
 * Grace window, in days, over which the legacy TI family counts openings that
 * have already expired.
 *
 * 30 days, chosen against the real corpus rather than picked round:
 *
 *   - It is the same window the codebase already treats as "wide enough to
 *     ride out a temporarily-absent feed entry (crawler hiccup, weekend
 *     off-shift, manual review)" for the previous-slug winners registry
 *     (`jobsSeoPagesPlugin.ts`, PREV_SLUG_WINNER_TTL_DAYS), so the site has one
 *     answer to "how long is a dip still a dip", not two.
 *   - Measured on the 2026-08-08 corpus it separates the two populations
 *     cleanly. Of the 10 legacy professions below floor on live counts alone,
 *     7 have enough recently-expired TI postings to clear it (cameriere 0→4,
 *     assistente-sociale 0→6, macellaio 2→9, saldatore 2→5, tecnico-radiologia
 *     2→5, logopedista 0→3, architetto 2→4) and 3 do not (assistente-dentale
 *     0→0, ottico-optometrista 1→1, farmacista 1→1). The three that stay below
 *     are below at 14, 30 AND 60 days — they are structurally empty, not dipping.
 *   - It sits comfortably inside `EXPIRED_JOBS_CAP` (5000 most-recent entries,
 *     ≈80 days of churn at the observed rate), so the window is never silently
 *     truncated by the archive cap. If that cap is ever lowered below ~2000,
 *     this window shrinks with it — they are coupled.
 */
export const PROFESSION_FLOOR_GRACE_DAYS = 30;

/** Localised profession label (Title-cased role keyword is good enough). */
export function professionLabel(locale: ProfessionLocale, id: AnyProfessionId): string {
  const role = professionRoleKeywordAny(locale, id).replace(/-/g, ' ');
  return role.charAt(0).toUpperCase() + role.slice(1);
}

interface BridgeCopy {
  title: (role: string, canton: string) => string;
  body: (role: string, canton: string) => string;
  cta: (canton: string) => string;
}

export const PROFESSION_BRIDGE_COPY: Record<ProfessionLocale, BridgeCopy> = {
  it: {
    title: (r, c) => `Lavoro ${r} Canton ${c}`,
    body: (r, c) => `Al momento non ci sono abbastanza offerte attive per ${r} nel Canton ${c} da mostrare una pagina dedicata. Consulta stipendi e mercato del lavoro nel Canton ${c}.`,
    cta: (c) => `Vai ai dati del Canton ${c}`,
  },
  en: {
    title: (r, c) => `${r} jobs in Canton ${c}`,
    body: (r, c) => `There aren't enough active ${r} openings in Canton ${c} right now for a dedicated page. See salary and job-market data for Canton ${c}.`,
    cta: (c) => `Go to Canton ${c} data`,
  },
  de: {
    title: (r, c) => `${r}-Stellen im Kanton ${c}`,
    body: (r, c) => `Im Kanton ${c} gibt es derzeit nicht genug aktive ${r}-Stellen fur eine eigene Seite. Lohn- und Arbeitsmarktdaten fur den Kanton ${c} ansehen.`,
    cta: (c) => `Zu den Daten fur Kanton ${c}`,
  },
  fr: {
    title: (r, c) => `Emplois ${r} dans le canton ${c}`,
    body: (r, c) => `Il n'y a pas assez d'offres actives pour ${r} dans le canton ${c} pour une page dediee actuellement. Consultez les donnees salariales et du marche du travail du canton ${c}.`,
    cta: (c) => `Voir les donnees du canton ${c}`,
  },
};

/**
 * Below-floor bridge: a (canton, profession) pair that doesn't meet MIN_JOBS
 * this build gets a noindex,follow canonical bridge instead of a hard 404.
 * Job counts fluctuate build to build, and this exact path may have been
 * indexed on a prior build when it did meet the floor (same orphaned-static-
 * page class fixed for weekly-employers company-city hubs via
 * findOrphanedCompanyCityPairs in weeklyEmployersPlugin.ts). The bridge
 * targets the same per-canton salary-stats hub the live page's own CTA links
 * to (buildSalaryStatsPath) — that family is emitted unconditionally for
 * every canton regardless of job counts, so it's always a safe target.
 */
export function renderProfessionBelowFloorBridge(
  locale: ProfessionLocale,
  cantonKey: string,
  id: AnyProfessionId,
): string {
  const cantonName = getCantonDisplayName(cantonKey, locale as CantonDisplayLocale);
  const role = professionLabel(locale, id);
  const copy = PROFESSION_BRIDGE_COPY[locale];
  return renderSalaryStatsBridge(locale, cantonKey, {
    title: copy.title(role, cantonName),
    description: copy.body(role, cantonName),
    ctaLabel: copy.cta(cantonName),
  });
}

export interface JobsFloorInput {
  /** Openings matching this (canton, profession) in the current dataset. */
  readonly liveCount: number;
  /**
   * Openings that matched recently but have since expired, inside the grace
   * window. `null` means "the expired archive could not be read this build" —
   * see `meetsJobsFloor` for why that is not the same as zero.
   */
  readonly recentlyExpiredCount?: number | null;
}

export interface JobsFloorVerdict {
  readonly meetsFloor: boolean;
  /** liveCount + recentlyExpiredCount — what was actually compared to MIN_JOBS. */
  readonly effectiveCount: number;
  /** True when the verdict was forced open because the grace signal was missing. */
  readonly graceUnavailable: boolean;
}

/**
 * The floor decision, in one place.
 *
 * Fail-OPEN on a missing grace signal, deliberately. The two failure directions
 * are not equally bad: wrongly keeping a thin page indexed for one more build
 * costs a little crawl budget, while wrongly flipping a ranking page to
 * `noindex` costs traffic that takes weeks to earn back. So when
 * `recentlyExpiredCount` is `null` — `data/expired-jobs.json` absent, truncated
 * or unparseable, which is precisely the shape a broken build has — no page is
 * flipped at all. This mirrors `trafficEvidenceFilter.ts`, which likewise never
 * noindexes a URL that is merely *missing* from its evidence file.
 */
export function meetsJobsFloor(input: JobsFloorInput): JobsFloorVerdict {
  const { liveCount, recentlyExpiredCount = 0 } = input;
  if (recentlyExpiredCount === null) {
    return { meetsFloor: true, effectiveCount: liveCount, graceUnavailable: true };
  }
  const effectiveCount = liveCount + recentlyExpiredCount;
  return {
    meetsFloor: effectiveCount >= MIN_JOBS,
    effectiveCount,
    graceUnavailable: false,
  };
}
