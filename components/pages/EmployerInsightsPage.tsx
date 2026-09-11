/**
 * EmployerInsightsPage — the cold-outreach insights centrepiece.
 *
 * A private, per-company "wow" traffic report: we give companies free job-board
 * traffic on frontaliereticino.ch, and this page PROVES it with their real
 * numbers, then pushes them to claim a paid plan. It is reached from an outreach
 * link of the form `/azienda/<companyKey>/?t=<token>` (private, noindex).
 *
 * This file exports TWO things:
 *  1. `EmployerInsightsReport` — the pure presentational component. It takes the
 *     already-fetched `data: EmployerInsights` and renders the whole report.
 *     Use this directly if you fetch in a parent (the prompt's wrapper).
 *  2. `EmployerInsightsPage` (default) — the route-level wrapper. It reads the
 *     companyKey from the path and the `t` token from the query, calls
 *     `fetchInsights`, and renders loading / error / empty / report states.
 *
 * Styling: semantic Tailwind tokens only (no inline hex, no raw `dark:` color
 * classes), mobile-first, one <h1>. Animations honour prefers-reduced-motion
 * (reveal transitions are globally neutralised by the media query in
 * index.css). No new npm deps; charts are hand-rolled in SVG/CSS.
 *
 * SEO: per-company data is PRIVATE → the page forces `<meta name="robots"
 * content="noindex, nofollow">` (overriding the global indexable meta) for its
 * lifetime and restores the previous value on unmount. Title is set to
 * "{companyName} — i tuoi dati su Frontaliere Ticino".
 */
import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  Building2,
  Eye,
  FileText,
  Home,
  Loader2,
  MousePointerClick,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
} from 'lucide-react';
import {
  fetchInsights,
  type EmployerInsights,
  type EmployerInsightsWindow,
  type FetchInsightsResult,
} from '@/services/employerInsights';
import { useReveal } from '@/components/insights/useReveal';
import { TopAdsChart } from '@/components/insights/TopAdsChart';
import { TrendSparkline } from '@/components/insights/TrendSparkline';
import { buildPath } from '@/services/router';
import { useTranslation, type Locale } from '@/services/i18n';

interface EmployerInsightsCopy {
  badge: string;
  title: (companyName: string) => string;
  intro: string;
  mainWindow: string;
  window: string;
  source: string;
  windowUnavailable: string;
  timezoneUnavailable: string;
  sourceUnavailable: string;
  observed: string;
  zeroObserved: string;
  missing: string;
  unavailable: string;
  notDeduplicated: string;
  deduplicationUnavailable: string;
  partial: string;
  applyClicks: string;
  applyClicksDescription: string;
  applyClickUsers: string;
  applyClickUsersDescription: string;
  applications: string;
  applicationsDescription: string;
  profileViews: string;
  profileViewsDescription: string;
  adViews: string;
  adViewsDescription: string;
  topAdsHeading: string;
  topAdsDescription: (topTitle?: string) => string;
  trendHeading: string;
  trendUp: string;
  trendDown: string;
  additionalHeading: string;
  additionalDescription: string;
  intent: string;
  submissions: string;
  profile: string;
  ad: string;
  ctaHeading: string;
  ctaDescription: (companyName: string) => string;
  claim: string;
  savePdf: string;
  generated: (companyName: string, date: string) => string;
  privatePage: string;
  home: string;
  invalidTitle: string;
  invalidBody: string;
  preparingTitle: string;
  preparingBody: string;
  loading: string;
}

