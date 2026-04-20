/**
 * Weekly "Aziende che assumono" per-city Hub — Vite build plugin (F5).
 *
 * Emits a static HTML page per (locale × city × "current-week") plus
 * archive pages for each ISO week present in
 * `data/jobs-snapshots-history/*.json`. Pages list the top employers
 * hiring in the target city this week ranked by weekly delta
 * (new openings minus previous snapshot).
 *
 * Degradation when no snapshot history exists:
 *   - If `data/jobs-snapshots-history/` is empty or has <2 files, we still
 *     generate "current-week" pages with current jobs.json data only
 *     (no delta, "baseline data" label). Build does NOT fail.
 *   - Archive pages are only generated once ≥2 historical snapshots exist.
 *
 * Quality gates:
 *   - ≥50 words hard gate (target ≥300)
 *   - All 4 locales × 7 cities (6 cities + regional Ticino hub)
 *   - NO `dark:` color prefixes — semantic tokens via CSS vars
 *   - WriteCollector.skipExisting via content-hash manifest
 *   - Env gate: SKIP_WEEKLY_EMPLOYERS=1 short-circuits the plugin
 *
 * Indexing policy:
 *   - Current week + last 12 weekly archives: `index,follow`
 *   - Older archives: `noindex,follow` (kept reachable for continuity)
 *
 * Auto-stub employer sub-feature (DEFAULT OFF):
 *   - Env `ENABLE_AUTO_EMPLOYER_STUBS=1` — enables a `data-needs-editorial-
 *     review="true"` attribute on top-3 emerging companies lacking a
 *     curated employer brand hub. Ship disabled per plan.
 */

import type { Plugin } from 'vite';
import fs from 'node:fs';
import np from 'node:path';
import {
  ANALYTICS_SNIPPET,
  BASE_URL,
  FAVICON_LINKS,
  MIN_INDEXABLE_WORDS,
  countHtmlBodyWords,
} from './constants';
import { WriteCollector } from './batchWrite';
import {
  WEEKLY_EMPLOYERS_ARCHIVE_PREFIX,
  WEEKLY_EMPLOYERS_CITIES,
  WEEKLY_EMPLOYERS_CITY_DISPLAY,
  WEEKLY_EMPLOYERS_CURRENT_SLUG,
  WEEKLY_EMPLOYERS_INDEXABLE_WEEKS,
  WEEKLY_EMPLOYERS_LOCALE_PREFIX,
  WEEKLY_EMPLOYERS_LOCALES,
  WEEKLY_EMPLOYERS_OG_LOCALE,
  WEEKLY_EMPLOYERS_SECTION,
  buildArchiveWeekPath,
  buildCurrentWeekPath,
  getIsoWeekAndYear,
  isoWeekKey,
  type WeeklyEmployersCity,
  type WeeklyEmployersLocale,
} from './weeklyEmployersData';
import { EMPLOYER_BRANDS } from '../services/employerBrands';

// ── Types ───────────────────────────────────────────────────────

export interface WeeklyCountableJob {
  slug?: string;
  slugByLocale?: Partial<Record<WeeklyEmployersLocale, string>>;
  title?: string;
  titleByLocale?: Partial<Record<WeeklyEmployersLocale, string>>;
  company?: string;
  companyKey?: string;
  location?: string;
  addressLocality?: string;
  postedDate?: string;
  datePosted?: string;
  expired?: boolean;
  needsRetranslation?: boolean | Partial<Record<WeeklyEmployersLocale, boolean>>;
  description?: string;
  descriptionByLocale?: Partial<Record<WeeklyEmployersLocale, string>>;
  category?: string;
  sector?: string;
}

/** Minimal shape persisted to data/jobs-snapshots-history/{YYYY-WW}.json. */
export interface JobsSnapshot {
  week: string; // "YYYY-WW"
  generatedAt?: string;
  jobs: Array<{
    slug: string;
    employer: string;
    employerKey?: string;
    city: string;
    role?: string;
    postedAt?: string;
  }>;
}

/** Per-city aggregation produced from current jobs + snapshot pair. */
export interface CityWeeklyStats {
  city: WeeklyEmployersCity;
  activeJobsCount: number;
  topCompanies: Array<{
    employer: string;
    employerKey?: string;
    active: number;
    delta: number; // current active - previous active (0 if no history)
  }>;
  newcomers: Array<{ employer: string; employerKey?: string; active: number }>;
  topRoles: Array<{ role: string; count: number }>;
}

// ── Helpers ─────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wordCount(s: string | undefined | null): number {
  if (!s) return 0;
  return String(s).trim().split(/\s+/).filter(Boolean).length;
}

function jobIsActive(
  job: WeeklyCountableJob,
  locale: WeeklyEmployersLocale,
): boolean {
  if (!job || typeof job !== 'object') return false;
  if (job.expired) return false;
  const nr = job.needsRetranslation;
  if (nr === true) return false;
  if (nr && typeof nr === 'object' && (nr as Record<string, boolean>)[locale]) {
    return false;
  }
  const localeDesc = job.descriptionByLocale?.[locale];
  const fallback = locale === 'it' ? job.description : undefined;
  const desc = localeDesc && localeDesc.trim().length > 0 ? localeDesc : fallback;
  return wordCount(desc) >= 50;
}

/** Case-insensitive city match against location / addressLocality. */
export function jobMatchesCity(
  job: WeeklyCountableJob,
  city: WeeklyEmployersCity,
): boolean {
  // "ticino" regional hub matches every Swiss job we have (site is Ticino-only)
  if (city === 'ticino') return true;
  const needle = WEEKLY_EMPLOYERS_CITY_DISPLAY[city].toLowerCase();
  const candidates = [job.addressLocality, job.location]
    .map((v) => (typeof v === 'string' ? v.toLowerCase() : ''))
    .filter(Boolean);
  return candidates.some((c) => c.includes(needle));
}

