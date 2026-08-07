/**
 * employerSuggestions — «altre aziende da seguire», ranked from the ONE
 * employer dataset this site actually publishes (issue #5012, fase 3).
 *
 * ── WHAT THE RUNTIME CAN READ, MEASURED RATHER THAN ASSUMED ────────────────
 * Fase 3 asks for a recommender. The honest first question is what an employer
 * recommender could possibly be built on HERE, and the answer is one file:
 *
 *   · `/data/employer-job-counts.json` — slug → active postings, ~20 KB, the
 *     map `employerProfilePagesPlugin` emits and `hooks/useEmployerHub.ts`
 *     already fetches and module-caches. 717 employers at the 2026-08-06
 *     build (509 above the MIN_ACTIVE_JOBS floor + 208 below-floor bridges).
 *     TWO fields per employer: the slug, and how many ads are open.
 *
 * Everything richer is BUILD INPUT and is deliberately not published:
 *
 *   · `data/employer-profiles.json` (447 KB) has `sector`, `cantons[]`,
 *     `cities[]`, `salaryMedianChf`, `trend` — i.e. the real affinity axes.
 *     The plugin's own comment explains why only the two-field slice ships:
 *     «shipping it to the CDN for one private page would be wildly out of
 *     proportion». Its `sector` would also disappoint: 607/717 employers carry
 *     one, but the vocabulary is free text — «Sanità / Ospedali» covers 167
 *     while dozens of values occur exactly once («Rail vehicle manufacturing»,
 *     «Cosmetica / Retail»). It is a label, not a taxonomy.
 *   · `/data/jobs-<locale>-index.json` IS published and carries `sector`,
 *     `canton` and `company` per ad — and weighs 27,8 MB (measured on
 *     cdn.frontaliereticino.ch, 2026-08-07). Downloading the whole corpus to
 *     decorate the bottom of a settings page is not a trade this page may make.
 *   · `/data/jobs-stats.json` is small (38 KB) but its `leaders
 *     .topCompaniesActive` is EIGHT entries keyed by crawler key, not by the
 *     canonical `/aziende/<slug>/` slug CompanyAlert persists. Too few to rank
 *     five unfollowed employers, and keyed on the wrong token.
 *
 * ── SO THE CRITERION IS DELIBERATELY POOR, AND SAYS SO ─────────────────────
 * With slug + count and nothing else, the defensible ranking is «the employers
 * hiring most right now that you do not already follow». That is the floor of
 * this module and what it degrades to in every uncertain case.
 *
 * On top of it sits ONE re-ranking signal that costs no new data: employers
 * whose slug shares a DISTINCTIVE token with an employer you already follow go
 * first. `hirslanden-klinik` pulls up `klinik-barmelweid`, `berit-klinik`,
 * `merian-iselin-klinik`; `ospedale-regionale-lugano` pulls up the Lugano care
 * institutions; `banca-stato-ticino` pulls up `corner-banca` and the «sede
 * Ticino» employers. (Checked against the real 717-slug corpus.)
 *
 * Be precise about what that signal is NOT: it is not a sector taxonomy and it
 * cannot become one. It is lexical overlap on a URL slug, and it mixes two
 * axes — industry (`klinik`, `spital`, `spitex`, `banca`) and geography
 * (`ticino`, `lugano`, `basel`). Geography is kept on purpose: for a reader of
 * a site about cross-border commuting, «another employer with a Ticino site»
 * is at least as relevant an affinity as «another hospital».
 *
 * Two guards keep it from degenerating into noise:
 *   · a stoplist of legal forms and country words (`group`, `genossenschaft`,
 *     `stiftung`, `schweiz`, `switzerland`, …) — these connect employers that
 *     have nothing in common but a company registry;
 *   · a rarity cap: a token carried by more than FAMILY_TOKEN_MAX_SHARE of the
 *     corpus is not a family, it is a filler word. At 717 employers the cap is
 *     35, which admits `klinik` (24), `landi` (23), `spital` (20) and rejects
 *     `ag` (151). Tokens shorter than MIN_TOKEN_LENGTH go too — `ag`, `sa`,
 *     `de`, `la`, `st` are all in the top twenty by frequency.
 *
 * When no seed token survives those guards the score is 0 for everyone and the
 * order collapses to pure activity — the poor criterion above, which is the
 * intended failure mode and not an error.
 *
 * ── WHAT IT GETS WRONG, RUN AGAINST THE REAL 717 SLUGS ────────────────────
 * Three weaknesses were visible immediately and are not fixable at this data
 * level, so they are written down rather than hidden:
 *
 *   · COLD START HAS NO GEOGRAPHY. With nothing followed the top five are
 *     `coop-genossenschaft` (1043 ads), `zurich-insurance-sede-ticino` (601),
 *     `rituals-cosmetics-switzerland` (435), `kanton-aargau` (417),
 *     `stadt-zurich` (401) — i.e. the largest Swiss-wide employers, three of
 *     them with almost no Ticino presence, on a site whose readers commute into
 *     one canton. The published map has no canton field; `cantons[]` exists
 *     only in the unpublished build input. This is THE thing to fix, and it is
 *     fixed by publishing one more field, not by cleverness here.
 *   · NEAR-DUPLICATE BRAND ENTITIES. Following `coop-genossenschaft` proposes
 *     `coop`, `coop-ristorante`, `coop-city`, `jumbo-division-der-coop-
 *     genossenschaft` — legally distinct employers in the corpus, barely
 *     distinguishable to a reader. The brand fold in
 *     `canonicalCompanyProfileSlug` collapses declared aliases only.
 *   · ONE WORD CAN CROSS A BORDER. `cantonale` links
 *     `amministrazione-cantonale-ticino` to `banque-cantonale-vaudoise`: same
 *     kind of institution, wrong canton. Lexical overlap cannot tell the
 *     difference, and pretending otherwise is exactly the fake ranking this
 *     module is written to avoid.
 *
 * ── NO FETCH LIVES HERE, ON PURPOSE ───────────────────────────────────────
 * This module is a pure function of a map somebody else already loaded.
 * `/aziende-seguite/` fetches that map for its per-row «N annunci attivi» line
 * through `fetchEmployerHubCounts()` (hooks/useEmployerHub.ts, one fetch per
 * session, module-cached, shared with every job surface that links a hub), and
 * hands the result straight to `rankEmployerSuggestions`. So suggestions cost
 * ZERO additional requests, and the page's promise — that nothing decorative
 * may delay or break the list people come here to unsubscribe from — holds by
 * construction: `counts === null` (in flight, or the fetch failed) yields an
 * empty array and the section simply does not render.
 */

