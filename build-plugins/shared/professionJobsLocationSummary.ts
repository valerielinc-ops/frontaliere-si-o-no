import type { ProfessionLocale } from '../professionLandingsData';

/** The location/employer fields already exposed by each live profession job. */
export interface ProfessionLocationJob {
  city: string;
  addressLocality?: string | null;
  company: string;
  companyKey?: string | null;
}

interface CountedName {
  name: string;
  count: number;
}

interface LocationSummary extends CountedName {
  employers: Map<string, CountedName>;
}

const COPY = {
  heading: {
    it: 'Offerte attive per località',
    en: 'Active openings by location',
    de: 'Aktive Stellen nach Ort',
    fr: 'Offres actives par lieu',
  },
  provenance: {
    it: 'Località e datori sono aggregati dalle schede degli annunci attivi in Ticino disponibili per questa pagina.',
    en: 'Locations and employers are aggregated from the active Ticino listings available on this page.',
    de: 'Orte und Arbeitgeber werden aus den für diese Seite verfügbaren aktiven Tessiner Stellenanzeigen zusammengefasst.',
    fr: 'Les lieux et employeurs sont agrégés à partir des annonces actives au Tessin disponibles sur cette page.',
  },
} satisfies Record<string, Record<ProfessionLocale, string>>;

const LOCALE_TAG: Record<ProfessionLocale, string> = {
  it: 'it-CH',
  en: 'en-CH',
  de: 'de-CH',
  fr: 'fr-CH',
};

function stableKey(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

function normalizedText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function firstNonEmpty(...values: readonly unknown[]): string {
  for (const value of values) {
    const normalized = normalizedText(value);
    if (normalized) return normalized;
  }
  return '';
}

function compareNames(a: string, b: string): number {
  const left = stableKey(a);
  const right = stableKey(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

function countJobsByLocation(jobs: readonly ProfessionLocationJob[]): LocationSummary[] {
  const locations = new Map<string, LocationSummary>();

  for (const job of jobs) {
    const city = firstNonEmpty(job.addressLocality, job.city);
    if (!city) continue;

    const locationKey = stableKey(city);
    let location = locations.get(locationKey);
    if (!location) {
      location = { name: city, count: 0, employers: new Map() };
      locations.set(locationKey, location);
    } else if (compareNames(city, location.name) < 0) {
      // Normalize casing/Unicode variants without making input order visible.
      location.name = city;
    }
    location.count += 1;

    const employer = normalizedText(job.company);
    if (!employer) continue;
    const employerKey = stableKey(firstNonEmpty(job.companyKey, employer));
    const counted = location.employers.get(employerKey);
    if (counted) {
      counted.count += 1;
      if (compareNames(employer, counted.name) < 0) counted.name = employer;
    } else {
      location.employers.set(employerKey, { name: employer, count: 1 });
    }
  }

  return [...locations.values()].sort(
    (a, b) => b.count - a.count || compareNames(a.name, b.name),
  );
}

function formatCount(count: number, locale: ProfessionLocale): string {
  return new Intl.NumberFormat(LOCALE_TAG[locale]).format(count);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildLocationSentence(
  location: LocationSummary,
  locale: ProfessionLocale,
): string {
  const employerList = [...location.employers.values()]
    .sort((a, b) => b.count - a.count || compareNames(a.name, b.name))
    .slice(0, 2)
    .map(({ name, count }) => `${name} (${formatCount(count, locale)})`)
    .join(locale === 'it' ? ' e ' : locale === 'de' ? ' und ' : locale === 'fr' ? ' et ' : ' and ');
  const count = formatCount(location.count, locale);
  const singular = location.count === 1;

  const sentence: Record<ProfessionLocale, string> = {
    it: `A ${location.name} ${singular ? 'risulta' : 'risultano'} ${count} ${singular ? 'annuncio attivo' : 'annunci attivi'}${employerList ? `: ${employerList}` : ''}.`,
    en: `In ${location.name}, ${count} active ${singular ? 'opening is' : 'openings are'} listed${employerList ? `: ${employerList}` : ''}.`,
    de: `In ${location.name} ${singular ? 'ist' : 'sind'} ${count} aktive ${singular ? 'Stelle' : 'Stellen'} gelistet${employerList ? `: ${employerList}` : ''}.`,
    fr: `À ${location.name}, ${count} ${singular ? 'offre active est répertoriée' : 'offres actives sont répertoriées'}${employerList ? ` : ${employerList}` : ''}.`,
  };
  return sentence[locale];
}

/**
 * Summarize the three Ticino locations with the most current openings and
 * their leading employers. The names and counts come from the same filtered
 * live inventory rendered on the page; ties are stable across build order.
 */
export function renderProfessionJobsLocationSummary(
  locale: ProfessionLocale,
  jobs: readonly ProfessionLocationJob[],
): string {
  const locations = countJobsByLocation(jobs).slice(0, 3);
  if (locations.length === 0) return '';

  const paragraphs = locations
    .map((location) => `<p class="text-sm text-body mt-2">${escapeHtml(buildLocationSentence(location, locale))}</p>`)
    .join('\n');

  return `
    <section data-profession-location-summary="1" class="s-KZc0LQ mt-6">
      <h2 class="s-BEjFo9">${escapeHtml(COPY.heading[locale])}</h2>
      ${paragraphs}
      <p class="text-xs text-muted mt-3">${escapeHtml(COPY.provenance[locale])}</p>
    </section>`;
}