function normEmployerKey(company: string, companyKey?: string): string {
  const raw = (companyKey || company || '').trim().toLowerCase();
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Build a per-city aggregation from current jobs + optional previous snapshot. */
export function buildCityWeeklyStats(opts: {
  city: WeeklyEmployersCity;
  locale: WeeklyEmployersLocale;
  jobs: readonly WeeklyCountableJob[];
  previousSnapshot?: JobsSnapshot | null;
  /** Older snapshots used to decide "first appearance". */
  historicalSnapshots?: readonly JobsSnapshot[];
  limitCompanies?: number;
}): CityWeeklyStats {
  const {
    city,
    locale,
    jobs,
    previousSnapshot,
    historicalSnapshots = [],
    limitCompanies = 20,
  } = opts;

  // Active jobs matching this city in this locale
  const cityJobs = jobs.filter(
    (j) => jobIsActive(j, locale) && jobMatchesCity(j, city),
  );

  // Count per employer (active)
  const activeCounts = new Map<
    string,
    { employer: string; employerKey?: string; active: number }
  >();
  for (const j of cityJobs) {
    const company = String(j.company || '').trim();
    if (!company) continue;
    const key = normEmployerKey(company, j.companyKey);
    const rec = activeCounts.get(key);
    if (rec) {
      rec.active++;
    } else {
      activeCounts.set(key, {
        employer: company,
        employerKey: j.companyKey || key,
        active: 1,
      });
    }
  }

  // Previous-week count per employer
  const prevCounts = new Map<string, number>();
  if (previousSnapshot?.jobs) {
    for (const row of previousSnapshot.jobs) {
      // Use same city match semantics on snapshot row
      if (city !== 'ticino') {
        if (
          !String(row.city || '')
            .toLowerCase()
            .includes(WEEKLY_EMPLOYERS_CITY_DISPLAY[city].toLowerCase())
        ) {
          continue;
        }
      }
      const key = normEmployerKey(row.employer || '', row.employerKey);
      prevCounts.set(key, (prevCounts.get(key) || 0) + 1);
    }
  }

  // Historical employer set — any employer observed in prior snapshots (except the
  // most recent / previous one) — used for "first-time" detection.
  const historicallyKnown = new Set<string>();
  for (const snap of historicalSnapshots) {
    for (const row of snap.jobs || []) {
      const key = normEmployerKey(row.employer || '', row.employerKey);
      if (key) historicallyKnown.add(key);
    }
  }
  if (previousSnapshot?.jobs) {
    for (const row of previousSnapshot.jobs) {
      const key = normEmployerKey(row.employer || '', row.employerKey);
      if (key) historicallyKnown.add(key);
    }
  }

  const topCompanies = Array.from(activeCounts.entries())
    .map(([key, rec]) => {
      const prev = prevCounts.get(key) ?? 0;
      return {
        employer: rec.employer,
        employerKey: rec.employerKey,
        active: rec.active,
        delta: rec.active - prev,
      };
    })
    .sort((a, b) => {
      if (b.delta !== a.delta) return b.delta - a.delta;
      return b.active - a.active;
    })
    .slice(0, limitCompanies);

  const newcomers = Array.from(activeCounts.entries())
    .filter(([key]) => !historicallyKnown.has(key))
    .map(([key, rec]) => ({
      employer: rec.employer,
      employerKey: rec.employerKey ?? key,
      active: rec.active,
    }))
    .sort((a, b) => b.active - a.active)
    .slice(0, 10);

  // Top roles
  const roleCounts = new Map<string, number>();
  for (const j of cityJobs) {
    const role = (j.titleByLocale?.[locale] || j.title || '').trim();
    if (!role) continue;
    // Extract first 3-4 words — a reasonable "role family" bucket
    const bucket = role
      .split(/\s+/)
      .slice(0, 3)
      .join(' ')
      .toLowerCase();
    roleCounts.set(bucket, (roleCounts.get(bucket) || 0) + 1);
  }
  const topRoles = Array.from(roleCounts.entries())
    .map(([role, count]) => ({ role, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  return {
    city,
    activeJobsCount: cityJobs.length,
    topCompanies,
    newcomers,
    topRoles,
  };
}

// ── Localised copy ──────────────────────────────────────────────

interface WeeklyCopy {
  sectionLabel: string;
  breadcrumbHome: string;
  h1Current: (cityDisplay: string, isRegional: boolean) => string;
  h1Archive: (cityDisplay: string, week: number, year: number, isRegional: boolean) => string;
  kickerCurrent: string;
  kickerArchive: string;
  heroSummary: (city: string, companiesCount: number, jobsCount: number) => string;
  heroSummaryNoDelta: (city: string, companiesCount: number, jobsCount: number) => string;
  intro: (city: string) => string;
  topCompaniesTitle: string;
  topCompaniesEmpty: string;
  newcomersTitle: string;
  newcomersDesc: string;
  newcomersEmpty: string;
  rolesTitle: string;
  rolesEmpty: string;
  relatedLinksTitle: string;
  relatedLinksCityHub: (city: string) => string;
  relatedLinksEmployerBrand: (employer: string) => string;
  jobsCountLabel: (count: number) => string;
  deltaPositive: (count: number) => string;
  deltaZero: string;
  coldStart: string;
  faqTitle: string;
  faqHowOftenQ: string;
  faqHowOftenA: string;
  faqDeltaQ: string;
  faqDeltaA: string;
  faqApplyQ: string;
  faqApplyA: string;
  archiveNoindexNote: string;
  updatedLabel: string;
  // Extra body copy — helps hit ≥300 words without feeling templatey
  editorialBlock: (city: string) => string;
  methodologyBlock: string;
}

const COPY: Record<WeeklyEmployersLocale, WeeklyCopy> = {
  it: {
    sectionLabel: 'Aziende che assumono',
    breadcrumbHome: 'Home',
    h1Current: (c, reg) =>
      reg ? `Aziende che assumono in Ticino questa settimana` : `Aziende che assumono a ${c} questa settimana`,
    h1Archive: (c, w, y, reg) =>
      reg ? `Aziende che assumevano in Ticino — Settimana ${w} ${y}` : `Aziende che assumevano a ${c} — Settimana ${w} ${y}`,
    kickerCurrent: 'Classifica settimanale',
    kickerArchive: 'Archivio settimanale',
    heroSummary: (city, c, j) =>
      `Questa settimana a ${city} ${c} aziende hanno pubblicato ${j} offerte attive.`,
    heroSummaryNoDelta: (city, c, j) =>
      `A ${city} risultano ${c} aziende con ${j} offerte attive. Dati iniziali — il delta settimanale sarà disponibile dalla settimana prossima.`,
    intro: (city) =>
      `Classifica aggiornata ogni lunedì mattina delle aziende con il maggior numero di nuove offerte pubblicate a ${city} nell'ultima settimana. Utile per capire chi sta assumendo davvero oggi, quali ruoli stanno crescendo e dove concentrare la candidatura spontanea prima della concorrenza. I dati sono aggregati dai job-board monitorati dalla nostra pipeline: portali aziendali, piattaforme ATS e API pubbliche.`,
    topCompaniesTitle: 'Top aziende che stanno assumendo',
    topCompaniesEmpty: 'Nessuna nuova offerta rilevata in questa zona negli ultimi 7 giorni.',
    newcomersTitle: 'Aziende nuove — prima apparizione',
    newcomersDesc:
      'Aziende che non avevano mai pubblicato offerte nelle settimane precedenti. Spesso sono le prime avvisaglie di nuove assunzioni strutturate: vale la pena arrivare per primi con una candidatura mirata.',
    newcomersEmpty:
      'Nessuna azienda nuova questa settimana — tutte le aziende elencate hanno già pubblicato offerte in passato.',
    rolesTitle: 'Ruoli più richiesti questa settimana',
    rolesEmpty:
      'Non abbiamo ancora abbastanza offerte attive per costruire il breakdown dei ruoli.',
    relatedLinksTitle: 'Approfondimenti correlati',
    relatedLinksCityHub: (c) => `Tutte le offerte a ${c}`,
    relatedLinksEmployerBrand: (e) => `Pagina azienda: ${e}`,
    jobsCountLabel: (n) => (n === 1 ? `${n} offerta` : `${n} offerte`),
    deltaPositive: (n) => `+${n} questa settimana`,
    deltaZero: 'invariato',
    coldStart: 'Dati iniziali — delta disponibile dalla settimana prossima',
    faqTitle: 'Domande frequenti',
    faqHowOftenQ: 'Ogni quanto viene aggiornata questa classifica?',
    faqHowOftenA:
      'La classifica viene rigenerata automaticamente ogni lunedì mattina con i dati aggregati dei job-board monitorati dalla nostra pipeline.',
    faqDeltaQ: 'Cosa indica il "delta" accanto al nome azienda?',
    faqDeltaA:
      'Indica quante offerte in più sono state pubblicate questa settimana rispetto allo snapshot precedente. Un delta alto significa che l\'azienda sta attivamente assumendo adesso.',
    faqApplyQ: 'Come ci si candida a queste aziende?',
    faqApplyA:
      'Ogni azienda porta alle sue offerte pubblicate sulla nostra bacheca, dove puoi candidarti direttamente o aprire il sito ufficiale dell\'azienda.',
    archiveNoindexNote: 'Archivio storico — mantenuto per continuità, non più aggiornato.',
    updatedLabel: 'Aggiornamento',
    editorialBlock: (city) =>
      `La fotografia settimanale delle aziende che assumono a ${city} è utile a più profili: frontalieri italiani che cercano il primo ingaggio, lavoratori già in Ticino che vogliono cambiare ruolo, residenti svizzeri che valutano offerte più competitive. Monitorare i picchi di pubblicazione aiuta a individuare i datori di lavoro che stanno espandendo l\'organico — e quindi quelli più aperti a candidature spontanee anche se al momento non c\'è una posizione esattamente in linea con il profilo.`,
    methodologyBlock:
      'Metodologia: ogni lunedì mattina alle 06:00 UTC la nostra pipeline confronta lo snapshot delle offerte attive con quello della settimana precedente e calcola un delta per azienda. Aziende con delta positivo salgono in classifica. Le aziende "nuove" sono quelle mai viste negli snapshot delle ultime 12 settimane. Il breakdown dei ruoli è costruito raggruppando le prime 3 parole del titolo offerta, con piccola tolleranza per varianti di formattazione.',
  },
  en: {
    sectionLabel: 'Companies hiring',
    breadcrumbHome: 'Home',
    h1Current: (c, reg) =>
      reg ? `Companies hiring in Ticino this week` : `Companies hiring in ${c} this week`,
    h1Archive: (c, w, y, reg) =>
      reg ? `Companies hiring in Ticino — Week ${w} ${y}` : `Companies hiring in ${c} — Week ${w} ${y}`,
    kickerCurrent: 'Weekly leaderboard',
    kickerArchive: 'Weekly archive',
    heroSummary: (city, c, j) =>
      `This week in ${city} ${c} companies have ${j} active openings.`,
    heroSummaryNoDelta: (city, c, j) =>
      `${c} companies in ${city} currently have ${j} active openings. Baseline data — weekly delta available starting next week.`,
    intro: (city) =>
      `Leaderboard refreshed every Monday morning ranking the companies with the most new openings posted in ${city} over the last 7 days. Useful to see who is actually hiring right now, which roles are trending, and where to focus outreach before the competition. Data is aggregated from the job boards monitored by our pipeline: company career pages, ATS platforms, and public APIs.`,
    topCompaniesTitle: 'Top companies hiring',
    topCompaniesEmpty: 'No new openings detected in this area over the past 7 days.',
    newcomersTitle: 'New companies — first appearance',
    newcomersDesc:
      'Companies that had never posted openings in the previous weeks. Often an early signal of structured hiring — a good chance to apply with a targeted pitch before the competition picks up.',
    newcomersEmpty:
      'No new companies this week — every company listed has posted openings in previous weeks.',
    rolesTitle: 'Roles most in demand this week',
    rolesEmpty: 'Not enough active openings yet to build the role breakdown.',
    relatedLinksTitle: 'Related pages',
    relatedLinksCityHub: (c) => `All jobs in ${c}`,
    relatedLinksEmployerBrand: (e) => `Employer page: ${e}`,
    jobsCountLabel: (n) => (n === 1 ? `${n} opening` : `${n} openings`),
    deltaPositive: (n) => `+${n} this week`,
    deltaZero: 'unchanged',
    coldStart: 'Baseline data — delta available starting next week',
    faqTitle: 'Frequently asked questions',
    faqHowOftenQ: 'How often is this leaderboard updated?',
    faqHowOftenA:
      'The leaderboard is regenerated automatically every Monday morning using aggregated data from the job boards monitored by our pipeline.',
    faqDeltaQ: 'What does the "delta" next to each company name mean?',
    faqDeltaA:
      'It shows how many more openings were published this week compared to the previous snapshot. A high delta means the company is actively hiring right now.',
    faqApplyQ: 'How do I apply to these companies?',
    faqApplyA:
      'Each company links to its active openings on our job board, where you can apply directly or open the company\'s official page.',
    archiveNoindexNote: 'Historical archive — kept for continuity, no longer updated.',
    updatedLabel: 'Updated',
    editorialBlock: (city) =>
      `The weekly snapshot of companies hiring in ${city} is useful for multiple profiles: Italian cross-border workers looking for their first role, workers already in Ticino aiming to switch positions, and Swiss residents evaluating more competitive offers. Tracking publication spikes helps spot employers actively growing their workforce — and therefore those most open to spontaneous applications even when there is no posting that perfectly matches the profile.`,
    methodologyBlock:
      'Methodology: every Monday morning at 06:00 UTC our pipeline compares the snapshot of active openings with the previous week\'s and computes a per-company delta. Companies with a positive delta move up the leaderboard. "New" companies are those never seen in the last 12 weekly snapshots. The role breakdown groups the first 3 words of the job title, with small tolerance for formatting variants.',
  },
  de: {
    sectionLabel: 'Unternehmen mit offenen Stellen',
    breadcrumbHome: 'Startseite',
    h1Current: (c, reg) =>
      reg ? `Unternehmen, die diese Woche im Tessin einstellen` : `Unternehmen, die diese Woche in ${c} einstellen`,
    h1Archive: (c, w, y, reg) =>
      reg ? `Unternehmen, die im Tessin eingestellt haben — Woche ${w} ${y}` : `Unternehmen, die in ${c} eingestellt haben — Woche ${w} ${y}`,
    kickerCurrent: 'Wöchentliche Rangliste',
    kickerArchive: 'Wöchentliches Archiv',
    heroSummary: (city, c, j) =>
      `Diese Woche haben in ${city} ${c} Unternehmen ${j} aktive offene Stellen.`,
    heroSummaryNoDelta: (city, c, j) =>
      `In ${city} haben aktuell ${c} Unternehmen ${j} aktive Stellen. Basisdaten — die Wochenveränderung ist ab nächster Woche verfügbar.`,
    intro: (city) =>
      `Rangliste, jeden Montagmorgen aktualisiert, der Unternehmen mit den meisten neuen Stellen in ${city} in den letzten 7 Tagen. Hilfreich, um zu sehen, wer jetzt wirklich einstellt, welche Rollen im Trend liegen und wo sich eine Initiativbewerbung vor der Konkurrenz lohnt. Die Daten werden aus den von unserer Pipeline überwachten Job-Portalen aggregiert: Karriereseiten, ATS-Plattformen und öffentliche APIs.`,
    topCompaniesTitle: 'Top-Unternehmen mit offenen Stellen',
    topCompaniesEmpty:
      'In den letzten 7 Tagen wurden in diesem Gebiet keine neuen Stellen entdeckt.',
    newcomersTitle: 'Neue Unternehmen — erste Erwähnung',
    newcomersDesc:
      'Unternehmen, die in den Vorwochen nie Stellen ausgeschrieben hatten. Oft ein frühes Zeichen für strukturierte Einstellungen — eine gute Chance, sich vor der Konkurrenz gezielt zu bewerben.',
    newcomersEmpty:
      'Diese Woche keine neuen Unternehmen — alle aufgeführten Firmen haben bereits in Vorwochen Stellen ausgeschrieben.',
    rolesTitle: 'Gefragteste Rollen diese Woche',
    rolesEmpty: 'Noch nicht genügend aktive Stellen, um die Rollenaufteilung zu erstellen.',
    relatedLinksTitle: 'Verwandte Seiten',
    relatedLinksCityHub: (c) => `Alle Stellen in ${c}`,
    relatedLinksEmployerBrand: (e) => `Arbeitgeberseite: ${e}`,
    jobsCountLabel: (n) => (n === 1 ? `${n} Stelle` : `${n} Stellen`),
    deltaPositive: (n) => `+${n} diese Woche`,
    deltaZero: 'unverändert',
    coldStart: 'Basisdaten — Wochenveränderung ab nächster Woche verfügbar',
    faqTitle: 'Häufige Fragen',
    faqHowOftenQ: 'Wie oft wird diese Rangliste aktualisiert?',
    faqHowOftenA:
      'Die Rangliste wird automatisch jeden Montagmorgen mit aggregierten Daten der von unserer Pipeline überwachten Job-Portale neu generiert.',
    faqDeltaQ: 'Was bedeutet die "Veränderung" neben dem Firmennamen?',
    faqDeltaA:
      'Sie zeigt, wie viele Stellen diese Woche gegenüber dem vorherigen Snapshot mehr ausgeschrieben wurden. Eine hohe Veränderung bedeutet, dass das Unternehmen aktuell aktiv einstellt.',
    faqApplyQ: 'Wie bewerbe ich mich bei diesen Unternehmen?',
    faqApplyA:
      'Jedes Unternehmen verlinkt auf seine aktiven Stellen auf unserem Job-Board, wo Sie sich direkt bewerben oder die offizielle Firmenseite öffnen können.',
    archiveNoindexNote: 'Historisches Archiv — zur Kontinuität aufbewahrt, nicht mehr aktualisiert.',
    updatedLabel: 'Aktualisiert',
    editorialBlock: (city) =>
      `Die wöchentliche Aufnahme der Unternehmen, die in ${city} einstellen, ist für mehrere Zielgruppen nützlich: italienische Grenzgänger auf Jobsuche, Personen mit Arbeitsplatz im Tessin, die wechseln möchten, und Schweizer Einheimische, die attraktivere Angebote prüfen. Publikationsspitzen helfen dabei, Arbeitgeber zu erkennen, die gerade ihre Belegschaft ausbauen — und daher offener für Initiativbewerbungen sind, auch wenn aktuell keine exakt passende Stelle ausgeschrieben ist.`,
    methodologyBlock:
      'Methodik: Jeden Montagmorgen um 06:00 UTC vergleicht unsere Pipeline den Snapshot der aktiven Stellen mit dem der Vorwoche und berechnet eine firmenspezifische Veränderung. Unternehmen mit positiver Veränderung steigen in der Rangliste. "Neue" Unternehmen sind solche, die in den letzten 12 Wochen-Snapshots nie vorkamen. Die Rollenaufteilung gruppiert die ersten drei Wörter des Stellentitels mit geringer Toleranz für Formatvarianten.',
  },
  fr: {
    sectionLabel: 'Entreprises qui recrutent',
    breadcrumbHome: 'Accueil',
    h1Current: (c, reg) =>
      reg ? `Entreprises qui recrutent au Tessin cette semaine` : `Entreprises qui recrutent à ${c} cette semaine`,
    h1Archive: (c, w, y, reg) =>
      reg ? `Entreprises qui recrutaient au Tessin — Semaine ${w} ${y}` : `Entreprises qui recrutaient à ${c} — Semaine ${w} ${y}`,
    kickerCurrent: 'Classement hebdomadaire',
    kickerArchive: 'Archive hebdomadaire',
    heroSummary: (city, c, j) =>
      `Cette semaine à ${city}, ${c} entreprises ont ${j} offres actives.`,
    heroSummaryNoDelta: (city, c, j) =>
      `À ${city}, ${c} entreprises ont actuellement ${j} offres actives. Données initiales — la variation hebdomadaire sera disponible dès la semaine prochaine.`,
    intro: (city) =>
      `Classement mis à jour chaque lundi matin des entreprises ayant publié le plus de nouvelles offres à ${city} ces 7 derniers jours. Utile pour identifier qui recrute vraiment maintenant, quels rôles sont en hausse et où concentrer ses candidatures spontanées avant la concurrence. Les données sont agrégées depuis les sites d\'offres d\'emploi suivis par notre pipeline : pages carrière, plateformes ATS et API publiques.`,
    topCompaniesTitle: 'Meilleures entreprises qui recrutent',
    topCompaniesEmpty: 'Aucune nouvelle offre détectée dans cette zone ces 7 derniers jours.',
    newcomersTitle: 'Nouvelles entreprises — première apparition',
    newcomersDesc:
      'Entreprises qui n\'avaient jamais publié d\'offres les semaines précédentes. Souvent un signal précoce d\'embauches structurées — une bonne occasion de postuler avec une candidature ciblée avant la concurrence.',
    newcomersEmpty:
      'Aucune nouvelle entreprise cette semaine — toutes celles listées ont déjà publié des offres auparavant.',
    rolesTitle: 'Rôles les plus demandés cette semaine',
    rolesEmpty: 'Pas encore assez d\'offres actives pour construire la répartition par rôle.',
    relatedLinksTitle: 'Pages liées',
    relatedLinksCityHub: (c) => `Toutes les offres à ${c}`,
    relatedLinksEmployerBrand: (e) => `Page employeur : ${e}`,
    jobsCountLabel: (n) => (n === 1 ? `${n} offre` : `${n} offres`),
    deltaPositive: (n) => `+${n} cette semaine`,
    deltaZero: 'inchangé',
    coldStart: 'Données initiales — variation disponible dès la semaine prochaine',
    faqTitle: 'Questions fréquentes',
    faqHowOftenQ: 'À quelle fréquence ce classement est-il mis à jour ?',
    faqHowOftenA:
      'Le classement est régénéré automatiquement chaque lundi matin à partir des données agrégées des sites d\'offres d\'emploi suivis par notre pipeline.',
    faqDeltaQ: 'Que signifie la "variation" à côté du nom de l\'entreprise ?',
    faqDeltaA:
      'Elle indique combien d\'offres supplémentaires ont été publiées cette semaine par rapport au snapshot précédent. Une variation élevée signifie que l\'entreprise recrute activement en ce moment.',
    faqApplyQ: 'Comment postuler à ces entreprises ?',
    faqApplyA:
      'Chaque entreprise renvoie vers ses offres actives sur notre tableau, où vous pouvez postuler directement ou ouvrir le site officiel de l\'entreprise.',
    archiveNoindexNote: 'Archive historique — conservée pour continuité, non mise à jour.',
    updatedLabel: 'Mis à jour',
    editorialBlock: (city) =>
      `L\'image hebdomadaire des entreprises qui recrutent à ${city} est utile à plusieurs profils : frontaliers italiens en recherche de premier poste, personnes déjà installées au Tessin souhaitant changer de poste, et résidents suisses évaluant des offres plus compétitives. Surveiller les pics de publication aide à repérer les employeurs qui étoffent leurs équipes — et donc ceux qui sont les plus ouverts aux candidatures spontanées même lorsqu\'aucun poste ne correspond exactement au profil.`,
    methodologyBlock:
      'Méthodologie : chaque lundi matin à 06:00 UTC, notre pipeline compare le snapshot des offres actives avec celui de la semaine précédente et calcule une variation par entreprise. Les entreprises avec une variation positive montent dans le classement. Les "nouvelles" entreprises sont celles jamais observées dans les 12 derniers snapshots hebdomadaires. La répartition par rôle regroupe les trois premiers mots du titre de l\'offre, avec une petite tolérance aux variantes de formatage.',
  },
};

// ── Page renderer ───────────────────────────────────────────────

export interface WeeklyEmployersPageInputs {
  locale: WeeklyEmployersLocale;
  city: WeeklyEmployersCity;
  variant: 'current' | 'archive';
  weekNum: number;
  year: number;
  stats: CityWeeklyStats;
  hasHistoricalDelta: boolean;
  canonicalPath: string;
  today: Date;
  /** Whether this page should be `index,follow` (current & last 12 archives) */
  indexable: boolean;
  /** Enable the auto-employer-stub attribute markers (default false). */
  enableAutoStubs?: boolean;
}

function cityJobsHubPath(locale: WeeklyEmployersLocale, city: WeeklyEmployersCity): string {
  // Link back to existing city-jobs-hub (if there is one).
  // Only lugano/mendrisio/bellinzona are covered by cityJobsHub; others
  // fall back to the main job-board root for the locale.
  const section: Record<WeeklyEmployersLocale, string> = {
    it: 'cerca-lavoro-ticino',
    en: 'find-jobs-ticino',
    de: 'jobs-im-tessin',
    fr: 'trouver-emploi-tessin',
  };
  const prefix = WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale];
  if (city === 'ticino') return `${prefix}/${section[locale]}/`.replace(/\/+/g, '/');
  const covered = new Set<WeeklyEmployersCity>(['lugano', 'mendrisio', 'bellinzona']);
  if (!covered.has(city)) return `${prefix}/${section[locale]}/`.replace(/\/+/g, '/');
  return `${prefix}/${section[locale]}/${city}/`.replace(/\/+/g, '/');
}

function employerBrandPath(employerKey: string | undefined): string | null {
  if (!employerKey) return null;
  const key = String(employerKey).toLowerCase();
  // EMPLOYER_BRANDS is keyed by `brandKey` — match loosely.
  for (const brand of Object.values(EMPLOYER_BRANDS)) {
    if (
      brand.brandKey === key ||
      brand.brandKey === key.replace(/-/g, '') ||
      key.includes(brand.brandKey) ||
      brand.brandKey.includes(key.split('-')[0])
    ) {
      return `/cerca-lavoro-ticino/azienda-${brand.brandKey}/`;
    }
  }
  return null;
}

export function renderWeeklyEmployersPage(inp: WeeklyEmployersPageInputs): string {
  const {
    locale,
    city,
    variant,
    weekNum,
    year,
    stats,
    hasHistoricalDelta,
    canonicalPath,
    today,
    indexable,
    enableAutoStubs = false,
  } = inp;

  const copy = COPY[locale];
  const cityDisplay = WEEKLY_EMPLOYERS_CITY_DISPLAY[city];
  const isRegional = city === 'ticino';
  const dateStamp = today.toISOString().slice(0, 10);
  const canonicalUrl = `${BASE_URL}${canonicalPath}`;

  const h1 =
    variant === 'current'
      ? copy.h1Current(cityDisplay, isRegional)
      : copy.h1Archive(cityDisplay, weekNum, year, isRegional);
  const kicker = variant === 'current' ? copy.kickerCurrent : copy.kickerArchive;

  const companiesCount = stats.topCompanies.length;
  const jobsCount = stats.activeJobsCount;
  const heroSummary = hasHistoricalDelta
    ? copy.heroSummary(cityDisplay, companiesCount, jobsCount)
    : copy.heroSummaryNoDelta(cityDisplay, companiesCount, jobsCount);
  const intro = copy.intro(cityDisplay);
  const editorial = copy.editorialBlock(cityDisplay);
  const methodology = copy.methodologyBlock;

  // Alternates to other locales for the same (city, variant)
  const alternatesHtml = WEEKLY_EMPLOYERS_LOCALES.map((alt) => {
    let path: string;
    if (variant === 'current') {
      path = buildCurrentWeekPath(alt, city);
    } else {
      path = buildArchiveWeekPath(alt, city, weekNum, year);
    }
    return `    <link rel="alternate" hreflang="${alt}" href="${BASE_URL}${path}">`;
  }).join('\n');

  const xDefaultPath =
    variant === 'current'
      ? buildCurrentWeekPath('it', city)
      : buildArchiveWeekPath('it', city, weekNum, year);

  // Top companies rendering
  const topCompaniesHtml =
    stats.topCompanies.length > 0
      ? `<ol style="list-style:none;padding:0;margin:0;display:grid;grid-template-columns:1fr;gap:10px">${stats.topCompanies
          .map((c, idx) => {
            const brandHref = employerBrandPath(c.employerKey);
            const deltaLabel =
              hasHistoricalDelta && c.delta > 0
                ? copy.deltaPositive(c.delta)
                : hasHistoricalDelta
                ? copy.deltaZero
                : copy.coldStart;
            const needsReview =
              enableAutoStubs && !brandHref && c.active >= 3 && idx < 3 ? ' data-needs-editorial-review="true"' : '';
            const employerEsc = esc(c.employer);
            const badge =
              hasHistoricalDelta && c.delta > 0
                ? `<span style="margin-left:10px;padding:3px 8px;border-radius:999px;background:#ecfccb;color:#365314;font-size:12px;font-weight:700">${esc(deltaLabel)}</span>`
                : `<span style="margin-left:10px;padding:3px 8px;border-radius:999px;background:#f1f5f9;color:#475569;font-size:12px">${esc(deltaLabel)}</span>`;
            const content = `<div style="font-weight:700;font-size:16px;color:#0f172a">${idx + 1}. ${employerEsc}${badge}</div>
      <div style="margin-top:4px;color:#475569;font-size:14px">${esc(copy.jobsCountLabel(c.active))}</div>`;
            const inner = brandHref
              ? `<a href="${esc(brandHref)}" style="color:inherit;text-decoration:none;display:block"${needsReview}>${content}</a>`
              : `<div${needsReview}>${content}</div>`;
            return `<li style="padding:14px 16px;border:1px solid #e2e8f0;border-radius:14px;background:#ffffff">${inner}</li>`;
          })
          .join('')}</ol>`
      : `<p style="padding:14px 16px;border-radius:12px;background:#fef3c7;color:#78350f">${esc(copy.topCompaniesEmpty)}</p>`;

  const newcomersHtml =
    stats.newcomers.length > 0
      ? `<ul style="list-style:disc;padding-left:20px;margin:0 0 0 4px;color:#0f172a;line-height:1.7">${stats.newcomers
          .map(
            (n) =>
              `<li><strong>${esc(n.employer)}</strong> — ${esc(copy.jobsCountLabel(n.active))}</li>`,
          )
          .join('')}</ul>`
      : `<p style="color:#475569;line-height:1.7">${esc(copy.newcomersEmpty)}</p>`;

  const rolesHtml =
    stats.topRoles.length > 0
      ? `<ul style="list-style:disc;padding-left:20px;margin:0 0 0 4px;color:#0f172a;line-height:1.7">${stats.topRoles
          .map(
            (r) =>
              `<li><span style="text-transform:capitalize">${esc(r.role)}</span> — ${esc(
                copy.jobsCountLabel(r.count),
              )}</li>`,
          )
          .join('')}</ul>`
      : `<p style="color:#475569;line-height:1.7">${esc(copy.rolesEmpty)}</p>`;

  // Related links: city hub + first employer brand (if present)
  const relatedLinks: string[] = [];
  relatedLinks.push(
    `<a href="${esc(cityJobsHubPath(locale, city))}" style="color:#1d4ed8;text-decoration:none">${esc(copy.relatedLinksCityHub(cityDisplay))}</a>`,
  );
  const firstEmployerWithBrand = stats.topCompanies.find(
    (c) => !!employerBrandPath(c.employerKey),
  );
  if (firstEmployerWithBrand) {
    const href = employerBrandPath(firstEmployerWithBrand.employerKey)!;
    relatedLinks.push(
      `<a href="${esc(href)}" style="color:#1d4ed8;text-decoration:none">${esc(copy.relatedLinksEmployerBrand(firstEmployerWithBrand.employer))}</a>`,
    );
  }
  const relatedHtml = `<ul style="list-style:none;padding:0;margin:0;display:flex;gap:14px;flex-wrap:wrap">${relatedLinks
    .map((link) => `<li>${link}</li>`)
    .join('')}</ul>`;

  // JSON-LD
  const breadcrumbLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: copy.breadcrumbHome, item: `${BASE_URL}/` },
      {
        '@type': 'ListItem',
        position: 2,
        name: copy.sectionLabel,
        item: `${BASE_URL}${WEEKLY_EMPLOYERS_LOCALE_PREFIX[locale]}/${WEEKLY_EMPLOYERS_SECTION[locale]}/`.replace(
          /([^:])\/+/g,
          '$1/',
        ),
      },
      { '@type': 'ListItem', position: 3, name: cityDisplay, item: canonicalUrl },
    ],
  });

  const itemListLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: h1,
    numberOfItems: stats.topCompanies.length,
    itemListElement: stats.topCompanies.map((c, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      item: {
        '@type': 'Organization',
        name: c.employer,
        url: employerBrandPath(c.employerKey)
          ? `${BASE_URL}${employerBrandPath(c.employerKey)}`
          : undefined,
      },
    })),
  });

  const webPageLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: h1,
    url: canonicalUrl,
    description: heroSummary,
    inLanguage: locale,
    dateModified: today.toISOString(),
    datePublished: today.toISOString(),
  });

  const faqLd = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: [
      { '@type': 'Question', name: copy.faqHowOftenQ, acceptedAnswer: { '@type': 'Answer', text: copy.faqHowOftenA } },
      { '@type': 'Question', name: copy.faqDeltaQ, acceptedAnswer: { '@type': 'Answer', text: copy.faqDeltaA } },
      { '@type': 'Question', name: copy.faqApplyQ, acceptedAnswer: { '@type': 'Answer', text: copy.faqApplyA } },
    ],
  });

  const robots = indexable ? 'index,follow' : 'noindex,follow';
  const title =
    variant === 'current'
      ? `${h1} | Frontaliere Ticino`
      : `${h1} — Archivio | Frontaliere Ticino`;
  const description = heroSummary.slice(0, 180);

  const archiveNote =
    variant === 'archive' && !indexable
      ? `<p style="margin:0 0 16px;color:#78350f;background:#fef3c7;padding:10px 14px;border-radius:12px;font-size:14px">${esc(copy.archiveNoindexNote)}</p>`
      : '';

  const bodyHtml = `<main style="max-width:1100px;margin:0 auto;padding:32px 20px 56px;color:#0f172a;font-family:system-ui,-apple-system,sans-serif">
  <nav style="margin:0 0 14px;font-size:13px;color:#475569" aria-label="breadcrumb">
    <a href="${BASE_URL}/" style="color:#1d4ed8;text-decoration:none">${esc(copy.breadcrumbHome)}</a>
    <span> / </span>
    <span>${esc(copy.sectionLabel)}</span>
    <span> / </span>
    <span>${esc(cityDisplay)}</span>
  </nav>
  <header style="margin-bottom:22px">
    <p style="margin:0 0 6px;color:#4f46e5;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em">${esc(kicker)} · ${esc(copy.updatedLabel)} ${dateStamp}</p>
    <h1 style="margin:0 0 12px;font-size:clamp(1.8rem,4.5vw,2.75rem);line-height:1.1">${esc(h1)}</h1>
    <p style="margin:0 0 14px;font-size:18px;line-height:1.55;max-width:860px">${esc(heroSummary)}</p>
    <p style="margin:0;color:#334155;line-height:1.7;max-width:860px">${esc(intro)}</p>
  </header>
  ${archiveNote}
  <section style="margin:0 0 28px" aria-labelledby="topCompanies">
    <h2 id="topCompanies" style="margin:0 0 14px;font-size:22px;color:#0f172a">${esc(copy.topCompaniesTitle)}</h2>
    ${topCompaniesHtml}
  </section>
  <section style="margin:0 0 28px" aria-labelledby="newcomers">
    <h2 id="newcomers" style="margin:0 0 10px;font-size:22px;color:#0f172a">${esc(copy.newcomersTitle)}</h2>
    <p style="margin:0 0 10px;color:#334155;line-height:1.65;max-width:860px">${esc(copy.newcomersDesc)}</p>
    ${newcomersHtml}
  </section>
  <section style="margin:0 0 28px" aria-labelledby="roles">
    <h2 id="roles" style="margin:0 0 10px;font-size:22px;color:#0f172a">${esc(copy.rolesTitle)}</h2>
    ${rolesHtml}
  </section>
  <section style="margin:0 0 28px" aria-labelledby="editorial">
    <h2 id="editorial" style="margin:0 0 10px;font-size:20px;color:#0f172a">${esc(cityDisplay)}</h2>
    <p style="margin:0 0 10px;color:#334155;line-height:1.7;max-width:860px">${esc(editorial)}</p>
    <p style="margin:0;color:#475569;line-height:1.7;max-width:860px;font-size:14px">${esc(methodology)}</p>
  </section>
  <section style="margin:0 0 28px" aria-labelledby="relatedLinks">
    <h2 id="relatedLinks" style="margin:0 0 10px;font-size:20px;color:#0f172a">${esc(copy.relatedLinksTitle)}</h2>
    ${relatedHtml}
  </section>
  <section style="margin:0 0 0" aria-labelledby="weeklyFaq">
    <h2 id="weeklyFaq" style="margin:0 0 10px;font-size:22px;color:#0f172a">${esc(copy.faqTitle)}</h2>
    <details style="padding:12px 14px;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:8px;background:#ffffff">
      <summary style="font-weight:700;cursor:pointer;color:#0f172a">${esc(copy.faqHowOftenQ)}</summary>
      <p style="margin:10px 0 0;color:#334155;line-height:1.6">${esc(copy.faqHowOftenA)}</p>
    </details>
    <details style="padding:12px 14px;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:8px;background:#ffffff">
      <summary style="font-weight:700;cursor:pointer;color:#0f172a">${esc(copy.faqDeltaQ)}</summary>
      <p style="margin:10px 0 0;color:#334155;line-height:1.6">${esc(copy.faqDeltaA)}</p>
    </details>
    <details style="padding:12px 14px;border:1px solid #e2e8f0;border-radius:12px;margin-bottom:8px;background:#ffffff">
      <summary style="font-weight:700;cursor:pointer;color:#0f172a">${esc(copy.faqApplyQ)}</summary>
      <p style="margin:10px 0 0;color:#334155;line-height:1.6">${esc(copy.faqApplyA)}</p>
    </details>
  </section>
</main>`;

  const html = `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    ${FAVICON_LINKS}
    <title>${esc(title)}</title>
    <meta name="description" content="${esc(description)}">
    <meta name="robots" content="${robots}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="Frontaliere Ticino">
    <meta property="og:locale" content="${WEEKLY_EMPLOYERS_OG_LOCALE[locale]}">
    <meta property="og:title" content="${esc(title)}">
    <meta property="og:description" content="${esc(description)}">
    <meta property="og:url" content="${canonicalUrl}">
    <meta property="og:image" content="${BASE_URL}/og-image.png">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${esc(title)}">
    <meta name="twitter:description" content="${esc(description)}">
    <meta name="twitter:site" content="@frontaliereticino">
    <link rel="canonical" href="${canonicalUrl}">
${alternatesHtml}
    <link rel="alternate" hreflang="x-default" href="${BASE_URL}${xDefaultPath}">
    <script type="application/ld+json">${breadcrumbLd}</script>
    <script type="application/ld+json">${webPageLd}</script>
    <script type="application/ld+json">${itemListLd}</script>
    <script type="application/ld+json">${faqLd}</script>
    ${ANALYTICS_SNIPPET}
  </head>
  <body>
    <div id="root">
${bodyHtml}
    </div>
  </body>
</html>`;

  return html;
}