const COPY: Record<Locale, EmployerInsightsCopy> = {
  it: {
    badge: 'Report gratuito · Frontaliere Ticino',
    title: (companyName) => `Dati di interazione per ${companyName}`,
    intro: 'Un riepilogo verificabile di come le persone hanno interagito con i tuoi annunci e il tuo profilo.',
    mainWindow: 'Finestra principale:', window: 'Finestra:', source: 'Sorgente:',
    windowUnavailable: 'finestra non disponibile', timezoneUnavailable: 'timezone non disponibile', sourceUnavailable: 'sorgente non disponibile',
    observed: 'dato osservato', zeroObserved: 'zero osservato', missing: 'dato assente', unavailable: 'non disponibile',
    notDeduplicated: 'conteggio osservato, unicità non provata', deduplicationUnavailable: 'Unità senza prova di unicità:', partial: 'copertura parziale',
    applyClicks: 'Click per candidarsi', applyClicksDescription: 'Segnale di intento; non è un invio di candidatura.',
    applyClickUsers: 'Utenti associati ai click', applyClickUsersDescription: 'Unità utente osservate dal provider: aggregate, non nominative e non necessariamente uniche nel periodo.',
    applications: 'Candidature inviate', applicationsDescription: 'Invii registrati dalla sorgente delle candidature; non si sommano ai click.',
    profileViews: 'Visualizzazioni profilo azienda', profileViewsDescription: 'Visite al profilo azienda, separate dalle visualizzazioni annuncio.',
    adViews: 'Visualizzazioni annuncio', adViewsDescription: "Eventi di visualizzazione dell'annuncio.",
    topAdsHeading: 'Annunci con più visualizzazioni registrate', topAdsDescription: (topTitle) => `I primi 10 annunci per visualizzazioni${topTitle ? `, con «${topTitle}» in testa` : ''}.`,
    trendHeading: 'Andamento delle visualizzazioni registrate', trendUp: 'Le visualizzazioni registrate sono in crescita.', trendDown: 'Le visualizzazioni registrate sono in calo.',
    additionalHeading: 'Viste aggiuntive', additionalDescription: 'Le finestre da 30 e 90 giorni sono confronti aggiuntivi e non sostituiscono il periodo principale.',
    intent: 'Intento', submissions: 'Invii', profile: 'Profilo', ad: 'Annuncio',
    ctaHeading: 'Dai seguito ai segnali registrati', ctaDescription: (companyName) => `Rivendica il profilo di ${companyName}, metti gli annunci in evidenza e porta il pubblico verso il tuo processo di candidatura con una misura più chiara. Setup in pochi minuti.`, claim: 'Rivendica i tuoi annunci', savePdf: 'Salva questi dati in PDF',
    generated: (companyName, date) => `Dati relativi a ${companyName} generati il ${date}`, privatePage: 'pagina privata, non indicizzata.', home: 'Vai alla home',
    invalidTitle: 'Link non valido o scaduto', invalidBody: 'Questo report è privato e raggiungibile solo dal link che ti abbiamo inviato. Il link potrebbe essere scaduto: scrivici e te ne mandiamo uno nuovo.',
    preparingTitle: 'Report in preparazione', preparingBody: 'Stiamo ancora raccogliendo i dati di traffico per la tua azienda. Riprova tra poco — nel frattempo puoi già pubblicare e mettere in evidenza i tuoi annunci.', loading: 'Caricamento del report in corso…',
  },
  en: {
    badge: 'Free report · Frontaliere Ticino', title: (companyName) => `Engagement data for ${companyName}`,
    intro: 'A verifiable summary of how people interacted with your job ads and company profile.', mainWindow: 'Main window:', window: 'Window:', source: 'Source:', windowUnavailable: 'window unavailable', timezoneUnavailable: 'timezone unavailable', sourceUnavailable: 'source unavailable', observed: 'observed data', zeroObserved: 'zero observed', missing: 'data missing', unavailable: 'not available', notDeduplicated: 'observed count, uniqueness not proven', deduplicationUnavailable: 'Units without proof of uniqueness:', partial: 'partial coverage',
    applyClicks: 'Apply clicks', applyClicksDescription: 'Intent signal; this is not a submitted application.', applyClickUsers: 'Users associated with clicks', applyClickUsersDescription: 'Provider-observed user units: aggregated, non-identifying and not necessarily unique across the window.', applications: 'Applications submitted', applicationsDescription: 'Submissions recorded by the application source; separate from clicks.', profileViews: 'Company profile views', profileViewsDescription: 'Visits to the company profile, separate from ad views.', adViews: 'Job ad views', adViewsDescription: 'Recorded job-ad view events.', topAdsHeading: 'Ads with the most recorded views', topAdsDescription: (topTitle) => `Top 10 ads by views${topTitle ? `, led by “${topTitle}”` : ''}.`, trendHeading: 'Recorded views over time', trendUp: 'Recorded views are growing.', trendDown: 'Recorded views are declining.', additionalHeading: 'Additional views', additionalDescription: 'The 30- and 90-day windows are additional comparisons and do not replace the main period.', intent: 'Intent', submissions: 'Submissions', profile: 'Profile', ad: 'Ad', ctaHeading: 'Turn these signals into action', ctaDescription: (companyName) => `Claim ${companyName}’s profile, feature your ads and guide this audience to your application process with clearer measurement. Set up in minutes.`, claim: 'Claim your job ads', savePdf: 'Save this report as PDF', generated: (companyName, date) => `Data for ${companyName} generated on ${date}`, privatePage: 'private, not indexed.', home: 'Go to homepage', invalidTitle: 'Invalid or expired link', invalidBody: 'This private report is only available through the link we sent you. It may have expired: contact us and we will send a new one.', preparingTitle: 'Report being prepared', preparingBody: 'We are still collecting traffic data for your company. Try again shortly — you can already publish and feature your job ads in the meantime.', loading: 'Loading report…',
  },
  de: {
    badge: 'Kostenloser Bericht · Frontaliere Ticino', title: (companyName) => `Interaktionsdaten für ${companyName}`,
    intro: 'Eine überprüfbare Zusammenfassung der Interaktionen mit Ihren Stellenanzeigen und Ihrem Unternehmensprofil.', mainWindow: 'Hauptzeitraum:', window: 'Zeitraum:', source: 'Quelle:', windowUnavailable: 'Zeitraum nicht verfügbar', timezoneUnavailable: 'Zeitzone nicht verfügbar', sourceUnavailable: 'Quelle nicht verfügbar', observed: 'beobachtete Daten', zeroObserved: 'null beobachtet', missing: 'Daten fehlen', unavailable: 'nicht verfügbar', notDeduplicated: 'beobachtete Anzahl, Eindeutigkeit nicht bestätigt', deduplicationUnavailable: 'Einheiten ohne Nachweis der Eindeutigkeit:', partial: 'teilweise Abdeckung',
    applyClicks: 'Klicks auf Bewerbung', applyClicksDescription: 'Signal für Interesse; keine eingereichte Bewerbung.', applyClickUsers: 'Nutzer im Zusammenhang mit Klicks', applyClickUsersDescription: 'Vom Anbieter beobachtete Nutzereinheiten: aggregiert, nicht personenbezogen und im Zeitraum nicht zwingend eindeutig.', applications: 'Eingereichte Bewerbungen', applicationsDescription: 'Von der Bewerbungsquelle erfasste Einreichungen; getrennt von Klicks.', profileViews: 'Aufrufe des Unternehmensprofils', profileViewsDescription: 'Besuche des Unternehmensprofils, getrennt von Anzeigenaufrufen.', adViews: 'Anzeigenaufrufe', adViewsDescription: 'Erfasste Aufrufe der Stellenanzeige.', topAdsHeading: 'Anzeigen mit den meisten Aufrufen', topAdsDescription: (topTitle) => `Top 10 nach Aufrufen${topTitle ? `, angeführt von „${topTitle}“` : ''}.`, trendHeading: 'Entwicklung der Aufrufe', trendUp: 'Die erfassten Aufrufe steigen.', trendDown: 'Die erfassten Aufrufe sinken.', additionalHeading: 'Zusätzliche Ansichten', additionalDescription: 'Die Zeiträume von 30 und 90 Tagen sind zusätzliche Vergleiche und ersetzen den Hauptzeitraum nicht.', intent: 'Interesse', submissions: 'Einreichungen', profile: 'Profil', ad: 'Anzeige', ctaHeading: 'Machen Sie mehr aus diesen Signalen', ctaDescription: (companyName) => `Beanspruchen Sie das Profil von ${companyName}, heben Sie Ihre Anzeigen hervor und führen Sie diese Zielgruppe mit klarerer Messung zu Ihrem Bewerbungsprozess. In wenigen Minuten eingerichtet.`, claim: 'Stellenanzeigen beanspruchen', savePdf: 'Bericht als PDF speichern', generated: (companyName, date) => `Daten für ${companyName}, erstellt am ${date}`, privatePage: 'privat, nicht indexiert.', home: 'Zur Startseite', invalidTitle: 'Ungültiger oder abgelaufener Link', invalidBody: 'Dieser private Bericht ist nur über den zugesandten Link erreichbar. Der Link ist möglicherweise abgelaufen: Kontaktieren Sie uns für einen neuen Link.', preparingTitle: 'Bericht wird vorbereitet', preparingBody: 'Wir sammeln noch Verkehrsdaten für Ihr Unternehmen. Versuchen Sie es später erneut — inzwischen können Sie Ihre Stellenanzeigen veröffentlichen und hervorheben.', loading: 'Bericht wird geladen…',
  },
  fr: {
    badge: 'Rapport gratuit · Frontaliere Ticino', title: (companyName) => `Données d’interaction pour ${companyName}`,
    intro: 'Un résumé vérifiable des interactions avec vos offres d’emploi et votre profil d’entreprise.', mainWindow: 'Période principale :', window: 'Période :', source: 'Source :', windowUnavailable: 'période indisponible', timezoneUnavailable: 'fuseau horaire indisponible', sourceUnavailable: 'source indisponible', observed: 'donnée observée', zeroObserved: 'zéro observé', missing: 'donnée absente', unavailable: 'indisponible', notDeduplicated: 'compte observé, unicité non prouvée', deduplicationUnavailable: 'Unités sans preuve d’unicité :', partial: 'couverture partielle',
    applyClicks: 'Clics pour postuler', applyClicksDescription: 'Signal d’intention ; ce n’est pas une candidature envoyée.', applyClickUsers: 'Utilisateurs associés aux clics', applyClickUsersDescription: 'Unités utilisateur observées par le fournisseur : agrégées, non nominatives et pas nécessairement uniques sur la période.', applications: 'Candidatures envoyées', applicationsDescription: 'Envois enregistrés par la source des candidatures ; séparés des clics.', profileViews: 'Vues du profil d’entreprise', profileViewsDescription: 'Visites du profil d’entreprise, séparées des vues de l’offre.', adViews: 'Vues de l’offre', adViewsDescription: 'Événements de consultation de l’offre enregistrés.', topAdsHeading: 'Offres avec le plus de vues enregistrées', topAdsDescription: (topTitle) => `Top 10 des offres par vues${topTitle ? `, avec « ${topTitle} » en tête` : ''}.`, trendHeading: 'Évolution des vues enregistrées', trendUp: 'Les vues enregistrées progressent.', trendDown: 'Les vues enregistrées diminuent.', additionalHeading: 'Vues supplémentaires', additionalDescription: 'Les périodes de 30 et 90 jours sont des comparaisons supplémentaires et ne remplacent pas la période principale.', intent: 'Intention', submissions: 'Envois', profile: 'Profil', ad: 'Offre', ctaHeading: 'Transformez ces signaux en actions', ctaDescription: (companyName) => `Revendiquez le profil de ${companyName}, mettez vos offres en avant et guidez ce public vers votre processus de candidature avec une mesure plus claire. Mise en place en quelques minutes.`, claim: 'Revendiquer vos offres', savePdf: 'Enregistrer le rapport en PDF', generated: (companyName, date) => `Données de ${companyName} générées le ${date}`, privatePage: 'page privée, non indexée.', home: 'Accéder à l’accueil', invalidTitle: 'Lien invalide ou expiré', invalidBody: 'Ce rapport privé est accessible uniquement via le lien que nous vous avons envoyé. Il a peut-être expiré : écrivez-nous pour en recevoir un nouveau.', preparingTitle: 'Rapport en préparation', preparingBody: 'Nous recueillons encore les données de trafic de votre entreprise. Réessayez dans un instant — vous pouvez déjà publier et mettre en avant vos offres.', loading: 'Chargement du rapport…',
  },
};

