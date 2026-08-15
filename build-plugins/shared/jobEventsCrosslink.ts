/**
 * Reverse crosslink: job-listing SEO pages (`jobsSeoPagesPlugin.ts`) -> nearby
 * evento pages. Issue #3646 (epic #3125) — the one item PR #3696 declared
 * open in "Non implementato (ancora)": that PR shipped evento -> lavoro /
 * comune / articoli crosslinks (`eventsSeoPagesPlugin.ts`), but not the
 * reverse direction, citing the risk of editing a 12.9k-line/~63%-revenue
 * file without a dedicated impact analysis.
 *
 * Reuses the SAME data + matching primitives the evento pages themselves
 * use (AGENTS.md #6 — one source of truth, no second comune-matching
 * implementation): `loadEventsDataset` / `upcomingEvents` / `normalizeText`
 * / `slugifyComune` / `eventsBasePathForCanton` from
 * `scripts/lib/events-utils.mjs`. Direction is inverted here: FROM a
 * job-listing page (comune + canton) TO the matching evento comune page, or
 * the canton hub page when the comune itself has no upcoming event but the
 * canton does elsewhere — never the other way.
 *
 * Kept isolated in its own module (not inlined into jobsSeoPagesPlugin.ts,
 * which has zero pre-existing crosslink hook) so the render path only gets
 * a single interpolated function call per page, not new inline branching in
 * the revenue-critical file.
 */
import {
  loadEventsDataset,
  upcomingEvents,
  normalizeText,
  slugifyComune,
  eventsBasePathForCanton,
} from '../../scripts/lib/events-utils.mjs';
import { escHtml } from './htmlEscape';
import { BUILD_DATE_STAMP } from '../constants';

export type CrosslinkLocale = 'it' | 'en' | 'de' | 'fr';

export interface NearbyEventSourceEvent {
  readonly comune?: string;
  readonly canton?: string;
  readonly startDate?: string;
  readonly endDate?: string;
}

export type NearbyEventMatch =
  | { readonly kind: 'comune'; readonly comune: string; readonly canton: string }
  | { readonly kind: 'canton'; readonly canton: string }
  | null;

/**
 * Pure matcher — given an already upcoming-filtered event list, decides
 * whether `comuneDisplay` (within `canton`) has its own evento(s) worth
 * linking, falls back to the canton hub (events exist elsewhere in the
 * canton), or has nothing at all (`null`, meaning: render NOTHING — never an
 * empty/dead crosslink section, Non-Negotiable #4).
 */
export function resolveNearbyEventMatch(
  events: readonly NearbyEventSourceEvent[],
  canton: string,
  comuneDisplay: string,
): NearbyEventMatch {
  const cantonCode = String(canton || '').toUpperCase().trim();
  if (!cantonCode) return null;
  const needle = normalizeText(comuneDisplay);
  let cantonHasAny = false;
  let comuneMatch: string | null = null;
  for (const event of events) {
    const eventCanton = String(event?.canton || '').toUpperCase().trim();
    if (eventCanton !== cantonCode) continue;
    cantonHasAny = true;
    if (comuneMatch || !needle) continue;
    if (event?.comune && normalizeText(event.comune) === needle) {
      comuneMatch = event.comune;
    }
  }
  if (comuneMatch) return { kind: 'comune', comune: comuneMatch, canton: cantonCode };
  if (cantonHasAny) return { kind: 'canton', canton: cantonCode };
  return null;
}

const HEADING: Record<CrosslinkLocale, string> = {
  it: 'Eventi vicino a te',
  en: 'Events near you',
  de: 'Veranstaltungen in deiner Nähe',
  fr: 'Événements près de chez vous',
};

function comuneLabel(locale: CrosslinkLocale, comune: string): string {
  switch (locale) {
    case 'en':
      return `See events in ${comune}`;
    case 'de':
      return `Veranstaltungen in ${comune} entdecken`;
    case 'fr':
      return `Découvrir les événements à ${comune}`;
    case 'it':
    default:
      return `Scopri gli eventi a ${comune}`;
  }
}

