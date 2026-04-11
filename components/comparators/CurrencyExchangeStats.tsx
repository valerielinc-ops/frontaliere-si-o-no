/**
 * CurrencyExchangeStats — Lazy-loaded statistics sub-tab for CurrencyExchange.
 *
 * Extracted to reduce initial bundle size and TBT on mobile.
 * Contains: WeightedAverageStats, EnhancedHistoricalStats, WeeklyExchangeAlert, ExchangeTimingSection.
 * Imports Recharts (BarChart) only when the Statistics tab is opened.
 */
import React, { useState, useEffect, useMemo } from 'react';
import { TrendingDown, TrendingUp, BarChart3, Clock, Calendar, FlaskConical, Zap, ChartBar, ArrowLeftRight, Bell, Mail } from 'lucide-react';
import { XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell } from 'recharts';
import { useTranslation } from '@/services/i18n';

// ── Constants ────────────────────────────────────────────────
const DAY_KEYS = ['day_mon', 'day_tue', 'day_wed', 'day_thu', 'day_fri', 'day_sat', 'day_sun'];
const MONTH_KEYS = ['month_jan', 'month_feb', 'month_mar', 'month_apr', 'month_may', 'month_jun', 'month_jul', 'month_aug', 'month_sep', 'month_oct', 'month_nov', 'month_dec'];

// ── Helper functions ─────────────────────────────────────────

interface TimingData {
  dayOfWeek: { day: string; avgRate: number; sampleCount: number }[];
  monthOfYear: { month: string; avgRate: number; sampleCount: number }[];
  bestDay: string;
  worstDay: string;
  bestMonth: string;
  worstMonth: string;
}

function analyzeTimingPatterns(historyData: Array<{ date: string; rate: number }>): TimingData | null {
  if (historyData.length < 30) return null;

  const dayBuckets: { sum: number; count: number }[] = Array.from({ length: 7 }, () => ({ sum: 0, count: 0 }));
  const monthBuckets: { sum: number; count: number }[] = Array.from({ length: 12 }, () => ({ sum: 0, count: 0 }));

  for (const point of historyData) {
    const d = new Date(point.date);
    const dow = (d.getDay() + 6) % 7;
    dayBuckets[dow].sum += point.rate;
    dayBuckets[dow].count++;
    monthBuckets[d.getMonth()].sum += point.rate;
    monthBuckets[d.getMonth()].count++;
  }

  const dayOfWeek = dayBuckets.map((b, i) => ({
    day: DAY_KEYS[i],
    avgRate: b.count > 0 ? b.sum / b.count : 0,
    sampleCount: b.count,
  }));

  const monthOfYear = monthBuckets.map((b, i) => ({
    month: MONTH_KEYS[i],
    avgRate: b.count > 0 ? b.sum / b.count : 0,
    sampleCount: b.count,
  })).filter(m => m.sampleCount > 0);

  const activeDays = dayOfWeek.filter(d => d.sampleCount > 0);
  const bestDay = activeDays.reduce((a, b) => a.avgRate > b.avgRate ? a : b).day;
  const worstDay = activeDays.reduce((a, b) => a.avgRate < b.avgRate ? a : b).day;
  const bestMonth = monthOfYear.reduce((a, b) => a.avgRate > b.avgRate ? a : b).month;
  const worstMonth = monthOfYear.reduce((a, b) => a.avgRate < b.avgRate ? a : b).month;

  return { dayOfWeek, monthOfYear, bestDay, worstDay, bestMonth, worstMonth };
}

function analyzeVolatility(historyData: Array<{ date: string; rate: number }>) {
  if (historyData.length < 10) return null;
  const rates = historyData.map(d => d.rate);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const variance = rates.reduce((sum, r) => sum + Math.pow(r - mean, 2), 0) / rates.length;
  const stdDev = Math.sqrt(variance);
  const min = Math.min(...rates);
  const max = Math.max(...rates);
  const range = max - min;
  const current = rates[rates.length - 1];
  const percentile = ((current - min) / range) * 100;

  const weeklyChanges: number[] = [];
  for (let i = 5; i < rates.length; i++) {
    weeklyChanges.push(((rates[i] - rates[i - 5]) / rates[i - 5]) * 100);
  }
  const avgWeeklyChange = weeklyChanges.length > 0 ? weeklyChanges.reduce((a, b) => a + b, 0) / weeklyChanges.length : 0;
  const maxWeeklyGain = weeklyChanges.length > 0 ? Math.max(...weeklyChanges) : 0;
  const maxWeeklyLoss = weeklyChanges.length > 0 ? Math.min(...weeklyChanges) : 0;

  let currentStreak = 0;
  let streakDirection: 'up' | 'down' | 'flat' = 'flat';
  for (let i = rates.length - 1; i > 0; i--) {
    const diff = rates[i] - rates[i - 1];
    if (currentStreak === 0) {
      streakDirection = diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat';
      currentStreak = 1;
    } else if ((diff > 0 && streakDirection === 'up') || (diff < 0 && streakDirection === 'down')) {
      currentStreak++;
    } else {
      break;
    }
  }

  return { mean, stdDev, min, max, range, percentile, avgWeeklyChange, maxWeeklyGain, maxWeeklyLoss, currentStreak, streakDirection, current };
}

// ── EnhancedHistoricalStats ──────────────────────────────────

