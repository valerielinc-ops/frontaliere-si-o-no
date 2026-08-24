/**
 * nearestMunicipalityComparison — the per-page unique element for the six
 * municipality page families (issue #5002).
 *
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * Measured on production 2026-08-24 with `npm run audit:information-gain`
 * (see `docs/INFORMATION-GAIN.md` for the metric): the fiscal-guide family
 * `/tasse-frontalieri-comune/` scored a **median Information Gain of 0,0 %**,
 * with 29 of 30 sampled pages contributing not one sentence their siblings did
 * not already carry. `/vivere-in-ticino/comuni-di-frontiera/` scored 11-15 %.
 * The control in the same run — employer profiles, same shell and nav but a
 * real per-page payload — scored 50-52 %.
 *
 * The families were mail-merges: identical prose with the place name and a
 * couple of figures swapped. Worse, `irpefAddizionale` takes only NINE
 * distinct values across all 518 comuni (346 of them share 0,55 %), so the
 * numbers did not differentiate the pages either: five of seven sampled fiscal
 * pages carried byte-identical figures (`0,55 %`, `−647 €`).
 *
 * WHAT THIS ADDS, AND WHY IT IS NOT MORE TEMPLATE
 * ---------------------------------------------------------------------------
 * The nearest neighbours of a comune are unique to that comune. So a block
 * built from them — the list, the spread of a real figure across the group,
 * and where this comune sits inside that spread — is page-specific by
 * construction, not by copywriting. It is also the answer to a question the
 * old prose asked and did not answer: the fiscal pages already told the reader
 * to "compare at least three comuni in the same corridor" while offering no
 * comparison at all.
 *
 * It replaces, in four of the families, a `RELATED.filter(self).slice(0, 6)`
 * block that emitted the SAME six links on every page — the recency-hub defect
 * PR #5107 fixed for articles (3.070 of 3.086 articles had zero inbound links
 * because every page linked the same five). Same shape, same cost: link equity
 * pooled on six pages, every other page reachable only from a paginated hub.
 *
 * DETERMINISM IS A HARD REQUIREMENT
 * ---------------------------------------------------------------------------
 * This runs inside the build. A neighbour list whose order depended on
 * iteration order would rewrite the internal links of every municipality page
 * on every deploy — churn a crawler reads as a site restructuring itself
 * daily. Distances are computed, sorted, and every tie is broken on `slug`.
 *
 * No new dependency, no data file: `population`, `distanceKm`, `lat`, `lng`
 * are already in each family's dataset, and the great-circle helper is the
 * existing leaf module `scripts/lib/haversine.mjs`.
 */

import { haversineKm } from '../../scripts/lib/haversine.mjs';

export type ComparisonLocale = 'it' | 'en' | 'de' | 'fr';

/**
 * The minimum a dataset row must expose to take part in the comparison.
 *
 * Identity is NOT a field here. Four of the six families carry a `slug`, but
 * `data/municipalities.ts` (the largest, 518 rows) has none — its pages derive
 * the slug from the name through `slugifyMunicipalityName`. Requiring a field
 * would have meant either a fake `slug` spread onto 518 objects per page
 * render, or this module refusing the family it was written for. Callers pass
 * `keyOf` instead.
 */
export interface ComparablePlace {
  name: string;
  lat: number;
  lng: number;
}

export interface ComparisonColumn<T extends ComparablePlace> {
  /**
   * Column header, ALREADY localised by the caller. Each family keeps its
   * column names in its own `COPY[locale]` block, next to the rest of its
   * strings, so a translator edits one object per family instead of hunting
   * for a second copy table inside this module.
   */
  header: string;
  /** Cell text. Already formatted and localised by the caller. */
  value: (place: T) => string;
  /**
   * Comparable magnitude behind `value`, when there is one. Supplying it opts
   * the column into the spread sentence — the prose that makes the block
   * page-specific rather than just a per-page table.
   */
  numeric?: (place: T) => number | null;
  /** Noun phrase for the spread sentence ("the municipal surcharge"), localised. */
  spreadLabel?: string;
  /** Renders a magnitude back into display form for the spread sentence. */
  formatNumeric?: (value: number, locale: ComparisonLocale) => string;
}

export interface NeighbourEntry<T extends ComparablePlace> {
  place: T;
  distanceKm: number;
}

