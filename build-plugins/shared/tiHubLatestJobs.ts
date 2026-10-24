/**
 * Ticino job-board hub — live data area (stat tiles + latest job cards).
 *
 * Why. `/cerca-lavoro-ticino/` (+ en/de/fr twins) is the page that should rank
 * for the head queries «lavoro ticino» / «offerte di lavoro ticino», yet on
 * 2026-10-24 its static HTML linked ZERO job detail pages: 1'357 anchors, all
 * pagination ladders and canton navigators. Google kept serving single job
 * details for those queries (position 8-10) and parked the hub at 23-27. Every
 * canton hub emitted by jobsSeoPagesPlugin already ships "Ultime offerte di
 * lavoro in <canton>"; the Ticino hub — owned by staticPagesPlugin — did not.
 *
 * How. staticPagesPlugin leaves {@link TI_HUB_LATEST_JOBS_SLOT} right under the
 * H1. jobsSeoPagesPlugin, the only owner of the active-detail registry,
 * renders the block per locale with {@link renderTiHubLatestJobsBlock} and
 * publishes it through `setTiHubLatestJobsBlocks` (buildSignals). The
 * tiHubLatestJobsPlugin patcher replaces the slot once both producers flushed.
 * Only self-canonical active detail URLs are linked (same rule as the canton
 * hub grid), so a card can never point at a bridge or a 404.
 */

import {
  JOB_CARD_ICON_SYMBOLS,
  renderJobCardHtml,
  type JobCardJob,
  type JobCardLocale,
} from './jobCardHtml';

/** Empty placeholder emitted by staticPagesPlugin under the TI hub H1. */
export const TI_HUB_LATEST_JOBS_SLOT = '<section data-ti-hub-latest-jobs-slot hidden></section>';

/** Marker carried by the rendered block (idempotency + tests). */
export const TI_HUB_LATEST_JOBS_MARKER = 'data-ti-hub-latest-jobs';

/** Same card count as the canton hubs' "latest jobs" grid. */
export const TI_HUB_LATEST_JOBS_LIMIT = 12;

export type TiHubLocale = JobCardLocale;

export interface TiHubInventoryStats {
  /** Most frequent city in the active Ticino pool, with its job count. */
  topCity: { name: string; count: number } | null;
  /** Distinct employers in the active Ticino pool. */
  employerCount: number;
  /** Employer with the most active Ticino listings. */
  topEmployer: { name: string; count: number } | null;
}

export interface TiHubLatestJobsInput {
  locale: TiHubLocale;
  jobs: ReadonlyArray<{ job: JobCardJob; href: string }>;
  stats: TiHubInventoryStats;
  /** "Jobs posted today" editorial landing of the TI section. */
  todayHref: string;
  /** Full paginated archive of the TI section. */
  allHref: string;
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function topEntry(counts: Map<string, { name: string; count: number }>): { name: string; count: number } | null {
  let best: { name: string; count: number } | null = null;
  const sorted = [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, value] of sorted) {
    if (!best || value.count > best.count) best = value;
  }
  return best;
}

/**
 * Pure aggregate over the active Ticino listing pool. City = the first
 * comma-separated part of `location` (same rule as the canton hub tiles);
 * employers are counted case-insensitively. Ties break alphabetically so the
 * output is deterministic across builds of the same data.
 */
export function summarizeTiHubInventory(
  pool: ReadonlyArray<{ location?: unknown; company?: unknown }>,
): TiHubInventoryStats {
  const cities = new Map<string, { name: string; count: number }>();
  const employers = new Map<string, { name: string; count: number }>();
  for (const job of pool) {
    const city = String(job?.location ?? '').split(',')[0].trim();
    if (city) {
      const key = city.toLowerCase();
      const cur = cities.get(key);
      if (cur) cur.count++;
      else cities.set(key, { name: city, count: 1 });
    }
    const company = String(job?.company ?? '').trim();
    if (company) {
      const key = company.toLowerCase();
      const cur = employers.get(key);
      if (cur) cur.count++;
      else employers.set(key, { name: company, count: 1 });
    }
  }
  return {
    topCity: topEntry(cities),
    employerCount: employers.size,
    topEmployer: topEntry(employers),
  };
}

