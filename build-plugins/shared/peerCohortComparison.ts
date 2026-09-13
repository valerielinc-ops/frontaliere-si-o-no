/**
 * peerCohortComparison — the per-page unique element for the four page
 * families whose payload is a NUMBER (issue #7386, container of #7340 item 2).
 *
 * WHY IT EXISTS
 * ---------------------------------------------------------------------------
 * `docs/INFORMATION-GAIN.md`, table «I 37 offender del 2026-09-01» (run
 * 33460354951, floor 5 %): four families sit under the Information Gain floor
 * with the SAME shape.
 *
 *   | family                                   | cohorts | median IGS |
 *   | border wait `/tempi-attesa-dogana/`      |    4    |      0 %   |
 *   | health premiums `/premi-cassa-malati/`   |    4    |  2,6-2,7 % |
 *   | weekly employers `/aziende-che-assumono/`|    4    |  2,8-4,9 % |
 *   | profession × canton `it:/lavoro-`        |    3    |  2,9-4,3 % |
 *
 * Each page is one cell of a grid — one crossing, one canton × age bracket,
 * one city × week, one profession in one canton — and everything that tells it
 * apart from its siblings is a FIGURE. Figures are masked to `#` by mask no. 1
 * of `scripts/lib/informationGain.mjs`, and that mask is not negotiable: without
 * it the metric would reward mail-merge. So after masking, nothing on the page
 * belongs to the page. Median 0-5 % is the arithmetic consequence, not an
 * accident of sampling.
 *
 * WHAT THIS ADDS, AND WHY IT SURVIVES BOTH MASKS
 * ---------------------------------------------------------------------------
 * The block names the page's PEERS in the cohort ranking — the rows strictly
 * ahead and behind it on the metric, equal-value rows as ties, plus the two
 * extremes. Mask no. 2 folds only the page's OWN identity tokens (its
 * `<title>`, `<h1>` and slug) to `@`; a sibling's name is left standing, by
 * design — the doc calls a table naming the neighbours «differenziazione vera
 * [che] deve sopravvivere alla misura». The ranking order is deterministic,
 * but it never decides whether equal values are ahead or behind. Same movement
 * as `nearestMunicipalityComparison.ts` did for the six municipality families
 * in #5002; different neighbour relation, because these families have no
 * geography — the peer of a page here is another row in the ranking.
 *
 * WHY NOT REUSE `nearestMunicipalityComparison.ts`
 * ---------------------------------------------------------------------------
 * That module's neighbour relation is `haversineKm` over `lat`/`lng`, and its
 * row type requires both. None of these four families has coordinates: a
 * canton × age bracket and a city × week are not places. Bolting a second,
 * metric-based neighbour relation onto it would have given one module two
 * definitions of "near" and one row type that is half-optional — the two
 * blocks can instead coexist on a page without either knowing about the other,
 * exactly as that module already argues for `shared/relatedLinks.ts`.
 *
 * WHY NOT A FULL RANKING TABLE
 * ---------------------------------------------------------------------------
 * Three of the four families already carry one, and it is precisely what does
 * NOT work: a table of all 26 cantons is byte-identical on all 26 pages, so it
 * contributes zero gain and pools link equity on whoever is at the top — the
 * `RELATED.filter(self).slice(0, 6)` defect PR #5107 removed from the articles
 * and #5002 removed from four municipality families. A window is bounded
 * (`windowSize` rows either side) and moves with the page.
 *
 * DETERMINISM IS A HARD REQUIREMENT
 * ---------------------------------------------------------------------------
 * This runs inside the build and emits internal links. Ties on the metric are
 * the norm, not the exception (a week where two cities both posted 12 roles),
 * so every sort breaks ties on `key`: without it the emitted HTML — and the
 * link graph — would be reshuffled by dataset iteration order on every deploy.
 * Rank is likewise counted as "how many peers are strictly ahead", never as an
 * array index, so four tied rows are not told they are 1st, 2nd, 3rd and 4th.
 */

export type PeerLocale = 'it' | 'en' | 'de' | 'fr';

/** One cell of the cohort. `value === null` means "no figure for this peer". */
export interface PeerRow {
  /** Stable identity: excludes the current row from its own peer set, breaks ties. */
  key: string;
  /** Display name of the peer, ALREADY localised by the caller. */
  name: string;
  /** Internal link to the peer's page. Omit to render the name unlinked. */
  href?: string;
  /** The comparable magnitude. `null` keeps the row out of the ranking. */
  value: number | null;
}

interface RankedRow extends PeerRow {
  value: number;
  /** 1-based, counted as strictly-ahead + 1, so ties share a rank. */
  rank: number;
}

