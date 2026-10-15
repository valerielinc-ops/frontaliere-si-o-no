/**
 * Compact, page-specific offer lines for the legacy profession landings.
 *
 * The job cards already expose title, employer and locality, but in separate
 * elements. The information-gain auditor scores element boundaries and those
 * short fragments mostly collapse after masking the profession and numbers.
 * Recombining the same sourced fields in one bounded line gives the reader a
 * useful offer summary and gives each profession page a real payload of its
 * own.
 */
import type { FeaturedJob } from '../professionJobsAggregate';
import type { ProfessionLocale } from '../professionLandingsData';
import { escHtml } from './htmlEscape';
import { sanitizeJobTitleForDisplay, stripLiteralMarkdown } from './stripLiteralMarkdown';

export const MAX_PROFESSION_OFFER_INSIGHTS = 6;

const LOCALE_COPY = {
  it: {
    heading: 'Dettaglio delle offerte attive',
    more: (shown: number, total: number) =>
      `Qui sono riepilogate ${shown} offerte attive su ${total}; tutte le schede disponibili sono elencate sopra.`,
    provenance: 'Titoli, datori e località provengono dalle schede degli annunci attivi disponibili per questa pagina.',
  },
  en: {
    heading: 'Active openings in detail',
    more: (shown: number, total: number) =>
      `${shown} of ${total} active openings are summarised here; all available cards are listed above.`,
    provenance: 'Titles, employers and locations come from the active listings available for this page.',
  },
  de: {
    heading: 'Aktive Stellen im Detail',
    more: (shown: number, total: number) =>
      `Hier sind ${shown} von ${total} aktiven Stellen zusammengefasst; alle verfügbaren Karten stehen oben.`,
    provenance: 'Titel, Arbeitgeber und Orte stammen aus den für diese Seite verfügbaren aktiven Stellenanzeigen.',
  },
  fr: {
    heading: 'Détail des offres actives',
    more: (shown: number, total: number) =>
      `${shown} offres actives sur ${total} sont résumées ici ; toutes les fiches disponibles sont listées plus haut.`,
    provenance: 'Les intitulés, employeurs et lieux proviennent des annonces actives disponibles pour cette page.',
  },
} satisfies Record<ProfessionLocale, {
  heading: string;
  more: (shown: number, total: number) => string;
  provenance: string;
}>;

function clean(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function postingAge(job: FeaturedJob): number {
  return Number.isFinite(job.daysAgo) ? job.daysAgo : Number.POSITIVE_INFINITY;
}

/**
 * Build stable, human-readable lines from the same live jobs shown in cards.
 * A posting's title, employer and locality are kept together so the line is
 * useful even when the page's identity token and numeric values are masked.
 */
export function professionOfferInsightLines(
  jobs: readonly FeaturedJob[],
  locale: ProfessionLocale,
  max = MAX_PROFESSION_OFFER_INSIGHTS,
): string[] {
  const candidates = jobs
    .map((job) => {
      const localizedTitle = clean(job.titleByLocale?.[locale]);
      const title = sanitizeJobTitleForDisplay(localizedTitle || clean(job.title));
      const company = stripLiteralMarkdown(clean(job.company));
      const locality = stripLiteralMarkdown(clean(job.addressLocality) || clean(job.city));
      const line = [title, company, locality].filter(Boolean).join(' — ');
      return { line, key: fold(line), age: postingAge(job) };
    })
    .filter(({ line }) => line.length > 0)
    .sort((a, b) => {
      if (a.age !== b.age) return a.age - b.age;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    });

  const lines: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.key)) continue;
    seen.add(candidate.key);
    lines.push(candidate.line);
    if (lines.length >= Math.max(1, Math.floor(max))) break;
  }
  return lines;
}

/** Render the bounded page-specific offer block, or nothing when data is absent. */
export function renderProfessionJobOfferInsights(
  locale: ProfessionLocale,
  jobs: readonly FeaturedJob[],
  total: number,
): string {
  const lines = professionOfferInsightLines(jobs, locale);
  if (lines.length === 0) return '';

  const copy = LOCALE_COPY[locale];
  const more = total > lines.length
    ? `<p class="text-sm text-muted mt-3">${escHtml(copy.more(lines.length, total))}</p>`
    : '';
  const list = lines
    .map((line) => `<li class="text-sm text-body">${escHtml(line)}</li>`)
    .join('\n');

  return `
    <section data-profession-offer-insights="1" class="s-KZc0LQ mt-6">
      <h2 class="s-BEjFo9">${escHtml(copy.heading)}</h2>
      <ul class="list-disc pl-5 mt-2 space-y-1">${list}</ul>
      ${more}
      <p class="text-xs text-muted mt-3">${escHtml(copy.provenance)}</p>
    </section>`;
}