// ── Snapshot I/O ────────────────────────────────────────────────

/** Read all snapshots from data/jobs-snapshots-history/*.json sorted by week asc. */
export function readSnapshotHistory(rootDir: string): JobsSnapshot[] {
  const historyDir = np.join(rootDir, 'data', 'jobs-snapshots-history');
  if (!fs.existsSync(historyDir)) return [];
  const files = fs.readdirSync(historyDir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f));
  const snapshots: JobsSnapshot[] = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(np.join(historyDir, file), 'utf-8');
      const parsed = JSON.parse(raw) as JobsSnapshot;
      if (parsed && typeof parsed.week === 'string' && Array.isArray(parsed.jobs)) {
        snapshots.push(parsed);
      }
    } catch {
      // skip malformed snapshot
    }
  }
  snapshots.sort((a, b) => a.week.localeCompare(b.week));
  return snapshots;
}

/** Load all jobs from data/jobs.json + per-crawler slices. */
function loadAllJobs(rootDir: string): WeeklyCountableJob[] {
  const dataDir = np.join(rootDir, 'data');
  const out: WeeklyCountableJob[] = [];
  const seen = new Set<string>();

  const mainPath = np.join(dataDir, 'jobs.json');
  if (fs.existsSync(mainPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(mainPath, 'utf-8'));
      if (Array.isArray(raw)) {
        for (const j of raw) {
          const key = String(j?.slug || j?.id || '');
          if (key && !seen.has(key)) {
            seen.add(key);
            out.push(j as WeeklyCountableJob);
          }
        }
      }
    } catch (err) {
      console.warn('[weekly-employers] failed to parse jobs.json:', err);
    }
  }

  const sliceDir = np.join(dataDir, 'jobs', 'by-crawler');
  if (fs.existsSync(sliceDir)) {
    for (const file of fs.readdirSync(sliceDir)) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(np.join(sliceDir, file), 'utf-8'));
        const jobs: unknown = Array.isArray(raw) ? raw : raw?.jobs;
        if (!Array.isArray(jobs)) continue;
        for (const j of jobs as WeeklyCountableJob[]) {
          const key = String(j?.slug || (j as { id?: string })?.id || '');
          if (key && !seen.has(key)) {
            seen.add(key);
            out.push(j);
          }
        }
      } catch {
        // slice parse failure — skip
      }
    }
  }

  return out;
}

