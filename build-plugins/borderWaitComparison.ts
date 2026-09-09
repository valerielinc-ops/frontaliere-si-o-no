/**
 * Border-wait comparison surface.
 *
 * The comparison is deliberately narrower than "all nearby crossings": a
 * peer must belong to the same regional corridor. This keeps the answer
 * operational for a commuter and prevents an alpine pass or a different
 * country corridor from being presented as a realistic detour.
 */

import { borderCrossings, type BorderCrossing } from '../data/borderCrossings';
import { slugifyCrossingName } from '../services/borderCrossingSlug';
import {
  BORDER_CROSSING_DISPLAY,
  BORDER_WAIT_REGIONS,
  BORDER_WAIT_CROSSINGS,
  BORDER_REGION_DISPLAY,
  CROSSING_TO_REGION,
  buildOggiPath,
  buildRegionalHubPath,
  type BorderCrossingRegion,
  type BorderCrossingSlug,
  type BorderWaitLocale,
} from './borderWaitData';
import { nearestComparablePlaces, formatDistanceKm } from './shared/nearestMunicipalityComparison';
import {
  H2_STYLE,
  H3_STYLE,
  LINK_ACCENT_STYLE,
  TABLE_CELL_CLASS,
  TABLE_CLASS,
  TABLE_HEAD_CLASS,
} from './shared/seoContentTokens';

export type BorderWaitDirection = 'IT → CH' | 'CH → IT' | 'Entrambi';

export interface BorderWaitComparisonEntry {
  waitTimeMinutes?: number | null;
  totalCrossingMinutes?: number | null;
  status?: 'green' | 'yellow' | 'red' | null;
  source?: string | null;
  lastUpdate?: string | null;
  direction?: BorderWaitDirection | null;
}

export interface BorderComparisonCandidate {
  slug: BorderCrossingSlug;
  crossing: BorderCrossing;
  distanceKm: number;
}

function crossingForSlug(slug: BorderCrossingSlug): BorderCrossing | undefined {
  return borderCrossings.find((crossing) => slugifyCrossingName(crossing.name) === slug);
}

/**
 * Stable peer selection shared by the renderer and its tests. The shared
 * nearest-neighbour calculator owns the distance calculation and tie-break;
 * this module owns only the border-specific corridor filter.
 */
export function getBorderComparisonCandidates(
  currentSlug: BorderCrossingSlug,
  limit = 4,
): BorderComparisonCandidate[] {
  const current = crossingForSlug(currentSlug);
  const region = CROSSING_TO_REGION[currentSlug];
  if (!current || !region) return [];

  const peers = BORDER_WAIT_CROSSINGS
    .filter((slug) => slug !== currentSlug && CROSSING_TO_REGION[slug] === region)
    .map((slug) => crossingForSlug(slug))
    .filter((crossing): crossing is BorderCrossing => Boolean(crossing));

  return nearestComparablePlaces(current, peers, (crossing) => slugifyCrossingName(crossing.name), limit)
    .map(({ place, distanceKm }) => ({
      slug: slugifyCrossingName(place.name) as BorderCrossingSlug,
      crossing: place,
      distanceKm,
    }));
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function effectiveWait(entry: BorderWaitComparisonEntry | undefined): number | null {
  if (!entry) return null;
  return typeof entry.totalCrossingMinutes === 'number'
    ? entry.totalCrossingMinutes
    : typeof entry.waitTimeMinutes === 'number'
      ? entry.waitTimeMinutes
      : null;
}

function intlLocale(locale: BorderWaitLocale): string {
  return locale === 'it' ? 'it-IT' : locale === 'de' ? 'de-DE' : locale === 'fr' ? 'fr-FR' : 'en-US';
}

function formatSnapshotTimestamp(value: string | null | undefined, locale: BorderWaitLocale): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(intlLocale(locale), {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Zurich',
  }).format(date);
}

function formatWait(value: number | null, locale: BorderWaitLocale): string {
  if (value === null) {
    return locale === 'it' ? 'n.d.' : locale === 'de' ? 'k.A.' : locale === 'fr' ? 'n.d.' : 'n/a';
  }
  return `${value} min`;
}

