/**
 * Recency-filtered job landing hubs.
 *
 * GSC data shows strong user intent for queries like
 *   "offerte di lavoro ticino negli ultimi 3 giorni"
 *   "lavoro ticino da ieri"
 * that are currently not served by a dedicated page and end up hitting
 * random job detail pages. This module provides the SEO model + slug
 * tables to ship dedicated hubs in all 4 locales for two variants:
 *   - "last-3-days"     → jobs posted in the last 3 days
 *   - "since-yesterday" → jobs posted in the last 1 day
 *
 * Designed to slot in next to `buildJobTodayLandingModel` without
 * changing the existing editorial landing contracts.
 */

import type { JobLandingLocale } from './jobEditorialLanding';

export type JobRecencyVariant = 'last-3-days' | 'since-yesterday';

export interface RecencyJobLink {
  title: string;
  company: string;
  location: string;
  href: string;
  datePosted?: string;
}

export interface JobRecencyLandingModel {
  kind: 'recency';
  variant: JobRecencyVariant;
  slug: string;
  title: string;
  heading: string;
  description: string;
  intro: string;
  updatedLabel: string;
  countsLabel: string;
  totalJobs: number;
  timeframeLabel: string;
  noResultsLabel: string;
  jobsLabel: string;
  openAllLabel: string;
  sisterLinkLabel: string;
  sisterLinkHref: string;
  jobs: RecencyJobLink[];
  faq: Array<{ question: string; answer: string }>;
}

// ── Slug tables ──────────────────────────────────────────────────────

export const JOB_RECENCY_LANDING_SLUGS: Record<JobRecencyVariant, Record<JobLandingLocale, string>> = {
  'last-3-days': {
    it: 'ultimi-3-giorni',
    en: 'last-3-days',
    de: 'letzte-3-tage',
    fr: 'derniers-3-jours',
  },
  'since-yesterday': {
    it: 'da-ieri',
    en: 'since-yesterday',
    de: 'seit-gestern',
    fr: 'depuis-hier',
  },
};

const ALL_RECENCY_SLUGS: ReadonlySet<string> = new Set<string>(
  (Object.values(JOB_RECENCY_LANDING_SLUGS) as Array<Record<JobLandingLocale, string>>).flatMap(
    (localeMap) => Object.values(localeMap),
  ),
);

/**
 * Return true when `value` matches one of the recency-landing slugs in any
 * of the 4 supported locales.
 */
export function isJobRecencyLandingSlug(value: string): boolean {
  if (!value) return false;
  return ALL_RECENCY_SLUGS.has(String(value).trim().toLowerCase());
}

/**
 * Reverse-lookup the variant + locale for a recency slug.
 * Returns null if the slug is not a recency-landing slug.
 */
export function resolveRecencyVariant(value: string): {
  variant: JobRecencyVariant;
  locale: JobLandingLocale;
} | null {
  const slug = String(value || '').trim().toLowerCase();
  if (!slug) return null;
  for (const variant of Object.keys(JOB_RECENCY_LANDING_SLUGS) as JobRecencyVariant[]) {
    const localeMap = JOB_RECENCY_LANDING_SLUGS[variant];
    for (const locale of Object.keys(localeMap) as JobLandingLocale[]) {
      if (localeMap[locale] === slug) return { variant, locale };
    }
  }
  return null;
}

/**
 * Map a variant to the "other" variant (for cross-linking).
 */
export function otherVariant(variant: JobRecencyVariant): JobRecencyVariant {
  return variant === 'last-3-days' ? 'since-yesterday' : 'last-3-days';
}

// ── Date helpers ─────────────────────────────────────────────────────

type JobLike = Record<string, unknown>;

