import React, { useEffect, useMemo, useState } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell
} from 'recharts';
import { TrendingUp, Info, ExternalLink, Loader2, BarChart3, Calendar } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { fetchSwitzerlandUnemploymentRate, type SwitzerlandUnemploymentRateData } from '@/services/unemploymentRateService';
import { Analytics } from '@/services/analytics';

const UnemploymentStats: React.FC = () => {
  const { t, locale } = useTranslation();
  const [data, setData] = useState<SwitzerlandUnemploymentRateData | null>(null);
  const [loading, setLoading] = useState(true);
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    Analytics.trackPageView('/statistiche/disoccupazione-svizzera', 'Disoccupazione Svizzera');
    Analytics.trackUIInteraction('stats', 'unemployment', 'unemployment_view', 'view');
    (async () => {
      setLoading(true);
      const result = await fetchSwitzerlandUnemploymentRate();
      setData(result);
      setLoading(false);
    })();
  }, []);

  useEffect(() => {
    const observer = new MutationObserver(() => setIsDark(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const localeLabels = useMemo(() => ({
    title: { it: 'Tasso di Disoccupazione Svizzera', en: 'Switzerland Unemployment Rate', de: 'Arbeitslosenquote Schweiz', fr: 'Taux de Chômage Suisse' }[locale] || 'Tasso di Disoccupazione Svizzera',
    subtitle: { it: 'Dati mensili SECO — ultimo decennio', en: 'Monthly SECO data — last decade', de: 'Monatliche SECO-Daten — letztes Jahrzehnt', fr: 'Données mensuelles SECO — dernière décennie' }[locale] || 'Dati mensili SECO — ultimo decennio',
    trendTitle: { it: 'Trend mensile disoccupazione (10 anni)', en: 'Monthly unemployment trend (10 years)', de: 'Monatlicher Arbeitslosentrend (10 Jahre)', fr: 'Tendance mensuelle du chômage (10 ans)' }[locale] || 'Trend mensile disoccupazione (10 anni)',
    yearlyTitle: { it: 'Media annuale', en: 'Yearly average', de: 'Jahresdurchschnitt', fr: 'Moyenne annuelle' }[locale] || 'Media annuale',
    rateLabel: { it: 'Tasso disoccupazione', en: 'Unemployment rate', de: 'Arbeitslosenquote', fr: 'Taux de chômage' }[locale] || 'Tasso disoccupazione',
    currentRate: { it: 'Tasso attuale', en: 'Current rate', de: 'Aktueller Satz', fr: 'Taux actuel' }[locale] || 'Tasso attuale',
    minimum: { it: 'Minimo storico', en: 'Historic low', de: 'Historisches Tief', fr: 'Minimum historique' }[locale] || 'Minimo storico',
    maximum: { it: 'Massimo storico', en: 'Historic high', de: 'Historisches Hoch', fr: 'Maximum historique' }[locale] || 'Massimo storico',
    average: { it: 'Media periodo', en: 'Period average', de: 'Periodendurchschnitt', fr: 'Moyenne période' }[locale] || 'Media periodo',
    period: { it: 'Periodo', en: 'Period', de: 'Zeitraum', fr: 'Période' }[locale] || 'Periodo',
    source: { it: 'Fonte: SECO — Segreteria di Stato dell\'economia', en: 'Source: SECO — State Secretariat for Economic Affairs', de: 'Quelle: SECO — Staatssekretariat für Wirtschaft', fr: 'Source : SECO — Secrétariat d\'État à l\'économie' }[locale] || 'Fonte: SECO — Segreteria di Stato dell\'economia',
    noData: { it: 'Dati non disponibili', en: 'Data not available', de: 'Daten nicht verfügbar', fr: 'Données non disponibles' }[locale] || 'Dati non disponibili',
    yoy: { it: 'vs anno prima', en: 'vs year ago', de: 'vs Vorjahr', fr: 'vs année précédente' }[locale] || 'vs anno prima',
    covidPeak: { it: 'Picco COVID-19', en: 'COVID-19 peak', de: 'COVID-19-Höhepunkt', fr: 'Pic COVID-19' }[locale] || 'Picco COVID-19',
    postCovidLow: { it: 'Minimo post-COVID', en: 'Post-COVID low', de: 'Post-COVID-Tief', fr: 'Minimum post-COVID' }[locale] || 'Minimo post-COVID',
  }), [locale]);

  const localeMap: Record<string, string> = { it: 'it-CH', en: 'en-CH', de: 'de-CH', fr: 'fr-CH' };

  // KPI calculations — must be before seoText which depends on kpis
  const kpis = useMemo(() => {
    if (!data?.history?.length) return null;
    const rates = data.history.map(h => h.rate);
    const min = Math.min(...rates);
    const max = Math.max(...rates);
    const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
    const minEntry = data.history.find(h => h.rate === min);
    const maxEntry = data.history.find(h => h.rate === max);

    // YoY comparison
    const currentRate = data.rate;
    const oneYearAgoMonth = data.history.find(h => {
      const [cy, cm] = data.period.split('-').map(Number);
      return h.period === `${cy - 1}-${String(cm).padStart(2, '0')}`;
    });
    const yoyChange = oneYearAgoMonth ? currentRate - oneYearAgoMonth.rate : null;

    return { min, max, avg, minEntry, maxEntry, yoyChange };
  }, [data]);

  // Dynamic SEO prose generated from live data
  const seoText = useMemo(() => {
    if (!data?.history?.length || !kpis) return '';
    const rates = data.history.map(h => h.rate);
    const minRate = kpis.min.toFixed(1);
    const maxRate = kpis.max.toFixed(1);
    const avgRate = kpis.avg.toFixed(1);
    const curRate = data.rate.toFixed(1);
    const [curYear, curMonth] = data.period.split('-').map(Number);
    const curDate = new Date(Date.UTC(curYear, curMonth - 1, 1));
    const fmt = (d: Date) => d.toLocaleDateString(localeMap[locale] || 'it-CH', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const curLabel = fmt(curDate);
    const minDate = kpis.minEntry ? (() => { const [y, m] = kpis.minEntry!.period.split('-').map(Number); return fmt(new Date(Date.UTC(y, m - 1, 1))); })() : '';
    const maxDate = kpis.maxEntry ? (() => { const [y, m] = kpis.maxEntry!.period.split('-').map(Number); return fmt(new Date(Date.UTC(y, m - 1, 1))); })() : '';
    const firstYear = data.history[0].period.split('-')[0];
    const lastYear = data.history[data.history.length - 1].period.split('-')[0];
    const yoyDelta = kpis.yoyChange != null ? kpis.yoyChange.toFixed(1) : null;
    const yoyDir = yoyDelta && Number(yoyDelta) > 0 ? 'up' : yoyDelta && Number(yoyDelta) < 0 ? 'down' : 'stable';

    // Yearly averages for narrative
    const grouped: Record<string, number[]> = {};
    for (const h of data.history) { const y = h.period.split('-')[0]; (grouped[y] ??= []).push(h.rate); }
    const yearlyAvgs = Object.entries(grouped).map(([y, r]) => ({ year: y, avg: Number((r.reduce((a, b) => a + b, 0) / r.length).toFixed(1)) })).sort((a, b) => a.year.localeCompare(b.year));
    const bestYear = yearlyAvgs.reduce((a, b) => (a.avg < b.avg ? a : b));
    const worstYear = yearlyAvgs.reduce((a, b) => (a.avg > b.avg ? a : b));
    const recentTrend = rates.slice(-6);
    const isRising = recentTrend.length >= 3 && recentTrend[recentTrend.length - 1] > recentTrend[0];

    if (locale === 'en') {
      return `As of ${curLabel}, the registered unemployment rate in Switzerland stands at ${curRate}%, according to the latest data published by SECO (State Secretariat for Economic Affairs). ` +
        (yoyDelta ? `Compared to the same month last year, the rate has ${yoyDir === 'up' ? `increased by ${yoyDelta} percentage points` : yoyDir === 'down' ? `decreased by ${Math.abs(Number(yoyDelta))} percentage points` : 'remained stable'}. ` : '') +
        `Over the ${firstYear}–${lastYear} observation period, the unemployment rate averaged ${avgRate}%, reaching a historic low of ${minRate}% in ${minDate} and a peak of ${maxRate}% in ${maxDate}. ` +
        `The best annual average was recorded in ${bestYear.year} at ${bestYear.avg}%, while the highest annual average was ${worstYear.avg}% in ${worstYear.year}, largely attributable to the impact of the COVID-19 pandemic on the labour market. ` +
        `${isRising ? 'The recent trend shows a slight upward tendency over the last six months, reflecting global economic uncertainty and structural shifts in the Swiss job market.' : 'The recent trend remains relatively stable, reflecting the resilience of the Swiss labour market despite the challenging global economic environment.'} ` +
        `Switzerland maintains one of Europe's lowest unemployment rates thanks to its dual vocational training system, a diversified economy, and flexible labour market policies. ` +
        `For cross-border workers (frontaliers) commuting from Italy to Ticino, these figures are particularly relevant: a stronger Swiss job market translates to better employment prospects and negotiating power. ` +
        `This data is automatically updated each month when SECO publishes its official labour market statistics.`;
    }
    if (locale === 'de') {
      return `Per ${curLabel} liegt die registrierte Arbeitslosenquote in der Schweiz bei ${curRate}%, gemäss den neuesten Daten des SECO (Staatssekretariat für Wirtschaft). ` +
        (yoyDelta ? `Im Vergleich zum gleichen Monat des Vorjahres ist die Quote ${yoyDir === 'up' ? `um ${yoyDelta} Prozentpunkte gestiegen` : yoyDir === 'down' ? `um ${Math.abs(Number(yoyDelta))} Prozentpunkte gesunken` : 'stabil geblieben'}. ` : '') +
        `Im Beobachtungszeitraum ${firstYear}–${lastYear} betrug die durchschnittliche Arbeitslosenquote ${avgRate}%, mit einem historischen Tiefststand von ${minRate}% im ${minDate} und einem Höchststand von ${maxRate}% im ${maxDate}. ` +
        `Der beste Jahresdurchschnitt wurde ${bestYear.year} mit ${bestYear.avg}% verzeichnet, während der höchste Jahresdurchschnitt bei ${worstYear.avg}% im Jahr ${worstYear.year} lag, was weitgehend auf die Auswirkungen der COVID-19-Pandemie auf den Arbeitsmarkt zurückzuführen ist. ` +
        `${isRising ? 'Der jüngste Trend zeigt in den letzten sechs Monaten eine leichte Aufwärtstendenz, die die globale wirtschaftliche Unsicherheit und strukturelle Veränderungen auf dem Schweizer Arbeitsmarkt widerspiegelt.' : 'Der jüngste Trend bleibt relativ stabil und spiegelt die Widerstandsfähigkeit des Schweizer Arbeitsmarktes trotz des herausfordernden globalen Umfelds wider.'} ` +
        `Die Schweiz weist dank ihres dualen Berufsbildungssystems, einer diversifizierten Wirtschaft und flexibler Arbeitsmarktpolitik eine der niedrigsten Arbeitslosenquoten Europas auf. ` +
        `Für Grenzgänger, die aus Italien ins Tessin pendeln, sind diese Zahlen besonders relevant: Ein stärkerer Schweizer Arbeitsmarkt bedeutet bessere Beschäftigungsaussichten und Verhandlungsposition. ` +
        `Diese Daten werden automatisch aktualisiert, sobald das SECO seine monatliche Arbeitsmarktstatistik veröffentlicht.`;
    }
    if (locale === 'fr') {
      return `En ${curLabel}, le taux de chômage enregistré en Suisse s'établit à ${curRate}%, selon les dernières données publiées par le SECO (Secrétariat d'État à l'économie). ` +
        (yoyDelta ? `Par rapport au même mois de l'année précédente, le taux a ${yoyDir === 'up' ? `augmenté de ${yoyDelta} point${Number(yoyDelta) > 1 ? 's' : ''} de pourcentage` : yoyDir === 'down' ? `diminué de ${Math.abs(Number(yoyDelta))} point${Math.abs(Number(yoyDelta)) > 1 ? 's' : ''} de pourcentage` : 'resté stable'}. ` : '') +
        `Sur la période d'observation ${firstYear}–${lastYear}, le taux de chômage moyen s'est établi à ${avgRate}%, atteignant un minimum historique de ${minRate}% en ${minDate} et un pic de ${maxRate}% en ${maxDate}. ` +
        `La meilleure moyenne annuelle a été enregistrée en ${bestYear.year} à ${bestYear.avg}%, tandis que la moyenne annuelle la plus élevée était de ${worstYear.avg}% en ${worstYear.year}, en grande partie attribuable à l'impact de la pandémie de COVID-19 sur le marché du travail. ` +
        `${isRising ? 'La tendance récente montre une légère hausse sur les six derniers mois, reflétant l\'incertitude économique mondiale et les mutations structurelles du marché suisse de l\'emploi.' : 'La tendance récente reste relativement stable, témoignant de la résilience du marché du travail suisse malgré un contexte économique mondial difficile.'} ` +
        `La Suisse maintient l'un des taux de chômage les plus bas d'Europe grâce à son système de formation professionnelle duale, une économie diversifiée et des politiques du marché du travail flexibles. ` +
        `Pour les travailleurs frontaliers faisant la navette entre l'Italie et le Tessin, ces chiffres sont particulièrement pertinents : un marché du travail suisse plus solide signifie de meilleures perspectives d'emploi et un pouvoir de négociation accru. ` +
        `Ces données sont automatiquement mises à jour chaque mois lors de la publication des statistiques officielles du SECO.`;
    }
    // Italian (default)
    return `A ${curLabel}, il tasso di disoccupazione registrata in Svizzera si attesta al ${curRate}%, secondo gli ultimi dati pubblicati dalla SECO (Segreteria di Stato dell'economia). ` +
      (yoyDelta ? `Rispetto allo stesso mese dell'anno precedente, il tasso è ${yoyDir === 'up' ? `aumentato di ${yoyDelta} punti percentuali` : yoyDir === 'down' ? `diminuito di ${Math.abs(Number(yoyDelta))} punti percentuali` : 'rimasto stabile'}. ` : '') +
      `Nel periodo di osservazione ${firstYear}–${lastYear}, il tasso di disoccupazione medio è stato del ${avgRate}%, raggiungendo un minimo storico del ${minRate}% a ${minDate} e un picco del ${maxRate}% a ${maxDate}. ` +
      `La migliore media annuale è stata registrata nel ${bestYear.year} con il ${bestYear.avg}%, mentre la media annuale più alta è stata del ${worstYear.avg}% nel ${worstYear.year}, in gran parte attribuibile all'impatto della pandemia COVID-19 sul mercato del lavoro. ` +
      `${isRising ? 'L\'andamento recente mostra una leggera tendenza al rialzo negli ultimi sei mesi, riflettendo l\'incertezza economica globale e i cambiamenti strutturali nel mercato del lavoro svizzero.' : 'L\'andamento recente rimane relativamente stabile, a testimonianza della resilienza del mercato del lavoro svizzero nonostante il difficile contesto economico globale.'} ` +
      `La Svizzera mantiene uno dei tassi di disoccupazione più bassi d'Europa grazie al sistema duale di formazione professionale, a un'economia diversificata e a politiche del mercato del lavoro flessibili. ` +
      `Per i lavoratori frontalieri che fanno il pendolare dall'Italia al Ticino, questi dati sono particolarmente rilevanti: un mercato del lavoro svizzero più forte si traduce in migliori prospettive occupazionali e maggiore potere contrattuale nella negoziazione salariale. ` +
      `Questi dati vengono aggiornati automaticamente ogni mese alla pubblicazione delle statistiche ufficiali della SECO sul mercato del lavoro.`;
  }, [data, kpis, locale]);

  // Full history for 10-year LineChart
  const trendData = useMemo(() => {
    if (!data?.history?.length) return [];
    return data.history.map((p) => {
      const [year, month] = String(p.period).split('-').map(Number);
      const dt = (year && month) ? new Date(Date.UTC(year, month - 1, 1)) : null;
      return {
        period: p.period,
        rate: Number(Number(p.rate).toFixed(1)),
        label: dt
          ? dt.toLocaleDateString(localeMap[locale] || 'it-CH', { month: 'short', year: '2-digit', timeZone: 'UTC' })
          : p.period,
      };
    });
  }, [data, locale]);

  // Yearly averages for BarChart
  const yearlyData = useMemo(() => {
    if (!data?.history?.length) return [];
    const grouped: Record<string, number[]> = {};
    for (const h of data.history) {
      const year = h.period.split('-')[0];
      if (!grouped[year]) grouped[year] = [];
      grouped[year].push(h.rate);
    }
    return Object.entries(grouped)
      .map(([year, rates]) => ({
        year,
        avg: Number((rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(2)),
      }))
      .sort((a, b) => a.year.localeCompare(b.year));
  }, [data]);

  const currentPeriodLabel = (() => {
    if (!data?.period) return '';
    const [year, month] = data.period.split('-').map(Number);
    if (!year || !month) return data.period;
    const d = new Date(Date.UTC(year, month - 1, 1));
    return d.toLocaleDateString(localeMap[locale] || 'it-CH', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  })();

  if (loading) {
    return (
      <div className="bg-surface rounded-2xl shadow-sm border border-edge flex items-center justify-center py-32">
        <Loader2 className="animate-spin h-10 w-10 text-amber-500" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="bg-surface rounded-2xl shadow-sm border border-edge flex flex-col items-center justify-center py-32 space-y-3">
        <BarChart3 size={40} className="text-muted" />
        <p className="text-muted text-sm">{localeLabels.noData}</p>
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-2xl shadow-sm border border-edge flex flex-col h-full animate-fade-in-up transition-colors duration-300 pb-8">
      {/* Header */}
      <div className="p-6 border-b border-slate-100 dark:border-slate-800 sticky top-0 z-10 bg-surface rounded-t-2xl">
        <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100 tracking-tight flex items-center gap-2">
          <BarChart3 size={20} className="text-amber-500" /> {localeLabels.title}
        </h2>
        <p className="text-muted text-xs mt-1">
          {localeLabels.subtitle}
        </p>
      </div>

      <div className="p-6 space-y-8">

        {/* KPI Row */}
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm">
          {/* Current Rate */}
          <div className="flex items-baseline gap-1">
            <span className="text-muted">{localeLabels.currentRate}:</span>{' '}
            <span className="font-semibold text-amber-700 dark:text-amber-400">{data.rate.toFixed(1)}%</span>
            {kpis?.yoyChange != null && (
              <span className={`text-xs font-semibold ${kpis.yoyChange > 0 ? 'text-red-600 dark:text-red-400' : kpis.yoyChange < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted'}`}>
                ({kpis.yoyChange > 0 ? '+' : ''}{kpis.yoyChange.toFixed(1)}pp {localeLabels.yoy})
              </span>
            )}
            <span className="text-sm text-muted capitalize">{currentPeriodLabel}</span>
          </div>

          {/* Historic Low */}
          <div>
            <span className="text-muted">{localeLabels.minimum}:</span>{' '}
            <span className="font-semibold text-emerald-600 dark:text-emerald-400">{kpis?.min.toFixed(1)}%</span>
            {kpis?.minEntry && (
              <span className="text-sm text-muted ml-1 capitalize">
                {(() => {
                  const [y, m] = kpis.minEntry.period.split('-').map(Number);
                  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(localeMap[locale] || 'it-CH', { month: 'short', year: 'numeric', timeZone: 'UTC' });
                })()}
              </span>
            )}
          </div>

          {/* Historic High */}
          <div>
            <span className="text-muted">{localeLabels.maximum}:</span>{' '}
            <span className="font-semibold text-red-600 dark:text-red-400">{kpis?.max.toFixed(1)}%</span>
            {kpis?.maxEntry && (
              <span className="text-sm text-muted ml-1 capitalize">
                {(() => {
                  const [y, m] = kpis.maxEntry.period.split('-').map(Number);
                  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(localeMap[locale] || 'it-CH', { month: 'short', year: 'numeric', timeZone: 'UTC' });
                })()}
              </span>
            )}
          </div>

          {/* Period Average */}
          <div>
            <span className="text-muted">{localeLabels.average}:</span>{' '}
            <span className="font-semibold text-slate-900 dark:text-white">{kpis?.avg.toFixed(1)}%</span>{' '}
            <span className="text-sm text-muted">2016 – 2026</span>
          </div>
        </div>

        {/* 10-year Trend Chart */}
        <div className="bg-surface p-5 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm">
          <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-6 flex items-center gap-2">
            <TrendingUp size={16} className="text-amber-500" /> {localeLabels.trendTitle}
          </h3>
          <div className="h-[320px] w-full">
            {trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={trendData}
                  margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                  onClick={() => Analytics.trackChartInteraction('unemployment_10y_trend', 'click')}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDark ? '#334155' : '#e2e8f0'} strokeOpacity={0.3} />
                  <XAxis
                    dataKey="label"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 10, fill: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}
                    dy={8}
                    minTickGap={50}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}
                    domain={['dataMin - 0.3', 'dataMax + 0.3']}
                    width={52}
                    tickFormatter={(val) => `${Number(val).toFixed(1)}%`}
                  />
                  <Tooltip
                    contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)', backgroundColor: isDark ? '#1e293b' : '#fff', color: isDark ? '#e2e8f0' : '#1e293b' }}
                    labelFormatter={(_label, payload) => {
                      const p = payload?.[0]?.payload?.period;
                      return p || _label;
                    }}
                    formatter={(value: any) => [`${Number(value).toFixed(1)}%`, localeLabels.rateLabel]}
                  />
                  <Line type="monotone" dataKey="rate" stroke="#f59e0b" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted text-xs italic">
                {localeLabels.noData}
              </div>
            )}
          </div>
        </div>

        {/* Yearly Average BarChart */}
        {yearlyData.length > 1 && (
          <div className="bg-surface p-5 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm">
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-6 flex items-center gap-2">
              <Calendar size={16} className="text-amber-500" /> {localeLabels.yearlyTitle}
            </h3>
            <div className="h-[260px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={yearlyData}
                  margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                  barSize={32}
                  onClick={() => Analytics.trackChartInteraction('unemployment_yearly_avg', 'click')}
                >
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDark ? '#334155' : '#e2e8f0'} strokeOpacity={0.3} />
                  <XAxis
                    dataKey="year"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}
                    dy={8}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}
                    domain={[0, 'dataMax + 0.5']}
                    width={52}
                    tickFormatter={(val) => `${Number(val).toFixed(1)}%`}
                  />
                  <Tooltip
                    contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)', backgroundColor: isDark ? '#1e293b' : '#fff', color: isDark ? '#e2e8f0' : '#1e293b' }}
                    formatter={(value: any) => [`${Number(value).toFixed(2)}%`, localeLabels.rateLabel]}
                  />
                  <Bar dataKey="avg" radius={[6, 6, 0, 0]} name={localeLabels.rateLabel}>
                    {yearlyData.map((entry, index) => (
                      <Cell
                        key={`cell-${index}`}
                        fill={entry.avg >= 3.0 ? '#ef4444' : entry.avg >= 2.5 ? '#f59e0b' : '#10b981'}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      {/* SEO Prose — dynamic data-driven text */}
      {seoText && (
        <div className="px-6 mt-2">
          <article className="bg-slate-50/80 dark:bg-slate-800/40 p-5 rounded-2xl border border-slate-100 dark:border-slate-700">
            <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-2">
              <TrendingUp size={14} className="text-amber-500" />
              {{ it: 'Analisi del mercato del lavoro svizzero', en: 'Swiss labour market analysis', de: 'Analyse des Schweizer Arbeitsmarktes', fr: 'Analyse du marché du travail suisse' }[locale] || 'Analisi del mercato del lavoro svizzero'}
            </h3>
            <p className="text-xs text-subtle leading-relaxed">{seoText}</p>
          </article>
        </div>
      )}

      {/* Footer Info */}
      <div className="px-6">
        <div className="bg-surface-alt/50 p-4 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4 border border-slate-100 dark:border-slate-700">
          <div className="flex items-center gap-3">
            <div className="bg-white dark:bg-slate-700 p-2 rounded-xl text-amber-600 shadow-sm hidden sm:block">
              <Info size={20} />
            </div>
            <p className="text-xs text-muted leading-relaxed text-center sm:text-left">
              {localeLabels.source}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {data.sourceUrl && (
              <a
                href={data.releaseUrl || data.sourceUrl}
                target="_blank"
                rel="noreferrer"
                onClick={() => Analytics.trackExternalLink(data.releaseUrl || data.sourceUrl, 'unemployment_source_seco')}
                className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-700 hover:bg-amber-50 dark:hover:bg-amber-900/30 text-amber-700 dark:text-amber-300 text-xs font-bold rounded-xl transition-colors border border-edge shadow-sm"
              >
                {t('stats.sourceSECO')} <ExternalLink size={12} />
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default UnemploymentStats;