function statusLabel(status: BorderWaitComparisonEntry['status'], locale: BorderWaitLocale): string {
  if (!status) return '—';
  const labels: Record<BorderWaitLocale, Record<'green' | 'yellow' | 'red', string>> = {
    it: { green: 'Scorrevole', yellow: 'Moderata', red: 'Lunga' },
    en: { green: 'Free-flowing', yellow: 'Moderate', red: 'Long' },
    de: { green: 'Fliessend', yellow: 'Moderat', red: 'Lang' },
    fr: { green: 'Fluide', yellow: 'Modérée', red: 'Longue' },
  };
  return labels[locale][status];
}

function directionLabel(direction: BorderWaitDirection | null | undefined, locale: BorderWaitLocale): string {
  if (!direction) return '—';
  if (locale === 'it') return direction;
  if (locale === 'en') {
    return direction === 'IT → CH' ? 'Italy → Switzerland' : direction === 'CH → IT' ? 'Switzerland → Italy' : 'Both directions';
  }
  if (locale === 'de') {
    return direction === 'IT → CH' ? 'Italien → Schweiz' : direction === 'CH → IT' ? 'Schweiz → Italien' : 'Beide Richtungen';
  }
  return direction === 'IT → CH' ? 'Italie → Suisse' : direction === 'CH → IT' ? 'Suisse → Italie' : 'Les deux directions';
}

function historicalValue(value: string | undefined, locale: BorderWaitLocale): string {
  if (!value || /^-+$/.test(value.trim())) {
    return locale === 'it' ? 'n.d.' : locale === 'de' ? 'k.A.' : locale === 'fr' ? 'n.d.' : 'n/a';
  }
  return value;
}

function sourceLabel(source: string | null | undefined, labels: Record<string, string>, locale: BorderWaitLocale): string {
  if (!source) return locale === 'it' ? 'n.d.' : locale === 'de' ? 'k.A.' : locale === 'fr' ? 'n.d.' : 'n/a';
  return labels[source] ?? source;
}

function comparisonCopy(locale: BorderWaitLocale, regionLabel: string, count: number) {
  return {
    it: {
      heading: 'Confronto tra valichi vicini',
      lead: `Questo confronto riunisce ${count} valichi dello stesso corridoio ${regionLabel}, ordinati per distanza in linea d'aria. Puoi confrontare la misura osservata, la direzione e la fonte prima di scegliere dove passare.`,
      observed: 'Attesa osservata',
      direction: 'Direzione',
      updated: 'Aggiornato',
      source: 'Fonte',
      current: 'Questo valico',
      historyHeading: 'Profilo storico indicativo',
      historyLead: 'Medie editoriali della finestra mattina/sera: non sono il dato live e non includono il tempo del tragitto fino al valico.',
      morning: 'Mattina',
      evening: 'Sera',
      distance: 'Distanza',
      note: 'La misura osservata combina approccio e checkpoint quando disponibili; non è il tempo totale dalla tua partenza. Un valore assente resta non disponibile.',
    },
    en: {
      heading: 'Compare nearby crossings',
      lead: `This comparison groups ${count} crossings in the same ${regionLabel} corridor, ordered by straight-line distance. Compare the observed reading, direction and source before choosing where to cross.`,
      observed: 'Observed wait',
      direction: 'Direction',
      updated: 'Updated',
      source: 'Source',
      current: 'This crossing',
      historyHeading: 'Indicative historical profile',
      historyLead: 'Editorial morning/evening averages: not live data and not the travel time to reach the crossing.',
      morning: 'Morning',
      evening: 'Evening',
      distance: 'Distance',
      note: 'The observed figure combines approach and checkpoint time when available; it is not the full journey from your starting point. Missing data stays unavailable.',
    },
    de: {
      heading: 'Nahe Übergänge vergleichen',
      lead: `Dieser Vergleich bündelt ${count} Übergänge im selben Korridor ${regionLabel}, geordnet nach Luftlinien-Entfernung. Vergleichen Sie Messwert, Richtung und Quelle, bevor Sie den Übergang wählen.`,
      observed: 'Gemessene Wartezeit',
      direction: 'Richtung',
      updated: 'Aktualisiert',
      source: 'Quelle',
      current: 'Dieser Übergang',
      historyHeading: 'Richtwert aus der Historie',
      historyLead: 'Redaktionelle Morgen-/Abend-Durchschnitte: keine Live-Daten und nicht die Fahrzeit bis zum Übergang.',
      morning: 'Morgen',
      evening: 'Abend',
      distance: 'Entfernung',
      note: 'Der Messwert kombiniert Annäherung und Kontrollpunkt, sofern verfügbar; er ist nicht die gesamte Strecke ab Ihrem Startpunkt. Fehlende Daten bleiben nicht verfügbar.',
    },
    fr: {
      heading: 'Comparer les passages proches',
      lead: `Cette comparaison regroupe ${count} passages du même corridor ${regionLabel}, classés par distance à vol d'oiseau. Comparez la mesure observée, la direction et la source avant de choisir le passage.`,
      observed: 'Attente observée',
      direction: 'Direction',
      updated: 'Mis à jour',
      source: 'Source',
      current: 'Ce passage',
      historyHeading: 'Profil historique indicatif',
      historyLead: "Moyennes éditoriales matin/soir : il ne s'agit pas d'une donnée live ni du temps de trajet jusqu'au passage.",
      morning: 'Matin',
      evening: 'Soir',
      distance: 'Distance',
      note: "La mesure observée combine l'approche et le contrôle lorsqu'ils sont disponibles ; ce n'est pas le trajet complet depuis votre départ. Une donnée absente reste indisponible.",
    },
  }[locale];
}

