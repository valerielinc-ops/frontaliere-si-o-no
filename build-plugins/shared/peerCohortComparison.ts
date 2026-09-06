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
 * The block names the page's NEIGHBOURS in the cohort ranking — the peers
 * immediately above and below it on the metric, plus the two extremes. Mask
 * no. 2 folds only the page's OWN identity tokens (its `<title>`, `<h1>` and
 * slug) to `@`; a sibling's name is left standing, by design — the doc calls a
 * table naming the neighbours «differenziazione vera [che] deve sopravvivere
 * alla misura». And the WINDOW around the current row is different for every
 * page in the cohort by construction, so the surviving names differ too. Same
 * movement as `nearestMunicipalityComparison.ts` did for the six municipality
 * families in #5002; different neighbour relation, because these families have
 * no geography — the peer of a page here is the row next to it in the ranking.
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
  /** Plural noun for the cohort members ("valichi", "cantoni"), localised. */
  peerNoun: string;
}

/**
 * The page-specific sentences.
 *
 * Three claims, all computed and all falsifiable from the cohort: where this
 * page sits, who is immediately on either side of it (named), and how wide the
 * cohort is (extremes named). A sentence that would read the same on a sibling
 * page would defeat the purpose of the block, so nothing here is editorial.
 */
export function buildPeerProse(params: {
  locale: PeerLocale;
  ranked: readonly RankedRow[];
  currentKey: string;
  labels: PeerComparisonLabels;
  formatValue: (value: number, locale: PeerLocale) => string;
}): string[] {
  const { locale, ranked, currentKey, labels, formatValue } = params;
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
    de: `Von ${total} vergleichbaren ${peerNoun} steht diese Seite bei ${metricLabel} auf Rang ${current.rank}, mit ${fmt(current.value)}.`,
    fr: `Sur ${total} ${peerNoun} comparables, cette page est ${ordinal} pour ${metricLabel}, avec ${fmt(current.value)}.`,
  };
  sentences.push(position[locale]);

  // The neighbours, named. This is the sentence the masks leave standing, and
  // the only one whose CONTENT is different on every page of the cohort.
  const above = ranked[index - 1];
  const below = ranked[index + 1];
  const neighbourParts: string[] = [];
  if (above) {
    const ahead: Record<PeerLocale, string> = {
      it: `subito davanti c’è ${above.name} (${fmt(above.value)})`,
      en: `just ahead is ${above.name} (${fmt(above.value)})`,
      de: `direkt davor liegt ${above.name} (${fmt(above.value)})`,
      fr: `juste devant se trouve ${above.name} (${fmt(above.value)})`,
    };
    neighbourParts.push(ahead[locale]);
  }
  if (below) {
    const behind: Record<PeerLocale, string> = {
      it: `subito dietro ${below.name} (${fmt(below.value)})`,
      en: `just behind is ${below.name} (${fmt(below.value)})`,
      de: `direkt dahinter ${below.name} (${fmt(below.value)})`,
      fr: `juste derrière ${below.name} (${fmt(below.value)})`,
    };
    neighbourParts.push(behind[locale]);
  }
  if (neighbourParts.length > 0) {
    const lead: Record<PeerLocale, string> = {
      it: `Nel confronto diretto ${joinNames(neighbourParts, locale)}.`,
      en: `Side by side, ${joinNames(neighbourParts, locale)}.`,
      de: `Im direkten Vergleich: ${joinNames(neighbourParts, locale)}.`,
      fr: `En comparaison directe, ${joinNames(neighbourParts, locale)}.`,
    };
    sentences.push(lead[locale]);
  }

  const first = ranked[0];
  const last = ranked[ranked.length - 1];
  if (first.value !== last.value) {
    const spread: Record<PeerLocale, string> = {
      it: `Sull’intero gruppo ${metricLabel} va da ${fmt(first.value)} (${first.name}) a ${fmt(last.value)} (${last.name}).`,
      en: `Across the whole group ${metricLabel} runs from ${fmt(first.value)} (${first.name}) to ${fmt(last.value)} (${last.name}).`,
      de: `Über die ganze Gruppe reicht ${metricLabel} von ${fmt(first.value)} (${first.name}) bis ${fmt(last.value)} (${last.name}).`,
      fr: `Sur l’ensemble du groupe, ${metricLabel} va de ${fmt(first.value)} (${first.name}) à ${fmt(last.value)} (${last.name}).`,
    };
    sentences.push(spread[locale]);
  } else {
    // A flat cohort is itself information: it says this figure is not the lever
    // to move on — the opposite of what a page showing the figure alone implies.
    const flat: Record<PeerLocale, string> = {
      it: `Su questo gruppo ${metricLabel} è identica ovunque (${fmt(first.value)}): qui non è la voce che fa la differenza.`,
      en: `Across this group ${metricLabel} is the same everywhere (${fmt(first.value)}): it is not the line that makes the difference here.`,
      de: `In dieser Gruppe ist ${metricLabel} überall gleich (${fmt(first.value)}): Hier ist es nicht der entscheidende Posten.`,
      fr: `Dans ce groupe, ${metricLabel} est identique partout (${fmt(first.value)}) : ce n’est pas ce poste qui fait la différence ici.`,
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

  const sentences = buildPeerProse({ locale, ranked, currentKey, labels, formatValue });
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