function parseDate(value: unknown): Date | null {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function getJobFreshnessDate(job: JobLike): Date | null {
  return (
    parseDate((job as Record<string, unknown>).postedDate)
    || parseDate((job as Record<string, unknown>).datePosted)
    || parseDate((job as Record<string, unknown>).crawledAt)
    || parseDate((job as Record<string, unknown>).updatedAt)
  );
}

/**
 * True when `jobDate` is within `windowDays` calendar days of `now`.
 * Uses both a precise millisecond-based check (to avoid TZ skew inside
 * the same day) and a calendar-diff fallback for older crawls that only
 * store a date component.
 */
export function isWithinWindow(jobDate: Date | null, now: Date, windowDays: number): boolean {
  if (!jobDate) return false;
  const ms = now.getTime() - jobDate.getTime();
  if (ms >= 0 && ms <= windowDays * 24 * 60 * 60 * 1000) return true;
  const dayMs = 24 * 60 * 60 * 1000;
  const utcNow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const utcJob = Date.UTC(jobDate.getUTCFullYear(), jobDate.getUTCMonth(), jobDate.getUTCDate());
  const calendarDiff = Math.floor((utcNow - utcJob) / dayMs);
  return calendarDiff >= 0 && calendarDiff <= windowDays - 1;
}

export function windowDaysForVariant(variant: JobRecencyVariant): number {
  return variant === 'last-3-days' ? 3 : 1;
}

// ── Copy ─────────────────────────────────────────────────────────────

interface RecencyCopy {
  title: (count: number) => string;
  heading: (count: number) => string;
  description: (count: number, year: number) => string;
  intro: string;
  timeframeLabel: string;
  updatedLabel: string;
  countsLabel: string;
  noResultsLabel: string;
  jobsLabel: string;
  openAllLabel: string;
  sisterLinkLabel: string;
  faq: Array<{ question: string; answer: string }>;
}

type CopyTable = Record<JobRecencyVariant, Record<JobLandingLocale, RecencyCopy>>;

const COPY: CopyTable = {
  'last-3-days': {
    it: {
      title: (n) => `${n > 0 ? '🔥 ' : ''}${n > 0 ? `${n} ` : ''}Offerte di Lavoro Ticino negli Ultimi 3 Giorni — Aggiornate Oggi`,
      heading: (n) => `Offerte di lavoro in Ticino negli ultimi 3 giorni${n > 0 ? ` (${n})` : ''}`,
      description: (n, year) =>
        n > 0
          ? `Scopri ${n} offerte di lavoro pubblicate in Ticino negli ultimi 3 giorni. Listino aggiornato in tempo reale nel ${year} con link diretto alla candidatura.`
          : `Offerte di lavoro in Ticino pubblicate negli ultimi 3 giorni. Listino aggiornato in tempo reale nel ${year}, con link diretto alla candidatura.`,
      intro:
        'Questa pagina raccoglie tutti gli annunci di lavoro in Ticino pubblicati negli ultimi 72 ore dai nostri crawler. Pensata per chi cerca attivamente e vuole candidarsi prima che le offerte scadano.',
      timeframeLabel: 'Ultimi 3 giorni',
      updatedLabel: 'Aggiornamento',
      countsLabel: 'offerte recenti',
      noResultsLabel: 'Nessuna nuova offerta negli ultimi 3 giorni. Torna domani o consulta l\'archivio completo.',
      jobsLabel: 'Offerte degli ultimi 3 giorni',
      openAllLabel: 'Vedi tutte le offerte di lavoro in Ticino',
      sisterLinkLabel: 'Vedi solo le offerte pubblicate da ieri',
      faq: [
        {
          question: 'Quali offerte rientrano in "ultimi 3 giorni"?',
          answer: 'Tutti gli annunci con data di pubblicazione negli ultimi 72 ore, aggiornati ogni giorno dai nostri crawler ufficiali in Ticino.',
        },
        {
          question: 'Posso candidarmi direttamente da qui?',
          answer: 'Sì. Ogni annuncio porta alla pagina dettaglio con link alla candidatura ufficiale sul sito dell\'azienda o ente pubblico.',
        },
        {
          question: 'Con quale frequenza viene aggiornata la lista?',
          answer: 'La lista è rigenerata ad ogni ciclo di crawling (più volte al giorno). La data di aggiornamento è visibile in alto.',
        },
      ],
    },
    en: {
      title: (n) => `${n > 0 ? '🔥 ' : ''}${n > 0 ? `${n} ` : ''}Ticino Jobs From The Last 3 Days — Updated Today`,
      heading: (n) => `Jobs in Ticino from the last 3 days${n > 0 ? ` (${n})` : ''}`,
      description: (n, year) =>
        n > 0
          ? `Browse ${n} jobs in Ticino posted in the last 3 days. Real-time feed updated in ${year} with direct application links.`
          : `Jobs in Ticino posted in the last 3 days. Real-time feed updated in ${year}, with direct application links.`,
      intro:
        'This page collects every job posting in Ticino published in the last 72 hours by our crawlers. Built for active job seekers who want to apply before listings expire.',
      timeframeLabel: 'Last 3 days',
      updatedLabel: 'Updated',
      countsLabel: 'recent jobs',
      noResultsLabel: 'No new jobs in the last 3 days. Come back tomorrow or browse the full archive.',
      jobsLabel: 'Jobs from the last 3 days',
      openAllLabel: 'See all jobs in Ticino',
      sisterLinkLabel: 'Show only jobs posted since yesterday',
      faq: [
        {
          question: 'Which jobs qualify as "last 3 days"?',
          answer: 'Every listing with a publication date in the last 72 hours, refreshed daily by our official Ticino crawlers.',
        },
        {
          question: 'Can I apply directly from here?',
          answer: 'Yes. Each listing leads to a detail page with a direct link to the official application on the employer or public-body website.',
        },
        {
          question: 'How often is the list updated?',
          answer: 'The list is regenerated on every crawl cycle (multiple times per day). The update timestamp is shown at the top.',
        },
      ],
    },
    de: {
      title: (n) => `${n > 0 ? '🔥 ' : ''}${n > 0 ? `${n} ` : ''}Jobs im Tessin der letzten 3 Tage — Heute aktualisiert`,
      heading: (n) => `Jobs im Tessin der letzten 3 Tage${n > 0 ? ` (${n})` : ''}`,
      description: (n, year) =>
        n > 0
          ? `Entdecken Sie ${n} Stellenangebote im Tessin aus den letzten 3 Tagen. Echtzeit-Feed aktualisiert in ${year} mit direktem Bewerbungslink.`
          : `Stellenangebote im Tessin aus den letzten 3 Tagen. Echtzeit-Feed aktualisiert in ${year} mit direktem Bewerbungslink.`,
      intro:
        'Diese Seite bündelt alle Stellen im Tessin, die in den letzten 72 Stunden von unseren Crawlern erfasst wurden — für aktive Kandidaten, die sich schnell bewerben wollen.',
      timeframeLabel: 'Letzte 3 Tage',
      updatedLabel: 'Aktualisiert',
      countsLabel: 'neue Angebote',
      noResultsLabel: 'Keine neuen Stellen in den letzten 3 Tagen. Schauen Sie morgen wieder vorbei oder im Gesamtarchiv.',
      jobsLabel: 'Stellen der letzten 3 Tage',
      openAllLabel: 'Alle Stellenangebote im Tessin ansehen',
      sisterLinkLabel: 'Nur Stellen seit gestern anzeigen',
      faq: [
        {
          question: 'Welche Stellen zählen als "letzte 3 Tage"?',
          answer: 'Alle Inserate mit Veröffentlichungsdatum in den letzten 72 Stunden — täglich durch unsere Tessiner Crawler aktualisiert.',
        },
        {
          question: 'Kann ich mich direkt von hier bewerben?',
          answer: 'Ja. Jedes Inserat führt zu einer Detailseite mit direktem Link zum offiziellen Bewerbungsformular.',
        },
        {
          question: 'Wie oft wird die Liste aktualisiert?',
          answer: 'Die Liste wird bei jedem Crawler-Durchlauf (mehrmals täglich) neu generiert. Der Aktualisierungszeitstempel ist oben sichtbar.',
        },
      ],
    },
    fr: {
      title: (n) => `${n > 0 ? '🔥 ' : ''}${n > 0 ? `${n} ` : ''}Offres d'emploi Tessin des 3 derniers jours — Mises à jour aujourd'hui`,
      heading: (n) => `Offres d'emploi au Tessin des 3 derniers jours${n > 0 ? ` (${n})` : ''}`,
      description: (n, year) =>
        n > 0
          ? `Consultez ${n} offres d'emploi au Tessin publiées ces 3 derniers jours. Flux en temps réel mis à jour en ${year} avec lien direct vers la candidature.`
          : `Offres d'emploi au Tessin publiées ces 3 derniers jours. Flux en temps réel mis à jour en ${year}, avec lien direct vers la candidature.`,
      intro:
        'Cette page rassemble toutes les offres d\'emploi au Tessin publiées ces 72 dernières heures par nos crawlers. Pensée pour les candidats actifs qui veulent postuler avant expiration.',
      timeframeLabel: '3 derniers jours',
      updatedLabel: 'Mis à jour',
      countsLabel: 'offres récentes',
      noResultsLabel: 'Aucune nouvelle offre ces 3 derniers jours. Revenez demain ou consultez l\'archive complète.',
      jobsLabel: 'Offres des 3 derniers jours',
      openAllLabel: 'Voir toutes les offres d\'emploi au Tessin',
      sisterLinkLabel: 'Afficher uniquement les offres depuis hier',
      faq: [
        {
          question: 'Quelles offres entrent dans "3 derniers jours" ?',
          answer: 'Toutes les annonces avec une date de publication dans les 72 dernières heures, actualisées chaque jour par nos crawlers officiels.',
        },
        {
          question: 'Puis-je postuler directement depuis ici ?',
          answer: 'Oui. Chaque annonce renvoie à sa fiche détaillée avec lien direct vers la candidature officielle.',
        },
        {
          question: 'À quelle fréquence la liste est-elle mise à jour ?',
          answer: 'La liste est régénérée à chaque cycle de crawl (plusieurs fois par jour). La date de mise à jour est affichée en haut.',
        },
      ],
    },
  },
  'since-yesterday': {
    it: {
      title: (n) => `${n > 0 ? '🔥 ' : ''}${n > 0 ? `${n} ` : ''}Offerte di Lavoro Ticino da Ieri — Nuove Oggi`,
      heading: (n) => `Offerte di lavoro in Ticino da ieri${n > 0 ? ` (${n})` : ''}`,
      description: (n, year) =>
        n > 0
          ? `Scopri ${n} offerte di lavoro pubblicate in Ticino da ieri. Feed in tempo reale aggiornato nel ${year} con link diretto alla candidatura.`
          : `Offerte di lavoro in Ticino pubblicate da ieri. Feed in tempo reale aggiornato nel ${year} con link diretto alla candidatura.`,
      intro:
        'Questa pagina mostra solo le offerte di lavoro in Ticino pubblicate nelle ultime 24 ore. Ideale per i candidati più veloci che vogliono essere tra i primi a farsi avanti.',
      timeframeLabel: 'Da ieri',
      updatedLabel: 'Aggiornamento',
      countsLabel: 'offerte da ieri',
      noResultsLabel: 'Nessuna nuova offerta da ieri. Riprova più tardi o consulta le offerte degli ultimi 3 giorni.',
      jobsLabel: 'Offerte da ieri',
      openAllLabel: 'Vedi tutte le offerte di lavoro in Ticino',
      sisterLinkLabel: 'Vedi anche le offerte degli ultimi 3 giorni',
      faq: [
        {
          question: 'Cosa significa "da ieri"?',
          answer: 'Annunci con data di pubblicazione nelle ultime 24 ore dalla mezzanotte di ieri.',
        },
        {
          question: 'Come vengono aggiornate?',
          answer: 'I nostri crawler girano più volte al giorno sui portali ufficiali e le aziende principali in Ticino.',
        },
      ],
    },
    en: {
      title: (n) => `${n > 0 ? '🔥 ' : ''}${n > 0 ? `${n} ` : ''}Ticino Jobs Since Yesterday — New Today`,
      heading: (n) => `Jobs in Ticino since yesterday${n > 0 ? ` (${n})` : ''}`,
      description: (n, year) =>
        n > 0
          ? `Browse ${n} jobs in Ticino posted since yesterday. Real-time feed updated in ${year} with direct application links.`
          : `Jobs in Ticino posted since yesterday. Real-time feed updated in ${year} with direct application links.`,
      intro:
        'This page shows only the Ticino job postings from the last 24 hours. Perfect for the fastest candidates who want to apply early.',
      timeframeLabel: 'Since yesterday',
      updatedLabel: 'Updated',
      countsLabel: 'jobs since yesterday',
      noResultsLabel: 'No new jobs since yesterday. Try again later or browse the last 3 days.',
      jobsLabel: 'Jobs since yesterday',
      openAllLabel: 'See all jobs in Ticino',
      sisterLinkLabel: 'See jobs from the last 3 days',
      faq: [
        {
          question: 'What does "since yesterday" mean?',
          answer: 'Listings with a publication date within the last 24 hours from midnight yesterday.',
        },
        {
          question: 'How are they updated?',
          answer: 'Our crawlers run multiple times per day across the official Ticino portals and major employers.',
        },
      ],
    },
    de: {
      title: (n) => `${n > 0 ? '🔥 ' : ''}${n > 0 ? `${n} ` : ''}Jobs im Tessin seit gestern — Neu heute`,
      heading: (n) => `Jobs im Tessin seit gestern${n > 0 ? ` (${n})` : ''}`,
      description: (n, year) =>
        n > 0
          ? `Entdecken Sie ${n} Stellenangebote im Tessin seit gestern. Echtzeit-Feed aktualisiert in ${year} mit direktem Bewerbungslink.`
          : `Stellenangebote im Tessin seit gestern. Echtzeit-Feed aktualisiert in ${year} mit direktem Bewerbungslink.`,
      intro:
        'Diese Seite zeigt nur die Tessiner Stellen, die in den letzten 24 Stunden veröffentlicht wurden — perfekt für schnelle Bewerber.',
      timeframeLabel: 'Seit gestern',
      updatedLabel: 'Aktualisiert',
      countsLabel: 'Angebote seit gestern',
      noResultsLabel: 'Keine neuen Stellen seit gestern. Schauen Sie später vorbei oder prüfen Sie die letzten 3 Tage.',
      jobsLabel: 'Stellen seit gestern',
      openAllLabel: 'Alle Stellenangebote im Tessin ansehen',
      sisterLinkLabel: 'Stellen der letzten 3 Tage ansehen',
      faq: [
        {
          question: 'Was bedeutet "seit gestern"?',
          answer: 'Inserate mit Veröffentlichungsdatum in den letzten 24 Stunden ab Mitternacht gestern.',
        },
        {
          question: 'Wie werden sie aktualisiert?',
          answer: 'Unsere Crawler laufen mehrmals täglich auf den offiziellen Tessiner Portalen und bei großen Arbeitgebern.',
        },
      ],
    },
    fr: {
      title: (n) => `${n > 0 ? '🔥 ' : ''}${n > 0 ? `${n} ` : ''}Offres d'emploi Tessin depuis hier — Nouveau aujourd'hui`,
      heading: (n) => `Offres d'emploi au Tessin depuis hier${n > 0 ? ` (${n})` : ''}`,
      description: (n, year) =>
        n > 0
          ? `Consultez ${n} offres d'emploi au Tessin publiées depuis hier. Flux en temps réel mis à jour en ${year} avec lien direct vers la candidature.`
          : `Offres d'emploi au Tessin publiées depuis hier. Flux en temps réel mis à jour en ${year} avec lien direct vers la candidature.`,
      intro:
        'Cette page affiche uniquement les offres d\'emploi au Tessin publiées ces 24 dernières heures — idéal pour les candidats les plus rapides.',
      timeframeLabel: 'Depuis hier',
      updatedLabel: 'Mis à jour',
      countsLabel: 'offres depuis hier',
      noResultsLabel: 'Aucune nouvelle offre depuis hier. Réessayez plus tard ou consultez les 3 derniers jours.',
      jobsLabel: 'Offres depuis hier',
      openAllLabel: 'Voir toutes les offres d\'emploi au Tessin',
      sisterLinkLabel: 'Voir les offres des 3 derniers jours',
      faq: [
        {
          question: 'Que signifie "depuis hier" ?',
          answer: 'Annonces avec une date de publication dans les 24 dernières heures à partir de minuit hier.',
        },
        {
          question: 'À quelle fréquence sont-elles mises à jour ?',
          answer: 'Nos crawlers tournent plusieurs fois par jour sur les portails officiels et les principaux employeurs du Tessin.',
        },
      ],
    },
  },
};

// ── Slug / href helpers ─────────────────────────────────────────────

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function normalizeSpace(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function sortByFreshness(jobs: JobLike[]): JobLike[] {
  return [...jobs].sort((a, b) => {
    const aTime = getJobFreshnessDate(a)?.getTime() || 0;
    const bTime = getJobFreshnessDate(b)?.getTime() || 0;
    if (bTime !== aTime) return bTime - aTime;
    return normalizeSpace((a as { title?: string }).title).localeCompare(
      normalizeSpace((b as { title?: string }).title),
      'it',
      { sensitivity: 'base' },
    );
  });
}

function buildRecencyHref(
  baseUrl: string,
  localePrefix: string,
  sectionSlug: string,
  variantSlug: string,
): string {
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  return ensureTrailingSlash(
    `${trimmedBase}${`${localePrefix}/${sectionSlug}/${variantSlug}`.replace(/\/+/g, '/')}`,
  );
}

// ── Public builder ──────────────────────────────────────────────────

/**
 * Build the recency-landing model. Pure function — callers (Vite plugin
 * at build time, router at navigation time) pass the job list and locale.
 * When called with an empty job list (slug-only mode, used by the router),
 * the slug / title shape still resolves correctly.
 */
export function buildJobRecencyLandingModel(options: {
  jobs: ReadonlyArray<JobLike>;
  locale: JobLandingLocale;
  variant: JobRecencyVariant;
  now?: string | Date;
  localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
  baseUrl: string;
  sectionSlug: string;
  localePrefix: string;
  year?: number;
  maxJobs?: number;
}): JobRecencyLandingModel {
  const { locale, variant } = options;
  const copy = COPY[variant][locale];
  const now = options.now instanceof Date
    ? options.now
    : new Date(options.now || new Date().toISOString());
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const slug = JOB_RECENCY_LANDING_SLUGS[variant][locale];
  const windowDays = windowDaysForVariant(variant);
  const year = options.year ?? now.getUTCFullYear();
  const maxJobs = options.maxJobs ?? 50;

  const matching = options.jobs.filter(
    (job) => isWithinWindow(getJobFreshnessDate(job as JobLike), now, windowDays),
  );
  const sorted = sortByFreshness(matching as JobLike[]).slice(0, maxJobs);
  const count = matching.length;

  const jobs: RecencyJobLink[] = sorted.map((job) => {
    const j = job as Record<string, unknown>;
    const titleByLocale = (j.titleByLocale as Record<string, unknown> | undefined) || {};
    const localized = String(titleByLocale[locale] || j.title || 'Offerta lavoro');
    const rawSlug = options.localizedSlug(job, locale);
    const href = buildRecencyHref(baseUrl, options.localePrefix, options.sectionSlug, rawSlug);
    const posted = getJobFreshnessDate(job as JobLike);
    return {
      title: normalizeSpace(localized),
      company: normalizeSpace(j.company),
      location: normalizeSpace(j.location),
      href,
      datePosted: posted ? posted.toISOString() : undefined,
    };
  });

  const sisterSlug = JOB_RECENCY_LANDING_SLUGS[otherVariant(variant)][locale];
  const sisterLinkHref = buildRecencyHref(baseUrl, options.localePrefix, options.sectionSlug, sisterSlug);

  // Build the count-prefixed title/heading deterministically
  const title = buildRecencyTitle(variant, locale, count);
  const heading = copy.heading(count);
  const description = copy.description(count, year);

  return {
    kind: 'recency',
    variant,
    slug,
    title,
    heading,
    description,
    intro: copy.intro,
    updatedLabel: copy.updatedLabel,
    countsLabel: copy.countsLabel,
    totalJobs: count,
    timeframeLabel: copy.timeframeLabel,
    noResultsLabel: copy.noResultsLabel,
    jobsLabel: copy.jobsLabel,
    openAllLabel: copy.openAllLabel,
    sisterLinkLabel: copy.sisterLinkLabel,
    sisterLinkHref,
    jobs,
    faq: copy.faq,
  };
}

/**
 * Build the `<title>` string for a recency landing with a live count.
 * Exposed as a standalone helper so it is trivially unit-testable.
 */
export function buildRecencyTitle(
  variant: JobRecencyVariant,
  locale: JobLandingLocale,
  count: number,
): string {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  return COPY[variant][locale].title(safe);
}

// Re-export for tests / consumers that want to iterate slugs directly
export function listRecencyLandingPaths(
  sectionByLocale: Record<JobLandingLocale, string>,
  localePrefix: Record<JobLandingLocale, string>,
): Array<{ locale: JobLandingLocale; variant: JobRecencyVariant; path: string }> {
  const out: Array<{ locale: JobLandingLocale; variant: JobRecencyVariant; path: string }> = [];
  for (const variant of Object.keys(JOB_RECENCY_LANDING_SLUGS) as JobRecencyVariant[]) {
    for (const locale of Object.keys(JOB_RECENCY_LANDING_SLUGS[variant]) as JobLandingLocale[]) {
      const slug = JOB_RECENCY_LANDING_SLUGS[variant][locale];
      const path = `${localePrefix[locale]}/${sectionByLocale[locale]}/${slug}/`.replace(/\/+/g, '/');
      out.push({ locale, variant, path });
    }
  }
  return out;
}
