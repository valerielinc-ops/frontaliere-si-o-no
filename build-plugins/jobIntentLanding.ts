import { resolveJobCanton } from './shared/cantonSection';
import type { JobLandingLocale, LandingJobLink } from './jobEditorialLanding';

/**
 * Demand-qualified, non-taxonomic job intents.
 *
 * Keep this list deliberately small: these pages are emitted only when the
 * live inventory reaches the same five-job floor used by canton landings.
 * The first two intents are backed by the observed Ticino search clusters
 * "tedesco/german-speaking" and "senza esperienza/without experience".
 */
export const JOB_INTENT_KEYS = ['german-speaking', 'without-experience'] as const;
export type JobIntentKey = (typeof JOB_INTENT_KEYS)[number];
export const JOB_INTENT_MIN_INDEXABLE_JOBS = 5;

type JobLike = Record<string, any>;

type IntentCopy = {
  slug: string;
  title: string;
  heading: string;
  description: (count: number) => string;
  intro: string;
  countsLabel: string;
  feedLabel: string;
  latestLabel: string;
  relatedLabel: string;
  openAllLabel: string;
};

const INTENT_COPY: Record<JobIntentKey, Record<JobLandingLocale, IntentCopy>> = {
  'german-speaking': {
    it: {
      slug: 'lavoro-tedesco-ticino',
      title: 'Lavoro con tedesco in Ticino | Offerte aggiornate',
      heading: 'Lavoro in Ticino per chi parla tedesco',
      description: (count) => `Scopri ${count} offerte in Ticino che richiedono o valorizzano il tedesco, con annunci attivi e candidatura diretta.`,
      intro: 'Questa selezione raccoglie gli annunci in cui il tedesco è indicato come requisito o vantaggio concreto. Controlla sempre il livello richiesto nella descrizione e verifica la sede, perché la conoscenza del tedesco è particolarmente utile nei ruoli a contatto con clienti, turismo, sanità e aziende attive in tutta la Svizzera.',
      countsLabel: 'annunci con tedesco',
      feedLabel: 'Offerte che valorizzano il tedesco',
      latestLabel: 'Nuovi annunci degli ultimi 3 giorni',
      relatedLabel: 'Altri percorsi di ricerca',
      openAllLabel: 'Vedi tutte le offerte in Ticino',
    },
    en: {
      slug: 'german-speaking-jobs-ticino',
      title: 'German-speaking jobs in Ticino | Updated listings',
      heading: 'German-speaking jobs in Ticino',
      description: (count) => `Browse ${count} active Ticino jobs that require or value German, with direct links to the employer application.`,
      intro: 'This selection groups listings where German is stated as a requirement or a concrete advantage. Check the requested level in each description and confirm the work location: German is especially useful in customer-facing, tourism, healthcare and Switzerland-wide roles.',
      countsLabel: 'jobs mentioning German',
      feedLabel: 'Jobs that value German',
      latestLabel: 'New listings from the last 3 days',
      relatedLabel: 'Other search paths',
      openAllLabel: 'See all jobs in Ticino',
    },
    de: {
      slug: 'deutschsprachige-jobs-tessin',
      title: 'Deutschsprachige Jobs im Tessin | Aktuelle Stellen',
      heading: 'Deutschsprachige Jobs im Tessin',
      description: (count) => `Entdecken Sie ${count} aktive Stellen im Tessin, in denen Deutsch verlangt oder ausdrücklich geschätzt wird.`,
      intro: 'Diese Auswahl bündelt Stellenanzeigen, in denen Deutsch als Voraussetzung oder konkreter Vorteil genannt wird. Prüfen Sie das geforderte Niveau in jeder Anzeige und den Arbeitsort: Deutsch ist besonders bei Kundenkontakt, Tourismus, Gesundheit und schweizweit tätigen Unternehmen hilfreich.',
      countsLabel: 'Stellen mit Deutsch',
      feedLabel: 'Stellen, die Deutsch voraussetzen oder schätzen',
      latestLabel: 'Neue Anzeigen der letzten 3 Tage',
      relatedLabel: 'Weitere Suchwege',
      openAllLabel: 'Alle Jobs im Tessin ansehen',
    },
    fr: {
      slug: 'emplois-germanophones-tessin',
      title: 'Emplois avec allemand au Tessin | Offres à jour',
      heading: 'Emplois germanophones au Tessin',
      description: (count) => `Consultez ${count} offres actives au Tessin qui demandent ou valorisent l’allemand, avec candidature directe.`,
      intro: 'Cette sélection rassemble les annonces où l’allemand est indiqué comme exigence ou avantage concret. Vérifiez le niveau demandé dans chaque descriptif et le lieu de travail : l’allemand est particulièrement utile dans la relation client, le tourisme, la santé et les entreprises présentes dans toute la Suisse.',
      countsLabel: 'offres avec allemand',
      feedLabel: 'Offres qui valorisent l’allemand',
      latestLabel: 'Nouvelles offres des 3 derniers jours',
      relatedLabel: 'Autres parcours de recherche',
      openAllLabel: 'Voir toutes les offres au Tessin',
    },
  },
  'without-experience': {
    it: {
      slug: 'lavoro-senza-esperienza-ticino',
      title: 'Lavoro senza esperienza in Ticino | Offerte aggiornate',
      heading: 'Lavoro in Ticino senza esperienza',
      description: (count) => `Trova ${count} offerte in Ticino per profili junior, prima esperienza o ingresso nel settore, aggiornate e candidabili online.`,
      intro: 'Questa pagina raccoglie gli annunci che parlano di prima esperienza, profili junior, formazione interna o ingresso nel ruolo. Leggi con attenzione i requisiti: “junior” non significa sempre “senza esperienza” e alcune posizioni richiedono comunque un diploma, una lingua o una disponibilità specifica.',
      countsLabel: 'annunci per profili junior',
      feedLabel: 'Offerte per chi entra nel settore',
      latestLabel: 'Nuovi annunci degli ultimi 3 giorni',
      relatedLabel: 'Altri percorsi di ricerca',
      openAllLabel: 'Vedi tutte le offerte in Ticino',
    },
    en: {
      slug: 'jobs-without-experience-ticino',
      title: 'Jobs without experience in Ticino | Updated listings',
      heading: 'Jobs in Ticino without experience',
      description: (count) => `Find ${count} Ticino jobs for junior profiles, first experience or career entry, with direct online applications.`,
      intro: 'This page groups listings mentioning first experience, junior profiles, training or entry into the role. Read the requirements carefully: “junior” does not always mean “no experience”, and some roles still require a qualification, language or specific availability.',
      countsLabel: 'jobs for junior profiles',
      feedLabel: 'Jobs for people entering the field',
      latestLabel: 'New listings from the last 3 days',
      relatedLabel: 'Other search paths',
      openAllLabel: 'See all jobs in Ticino',
    },
    de: {
      slug: 'jobs-ohne-erfahrung-tessin',
      title: 'Jobs ohne Erfahrung im Tessin | Aktuelle Stellen',
      heading: 'Jobs im Tessin ohne Erfahrung',
      description: (count) => `Finden Sie ${count} Stellen im Tessin für Juniorprofile, Berufseinstieg oder erste Erfahrung mit direkter Online-Bewerbung.`,
      intro: 'Diese Seite bündelt Anzeigen für Berufseinsteiger, Juniorprofile, interne Ausbildung oder den Einstieg in eine neue Rolle. Lesen Sie die Anforderungen genau: „Junior“ bedeutet nicht immer „ohne Erfahrung“; manche Stellen verlangen weiterhin einen Abschluss, Sprachkenntnisse oder besondere Verfügbarkeit.',
      countsLabel: 'Stellen für Juniorprofile',
      feedLabel: 'Stellen für den Berufseinstieg',
      latestLabel: 'Neue Anzeigen der letzten 3 Tage',
      relatedLabel: 'Weitere Suchwege',
      openAllLabel: 'Alle Jobs im Tessin ansehen',
    },
    fr: {
      slug: 'emplois-sans-experience-tessin',
      title: 'Emplois sans expérience au Tessin | Offres à jour',
      heading: 'Emplois au Tessin sans expérience',
      description: (count) => `Trouvez ${count} offres au Tessin pour profils juniors, première expérience ou entrée dans un métier.`,
      intro: 'Cette page rassemble les annonces qui mentionnent une première expérience, un profil junior, une formation interne ou une entrée dans le métier. Lisez les exigences avec attention : « junior » ne veut pas toujours dire « sans expérience » et certains postes demandent un diplôme, une langue ou une disponibilité particulière.',
      countsLabel: 'offres pour profils juniors',
      feedLabel: 'Offres pour débuter dans le métier',
      latestLabel: 'Nouvelles offres des 3 derniers jours',
      relatedLabel: 'Autres parcours de recherche',
      openAllLabel: 'Voir toutes les offres au Tessin',
    },
  },
};

