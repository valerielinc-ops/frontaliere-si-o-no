import React, { useEffect, useMemo, useState } from 'react';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
  Legend, Cell, BarChart, Bar, LineChart, Line
} from 'recharts';
import { TrendingUp, Info, ExternalLink, Loader2, Database, PersonStanding, RefreshCw, BarChart2, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { fetchStats, SOURCE_LINK, type TrendPoint, type AgePoint, type GenderTrendPoint, type GenderSnapshot, type StatsSource } from '@/services/statsService';
import { Analytics } from '@/services/analytics';
import JobBoardStatsOverview from './JobBoardStatsOverview';

// StatsSubTab is defined in services/router.ts — use that as the canonical source

export const StatsView: React.FC = () => {
  const { t, locale } = useTranslation();
  const [historicalData, setHistoricalData] = useState<TrendPoint[]>([]);
  const [ageData, setAgeData] = useState<AgePoint[]>([]);
  const [genderTrendData, setGenderTrendData] = useState<GenderTrendPoint[]>([]);
  const [genderData, setGenderData] = useState<GenderSnapshot[]>([]);

  const [loading, setLoading] = useState(true);
  const [usingRealData, setUsingRealData] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [showBfsIntro, setShowBfsIntro] = useState(false);
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));

  useEffect(() => {
    const observer = new MutationObserver(() => setIsDark(document.documentElement.classList.contains('dark')));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const fetchBFSData = async (forceRefresh = false) => {
    try {
      setLoading(true);
      setApiError(null);
      
      const result = await fetchStats(forceRefresh);

      if (result.data) {
        setHistoricalData(result.data.trend);
        setAgeData(result.data.ages);
        setGenderTrendData(result.data.genderTrend);
        setGenderData(result.data.genderSnapshot);
        setUsingRealData(true);
        setLastUpdated(new Date(result.data.lastUpdated));
        console.log(`📊 BFS Data loaded from ${result.source}`);
      } else {
        throw new Error(result.error || 'Errore scaricamento dati BFS');
      }
    } catch (error: any) {
      console.error("BFS Fetch Error:", error);
      setApiError(error.message || "Errore scaricamento dati BFS");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    Analytics.trackPageView('/statistiche', 'Statistiche frontalieri');
    Analytics.trackUIInteraction('stats', 'dashboard', 'stats_view', 'view');
    fetchBFSData(false);
  }, []);

  // --- KPI CALCULATIONS ---
  const { latestValue, prevValue, qoqPercent, malePercent } = useMemo(() => {
    const latest = historicalData.length > 0 ? historicalData[historicalData.length - 1].frontalieri : 0;
    const prev = historicalData.length > 1 ? historicalData[historicalData.length - 2].frontalieri : 0;
    const qoq = prev > 0 ? (((latest - prev) / prev) * 100).toFixed(1) : "0.0";
    const male = genderData.find(g => g.name === 'Uomini')?.pct || "0";
    return { latestValue: latest, prevValue: prev, qoqPercent: qoq, malePercent: male };
  }, [historicalData, genderData]);

  return (
    <div className="bg-white dark:bg-slate-800 rounded-2xl shadow-sm border border-slate-200 dark:border-slate-700 flex flex-col h-full animate-fade-in-up transition-colors duration-300 pb-8">
       {/* Header */}
       <div className="p-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center sticky top-0 z-10 bg-white dark:bg-slate-800 rounded-t-2xl">
          <div>
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100 tracking-tight flex items-center gap-2">
              <Database size={20} className="text-indigo-600"/> {t('stats.title')}
            </h2>
            <p className="text-slate-500 dark:text-slate-400 text-xs mt-1">
              {t('stats.source')}
            </p>
          </div>
          
          {usingRealData && (
            <button 
                onClick={() => {
                  Analytics.trackUIInteraction('stats', 'header', 'refresh_data', 'click');
                  fetchBFSData(true);
                }}
                disabled={loading}
                className="p-2 bg-white dark:bg-slate-800 rounded-xl shadow-sm border border-slate-100 dark:border-slate-700 text-slate-500 hover:text-indigo-600 transition-all hover:rotate-180 disabled:opacity-50"
                title={t('stats.refreshData')}
            >
                <RefreshCw size={18} className={loading ? "animate-spin" : ""} />
            </button>
          )}
      </div>

      <div className="p-3 sm:p-6 space-y-6 sm:space-y-8">
        {/* BFS SEO intro — always visible on desktop, collapsible on mobile */}
        <div className="hidden sm:block">
          <div className="bg-indigo-50/40 dark:bg-indigo-900/20 p-5 rounded-2xl border border-indigo-100 dark:border-indigo-800">
            <h3 className="text-sm font-bold text-indigo-700 dark:text-indigo-300 mb-2 flex items-center gap-2">
              <Database size={16} className="text-indigo-600 dark:text-indigo-400" /> {t('stats.bfsSectionTitle')}
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">{t('stats.bfsIntro')}</p>
          </div>
        </div>
        <div className="sm:hidden">
          <button
            onClick={() => setShowBfsIntro(!showBfsIntro)}
            className="w-full flex items-center justify-between bg-indigo-50/40 dark:bg-indigo-900/20 px-4 py-3 rounded-2xl border border-indigo-100 dark:border-indigo-800 text-left"
          >
            <span className="text-sm font-bold text-indigo-700 dark:text-indigo-300 flex items-center gap-2">
              <Database size={16} className="text-indigo-600 dark:text-indigo-400" /> {t('stats.bfsSectionTitle')}
            </span>
            {showBfsIntro ? <ChevronUp size={16} className="text-indigo-500" /> : <ChevronDown size={16} className="text-indigo-500" />}
          </button>
          {showBfsIntro && (
            <div className="bg-indigo-50/40 dark:bg-indigo-900/20 px-4 pb-4 -mt-2 pt-2 rounded-b-2xl border border-t-0 border-indigo-100 dark:border-indigo-800">
              <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">{t('stats.bfsIntro')}</p>
            </div>
          )}
        </div>

        {/* KPI Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-blue-50/50 dark:bg-blue-900/20 p-4 rounded-2xl border border-blue-100 dark:border-blue-800 group relative">
               <p className="text-xs font-bold text-blue-500 uppercase flex items-center gap-1">
                 {t('stats.totalFrontierWorkers')}
                 <Info size={12} className="text-blue-400 cursor-help" />
               </p>
               <p className="text-2xl font-bold text-slate-800 dark:text-slate-100 mt-1">
                 {loading ? <Loader2 className="animate-spin h-6 w-6"/> : (latestValue / 1000).toFixed(1) + 'k'}
               </p>
               {/* Tooltip */}
               <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 w-56">
                 <div className="bg-slate-900 text-white text-xs rounded-xl p-3 shadow-xl">
                   <p className="font-semibold mb-1">{t('stats.totalTooltipTitle')}</p>
                   <p className="text-slate-300">{t('stats.totalTooltipDesc')}</p>
                   <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-slate-900"></div>
                 </div>
               </div>
            </div>
            <div className={`p-4 rounded-2xl border group relative ${Number(qoqPercent) >= 0 ? 'bg-emerald-50/50 border-emerald-100 dark:bg-emerald-900/20 dark:border-emerald-800' : 'bg-red-50/50 border-red-100'}`}>
               <p className={`text-xs font-bold uppercase flex items-center gap-1 ${Number(qoqPercent) >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                 {t('stats.quarterlyTrend')}
                 <Info size={12} className={`cursor-help ${Number(qoqPercent) >= 0 ? 'text-emerald-400' : 'text-red-400'}`} />
               </p>
               <div className="flex items-center gap-2 mt-1">
                 <p className="text-2xl font-bold text-slate-800 dark:text-slate-100">{qoqPercent}%</p>
                 {Number(qoqPercent) >= 0 ? <TrendingUp size={18} className="text-emerald-500"/> : <TrendingUp size={18} className="text-red-500 rotate-180"/>}
               </div>
               {/* Tooltip */}
               <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 w-56">
                 <div className="bg-slate-900 text-white text-xs rounded-xl p-3 shadow-xl">
                   <p className="font-semibold mb-1">{t('stats.trendTooltipTitle')}</p>
                   <p className="text-slate-300">{t('stats.trendTooltipDesc')}</p>
                   <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-slate-900"></div>
                 </div>
               </div>
            </div>
            <div className="bg-indigo-50/50 dark:bg-indigo-900/20 p-4 rounded-2xl border border-indigo-100 dark:border-indigo-800 group relative">
               <p className="text-xs font-bold text-indigo-600 uppercase flex items-center gap-1">
                 {t('stats.permitsEstimated')}
                 <Info size={12} className="text-indigo-400 cursor-help" />
               </p>
               <p className="text-lg font-bold text-slate-800 dark:text-slate-100 mt-2 truncate">{t('stats.permitG')}</p>
               {/* Tooltip */}
               <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 w-56">
                 <div className="bg-slate-900 text-white text-xs rounded-xl p-3 shadow-xl">
                   <p className="font-semibold mb-1">{t('stats.permitTooltipTitle')}</p>
                   <p className="text-slate-300">{t('stats.permitTooltipDesc')}</p>
                   <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-slate-900"></div>
                 </div>
               </div>
            </div>
            <div className="bg-purple-50/50 dark:bg-purple-900/20 p-4 rounded-2xl border border-purple-100 dark:border-purple-800 group relative">
               <p className="text-xs font-bold text-purple-500 uppercase flex items-center gap-1">
                 {t('stats.genderRatio')}
                 <Info size={12} className="text-purple-400 cursor-help" />
               </p>
               <div className="flex items-end gap-1 mt-1">
                  <p className="text-2xl font-bold text-slate-800 dark:text-slate-100">{malePercent}%</p>
                  <span className="text-xs text-slate-500 dark:text-slate-400 mb-1">M</span>
               </div>
               {/* Tooltip */}
               <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-20 w-56">
                 <div className="bg-slate-900 text-white text-xs rounded-xl p-3 shadow-xl">
                   <p className="font-semibold mb-1">{t('stats.genderTooltipTitle')}</p>
                   <p className="text-slate-300">{t('stats.genderTooltipDesc')}</p>
                   <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-slate-900"></div>
                 </div>
               </div>
            </div>
        </div>

        {/* Chart Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Chart 1: Historical Trend */}
            <div className="bg-white dark:bg-slate-800 p-5 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm col-span-1 lg:col-span-2">
               <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-6 flex items-center gap-2">
                 <TrendingUp size={16} className="text-blue-500"/> {t('stats.historicalTrend')}
               </h3>
               <div className="h-[300px] w-full">
                 <ResponsiveContainer width="100%" height="100%">
                   <AreaChart
                     data={historicalData}
                     margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                     onClick={() => Analytics.trackChartInteraction('stats_historical_trend', 'click')}
                   >
                     <defs>
                       <linearGradient id="colorFront" x1="0" y1="0" x2="0" y2="1">
                         <stop offset="5%" stopColor="#f59e0b" stopOpacity={0.3}/>
                         <stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/>
                       </linearGradient>
                     </defs>
                     <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDark ? '#334155' : '#e2e8f0'} strokeOpacity={0.3} />
                     <XAxis dataKey="year" axisLine={false} tickLine={false} tick={{fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b', fontWeight: 600}} dy={10} minTickGap={30} />
                     <YAxis axisLine={false} tickLine={false} tick={{fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b', fontWeight: 600}} domain={['dataMin - 2000', 'auto']} width={50} tickFormatter={(val) => `${(val/1000).toFixed(0)}k`} />
                     <Tooltip
                        contentStyle={{borderRadius: '12px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)', backgroundColor: isDark ? '#1e293b' : '#fff', color: isDark ? '#e2e8f0' : '#1e293b'}}
                        formatter={(value: any) => [Number(value).toLocaleString('it-IT'), t('stats.workers')]}
                     />
                     <Area type="monotone" dataKey="frontalieri" stroke="#f59e0b" strokeWidth={3} fillOpacity={1} fill="url(#colorFront)" animationDuration={1500} />
                   </AreaChart>
                 </ResponsiveContainer>
               </div>
            </div>

            {/* Chart 2: Age Distribution */}
            <div className="bg-white dark:bg-slate-800 p-5 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm">
               <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-6 flex items-center gap-2">
                 <BarChart2 size={16} className="text-emerald-500"/> {t('stats.ageDistribution')}
               </h3>
               <div className="h-[250px] w-full">
                 <ResponsiveContainer width="100%" height="100%">
                   <BarChart
                     data={ageData}
                     layout="vertical"
                     margin={{ top: 0, right: 30, left: 40, bottom: 0 }}
                     barSize={12}
                     onClick={() => Analytics.trackChartInteraction('stats_age_distribution', 'click')}
                   >
                     <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke={isDark ? '#334155' : '#e2e8f0'} strokeOpacity={0.3} />
                     <XAxis type="number" hide />
                     <YAxis dataKey="name" type="category" width={60} tick={{fontSize: 10, fill: isDark ? '#94a3b8' : '#64748b', fontWeight: 600}} axisLine={false} tickLine={false} />
                     <Tooltip cursor={{fill: 'transparent'}} contentStyle={{borderRadius: '12px', backgroundColor: isDark ? '#1e293b' : '#fff', color: isDark ? '#e2e8f0' : '#1e293b', border: 'none'}} />
                     <Bar dataKey="value" radius={[0, 4, 4, 0]} fill="#10b981" name="Lavoratori">
                        {ageData.map((entry, index) => (
                            <Cell key={`cell-${index}`} fill={index % 2 === 0 ? '#10b981' : '#34d399'} />
                        ))}
                     </Bar>
                   </BarChart>
                 </ResponsiveContainer>
               </div>
            </div>

            {/* Chart 3: Gender Trend (Replacing Broken Sectors) */}
            <div className="bg-white dark:bg-slate-800 p-5 rounded-3xl border border-slate-100 dark:border-slate-700 shadow-sm">
               <h3 className="text-sm font-bold text-slate-700 dark:text-slate-200 mb-6 flex items-center gap-2">
                 <PersonStanding size={16} className="text-indigo-600"/> {t('stats.genderTrend')}
               </h3>
               <div className="h-[250px] w-full">
                 {genderTrendData.length > 0 ? (
                    <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={genderTrendData}
                          margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                          onClick={() => Analytics.trackChartInteraction('stats_gender_trend', 'click')}
                        >
                            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={isDark ? '#334155' : '#e2e8f0'} strokeOpacity={0.2} />
                            <XAxis dataKey="year" axisLine={false} tickLine={false} tick={{fontSize: 10, fill: isDark ? '#94a3b8' : '#64748b'}} dy={10} minTickGap={30} />
                            <YAxis axisLine={false} tickLine={false} tick={{fontSize: 10, fill: isDark ? '#94a3b8' : '#64748b'}} width={45} tickFormatter={(val) => `${(val/1000).toFixed(0)}k`} />
                            <Tooltip contentStyle={{borderRadius: '12px', backgroundColor: isDark ? '#1e293b' : '#fff', color: isDark ? '#e2e8f0' : '#1e293b', border: 'none'}} />
                            <Legend iconType="circle" wrapperStyle={{fontSize: '10px', paddingTop: '10px'}}/>
                            <Line type="monotone" dataKey="Uomini" stroke="#f59e0b" strokeWidth={2} dot={false} activeDot={{r: 4}} />
                            <Line type="monotone" dataKey="Donne" stroke="#f43f5e" strokeWidth={2} dot={false} activeDot={{r: 4}} />
                        </LineChart>
                    </ResponsiveContainer>
                 ) : (
                    <div className="w-full h-full flex flex-col items-center justify-center text-slate-500">
                        {loading ? <Loader2 className="animate-spin" /> : <span className="text-xs italic">{t('stats.dataNotAvailable')}</span>}
                    </div>
                 )}
               </div>
            </div>

        </div>

        <JobBoardStatsOverview locale={locale} />

      </div>

      {/* Footer Info */}
      <div className="px-6">
        <div className="bg-slate-50 dark:bg-slate-800/50 p-4 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4 border border-slate-100 dark:border-slate-700">
            <div className="flex items-center gap-3">
                <div className="bg-white dark:bg-slate-700 p-2 rounded-xl text-indigo-600 shadow-sm hidden sm:block">
                    <Info size={20} />
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed text-center sm:text-left">
                    {t('stats.extractedFrom')}
                    {usingRealData ? (
                        <span className="text-emerald-700 dark:text-emerald-400 font-bold ml-1">
                            {t('stats.lastUpdate')}: {lastUpdated?.toLocaleDateString()}
                        </span>
                    ) : (
                        apiError && <span className="text-red-500 ml-1">{apiError}</span>
                    )}
                </div>
            </div>
            <div className="flex items-center gap-2">
              <a
                href={SOURCE_LINK}
                target="_blank"
                rel="noreferrer"
                onClick={() => Analytics.trackExternalLink(SOURCE_LINK, 'stats_source_bfs')}
                className="flex items-center gap-2 px-4 py-2 bg-white dark:bg-slate-700 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 text-indigo-600 dark:text-indigo-300 text-xs font-bold rounded-xl transition-all border border-slate-200 dark:border-slate-600 shadow-sm"
              >
                {t('stats.sourceBFS')} <ExternalLink size={12} />
              </a>
            </div>
        </div>
      </div>

    </div>
  );
};