const EnhancedHistoricalStats: React.FC<{ historyData: Array<{ date: string; rate: number }> }> = ({ historyData }) => {
  const { t } = useTranslation();
  
  const stats = useMemo(() => {
    if (historyData.length < 60) return null;
    
    let highestRate = { rate: -Infinity, date: '' };
    let lowestRate = { rate: Infinity, date: '' };
    for (const point of historyData) {
      if (point.rate > highestRate.rate) highestRate = { rate: point.rate, date: point.date };
      if (point.rate < lowestRate.rate) lowestRate = { rate: point.rate, date: point.date };
    }
    
    const calculateRollingAvg = (days: number) => {
      if (historyData.length < days) return null;
      const recentData = historyData.slice(-days);
      return recentData.reduce((sum, d) => sum + d.rate, 0) / recentData.length;
    };
    
    const rolling30d = calculateRollingAvg(30);
    const rolling90d = calculateRollingAvg(90);
    const rolling180d = calculateRollingAvg(180);
    const currentRate = historyData[historyData.length - 1].rate;
    
    const quarterlyData: Record<string, { sum: number; count: number; rates: number[] }> = {};
    for (const point of historyData) {
      const d = new Date(point.date);
      const q = Math.ceil((d.getMonth() + 1) / 3);
      const key = `${d.getFullYear()}-Q${q}`;
      if (!quarterlyData[key]) quarterlyData[key] = { sum: 0, count: 0, rates: [] };
      quarterlyData[key].sum += point.rate;
      quarterlyData[key].count++;
      quarterlyData[key].rates.push(point.rate);
    }
    
    const quarters = Object.entries(quarterlyData)
      .map(([quarter, data]) => ({
        quarter,
        avg: data.sum / data.count,
        count: data.count,
        min: Math.min(...data.rates),
        max: Math.max(...data.rates),
      }))
      .sort((a, b) => a.quarter.localeCompare(b.quarter));
    
    for (let i = 1; i < quarters.length; i++) {
      (quarters[i] as any).trend = ((quarters[i].avg - quarters[i - 1].avg) / quarters[i - 1].avg) * 100;
    }
    
    const monthlySeasonalData: Record<number, { sum: number; count: number }> = {};
    const yearsSet = new Set<number>();
    for (const point of historyData) {
      const d = new Date(point.date);
      const month = d.getMonth();
      yearsSet.add(d.getFullYear());
      if (!monthlySeasonalData[month]) monthlySeasonalData[month] = { sum: 0, count: 0 };
      monthlySeasonalData[month].sum += point.rate;
      monthlySeasonalData[month].count++;
    }
    
    const seasonalMonths = Object.entries(monthlySeasonalData)
      .map(([month, data]) => ({
        month: parseInt(month),
        monthKey: MONTH_KEYS[parseInt(month)],
        avg: data.sum / data.count,
        count: data.count,
      }))
      .filter(m => m.count > 0)
      .sort((a, b) => b.avg - a.avg);
    
    const yearsCount = yearsSet.size;
    const bestMonths = seasonalMonths.slice(0, 3);
    const worstMonths = seasonalMonths.slice(-3).reverse();
    
    return { highestRate, lowestRate, rolling30d, rolling90d, rolling180d, currentRate, quarters, bestMonths, worstMonths, yearsCount };
  }, [historyData]);
  
  if (!stats) return null;
  
  return (
    <div className="bg-gradient-to-br from-slate-50 to-stripe-50 dark:from-slate-900/50 dark:to-stripe-950/30 rounded-2xl border border-edge p-4 sm:p-6 space-y-6">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-surface-raised rounded-xl">
          <ChartBar size={24} className="text-subtle" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">{t('currency.historical_extremes')}</h2>
          <p className="text-sm text-subtle">
            {historyData.length} {t('currency.data_points')}
          </p>
        </div>
      </div>
      
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800">
          <div className="flex items-center gap-2 mb-2">
            <TrendingUp size={16} className="text-emerald-700" />
            <span className="text-sm font-bold text-emerald-700 dark:text-emerald-400">{t('currency.historical_high')}</span>
          </div>
          <div className="text-2xl font-bold text-emerald-700">{stats.highestRate.rate.toFixed(4)}</div>
          <div className="text-xs text-subtle">
            {t('currency.on_date')} {new Date(stats.highestRate.date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })}
          </div>
        </div>
        <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4 border border-red-200 dark:border-red-800">
          <div className="flex items-center gap-2 mb-2">
            <TrendingDown size={16} className="text-red-600" />
            <span className="text-sm font-bold text-red-700 dark:text-red-400">{t('currency.historical_low')}</span>
          </div>
          <div className="text-2xl font-bold text-red-600">{stats.lowestRate.rate.toFixed(4)}</div>
          <div className="text-xs text-subtle">
            {t('currency.on_date')} {new Date(stats.lowestRate.date).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' })}
          </div>
        </div>
      </div>
      
      <div className="bg-surface rounded-xl p-4 border border-edge">
        <h3 className="font-bold text-sm text-body mb-3 flex items-center gap-2">
          <ArrowLeftRight size={14} /> {t('currency.rolling_averages')}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {stats.rolling30d && (
            <div className="text-center p-3 bg-surface-alt rounded-lg">
              <div className="text-xs font-bold text-muted uppercase">{t('currency.rolling_30d')}</div>
              <div className="text-lg font-bold text-slate-700 dark:text-slate-200">{stats.rolling30d.toFixed(4)}</div>
              <div className={`text-xs ${stats.currentRate > stats.rolling30d ? 'text-emerald-700' : 'text-red-600'}`}>
                {((stats.currentRate - stats.rolling30d) / stats.rolling30d * 100).toFixed(2)}% {t('currency.vs_current')}
              </div>
            </div>
          )}
          {stats.rolling90d && (
            <div className="text-center p-3 bg-surface-alt rounded-lg">
              <div className="text-xs font-bold text-muted uppercase">{t('currency.rolling_90d')}</div>
              <div className="text-lg font-bold text-slate-700 dark:text-slate-200">{stats.rolling90d.toFixed(4)}</div>
              <div className={`text-xs ${stats.currentRate > stats.rolling90d ? 'text-emerald-700' : 'text-red-600'}`}>
                {((stats.currentRate - stats.rolling90d) / stats.rolling90d * 100).toFixed(2)}% {t('currency.vs_current')}
              </div>
            </div>
          )}
          {stats.rolling180d && (
            <div className="text-center p-3 bg-surface-alt rounded-lg">
              <div className="text-xs font-bold text-muted uppercase">{t('currency.rolling_180d')}</div>
              <div className="text-lg font-bold text-slate-700 dark:text-slate-200">{stats.rolling180d.toFixed(4)}</div>
              <div className={`text-xs ${stats.currentRate > stats.rolling180d ? 'text-emerald-700' : 'text-red-600'}`}>
                {((stats.currentRate - stats.rolling180d) / stats.rolling180d * 100).toFixed(2)}% {t('currency.vs_current')}
              </div>
            </div>
          )}
        </div>
      </div>
      
      {stats.quarters.length > 2 && (
        <div className="bg-surface rounded-xl p-4 border border-edge">
          <h3 className="font-bold text-sm text-body mb-3 flex items-center gap-2">
            <Calendar size={14} /> {t('currency.quarterly_breakdown')}
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-edge">
                  <th className="text-left py-2 px-2 font-bold text-subtle">{t('currency.quarter')}</th>
                  <th className="text-right py-2 px-2 font-bold text-subtle">{t('currency.avg_rate')}</th>
                  <th className="text-right py-2 px-2 font-bold text-subtle">Min / Max</th>
                  <th className="text-right py-2 px-2 font-bold text-subtle">{t('currency.trend')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.quarters.slice(-8).map((q, i) => (
                  <tr key={q.quarter} className={i % 2 === 0 ? 'bg-surface-alt/50' : ''}>
                    <td className="py-2 px-2 font-medium text-body">{q.quarter}</td>
                    <td className="py-2 px-2 text-right font-bold text-strong">{q.avg.toFixed(4)}</td>
                    <td className="py-2 px-2 text-right text-subtle text-xs">{q.min.toFixed(4)} / {q.max.toFixed(4)}</td>
                    <td className="py-2 px-2 text-right">
                      {(q as any).trend !== undefined ? (
                        <span className={`font-bold ${(q as any).trend >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                          {(q as any).trend >= 0 ? '+' : ''}{(q as any).trend.toFixed(2)}%
                        </span>
                      ) : (
                        <span className="text-muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      
      {stats.yearsCount >= 2 && (
        <div className="bg-gradient-to-r from-teal-50 to-emerald-50 dark:from-teal-950/20 dark:to-emerald-950/20 rounded-xl p-4 border border-teal-200 dark:border-teal-800">
          <h3 className="font-bold text-sm text-teal-700 dark:text-teal-300 mb-3 flex items-center gap-2">
            🗓️ {t('currency.seasonal_patterns')}
          </h3>
          <div className="grid sm:grid-cols-2 gap-4">
            <div>
              <div className="text-xs font-bold text-emerald-700 mb-2">✅ {t('currency.best_months')}</div>
              <div className="space-y-1">
                {stats.bestMonths.map((m, i) => (
                  <div key={m.monthKey} className="flex items-center justify-between bg-surface rounded-lg p-2">
                    <span className="font-medium text-body">{i + 1}. {t(`currency.${m.monthKey}`)}</span>
                    <span className="font-bold text-emerald-700">{m.avg.toFixed(4)}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="text-xs font-bold text-red-600 mb-2">⚠️ {t('currency.worst_months')}</div>
              <div className="space-y-1">
                {stats.worstMonths.map((m, i) => (
                  <div key={m.monthKey} className="flex items-center justify-between bg-surface rounded-lg p-2">
                    <span className="font-medium text-body">{i + 1}. {t(`currency.${m.monthKey}`)}</span>
                    <span className="font-bold text-red-600">{m.avg.toFixed(4)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-3 text-xs text-subtle text-center">
            {t('currency.seasonality_note', { years: stats.yearsCount })}
          </div>
        </div>
      )}
    </div>
  );
};

// ── ExchangeTimingSection ────────────────────────────────────

const ExchangeTimingSection: React.FC<{ historyData: Array<{ date: string; rate: number }> }> = ({ historyData }) => {
  const { t } = useTranslation();
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const obs = new MutationObserver(() => setIsDark(document.documentElement.classList.contains('dark')));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  const timing = useMemo(() => analyzeTimingPatterns(historyData), [historyData]);
  const volatility = useMemo(() => analyzeVolatility(historyData), [historyData]);

  if (!timing) return null;

  const dayMin = Math.min(...timing.dayOfWeek.filter(d => d.sampleCount > 0).map(d => d.avgRate));
  const dayMax = Math.max(...timing.dayOfWeek.filter(d => d.sampleCount > 0).map(d => d.avgRate));
  const monthMin = Math.min(...timing.monthOfYear.map(m => m.avgRate));
  const monthMax = Math.max(...timing.monthOfYear.map(m => m.avgRate));

  return (
    <div className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/20 dark:to-orange-950/20 rounded-2xl border-2 border-dashed border-amber-300 dark:border-amber-700 p-4 sm:p-6 space-y-5">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-amber-100 dark:bg-amber-900/40 rounded-xl">
          <FlaskConical size={24} className="text-amber-700 dark:text-amber-400" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">{t('currency.when_to_exchange')}</h2>
            <span className="px-2 py-0.5 bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200 text-xs font-bold uppercase rounded-full tracking-wider">{t('currency.experimental')}</span>
          </div>
          <p className="text-sm text-subtle mt-0.5">
            {t('currency.timing_analysis_desc')}
          </p>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-surface rounded-xl p-4 border border-emerald-200 dark:border-emerald-800">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={18} className="text-emerald-700" />
            <span className="font-bold text-emerald-700 dark:text-emerald-400 text-sm">{t('currency.best_time')}</span>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-subtle">{t('currency.day_of_week')}</span>
              <span className="font-bold text-emerald-700">{t(`currency.${timing.bestDay}`)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-subtle">{t('currency.month_of_year')}</span>
              <span className="font-bold text-emerald-700">{t(`currency.${timing.bestMonth}`)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-subtle">{t('currency.recommended_time')}</span>
              <span className="font-bold text-emerald-700">10:00–12:00</span>
            </div>
          </div>
        </div>
        <div className="bg-surface rounded-xl p-4 border border-red-200 dark:border-red-800">
          <div className="flex items-center gap-2 mb-3">
            <TrendingDown size={18} className="text-red-600" />
            <span className="font-bold text-red-700 dark:text-red-400 text-sm">{t('currency.avoid')}</span>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-subtle">{t('currency.day_of_week')}</span>
              <span className="font-bold text-red-600">{t(`currency.${timing.worstDay}`)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-subtle">{t('currency.month_of_year')}</span>
              <span className="font-bold text-red-600">{t(`currency.${timing.worstMonth}`)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-subtle">{t('currency.unfavorable_time')}</span>
              <span className="font-bold text-red-600">{t('currency.weekend_17plus')}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="bg-surface rounded-xl p-4 border border-edge">
        <h3 className="font-bold text-sm text-body mb-3 flex items-center gap-2">
          <Calendar size={14} /> {t('currency.avg_rate_by_day')}
        </h3>
        <div className="h-[180px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={timing.dayOfWeek.filter(d => d.sampleCount > 0)} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#334155' : '#e2e8f0'} opacity={0.3} />
              <XAxis dataKey="day" tick={{ fontSize: 12, fill: isDark ? '#94a3b8' : '#64748b' }} tickFormatter={(v: string) => t(`currency.${v}`)} />
              <YAxis domain={[dayMin * 0.999, dayMax * 1.001]} tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b' }} tickFormatter={(v: number) => v.toFixed(4)} />
              <Tooltip
                formatter={(v: number) => [v.toFixed(5), t('currency.average')]}
                labelFormatter={(label: string) => t(`currency.${label}`)}
                contentStyle={{ borderRadius: '12px', backgroundColor: isDark ? '#1e293b' : '#ffffff', color: isDark ? '#e2e8f0' : '#1e293b', border: 'none' }}
              />
              <Bar dataKey="avgRate" radius={[6, 6, 0, 0]}>
                {timing.dayOfWeek.filter(d => d.sampleCount > 0).map((entry) => (
                  <Cell key={entry.day} fill={entry.day === timing.bestDay ? '#10b981' : entry.day === timing.worstDay ? '#ef4444' : '#8b5cf6'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="bg-surface rounded-xl p-4 border border-edge">
        <h3 className="font-bold text-sm text-body mb-3 flex items-center gap-2">
          <Clock size={14} /> {t('currency.avg_rate_by_month')}
        </h3>
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={timing.monthOfYear} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#334155' : '#e2e8f0'} opacity={0.3} />
              <XAxis dataKey="month" tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b' }} tickFormatter={(v: string) => t(`currency.${v}`)} />
              <YAxis domain={[monthMin * 0.998, monthMax * 1.002]} tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b' }} tickFormatter={(v: number) => v.toFixed(4)} />
              <Tooltip
                formatter={(v: number) => [v.toFixed(5), t('currency.average')]}
                labelFormatter={(label: string) => t(`currency.${label}`)}
                contentStyle={{ borderRadius: '12px', backgroundColor: isDark ? '#1e293b' : '#ffffff', color: isDark ? '#e2e8f0' : '#1e293b', border: 'none' }}
              />
              <Bar dataKey="avgRate" radius={[6, 6, 0, 0]}>
                {timing.monthOfYear.map((entry) => (
                  <Cell key={entry.month} fill={entry.month === timing.bestMonth ? '#10b981' : entry.month === timing.worstMonth ? '#ef4444' : '#6366f1'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="bg-amber-100/50 dark:bg-amber-900/20 rounded-xl p-4 text-sm">
        <div className="flex items-start gap-2">
          <Zap size={16} className="text-amber-700 mt-0.5 flex-shrink-0" />
          <div className="text-body space-y-1">
            <p className="font-bold text-amber-800 dark:text-amber-300">{t('currency.timing_tips_title')}</p>
            <ul className="list-disc ml-4 space-y-1 text-subtle">
              <li><strong>{t('currency.tip_morning_label')}:</strong> {t('currency.tip_morning')}</li>
              <li><strong>{t('currency.tip_avoid_weekend_label')}:</strong> {t('currency.tip_avoid_weekend')}</li>
              <li><strong>{t('currency.tip_end_month_label')}:</strong> {t('currency.tip_end_month')}</li>
              <li><strong>{t('currency.tip_dont_wait_label')}:</strong> {t('currency.tip_dont_wait')}</li>
            </ul>
          </div>
        </div>
      </div>

      {volatility && (
        <div className="bg-surface rounded-xl p-5 border border-amber-200 dark:border-amber-800 space-y-4">
          <h3 className="font-bold text-sm text-stripe-700 dark:text-stripe-300 flex items-center gap-2">
            📈 {t('currency.volatility_trend_analysis')}
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-lg p-3 text-center">
              <div className="text-xs font-bold text-stripe-500 uppercase tracking-wider">{t('currency.current_rate')}</div>
              <div className="text-lg font-bold text-stripe-700 dark:text-stripe-300">{volatility.current.toFixed(4)}</div>
              <div className="text-xs text-muted">
                {volatility.percentile > 70 ? `🟢 ${t('currency.high_in_range')}` : volatility.percentile < 30 ? `🔴 ${t('currency.low_in_range')}` : `🟡 ${t('currency.in_average')}`}
              </div>
            </div>
            <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 text-center">
              <div className="text-xs font-bold text-muted uppercase tracking-wider">{t('currency.range_min_max')}</div>
              <div className="text-sm font-bold text-slate-700 dark:text-slate-200">{volatility.min.toFixed(4)} – {volatility.max.toFixed(4)}</div>
              <div className="text-xs text-muted">Δ {(volatility.range * 100).toFixed(2)}%</div>
            </div>
            <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 text-center">
              <div className="text-xs font-bold text-muted uppercase tracking-wider">{t('currency.volatility_sigma')}</div>
              <div className="text-sm font-bold text-slate-700 dark:text-slate-200">{volatility.stdDev.toFixed(5)}</div>
              <div className="text-xs text-muted">{volatility.stdDev < 0.005 ? `😴 ${t('currency.stable')}` : volatility.stdDev < 0.015 ? `⚡ ${t('currency.moderate')}` : `🌊 ${t('currency.high')}`}</div>
            </div>
            <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 text-center">
              <div className="text-xs font-bold text-muted uppercase tracking-wider">{t('currency.current_trend')}</div>
              <div className="text-sm font-bold text-slate-700 dark:text-slate-200">
                {volatility.streakDirection === 'up' ? '📈' : volatility.streakDirection === 'down' ? '📉' : '➡️'} {volatility.currentStreak}{t('currency.days_abbr')} {volatility.streakDirection === 'up' ? t('currency.going_up') : volatility.streakDirection === 'down' ? t('currency.going_down') : t('currency.stable')}
              </div>
              <div className="text-xs text-muted">
                {volatility.streakDirection === 'up' ? `✅ ${t('currency.good_time_to_exchange')}` : volatility.streakDirection === 'down' ? `⏳ ${t('currency.maybe_wait')}` : `🤷 ${t('currency.neutral')}`}
              </div>
            </div>
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-muted">
              <span>Min {volatility.min.toFixed(4)}</span>
              <span>{t('currency.current_position_in_range')}</span>
              <span>Max {volatility.max.toFixed(4)}</span>
            </div>
            <div className="h-3 bg-gradient-to-r from-red-400 via-yellow-400 to-emerald-400 rounded-full relative">
              <div
                className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-slate-800 dark:border-white rounded-full shadow-lg"
                style={{ left: `calc(${Math.max(2, Math.min(98, volatility.percentile))}% - 8px)` }}
              />
            </div>
            <div className="text-center text-xs font-bold text-subtle">
              {t('currency.percentile')}: {volatility.percentile.toFixed(0)}%
              {volatility.percentile > 70 ? ` — 🎯 ${t('currency.favorable_moment')}` : volatility.percentile < 30 ? ` — ⏰ ${t('currency.low_rate_wait')}` : ` — ${t('currency.normal')}`}
            </div>
          </div>
        </div>
      )}

      <div className="bg-gradient-to-br from-emerald-50 to-stripe-50 dark:from-emerald-950/20 dark:to-stripe-950/20 rounded-xl p-5 border border-emerald-200 dark:border-emerald-800 space-y-3">
        <h3 className="font-bold text-sm text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
          🎯 {t('currency.life_hacks_title')}
        </h3>
        <div className="grid sm:grid-cols-2 gap-2">
          {[
            { emoji: '🏧', text: t('currency.hack_atm_monday') },
            { emoji: '📱', text: t('currency.hack_wise_revolut') },
            { emoji: '📅', text: t('currency.hack_end_month') },
            { emoji: '💡', text: t('currency.hack_split_exchange') },
            { emoji: '⚡', text: t('currency.hack_avoid_friday') },
            { emoji: '🔔', text: t('currency.hack_set_alert') },
          ].map((hack, i) => (
            <div key={i} className="flex items-start gap-2 bg-surface/60 rounded-lg p-2.5 text-xs text-body">
              <span className="text-base flex-shrink-0">{hack.emoji}</span>
              <span>{hack.text}</span>
            </div>
          ))}
        </div>
      </div>

      {volatility && (
        <div className="bg-gradient-to-r from-teal-600 to-emerald-700 rounded-xl px-5 py-4 text-white space-y-2">
          <h3 className="font-bold text-sm flex items-center gap-2">🧮 {t('currency.how_much_difference')}</h3>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-white">
            <div><span className="text-lg font-semibold">€ {(1000 * volatility.max).toFixed(2)}</span> <span className="text-sm text-white/80">{t('currency.1000chf_best_rate')}</span></div>
            <div><span className="text-lg font-semibold">€ {(1000 * volatility.min).toFixed(2)}</span> <span className="text-sm text-white/80">{t('currency.1000chf_worst_rate')}</span></div>
            <div><span className="text-lg font-semibold text-amber-300">€ {(1000 * volatility.range).toFixed(2)}</span> <span className="text-sm text-white/80">{t('currency.potential_difference')} · {t('currency.on_1000chf_period')}</span></div>
          </div>
          <p className="text-xs text-white/90 text-center mt-1">
            {t('currency.on_5000chf_annual')} <strong>€ {(5000 * volatility.range * 12).toFixed(0)}</strong>!
          </p>
        </div>
      )}
    </div>
  );
};

// ── WeightedAverageStats ─────────────────────────────────────

const WeightedAverageStats: React.FC<{
  historyData: Array<{ date: string; rate: number }>;
  currentRate: number;
  period: string;
}> = ({ historyData, currentRate, period }) => {
  const { t } = useTranslation();
  const [isDark, setIsDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const obs = new MutationObserver(() => setIsDark(document.documentElement.classList.contains('dark')));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  const stats = useMemo(() => {
    if (historyData.length < 5) return null;

    const rates = historyData.map(d => d.rate);
    const n = rates.length;
    
    const simpleAvg = rates.reduce((a, b) => a + b, 0) / n;
    
    let weightedSum = 0;
    let totalWeight = 0;
    for (let i = 0; i < n; i++) {
      const weight = (i + 1) / n;
      weightedSum += rates[i] * weight;
      totalWeight += weight;
    }
    const weightedAvg = weightedSum / totalWeight;
    
    const alpha = 2 / (n + 1);
    let ewa = rates[0];
    for (let i = 1; i < n; i++) {
      ewa = alpha * rates[i] + (1 - alpha) * ewa;
    }
    
    const yearlyData: Record<string, { sum: number; count: number }> = {};
    for (const point of historyData) {
      const year = point.date.split('-')[0];
      if (!yearlyData[year]) yearlyData[year] = { sum: 0, count: 0 };
      yearlyData[year].sum += point.rate;
      yearlyData[year].count++;
    }
    const yearlyAvgs = Object.entries(yearlyData).map(([year, d]) => ({
      year,
      avg: d.sum / d.count,
      count: d.count,
    })).sort((a, b) => a.year.localeCompare(b.year));
    
    const currentVsSimple = ((currentRate - simpleAvg) / simpleAvg) * 100;
    const currentVsWeighted = ((currentRate - weightedAvg) / weightedAvg) * 100;
    
    let annualTrend = 0;
    if (yearlyAvgs.length >= 2) {
      const first = yearlyAvgs[0].avg;
      const last = yearlyAvgs[yearlyAvgs.length - 1].avg;
      const years = yearlyAvgs.length - 1;
      annualTrend = ((last / first) - 1) * 100 / years;
    }
    
    const monthlyAmount = 5000;
    const currentMonthly = monthlyAmount * currentRate;
    const avgMonthly = monthlyAmount * weightedAvg;
    const monthlyDiff = currentMonthly - avgMonthly;
    const annualDiff = monthlyDiff * 12;

    return { simpleAvg, weightedAvg, ewa, yearlyAvgs, currentVsSimple, currentVsWeighted, annualTrend, currentMonthly, avgMonthly, monthlyDiff, annualDiff };
  }, [historyData, currentRate]);

  if (!stats || historyData.length < 30) return null;

  const periodLabel = period === '5y' ? t('currency.period_5y') : period === '1y' ? t('currency.period_1y') : period === '6m' ? t('currency.period_6m') : period === '3m' ? t('currency.period_3m') : t('currency.period_1m');

  return (
    <div className="bg-gradient-to-br from-stripe-50 to-stripe-100 dark:from-stripe-950/20 dark:to-stripe-900/20 rounded-2xl border border-stripe-200 dark:border-stripe-800 p-4 sm:p-6 space-y-5">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-stripe-100 dark:bg-stripe-900/40 rounded-xl">
          <BarChart3 size={24} className="text-link" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100">📊 {t('currency.weighted_avg_stats')}</h2>
          <p className="text-sm text-subtle">
            {t('currency.weighted_avg_desc', { period: periodLabel })}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-surface rounded-xl p-4 text-center border border-edge">
          <div className="text-xs font-bold text-muted uppercase tracking-wider">{t('currency.current_rate')}</div>
          <div className="text-xl font-bold text-stripe-600">{currentRate.toFixed(4)}</div>
          <div className={`text-xs font-bold ${stats.currentVsWeighted >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
            {stats.currentVsWeighted >= 0 ? '↑' : '↓'} {Math.abs(stats.currentVsWeighted).toFixed(2)}% vs {t('currency.vs_average')}
          </div>
        </div>
        <div className="bg-surface rounded-xl p-4 text-center border border-edge">
          <div className="text-xs font-bold text-muted uppercase tracking-wider">{t('currency.simple_average')}</div>
          <div className="text-xl font-bold text-slate-700 dark:text-slate-200">{stats.simpleAvg.toFixed(4)}</div>
          <div className="text-xs text-muted">{historyData.length} {t('currency.data_points')}</div>
        </div>
        <div className="bg-stripe-50 dark:bg-stripe-900/20 rounded-xl p-4 text-center border-2 border-stripe-300 dark:border-stripe-700">
          <div className="text-xs font-bold text-stripe-600 uppercase tracking-wider">{t('currency.weighted_average')}</div>
          <div className="text-xl font-bold text-stripe-700 dark:text-stripe-300">{stats.weightedAvg.toFixed(4)}</div>
          <div className="text-xs text-stripe-500">⭐ {t('currency.more_reliable')}</div>
        </div>
        <div className="bg-surface rounded-xl p-4 text-center border border-edge">
          <div className="text-xs font-bold text-muted uppercase tracking-wider">{t('currency.exponential_average')}</div>
          <div className="text-xl font-bold text-slate-700 dark:text-slate-200">{stats.ewa.toFixed(4)}</div>
          <div className="text-xs text-muted">{t('currency.adaptive_ema')}</div>
        </div>
      </div>

      {stats.yearlyAvgs.length > 1 && (
        <div className="bg-surface rounded-xl p-4 border border-edge">
          <h3 className="font-bold text-sm text-body mb-3 flex items-center gap-2">
            <Calendar size={14} /> {t('currency.yearly_avg_rate')}
          </h3>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.yearlyAvgs} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#334155' : '#e2e8f0'} opacity={0.3} />
                <XAxis dataKey="year" tick={{ fontSize: 12, fill: isDark ? '#94a3b8' : '#64748b' }} />
                <YAxis domain={[
                  Math.min(...stats.yearlyAvgs.map(d => d.avg)) * 0.998,
                  Math.max(...stats.yearlyAvgs.map(d => d.avg)) * 1.002
                ]} tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b' }} tickFormatter={(v: number) => v.toFixed(3)} />
                <Tooltip formatter={(v: number) => [v.toFixed(5), t('currency.average')]} contentStyle={{ borderRadius: '12px', backgroundColor: isDark ? '#1e293b' : '#ffffff', color: isDark ? '#e2e8f0' : '#1e293b', border: 'none' }} />
                <Bar dataKey="avg" radius={[8, 8, 0, 0]}>
                  {stats.yearlyAvgs.map((entry, i) => (
                    <Cell key={entry.year} fill={i === stats.yearlyAvgs.length - 1 ? '#6366f1' : '#94a3b8'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="bg-gradient-to-r from-teal-600 to-emerald-700 rounded-xl px-5 py-4 text-white space-y-3">
        <h3 className="font-bold text-sm flex items-center gap-2">💰 {t('currency.impact_frontaliere')}</h3>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-white">
          <div><span className="text-lg font-semibold">€ {stats.currentMonthly.toFixed(0)}/{t('currency.month_abbr')}</span> <span className="text-sm text-white/80">{t('currency.at_current_rate')}</span></div>
          <div><span className="text-lg font-semibold">€ {stats.avgMonthly.toFixed(0)}/{t('currency.month_abbr')}</span> <span className="text-sm text-white/80">{t('currency.at_weighted_avg')}</span></div>
          <div>
            <span className={`text-lg font-semibold ${stats.annualDiff >= 0 ? 'text-emerald-300' : 'text-amber-300'}`}>
              {stats.annualDiff >= 0 ? '+' : ''}€ {stats.annualDiff.toFixed(0)}
            </span>
            {' '}<span className="text-sm text-white/80">{t('currency.annual_difference')} · {stats.annualDiff >= 0 ? `✅ ${t('currency.rate_favors_you')}` : `⚠️ ${t('currency.rate_below_average')}`}</span>
          </div>
        </div>
        {stats.annualTrend !== 0 && (
          <p className="text-xs text-white/90 text-center">
            {t('currency.avg_trend')}: {stats.annualTrend >= 0 ? '+' : ''}{stats.annualTrend.toFixed(3)}% {t('currency.annual')}
            {stats.annualTrend > 0 ? ` (${t('currency.eur_strengthens')})` : ` (${t('currency.chf_strengthens')})`}
          </p>
        )}
      </div>
    </div>
  );
};

// ── WeeklyExchangeAlert ──────────────────────────────────────

type WeeklyExchangeAlertPrefs = {
  enabled: boolean;
  targetRate: number;
  minPercentile: number;
  notifyDay: number;
  lastWeekNotified: string | null;
};

const WEEKLY_ALERT_STORAGE_KEY = 'ft_exchange_weekly_alert_v1';

const getIsoWeekKey = (date: Date): string => {
  const utcDate = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = utcDate.getUTCDay() || 7;
  utcDate.setUTCDate(utcDate.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utcDate.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((utcDate.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${utcDate.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
};

const WeeklyExchangeAlert: React.FC<{ currentRate: number; historyData: Array<{ date: string; rate: number }> }> = ({ currentRate, historyData }) => {
  const defaultPrefs: WeeklyExchangeAlertPrefs = {
    enabled: false,
    targetRate: Number((currentRate + 0.005).toFixed(4)),
    minPercentile: 65,
    notifyDay: 1,
    lastWeekNotified: null,
  };
  const [prefs, setPrefs] = useState<WeeklyExchangeAlertPrefs>(() => {
    try {
      const raw = localStorage.getItem(WEEKLY_ALERT_STORAGE_KEY);
      if (!raw) return defaultPrefs;
      return { ...defaultPrefs, ...(JSON.parse(raw) as Partial<WeeklyExchangeAlertPrefs>) };
    } catch {
      return defaultPrefs;
    }
  });
  const [inlineNotice, setInlineNotice] = useState<string | null>(null);
  const volatility = useMemo(() => analyzeVolatility(historyData), [historyData]);
  const percentile = volatility?.percentile ?? 50;

  useEffect(() => {
    localStorage.setItem(WEEKLY_ALERT_STORAGE_KEY, JSON.stringify(prefs));
  }, [prefs]);

  useEffect(() => {
    if (!prefs.enabled) return;
    const now = new Date();
    const jsDay = now.getDay();
    const day = jsDay === 0 ? 7 : jsDay;
    if (day !== prefs.notifyDay) return;

    const currentWeek = getIsoWeekKey(now);
    if (prefs.lastWeekNotified === currentWeek) return;

    const reached = currentRate >= prefs.targetRate && percentile >= prefs.minPercentile;
    if (!reached) return;

    const nextPrefs = { ...prefs, lastWeekNotified: currentWeek };
    setPrefs(nextPrefs);
    setInlineNotice(`Segnale favorevole: ${currentRate.toFixed(4)} (percentile ${percentile.toFixed(0)}%).`);
  }, [prefs, currentRate, percentile]);

  const dayOptions = [
    { value: 1, label: 'Lunedi' },
    { value: 2, label: 'Martedi' },
    { value: 3, label: 'Mercoledi' },
    { value: 4, label: 'Giovedi' },
    { value: 5, label: 'Venerdi' },
  ];

  return (
    <div className="bg-surface rounded-2xl border border-edge p-5 space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
          <Bell size={16} className="text-stripe-600" />
          Alert settimanale cambio CHF→EUR
        </h3>
        <button
          type="button"
          onClick={() => setPrefs(prev => ({ ...prev, enabled: !prev.enabled }))}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${prefs.enabled ? 'bg-emerald-600 text-white' : 'bg-slate-200 dark:bg-slate-700 text-body'}`}
          aria-label={prefs.enabled ? 'Disattiva alert' : 'Attiva alert'}
        >
          {prefs.enabled ? 'Attivo' : 'Disattivo'}
        </button>
      </div>

      <div className="grid sm:grid-cols-3 gap-3">
        <label className="text-xs font-semibold text-subtle">
          Target minimo (EUR)
          <input
            type="number"
            inputMode="decimal"
            step="0.0001"
            min="0.8"
            max="1.3"
            value={prefs.targetRate}
            onChange={(e) => setPrefs(prev => ({ ...prev, targetRate: Number(e.target.value) || prev.targetRate }))}
            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-surface-alt text-slate-800 dark:text-slate-100"
            aria-label="Target minimo tasso di cambio in EUR"
          />
        </label>
        <label className="text-xs font-semibold text-subtle">
          Percentile minimo
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={99}
            value={prefs.minPercentile}
            onChange={(e) => setPrefs(prev => ({ ...prev, minPercentile: Math.max(1, Math.min(99, Number(e.target.value) || prev.minPercentile)) }))}
            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-surface-alt text-slate-800 dark:text-slate-100"
            aria-label="Percentile minimo per notifica"
          />
        </label>
        <label className="text-xs font-semibold text-subtle">
          Giorno check
          <select
            value={prefs.notifyDay}
            onChange={(e) => setPrefs(prev => ({ ...prev, notifyDay: Number(e.target.value) }))}
            className="mt-1 w-full px-3 py-2 rounded-lg border border-slate-300 dark:border-slate-600 bg-surface-alt text-slate-800 dark:text-slate-100"
            aria-label="Seleziona giorno della settimana per notifica"
          >
            {dayOptions.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
          </select>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-subtle">
        <span className="px-2 py-1 rounded bg-surface-raised">Tasso attuale: {currentRate.toFixed(4)}</span>
        <span className="px-2 py-1 rounded bg-surface-raised">Percentile: {percentile.toFixed(0)}%</span>
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('navigate-tab', {
              detail: { tab: 'weekly-digest' },
            }));
          }}
          className="px-2.5 py-1 rounded-lg bg-stripe-600 text-white font-semibold hover:bg-stripe-700 transition-colors flex items-center gap-1"
        >
          <Mail size={12} />
          Ricevi alert via email
        </button>
      </div>

      {inlineNotice && (
        <div className="text-xs font-semibold text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-lg px-3 py-2">
          {inlineNotice}
        </div>
      )}
    </div>
  );
};

// ── Main exported component ──────────────────────────────────

interface CurrencyExchangeStatsProps {
  historyData: Array<{ date: string; rate: number }>;
  currentRate: number;
  period: string;
}

const CurrencyExchangeStats: React.FC<CurrencyExchangeStatsProps> = ({ historyData, currentRate, period }) => {
  return (
    <div className="min-h-[60vh] space-y-6">
      <WeightedAverageStats historyData={historyData} currentRate={currentRate} period={period} />
      <EnhancedHistoricalStats historyData={historyData} />
      <WeeklyExchangeAlert currentRate={currentRate} historyData={historyData} />
      <ExchangeTimingSection historyData={historyData} />
    </div>
  );
};

export default CurrencyExchangeStats;