const COPY = {
  heading: {
    it: 'Confronto con i comuni più vicini',
    en: 'Compared with the nearest towns',
    de: 'Vergleich mit den nächsten Gemeinden',
    fr: 'Comparaison avec les communes les plus proches',
  },
  colPlace: {
    it: 'Comune',
    en: 'Town',
    de: 'Gemeinde',
    fr: 'Commune',
  },
  colDistance: {
    it: 'Distanza da qui',
    en: 'Distance from here',
    de: 'Entfernung von hier',
    fr: 'Distance d’ici',
  },
  thisPlace: {
    it: 'qui',
    en: 'here',
    de: 'hier',
    fr: 'ici',
  },
  provenance: {
    it: 'Distanze in linea d’aria calcolate dalle coordinate del centro comunale del nostro dataset.',
    en: 'Straight-line distances computed from the town-centre coordinates in our dataset.',
    de: 'Luftlinien-Entfernungen, berechnet aus den Ortsmittelpunkt-Koordinaten unseres Datensatzes.',
    fr: 'Distances à vol d’oiseau calculées depuis les coordonnées du centre communal de notre jeu de données.',
  },
} satisfies Record<string, Record<ComparisonLocale, string>>;

const esc = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const intlFor = (locale: ComparisonLocale): string =>
  locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-DE' : locale === 'fr' ? 'fr-FR' : 'en-US';

