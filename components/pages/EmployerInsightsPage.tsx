/**
 * Private employer-insights report.
 *
 * The page deliberately separates three things that are easy to confuse:
 * recorded traffic, intent signals, and completed applications. It consumes
 * the token-gated report through services/employerInsights and never exposes
 * a person-level identifier.
 */
import React, { useEffect, useState } from 'react';
import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  Eye,
  Home,
  Layers3,
  Loader2,
  MousePointerClick,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import {
  fetchInsights,
  humanizeInsightsSource,
  type EmployerApplicationsCoverage,
  type EmployerInsights,
  type EmployerInsightsTrendPoint,
  type EmployerInsightsWindow,
  type EmployerEventsCoverage,
  type FetchInsightsResult,
} from '@/services/employerInsights';
import { TopAdsChart } from '@/components/insights/TopAdsChart';
import { InsightsTrendChart } from '@/components/insights/InsightsTrendChart';
import { buildPath } from '@/services/router';
import { useTranslation, type Locale } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { cdnImageUrl } from '@/services/cdnImageBase';
import { resolveCompanyLogoUrl } from '@/services/jobDataNormalization';
import { generateInitialsLogo } from '@/services/logoService';

interface EmployerInsightsCopy {
  reportLabel: string;
  title: (companyName: string) => string;
  intro: string;
  periodLabel: string;
  period30: string;
  period90: string;
  periodUnavailable: string;
  sourceUnavailable: string;
  updated: (date: string) => string;
  overviewHeading: string;
  applyClicks: string;
  applyClicksDescription: string;
  interestRate: string;
  interestRateDescription: string;
  adViews: string;
  adViewsDescription: string;
  attentionShare: string;
  attentionShareDescription: string;
  adsWithClicks: string;
  adsWithClicksDescription: string;
  topAdsHeading: string;
  topAdsDescription: string;
  trendHeading: string;
  trendDescription: string;
  trendUp: string;
  trendDown: string;
  qualityHeading: string;
  qualityDescription: string;
  qualitySource: string;
  qualitySourceDescription: string;
  profileViews: string;
  profileObserved: string;
  profileZero: string;
  profileMissing: string;
  profileUnavailable: string;
  applications: string;
  applicationsDescription: string;
  applicationsObserved: (value: string) => string;
  applicationsZero: string;
  measurementHeading: string;
  measurementDescription: string;
  observed: string;
  zeroObserved: string;
  missing: string;
  unavailable: string;
  partial: string;
  logoAlt: (companyName: string) => string;
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
    reportLabel: 'Report privato · dati aggregati',
    title: (companyName) => `I segnali di ${companyName}`,
    intro: 'Un quadro verificabile di visibilità e interesse per i tuoi annunci, con un periodo che puoi esplorare.',
    periodLabel: 'Periodo', period30: 'Ultimi 30 giorni', period90: 'Ultimi 90 giorni', periodUnavailable: 'Periodo non disponibile',
    sourceUnavailable: 'Fonte non disponibile',
    updated: (date) => `Aggiornato il ${date}`,
    overviewHeading: 'Il segnale in breve',
    applyClicks: 'Click per candidarsi', applyClicksDescription: 'Un segnale di interesse, non una candidatura inviata.',
    interestRate: 'Tasso di interesse', interestRateDescription: 'Click per candidarsi ÷ visualizzazioni annuncio.',
    adViews: 'Visualizzazioni annunci', adViewsDescription: 'Eventi di visualizzazione registrati.',
    attentionShare: 'Peso dell’annuncio principale', attentionShareDescription: 'Quota delle visualizzazioni concentrate sull’annuncio più visto.', adsWithClicks: 'Annunci con click', adsWithClicksDescription: 'Annunci con almeno un click per candidarsi (su quelli misurati).',
    topAdsHeading: 'Dove si concentra l’attenzione', topAdsDescription: 'Gli annunci sono ordinati per visualizzazioni; sotto trovi anche click e tasso di interesse.',
    trendHeading: 'Andamento nel tempo', trendDescription: 'La linea segue le visualizzazioni. Le barre mostrano i click quando esistono valori settimanali. Ogni serie usa la propria scala.',
    trendUp: 'La visibilità registrata è cresciuta nel periodo.', trendDown: 'La visibilità registrata è diminuita nel periodo.',
    qualityHeading: 'Trasparenza della misura', qualityDescription: 'Cosa misura il report, come leggere un click e dove si ferma il dato.',
    qualitySource: 'Da dove arrivano i numeri', qualitySourceDescription: 'Numeri aggregati dalla sorgente indicata sopra, nel periodo selezionato.',
    profileViews: 'Visite al profilo azienda', profileObserved: 'Visite al profilo registrate separatamente dalle pagine degli annunci.', profileZero: 'Non è disponibile un segnale separato di visita al profilo nel periodo.', profileMissing: 'Questo segnale non è presente nel report.', profileUnavailable: 'La sorgente non rende disponibile questo segnale.',
    applications: 'Candidature inviate', applicationsDescription: 'La candidatura si completa sul sito esterno; questo report non vede il completamento.', applicationsObserved: (value) => `${value} registrate`, applicationsZero: 'Nessuna candidatura registrata nel periodo.',
    measurementHeading: 'Il click segnala interesse', measurementDescription: 'Il click registra il passaggio verso la candidatura. Se il completamento avviene su un sito esterno, questo report non lo vede.',
    observed: 'dato osservato', zeroObserved: 'zero osservato', missing: 'dato assente', unavailable: 'non disponibile', partial: 'copertura parziale',
    logoAlt: (companyName) => `Logo di ${companyName}`,
    ctaHeading: 'Dai seguito ai segnali registrati', ctaDescription: (companyName) => `Rivendica il profilo di ${companyName}, metti gli annunci in evidenza e accompagna il pubblico verso il tuo processo di candidatura con una misurazione più chiara.`, claim: 'Rivendica i tuoi annunci', savePdf: 'Salva questi dati in PDF',
    generated: (companyName, date) => `Dati di ${companyName} generati il ${date}`, privatePage: 'pagina privata, non indicizzata.', home: 'Vai alla home',
    invalidTitle: 'Link non valido o scaduto', invalidBody: 'Questo report è privato e raggiungibile solo dal link che ti abbiamo inviato. Il link potrebbe essere scaduto: scrivici e te ne mandiamo uno nuovo.',
    preparingTitle: 'Report in preparazione', preparingBody: 'Stiamo ancora raccogliendo i dati di traffico per la tua azienda. Riprova tra poco.', loading: 'Caricamento del report in corso…',
  },
  en: {
    reportLabel: 'Private report · aggregated data', title: (companyName) => `The signals from ${companyName}`, intro: 'A verifiable view of visibility and interest for your job ads, with a period you can explore.',
    periodLabel: 'Period', period30: 'Last 30 days', period90: 'Last 90 days', periodUnavailable: 'Period unavailable', sourceUnavailable: 'Source unavailable', updated: (date) => `Updated ${date}`,
    overviewHeading: 'The signal at a glance', applyClicks: 'Apply clicks', applyClicksDescription: 'A signal of interest, not a submitted application.', interestRate: 'Interest rate', interestRateDescription: 'Apply clicks ÷ ad views.', adViews: 'Ad views', adViewsDescription: 'Recorded view events.', attentionShare: 'Share of the leading ad', attentionShareDescription: 'Share of all views concentrated on the most-viewed ad.', adsWithClicks: 'Ads with clicks', adsWithClicksDescription: 'Ads with at least one apply click (out of measured ads).', topAdsHeading: 'Where attention is focused', topAdsDescription: 'Ads are ordered by views; clicks and interest rate are shown below too.', trendHeading: 'Trend over time', trendDescription: 'The line follows views. Bars show apply clicks when weekly values exist. Each series uses its own scale.', trendUp: 'Recorded visibility grew over the period.', trendDown: 'Recorded visibility declined over the period.',
    qualityHeading: 'Measurement transparency', qualityDescription: 'What this report measures, how to read a click and where the data stops.', qualitySource: 'Where the numbers come from', qualitySourceDescription: 'Aggregated numbers from the source shown above, for the selected period.', profileViews: 'Company profile visits', profileObserved: 'Profile visits recorded separately from ad pages.', profileZero: 'No separate profile-visit signal is available for this period.', profileMissing: 'This signal is not included in the report.', profileUnavailable: 'The source does not provide this signal.', applications: 'Applications submitted', applicationsDescription: 'Applications are completed on an external site; this report cannot see completion.', applicationsObserved: (value) => `${value} recorded`, applicationsZero: 'No application was recorded in the period.', measurementHeading: 'A click signals interest', measurementDescription: 'A click records the path towards an application. If completion happens on an external site, this report cannot see it.',
    observed: 'observed data', zeroObserved: 'zero observed', missing: 'data missing', unavailable: 'not available', partial: 'partial coverage', logoAlt: (companyName) => `${companyName} logo`, ctaHeading: 'Turn these signals into action', ctaDescription: (companyName) => `Claim ${companyName}’s profile, feature your ads and guide this audience to your application process with clearer measurement.`, claim: 'Claim your job ads', savePdf: 'Save this report as PDF', generated: (companyName, date) => `Data for ${companyName} generated on ${date}`, privatePage: 'private, not indexed.', home: 'Go to homepage', invalidTitle: 'Invalid or expired link', invalidBody: 'This private report is only available through the link we sent you. It may have expired: contact us and we will send you a new one.', preparingTitle: 'Report being prepared', preparingBody: 'We are still collecting traffic data for your company. Try again shortly.', loading: 'Loading report…',
  },
  de: {
    reportLabel: 'Privater Bericht · aggregierte Daten', title: (companyName) => `Die Signale von ${companyName}`, intro: 'Eine überprüfbare Ansicht von Sichtbarkeit und Interesse für Ihre Stellenanzeigen – mit wählbarem Zeitraum.',
    periodLabel: 'Zeitraum', period30: 'Letzte 30 Tage', period90: 'Letzte 90 Tage', periodUnavailable: 'Zeitraum nicht verfügbar', sourceUnavailable: 'Quelle nicht verfügbar', updated: (date) => `Aktualisiert am ${date}`,
    overviewHeading: 'Das Signal auf einen Blick', applyClicks: 'Klicks auf Bewerbung', applyClicksDescription: 'Ein Signal für Interesse, keine eingereichte Bewerbung.', interestRate: 'Interesse', interestRateDescription: 'Bewerbungsklicks ÷ Anzeigenaufrufe.', adViews: 'Anzeigenaufrufe', adViewsDescription: 'Erfasste Aufrufereignisse.', attentionShare: 'Anteil der führenden Anzeige', attentionShareDescription: 'Anteil aller Aufrufe, der auf die meistgesehene Anzeige entfällt.', adsWithClicks: 'Anzeigen mit Klicks', adsWithClicksDescription: 'Anzeigen mit mindestens einem Bewerbungsklick (von den gemessenen Anzeigen).', topAdsHeading: 'Wo die Aufmerksamkeit liegt', topAdsDescription: 'Die Anzeigen sind nach Aufrufen geordnet; Klicks und Interesse stehen ebenfalls dabei.', trendHeading: 'Entwicklung im Zeitverlauf', trendDescription: 'Die Linie zeigt Aufrufe. Balken zeigen Bewerbungsklicks, sofern Wochenwerte vorhanden sind. Jede Serie nutzt ihre eigene Skala.', trendUp: 'Die erfasste Sichtbarkeit ist im Zeitraum gestiegen.', trendDown: 'Die erfasste Sichtbarkeit ist im Zeitraum gesunken.',
    qualityHeading: 'Transparenz der Messung', qualityDescription: 'Was dieser Bericht misst, wie ein Klick zu lesen ist und wo die Daten enden.', qualitySource: 'Herkunft der Zahlen', qualitySourceDescription: 'Aggregierte Zahlen aus der oben genannten Quelle für den gewählten Zeitraum.', profileViews: 'Besuche des Unternehmensprofils', profileObserved: 'Profilbesuche getrennt von den Anzeigenseiten erfasst.', profileZero: 'Für diesen Zeitraum ist kein separates Profilbesuch-Signal verfügbar.', profileMissing: 'Dieses Signal ist im Bericht nicht enthalten.', profileUnavailable: 'Die Quelle stellt dieses Signal nicht bereit.', applications: 'Eingereichte Bewerbungen', applicationsDescription: 'Bewerbungen werden auf einer externen Seite abgeschlossen; dieser Bericht sieht den Abschluss nicht.', applicationsObserved: (value) => `${value} erfasst`, applicationsZero: 'Im Zeitraum wurde keine Bewerbung erfasst.', measurementHeading: 'Ein Klick signalisiert Interesse', measurementDescription: 'Ein Klick erfasst den Weg zur Bewerbung. Wenn der Abschluss auf einer externen Seite erfolgt, kann dieser Bericht ihn nicht sehen.',
    observed: 'beobachtete Daten', zeroObserved: 'null beobachtet', missing: 'Daten fehlen', unavailable: 'nicht verfügbar', partial: 'teilweise Abdeckung', logoAlt: (companyName) => `Logo von ${companyName}`, ctaHeading: 'Machen Sie mehr aus diesen Signalen', ctaDescription: (companyName) => `Beanspruchen Sie das Profil von ${companyName}, heben Sie Ihre Anzeigen hervor und führen Sie diese Zielgruppe mit klarerer Messung zu Ihrem Bewerbungsprozess.`, claim: 'Stellenanzeigen beanspruchen', savePdf: 'Bericht als PDF speichern', generated: (companyName, date) => `Daten für ${companyName}, erstellt am ${date}`, privatePage: 'privat, nicht indexiert.', home: 'Zur Startseite', invalidTitle: 'Ungültiger oder abgelaufener Link', invalidBody: 'Dieser private Bericht ist nur über den zugesandten Link erreichbar. Der Link ist möglicherweise abgelaufen: Kontaktieren Sie uns für einen neuen Link.', preparingTitle: 'Bericht wird vorbereitet', preparingBody: 'Wir sammeln noch Verkehrsdaten für Ihr Unternehmen. Versuchen Sie es später erneut.', loading: 'Bericht wird geladen…',
  },
  fr: {
    reportLabel: 'Rapport privé · données agrégées', title: (companyName) => `Les signaux de ${companyName}`, intro: 'Une vue vérifiable de la visibilité et de l’intérêt pour vos offres, avec une période à explorer.',
    periodLabel: 'Période', period30: '30 derniers jours', period90: '90 derniers jours', periodUnavailable: 'Période indisponible', sourceUnavailable: 'Source indisponible', updated: (date) => `Mis à jour le ${date}`,
    overviewHeading: 'Le signal en un coup d’œil', applyClicks: 'Clics pour postuler', applyClicksDescription: 'Un signal d’intérêt, pas une candidature envoyée.', interestRate: 'Taux d’intérêt', interestRateDescription: 'Clics pour postuler ÷ vues de l’offre.', adViews: 'Vues des offres', adViewsDescription: 'Événements de consultation enregistrés.', attentionShare: 'Part de l’offre principale', attentionShareDescription: 'Part de toutes les vues concentrée sur l’offre la plus consultée.', adsWithClicks: 'Offres avec clics', adsWithClicksDescription: 'Offres ayant reçu au moins un clic pour postuler (parmi les offres mesurées).', topAdsHeading: 'Où se concentre l’attention', topAdsDescription: 'Les offres sont classées par vues ; les clics et le taux d’intérêt sont également indiqués.', trendHeading: 'Évolution dans le temps', trendDescription: 'La ligne suit les vues. Les barres montrent les clics lorsque des valeurs hebdomadaires existent. Chaque série utilise sa propre échelle.', trendUp: 'La visibilité enregistrée a progressé sur la période.', trendDown: 'La visibilité enregistrée a diminué sur la période.',
    qualityHeading: 'Transparence de la mesure', qualityDescription: 'Ce que ce rapport mesure, comment lire un clic et où les données s’arrêtent.', qualitySource: 'Origine des chiffres', qualitySourceDescription: 'Des chiffres agrégés issus de la source indiquée ci-dessus, pour la période sélectionnée.', profileViews: 'Visites du profil d’entreprise', profileObserved: 'Visites du profil enregistrées séparément des pages d’offres.', profileZero: 'Aucun signal séparé de visite du profil n’est disponible pour cette période.', profileMissing: 'Ce signal n’est pas présent dans le rapport.', profileUnavailable: 'La source ne fournit pas ce signal.', applications: 'Candidatures envoyées', applicationsDescription: 'Les candidatures sont finalisées sur un site externe ; ce rapport ne voit pas la finalisation.', applicationsObserved: (value) => `${value} enregistrées`, applicationsZero: 'Aucune candidature n’a été enregistrée sur la période.', measurementHeading: 'Un clic signale un intérêt', measurementDescription: 'Un clic enregistre le parcours vers la candidature. Si la finalisation a lieu sur un site externe, ce rapport ne la voit pas.',
    observed: 'donnée observée', zeroObserved: 'zéro observé', missing: 'donnée absente', unavailable: 'indisponible', partial: 'couverture partielle', logoAlt: (companyName) => `Logo de ${companyName}`, ctaHeading: 'Transformez ces signaux en actions', ctaDescription: (companyName) => `Revendiquez le profil de ${companyName}, mettez vos offres en avant et guidez ce public vers votre processus de candidature avec une mesure plus claire.`, claim: 'Revendiquer vos offres', savePdf: 'Enregistrer le rapport en PDF', generated: (companyName, date) => `Données de ${companyName} générées le ${date}`, privatePage: 'page privée, non indexée.', home: 'Accéder à l’accueil', invalidTitle: 'Lien invalide ou expiré', invalidBody: 'Ce rapport privé est accessible uniquement via le lien que nous vous avons envoyé. Il a peut-être expiré : écrivez-nous pour en recevoir un nouveau.', preparingTitle: 'Rapport en préparation', preparingBody: 'Nous recueillons encore les données de trafic de votre entreprise. Réessayez dans un instant.', loading: 'Chargement du rapport…',
  },
};