function copyFor(locale: Locale): EmployerInsightsCopy {
  return COPY[locale] || COPY.it;
}

function numberFormatter(locale: Locale): Intl.NumberFormat {
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : locale);
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Small building blocks                                                        */
/* ────────────────────────────────────────────────────────────────────────── */

/** Generic scroll-reveal section wrapper (fade + slide up). */
function RevealSection({
  children,
  className = '',
  ariaLabelledby,
}: {
  children: React.ReactNode;
  className?: string;
  ariaLabelledby?: string;
}): React.ReactElement {
  const { ref, inView } = useReveal<HTMLElement>();
  return (
    <section
      ref={ref}
      aria-labelledby={ariaLabelledby}
      className={`transition-all duration-700 ease-out ${inView ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'} ${className}`}
    >
      {children}
    </section>
  );
}

type MetricValue = number | null | undefined;
/**
 * `observed-not-deduplicated` is a measured number whose units are not proven
 * distinct: the builder keeps the full observed count for event rows that
 * carry no emission id (`coverage.deduplication.status`). Dropping those rows
 * would delete real traffic; presenting them as a proven count would overstate
 * it. So the number stays and says what it is.
 */
type MetricState =
  | 'observed'
  | 'observed-not-deduplicated'
  | 'zero-observed'
  | 'data-missing'
  | 'source-unavailable'
  | 'coverage-partial';