const COPY = {
  colPeer: { it: 'Pagina', en: 'Page', de: 'Seite', fr: 'Page' },
  colRank: { it: 'Posizione', en: 'Rank', de: 'Rang', fr: 'Rang' },
  thisPage: { it: 'questa pagina', en: 'this page', de: 'diese Seite', fr: 'cette page' },
  provenance: {
    it: 'Posizioni calcolate al momento della build sulle pagine sorelle di questa stessa famiglia.',
    en: 'Ranks computed at build time across the sibling pages of this same family.',
    de: 'Ränge zur Build-Zeit über die Schwesterseiten derselben Familie berechnet.',
    fr: 'Rangs calculés au moment du build sur les pages sœurs de cette même famille.',
  },
} satisfies Record<string, Record<PeerLocale, string>>;

const esc = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * The cohort ranked, ties broken on `key`, rows without a figure dropped.
 *
 * `higherIsBetter` decides only the DIRECTION of rank 1 (most open roles wins;
 * fewest waiting minutes wins). The sort key is always the value, so the table
 * reads monotonically either way.
 */
export function rankPeerRows(rows: readonly PeerRow[], higherIsBetter: boolean): RankedRow[] {
  const withValue = rows.filter((row): row is PeerRow & { value: number } => row.value !== null && Number.isFinite(row.value));
  const sorted = [...withValue].sort(
    (a, b) => (higherIsBetter ? b.value - a.value : a.value - b.value) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  return sorted.map((row) => ({
    ...row,
    rank:
      sorted.filter((other) => (higherIsBetter ? other.value > row.value : other.value < row.value)).length + 1,
  }));
}

/**
 * The rows to show: the current one, `windowSize` peers either side, and the
 * two extremes of the cohort — deduplicated, kept in ranking order.
 *
 * The extremes are in because a window alone cannot answer "and how far is
 * this from the best?", which is the question a reader of a ranked cell has.
 * They are two rows, not a leaderboard, so they cannot dominate the block.
 */
export function peerWindow(ranked: readonly RankedRow[], currentKey: string, windowSize: number): RankedRow[] {
  const index = ranked.findIndex((row) => row.key === currentKey);
  if (index < 0) return [];
  const from = Math.max(0, index - windowSize);
  const to = Math.min(ranked.length, index + windowSize + 1);
  const picked = new Map<string, RankedRow>();
  for (const row of [ranked[0], ...ranked.slice(from, to), ranked[ranked.length - 1]]) {
    if (row) picked.set(row.key, row);
  }
  return ranked.filter((row) => picked.has(row.key));
}

/** Localised "a, b and c" — the list is prose, so it needs real conjunctions. */
function joinNames(names: string[], locale: PeerLocale): string {
  if (names.length <= 1) return names[0] ?? '';
  const conjunction = locale === 'it' ? ' e ' : locale === 'de' ? ' und ' : locale === 'fr' ? ' et ' : ' and ';
  return `${names.slice(0, -1).join(', ')}${conjunction}${names[names.length - 1]}`;
}

export interface PeerComparisonLabels {
  /** `<h2>` of the block, localised. */
  heading: string;
  /** Noun phrase for the metric ("le posizioni aperte"), localised, lowercase. */
  metricLabel: string;
  /**
   * Plural noun for the cohort members ("valichi", "cantoni"), localised.
   *
   * In `de` it must be the DATIVE plural ("Kantonen", "Berufen", i.e. the -n
   * form), because the German template consumes it inside the prepositional
   * phrase "Von ${total} vergleichbaren ${peerNoun}", which governs the
   * dative. The nominative reads as broken grammar on every page of the
   * family, and it does so silently — this line is the contract, the two
   * callers of the module diverged on it once (#7596).
   */
  peerNoun: string;
}

function assertPeerNounContract(locale: PeerLocale, peerNoun: string): void {
  if (locale !== 'de' || /(?:en|n)$/i.test(String(peerNoun).trim())) return;
  throw new Error(
    `peerNoun in de must be a German dative plural ending in -n/-en (dativo plurale): ${peerNoun}`,
  );
}

/**
 * The page-specific sentences.
 *
 * The metric label always enters as an APPOSITION ("… ${metricLabel}: da X a
 * Y"), never as the subject or the object of a verb. A family passes it a bare
 * plural noun ("offerte attive") as readily as a singular one ("l'attesa"), and
 * a template with a verb agreeing with one of the two produces broken grammar
 * for the other — in four languages, silently, on a thousand pages.
 *
 * Three claims, all computed and all falsifiable from the cohort: where this
 * page sits, which rows are strictly ahead/behind or tied with it (named), and
 * how wide the cohort is (extremes named). A sentence that would read the same on a sibling
 * page would defeat the purpose of the block, so nothing here is editorial.
 */
export function buildPeerProse(params: {
  locale: PeerLocale;
  ranked: readonly RankedRow[];
  currentKey: string;
  labels: PeerComparisonLabels;
  formatValue: (value: number, locale: PeerLocale) => string;
  /** Same direction used to produce `ranked`, so ahead/behind stays truthful. */
  higherIsBetter?: boolean;
  /** Kept for API symmetry with `renderPeerComparison`; prose uses full strict partitions. */
  windowSize?: number;
}): string[] {
  const { locale, ranked, currentKey, labels, formatValue, higherIsBetter = true } = params;
  assertPeerNounContract(locale, labels.peerNoun);
  const index = ranked.findIndex((row) => row.key === currentKey);
  if (index < 0 || ranked.length < 3) return [];

  const current = ranked[index];
  const fmt = (value: number) => formatValue(value, locale);
  const { metricLabel, peerNoun } = labels;
  const total = ranked.length;
  const sentences: string[] = [];

  const ordinal = locale === 'it' ? `${current.rank}ª` : locale === 'fr' ? `${current.rank}ᵉ` : `${current.rank}.`;
  const position: Record<PeerLocale, string> = {
    it: `Su ${total} ${peerNoun} confrontabili, questa pagina è ${ordinal} per ${metricLabel}, con ${fmt(current.value)}.`,
    en: `Of ${total} comparable ${peerNoun}, this page ranks ${current.rank} on ${metricLabel}, at ${fmt(current.value)}.`,
    de: `Von ${total} vergleichbaren ${peerNoun} steht diese Seite auf Rang ${current.rank} — ${metricLabel}: ${fmt(current.value)}.`,
    fr: `Sur ${total} ${peerNoun} comparables, cette page est ${ordinal} pour ${metricLabel}, avec ${fmt(current.value)}.`,
  };
  sentences.push(position[locale]);

  // Rank ties are deterministic in the table (their key breaks the display
  // order), but that order is not a value comparison. Partition by strict
  // value so equal rows are never published as ahead/behind merely because a
  // key sorts before or after the current row.
  const isAhead = (row: RankedRow): boolean =>
    higherIsBetter ? row.value > current.value : row.value < current.value;
  const isBehind = (row: RankedRow): boolean =>
    higherIsBetter ? row.value < current.value : row.value > current.value;
  const peers = ranked.filter((row) => row.key !== currentKey);
  const aheadNames = peers.filter(isAhead).map((row) => row.name);
  const behindNames = peers.filter(isBehind).map((row) => row.name);
  const tiedRows = peers.filter((row) => row.value === current.value);

  if (aheadNames.length > 0) {
    const ahead: Record<PeerLocale, string> = {
      it: `Davanti in classifica, nell’ordine: ${joinNames(aheadNames, locale)}.`,
      en: `Ahead in the ranking, in order: ${joinNames(aheadNames, locale)}.`,
      de: `Vor dieser Seite, in dieser Reihenfolge: ${joinNames(aheadNames, locale)}.`,
      fr: `Devant au classement, dans l’ordre : ${joinNames(aheadNames, locale)}.`,
    };
    sentences.push(ahead[locale]);
  }
  if (behindNames.length > 0) {
    const behind: Record<PeerLocale, string> = {
      it: `Più indietro in classifica: ${joinNames(behindNames, locale)}.`,
      en: `Further down the ranking: ${joinNames(behindNames, locale)}.`,
      de: `Weiter unten in der Rangliste: ${joinNames(behindNames, locale)}.`,
      fr: `Plus bas au classement : ${joinNames(behindNames, locale)}.`,
    };
    sentences.push(behind[locale]);
  }
  if (tiedRows.length > 0) {
    const tied = tiedRows.map((row) => `${row.name} (${fmt(row.value)})`);
    const ties: Record<PeerLocale, string> = {
      it: `A pari merito con questa pagina: ${joinNames(tied, locale)}.`,
      en: `Tied with this page: ${joinNames(tied, locale)}.`,
      de: `Punktgleich mit dieser Seite: ${joinNames(tied, locale)}.`,
      fr: `À égalité avec cette page : ${joinNames(tied, locale)}.`,
    };
    sentences.push(ties[locale]);
  }

  // Choose the actual value extremes, not the first/last rows of the
  // direction-dependent ranking. In particular, lower-is-better ranks the
  // minimum first but the copy must still call the maximum "highest".
  const highest = ranked.reduce((best, row) => (row.value > best.value ? row : best));
  const lowest = ranked.reduce((best, row) => (row.value < best.value ? row : best));
  if (highest.value !== lowest.value) {
    const spread: Record<PeerLocale, string> = {
      it: `Nel gruppo il valore più alto è ${fmt(highest.value)} (${highest.name}), il più basso ${fmt(lowest.value)} (${lowest.name}).`,
      en: `Across the group the highest value is ${fmt(highest.value)} (${highest.name}) and the lowest ${fmt(lowest.value)} (${lowest.name}).`,
      de: `In der Gruppe ist der höchste Wert ${fmt(highest.value)} (${highest.name}), der niedrigste ${fmt(lowest.value)} (${lowest.name}).`,
      fr: `Dans le groupe, la valeur la plus haute est ${fmt(highest.value)} (${highest.name}) et la plus basse ${fmt(lowest.value)} (${lowest.name}).`,
    };
    sentences.push(spread[locale]);
  } else {
    // A flat cohort is itself information: it says this figure is not the lever
    // to move on — the opposite of what a page showing the figure alone implies.
    const flat: Record<PeerLocale, string> = {
      it: `Su questo gruppo ${metricLabel}: stesso valore ovunque (${fmt(highest.value)}), qui non è la voce che fa la differenza.`,
      en: `Across this group ${metricLabel}: the same everywhere (${fmt(highest.value)}), so it is not the line that makes the difference here.`,
      de: `In dieser Gruppe ${metricLabel}: überall gleich (${fmt(highest.value)}) — hier ist es nicht der entscheidende Posten.`,
      fr: `Dans ce groupe ${metricLabel} : identique partout (${fmt(highest.value)}), ce n’est pas ce poste qui fait la différence ici.`,
    };
    sentences.push(flat[locale]);
  }

  return sentences;
}

/**
 * The whole block: prose, then the windowed table, then provenance.
 *
 * Returns `''` when there is nothing to compare — a cohort of fewer than three
 * rows with a figure, or a current key absent from its own cohort. Emitting an
 * empty "compare" heading would be worse than emitting nothing: it is a promise
 * the page does not keep, and it would count as template prose in the audit.
 */
export function renderPeerComparison(params: {
  locale: PeerLocale;
  currentKey: string;
  rows: readonly PeerRow[];
  labels: PeerComparisonLabels;
  formatValue: (value: number, locale: PeerLocale) => string;
  /** Rank 1 goes to the largest value when true (default), the smallest when false. */
  higherIsBetter?: boolean;
  /** Peers shown either side of the current row. */
  windowSize?: number;
  /** Extra provenance line for family-specific figures. */
  sourceNote?: string;
}): string {
  const { locale, currentKey, rows, labels, formatValue, higherIsBetter = true, windowSize = 2, sourceNote } = params;
  const ranked = rankPeerRows(rows, higherIsBetter);
  if (ranked.length < 3 || !ranked.some((row) => row.key === currentKey)) return '';

  const sentences = buildPeerProse({ locale, ranked, currentKey, labels, formatValue, higherIsBetter, windowSize });
  if (sentences.length === 0) return '';
  const prose = sentences.map((s) => `<p class="mt-2 text-sm text-body">${esc(s)}</p>`).join('\n        ');

  const tableRows = peerWindow(ranked, currentKey, windowSize)
    .map((row) => {
      const isCurrent = row.key === currentKey;
      const nameCell = isCurrent
        ? `<th scope="row" class="px-3 py-2 text-left font-semibold text-heading">${esc(row.name)} <span class="font-normal text-muted">(${esc(COPY.thisPage[locale])})</span></th>`
        : row.href
          ? `<th scope="row" class="px-3 py-2 text-left font-normal"><a class="font-semibold text-accent hover:underline" href="${esc(row.href)}">${esc(row.name)}</a></th>`
          : `<th scope="row" class="px-3 py-2 text-left font-normal">${esc(row.name)}</th>`;
      return `<tr class="${isCurrent ? 'bg-surface-raised' : ''}">${nameCell}<td class="px-3 py-2 text-right tabular-nums">${esc(String(row.rank))}</td><td class="px-3 py-2 text-right tabular-nums">${esc(formatValue(row.value, locale))}</td></tr>`;
    })
    .join('\n            ');

  const provenance = sourceNote ? `${COPY.provenance[locale]} ${sourceNote}` : COPY.provenance[locale];

  return `
      <section data-peer-comparison="1" class="mt-6 rounded-md border border-edge bg-surface p-5">
        <h2 class="text-xl font-bold text-heading">${esc(labels.heading)}</h2>
        ${prose}
        <div class="mt-4 overflow-x-auto">
          <table class="w-full min-w-[28rem] border-collapse text-sm">
            <thead class="border-b border-edge text-muted">
              <tr><th scope="col" class="px-3 py-2 text-left font-semibold">${esc(COPY.colPeer[locale])}</th><th scope="col" class="px-3 py-2 text-right font-semibold">${esc(COPY.colRank[locale])}</th><th scope="col" class="px-3 py-2 text-right font-semibold">${esc(labels.metricLabel)}</th></tr>
            </thead>
            <tbody class="divide-y divide-edge text-body">
            ${tableRows}
            </tbody>
          </table>
        </div>
        <p class="mt-3 text-xs text-muted">${esc(provenance)}</p>
      </section>`;
}

export const PEER_COMPARISON_COPY = COPY;