export function renderBorderWaitComparison(params: {
  locale: BorderWaitLocale;
  currentSlug: BorderCrossingSlug;
  current: BorderWaitComparisonEntry | undefined;
  perCrossing: Partial<Record<BorderCrossingSlug, BorderWaitComparisonEntry>>;
  regionLabel: string;
  sourceLabels: Record<string, string>;
  limit?: number;
}): string {
  const { locale, currentSlug, current, perCrossing, regionLabel, sourceLabels, limit = 4 } = params;
  const candidates = getBorderComparisonCandidates(currentSlug, limit);
  if (candidates.length === 0) return '';

  const copy = comparisonCopy(locale, regionLabel, candidates.length + 1);
  const rows: Array<{ slug: BorderCrossingSlug; crossing: BorderCrossing; distanceKm: number; entry: BorderWaitComparisonEntry | undefined; isCurrent: boolean }> = [
    {
      slug: currentSlug,
      crossing: crossingForSlug(currentSlug)!,
      distanceKm: 0,
      entry: current,
      isCurrent: true,
    },
    ...candidates.map((candidate) => ({
      ...candidate,
      entry: perCrossing[candidate.slug],
      isCurrent: false,
    })),
  ];
  const sourceLabelMap = escapeHtml(JSON.stringify(sourceLabels));
  const liveRows = rows.map(({ slug, entry, isCurrent }) => {
    const wait = effectiveWait(entry);
    const rowStyle = isCurrent ? ' style="background:var(--color-surface-alt)"' : '';
    return `<tr data-bw-crossing="${escapeHtml(slug)}" data-bw-comparison-current="${isCurrent ? 'true' : 'false'}"${rowStyle}>
      <td class="${TABLE_CELL_CLASS}">
        <a href="${buildOggiPath(locale, slug)}" style="${LINK_ACCENT_STYLE};font-weight:600;text-decoration:underline;text-underline-offset:2px">${escapeHtml(BORDER_CROSSING_DISPLAY[slug])}</a>
        ${isCurrent ? `<span style="margin-left:8px;font-size:12px;font-weight:600;color:var(--color-subtle)">${escapeHtml(copy.current)}</span>` : ''}
      </td>
      <td class="${TABLE_CELL_CLASS}" style="text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap">
        <span data-bw-field="totalCrossingMinutes" style="font-weight:600;color:var(--color-heading)">${escapeHtml(formatWait(wait, locale))}</span>
        <span data-bw-field="status" style="display:block;font-size:12px;color:var(--color-subtle)">${escapeHtml(statusLabel(entry?.status, locale))}</span>
      </td>
      <td class="${TABLE_CELL_CLASS}" style="white-space:nowrap" data-bw-field="direction">${escapeHtml(directionLabel(entry?.direction, locale))}</td>
      <td class="${TABLE_CELL_CLASS}" style="white-space:nowrap;color:var(--color-subtle)" data-bw-field="lastUpdate">${escapeHtml(formatSnapshotTimestamp(entry?.lastUpdate, locale))}</td>
      <td class="${TABLE_CELL_CLASS}" style="color:var(--color-subtle)" data-bw-field="source" data-bw-source-labels="${sourceLabelMap}">${escapeHtml(sourceLabel(entry?.source, sourceLabels, locale))}</td>
    </tr>`;
  }).join('\n');

  const historyRows = rows.map(({ slug, crossing, distanceKm }) => `<tr>
    <td class="${TABLE_CELL_CLASS}"><a href="${buildOggiPath(locale, slug)}" style="${LINK_ACCENT_STYLE};text-decoration:underline;text-underline-offset:2px">${escapeHtml(BORDER_CROSSING_DISPLAY[slug])}</a></td>
    <td class="${TABLE_CELL_CLASS}" style="text-align:right;font-variant-numeric:tabular-nums">${escapeHtml(historicalValue(crossing.avgWaitMorning, locale))}</td>
    <td class="${TABLE_CELL_CLASS}" style="text-align:right;font-variant-numeric:tabular-nums">${escapeHtml(historicalValue(crossing.avgWaitEvening, locale))}</td>
    <td class="${TABLE_CELL_CLASS}" style="text-align:right;color:var(--color-subtle);font-variant-numeric:tabular-nums">${escapeHtml(formatDistanceKm(distanceKm, locale))}</td>
  </tr>`).join('\n');

  return `<section class="s-ziawP1" aria-labelledby="borderComparison-${escapeHtml(currentSlug)}" data-bw-comparison="true">
    <h2 id="borderComparison-${escapeHtml(currentSlug)}" style="${H2_STYLE}">${escapeHtml(copy.heading)}</h2>
    <p class="s-sau7he">${escapeHtml(copy.lead)}</p>
    <div class="s-card" style="overflow-x:auto;padding:0">
      <table class="${TABLE_CLASS}" style="font-size:14px;min-width:680px" data-bw-comparison-table>
        <caption class="s-li0wom">${escapeHtml(copy.heading)}</caption>
        <thead><tr>
          <th class="${TABLE_HEAD_CLASS}">${locale === 'it' ? 'Valico' : locale === 'de' ? 'Übergang' : locale === 'fr' ? 'Passage' : 'Crossing'}</th>
          <th class="${TABLE_HEAD_CLASS}" style="text-align:right">${escapeHtml(copy.observed)}</th>
          <th class="${TABLE_HEAD_CLASS}">${escapeHtml(copy.direction)}</th>
          <th class="${TABLE_HEAD_CLASS}">${escapeHtml(copy.updated)}</th>
          <th class="${TABLE_HEAD_CLASS}">${escapeHtml(copy.source)}</th>
        </tr></thead>
        <tbody>${liveRows}</tbody>
      </table>
    </div>
    <p class="s-gu2hlZ">${escapeHtml(copy.note)}</p>
    <h3 style="${H3_STYLE}">${escapeHtml(copy.historyHeading)}</h3>
    <p class="s-sau7he">${escapeHtml(copy.historyLead)}</p>
    <div class="s-card" style="overflow-x:auto;padding:0">
      <table class="${TABLE_CLASS}" style="font-size:14px;min-width:520px">
        <thead><tr>
          <th class="${TABLE_HEAD_CLASS}">${locale === 'it' ? 'Valico' : locale === 'de' ? 'Übergang' : locale === 'fr' ? 'Passage' : 'Crossing'}</th>
          <th class="${TABLE_HEAD_CLASS}" style="text-align:right">${escapeHtml(copy.morning)}</th>
          <th class="${TABLE_HEAD_CLASS}" style="text-align:right">${escapeHtml(copy.evening)}</th>
          <th class="${TABLE_HEAD_CLASS}" style="text-align:right">${escapeHtml(copy.distance)}</th>
        </tr></thead>
        <tbody>${historyRows}</tbody>
      </table>
    </div>
  </section>`;
}