import { MIN_ACTIVE_JOBS } from '@/build-plugins/shared/employerProfileConfig.mjs';

/** One proposed employer, in the order it should be shown. */
export interface EmployerSuggestion {
  /** Canonical `/aziende/<slug>/` slug — the same token CompanyAlert persists. */
  slug: string;
  /** Active postings the last build counted for this employer. */
  activeJobs: number;
  /**
   * The distinctive tokens this employer shares with something the user
   * follows, or `[]` when it was picked on activity alone.
   *
   * Not rendered — a raw slug token is not copy in any of the four locales.
   * It exists so the ranking is auditable in a test instead of being a black
   * box, which is the difference between a criterion and a vibe.
   */
  sharedTokens: string[];
}

/**
 * How many to propose. Five: enough that a reader who follows one employer has
 * a real choice, few enough that the section stays a footnote under the list
 * it is attached to. Each one mounts a CompanyFollowCta, so this is also the
 * ceiling on how many buttons the page adds.
 */
export const DEFAULT_SUGGESTION_LIMIT = 5;

/**
 * Shortest token that may carry a family signal.
 *
 * Three, because the two-character tokens in this corpus are precisely the
 * ones that mean nothing: `ag` (151 employers), `sa` (29), `de` (24), `la`
 * (11), `st` (8). Not one of them says anything about who an employer is.
 */
export const MIN_TOKEN_LENGTH = 3;

/**
 * A token carried by more than this share of the corpus is filler, not family.
 *
 * Expressed as a fraction rather than a count so the rule survives the corpus
 * growing: the map had 717 employers on 2026-08-06 and is regenerated on every
 * build. 5 % is calibrated on the real distribution — it admits the genuine
 * families (`klinik` 24, `landi` 23, `spital` 20, `elektro` 20, `migros` 27,
 * `genossenschaft` 14 were it not stoplisted) and excludes `ag`, which alone
 * would connect a fifth of the corpus to itself.
 */
export const FAMILY_TOKEN_MAX_SHARE = 0.05;

/**
 * Tokens that describe a company's PAPERWORK, not its work.
 *
 * Legal forms, country names and corporate filler. Each one really occurs in
 * this corpus (counts measured 2026-08-06 over the 717 emitted slugs) and each
 * would otherwise link employers whose only relationship is a registry entry:
 * `group` (25), `genossenschaft` (14), `schweiz` (10), `switzerland` (9),
 * `stiftung` (9), `swiss` (7), `suisse` (7), `international` (5).
 *
 * The rarity cap alone would not catch these — they sit comfortably under 5 %.
 * Rarity and meaninglessness are different properties, so they need different
 * guards.
 */
export const GENERIC_SLUG_TOKENS: ReadonlySet<string> = new Set([
  // legal forms
  'ag', 'sa', 'sagl', 'sarl', 'srl', 'spa', 'gmbh', 'ltd', 'inc', 'plc', 'nv', 'bv',
  'holding', 'group', 'groupe', 'gruppo', 'genossenschaft', 'stiftung', 'fondazione',
  'fondation', 'verein', 'cooperativa', 'societa',
  // country / nationality
  'swiss', 'suisse', 'svizzera', 'schweiz', 'switzerland', 'ch', 'international',
  // corporate filler
  'services', 'service', 'servizi', 'solutions', 'sede', 'company', 'consulting',
  // grammar words that survive slugification
  'und', 'der', 'die', 'das', 'del', 'della', 'delle', 'dei', 'les', 'des', 'the',
  'and', 'von', 'fur', 'per', 'con',
]);