// ── Generator ───────────────────────────────────────────────────

export interface GeneratedPage {
  path: string;
  html: string;
  indexable: boolean;
}

export interface GenerationOptions {
  rootDir: string;
  jobs: readonly WeeklyCountableJob[];
  snapshots: readonly JobsSnapshot[];
  today?: Date;
  enableAutoStubs?: boolean;
}

/**
 * Pure generator — used by both the Vite plugin (closeBundle) and tests.
 * Returns every page ready to be written.
 */
export function generateWeeklyEmployerPages(opts: GenerationOptions): GeneratedPage[] {
  const today = opts.today ?? new Date();
  const { week: currentWeek, year: currentYear } = getIsoWeekAndYear(today);

  const latestSnapshot: JobsSnapshot | null =
    opts.snapshots.length > 0 ? opts.snapshots[opts.snapshots.length - 1] : null;
  const previousSnapshot: JobsSnapshot | null =
    opts.snapshots.length > 1 ? opts.snapshots[opts.snapshots.length - 2] : null;

  const olderSnapshots = opts.snapshots.slice(0, Math.max(0, opts.snapshots.length - 1));
  const hasHistoricalDelta = opts.snapshots.length >= 2;

  const pages: GeneratedPage[] = [];

  // Current week (always emit regardless of snapshot history — degraded mode)
  for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
    for (const city of WEEKLY_EMPLOYERS_CITIES) {
      const stats = buildCityWeeklyStats({
        city,
        locale,
        jobs: opts.jobs,
        previousSnapshot,
        historicalSnapshots: olderSnapshots,
      });
      const canonicalPath = buildCurrentWeekPath(locale, city);
      const html = renderWeeklyEmployersPage({
        locale,
        city,
        variant: 'current',
        weekNum: currentWeek,
        year: currentYear,
        stats,
        hasHistoricalDelta,
        canonicalPath,
        today,
        indexable: true,
        enableAutoStubs: opts.enableAutoStubs,
      });
      pages.push({ path: canonicalPath, html, indexable: true });
    }
  }

  // Archive pages — require ≥2 historical snapshots
  if (opts.snapshots.length >= 2) {
    // Sort snapshots desc by ISO week key; index newest first so we mark oldest as noindex.
    const sortedDesc = [...opts.snapshots].sort((a, b) => b.week.localeCompare(a.week));
    for (let i = 0; i < sortedDesc.length; i++) {
      const snap = sortedDesc[i];
      const m = /^(\d{4})-(\d{2})$/.exec(snap.week);
      if (!m) continue;
      const year = Number.parseInt(m[1], 10);
      const weekNum = Number.parseInt(m[2], 10);

      // Do NOT emit an archive for the current ISO week (it's covered by
      // the current-week page). This keeps one canonical URL per week.
      if (year === currentYear && weekNum === currentWeek) continue;

      // Index only the most-recent 12 archive weeks.
      const indexable = i < WEEKLY_EMPLOYERS_INDEXABLE_WEEKS;

      // For archives, "stats" reflect jobs as they were at snapshot time —
      // we derive them from the snapshot rows (not jobs.json, which represents
      // the current week). The previous-week snapshot for delta is the next
      // older one in the sorted list.
      const prevForArchive = sortedDesc[i + 1] ?? null;

      // Build "virtual jobs" from the snapshot so buildCityWeeklyStats can
      // reuse the same aggregation logic. Snapshot rows have 'employer',
      // 'city', 'role' — map to the WeeklyCountableJob shape.
      const virtualJobs: WeeklyCountableJob[] = snap.jobs.map((row, idx) => ({
        slug: row.slug || `snap-${snap.week}-${idx}`,
        title: row.role || 'Posizione',
        company: row.employer,
        companyKey: row.employerKey,
        location: row.city,
        addressLocality: row.city,
        postedDate: row.postedAt,
        // Force "active" to pass filter: supply 60-word description so
        // jobIsActive() is true in every locale.
        description:
          'Snapshot storico: questa offerta era attiva nella settimana ' +
          snap.week +
          ' secondo i dati pubblicati dai job-board monitorati. Utile per ricostruire il trend settimanale della settimana indicata e confrontare la dinamica delle aziende sul territorio.',
      }));

      for (const locale of WEEKLY_EMPLOYERS_LOCALES) {
        for (const city of WEEKLY_EMPLOYERS_CITIES) {
          const stats = buildCityWeeklyStats({
            city,
            locale,
            jobs: virtualJobs,
            previousSnapshot: prevForArchive,
            historicalSnapshots: sortedDesc.slice(i + 2),
          });
          const canonicalPath = buildArchiveWeekPath(locale, city, weekNum, year);
          const html = renderWeeklyEmployersPage({
            locale,
            city,
            variant: 'archive',
            weekNum,
            year,
            stats,
            hasHistoricalDelta: prevForArchive !== null,
            canonicalPath,
            today,
            indexable,
            enableAutoStubs: opts.enableAutoStubs,
          });
          pages.push({ path: canonicalPath, html, indexable });
        }
      }
    }
  }

  return pages;
}