export function renderBorderWaitPicker(params: {
  locale: BorderWaitLocale;
  region?: BorderCrossingRegion;
  crossings: readonly BorderCrossingSlug[];
}): string {
  const { locale, region, crossings } = params;
  const copy = {
    it: { heading: region ? 'Scegli un altro valico' : 'Scegli il corridoio', label: region ? 'Valico' : 'Corridoio', go: 'Vai', fallback: 'Apri direttamente una pagina' },
    en: { heading: region ? 'Choose another crossing' : 'Choose a corridor', label: region ? 'Crossing' : 'Corridor', go: 'Go', fallback: 'Open a page directly' },
    de: { heading: region ? 'Anderen Übergang wählen' : 'Korridor wählen', label: region ? 'Übergang' : 'Korridor', go: 'Öffnen', fallback: 'Seite direkt öffnen' },
    fr: { heading: region ? 'Choisir un autre passage' : 'Choisir un corridor', label: region ? 'Passage' : 'Corridor', go: 'Ouvrir', fallback: 'Ouvrir une page directement' },
  }[locale];
  const pickerId = `bw-picker-${region ?? 'root'}-${locale}`;
  const options = region
    ? crossings.map((slug) => `<option value="${buildOggiPath(locale, slug)}">${escapeHtml(BORDER_CROSSING_DISPLAY[slug])}</option>`).join('')
    : BORDER_WAIT_REGIONS.map((candidate) => `<option value="${buildRegionalHubPath(locale, candidate)}">${escapeHtml(BORDER_REGION_DISPLAY[candidate])}</option>`).join('');
  const links = region
    ? crossings.map((slug) => `<li><a href="${buildOggiPath(locale, slug)}" style="${LINK_ACCENT_STYLE};text-decoration:underline;text-underline-offset:2px">${escapeHtml(BORDER_CROSSING_DISPLAY[slug])}</a></li>`).join('')
    : BORDER_WAIT_REGIONS.map((candidate) => `<li><a href="${buildRegionalHubPath(locale, candidate)}" style="${LINK_ACCENT_STYLE};text-decoration:underline;text-underline-offset:2px">${escapeHtml(BORDER_REGION_DISPLAY[candidate])}</a></li>`).join('');

  return `<section class="s-ziawP1" aria-labelledby="${pickerId}-heading" data-bw-picker="true">
    <h2 id="${pickerId}-heading" style="${H2_STYLE}">${escapeHtml(copy.heading)}</h2>
    <div class="s-card" style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">
      <div style="flex:1 1 240px;min-width:0">
        <label for="${pickerId}" style="display:block;font-size:14px;font-weight:600;color:var(--color-body)">${escapeHtml(copy.label)}</label>
        <select id="${pickerId}" style="margin-top:4px;min-height:44px;width:100%;border:1px solid var(--color-edge);border-radius:10px;background:var(--color-surface);padding:8px 12px;color:var(--color-body)" data-bw-picker-select>
          ${options}
        </select>
      </div>
      <button type="button" style="min-height:44px;border:0;border-radius:10px;background:var(--color-accent);padding:8px 16px;font-weight:600;color:var(--color-on-accent)" data-bw-picker-go>${escapeHtml(copy.go)}</button>
    </div>
    <details class="s-card" style="margin-top:12px">
      <summary style="cursor:pointer;font-size:14px;font-weight:600;color:var(--color-link);text-decoration:underline;text-underline-offset:2px">${escapeHtml(copy.fallback)}</summary>
      <ul class="s-eeWB4A" style="margin-top:8px">${links}</ul>
    </details>
  </section>`;
}