type MetricCoverageStatus = string | null | undefined;

/** The `coverage.deduplication` block the builder writes onto every document. */
export interface EmployerDeduplicationCoverage {
  key?: string;
  status?: string;
  unavailableCount?: number;
}

/**
 * Absence of proof is not proof: a payload with no deduplication record — one
 * written before the ledger existed, or one whose status we do not recognise —
 * cannot claim its counts are deduplicated.
 */
function deduplicationIsProven(coverage: EmployerDeduplicationCoverage | null | undefined): boolean {
  return coverage?.status === 'available';
}

function deduplicationUnavailableCount(coverage: EmployerDeduplicationCoverage | null | undefined): number {
  const count = coverage?.unavailableCount;
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : 0;
}

function windowLabel(window: EmployerInsightsWindow | null | undefined, locale: Locale = 'it'): string {
  const copy = copyFor(locale);
  if (!window?.from || !window.to) return copy.windowUnavailable;
  const timezone = window.timezone?.trim() || copy.timezoneUnavailable;
  const inclusive = window.inclusive ? ` · ${window.inclusive}` : '';
  return `${window.from} → ${window.to} · ${timezone}${inclusive}`;
}

export function employerMetricState(
  value: MetricValue,
  source: string | null | undefined,
  window: EmployerInsightsWindow | null | undefined,
  deduplication?: EmployerDeduplicationCoverage | null,
  locale: Locale = 'it',
): {
  display: string;
  state: MetricState;
  source: string;
  deduplicationUnavailableCount: number;
} {
  const copy = copyFor(locale);
  const unavailableCount = deduplicationUnavailableCount(deduplication);
  const hasSource = typeof source === 'string' && source.trim().length > 0;
  const sourceLabel = hasSource ? source.trim() : copy.sourceUnavailable;
  const base = { source: sourceLabel, deduplicationUnavailableCount: unavailableCount };
  if (!hasSource) {
    return { ...base, display: copy.unavailable, state: 'source-unavailable' };
  }
  if (!window?.from || !window.to || typeof value !== 'number' || !Number.isFinite(value) || !(value >= 0)) {
    return { ...base, display: copy.unavailable, state: 'data-missing' };
  }
  if (value === 0) return { ...base, display: '0', state: 'zero-observed' };
  return {
    ...base,
    display: numberFormatter(locale).format(value),
    // The count is kept either way; only the claim about it changes.
    state: deduplicationIsProven(deduplication) ? 'observed' : 'observed-not-deduplicated',
  };
}

