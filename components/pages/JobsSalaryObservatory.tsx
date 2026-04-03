import React, { useEffect, useState } from 'react';
import { Briefcase, Building2, Loader2, MapPin, RefreshCw, Search, TrendingUp, Wallet } from 'lucide-react';

import { Analytics } from '@/services/analytics';
import { useTranslation, type Locale } from '@/services/i18n';
import {
  fetchJobBoardStats,
  type JobBoardLeader,
  type JobBoardSalaryLeader,
  type JobBoardStatsData,
} from '@/services/jobBoardStatsService';
import { buildPath, pushRoute } from '@/services/router';

const COPY: Record<Locale, {
  title: string;
  intro: string;
  methodology: string;
  updated: string;
  refresh: string;
  allJobs: string;
  salaryCompare: string;
  jobsToday: string;
  overview: string;
  kpiSalaryCoverage: string;
  kpiAverageMid: string;
  kpiMedianMid: string;
  kpiTrackedLocations: string;
  salaryCompanies: string;
  salaryLocations: string;
  salaryTitles: string;
  hottestTitles: string;
  hottestLocations: string;
  hiringCompanies: string;
  empty: string;
  noteTitle: string;
  noteBody: string;
  disclaimerTitle: string;
  disclaimer: string;
}> = {
  it: {
    title: 'Osservatorio stipendi e lavori piu richiesti in Ticino',
    intro: 'Questo osservatorio unisce i nostri dati giornalieri sul job board con i salary range presenti negli annunci: vedi dove si concentra la domanda, quali ruoli compaiono piu spesso e quali aziende pubblicano di piu.',
    methodology: 'Aggiornamento giornaliero dal board Frontaliere Ticino. I ruoli piu richiesti qui sotto derivano dalla presenza e dalla pubblicazione degli annunci, non da stime inventate.',
    updated: 'Aggiornato',
    refresh: 'Aggiorna osservatorio',
    allJobs: 'Tutte le offerte in Ticino',
    salaryCompare: 'Confronta stipendi',
    jobsToday: 'Offerte di lavoro Ticino oggi',
    overview: 'Panoramica statistiche',
    kpiSalaryCoverage: 'Annunci con stipendio',
    kpiAverageMid: 'Range medio osservato',
    kpiMedianMid: 'Mediana osservata',
    kpiTrackedLocations: 'Localita monitorate',
    salaryCompanies: 'Aziende con stipendio medio piu alto',
    salaryLocations: 'Localita con stipendio medio piu alto',
    salaryTitles: 'Ruoli con stipendio medio piu alto',
    hottestTitles: 'Ruoli piu pubblicati negli ultimi 30 giorni',
    hottestLocations: 'Localita piu attive negli ultimi 30 giorni',
    hiringCompanies: 'Aziende che assumono di piu nel periodo recente',
    empty: 'Osservatorio non disponibile in questo momento.',
    noteTitle: 'Come leggere questi dati',
    noteBody: 'Usa questa pagina per capire dove si muove il mercato: per entrare nel dettaglio apri le pagine azienda, le landing per localita e il confronto stipendi.',
    disclaimerTitle: 'Nota sugli stipendi',
    disclaimer: 'I valori degli stipendi riportati in questa pagina sono stime indicative, ricavate tramite euristiche applicate ai dati presenti negli annunci di lavoro. Sono da considerare esclusivamente a scopo informativo e orientativo e non costituiscono un riferimento contrattuale ne retributivo.',
  },
  en: {
    title: 'Ticino salary and job demand observatory',
    intro: 'This observatory combines our daily job-board data with salary ranges found in listings, so you can see where demand is building, which roles appear most often and which companies are hiring the most.',
    methodology: 'Updated daily from the Frontaliere Ticino board. The “most in-demand” roles below are based on observed listing volume and publishing activity.',
    updated: 'Updated',
    refresh: 'Refresh observatory',
    allJobs: 'All jobs in Ticino',
    salaryCompare: 'Compare salaries',
    jobsToday: 'Ticino jobs today',
    overview: 'Stats overview',
    kpiSalaryCoverage: 'Jobs with salary',
    kpiAverageMid: 'Observed average range',
    kpiMedianMid: 'Observed median',
    kpiTrackedLocations: 'Tracked locations',
    salaryCompanies: 'Companies with the highest average salary',
    salaryLocations: 'Locations with the highest average salary',
    salaryTitles: 'Roles with the highest average salary',
    hottestTitles: 'Most posted roles in the last 30 days',
    hottestLocations: 'Most active locations in the last 30 days',
    hiringCompanies: 'Companies hiring the most recently',
    empty: 'Observatory not available right now.',
    noteTitle: 'How to read this page',
    noteBody: 'Use this view to spot where the market is moving. Then open company pages, city landings and the salary comparison page for deeper analysis.',
    disclaimerTitle: 'Salary disclaimer',
    disclaimer: 'The salary figures shown on this page are indicative estimates derived from heuristics applied to job listing data. They are provided for informational and guidance purposes only and do not constitute contractual or compensation references.',
  },
  de: {
    title: 'Observatorium fur Löhne und gefragte Jobs im Tessin',
    intro: 'Dieses Observatorium verbindet unsere täglichen Job-Board-Daten mit den in Inseraten vorhandenen Lohnspannen. So sehen Sie, wo Nachfrage entsteht, welche Rollen am häufigsten erscheinen und welche Unternehmen am meisten einstellen.',
    methodology: 'Tägliches Update aus dem Frontaliere-Ticino-Board. Die hier gezeigten gefragten Rollen basieren auf beobachtetem Inserate- und Veröffentlichungsvolumen.',
    updated: 'Aktualisiert',
    refresh: 'Observatorium aktualisieren',
    allJobs: 'Alle Jobs im Tessin',
    salaryCompare: 'Gehälter vergleichen',
    jobsToday: 'Jobs im Tessin heute',
    overview: 'Statistik-Übersicht',
    kpiSalaryCoverage: 'Jobs mit Gehalt',
    kpiAverageMid: 'Beobachtete Durchschnittsspanne',
    kpiMedianMid: 'Beobachteter Median',
    kpiTrackedLocations: 'Erfasste Orte',
    salaryCompanies: 'Unternehmen mit dem höchsten Durchschnittsgehalt',
    salaryLocations: 'Orte mit dem höchsten Durchschnittsgehalt',
    salaryTitles: 'Rollen mit dem höchsten Durchschnittsgehalt',
    hottestTitles: 'Am häufigsten veröffentlichte Rollen in den letzten 30 Tagen',
    hottestLocations: 'Aktivste Orte in den letzten 30 Tagen',
    hiringCompanies: 'Unternehmen mit den meisten neuen Jobs',
    empty: 'Observatorium derzeit nicht verfügbar.',
    noteTitle: 'So lesen Sie diese Daten',
    noteBody: 'Mit dieser Seite erkennen Sie Marktbewegungen. Wechseln Sie dann zu Unternehmensseiten, Orts-Landings und zum Gehaltsvergleich für mehr Tiefe.',
    disclaimerTitle: 'Hinweis zu den Gehältern',
    disclaimer: 'Die auf dieser Seite angezeigten Gehaltswerte sind indikative Schätzungen, die mithilfe von Heuristiken aus den Daten der Stellenanzeigen abgeleitet wurden. Sie dienen ausschliesslich zu Informations- und Orientierungszwecken und stellen keine vertragliche oder vergütungsrelevante Referenz dar.',
  },
  fr: {
    title: 'Observatoire des salaires et des emplois les plus demandes au Tessin',
    intro: 'Cet observatoire combine nos donnees quotidiennes du job board avec les fourchettes salariales presentes dans les annonces. Vous voyez ainsi ou la demande se concentre, quels postes reviennent le plus et quelles entreprises recrutent le plus.',
    methodology: 'Mise a jour quotidienne a partir du job board Frontaliere Ticino. Les postes “les plus demandes” ci-dessous reposent sur le volume observe des annonces et des publications.',
    updated: 'Mis a jour',
    refresh: 'Rafraichir l observatoire',
    allJobs: 'Toutes les offres au Tessin',
    salaryCompare: 'Comparer les salaires',
    jobsToday: "Offres d'emploi au Tessin aujourd'hui",
    overview: 'Apercu des statistiques',
    kpiSalaryCoverage: 'Annonces avec salaire',
    kpiAverageMid: 'Fourchette moyenne observee',
    kpiMedianMid: 'Mediane observee',
    kpiTrackedLocations: 'Lieux suivis',
    salaryCompanies: 'Entreprises avec le salaire moyen le plus eleve',
    salaryLocations: 'Lieux avec le salaire moyen le plus eleve',
    salaryTitles: 'Postes avec le salaire moyen le plus eleve',
    hottestTitles: 'Postes les plus publies sur 30 jours',
    hottestLocations: 'Lieux les plus actifs sur 30 jours',
    hiringCompanies: 'Entreprises qui recrutent le plus recemment',
    empty: 'Observatoire indisponible pour le moment.',
    noteTitle: 'Comment lire ces donnees',
    noteBody: 'Utilisez cette page pour voir ou bouge le marche. Ouvrez ensuite les pages entreprise, les landing locales et la page de comparaison des salaires.',
    disclaimerTitle: 'Avertissement sur les salaires',
    disclaimer: 'Les valeurs salariales affichees sur cette page sont des estimations indicatives, obtenues par des heuristiques appliquees aux donnees des offres d\u2019emploi. Elles sont fournies a titre informatif et indicatif uniquement et ne constituent pas une reference contractuelle ou salariale.',
  },
};