function copyFor(locale: Locale): EmployerInsightsCopy {
  return COPY[locale] || COPY.it;
}

function numberFormatter(locale: Locale): Intl.NumberFormat {
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : locale);
}

function localeTag(locale: Locale): string {
  return locale === 'it' ? 'it-IT' : locale;
}

function dateParts(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatterFor(locale: Locale, timezone: string, includeYear: boolean): Intl.DateTimeFormat {
  const options: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', ...(includeYear ? { year: 'numeric' } : {}), timeZone: timezone };
  try { return new Intl.DateTimeFormat(localeTag(locale), options); } catch { return new Intl.DateTimeFormat(localeTag(locale), { ...options, timeZone: 'UTC' }); }
}

/** Format the exclusive API end as the last observed calendar day. */
export function windowLabel(window: EmployerInsightsWindow | null | undefined, locale: Locale = 'it'): string {
  const copy = copyFor(locale);
  const from = dateParts(window?.from);
  const exclusiveTo = dateParts(window?.to);
  if (!from || !exclusiveTo) return copy.periodUnavailable;
  const to = new Date(exclusiveTo.getTime() - 1);
  const timezone = window?.timezone?.trim() || 'UTC';
  const fullFormatter = formatterFor(locale, timezone, true);
  const shortFormatter = formatterFor(locale, timezone, false);
  const fromYear = fullFormatter.formatToParts(from).find((part) => part.type === 'year')?.value;
  const toYear = fullFormatter.formatToParts(to).find((part) => part.type === 'year')?.value;
  if (fromYear && fromYear === toYear) return `${shortFormatter.format(from)} – ${shortFormatter.format(to)} ${toYear}`;
  return `${fullFormatter.format(from)} – ${fullFormatter.format(to)}`;
}

function generatedDate(value: string, locale: Locale): string {
  const date = dateParts(value);
  if (!date) return copyFor(locale).periodUnavailable;
  return formatterFor(locale, 'UTC', true).format(date);
}

type MetricValue = number | null | undefined;
export type MetricState = 'observed' | 'observed-not-deduplicated' | 'zero-observed' | 'data-missing' | 'source-unavailable' | 'coverage-partial';

export interface EmployerDeduplicationCoverage {
  key?: string;
  status?: string;
  unavailableCount?: number;
}

function deduplicationIsProven(coverage: EmployerDeduplicationCoverage | null | undefined): boolean {
  return coverage?.status === 'available';
}

function deduplicationUnavailableCount(coverage: EmployerDeduplicationCoverage | null | undefined): number {
  const count = coverage?.unavailableCount;
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : 0;
}

export function employerMetricState(value: MetricValue, source: string | null | undefined, window: EmployerInsightsWindow | null | undefined, deduplication?: EmployerDeduplicationCoverage | null, locale: Locale = 'it'): { display: string; state: MetricState; source: string; deduplicationUnavailableCount: number } {
  const copy = copyFor(locale);
  const unavailableCount = deduplicationUnavailableCount(deduplication);
  const hasSource = typeof source === 'string' && source.trim().length > 0;
  const sourceLabel = hasSource ? source.trim() : copy.sourceUnavailable;
  const base = { source: sourceLabel, deduplicationUnavailableCount: unavailableCount };
  if (!hasSource) return { ...base, display: copy.unavailable, state: 'source-unavailable' };
  if (!window?.from || !window.to || typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { ...base, display: copy.unavailable, state: 'data-missing' };
  if (value === 0) return { ...base, display: '0', state: 'zero-observed' };
  return { ...base, display: numberFormatter(locale).format(value), state: deduplicationIsProven(deduplication) ? 'observed' : 'observed-not-deduplicated' };
}

function metricState(value: MetricValue, source: string | null | undefined, window: EmployerInsightsWindow | null | undefined, coverageStatuses: readonly (string | null | undefined)[] = [], locale: Locale = 'it'): { display: string; state: MetricState; source: string; deduplicationUnavailableCount: number } {
  const copy = copyFor(locale);
  const hasSource = typeof source === 'string' && source.trim().length > 0;
  const sourceLabel = hasSource ? source.trim() : copy.sourceUnavailable;
  const base = { source: sourceLabel, deduplicationUnavailableCount: 0 };
  const coverageState = coverageStatuses.reduce<MetricState | null>((state, status) => {
    if (state === 'source-unavailable' || typeof status !== 'string') return state;
    const normalized = status.trim().toLowerCase();
    if (normalized === 'source_unavailable') return 'source-unavailable';
    if (normalized !== 'observed' && normalized !== 'zero_observed') return 'coverage-partial';
    return state;
  }, null);
  if (coverageState === 'source-unavailable' || !hasSource) return { ...base, display: copy.unavailable, state: 'source-unavailable' };
  if (!window?.from || !window.to || typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { ...base, display: copy.unavailable, state: 'data-missing' };
  if (coverageState === 'coverage-partial') return { ...base, display: numberFormatter(locale).format(value), state: coverageState };
  if (value === 0) return { ...base, display: '0', state: 'zero-observed' };
  return { ...base, display: numberFormatter(locale).format(value), state: 'observed' };
}

export function employerMetricStateLabel(state: MetricState, locale: Locale = 'it'): string {
  const copy = copyFor(locale);
  if (state === 'zero-observed') return copy.zeroObserved;
  if (state === 'data-missing') return copy.missing;
  if (state === 'source-unavailable') return copy.unavailable;
  // The source can retain a technical deduplication state, but the report
  // should describe the number as observed data rather than foregrounding an
  // implementation detail in the customer-facing surface.
  if (state === 'observed-not-deduplicated') return copy.observed;
  if (state === 'coverage-partial') return copy.partial;
  return copy.observed;
}

function RevealSection({ children, className = '', ariaLabelledby }: { children: React.ReactNode; className?: string; ariaLabelledby?: string }): React.ReactElement {
  return <section aria-labelledby={ariaLabelledby} className={className}>{children}</section>;
}

function CompanyLogo({ companyName, companyKey, alt }: { companyName: string; companyKey: string; alt: string }): React.ReactElement {
  const fallback = generateInitialsLogo(companyName);
  const resolved = cdnImageUrl(resolveCompanyLogoUrl({ company: companyName, companyKey })) || fallback;
  const [src, setSrc] = useState(resolved);
  useEffect(() => setSrc(resolved), [resolved]);
  return <img src={src} alt={alt} width={72} height={72} className="h-[72px] w-[72px] rounded-xl bg-surface p-2 object-contain" loading="eager" onError={() => setSrc(fallback)} />;
}

function MetricTile({ icon, label, value, description, state }: { icon: React.ReactNode; label: string; value: string; description: string; state?: string }): React.ReactElement {
  return <div className="flex min-w-0 flex-col px-4 py-5 first:pl-0 last:pr-0 sm:px-5"><span className="order-1 mb-3 inline-flex text-accent" aria-hidden="true">{icon}</span><dt className="order-3 mt-1 text-sm font-semibold text-body">{label}</dt><dd className="order-2 m-0 font-display text-2xl font-semibold tabular-nums text-strong sm:text-3xl">{value}</dd><dd className="order-4 mt-2 text-xs leading-relaxed text-muted">{description}</dd>{state && <dd className="order-5 mt-2 text-xs font-medium text-warning-strong">{state}</dd>}</div>;
}

function formatRate(clicks: MetricValue, views: MetricValue, locale: Locale): string {
  if (typeof clicks !== 'number' || typeof views !== 'number' || views <= 0 || clicks < 0) return '—';
  return new Intl.NumberFormat(localeTag(locale), { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(clicks / views);
}

function nonNegativeMetric(value: MetricValue): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function formatAttentionShare(ads: EmployerInsights['ads'], totalViews: MetricValue, locale: Locale): string {
  const total = nonNegativeMetric(totalViews);
  const leadingViews = ads.reduce((max, ad) => Math.max(max, nonNegativeMetric(ad.views) ?? 0), 0);
  if (total == null || total <= 0 || leadingViews <= 0 || leadingViews > total) return '—';
  return new Intl.NumberFormat(localeTag(locale), { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(leadingViews / total);
}

function adsWithApplyClicks(ads: EmployerInsights['ads']): number | null {
  if (ads.length === 0) return null;
  return ads.filter((ad) => {
    const clicks = nonNegativeMetric(ad.applyClicks);
    return clicks != null && clicks > 0;
  }).length;
}

function formatAdsWithApplyClicks(ads: EmployerInsights['ads'], totalAds: MetricValue, locale: Locale): string {
  const withClicks = adsWithApplyClicks(ads);
  if (withClicks == null) return '—';
  const measured = nonNegativeMetric(totalAds);
  const nf = numberFormatter(locale);
  return measured != null && measured >= withClicks ? `${nf.format(withClicks)} / ${nf.format(measured)}` : nf.format(withClicks);
}

interface InsightRange {
  key: string;
  label: string;
  window: EmployerInsightsWindow | null | undefined;
  totals: EmployerInsights['totals'];
  trend: EmployerInsightsTrendPoint[];
  ads: EmployerInsights['ads'];
  coverage?: EmployerEventsCoverage;
  applicationsCoverage?: EmployerApplicationsCoverage;
}

function normalizedWindowKey(key: string): string {
  return key.trim().toLowerCase().replace(/^p/, '');
}

function buildRanges(data: EmployerInsights, locale: Locale): InsightRange[] {
  const copy = copyFor(locale);
  const ranges: InsightRange[] = [{ key: '30d', label: copy.period30, window: data.window, totals: data.totals, trend: data.trend || [], ads: data.ads || [], coverage: data.coverage, applicationsCoverage: data.applicationsCoverage }];
  for (const [key, summary] of Object.entries(data.additionalWindows || {})) {
    if (normalizedWindowKey(key) !== '90d') continue;
    ranges.push({ key: '90d', label: copy.period90, window: summary.window, totals: summary.totals, trend: summary.trend || [], ads: summary.ads || [], coverage: summary.coverage as EmployerEventsCoverage | undefined, applicationsCoverage: summary.applicationsCoverage });
  }
  return ranges;
}

export function EmployerInsightsReport({ data, locale: localeProp }: { data: EmployerInsights; locale?: Locale }): React.ReactElement {
  const { locale: currentLocale } = useTranslation();
  const locale = localeProp || currentLocale;
  const copy = copyFor(locale);
  const ranges = buildRanges(data, locale);
  const [selectedRangeKey, setSelectedRangeKey] = useState('30d');
  const activeRange = ranges.find((range) => range.key === selectedRangeKey) || ranges[0];
  const source = data.source;
  const sourceDisplay = humanizeInsightsSource(source, locale) || copy.sourceUnavailable;
  const eventDeduplication = activeRange.coverage?.deduplication;
  const applyMetric = employerMetricState(activeRange.totals.applyClicks, source, activeRange.window, eventDeduplication, locale);
  const viewMetric = employerMetricState(activeRange.totals.views, source, activeRange.window, eventDeduplication, locale);
  const profileMetric = employerMetricState(activeRange.totals.profileViews, source, activeRange.window, eventDeduplication, locale);
  const applicationSource = activeRange.applicationsCoverage?.source;
  const applicationMetric = metricState(activeRange.totals.applications, applicationSource, activeRange.window, [activeRange.applicationsCoverage?.status, activeRange.totals.applicationsStatus], locale);
  const applicationUnavailable = applicationMetric.state === 'source-unavailable';
  const trendUp = activeRange.trend.length >= 2 ? (activeRange.trend.at(-1)?.views || 0) >= (activeRange.trend[0]?.views || 0) : true;
  const periodLabel = windowLabel(activeRange.window, locale);
  const updatedLabel = generatedDate(data.generatedAt, locale);
  const profileDescription = profileMetric.state === 'zero-observed' ? copy.profileZero : profileMetric.state === 'data-missing' ? copy.profileMissing : profileMetric.state === 'source-unavailable' ? copy.profileUnavailable : copy.profileObserved;
  const profileDetail = profileMetric.state === 'observed' || profileMetric.state === 'observed-not-deduplicated' ? `${profileMetric.display} · ${profileDescription}` : profileDescription;
  const attentionShare = formatAttentionShare(activeRange.ads, activeRange.totals.views, locale);
  const adsWithClicks = formatAdsWithApplyClicks(activeRange.ads, activeRange.totals.adsCount, locale);
  const applicationDescription = applicationUnavailable
    ? copy.applicationsDescription
    : applicationMetric.state === 'zero-observed'
      ? copy.applicationsZero
      : applicationMetric.state === 'data-missing' || applicationMetric.state === 'source-unavailable'
        ? employerMetricStateLabel(applicationMetric.state, locale)
        : applicationMetric.state === 'coverage-partial'
          ? copy.partial
          : copy.applicationsObserved(applicationMetric.display);

  const handleRangeChange = (key: string) => {
    setSelectedRangeKey(key);
    Analytics.trackChartInteraction('employer_insights', `period_${key}`);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-12 px-4 py-8 sm:space-y-16 sm:py-12">
      <header>
        <div className="relative isolate overflow-hidden rounded-2xl bg-surface-inverted px-5 py-6 text-on-accent shadow-stripe-xl sm:px-8 sm:py-9">
          <span className="insights-hero-signal" aria-hidden="true" />
          <div className="relative z-10 flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex min-w-0 items-start gap-4 sm:gap-5">
              <CompanyLogo companyName={data.companyName} companyKey={data.companyKey} alt={copy.logoAlt(data.companyName)} />
              <div className="min-w-0">
                <h1 className="max-w-3xl font-display text-3xl font-semibold leading-tight tracking-[-0.025em] text-on-accent text-balance sm:text-5xl">{copy.title(data.companyName)}</h1>
                <p className="mt-3 max-w-2xl text-sm leading-relaxed text-on-accent/80 sm:text-base">{copy.intro}</p>
                <div className="mt-4 flex flex-wrap items-center gap-2 text-xs font-medium text-on-accent/75"><span className="inline-flex items-center gap-1.5 rounded-full bg-on-accent/10 px-2.5 py-1"><Sparkles className="h-3.5 w-3.5" aria-hidden="true" />{copy.reportLabel}</span><span className="inline-flex items-center gap-1.5 rounded-full bg-on-accent/10 px-2.5 py-1"><BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />{sourceDisplay}</span></div>
              </div>
            </div>
            <div className="shrink-0 rounded-xl bg-on-accent/10 px-4 py-3 text-sm lg:min-w-[190px]"><p className="text-xs font-semibold uppercase tracking-[0.08em] text-on-accent/65">{copy.periodLabel}</p><p className="mt-1 font-semibold text-on-accent">{periodLabel}</p><p className="mt-2 text-xs text-on-accent/65">{copy.updated(updatedLabel)}</p></div>
          </div>
          <div className="relative z-10 mt-8 grid gap-7 border-t border-on-accent/15 pt-7 sm:grid-cols-[minmax(0,1.35fr)_minmax(0,0.82fr)_minmax(0,0.82fr)] sm:gap-0">
            <div className="sm:pr-8">
              <p className="text-sm font-medium text-on-accent/75">{copy.applyClicks}</p>
              <p className="mt-1 font-display text-6xl font-semibold leading-none tracking-[-0.04em] tabular-nums text-on-accent sm:text-7xl">{applyMetric.display}</p>
              <p className="mt-3 max-w-md text-sm leading-relaxed text-on-accent/75">{copy.applyClicksDescription}</p>
              {applyMetric.state !== 'observed' && applyMetric.state !== 'observed-not-deduplicated' && <p className="mt-2 text-xs font-semibold uppercase tracking-[0.06em] text-on-accent/65">{employerMetricStateLabel(applyMetric.state, locale)}</p>}
            </div>
            <div className="flex min-h-[112px] flex-col justify-end border-t border-on-accent/15 pt-5 sm:border-l sm:border-t-0 sm:px-7 sm:pt-0">
              <p className="text-xs text-on-accent/60">{copy.interestRate}</p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-on-accent">{formatRate(activeRange.totals.applyClicks, activeRange.totals.views, locale)}</p>
              <p className="mt-2 text-xs leading-relaxed text-on-accent/60">{copy.interestRateDescription}</p>
            </div>
            <div className="flex min-h-[112px] flex-col justify-end border-t border-on-accent/15 pt-5 sm:border-l sm:border-t-0 sm:pl-7 sm:pt-0">
              <p className="text-xs text-on-accent/60">{copy.adViews}</p>
              <p className="mt-1 font-display text-2xl font-semibold tabular-nums text-on-accent">{viewMetric.display}</p>
              <p className="mt-2 text-xs leading-relaxed text-on-accent/60">{copy.adViewsDescription}</p>
            </div>
          </div>
        </div>
        <div data-period-selector className="mt-5 flex flex-col gap-4 rounded-2xl border border-edge bg-surface-raised p-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"><div className="flex items-center gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent-subtle text-accent"><CalendarDays className="h-5 w-5" aria-hidden="true" /></span><div><p className="text-sm font-semibold text-strong">{copy.periodLabel}</p><p className="text-xs text-muted" aria-live="polite">{periodLabel}</p></div></div><div className="grid w-full grid-cols-2 gap-2 sm:w-auto" role="group" aria-label={copy.periodLabel}>{ranges.map((range) => <button key={range.key} type="button" data-period={range.key} aria-pressed={range.key === activeRange.key} onClick={() => handleRangeChange(range.key)} className={`min-h-[44px] rounded-lg px-4 py-2 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${range.key === activeRange.key ? 'bg-accent text-on-accent shadow-stripe-sm' : 'bg-surface text-link hover:bg-accent-subtle'}`}>{range.label}</button>)}</div></div>
      </header>

      <RevealSection ariaLabelledby="insights-overview-heading"><h2 id="insights-overview-heading" className="mb-5 font-display text-xl font-semibold text-strong sm:text-2xl">{copy.overviewHeading}</h2><dl className="grid grid-cols-2 divide-x divide-y divide-edge overflow-hidden rounded-2xl border border-edge bg-surface-raised sm:grid-cols-4 sm:divide-y-0"><MetricTile icon={<MousePointerClick className="h-5 w-5" />} label={copy.interestRate} value={formatRate(activeRange.totals.applyClicks, activeRange.totals.views, locale)} description={copy.interestRateDescription} /><MetricTile icon={<Eye className="h-5 w-5" />} label={copy.adViews} value={viewMetric.display} description={copy.adViewsDescription} state={viewMetric.state === 'data-missing' || viewMetric.state === 'source-unavailable' ? employerMetricStateLabel(viewMetric.state, locale) : undefined} /><MetricTile icon={<BarChart3 className="h-5 w-5" />} label={copy.attentionShare} value={attentionShare} description={copy.attentionShareDescription} /><MetricTile icon={<Layers3 className="h-5 w-5" />} label={copy.adsWithClicks} value={adsWithClicks} description={copy.adsWithClicksDescription} /></dl></RevealSection>

      {activeRange.ads.length > 0 && <RevealSection ariaLabelledby="insights-topads-heading"><div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between"><div><h2 id="insights-topads-heading" className="font-display text-xl font-semibold text-strong sm:text-2xl">{copy.topAdsHeading}</h2><p className="mt-1 max-w-2xl text-sm text-subtle">{copy.topAdsDescription}</p></div><span className="shrink-0 text-xs font-medium text-muted">{periodLabel}</span></div><TopAdsChart ads={activeRange.ads} limit={10} locale={locale} /></RevealSection>}

      <RevealSection ariaLabelledby="insights-trend-heading" className="rounded-2xl border border-edge bg-surface-raised px-4 py-6 sm:px-7 sm:py-7"><div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between"><div className="flex items-start gap-3"><span className={trendUp ? 'mt-0.5 text-success' : 'mt-0.5 text-warning-strong'} aria-hidden="true">{trendUp ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}</span><div><h2 id="insights-trend-heading" className="font-display text-xl font-semibold text-strong sm:text-2xl">{copy.trendHeading}</h2><p className="mt-1 text-sm text-subtle">{trendUp ? copy.trendUp : copy.trendDown} {copy.trendDescription}</p></div></div><span className="shrink-0 text-xs font-medium text-muted">{periodLabel}</span></div><div className="mt-6"><InsightsTrendChart trend={activeRange.trend} locale={locale} /></div></RevealSection>

      <RevealSection ariaLabelledby="insights-quality-heading">
        <div className="mb-5">
          <h2 id="insights-quality-heading" className="font-display text-xl font-semibold text-strong sm:text-2xl">{copy.qualityHeading}</h2>
          <p className="mt-1 max-w-2xl text-sm text-subtle">{copy.qualityDescription}</p>
        </div>
        <article className="rounded-2xl border border-edge bg-surface-raised p-5 sm:p-7">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-2 rounded-full bg-accent-subtle px-3 py-1.5 text-xs font-semibold text-link"><BarChart3 className="h-3.5 w-3.5" aria-hidden="true" />{sourceDisplay}</span>
            <span className="inline-flex items-center gap-2 rounded-full bg-surface-alt px-3 py-1.5 text-xs font-medium text-subtle"><CalendarDays className="h-3.5 w-3.5" aria-hidden="true" />{periodLabel}</span>
          </div>
          <div className="mt-7 grid gap-6 border-t border-edge pt-6 sm:grid-cols-2 sm:gap-10">
            <div>
              <h3 className="font-semibold text-strong">{copy.measurementHeading}</h3>
              <p className="mt-2 text-sm leading-relaxed text-subtle">{copy.measurementDescription}</p>
            </div>
            <div>
              <h3 className="font-semibold text-strong">{copy.qualitySource}</h3>
              <p className="mt-2 text-sm leading-relaxed text-subtle">{copy.qualitySourceDescription}</p>
            </div>
          </div>
          <div className="mt-7 grid gap-4 border-t border-edge pt-5 sm:grid-cols-2 sm:gap-10">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">{copy.profileViews}</p>
              <p className="mt-1 text-sm leading-relaxed text-subtle">{profileDetail}</p>
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">{copy.applications}</p>
              <p className="mt-1 text-sm leading-relaxed text-subtle">{applicationDescription}</p>
            </div>
          </div>
        </article>
      </RevealSection>

      <RevealSection ariaLabelledby="insights-cta-heading" className="rounded-2xl bg-surface-inverted px-5 py-9 text-center text-on-accent sm:px-10 sm:py-12"><h2 id="insights-cta-heading" className="font-display text-2xl font-semibold text-on-accent text-balance sm:text-3xl">{copy.ctaHeading}</h2><p className="mx-auto mt-3 max-w-2xl text-sm leading-relaxed text-on-accent/80 sm:text-base">{copy.ctaDescription(data.companyName)}</p><a data-employer-cta="insights_claim" href={`${buildPath({ activeTab: 'publish' }, locale)}?claim=1&tier=azienda`} className="mt-7 inline-flex min-h-[48px] items-center justify-center gap-2 rounded-lg bg-accent px-7 py-3.5 text-base font-semibold text-on-accent no-underline transition-colors hover:bg-accent-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">{copy.claim}<ArrowRight className="h-5 w-5" aria-hidden="true" /></a></RevealSection>

      <div className="text-center print:hidden"><button type="button" onClick={() => { if (typeof window !== 'undefined') window.print(); }} className="inline-flex min-h-[44px] items-center justify-center rounded-lg border border-edge bg-surface-alt px-5 py-2.5 text-sm font-semibold text-body transition-colors hover:bg-surface-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-accent">{copy.savePdf}</button></div><p className="text-center text-xs text-muted">{copy.generated(data.companyName, updatedLabel)} · {copy.privatePage}</p>
    </div>
  );
}

function CenteredMessage({ title, body, homeHref = '/', homeLabel = 'Vai alla home', showHome = true }: { title: string; body: string; homeHref?: string; homeLabel?: string; showHome?: boolean }): React.ReactElement {
  return <div className="mx-auto max-w-md px-4 py-20 text-center"><h1 className="font-display text-2xl font-semibold text-strong">{title}</h1><p className="mt-3 text-base text-subtle text-pretty">{body}</p>{showHome && <a href={homeHref} className="mt-6 inline-flex min-h-[44px] items-center justify-center gap-2 rounded-lg border border-edge px-5 py-2.5 text-sm font-semibold text-link no-underline transition-colors hover:bg-surface-alt focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"><Home className="h-4 w-4" aria-hidden="true" />{homeLabel}</a>}</div>;
}

function LoadingSkeleton(): React.ReactElement {
  const { locale } = useTranslation();
  const copy = copyFor(locale);
  return <div className="mx-auto max-w-3xl px-4 py-16" aria-busy="true" aria-live="polite"><span className="sr-only">{copy.loading}</span><div className="flex justify-center" aria-hidden="true"><Loader2 className="h-7 w-7 animate-spin text-accent" /></div><div className="mt-8 space-y-5" aria-hidden="true"><div className="h-52 rounded-2xl bg-surface-alt animate-pulse" /><div className="h-28 rounded-2xl bg-surface-alt animate-pulse" /><div className="h-72 rounded-2xl bg-surface-alt animate-pulse" /></div></div>;
}

function companyKeyFromPath(): string {
  if (typeof window === 'undefined') return '';
  const segments = window.location.pathname.split('/').filter(Boolean);
  const index = segments.indexOf('azienda');
  return index >= 0 && segments[index + 1] ? decodeURIComponent(segments[index + 1]) : '';
}

function tokenFromQuery(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('t') ?? '';
}

function usePrivatePageHead(title: string): void {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = title;
    const meta = document.querySelector('meta[name="robots"]');
    const previousRobots = meta?.getAttribute('content') ?? null;
    let created = false;
    let element = meta as HTMLMetaElement | null;
    if (element) element.setAttribute('content', 'noindex, nofollow');
    else { element = document.createElement('meta'); element.setAttribute('name', 'robots'); element.setAttribute('content', 'noindex, nofollow'); document.head.appendChild(element); created = true; }
    return () => { document.title = previousTitle; if (created && element) element.remove(); else if (element && previousRobots != null) element.setAttribute('content', previousRobots); };
  }, [title]);
}

export interface EmployerInsightsPageProps { companyKey?: string; token?: string; }

export function EmployerInsightsPage({ companyKey: companyKeyProp, token: tokenProp }: EmployerInsightsPageProps = {}): React.ReactElement {
  const { locale } = useTranslation();
  const copy = copyFor(locale);
  const companyKey = companyKeyProp ?? companyKeyFromPath();
  const token = tokenProp ?? tokenFromQuery();
  const [result, setResult] = useState<FetchInsightsResult | null>(null);
  useEffect(() => {
    let cancelled = false;
    setResult(null);
    fetchInsights(companyKey, token).then((next) => { if (!cancelled) setResult(next); }).catch(() => { if (!cancelled) setResult({ status: 'error', reason: 'network' }); });
    return () => { cancelled = true; };
  }, [companyKey, token]);
  const companyName = result?.status === 'ok' ? result.data.companyName : locale === 'en' ? 'Your company' : locale === 'de' ? 'Ihr Unternehmen' : locale === 'fr' ? 'Votre entreprise' : 'La tua azienda';
  usePrivatePageHead(result?.status === 'ok' ? copy.title(companyName) : `${companyName} — Frontaliere Ticino`);
  const homeHref = locale === 'it' ? '/' : `/${locale}/`;
  if (result === null) return <LoadingSkeleton />;
  if (result.status === 'error') return <CenteredMessage title={copy.invalidTitle} body={copy.invalidBody} homeHref={homeHref} homeLabel={copy.home} />;
  if (result.status === 'not-found') return <CenteredMessage title={copy.preparingTitle} body={copy.preparingBody} homeHref={homeHref} homeLabel={copy.home} />;
  return <EmployerInsightsReport data={result.data} locale={locale} />;
}

export default EmployerInsightsPage;