function cantonLabel(locale: CrosslinkLocale, cantonDisplay: string): string {
  switch (locale) {
    case 'en':
      return `See events in ${cantonDisplay}`;
    case 'de':
      return `Veranstaltungen in ${cantonDisplay} entdecken`;
    case 'fr':
      return `Découvrir les événements en ${cantonDisplay}`;
    case 'it':
    default:
      return `Scopri gli eventi in ${cantonDisplay}`;
  }
}

/** Render-ready link: href + label already resolved for one locale. */
export interface NearbyEventLink {
  readonly href: string;
  readonly label: string;
}

export function toNearbyEventLink(
  match: NearbyEventMatch,
  locale: CrosslinkLocale,
  cantonDisplay: string,
): NearbyEventLink | null {
  if (!match) return null;
  const base = eventsBasePathForCanton(match.canton)[locale];
  if (!base) return null;
  if (match.kind === 'comune') {
    return {
      href: `${base}/${slugifyComune(match.comune)}/`,
      label: comuneLabel(locale, match.comune),
    };
  }
  return {
    href: `${base}/`,
    label: cantonLabel(locale, cantonDisplay),
  };
}

/**
 * Full pure render — given an explicit event list, resolves the match and
 * renders the HTML block. Returns `''` when there is nothing to link
 * (Non-Negotiable #4: no empty/dead section ever rendered).
 */
export function renderNearbyEventsBlock(
  events: readonly NearbyEventSourceEvent[],
  locale: CrosslinkLocale,
  canton: string,
  comuneDisplay: string,
  cantonDisplay: string,
): string {
  const match = resolveNearbyEventMatch(events, canton, comuneDisplay);
  const link = toNearbyEventLink(match, locale, cantonDisplay);
  if (!link) return '';
  return `<section class="mt-8"><h2 class="text-lg font-semibold text-heading mb-3">${escHtml(HEADING[locale])}</h2><a class="inline-flex items-center gap-2 rounded-md border border-edge bg-surface-raised px-4 py-3 text-sm font-semibold text-heading transition-colors hover:border-accent-border hover:text-accent" href="${escHtml(link.href)}">${escHtml(link.label)} &rarr;</a></section>`;
}

let cachedUpcomingEvents: NearbyEventSourceEvent[] | null = null;

function getUpcomingEventsCached(): NearbyEventSourceEvent[] {
  if (!cachedUpcomingEvents) {
    const dataset = loadEventsDataset();
    // #5911: explicit BUILD_DATE_STAMP, not the implicit `new Date()` fallback
    // inside upcomingEvents() — this crosslink and eventsSeoPagesPlugin.ts both
    // decide "does this comune have an upcoming event" from the same dataset,
    // and must agree on "today" for the same reason (see constants.ts doc).
    cachedUpcomingEvents = upcomingEvents(dataset.events ?? [], BUILD_DATE_STAMP) as NearbyEventSourceEvent[];
  }
  return cachedUpcomingEvents;
}

/**
 * Production entry point — the two per-comune render loops in
 * `jobsSeoPagesPlugin.ts` call this directly, interpolating the result
 * inline. Loads + filters `data/events.json` once per build process
 * regardless of how many hundred comune pages call it.
 */
export function nearbyEventsBlockForJobPage(
  locale: CrosslinkLocale,
  canton: string,
  comuneDisplay: string,
  cantonDisplay: string,
): string {
  return renderNearbyEventsBlock(
    getUpcomingEventsCached(),
    locale,
    canton,
    comuneDisplay,
    cantonDisplay,
  );
}

/** Test-only reset for the module-level dataset cache. */
export function __resetNearbyEventsCacheForTests(): void {
  cachedUpcomingEvents = null;
}