const COPY: Record<TiHubLocale, {
  heading: string;
  intro: string;
  topCity: string;
  employers: string;
  topEmployer: string;
  today: string;
  all: string;
}> = {
  it: {
    heading: 'Ultime offerte di lavoro in Ticino',
    intro: 'Gli annunci più recenti con sede in Canton Ticino: apri la scheda per requisiti, sede e candidatura.',
    topCity: 'Città con più offerte',
    employers: 'Aziende che assumono',
    topEmployer: 'Datore con più annunci',
    today: 'Offerte pubblicate oggi',
    all: 'Sfoglia tutte le offerte',
  },
  en: {
    heading: 'Latest job openings in Ticino',
    intro: 'The most recent listings based in Canton Ticino: open each one for requirements, location and how to apply.',
    topCity: 'City with most openings',
    employers: 'Hiring employers',
    topEmployer: 'Top employer',
    today: 'Jobs posted today',
    all: 'Browse all openings',
  },
  de: {
    heading: 'Neueste Stellenangebote im Tessin',
    intro: 'Die aktuellsten Inserate mit Arbeitsort im Kanton Tessin: Anforderungen, Ort und Bewerbung stehen im Inserat.',
    topCity: 'Stadt mit den meisten Stellen',
    employers: 'Einstellende Unternehmen',
    topEmployer: 'Arbeitgeber mit den meisten Inseraten',
    today: 'Heute veröffentlicht',
    all: 'Alle Stellen ansehen',
  },
  fr: {
    heading: 'Dernières offres d’emploi au Tessin',
    intro: 'Les annonces les plus récentes situées au Tessin : ouvrez chaque fiche pour les exigences, le lieu et la candidature.',
    topCity: 'Ville avec le plus d’offres',
    employers: 'Employeurs qui recrutent',
    topEmployer: 'Employeur le plus actif',
    today: 'Offres publiées aujourd’hui',
    all: 'Voir toutes les offres',
  },
};

/**
 * Render the TI hub data area. Returns '' when there is no linkable job, so
 * the patcher simply clears the slot and the hub never shows an empty grid.
 * Markup reuses the canton-hub classes (`s-qkhIAD` tile grid, shared job
 * cards) that seo-static.css / index.css already style on every hub.
 */
export function renderTiHubLatestJobsBlock(input: TiHubLatestJobsInput): string {
  const cards = input.jobs.slice(0, TI_HUB_LATEST_JOBS_LIMIT);
  if (cards.length === 0) return '';
  const c = COPY[input.locale];
  const fmt = (n: number) => n.toLocaleString('de-CH');
  const tiles: string[] = [];
  if (input.stats.topCity) {
    tiles.push(
      `<div class="s-aHhpNC" data-stat-tile="accent"><div class="s-hr1jx1">${esc(c.topCity)}</div>` +
      `<div class="s-9is_7q">${esc(input.stats.topCity.name)} · ${fmt(input.stats.topCity.count)}</div></div>`,
    );
  }
  if (input.stats.employerCount > 0) {
    tiles.push(
      `<div class="s-ZeLwIZ" data-stat-tile="success"><div class="s-hr1jx1">${esc(c.employers)}</div>` +
      `<div class="s-I_TRkF">${fmt(input.stats.employerCount)}</div></div>`,
    );
  }
  if (input.stats.topEmployer) {
    tiles.push(
      `<div class="s-RWhR1p" data-stat-tile="warning"><div class="s-hr1jx1">${esc(c.topEmployer)}</div>` +
      `<div class="s-9is_7q">${esc(input.stats.topEmployer.name)} · ${fmt(input.stats.topEmployer.count)}</div></div>`,
    );
  }
  const tileGrid = tiles.length > 0 ? `<div class="s-qkhIAD" data-stat-tile-grid>${tiles.join('')}</div>` : '';
  const cta =
    `<p class="s-ziawP1"><a class="s-yy370N" data-primary-cta href="${esc(input.todayHref)}">${esc(c.today)}</a> ` +
    `<a href="${esc(input.allHref)}">${esc(c.all)}</a></p>`;
  const grid =
    `<div data-listing-grid class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 my-6">` +
    JOB_CARD_ICON_SYMBOLS +
    cards.map(({ job, href }) => renderJobCardHtml(job, { href, locale: input.locale })).join('') +
    `</div>`;
  return (
    `<section ${TI_HUB_LATEST_JOBS_MARKER}>` +
    tileGrid +
    cta +
    `<h2 class="s-iEVPhz">${esc(c.heading)}</h2>` +
    `<p>${esc(c.intro)}</p>` +
    grid +
    `</section>`
  );
}

export type TiHubSlotOutcome = 'inserted' | 'cleared' | 'duplicate' | 'no-slot';

/**
 * Replace the slot with `block` (or remove it when `block` is empty). A page
 * that already carries the marker is left untouched (idempotent re-runs).
 */
export function applyTiHubLatestJobsSlot(html: string, block: string): { html: string; outcome: TiHubSlotOutcome } {
  if (html.includes(`<section ${TI_HUB_LATEST_JOBS_MARKER}>`)) return { html, outcome: 'duplicate' };
  const at = html.indexOf(TI_HUB_LATEST_JOBS_SLOT);
  if (at < 0) return { html, outcome: 'no-slot' };
  const next = html.slice(0, at) + block + html.slice(at + TI_HUB_LATEST_JOBS_SLOT.length);
  return { html: next, outcome: block ? 'inserted' : 'cleared' };
}
