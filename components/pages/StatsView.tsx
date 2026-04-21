import React, { useEffect, useMemo, useState, memo } from 'react';
import { 
 AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
 Legend, Cell, BarChart, Bar, LineChart, Line
} from 'recharts';
import { TrendingUp, Info, ExternalLink, Loader2, Database, PersonStanding, RefreshCw, BarChart2, ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import { useChartColors, CHART_DATA_COLORS } from '@/hooks/useChartColors';
import { fetchStats, SOURCE_LINK, type TrendPoint, type AgePoint, type GenderTrendPoint, type GenderSnapshot, type StatsSource } from '@/services/statsService';
import { Analytics } from '@/services/analytics';
import JobBoardStatsOverview from './JobBoardStatsOverview';

// StatsSubTab is defined in services/router.ts — use that as the canonical source

const StatsViewInner: React.FC = () => {
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

 const chart = useChartColors(isDark);

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
 setApiError(error.message ||"Errore scaricamento dati BFS");
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
 const qoq = prev > 0 ? (((latest - prev) / prev) * 100).toFixed(1) :"0.0";
 const male = genderData.find(g => g.name === 'Uomini')?.pct ||"0";
 return { latestValue: latest, prevValue: prev, qoqPercent: qoq, malePercent: male };
 }, [historicalData, genderData]);

 return (
 <div className="bg-surface rounded-2xl shadow-sm border border-edge flex flex-col h-full animate-fade-in-up transition-colors duration-300 pb-8">
 {/* Header */}
 <div className="p-6 border-b border-edge flex justify-between items-center sticky top-0 z-10 bg-surface rounded-t-2xl">
 <div>
 <h2 className="text-xl font-bold font-display text-strong tracking-tight flex items-center gap-2">
 <Database size={20} className="text-accent"/> {t('stats.title')}
 </h2>
 <p className="text-muted text-xs mt-1">
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
 className="p-2 bg-surface rounded-xl shadow-sm border border-edge text-muted hover:text-accent transition-[color,background-color,border-color,opacity,transform] hover:rotate-180 disabled:opacity-50"
 title={t('stats.refreshData')}
 >
 <RefreshCw size={18} className={loading ?"animate-spin" :""} />
 </button>
 )}
 </div>

 <div className="p-3 sm:p-6 space-y-6 sm:space-y-8">
 {/* BFS SEO intro — always visible on desktop, collapsible on mobile */}
 <div className="hidden sm:block">
 <div className="bg-accent-subtle/40 p-5 rounded-2xl border border-accent-border">
 <h3 className="text-sm font-bold text-accent mb-2 flex items-center gap-2">
 <Database size={16} className="text-accent" /> {t('stats.bfsSectionTitle')}
 </h3>
 <p className="text-sm text-subtle leading-relaxed">{t('stats.bfsIntro')}</p>
 </div>
 </div>
 <div className="sm:hidden">
 <button
 onClick={() => setShowBfsIntro(!showBfsIntro)}
 className="w-full flex items-center justify-between bg-accent-subtle/40 px-4 py-3 rounded-2xl border border-accent-border text-left"
 >
 <span className="text-sm font-bold text-accent flex items-center gap-2">
 <Database size={16} className="text-accent" /> {t('stats.bfsSectionTitle')}
 </span>
 {showBfsIntro ? <ChevronUp size={16} className="text-accent" /> : <ChevronDown size={16} className="text-accent" />}
 </button>
 {showBfsIntro && (
 <div className="bg-accent-subtle/40 px-4 pb-4 -mt-2 pt-2 rounded-b-2xl border border-t-0 border-accent-border">
 <p className="text-sm text-subtle leading-relaxed">{t('stats.bfsIntro')}</p>
 </div>
 )}
 </div>

 {/* KPI Strip */}
 <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-body">
 <span><span className="font-semibold text-accent">{loading ? '…' : (latestValue / 1000).toFixed(1) + 'k'}</span> {t('stats.totalFrontierWorkers')}</span>
 <span className="text-edge">·</span>
 <span>{t('stats.quarterlyTrend')}: <span className={`font-semibold ${Number(qoqPercent) >= 0 ? 'text-success' : 'text-danger'}`}>{qoqPercent}%</span> {Number(qoqPercent) >= 0 ? <TrendingUp size={14} className="inline text-success"/> : <TrendingUp size={14} className="inline text-danger rotate-180"/>}</span>
 <span className="text-edge">·</span>
 <span>{t('stats.permitsEstimated')}: <span className="font-semibold">{t('stats.permitG')}</span></span>
 <span className="text-edge">·</span>
 <span>{t('stats.genderRatio')}: <span className="font-semibold">{malePercent}% M</span></span>
 </div>

 {/* Chart Grid */}
 <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
 {/* Chart 1: Historical Trend */}
 <div className="bg-surface p-5 rounded-3xl border border-edge shadow-sm col-span-1 lg:col-span-2">
 <h3 className="text-sm font-bold text-body mb-6 flex items-center gap-2">
 <TrendingUp size={16} className="text-accent"/> {t('stats.historicalTrend')}
 </h3>
 <div className="h-[300px] w-full">
 {historicalData.length > 0 ? (
 <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
 <AreaChart
 data={historicalData}
 margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
 onClick={() => Analytics.trackChartInteraction('stats_historical_trend', 'click')}
 >
 <defs>
 <linearGradient id="colorFront" x1="0" y1="0" x2="0" y2="1">
 <stop offset="5%" stopColor={CHART_DATA_COLORS.warning} stopOpacity={0.3}/>
 <stop offset="95%" stopColor={CHART_DATA_COLORS.warning} stopOpacity={0}/>
 </linearGradient>
 </defs>
 <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chart.grid} strokeOpacity={0.3} />
 <XAxis dataKey="year" axisLine={false} tickLine={false} tick={{fontSize: 11, fill: chart.tick, fontWeight: 600}} dy={10} minTickGap={30} />
 <YAxis axisLine={false} tickLine={false} tick={{fontSize: 11, fill: chart.tick, fontWeight: 600}} domain={['dataMin - 2000', 'auto']} width={50} tickFormatter={(val) => `${(val/1000).toFixed(0)}k`} />
 <Tooltip
 contentStyle={{...chart.tooltipStyle, boxShadow: '0 10px 15px -3px rgba(0, 0, 0, 0.1)'}}
 formatter={(value: any) => [Number(value).toLocaleString('it-IT'), t('stats.workers')]}
 />
 <Area type="monotone" dataKey="frontalieri" stroke={CHART_DATA_COLORS.warning} strokeWidth={3} fillOpacity={1} fill="url(#colorFront)" animationDuration={800} />
 </AreaChart>
 </ResponsiveContainer>
 ) : (
 <div className="w-full h-full flex items-center justify-center text-muted">
 {loading ? <Loader2 className="animate-spin" /> : <span className="text-xs italic">{t('stats.dataNotAvailable')}</span>}
 </div>
 )}
 </div>
 </div>

 {/* Chart 2: Age Distribution */}
 <div className="bg-surface p-5 rounded-3xl border border-edge shadow-sm">
 <h3 className="text-sm font-bold text-body mb-6 flex items-center gap-2">
 <BarChart2 size={16} className="text-success"/> {t('stats.ageDistribution')}
 </h3>
 <div className="h-[250px] w-full">
 {ageData.length > 0 ? (
 <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
 <BarChart
 data={ageData}
 layout="vertical"
 margin={{ top: 0, right: 30, left: 40, bottom: 0 }}
 barSize={12}
 onClick={() => Analytics.trackChartInteraction('stats_age_distribution', 'click')}
 >
 <CartesianGrid strokeDasharray="3 3" horizontal={true} vertical={false} stroke={chart.grid} strokeOpacity={0.3} />
 <XAxis type="number" hide />
 <YAxis dataKey="name" type="category" width={60} tick={{fontSize: 10, fill: chart.tick, fontWeight: 600}} axisLine={false} tickLine={false} />
 <Tooltip cursor={{fill: 'transparent'}} contentStyle={chart.tooltipStyle} />
 <Bar dataKey="value" radius={[0, 4, 4, 0]} fill={CHART_DATA_COLORS.positive} name="Lavoratori">
 {ageData.map((entry, index) => (
 <Cell key={`cell-${index}`} fill={index % 2 === 0 ? CHART_DATA_COLORS.positive : CHART_DATA_COLORS.positiveAlt} />
 ))}
 </Bar>
 </BarChart>
 </ResponsiveContainer>
 ) : (
 <div className="w-full h-full flex items-center justify-center text-muted">
 {loading ? <Loader2 className="animate-spin" /> : <span className="text-xs italic">{t('stats.dataNotAvailable')}</span>}
 </div>
 )}
 </div>
 </div>

 {/* Chart 3: Gender Trend (Replacing Broken Sectors) */}
 <div className="bg-surface p-5 rounded-3xl border border-edge shadow-sm">
 <h3 className="text-sm font-bold text-body mb-6 flex items-center gap-2">
 <PersonStanding size={16} className="text-accent"/> {t('stats.genderTrend')}
 </h3>
 <div className="h-[250px] w-full">
 {genderTrendData.length > 0 ? (
 <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
 <LineChart
 data={genderTrendData}
 margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
 onClick={() => Analytics.trackChartInteraction('stats_gender_trend', 'click')}
 >
 <CartesianGrid strokeDasharray="3 3" vertical={false} stroke={chart.grid} strokeOpacity={0.2} />
 <XAxis dataKey="year" axisLine={false} tickLine={false} tick={{fontSize: 10, fill: chart.tick}} dy={10} minTickGap={30} />
 <YAxis axisLine={false} tickLine={false} tick={{fontSize: 10, fill: chart.tick}} width={45} tickFormatter={(val) => `${(val/1000).toFixed(0)}k`} />
 <Tooltip contentStyle={chart.tooltipStyle} />
 <Legend iconType="circle" wrapperStyle={{fontSize: '10px', paddingTop: '10px'}}/>
 <Line type="monotone" dataKey="Uomini" stroke={CHART_DATA_COLORS.warning} strokeWidth={2} dot={false} activeDot={{r: 4}} />
 <Line type="monotone" dataKey="Donne" stroke={CHART_DATA_COLORS.rose} strokeWidth={2} dot={false} activeDot={{r: 4}} />
 </LineChart>
 </ResponsiveContainer>
 ) : (
 <div className="w-full h-full flex flex-col items-center justify-center text-muted">
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
 <div className="bg-surface-alt/50 p-4 rounded-2xl flex flex-col sm:flex-row items-center justify-between gap-4 border border-edge">
 <div className="flex items-center gap-3">
 <div className="bg-surface p-2 rounded-xl text-accent shadow-sm hidden sm:block">
 <Info size={20} />
 </div>
 <div className="text-xs text-muted leading-relaxed text-center sm:text-left">
 {t('stats.extractedFrom')}
 {usingRealData ? (
 <span className="text-success font-bold ml-1">
 {t('stats.lastUpdate')}: {lastUpdated?.toLocaleDateString()}
 </span>
 ) : (
 apiError && <span className="text-danger ml-1">{apiError}</span>
 )}
 </div>
 </div>
 <div className="flex items-center gap-2">
 <a
 href={SOURCE_LINK}
 target="_blank"
 rel="noreferrer"
 onClick={() => Analytics.trackExternalLink(SOURCE_LINK, 'stats_source_bfs')}
 className="flex items-center gap-2 px-4 py-2 bg-surface hover:bg-accent-subtle text-accent text-xs font-bold rounded-xl transition-colors border border-edge shadow-sm"
 >
 {t('stats.sourceBFS')} <ExternalLink size={12} />
 </a>
 </div>
 </div>
 </div>

 </div>
 );
};

export const StatsView = memo(StatsViewInner);