const INTENT_MATCHERS: Record<JobIntentKey, (job: JobLike) => boolean> = {
  'german-speaking': (job) => {
    const text = intentText(job);
    return /\b(?:tedesc\w*|deutsch\w*|german(?:[- ]speaking|ophone)?\w*|allemand\w*)\b/i.test(text);
  },
  'without-experience': (job) => {
    const text = intentText(job);
    return /\b(?:senza\s+esperienza|prima\s+esperienza|anche\s+senza|without(?:\s+any)?\s+experience|no\s+experience|entry[- ]level|inexperienced|sans\s+exp[ée]rience|ohne\s+erfahrung|berufseinsteiger|quereinsteiger|junior)\b/i.test(text);
  },
};

function normalizeSpace(value: unknown): string {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function intentText(job: JobLike): string {
  return [
    job.title,
    job.description,
    job.requirements,
    job.skills,
    job.languages,
    job.language,
    job.languageRequirements,
    job.experienceLevel,
  ].map(normalizeSpace).filter(Boolean).join(' ');
}

function parseDate(value: unknown): Date | null {
  const raw = normalizeSpace(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function freshnessDate(job: JobLike): Date | null {
  return parseDate(job.postedDate) || parseDate(job.datePosted) || parseDate(job.crawledAt) || parseDate(job.updatedAt);
}

function isInLast3Days(jobDate: Date | null, now: Date): boolean {
  if (!jobDate) return false;
  const elapsed = now.getTime() - jobDate.getTime();
  return elapsed >= 0 && elapsed <= 3 * 24 * 60 * 60 * 1000;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

function buildJobHref(
  baseUrl: string,
  localePrefix: string,
  sectionSlug: string,
  jobSlug: string,
): string {
  return ensureTrailingSlash(`${baseUrl.replace(/\/+$/, '')}${`${localePrefix}/${sectionSlug}/${jobSlug}`.replace(/\/+/g, '/')}`);
}

function sortByFreshness(jobs: JobLike[]): JobLike[] {
  return [...jobs].sort((a, b) => {
    const aTime = freshnessDate(a)?.getTime() || 0;
    const bTime = freshnessDate(b)?.getTime() || 0;
    if (bTime !== aTime) return bTime - aTime;
    return normalizeSpace(a.title).localeCompare(normalizeSpace(b.title), 'it', { sensitivity: 'base' });
  });
}

function toLinkedJobs(
  jobs: JobLike[],
  locale: JobLandingLocale,
  options: { baseUrl: string; localePrefix: string; sectionSlug: string; localizedSlug: (job: JobLike, locale: JobLandingLocale) => string },
  max: number,
): LandingJobLink[] {
  return sortByFreshness(jobs).slice(0, max).map((job) => {
    const localizedTitles = job.titleByLocale as Record<string, unknown> | undefined;
    return {
      title: normalizeSpace(localizedTitles && typeof localizedTitles[locale] === 'string' ? localizedTitles[locale] : job.title || 'Offerta lavoro'),
      company: normalizeSpace(job.company),
      location: normalizeSpace(job.location),
      href: buildJobHref(options.baseUrl, options.localePrefix, options.sectionSlug, options.localizedSlug(job, locale)),
      datePosted: freshnessDate(job)?.toISOString(),
      titleByLocale: Object.fromEntries(Object.entries(localizedTitles || {}).filter(([, value]) => typeof value === 'string')) as Partial<Record<JobLandingLocale, string>>,
      companyKey: typeof job.companyKey === 'string' ? job.companyKey : undefined,
      canton: typeof job.canton === 'string' ? job.canton : undefined,
      contract: typeof job.contract === 'string' ? job.contract : undefined,
      salaryMin: typeof job.salaryMin === 'number' ? job.salaryMin : undefined,
      salaryMax: typeof job.salaryMax === 'number' ? job.salaryMax : undefined,
      featured: job.featured === true,
      logo: typeof job.logo === 'string' ? job.logo : undefined,
      addressLocality: typeof job.addressLocality === 'string' ? job.addressLocality : undefined,
      companyDomain: typeof job.companyDomain === 'string' ? job.companyDomain : undefined,
      url: typeof job.url === 'string' ? job.url : undefined,
    };
  });
}

function dedupeLatest(latest: LandingJobLink[], feed: LandingJobLink[]): LandingJobLink[] {
  const seen = new Set(feed.map((job) => job.href));
  return latest.filter((job) => !seen.has(job.href));
}

export function getJobIntentLandingSlug(locale: JobLandingLocale, intentKey: JobIntentKey): string {
  return INTENT_COPY[intentKey][locale].slug;
}

export function resolveJobIntentKeyBySlug(value: string): JobIntentKey | null {
  const slug = normalizeSpace(value).toLowerCase();
  return JOB_INTENT_KEYS.find((key) => Object.values(INTENT_COPY[key]).some((copy) => copy.slug === slug)) || null;
}

export function matchesJobIntent(job: JobLike, intentKey: JobIntentKey): boolean {
  return INTENT_MATCHERS[intentKey](job);
}

export type JobIntentLandingModel = {
  kind: 'intent';
  intentKey: JobIntentKey;
  slug: string;
  title: string;
  heading: string;
  description: string;
  intro: string;
  countsLabel: string;
  totalJobs: number;
  feed: { label: string; jobs: LandingJobLink[] };
  latestLabel: string;
  latestJobs: LandingJobLink[];
  relatedLabel: string;
  relatedLinks: Array<{ label: string; href: string; count: number }>;
  openAllLabel: string;
};

export function buildJobIntentLandingModel(options: {
  jobs: JobLike[];
  locale: JobLandingLocale;
  intentKey: JobIntentKey;
  canton?: string;
  now?: string | Date;
  localizedSlug: (job: JobLike, locale: JobLandingLocale) => string;
  baseUrl: string;
  sectionSlug: string;
  localePrefix: string;
}): JobIntentLandingModel {
  const canton = options.canton || 'TI';
  const copy = INTENT_COPY[options.intentKey][options.locale];
  const now = options.now instanceof Date ? options.now : new Date(options.now || new Date().toISOString());
  const matches = options.jobs.filter((job) => resolveJobCanton(job) === canton && matchesJobIntent(job, options.intentKey));
  const latest = matches.filter((job) => isInLast3Days(freshnessDate(job), now));
  const feed = toLinkedJobs(matches, options.locale, options, 18);
  const latestJobs = dedupeLatest(toLinkedJobs(latest, options.locale, options, 12), feed);
  const relatedLinks = JOB_INTENT_KEYS
    .filter((key) => key !== options.intentKey)
    .map((key) => {
      const count = options.jobs.filter((job) => resolveJobCanton(job) === canton && matchesJobIntent(job, key)).length;
      return {
        label: INTENT_COPY[key][options.locale].heading,
        href: ensureTrailingSlash(`${options.baseUrl.replace(/\/+$/, '')}${`${options.localePrefix}/${options.sectionSlug}/${getJobIntentLandingSlug(options.locale, key)}`.replace(/\/+/g, '/')}`),
        count,
      };
    })
    .filter((link) => link.count >= JOB_INTENT_MIN_INDEXABLE_JOBS);

  return {
    kind: 'intent',
    intentKey: options.intentKey,
    slug: copy.slug,
    title: copy.title,
    heading: copy.heading,
    description: copy.description(matches.length),
    intro: copy.intro,
    countsLabel: copy.countsLabel,
    totalJobs: matches.length,
    feed: { label: copy.feedLabel, jobs: feed },
    latestLabel: copy.latestLabel,
    latestJobs,
    relatedLabel: copy.relatedLabel,
    relatedLinks,
    openAllLabel: copy.openAllLabel,
  };
}