/** `metricState()` treats only finite non-negative values as observed. */
function metricState(
  value: MetricValue,
  source: string | null | undefined,
  window: EmployerInsightsWindow | null | undefined,
  coverageStatuses: readonly MetricCoverageStatus[] = [],
  locale: Locale = 'it',
): {
  display: string;
  state: MetricState;
  source: string;
  deduplicationUnavailableCount: number;
} {
  const copy = copyFor(locale);
  const hasSource = typeof source === 'string' && source.trim().length > 0;
  const sourceLabel = hasSource ? source.trim() : copy.sourceUnavailable;
  const base = { source: sourceLabel, deduplicationUnavailableCount: 0 };
  const coverageState = coverageStatuses.reduce<MetricState | null>((state, status) => {
    if (state === 'source-unavailable') return state;
    if (typeof status !== 'string') return state;
    const normalized = status.trim().toLowerCase();
    if (normalized === 'source_unavailable') return 'source-unavailable';
    if (normalized !== 'observed' && normalized !== 'zero_observed') return 'coverage-partial';
    return state;
  }, null);
  if (coverageState === 'source-unavailable') {
    return { ...base, display: copy.unavailable, state: coverageState };
  }
  if (!hasSource) {
    return { ...base, display: copy.unavailable, state: 'source-unavailable' };
  }
  if (!window?.from || !window.to || typeof value !== 'number' || !Number.isFinite(value) || !(value >= 0)) {
    return { ...base, display: copy.unavailable, state: 'data-missing' };
  }
  if (coverageState === 'coverage-partial') {
    return { ...base, display: numberFormatter(locale).format(value), state: coverageState };
  }
  if (value === 0) return { ...base, display: '0', state: 'zero-observed' };
  return { ...base, display: numberFormatter(locale).format(value), state: 'observed' };
}

export function employerMetricStateLabel(state: MetricState, locale: Locale = 'it'): string {
  const copy = copyFor(locale);
  if (state === 'zero-observed') return copy.zeroObserved;
  if (state === 'data-missing') return copy.missing;
  if (state === 'source-unavailable') return copy.unavailable;
  if (state === 'observed-not-deduplicated') return copy.notDeduplicated;
  if (state === 'coverage-partial') return copy.partial;
  return copy.observed;
}

function MetricCard({
  icon,
  label,
  description,
  value,
  source,
  window,
  deduplication,
  coverageStatuses,
  locale,
  featured = false,
  compact = false,
}: {
  icon: React.ReactNode;
  label: string;
  description: string;
  value: MetricValue;
  source: string | null | undefined;
  window: EmployerInsightsWindow | null | undefined;
  deduplication?: EmployerDeduplicationCoverage | null;
  coverageStatuses?: readonly MetricCoverageStatus[];
  locale: Locale;
  featured?: boolean;
  compact?: boolean;
}): React.ReactElement {
  const metric = coverageStatuses
    ? metricState(value, source, window, coverageStatuses, locale)
    : employerMetricState(value, source, window, deduplication, locale);
  const copy = copyFor(locale);
  const displayWindow = windowLabel(window, locale);
  return (
    <div
      className={`rounded-2xl border ${featured ? 'border-accent-border bg-gradient-to-br from-accent-subtle via-surface-raised to-surface-raised shadow-sm' : 'border-edge bg-surface-raised'} ${compact ? 'p-4' : 'px-4 py-5'}`}
      aria-label={`${label}: ${metric.display}`}
    >
      <span className="text-accent mb-2 inline-flex" aria-hidden="true">
        {icon}
      </span>
      <p className={`${compact ? 'text-2xl' : 'text-3xl sm:text-4xl'} font-bold font-display text-strong tabular-nums`}>
        {metric.display}
      </p>
      <p className="text-xs sm:text-sm text-subtle mt-1">{label}</p>
      <p className="text-xs text-muted mt-2">{employerMetricStateLabel(metric.state, locale)}</p>
      <dl className="mt-3 space-y-1 text-[0.7rem] leading-snug text-muted">
        <div>
          <dt className="inline font-semibold">{copy.window} </dt>
          <dd className="inline">{displayWindow}</dd>
        </div>
        <div>
          <dt className="inline font-semibold">{copy.source} </dt>
          <dd className="inline">{metric.source}</dd>
        </div>
        {metric.state === 'observed-not-deduplicated' && metric.deduplicationUnavailableCount > 0 && (
          <div>
            <dt className="inline font-semibold">{copy.deduplicationUnavailable} </dt>
            <dd className="inline">{numberFormatter(locale).format(metric.deduplicationUnavailableCount)}</dd>
          </div>
        )}
      </dl>
      <p className="text-xs text-body mt-3">{description}</p>
    </div>
  );
}

/** `additionalWindowLabel()` keeps producer window keys readable in the UI. */
function additionalWindowLabel(key: string, locale: Locale = 'it'): string {
  const normalized = key.trim().toLowerCase();
  if (/^all(?:[-_ ]?time)$/.test(normalized)) return locale === 'en' ? 'Full period' : locale === 'de' ? 'Gesamtzeitraum' : locale === 'fr' ? 'Période complète' : 'Periodo completo';
  const days = normalized.match(/^p?(\d+)\s*d$/);
  if (days) return locale === 'en' ? `${Number(days[1])} days` : locale === 'de' ? `${Number(days[1])} Tage` : locale === 'fr' ? `${Number(days[1])} jours` : `${Number(days[1])} giorni`;
  return locale === 'en' ? 'Additional window' : locale === 'de' ? 'Zusätzlicher Zeitraum' : locale === 'fr' ? 'Période supplémentaire' : 'Finestra aggiuntiva';
}