/** Options for {@link rankEmployerSuggestions}. */
export interface SuggestionOptions {
  /** How many to return. Defaults to {@link DEFAULT_SUGGESTION_LIMIT}. */
  limit?: number;
  /**
   * Minimum active postings to be proposable. Defaults to `MIN_ACTIVE_JOBS`,
   * the SAME floor `employerProfilePagesPlugin` uses to decide who gets a full
   * `/aziende/<slug>/` page instead of a `noindex` bridge with no job list.
   *
   * Not an arbitrary quality bar: it makes both halves of a suggestion card
   * true at once. The card links the hub, and below the floor that hub lists
   * nothing; and «follow them, they are hiring» is a weak claim about an
   * employer with two open ads. The map deliberately includes below-floor
   * employers (the followed rows above show their real, small count) — this is
   * where they are filtered back out.
   */
  minActiveJobs?: number;
}

/**
 * Slug → its distinct tokens, lowercase, empties dropped.
 *
 * The slug is already the output of `canonicalCompanyProfileSlug` (lowercase
 * ASCII, non-alphanumeric runs collapsed to `-`), so splitting on `-` is the
 * whole tokenizer. No second normalisation is introduced here — that is the
 * drift #5151 spent its review deleting four copies of.
 */
export function slugTokens(slug: string): string[] {
  return Array.from(new Set(String(slug || '').split('-').filter(Boolean)));
}

/**
 * The whole decision, as a pure function of the published map.
 *
 * @param counts   `/data/employer-job-counts.json` as loaded by
 *                 `fetchEmployerHubCounts()`, or `null` while it is in flight
 *                 or after a failed fetch.
 * @param followed The slugs the user already follows (`specificCompanyKey` on
 *                 their CompanyAlert rows). Empty is the interesting case, not
 *                 an edge case — see the cold-start note below.
 *
 * Returns `[]` — never throws, never partially fills — whenever it cannot do
 * better: no map, an empty map, or nothing left once the followed employers
 * and the below-floor ones are removed.
 */
export function rankEmployerSuggestions(
  counts: Record<string, number> | null | undefined,
  followed: readonly string[],
  options: SuggestionOptions = {},
): EmployerSuggestion[] {
  const limit = options.limit ?? DEFAULT_SUGGESTION_LIMIT;
  const floor = options.minActiveJobs ?? MIN_ACTIVE_JOBS;
  if (!counts || typeof counts !== 'object' || limit <= 0) return [];

  const universe = Object.keys(counts);
  if (universe.length === 0) return [];

  const alreadyFollowed = new Set(followed.filter(Boolean).map((s) => String(s)));

  const candidates = universe.filter((slug) => {
    const n = counts[slug];
    return typeof n === 'number' && n >= floor && !alreadyFollowed.has(slug);
  });
  if (candidates.length === 0) return [];

  // Document frequency over the WHOLE corpus, not over the candidates: how
  // distinctive a token is, is a property of the corpus, and computing it on a
  // set that shrinks as the user follows more employers would make the same
  // token qualify or not depending on who is looking.
  const documentFrequency = new Map<string, number>();
  for (const slug of universe) {
    for (const token of slugTokens(slug)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const maxFamilySize = Math.max(2, Math.floor(universe.length * FAMILY_TOKEN_MAX_SHARE));

  // Seed tokens: what the employers you follow are "made of", minus everything
  // that cannot carry meaning. `df >= 2` is not a quality filter but an
  // arithmetic one — a token no other employer has can never match anything.
  const seedTokens = new Set<string>();
  for (const slug of alreadyFollowed) {
    for (const token of slugTokens(slug)) {
      if (token.length < MIN_TOKEN_LENGTH) continue;
      if (GENERIC_SLUG_TOKENS.has(token)) continue;
      const df = documentFrequency.get(token) ?? 0;
      if (df < 2 || df > maxFamilySize) continue;
      seedTokens.add(token);
    }
  }

  const scored = candidates.map((slug) => {
    const shared = seedTokens.size
      ? slugTokens(slug).filter((token) => seedTokens.has(token))
      : [];
    return { slug, activeJobs: counts[slug] as number, sharedTokens: shared.sort() };
  });

  // One sort, two tiers by construction: family first (more shared tokens
  // wins), then the plain "most active you don't follow" the whole module
  // degrades to when `sharedTokens` is empty for everyone. The slug tie-break
  // is what makes the output deterministic — without it two employers with the
  // same count would swap places between reads of an unordered JSON object,
  // and the section would reshuffle itself on every render.
  scored.sort((a, b) => {
    if (b.sharedTokens.length !== a.sharedTokens.length) {
      return b.sharedTokens.length - a.sharedTokens.length;
    }
    if (b.activeJobs !== a.activeJobs) return b.activeJobs - a.activeJobs;
    return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
  });

  return scored.slice(0, limit);
}