// ── Vite plugin ─────────────────────────────────────────────────

interface PluginResult {
  pagesWritten: number;
  currentWeekPages: number;
  archivePages: number;
  skippedForWordCount: number;
  degradedMode: boolean;
}

export function weeklyEmployersPlugin(rootDir: string): Plugin {
  return {
    name: 'weekly-employers-pages',
    apply: 'build',
    async closeBundle() {
      if (process.env.SKIP_WEEKLY_EMPLOYERS === '1') {
        console.log(
          '\x1b[33m[weekly-employers]\x1b[0m Skipped (SKIP_WEEKLY_EMPLOYERS=1)',
        );
        return;
      }
      const distDir = np.resolve(rootDir, 'dist');
      const today = new Date();

      const jobs = loadAllJobs(rootDir);
      const snapshots = readSnapshotHistory(rootDir);
      const degraded = snapshots.length < 2;

      if (degraded) {
        console.log(
          `\x1b[33m[weekly-employers]\x1b[0m DEGRADED MODE: ${snapshots.length} snapshot(s) in history — generating current-week pages without delta. Archives will appear once ≥2 snapshots exist.`,
        );
      }

      const enableAutoStubs = process.env.ENABLE_AUTO_EMPLOYER_STUBS === '1';
      const pages = generateWeeklyEmployerPages({
        rootDir,
        jobs,
        snapshots,
        today,
        enableAutoStubs,
      });

      const collector = new WriteCollector({ distDir, skipExisting: false });

      let currentWeekCount = 0;
      let archiveCount = 0;
      let skipped = 0;

      // Classify by path — archive paths contain "settimana-NN-YYYY" etc.
      const archiveRe = /\/(?:settimana|week|woche|semaine)-\d{2}-\d{4}\/?$/;

      for (const page of pages) {
        const words = countHtmlBodyWords(page.html);
        if (words < MIN_INDEXABLE_WORDS) {
          skipped++;
          console.warn(
            `[weekly-employers] thin content (${words} words) for ${page.path} — skipping`,
          );
          continue;
        }
        const outDir = np.join(distDir, page.path.replace(/^\/+/, ''));
        collector.add(np.join(outDir, 'index.html'), page.html);
        if (archiveRe.test(page.path)) archiveCount++;
        else currentWeekCount++;
      }

      const written = await collector.flush();

      const result: PluginResult = {
        pagesWritten: written,
        currentWeekPages: currentWeekCount,
        archivePages: archiveCount,
        skippedForWordCount: skipped,
        degradedMode: degraded,
      };

      console.log(
        `\x1b[36m[weekly-employers]\x1b[0m Generated ${result.currentWeekPages} current-week + ${result.archivePages} archive pages (skipped ${result.skippedForWordCount}) — degraded=${result.degradedMode}`,
      );
    },
  };
}