/** One decimal for short distances, none above 10 km — matching the family pages. */
export function formatDistanceKm(km: number, locale: ComparisonLocale): string {
  const digits = km < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(intlFor(locale), {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(km)} km`;
}

/**
 * The `limit` places nearest to `current`, excluding `current` itself.
 *
 * Sorted by distance, ties broken on `slug`: two comuni equidistant to the
 * metre are possible in a dataset that rounds coordinates, and without the
 * second key their order would come from the array and silently change the
 * emitted HTML whenever the dataset is regenerated.
 */
export function nearestComparablePlaces<T extends ComparablePlace>(
  current: T,
  pool: readonly T[],
  keyOf: (place: T) => string,
  limit = 6,
): Array<NeighbourEntry<T>> {
  const currentKey = keyOf(current);
  return pool
    .filter((place) => keyOf(place) !== currentKey)
    .map((place) => ({
      place,
      distanceKm: haversineKm(current.lat, current.lng, place.lat, place.lng),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm || (keyOf(a.place) < keyOf(b.place) ? -1 : 1))
    .slice(0, limit);
}

/** Localised "a, b and c" — the list is prose, so it needs real conjunctions. */
function joinNames(names: string[], locale: ComparisonLocale): string {
  if (names.length <= 1) return names[0] ?? '';
  const conjunction = locale === 'it' ? ' e ' : locale === 'de' ? ' und ' : locale === 'fr' ? ' et ' : ' and ';
  return `${names.slice(0, -1).join(', ')}${conjunction}${names[names.length - 1]}`;
}

/**
 * The page-specific sentences.
 *
 * Two claims, both computed and both falsifiable from the dataset: who the
 * neighbours are within what radius, and how the current place sits inside the
 * group on one real figure (lowest / highest / in between, with the holders
 * named). Nothing here is editorial padding — a sentence that would read the
 * same on the sibling pages would defeat the purpose of the block.
 */
export function buildComparisonProse<T extends ComparablePlace>(params: {
  locale: ComparisonLocale;
  current: T;
  neighbours: Array<NeighbourEntry<T>>;
  keyOf: (place: T) => string;
  spreadColumn?: ComparisonColumn<T>;
}): string[] {
  const { locale, current, neighbours, keyOf, spreadColumn } = params;
  if (neighbours.length === 0) return [];

  const radius = formatDistanceKm(neighbours[neighbours.length - 1].distanceKm, locale);
  const names = joinNames(
    neighbours.map((entry) => entry.place.name),
    locale,
  );
  const count = neighbours.length;

  const lead: Record<ComparisonLocale, string> = {
    it: `Entro ${radius} da ${current.name} ci sono ${count} comuni con una pagina su questo sito: ${names}.`,
    en: `Within ${radius} of ${current.name} there are ${count} towns with a page on this site: ${names}.`,
    de: `Innerhalb von ${radius} um ${current.name} liegen ${count} Gemeinden mit einer Seite auf dieser Website: ${names}.`,
    fr: `Dans un rayon de ${radius} autour de ${current.name}, ${count} communes ont une page sur ce site : ${names}.`,
  };
  const sentences = [lead[locale]];

  if (!spreadColumn?.numeric || !spreadColumn.spreadLabel) return sentences;

  const format = spreadColumn.formatNumeric ?? ((value: number) => String(value));
  const group = [current, ...neighbours.map((entry) => entry.place)]
    .map((place) => ({ place, value: spreadColumn.numeric?.(place) ?? null }))
    .filter((row): row is { place: T; value: number } => row.value !== null)
    .sort((a, b) => a.value - b.value || (keyOf(a.place) < keyOf(b.place) ? -1 : 1));

  if (group.length < 2) return sentences;

  const lowest = group[0];
  const highest = group[group.length - 1];
  const label = spreadColumn.spreadLabel;
  const currentKey = keyOf(current);
  const currentValue = group.find((row) => keyOf(row.place) === currentKey);

  if (lowest.value === highest.value) {
    // A flat group is itself information: it tells the reader this figure is
    // not the lever to move on, which is the opposite of what a page showing
    // the figure alone implies.
    const flat: Record<ComparisonLocale, string> = {
      it: `Su questo gruppo ${label} è identica per tutti (${format(lowest.value, locale)}): qui non è la voce che fa la differenza.`,
      en: `Across this group ${label} is the same everywhere (${format(lowest.value, locale)}): it is not the line that makes the difference here.`,
      de: `In dieser Gruppe ist ${label} überall gleich (${format(lowest.value, locale)}): Hier ist es nicht der entscheidende Posten.`,
      fr: `Dans ce groupe, ${label} est identique partout (${format(lowest.value, locale)}) : ce n’est pas ce poste qui fait la différence ici.`,
    };
    sentences.push(flat[locale]);
    return sentences;
  }

  const spread: Record<ComparisonLocale, string> = {
    it: `Su questo gruppo ${label} va da ${format(lowest.value, locale)} (${lowest.place.name}) a ${format(highest.value, locale)} (${highest.place.name}).`,
    en: `Across this group ${label} runs from ${format(lowest.value, locale)} (${lowest.place.name}) to ${format(highest.value, locale)} (${highest.place.name}).`,
    de: `In dieser Gruppe reicht ${label} von ${format(lowest.value, locale)} (${lowest.place.name}) bis ${format(highest.value, locale)} (${highest.place.name}).`,
    fr: `Dans ce groupe, ${label} va de ${format(lowest.value, locale)} (${lowest.place.name}) à ${format(highest.value, locale)} (${highest.place.name}).`,
  };
  sentences.push(spread[locale]);

  if (currentValue) {
    // Rank counted as "how many are strictly cheaper", not array position:
    // `irpefAddizionale` has nine distinct values across 518 comuni, so ties
    // are the NORM here (346 rows share 0,55 %). Reading a position off the
    // sorted array would tell four comuni with the same rate that they are
    // 1st, 2nd, 3rd and 4th — a made-up ordering presented as a finding.
    const strictlyLower = group.filter((row) => row.value < currentValue.value).length;
    const tied = group.filter((row) => row.value === currentValue.value).length - 1;
    const rank = strictlyLower + 1;
    // Singular vs plural written out per locale: "a pari merito con altri 1"
    // is the tell of a template that counts without reading.
    const tie: Record<ComparisonLocale, string> = {
      it: tied === 0 ? '' : tied === 1 ? ', a pari merito con un altro' : `, a pari merito con altri ${tied}`,
      en: tied === 0 ? '' : tied === 1 ? ', tied with one other' : `, tied with ${tied} others`,
      de: tied === 0 ? '' : tied === 1 ? ', gleichauf mit einer weiteren' : `, gleichauf mit ${tied} weiteren`,
      fr: tied === 0 ? '' : tied === 1 ? ', à égalité avec une autre' : `, à égalité avec ${tied} autres`,
    };
    const position: Record<ComparisonLocale, string> = {
      it: `${current.name} sta a ${format(currentValue.value, locale)}: ${rank}° su ${group.length} partendo dal più basso${tie.it}.`,
      en: `${current.name} sits at ${format(currentValue.value, locale)}: ${rank} of ${group.length} counting from the lowest${tie.en}.`,
      de: `${current.name} liegt bei ${format(currentValue.value, locale)}: Platz ${rank} von ${group.length} vom niedrigsten Wert an${tie.de}.`,
      fr: `${current.name} est à ${format(currentValue.value, locale)} : ${rank}ᵉ sur ${group.length} en partant du plus bas${tie.fr}.`,
    };
    sentences.push(position[locale]);
  }

  return sentences;
}

/**
 * The whole block: prose, then the table, then provenance.
 *
 * Returns `''` when there is nothing to compare — a family with one page, or a
 * `pool` that does not contain the current place's siblings. Emitting an empty
 * "compare" heading would be worse than emitting nothing: it is a promise the
 * page does not keep, and it would count as template prose in the audit.
 */
export function renderNearestComparison<T extends ComparablePlace>(params: {
  locale: ComparisonLocale;
  current: T;
  pool: readonly T[];
  columns: Array<ComparisonColumn<T>>;
  hrefFor: (place: T) => string;
  /** Stable identity, used to exclude `current` from its own pool and to break ties. */
  keyOf: (place: T) => string;
  limit?: number;
  /** Column driving the spread sentence. Defaults to the first eligible one. */
  spreadColumnIndex?: number;
  /** Extra provenance line for family-specific figures. */
  sourceNote?: string;
  /**
   * Family-specific computed claims, appended after the standard sentences.
   *
   * The generic prose can only say what a generic module knows: who the
   * neighbours are, and where this place sits on one column. The sentence a
   * reader actually wants is domain-shaped — "moving to the cheapest of these
   * is worth about X € a year on the same profile" — and only the family owns
   * the engine that computes it. Returning `[]` is always valid.
   */
  extraProse?: (ctx: {
    locale: ComparisonLocale;
    current: T;
    neighbours: Array<NeighbourEntry<T>>;
  }) => string[];
}): string {
  const { locale, current, pool, columns, hrefFor, keyOf, limit = 6, sourceNote, extraProse } = params;
  const neighbours = nearestComparablePlaces(current, pool, keyOf, limit);
  if (neighbours.length < 2) return '';

  const spreadColumn =
    params.spreadColumnIndex !== undefined
      ? columns[params.spreadColumnIndex]
      : columns.find((column) => column.numeric && column.spreadLabel);

  const prose = [
    ...buildComparisonProse({ locale, current, neighbours, keyOf, spreadColumn }),
    ...(extraProse?.({ locale, current, neighbours }) ?? []),
  ]
    .map((sentence) => `<p class="mt-2 text-sm text-body">${esc(sentence)}</p>`)
    .join('\n        ');

  const headerCells = [
    `<th scope="col" class="px-3 py-2 text-left font-semibold">${esc(COPY.colPlace[locale])}</th>`,
    `<th scope="col" class="px-3 py-2 text-right font-semibold">${esc(COPY.colDistance[locale])}</th>`,
    ...columns.map(
      (column) =>
        `<th scope="col" class="px-3 py-2 text-right font-semibold">${esc(column.header)}</th>`,
    ),
  ].join('');

  const row = (place: T, distanceLabel: string, isCurrent: boolean): string => {
    const nameCell = isCurrent
      ? `<th scope="row" class="px-3 py-2 text-left font-semibold text-heading">${esc(place.name)} <span class="font-normal text-muted">(${esc(COPY.thisPlace[locale])})</span></th>`
      : `<th scope="row" class="px-3 py-2 text-left font-normal"><a class="font-semibold text-accent hover:underline" href="${esc(hrefFor(place))}">${esc(place.name)}</a></th>`;
    const cells = columns
      .map((column) => `<td class="px-3 py-2 text-right tabular-nums">${esc(column.value(place))}</td>`)
      .join('');
    return `<tr class="${isCurrent ? 'bg-surface-raised' : ''}">${nameCell}<td class="px-3 py-2 text-right tabular-nums">${esc(distanceLabel)}</td>${cells}</tr>`;
  };

  const rows = [
    row(current, '—', true),
    ...neighbours.map((entry) => row(entry.place, formatDistanceKm(entry.distanceKm, locale), false)),
  ].join('\n            ');

  const provenance = sourceNote
    ? `${COPY.provenance[locale]} ${sourceNote}`
    : COPY.provenance[locale];

  return `
      <section data-nearest-comparison="1" class="mt-6 rounded-md border border-edge bg-surface p-5">
        <h2 class="text-xl font-bold text-heading">${esc(COPY.heading[locale])}</h2>
        ${prose}
        <div class="mt-4 overflow-x-auto">
          <table class="w-full min-w-[32rem] border-collapse text-sm">
            <thead class="border-b border-edge text-muted">
              <tr>${headerCells}</tr>
            </thead>
            <tbody class="divide-y divide-edge text-body">
            ${rows}
            </tbody>
          </table>
        </div>
        <p class="mt-3 text-xs text-muted">${esc(provenance)}</p>
      </section>`;
}

export const NEAREST_COMPARISON_COPY = COPY;