const FORMAT_LOCALE: Record<Locale, string> = {
  it: 'it-CH',
  en: 'en-CH',
  de: 'de-CH',
  fr: 'fr-CH',
};

function formatCurrency(value: number, locale: Locale): string {
  return new Intl.NumberFormat(FORMAT_LOCALE[locale], {
    style: 'currency',
    currency: 'CHF',
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function formatDate(value: string, locale: Locale): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(FORMAT_LOCALE[locale], {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function localizeLeaderSlug(url: string, locale: Locale): string {
  const slug = url.split('/').pop() || '';
  const companyPrefix: Record<Locale, string> = { it: 'azienda', en: 'company', de: 'unternehmen', fr: 'entreprise' };
  const searchPrefix: Record<Locale, string> = { it: 'ricerca', en: 'search', de: 'suche', fr: 'recherche' };
  if (slug.startsWith('azienda-')) return `${companyPrefix[locale]}-${slug.slice('azienda-'.length)}`;
  if (slug.startsWith('ricerca-')) return `${searchPrefix[locale]}-${slug.slice('ricerca-'.length)}`;
  return slug;
}

function leaderHref(item: JobBoardLeader, locale: Locale): string {
  return buildPath({ activeTab: 'job-board', jobSlug: localizeLeaderSlug(item.url, locale) }, locale);
}

function navigateTo(route: Parameters<typeof buildPath>[0], locale?: Locale) {
  Analytics.trackSelectContent('jobs_salary_observatory_link', buildPath(route, locale));
  pushRoute(route);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function ActionLink(props: { label: string; route: Parameters<typeof buildPath>[0]; locale: Locale }) {
  return (
    <a
      href={buildPath(props.route, props.locale)}
      className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-bold text-indigo-700 no-underline hover:border-indigo-300 dark:border-indigo-900/60 dark:bg-indigo-950/30 dark:text-indigo-200 dark:hover:border-indigo-700"
      onClick={(event) => {
        event.preventDefault();
        navigateTo(props.route, props.locale);
      }}
    >
      {props.label}
    </a>
  );
}

function Kpi(props: { label: string; value: string; accent: string }) {
  return (
    <div className={`rounded-2xl border p-4 ${props.accent}`}>
      <div className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">{props.label}</div>
      <div className="mt-2 text-2xl font-bold text-slate-900 dark:text-white">{props.value}</div>
    </div>
  );
}

function LeaderBlock(props: {
  title: string;
  items: Array<JobBoardLeader | JobBoardSalaryLeader>;
  locale: Locale;
  valueRenderer: (item: JobBoardLeader | JobBoardSalaryLeader) => string;
  icon: React.ReactNode;
  empty: string;
}) {
  return (
    <div className="rounded-3xl border border-slate-100 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
      <h3 className="mb-4 flex items-center gap-2 text-sm font-bold text-slate-700 dark:text-slate-200">
        {props.icon}
        {props.title}
      </h3>
      {props.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-200 px-4 py-6 text-sm text-slate-500 dark:border-slate-700 dark:text-slate-400">
          {props.empty}
        </div>
      ) : (
        <div className="space-y-3">
          {props.items.map((item, index) => (
            <a
              key={`${item.key}-${item.url}`}
              href={leaderHref(item, props.locale)}
              className="flex items-center justify-between gap-3 rounded-2xl border border-slate-100 px-3 py-2 no-underline transition-colors hover:border-indigo-300 dark:border-slate-700 dark:hover:border-indigo-500"
              onClick={(event) => {
                event.preventDefault();
                navigateTo({ activeTab: 'job-board', jobSlug: localizeLeaderSlug(item.url, props.locale) }, props.locale);
              }}
            >
              <div className="min-w-0">
                <div className="text-xs font-bold text-slate-500 dark:text-slate-400">#{index + 1}</div>
                <div className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{item.name}</div>
              </div>
              <div className="shrink-0 text-right text-sm font-bold text-indigo-600 dark:text-indigo-300">
                {props.valueRenderer(item)}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

export const JobsSalaryObservatory: React.FC = () => {
  const { locale } = useTranslation();
  const copy = COPY[locale] || COPY.it;
  const [data, setData] = useState<JobBoardStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (forceRefresh = false) => {
    try {
      setError(null);
      if (forceRefresh) setRefreshing(true);
      else setLoading(true);
      const result = await fetchJobBoardStats(forceRefresh);
      setData(result);
    } catch (err: any) {
      setError(err?.message || copy.empty);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    Analytics.trackPageView(buildPath({ activeTab: 'stats', statsSubTab: 'jobs-observatory' }, locale), copy.title);
    void load(false);
  }, [locale, copy.title]);

  if (loading) {
    return (
      <div className="rounded-3xl border border-slate-100 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-indigo-600" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="rounded-3xl border border-slate-100 bg-white p-6 text-sm text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300">
        {error || copy.empty}
      </div>
    );
  }

  const salary = data.salary?.coverage;
  const salaryLeaders = data.salary?.leaders;

  return (
    <div className="space-y-6">
      <div className="rounded-3xl border border-slate-100 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-4xl">
            <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900 dark:text-white">
              <Wallet className="h-5 w-5 text-indigo-600" />
              {copy.title}
            </h2>
            <p className="mt-3 text-sm leading-7 text-slate-600 dark:text-slate-300">{copy.intro}</p>
            <p className="mt-3 text-sm leading-7 text-slate-500 dark:text-slate-400">{copy.methodology}</p>
            <div className="mt-5 flex flex-wrap gap-2">
              <ActionLink label={copy.allJobs} route={{ activeTab: 'job-board' }} locale={locale} />
              <ActionLink label={copy.jobsToday} route={{ activeTab: 'job-board', jobSlug: locale === 'it' ? 'offerte-di-lavoro-ticino-oggi' : locale === 'en' ? 'ticino-jobs-today' : locale === 'de' ? 'jobs-tessin-heute' : 'offres-emploi-tessin-aujourdhui' }} locale={locale} />
              <ActionLink label={copy.salaryCompare} route={{ activeTab: 'stats', statsSubTab: 'salary-compare' }} locale={locale} />
              <ActionLink label={copy.overview} route={{ activeTab: 'stats', statsSubTab: 'overview' }} locale={locale} />
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-900/40">
            <div className="text-xs font-bold uppercase tracking-[0.16em] text-slate-500 dark:text-slate-400">{copy.updated}</div>
            <div className="mt-2 text-sm font-semibold text-slate-800 dark:text-slate-100">{formatDate(data.generatedAt, locale)}</div>
            <button
              type="button"
              onClick={() => void load(true)}
              disabled={refreshing}
              className="mt-4 inline-flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700 hover:border-indigo-300 dark:border-slate-700 dark:text-slate-200 dark:hover:border-indigo-500"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
              {copy.refresh}
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label={copy.kpiSalaryCoverage} value={`${salary?.jobsWithSalary || 0} (${salary?.coveragePct || 0}%)`} accent="border-emerald-100 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/20" />
        <Kpi label={copy.kpiAverageMid} value={formatCurrency(salary?.avgMid || 0, locale)} accent="border-indigo-100 bg-indigo-50/60 dark:border-indigo-900/40 dark:bg-indigo-950/20" />
        <Kpi label={copy.kpiMedianMid} value={formatCurrency(salary?.medianMid || 0, locale)} accent="border-amber-100 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20" />
        <Kpi label={copy.kpiTrackedLocations} value={String(data.totals.activeLocations || 0)} accent="border-blue-100 bg-blue-50/60 dark:border-blue-900/40 dark:bg-blue-950/20" />
      </div>

      <div className="rounded-3xl border border-slate-100 bg-white p-5 shadow-sm dark:border-slate-700 dark:bg-slate-800">
        <h3 className="mb-3 text-sm font-bold text-slate-700 dark:text-slate-200">{copy.noteTitle}</h3>
        <p className="text-sm leading-7 text-slate-600 dark:text-slate-300">{copy.noteBody}</p>
      </div>

      <div className="rounded-3xl border border-amber-200/80 bg-amber-50/60 p-5 dark:border-amber-900/40 dark:bg-amber-950/20">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-bold text-amber-800 dark:text-amber-200">
          <Wallet className="h-4 w-4" />
          {copy.disclaimerTitle}
        </h3>
        <p className="text-sm leading-7 text-amber-700 dark:text-amber-300">{copy.disclaimer}</p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <LeaderBlock title={copy.salaryCompanies} items={salaryLeaders?.topSalaryCompanies || []} locale={locale} valueRenderer={(item) => formatCurrency(Number((item as JobBoardSalaryLeader).weightedSalary || (item as JobBoardSalaryLeader).avgMid || 0), locale)} icon={<Building2 size={16} className="text-indigo-600" />} empty={copy.empty} />
        <LeaderBlock title={copy.salaryLocations} items={salaryLeaders?.topSalaryLocations || []} locale={locale} valueRenderer={(item) => formatCurrency(Number((item as JobBoardSalaryLeader).weightedSalary || (item as JobBoardSalaryLeader).avgMid || 0), locale)} icon={<MapPin size={16} className="text-emerald-600" />} empty={copy.empty} />
        <LeaderBlock title={copy.salaryTitles} items={salaryLeaders?.topSalaryTitles || []} locale={locale} valueRenderer={(item) => formatCurrency(Number((item as JobBoardSalaryLeader).weightedSalary || (item as JobBoardSalaryLeader).avgMid || 0), locale)} icon={<Wallet size={16} className="text-amber-600" />} empty={copy.empty} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <LeaderBlock title={copy.hottestTitles} items={data.leaders.topTitlesAdded30d || []} locale={locale} valueRenderer={(item) => String(Number(item.added || 0))} icon={<Search size={16} className="text-violet-600" />} empty={copy.empty} />
        <LeaderBlock title={copy.hottestLocations} items={data.leaders.topLocationsAdded30d || []} locale={locale} valueRenderer={(item) => String(Number(item.added || 0))} icon={<MapPin size={16} className="text-blue-600" />} empty={copy.empty} />
        <LeaderBlock title={copy.hiringCompanies} items={data.leaders.topCompaniesAdded30d || []} locale={locale} valueRenderer={(item) => String(Number(item.added || 0))} icon={<Briefcase size={16} className="text-indigo-600" />} empty={copy.empty} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <LeaderBlock title={copy.salaryCompanies} items={data.leaders.topCompaniesActive || []} locale={locale} valueRenderer={(item) => String(Number(item.count || 0))} icon={<TrendingUp size={16} className="text-indigo-600" />} empty={copy.empty} />
        <LeaderBlock title={copy.salaryLocations} items={data.leaders.topLocationsActive || []} locale={locale} valueRenderer={(item) => String(Number(item.count || 0))} icon={<MapPin size={16} className="text-emerald-600" />} empty={copy.empty} />
      </div>
    </div>
  );
};

export default JobsSalaryObservatory;
