import React, { memo, useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from 'recharts';
import { Briefcase, Building2, Link2, Loader2, MapPin, RefreshCw, TrendingUp } from 'lucide-react';

import { Analytics } from '@/services/analytics';
import { fetchJobBoardStats, type JobBoardLeader, type JobBoardStatsData } from '@/services/jobBoardStatsService';
import type { Locale } from '@/services/i18n';
import { buildPath, pushRoute } from '@/services/router';

const COPY_BY_LOCALE: Record<Locale, {
  title: string;
  intro1: string;
  intro2Prefix: string;
  allJobs: string;
  companiesLabel: string;
  locationsLabel: string;
  todayLandingLabel: string;
  todayLandingEyebrow: string;
  observatoryLabel: string;
  observatoryEyebrow: string;
  updatedAt: string;
  activeJobs: string;
  addedToday: string;
  updatedToday: string;
  removedToday: string;
  activeCompanies: string;
  chartTitle: string;
  chartLine: string;
  chartAdded: string;
  chartUpdated: string;
  chartRemoved: string;
  activeCompaniesTitle: string;
  activeLocationsTitle: string;
  recentCompaniesTitle: string;
  recentTitlesTitle: string;
  empty: string;
  refresh: string;
}> = {
  it: {
    title: 'Osservatorio offerte lavoro in Ticino',
    intro1: 'Il nostro osservatorio del cerca lavoro in Ticino monitora ogni giorno quanti annunci restano attivi, quante offerte nuove entrano nel board, quanti annunci vengono aggiornati e quante posizioni vengono rimosse.',
    intro2Prefix: 'Per passare dai numeri agli annunci reali puoi aprire',
    allJobs: 'tutte le offerte di lavoro in Ticino',
    companiesLabel: 'pagine azienda',
    locationsLabel: 'ricerche per localita',
    todayLandingLabel: 'offerte di lavoro Ticino oggi',
    todayLandingEyebrow: 'landing editoriale',
    observatoryLabel: 'osservatorio stipendi e lavori in Ticino',
    observatoryEyebrow: 'nuova pagina dati',
    updatedAt: 'Aggiornato',
    activeJobs: 'Annunci attivi',
    addedToday: 'Nuovi oggi',
    updatedToday: 'Aggiornati oggi',
    removedToday: 'Rimossi oggi',
    activeCompanies: 'Aziende attive',
    chartTitle: 'Andamento giornaliero del nostro job board',
    chartLine: 'Annunci attivi',
    chartAdded: 'Aggiunti',
    chartUpdated: 'Aggiornati',
    chartRemoved: 'Rimossi',
    activeCompaniesTitle: 'Aziende con piu annunci attivi',
    activeLocationsTitle: 'Localita con piu annunci attivi',
    recentCompaniesTitle: 'Aziende che hanno aggiunto piu job negli ultimi 30 giorni',
    recentTitlesTitle: 'Ruoli piu pubblicati negli ultimi 30 giorni',
    empty: 'Nessuna statistica jobs disponibile al momento.',
    refresh: 'Aggiorna statistiche offerte',
  },
  en: {
    title: 'Ticino jobs observatory',
    intro1: 'Our Ticino job board observatory tracks active listings, new jobs, updates and removals day by day.',
    intro2Prefix: 'To move from stats to actual listings you can open',
    allJobs: 'all Ticino jobs',
    companiesLabel: 'company pages',
    locationsLabel: 'location searches',
    todayLandingLabel: 'Ticino jobs today',
    todayLandingEyebrow: 'editorial landing',
    observatoryLabel: 'Ticino jobs and salary observatory',
    observatoryEyebrow: 'data hub',
    updatedAt: 'Updated',
    activeJobs: 'Active listings',
    addedToday: 'Added today',
    updatedToday: 'Updated today',
    removedToday: 'Removed today',
    activeCompanies: 'Active companies',
    chartTitle: 'Daily trend of our job board',
    chartLine: 'Active listings',
    chartAdded: 'Added',
    chartUpdated: 'Updated',
    chartRemoved: 'Removed',
    activeCompaniesTitle: 'Companies with the most active jobs',
    activeLocationsTitle: 'Locations with the most active jobs',
    recentCompaniesTitle: 'Companies adding the most jobs in the last 30 days',
    recentTitlesTitle: 'Most posted roles in the last 30 days',
    empty: 'No job-board stats available right now.',
    refresh: 'Refresh job stats',
  },
  de: {
    title: 'Stellenobservatorium Tessin',
    intro1: 'Unser Stellenobservatorium fur das Tessin verfolgt aktive Inserate, neue Jobs, Aktualisierungen und Entfernungen pro Tag.',
    intro2Prefix: 'Wenn Sie von den Zahlen zu echten Inseraten wechseln wollen, offnen Sie',
    allJobs: 'alle Jobs im Tessin',
    companiesLabel: 'Unternehmensseiten',
    locationsLabel: 'Ortssuchen',
    todayLandingLabel: 'Jobs im Tessin heute',
    todayLandingEyebrow: 'redaktionelle landing page',
    observatoryLabel: 'Lohn- und Stellenobservatorium Tessin',
    observatoryEyebrow: 'Daten-Hub',
    updatedAt: 'Aktualisiert',
    activeJobs: 'Aktive Inserate',
    addedToday: 'Heute hinzugefugt',
    updatedToday: 'Heute aktualisiert',
    removedToday: 'Heute entfernt',
    activeCompanies: 'Aktive Unternehmen',
    chartTitle: 'Tagliche Entwicklung unseres Job Boards',
    chartLine: 'Aktive Inserate',
    chartAdded: 'Hinzugefugt',
    chartUpdated: 'Aktualisiert',
    chartRemoved: 'Entfernt',
    activeCompaniesTitle: 'Unternehmen mit den meisten aktiven Jobs',
    activeLocationsTitle: 'Orte mit den meisten aktiven Jobs',
    recentCompaniesTitle: 'Unternehmen mit den meisten neuen Jobs in den letzten 30 Tagen',
    recentTitlesTitle: 'Am haufigsten veroffentlichte Rollen in den letzten 30 Tagen',
    empty: 'Zurzeit sind keine Job-Statistiken verfugbar.',
    refresh: 'Job-Statistiken aktualisieren',
  },
  fr: {
    title: 'Observatoire des offres d emploi au Tessin',
    intro1: 'Notre observatoire des offres au Tessin suit les annonces actives, les nouvelles offres, les mises a jour et les suppressions jour apres jour.',
    intro2Prefix: 'Pour passer des chiffres aux annonces reelles, ouvrez',
    allJobs: 'toutes les offres au Tessin',
    companiesLabel: 'pages entreprise',
    locationsLabel: 'recherches par lieu',
    todayLandingLabel: "offres d'emploi au Tessin aujourd'hui",
    todayLandingEyebrow: 'landing editoriale',
    observatoryLabel: 'observatoire emplois et salaires au Tessin',
    observatoryEyebrow: 'hub data',
    updatedAt: 'Mis a jour',
    activeJobs: 'Annonces actives',
    addedToday: 'Ajoutees aujourd hui',
    updatedToday: 'Mises a jour aujourd hui',
    removedToday: 'Retirees aujourd hui',
    activeCompanies: 'Entreprises actives',
    chartTitle: 'Evolution quotidienne de notre job board',
    chartLine: 'Annonces actives',
    chartAdded: 'Ajoutees',
    chartUpdated: 'Mises a jour',
    chartRemoved: 'Retirees',
    activeCompaniesTitle: 'Entreprises avec le plus d annonces actives',
    activeLocationsTitle: 'Lieux avec le plus d annonces actives',
    recentCompaniesTitle: 'Entreprises ayant ajoute le plus d offres sur 30 jours',
    recentTitlesTitle: 'Postes les plus publies sur 30 jours',
    empty: 'Aucune statistique d offres disponible pour le moment.',
    refresh: 'Rafraichir les statistiques',
  },
};

const LOCALE_FORMAT_MAP: Record<Locale, string> = {
  it: 'it-CH',
  en: 'en-CH',
  de: 'de-CH',
  fr: 'fr-CH',
};

const COMPANY_PREFIX: Record<Locale, string> = { it: 'azienda', en: 'company', de: 'unternehmen', fr: 'entreprise' };
const SEARCH_PREFIX: Record<Locale, string> = { it: 'ricerca', en: 'search', de: 'suche', fr: 'recherche' };
const JOB_TODAY_SLUG: Record<Locale, string> = {
  it: 'offerte-di-lavoro-ticino-oggi',
  en: 'ticino-jobs-today',
  de: 'jobs-tessin-heute',
  fr: 'offres-emploi-tessin-aujourdhui',
};

function localizeLeaderSlug(url: string, locale: Locale): string {
  const slug = url.split('/').pop() || '';
  if (slug.startsWith('azienda-')) {
    return `${COMPANY_PREFIX[locale]}-${slug.slice('azienda-'.length)}`;
  }
  if (slug.startsWith('ricerca-')) {
    return `${SEARCH_PREFIX[locale]}-${slug.slice('ricerca-'.length)}`;
  }
  return slug;
}

function leaderHref(item: JobBoardLeader, locale: Locale): string {
  const jobSlug = localizeLeaderSlug(item.url, locale);
  return buildPath({ activeTab: 'job-board', jobSlug });
}

function jobTodayHref(locale: Locale): string {
  return buildPath({ activeTab: 'job-board', jobSlug: JOB_TODAY_SLUG[locale] }, locale);
}

function jobsObservatoryHref(locale: Locale): string {
  return buildPath({ activeTab: 'stats', statsSubTab: 'jobs-observatory' }, locale);
}

function navigateLeader(e: React.MouseEvent, item: JobBoardLeader, locale: Locale): void {
  e.preventDefault();
  const jobSlug = localizeLeaderSlug(item.url, locale);
  const route = { activeTab: 'job-board' as const, jobSlug };
  Analytics.trackSelectContent('stats_jobs_internal_link', buildPath(route));
  pushRoute(route);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

function renderLinkPills(items: JobBoardLeader[], tone: 'indigo' | 'emerald', locale: Locale): React.ReactNode {
  const toneClass =
    tone === 'emerald'
      ? 'border-emerald-200/80 bg-emerald-50 text-emerald-800 hover:border-success-border dark:bg-emerald-950/30 dark:text-emerald-200 dark:hover:border-emerald-700'
      : 'border-stripe-200/80 bg-stripe-50 text-stripe-800 hover:border-accent-border dark:bg-stripe-950/30 dark:text-stripe-200 dark:hover:border-stripe-700';

  return items.map((item) => (
    <a
      key={`${item.key}-${item.url}`}
      href={leaderHref(item, locale)}
      className={`inline-flex items-center rounded-full border px-3 py-1.5 text-xs font-semibold no-underline transition-colors ${toneClass}`}
      onClick={(e) => navigateLeader(e, item, locale)}
    >
      {item.name}
    </a>
  ));
}

function formatDate(isoString: string, locale: Locale): string {
  const value = String(isoString || '').trim();
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(LOCALE_FORMAT_MAP[locale], {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function KpiCard(props: { label: string; value: number; accent: string }) {
  return (
    <div className="inline-flex items-baseline gap-1">
      <span className="text-muted">{props.label}:</span>
      <span className="font-semibold text-heading">{props.value.toLocaleString('it-IT')}</span>
    </div>
  );
}

function LeaderList(props: { title: string; icon: React.ReactNode; items: JobBoardLeader[]; valueKey: 'count' | 'added'; emptyText: string; locale: Locale }) {
  return (
    <div className="bg-surface p-5 rounded-3xl border border-edge shadow-sm">
      <h3 className="text-sm font-bold text-body mb-4 flex items-center gap-2">
        {props.icon}
        {props.title}
      </h3>
      {props.items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-edge px-4 py-6 text-sm text-muted">
          {props.emptyText}
        </div>
      ) : (
        <div className="space-y-3">
          {props.items.map((item, index) => (
            <a
              key={`${item.key}-${item.url}`}
              href={leaderHref(item, props.locale)}
              className="flex items-center justify-between gap-3 rounded-2xl border border-edge px-3 py-2 no-underline hover:border-stripe-300 dark:hover:border-stripe-500 transition-colors"
              onClick={(e) => navigateLeader(e, item, props.locale)}
            >
              <div className="min-w-0">
                <div className="text-xs font-bold text-muted">#{index + 1}</div>
                <div className="text-sm font-semibold text-strong line-clamp-2">{item.name}</div>
              </div>
              <div className="shrink-0 text-sm font-bold text-accent">
                {Number(item[props.valueKey] || 0).toLocaleString('it-IT')}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

const JobBoardStatsOverviewInner: React.FC<{ locale: Locale }> = ({ locale }) => {
  const copy = COPY_BY_LOCALE[locale] || COPY_BY_LOCALE.it;
  const [data, setData] = useState<JobBoardStatsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));

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
    void load(false);
  }, []);

  useEffect(() => {
    const observer = new MutationObserver(() => setIsDark(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // All hooks MUST be called before any early return (React rules of hooks)
  const leaders = data?.leaders;
  const topCompaniesForSeo = useMemo(() => leaders?.topCompaniesActive.slice(0, 3) ?? [], [leaders?.topCompaniesActive]);
  const topLocationsForSeo = useMemo(() => leaders?.topLocationsActive.slice(0, 3) ?? [], [leaders?.topLocationsActive]);
  const topCompaniesRecent = useMemo(() => leaders?.topCompaniesAdded30d.slice(0, 8) ?? [], [leaders?.topCompaniesAdded30d]);
  const topTitlesRecent = useMemo(() => leaders?.topTitlesAdded30d.slice(0, 8) ?? [], [leaders?.topTitlesAdded30d]);
  const topLocationsActive = useMemo(() => leaders?.topLocationsActive.slice(0, 8) ?? [], [leaders?.topLocationsActive]);
  const topCompaniesActive = useMemo(() => leaders?.topCompaniesActive.slice(0, 8) ?? [], [leaders?.topCompaniesActive]);

  if (loading) {
    return (
      <div className="bg-surface p-6 rounded-3xl border border-edge shadow-sm flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-stripe-600" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="bg-surface p-6 rounded-3xl border border-edge shadow-sm text-sm text-subtle">
        {error || copy.empty}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-surface p-6 rounded-3xl border border-edge shadow-sm">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-4xl">
            <h3 className="text-lg font-bold text-heading flex items-center gap-2">
              <Briefcase className="w-5 h-5 text-stripe-600" />
              {copy.title}
            </h3>
            <p className="mt-3 text-sm leading-7 text-subtle">
              {copy.intro1}
            </p>

            <div className="mt-5 space-y-4">
              <div className="rounded-2xl border border-stripe-100 bg-stripe-50/60 p-4 dark:border-stripe-900/50 dark:bg-stripe-950/20">
                <div className="text-xs font-bold uppercase tracking-[0.16em] text-accent">
                  {copy.intro2Prefix}
                </div>
                <a
                  href={buildPath({ activeTab: 'job-board' })}
                  className="mt-2 inline-flex items-center text-sm font-bold text-accent no-underline hover:underline"
                  onClick={(e) => {
                    e.preventDefault();
                    const route = { activeTab: 'job-board' as const };
                    Analytics.trackSelectContent('stats_jobs_internal_link', buildPath(route));
                    pushRoute(route);
                    window.dispatchEvent(new PopStateEvent('popstate'));
                  }}
                >
                  {copy.allJobs}
                </a>
                <div className="mt-4 border-t border-stripe-200/70 pt-4 dark:border-stripe-800/60">
                  <div className="text-xs font-bold uppercase tracking-[0.16em] text-accent">
                    {copy.todayLandingEyebrow}
                  </div>
                  <a
                    href={jobTodayHref(locale)}
                    className="mt-2 inline-flex items-center text-sm font-bold text-accent no-underline hover:underline"
                    onClick={(e) => {
                      e.preventDefault();
                      const route = { activeTab: 'job-board' as const, jobSlug: JOB_TODAY_SLUG[locale] };
                      Analytics.trackSelectContent('stats_jobs_today_internal_link', buildPath(route, locale));
                      pushRoute(route);
                      window.dispatchEvent(new PopStateEvent('popstate'));
                    }}
                  >
                    {copy.todayLandingLabel}
                  </a>
                </div>

                <div className="mt-4 border-t border-stripe-200/70 pt-4 dark:border-stripe-800/60">
                  <div className="text-xs font-bold uppercase tracking-[0.16em] text-accent">
                    {copy.observatoryEyebrow}
                  </div>
                  <a
                    href={jobsObservatoryHref(locale)}
                    className="mt-2 inline-flex items-center text-sm font-bold text-accent no-underline hover:underline"
                    onClick={(e) => {
                      e.preventDefault();
                      const route = { activeTab: 'stats' as const, statsSubTab: 'jobs-observatory' as const };
                      Analytics.trackSelectContent('stats_jobs_observatory_internal_link', buildPath(route, locale));
                      pushRoute(route);
                      window.dispatchEvent(new PopStateEvent('popstate'));
                    }}
                  >
                    {copy.observatoryLabel}
                  </a>
                </div>
              </div>

              {(topCompaniesForSeo.length > 0 || topLocationsForSeo.length > 0) ? (
                <div className="grid gap-3 md:grid-cols-2">
                  {topCompaniesForSeo.length > 0 ? (
                    <div className="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-900/40">
                      <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted">
                        {copy.companiesLabel}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {renderLinkPills(topCompaniesForSeo, 'indigo', locale)}
                      </div>
                    </div>
                  ) : null}

                  {topLocationsForSeo.length > 0 ? (
                    <div className="rounded-2xl border border-slate-200/80 bg-slate-50/70 p-4 dark:border-slate-700 dark:bg-slate-900/40">
                      <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted">
                        {copy.locationsLabel}
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2">
                        {renderLinkPills(topLocationsForSeo, 'emerald', locale)}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>

          <div className="flex flex-col items-start gap-3 self-start rounded-2xl border border-slate-200/80 bg-slate-50/80 p-4 dark:border-slate-700 dark:bg-slate-900/40">
            <div className="text-xs font-bold uppercase tracking-[0.16em] text-muted">
              {copy.updatedAt}
            </div>
            <div className="text-sm font-semibold text-strong whitespace-nowrap">
              {formatDate(data.generatedAt, locale)}
            </div>
            <button
              type="button"
              onClick={() => {
                Analytics.trackUIInteraction('stats', 'jobs_overview', 'refresh', 'click');
                void load(true);
              }}
              disabled={refreshing}
              className="inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-edge text-xs font-bold text-body hover:border-stripe-300 dark:hover:border-stripe-500"
              title={copy.refresh}
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
              {copy.refresh}
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <KpiCard label={copy.activeJobs} value={data.totals.activeJobs} accent="" />
        <KpiCard label={copy.addedToday} value={data.totals.todayAdded} accent="" />
        <KpiCard label={copy.updatedToday} value={data.totals.todayUpdated} accent="" />
        <KpiCard label={copy.removedToday} value={data.totals.todayRemoved} accent="" />
        <KpiCard label={copy.activeCompanies} value={data.totals.activeCompanies} accent="" />
      </div>

      <div className="bg-surface p-5 rounded-3xl border border-edge shadow-sm">
        <h3 className="text-sm font-bold text-body mb-6 flex items-center gap-2">
          <TrendingUp size={16} className="text-stripe-600" />
          {copy.chartTitle}
        </h3>
        <div className="h-[320px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={data.history}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
              onClick={() => Analytics.trackChartInteraction('stats_jobs_daily_history', 'click')}
            >
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDark ? '#334155' : '#cbd5e1'} strokeOpacity={0.25} />
              <XAxis dataKey="date" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }} minTickGap={28} />
              <YAxis yAxisId="left" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }} width={48} />
              <YAxis yAxisId="right" orientation="right" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }} width={48} />
              <Tooltip contentStyle={{ borderRadius: '14px', border: 'none', boxShadow: '0 10px 30px rgba(15, 23, 42, 0.12)', backgroundColor: isDark ? '#1e293b' : '#fff', color: isDark ? '#e2e8f0' : '#1e293b' }} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: '11px', paddingTop: '10px' }} />
              <Bar yAxisId="left" dataKey="added" fill="#10b981" radius={[6, 6, 0, 0]} name={copy.chartAdded} />
              <Bar yAxisId="left" dataKey="updated" fill="#f59e0b" radius={[6, 6, 0, 0]} name={copy.chartUpdated} />
              <Bar yAxisId="left" dataKey="removed" fill="#ef4444" radius={[6, 6, 0, 0]} name={copy.chartRemoved} />
              <Line yAxisId="right" type="monotone" dataKey="totalJobs" stroke={isDark ? '#f59e0b' : '#78716c'} strokeWidth={3} dot={false} name={copy.chartLine} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <LeaderList title={copy.activeCompaniesTitle} icon={<Building2 size={16} className="text-stripe-600" />} items={topCompaniesActive} valueKey="count" emptyText={copy.empty} locale={locale} />
        <LeaderList title={copy.activeLocationsTitle} icon={<MapPin size={16} className="text-emerald-600" />} items={topLocationsActive} valueKey="count" emptyText={copy.empty} locale={locale} />
        <LeaderList title={copy.recentCompaniesTitle} icon={<Link2 size={16} className="text-stripe-600" />} items={topCompaniesRecent} valueKey="added" emptyText={copy.empty} locale={locale} />
        <LeaderList title={copy.recentTitlesTitle} icon={<Briefcase size={16} className="text-stripe-600" />} items={topTitlesRecent} valueKey="added" emptyText={copy.empty} locale={locale} />
      </div>
    </div>
  );
};

export const JobBoardStatsOverview = memo(JobBoardStatsOverviewInner);
export default JobBoardStatsOverview;