/* ────────────────────────────────────────────────────────────────────────── */
/* The report (presentational — takes already-fetched data)                     */
/* ────────────────────────────────────────────────────────────────────────── */

export function EmployerInsightsReport({
  data,
  locale: localeProp,
}: { data: EmployerInsights; locale?: Locale }): React.ReactElement {
  const { totals, trend, ads } = data;
  const { locale: currentLocale } = useTranslation();
  const locale = localeProp || currentLocale;
  const copy = copyFor(locale);
  const eventSource = data.source;
  const applicationSource = data.applicationsCoverage?.source;
  // Event counts share one deduplication proof; applications do not — they are
  // deduplicated by application id in their own source, not by emission id.
  const eventDeduplication = data.coverage?.deduplication;
  const applicationCoverageStatus = data.applicationsCoverage
    ? data.applicationsCoverage.status
    : undefined;
  const trendUp =
    trend.length >= 2 ? trend[trend.length - 1].views >= trend[0].views : true;

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 sm:py-10 space-y-12 sm:space-y-16">
      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <header className="text-center animate-fade-in-up">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold text-link bg-accent-subtle border border-accent-border mb-4">
          <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
          {copy.badge}
        </span>
        <h1 className="text-3xl sm:text-5xl font-bold font-display text-heading leading-tight text-balance">
          {copy.title(data.companyName)}
        </h1>
        <p className="mt-3 text-base sm:text-lg text-subtle max-w-xl mx-auto text-pretty">
          {copy.intro}
        </p>
        <p className="mt-2 text-xs text-muted">{copy.mainWindow} {windowLabel(data.window, locale)}</p>

        <div className="mt-8 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-5">
          <MetricCard
            featured
            icon={<MousePointerClick className="w-5 h-5" />}
            value={typeof totals.applyClicks === 'number' ? totals.applyClicks : undefined}
            label={copy.applyClicks}
            description={copy.applyClicksDescription}
            source={eventSource}
            deduplication={eventDeduplication}
            window={data.window}
            locale={locale}
          />
          <MetricCard
            icon={<Users className="w-5 h-5" />}
            value={totals.applyClickUsers}
            label={copy.applyClickUsers}
            description={copy.applyClickUsersDescription}
            source={eventSource}
            deduplication={eventDeduplication}
            window={data.window}
            locale={locale}
          />
          <MetricCard
            icon={<FileText className="w-5 h-5" />}
            value={totals.applications}
            label={copy.applications}
            description={copy.applicationsDescription}
            source={applicationSource}
            window={data.window}
            coverageStatuses={[applicationCoverageStatus, totals.applicationsStatus]}
            locale={locale}
          />
          <MetricCard
            icon={<Building2 className="w-5 h-5" />}
            value={totals.profileViews}
            label={copy.profileViews}
            description={copy.profileViewsDescription}
            source={eventSource}
            deduplication={eventDeduplication}
            window={data.window}
            locale={locale}
          />
          <MetricCard
            icon={<Eye className="w-5 h-5" />}
            value={totals.views}
            label={copy.adViews}
            description={copy.adViewsDescription}
            source={eventSource}
            deduplication={eventDeduplication}
            window={data.window}
            locale={locale}
          />
        </div>
      </header>

      {/* ── Top ads bar chart ───────────────────────────────────────────── */}
      {ads.length > 0 && (
        <RevealSection ariaLabelledby="insights-topads-heading">
          <h2
            id="insights-topads-heading"
            className="text-xl sm:text-2xl font-bold font-display text-strong mb-1"
          >
            {copy.topAdsHeading}
          </h2>
          <p className="text-sm text-subtle mb-5">
            {copy.topAdsDescription(data.topAd?.title)}
          </p>
          <p className="text-xs text-muted mb-4">
            {copy.window} {windowLabel(data.window, locale)} · {copy.source} {typeof eventSource === 'string' && eventSource.trim() ? eventSource : copy.sourceUnavailable}
          </p>
          <TopAdsChart ads={ads} limit={10} locale={locale} />
        </RevealSection>
      )}

      {/* ── Trend sparkline ─────────────────────────────────────────────── */}
      {trend.length >= 2 && (
        <RevealSection
          ariaLabelledby="insights-trend-heading"
          className="rounded-3xl border border-edge bg-surface-raised px-5 py-6 sm:px-7 sm:py-7"
        >
          <div className="flex items-center gap-2 mb-1">
            <span className={trendUp ? 'text-success' : 'text-warning-strong'} aria-hidden="true">
              {trendUp ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
            </span>
            <h2
              id="insights-trend-heading"
              className="text-xl sm:text-2xl font-bold font-display text-strong"
            >
              {copy.trendHeading}
            </h2>
          </div>
          <p className="text-sm text-subtle mb-2">
            {trendUp ? copy.trendUp : copy.trendDown}
          </p>
          <p className="text-xs text-muted mb-4">
            {copy.window} {windowLabel(data.window, locale)} · {copy.source} {typeof eventSource === 'string' && eventSource.trim() ? eventSource : copy.sourceUnavailable}
          </p>
          <TrendSparkline trend={trend} locale={locale} />
        </RevealSection>
      )}

      {data.additionalWindows && Object.entries(data.additionalWindows).length > 0 && (
        <RevealSection ariaLabelledby="insights-additional-heading">
          <h2 id="insights-additional-heading" className="text-xl sm:text-2xl font-bold font-display text-strong mb-1">
            {copy.additionalHeading}
          </h2>
          <p className="text-sm text-subtle mb-5">
            {copy.additionalDescription}
          </p>
          <div className="space-y-6">
            {Object.entries(data.additionalWindows).map(([key, summary]) => (
              <div key={key}>
                <h3 className="text-base font-semibold text-strong mb-3">{additionalWindowLabel(key, locale)}</h3>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  <MetricCard
                    compact
                    icon={<MousePointerClick className="w-4 h-4" />}
                    value={summary.totals.applyClicks}
                    label={copy.applyClicks}
                    description={copy.intent}
                    source={eventSource}
                    deduplication={eventDeduplication}
                    window={summary.window}
                    locale={locale}
                  />
                  <MetricCard
                    compact
                    icon={<Users className="w-4 h-4" />}
                    value={summary.totals.applyClickUsers}
                    label={copy.applyClickUsers}
                    description={copy.intent}
                    source={eventSource}
                    deduplication={eventDeduplication}
                    window={summary.window}
                    locale={locale}
                  />
                  <MetricCard
                    compact
                    icon={<FileText className="w-4 h-4" />}
                    value={summary.totals.applications}
                    label={copy.applications}
                    description={copy.submissions}
                    source={applicationSource}
                    window={summary.window}
                    coverageStatuses={[applicationCoverageStatus, summary.totals.applicationsStatus]}
                    locale={locale}
                  />
                  <MetricCard
                    compact
                    icon={<Building2 className="w-4 h-4" />}
                    value={summary.totals.profileViews}
                    label={copy.profileViews}
                    description={copy.profile}
                    source={eventSource}
                    deduplication={eventDeduplication}
                    window={summary.window}
                    locale={locale}
                  />
                  <MetricCard
                    compact
                    icon={<Eye className="w-4 h-4" />}
                    value={summary.totals.views}
                    label={copy.adViews}
                    description={copy.ad}
                    source={eventSource}
                    deduplication={eventDeduplication}
                    window={summary.window}
                    locale={locale}
                  />
                </div>
              </div>
            ))}
          </div>
        </RevealSection>
      )}

      {/* ── CTA ─────────────────────────────────────────────────────────── */}
      <RevealSection
        ariaLabelledby="insights-cta-heading"
        className="rounded-3xl bg-surface-inverted px-6 py-10 sm:px-10 sm:py-12 text-center"
      >
        <h2
          id="insights-cta-heading"
          className="text-2xl sm:text-3xl font-bold font-display text-on-accent text-balance"
        >
          {copy.ctaHeading}
        </h2>
        <p className="mt-3 text-sm sm:text-base text-on-accent/80 max-w-md mx-auto text-pretty">
          {copy.ctaDescription(data.companyName)}
        </p>
        <a
          href={`${buildPath({ activeTab: 'publish' }, locale)}?claim=1&tier=azienda`}
          className="mt-7 inline-flex items-center justify-center gap-2 px-7 py-3.5 text-base font-semibold text-on-accent bg-accent hover:bg-accent-hover rounded-xl shadow-sm transition-colors no-underline"
        >
          {copy.claim}
          <ArrowRight className="w-5 h-5" aria-hidden="true" />
        </a>
      </RevealSection>

      {/* Save-as-PDF: lets the company keep its own copy without us emailing an
          attachment (attachments hurt cold-email deliverability). Browser
          print-to-PDF; hidden in the printed output itself. */}
      <div className="text-center print:hidden">
        <button
          type="button"
          onClick={() => { if (typeof window !== 'undefined') window.print(); }}
          className="inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-body bg-surface-alt hover:bg-surface-muted border border-edge rounded-xl transition-colors"
        >
          {copy.savePdf}
        </button>
      </div>

      <p className="text-center text-xs text-muted">
        {copy.generated(data.companyName, new Date(data.generatedAt).toLocaleDateString(locale))}{' '}
        · {copy.privatePage}
      </p>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* States: loading / error / empty                                              */
/* ────────────────────────────────────────────────────────────────────────── */

function CenteredMessage({
  title,
  body,
  homeHref = '/',
  homeLabel = 'Vai alla home',
  showHome = true,
}: {
  title: string;
  body: string;
  homeHref?: string;
  homeLabel?: string;
  showHome?: boolean;
}): React.ReactElement {
  return (
    <div className="max-w-md mx-auto px-4 py-20 text-center">
      <h1 className="text-2xl font-bold font-display text-strong mb-3">{title}</h1>
      <p className="text-base text-subtle text-pretty">{body}</p>
      {showHome && (
        <a
          href={homeHref}
          className="mt-6 inline-flex items-center justify-center gap-2 px-5 py-2.5 text-sm font-semibold text-link border border-edge rounded-xl hover:bg-surface-alt transition-colors no-underline"
        >
          <Home className="w-4 h-4" aria-hidden="true" />
          {homeLabel}
        </a>
      )}
    </div>
  );
}

function LoadingSkeleton(): React.ReactElement {
  const { locale } = useTranslation();
  const copy = copyFor(locale);
  return (
    <div className="max-w-3xl mx-auto px-4 py-10" aria-busy="true" aria-live="polite">
      <span className="sr-only">{copy.loading}</span>
      <div className="flex justify-center mb-8" aria-hidden="true">
        <Loader2 className="w-7 h-7 text-accent animate-spin" />
      </div>
      <div className="space-y-6" aria-hidden="true">
        <div className="h-10 rounded-xl bg-surface-alt animate-pulse mx-auto w-3/4" />
        <div className="grid grid-cols-3 gap-3">
          <div className="h-24 rounded-2xl bg-surface-alt animate-pulse" />
          <div className="h-24 rounded-2xl bg-surface-alt animate-pulse" />
          <div className="h-24 rounded-2xl bg-surface-alt animate-pulse" />
        </div>
        <div className="h-40 rounded-3xl bg-surface-alt animate-pulse" />
        <div className="h-32 rounded-3xl bg-surface-alt animate-pulse" />
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Route wrapper — reads companyKey from path + token from query, fetches       */
/* ────────────────────────────────────────────────────────────────────────── */

/** Pull `companyKey` from the path (`/azienda/<companyKey>/`) if not provided. */
function companyKeyFromPath(): string {
  if (typeof window === 'undefined') return '';
  const segs = window.location.pathname.split('/').filter(Boolean);
  const idx = segs.indexOf('azienda');
  return idx >= 0 && segs[idx + 1] ? decodeURIComponent(segs[idx + 1]) : '';
}

function tokenFromQuery(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('t') ?? '';
}

/**
 * Set document.title and force noindex robots meta for the lifetime of the
 * report page; restore on unmount. Centralised so every state (and the wrapper)
 * keeps the page out of the index.
 */
function usePrivatePageHead(title: string): void {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = title;

    const meta = document.querySelector('meta[name="robots"]');
    const prevRobots = meta?.getAttribute('content') ?? null;
    let created = false;
    let el = meta as HTMLMetaElement | null;
    if (el) {
      el.setAttribute('content', 'noindex, nofollow');
    } else {
      el = document.createElement('meta');
      el.setAttribute('name', 'robots');
      el.setAttribute('content', 'noindex, nofollow');
      document.head.appendChild(el);
      created = true;
    }

    return () => {
      document.title = prevTitle;
      if (created && el) {
        el.remove();
      } else if (el && prevRobots != null) {
        el.setAttribute('content', prevRobots);
      }
    };
  }, [title]);
}

export interface EmployerInsightsPageProps {
  /** Override companyKey (else read from path). */
  companyKey?: string;
  /** Override token (else read from query `t`). */
  token?: string;
}

export function EmployerInsightsPage({
  companyKey: companyKeyProp,
  token: tokenProp,
}: EmployerInsightsPageProps = {}): React.ReactElement {
  const { locale } = useTranslation();
  const copy = copyFor(locale);
  const companyKey = companyKeyProp ?? companyKeyFromPath();
  const token = tokenProp ?? tokenFromQuery();

  const [result, setResult] = useState<FetchInsightsResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    fetchInsights(companyKey, token)
      .then((r) => {
        if (!cancelled) setResult(r);
      })
      .catch(() => {
        if (!cancelled) setResult({ status: 'error', reason: 'network' });
      });
    return () => {
      cancelled = true;
    };
  }, [companyKey, token]);

  const companyName = result?.status === 'ok' ? result.data.companyName : locale === 'en' ? 'Your company' : locale === 'de' ? 'Ihr Unternehmen' : locale === 'fr' ? 'Votre entreprise' : 'La tua azienda';
  usePrivatePageHead(result?.status === 'ok' ? copy.title(companyName) : `${companyName} — Frontaliere Ticino`);
  const homeHref = locale === 'it' ? '/' : `/${locale}/`;

  if (result === null) return <LoadingSkeleton />;

  if (result.status === 'error') {
    return (
      <CenteredMessage
        title={copy.invalidTitle}
        body={copy.invalidBody}
        homeHref={homeHref}
        homeLabel={copy.home}
      />
    );
  }

  if (result.status === 'not-found') {
    return (
      <CenteredMessage
        title={copy.preparingTitle}
        body={copy.preparingBody}
        homeHref={homeHref}
        homeLabel={copy.home}
      />
    );
  }

  return <EmployerInsightsReport data={result.data} />;
}

export default EmployerInsightsPage;
