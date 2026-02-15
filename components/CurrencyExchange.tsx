import React, { useState, useEffect, useMemo } from 'react';
import { ArrowRightLeft, TrendingDown, TrendingUp, AlertCircle, CheckCircle2, Info, DollarSign, Percent, Calculator, RefreshCw, BarChart3, Clock, Calendar, FlaskConical, Zap, ChartBar, ArrowLeftRight } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell } from 'recharts';
import { Analytics } from '@/services/analytics';
import { useTranslation } from '@/services/i18n';

interface ExchangeProvider {
  name: string;
  logo: string;
  commission: number; // Flat fee in CHF
  commissionPercent: number; // Percentage fee
  exchangeRateMarkup: number; // Markup over real rate (e.g., 0.01 = 1%)
  minAmount: number;
  maxAmount: number;
  transferTime: string;
  color: string;
  features: string[];
  type: 'neobank' | 'traditional' | 'service';
  referralUrl?: string; // Optional referral link
  transferTimeKey: string;
  featureKeys: string[];
}

const providers: ExchangeProvider[] = [
  {
    name: 'Wise (TransferWise)',
    logo: '🌍',
    commission: 0,
    commissionPercent: 0.35,
    exchangeRateMarkup: 0, // Uses real mid-market rate
    minAmount: 1,
    maxAmount: 1000000,
    transferTime: '1-2 giorni lavorativi',
    transferTimeKey: '1_2_business_days',
    color: 'from-emerald-500 to-teal-600',
    features: ['Tasso medio di mercato reale', 'Trasparenza totale', 'Sconto volume: 0.20% sopra 22k EUR/mese'],
    featureKeys: ['feature_real_market_rate', 'feature_total_transparency', 'feature_wise_volume_discount'],
    type: 'service',
    referralUrl: 'https://wise.com/invite/dic/luigis147'
  },
  {
    name: 'Revolut',
    logo: '💳',
    commission: 0,
    commissionPercent: 0,
    exchangeRateMarkup: 0.005, // ~0.5% fair usage fee over 1000 EUR/month on Standard
    minAmount: 0,
    maxAmount: 50000,
    transferTime: 'Istantaneo',
    transferTimeKey: 'instant',
    color: 'from-blue-500 to-indigo-600',
    features: ['Cambio gratuito fino a 1000 EUR/mese (Standard)', 'Oltre limite: 1% commissione uso corretto', 'Weekend: markup 1%'],
    featureKeys: ['feature_free_exchange_1000', 'feature_fair_usage_1pct', 'feature_weekend_markup_1pct'],
    type: 'neobank'
  },
  {
    name: 'Yuh',
    logo: '🇨🇭',
    commission: 0,
    commissionPercent: 0,
    exchangeRateMarkup: 0.009, // ~0.9% markup
    minAmount: 0,
    maxAmount: 100000,
    transferTime: 'Istantaneo',
    transferTimeKey: 'instant',
    color: 'from-purple-500 to-pink-600',
    features: ['100% digitale', 'Nessuna commissione dichiarata', 'Spread nascosto ~0.9%'],
    featureKeys: ['feature_100_digital', 'feature_no_declared_commission', 'feature_hidden_spread_09'],
    type: 'neobank'
  },
  {
    name: 'PostFinance',
    logo: '📮',
    commission: 0,
    commissionPercent: 0,
    exchangeRateMarkup: 0.025, // ~2.5% markup
    minAmount: 0,
    maxAmount: 500000,
    transferTime: '1-3 giorni lavorativi',
    transferTimeKey: '1_3_business_days',
    color: 'from-yellow-500 to-orange-600',
    features: ['Nessuna commissione dichiarata', 'Tasso sfavorevole', 'Spread nascosto ~2-3%'],
    featureKeys: ['feature_no_declared_commission', 'feature_unfavorable_rate', 'feature_hidden_spread_2_3'],
    type: 'traditional'
  },
  {
    name: 'UBS',
    logo: '🏦',
    commission: 5,
    commissionPercent: 0.1,
    exchangeRateMarkup: 0.03, // ~3% markup
    minAmount: 0,
    maxAmount: 1000000,
    transferTime: '2-4 giorni lavorativi',
    transferTimeKey: '2_4_business_days',
    color: 'from-red-500 to-pink-600',
    features: ['Commissioni fisse + spread', 'Tasso molto sfavorevole', 'Costi nascosti elevati'],
    featureKeys: ['feature_fixed_commission_spread', 'feature_very_unfavorable_rate', 'feature_high_hidden_costs'],
    type: 'traditional'
  },
  {
    name: 'Credit Suisse',
    logo: '🏛️',
    commission: 5,
    commissionPercent: 0.15,
    exchangeRateMarkup: 0.028, // ~2.8% markup
    minAmount: 0,
    maxAmount: 1000000,
    transferTime: '2-4 giorni lavorativi',
    transferTimeKey: '2_4_business_days',
    color: 'from-slate-500 to-gray-600',
    features: ['Commissioni + spread', 'Servizio tradizionale', 'Poco trasparente'],
    featureKeys: ['feature_commission_spread', 'feature_traditional_service', 'feature_not_transparent'],
    type: 'traditional'
  },
  {
    name: 'Fineco Bank',
    logo: '🇮🇹',
    commission: 0,
    commissionPercent: 0.5,
    exchangeRateMarkup: 0.018, // ~1.8% markup
    minAmount: 0,
    maxAmount: 100000,
    transferTime: '1-3 giorni lavorativi',
    transferTimeKey: '1_3_business_days',
    color: 'from-sky-500 to-blue-600',
    features: ['Banca digitale italiana', 'Commissione 0.5%', 'Spread nascosto ~1.8%'],
    featureKeys: ['feature_italian_digital_bank', 'feature_commission_05', 'feature_hidden_spread_18'],
    type: 'traditional'
  },
  {
    name: 'Intesa Sanpaolo',
    logo: '🏦',
    commission: 5,
    commissionPercent: 0.25,
    exchangeRateMarkup: 0.032, // ~3.2% markup
    minAmount: 0,
    maxAmount: 500000,
    transferTime: '2-5 giorni lavorativi',
    transferTimeKey: '2_5_business_days',
    color: 'from-blue-600 to-indigo-700',
    features: ['Commissione fissa + 0.25%', 'Spread molto elevato', 'Servizio bancario classico'],
    featureKeys: ['feature_fixed_commission_025', 'feature_very_high_spread', 'feature_classic_banking'],
    type: 'traditional'
  },
  {
    name: 'Cariparma (Crédit Agricole)',
    logo: '🏛️',
    commission: 4,
    commissionPercent: 0.3,
    exchangeRateMarkup: 0.028, // ~2.8% markup
    minAmount: 0,
    maxAmount: 500000,
    transferTime: '2-4 giorni lavorativi',
    transferTimeKey: '2_4_business_days',
    color: 'from-green-600 to-teal-700',
    features: ['Commissione 4 CHF + 0.3%', 'Spread nascosto ~2.8%', 'Gruppo Crédit Agricole'],
    featureKeys: ['feature_commission_4chf_03', 'feature_hidden_spread_28', 'feature_credit_agricole_group'],
    type: 'traditional'
  },
  {
    name: 'UniCredit',
    logo: '🏦',
    commission: 5,
    commissionPercent: 0.2,
    exchangeRateMarkup: 0.03, // ~3% markup
    minAmount: 0,
    maxAmount: 500000,
    transferTime: '2-5 giorni lavorativi',
    transferTimeKey: '2_5_business_days',
    color: 'from-red-600 to-rose-700',
    features: ['Commissione 5 CHF + 0.2%', 'Spread ~3%', 'Banca europea'],
    featureKeys: ['feature_commission_5chf_02', 'feature_spread_3', 'feature_european_bank'],
    type: 'traditional'
  },
  {
    name: 'Banco BPM',
    logo: '🏦',
    commission: 4.5,
    commissionPercent: 0.25,
    exchangeRateMarkup: 0.029, // ~2.9% markup
    minAmount: 0,
    maxAmount: 300000,
    transferTime: '2-4 giorni lavorativi',
    transferTimeKey: '2_4_business_days',
    color: 'from-orange-600 to-amber-700',
    features: ['Commissione 4.5 CHF + 0.25%', 'Spread nascosto ~2.9%', 'Gruppo bancario italiano'],
    featureKeys: ['feature_commission_45chf_025', 'feature_hidden_spread_29', 'feature_italian_banking_group'],
    type: 'traditional'
  },
  {
    name: 'Cambiovalute.ch',
    logo: '🇨🇭',
    commission: 0,
    commissionPercent: 0,
    exchangeRateMarkup: 0.0035, // ~0.35% spread
    minAmount: 100,
    maxAmount: 500000,
    transferTime: '1-2 giorni lavorativi',
    transferTimeKey: '1_2_business_days',
    color: 'from-cyan-500 to-blue-600',
    features: ['Servizio svizzero specializzato', 'Spread competitivo ~0.35%', 'Bonifico diretto su conto italiano'],
    featureKeys: ['feature_swiss_specialized_service', 'feature_competitive_spread_035', 'feature_direct_transfer_italy'],
    type: 'service',
    referralUrl: 'https://www.cambiovalute.ch'
  }
];

// --- Exchange Timing Analysis (Experimental) ---
const DAY_KEYS = ['day_mon', 'day_tue', 'day_wed', 'day_thu', 'day_fri', 'day_sat', 'day_sun'];
const MONTH_KEYS = ['month_jan', 'month_feb', 'month_mar', 'month_apr', 'month_may', 'month_jun', 'month_jul', 'month_aug', 'month_sep', 'month_oct', 'month_nov', 'month_dec'];

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

  // Day of week analysis (0=Monday, 6=Sunday)
  const dayBuckets: { sum: number; count: number }[] = Array.from({ length: 7 }, () => ({ sum: 0, count: 0 }));
  const monthBuckets: { sum: number; count: number }[] = Array.from({ length: 12 }, () => ({ sum: 0, count: 0 }));

  for (const point of historyData) {
    const d = new Date(point.date);
    const dow = (d.getDay() + 6) % 7; // Monday = 0
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

  // Higher rate = more EUR per CHF = better for the frontaliere
  const activeDays = dayOfWeek.filter(d => d.sampleCount > 0);
  const bestDay = activeDays.reduce((a, b) => a.avgRate > b.avgRate ? a : b).day;
  const worstDay = activeDays.reduce((a, b) => a.avgRate < b.avgRate ? a : b).day;
  const bestMonth = monthOfYear.reduce((a, b) => a.avgRate > b.avgRate ? a : b).month;
  const worstMonth = monthOfYear.reduce((a, b) => a.avgRate < b.avgRate ? a : b).month;

  return { dayOfWeek, monthOfYear, bestDay, worstDay, bestMonth, worstMonth };
}

// Volatility & advanced stats
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

  // Weekly changes
  const weeklyChanges: number[] = [];
  for (let i = 5; i < rates.length; i++) {
    weeklyChanges.push(((rates[i] - rates[i - 5]) / rates[i - 5]) * 100);
  }
  const avgWeeklyChange = weeklyChanges.length > 0 ? weeklyChanges.reduce((a, b) => a + b, 0) / weeklyChanges.length : 0;
  const maxWeeklyGain = weeklyChanges.length > 0 ? Math.max(...weeklyChanges) : 0;
  const maxWeeklyLoss = weeklyChanges.length > 0 ? Math.min(...weeklyChanges) : 0;

  // Streak analysis
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

const ExchangeTimingSection: React.FC<{ historyData: Array<{ date: string; rate: number }> }> = ({ historyData }) => {
  const { t } = useTranslation();
  const timing = useMemo(() => analyzeTimingPatterns(historyData), [historyData]);
  const volatility = useMemo(() => analyzeVolatility(historyData), [historyData]);

  if (!timing) return null;

  const dayMin = Math.min(...timing.dayOfWeek.filter(d => d.sampleCount > 0).map(d => d.avgRate));
  const dayMax = Math.max(...timing.dayOfWeek.filter(d => d.sampleCount > 0).map(d => d.avgRate));
  const monthMin = Math.min(...timing.monthOfYear.map(m => m.avgRate));
  const monthMax = Math.max(...timing.monthOfYear.map(m => m.avgRate));

  return (
    <div className="bg-gradient-to-br from-amber-50 to-orange-50 dark:from-amber-950/20 dark:to-orange-950/20 rounded-2xl border-2 border-dashed border-amber-300 dark:border-amber-700 p-6 space-y-5">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-amber-100 dark:bg-amber-900/40 rounded-xl">
          <FlaskConical size={24} className="text-amber-600 dark:text-amber-400" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-xl font-extrabold text-slate-800 dark:text-slate-100">{t('currency.when_to_exchange')}</h3>
            <span className="px-2 py-0.5 bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200 text-[10px] font-black uppercase rounded-full tracking-wider">{t('currency.experimental')}</span>
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-500 mt-0.5">
            {t('currency.timing_analysis_desc')}
          </p>
        </div>
      </div>

      {/* Recommendations */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={18} className="text-emerald-600" />
            <span className="font-bold text-emerald-700 dark:text-emerald-400 text-sm">{t('currency.best_time')}</span>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-slate-600 dark:text-slate-500">{t('currency.day_of_week')}</span>
              <span className="font-extrabold text-emerald-600">{t(`currency.${timing.bestDay}`)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-600 dark:text-slate-500">{t('currency.month_of_year')}</span>
              <span className="font-extrabold text-emerald-600">{t(`currency.${timing.bestMonth}`)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-600 dark:text-slate-500">{t('currency.recommended_time')}</span>
              <span className="font-extrabold text-emerald-600">10:00–12:00</span>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-red-200 dark:border-red-800">
          <div className="flex items-center gap-2 mb-3">
            <TrendingDown size={18} className="text-red-600" />
            <span className="font-bold text-red-700 dark:text-red-400 text-sm">{t('currency.avoid')}</span>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-slate-600 dark:text-slate-500">{t('currency.day_of_week')}</span>
              <span className="font-extrabold text-red-600">{t(`currency.${timing.worstDay}`)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-600 dark:text-slate-500">{t('currency.month_of_year')}</span>
              <span className="font-extrabold text-red-600">{t(`currency.${timing.worstMonth}`)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-600 dark:text-slate-500">{t('currency.unfavorable_time')}</span>
              <span className="font-extrabold text-red-600">{t('currency.weekend_17plus')}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Day of Week Chart */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <h4 className="font-bold text-sm text-slate-700 dark:text-slate-300 mb-3 flex items-center gap-2">
          <Calendar size={14} /> {t('currency.avg_rate_by_day')}
        </h4>
        <div className="h-[180px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={timing.dayOfWeek.filter(d => d.sampleCount > 0)} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="day" tick={{ fontSize: 12 }} tickFormatter={(v: string) => t(`currency.${v}`)} />
              <YAxis domain={[dayMin * 0.999, dayMax * 1.001]} tick={{ fontSize: 11 }} tickFormatter={(v: number) => v.toFixed(4)} />
              <Tooltip formatter={(v: number) => v.toFixed(5)} />
              <Bar dataKey="avgRate" radius={[6, 6, 0, 0]}>
                {timing.dayOfWeek.filter(d => d.sampleCount > 0).map((entry) => (
                  <Cell key={entry.day} fill={entry.day === timing.bestDay ? '#10b981' : entry.day === timing.worstDay ? '#ef4444' : '#8b5cf6'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Month Chart */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <h4 className="font-bold text-sm text-slate-700 dark:text-slate-300 mb-3 flex items-center gap-2">
          <Clock size={14} /> {t('currency.avg_rate_by_month')}
        </h4>
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={timing.monthOfYear} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} tickFormatter={(v: string) => t(`currency.${v}`)} />
              <YAxis domain={[monthMin * 0.998, monthMax * 1.002]} tick={{ fontSize: 11 }} tickFormatter={(v: number) => v.toFixed(4)} />
              <Tooltip formatter={(v: number) => v.toFixed(5)} />
              <Bar dataKey="avgRate" radius={[6, 6, 0, 0]}>
                {timing.monthOfYear.map((entry) => (
                  <Cell key={entry.month} fill={entry.month === timing.bestMonth ? '#10b981' : entry.month === timing.worstMonth ? '#ef4444' : '#6366f1'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Tips */}
      <div className="bg-amber-100/50 dark:bg-amber-900/20 rounded-xl p-4 text-sm">
        <div className="flex items-start gap-2">
          <Zap size={16} className="text-amber-600 mt-0.5 flex-shrink-0" />
          <div className="text-slate-700 dark:text-slate-300 space-y-1">
            <p className="font-bold text-amber-800 dark:text-amber-300">{t('currency.timing_tips_title')}</p>
            <ul className="list-disc ml-4 space-y-1 text-slate-600 dark:text-slate-500">
              <li><strong>{t('currency.tip_morning_label')}:</strong> {t('currency.tip_morning')}</li>
              <li><strong>{t('currency.tip_avoid_weekend_label')}:</strong> {t('currency.tip_avoid_weekend')}</li>
              <li><strong>{t('currency.tip_end_month_label')}:</strong> {t('currency.tip_end_month')}</li>
              <li><strong>{t('currency.tip_dont_wait_label')}:</strong> {t('currency.tip_dont_wait')}</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Volatility Analysis */}
      {volatility && (
        <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-purple-200 dark:border-purple-800 space-y-4">
          <h4 className="font-extrabold text-sm text-purple-700 dark:text-purple-300 flex items-center gap-2">
            📈 {t('currency.volatility_trend_analysis')}
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 text-center">
              <div className="text-[10px] font-bold text-purple-500 uppercase tracking-wider">{t('currency.current_rate')}</div>
              <div className="text-lg font-black text-purple-700 dark:text-purple-300">{volatility.current.toFixed(4)}</div>
              <div className="text-[10px] text-slate-500">
                {volatility.percentile > 70 ? `🟢 ${t('currency.high_in_range')}` : volatility.percentile < 30 ? `🔴 ${t('currency.low_in_range')}` : `🟡 ${t('currency.in_average')}`}
              </div>
            </div>
            <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 text-center">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{t('currency.range_min_max')}</div>
              <div className="text-sm font-bold text-slate-700 dark:text-slate-200">{volatility.min.toFixed(4)} – {volatility.max.toFixed(4)}</div>
              <div className="text-[10px] text-slate-500">Δ {(volatility.range * 100).toFixed(2)}%</div>
            </div>
            <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 text-center">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{t('currency.volatility_sigma')}</div>
              <div className="text-sm font-bold text-slate-700 dark:text-slate-200">{volatility.stdDev.toFixed(5)}</div>
              <div className="text-[10px] text-slate-500">{volatility.stdDev < 0.005 ? `😴 ${t('currency.stable')}` : volatility.stdDev < 0.015 ? `⚡ ${t('currency.moderate')}` : `🌊 ${t('currency.high')}`}</div>
            </div>
            <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 text-center">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{t('currency.current_trend')}</div>
              <div className="text-sm font-bold text-slate-700 dark:text-slate-200">
                {volatility.streakDirection === 'up' ? '📈' : volatility.streakDirection === 'down' ? '📉' : '➡️'} {volatility.currentStreak}{t('currency.days_abbr')} {volatility.streakDirection === 'up' ? t('currency.going_up') : volatility.streakDirection === 'down' ? t('currency.going_down') : t('currency.stable')}
              </div>
              <div className="text-[10px] text-slate-500">
                {volatility.streakDirection === 'up' ? `✅ ${t('currency.good_time_to_exchange')}` : volatility.streakDirection === 'down' ? `⏳ ${t('currency.maybe_wait')}` : `🤷 ${t('currency.neutral')}`}
              </div>
            </div>
          </div>
          {/* Percentile bar */}
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-slate-500">
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
            <div className="text-center text-xs font-bold text-slate-600 dark:text-slate-500">
              {t('currency.percentile')}: {volatility.percentile.toFixed(0)}%
              {volatility.percentile > 70 ? ` — 🎯 ${t('currency.favorable_moment')}` : volatility.percentile < 30 ? ` — ⏰ ${t('currency.low_rate_wait')}` : ` — ${t('currency.normal')}`}
            </div>
          </div>
        </div>
      )}

      {/* Life Hacks */}
      <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/20 dark:to-teal-950/20 rounded-xl p-5 border border-emerald-200 dark:border-emerald-800 space-y-3">
        <h4 className="font-extrabold text-sm text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
          🎯 {t('currency.life_hacks_title')}
        </h4>
        <div className="grid sm:grid-cols-2 gap-2">
          {[
            { emoji: '🏧', text: t('currency.hack_atm_monday') },
            { emoji: '📱', text: t('currency.hack_wise_revolut') },
            { emoji: '📅', text: t('currency.hack_end_month') },
            { emoji: '💡', text: t('currency.hack_split_exchange') },
            { emoji: '⚡', text: t('currency.hack_avoid_friday') },
            { emoji: '🔔', text: t('currency.hack_set_alert') },
          ].map((hack, i) => (
            <div key={i} className="flex items-start gap-2 bg-white/60 dark:bg-slate-800/60 rounded-lg p-2.5 text-xs text-slate-700 dark:text-slate-300">
              <span className="text-base flex-shrink-0">{hack.emoji}</span>
              <span>{hack.text}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Fun stat: how much 1000 CHF gives you on best vs worst day */}
      {volatility && (
        <div className="bg-gradient-to-r from-indigo-500 to-purple-600 rounded-xl p-5 text-white space-y-2">
          <h4 className="font-extrabold text-sm flex items-center gap-2">🧮 {t('currency.how_much_difference')}</h4>
          <div className="grid sm:grid-cols-3 gap-3 text-center">
            <div className="bg-white/15 rounded-lg p-3">
              <div className="text-[10px] uppercase tracking-wider text-white/70">{t('currency.1000chf_best_rate')}</div>
              <div className="text-xl font-black">€ {(1000 * volatility.max).toFixed(2)}</div>
            </div>
            <div className="bg-white/15 rounded-lg p-3">
              <div className="text-[10px] uppercase tracking-wider text-white/70">{t('currency.1000chf_worst_rate')}</div>
              <div className="text-xl font-black">€ {(1000 * volatility.min).toFixed(2)}</div>
            </div>
            <div className="bg-white/25 rounded-lg p-3 ring-2 ring-white/50">
              <div className="text-[10px] uppercase tracking-wider text-white/90">{t('currency.potential_difference')}</div>
              <div className="text-xl font-black text-amber-300">€ {(1000 * volatility.range).toFixed(2)}</div>
              <div className="text-[10px] text-white/70">{t('currency.on_1000chf_period')}</div>
            </div>
          </div>
          <p className="text-[11px] text-white/60 text-center mt-1">
            {t('currency.on_5000chf_annual')} <strong>€ {(5000 * volatility.range * 12).toFixed(0)}</strong>!
          </p>
        </div>
      )}
    </div>
  );
};

// --- 5-Year Weighted Average Stats ---
const WeightedAverageStats: React.FC<{
  historyData: Array<{ date: string; rate: number }>;
  currentRate: number;
  period: string;
}> = ({ historyData, currentRate, period }) => {
  const { t } = useTranslation();
  const stats = useMemo(() => {
    if (historyData.length < 5) return null;

    const rates = historyData.map(d => d.rate);
    const n = rates.length;
    
    // Simple average
    const simpleAvg = rates.reduce((a, b) => a + b, 0) / n;
    
    // Weighted average — more recent data weighted higher (linear decay)
    let weightedSum = 0;
    let totalWeight = 0;
    for (let i = 0; i < n; i++) {
      const weight = (i + 1) / n; // 0→1, newest data has highest weight
      weightedSum += rates[i] * weight;
      totalWeight += weight;
    }
    const weightedAvg = weightedSum / totalWeight;
    
    // Exponential weighted average (EWA) — alpha = 2/(N+1)
    const alpha = 2 / (n + 1);
    let ewa = rates[0];
    for (let i = 1; i < n; i++) {
      ewa = alpha * rates[i] + (1 - alpha) * ewa;
    }
    
    // Yearly averages
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
    
    // Quarterly averages
    const quarterlyData: Record<string, { sum: number; count: number }> = {};
    for (const point of historyData) {
      const d = new Date(point.date);
      const q = Math.ceil((d.getMonth() + 1) / 3);
      const key = `${d.getFullYear()}-Q${q}`;
      if (!quarterlyData[key]) quarterlyData[key] = { sum: 0, count: 0 };
      quarterlyData[key].sum += point.rate;
      quarterlyData[key].count++;
    }
    const quarterlyAvgs = Object.entries(quarterlyData).map(([quarter, d]) => ({
      quarter,
      avg: d.sum / d.count,
    })).sort((a, b) => a.quarter.localeCompare(b.quarter));
    
    // Current position relative to averages
    const currentVsSimple = ((currentRate - simpleAvg) / simpleAvg) * 100;
    const currentVsWeighted = ((currentRate - weightedAvg) / weightedAvg) * 100;
    
    // Annual trend (% change per year)
    let annualTrend = 0;
    if (yearlyAvgs.length >= 2) {
      const first = yearlyAvgs[0].avg;
      const last = yearlyAvgs[yearlyAvgs.length - 1].avg;
      const years = yearlyAvgs.length - 1;
      annualTrend = ((last / first) - 1) * 100 / years;
    }
    
    // Impact for a frontaliere: 5000 CHF/month
    const monthlyAmount = 5000;
    const currentMonthly = monthlyAmount * currentRate;
    const avgMonthly = monthlyAmount * weightedAvg;
    const monthlyDiff = currentMonthly - avgMonthly;
    const annualDiff = monthlyDiff * 12;

    return { simpleAvg, weightedAvg, ewa, yearlyAvgs, quarterlyAvgs, currentVsSimple, currentVsWeighted, annualTrend, currentMonthly, avgMonthly, monthlyDiff, annualDiff };
  }, [historyData, currentRate]);

  if (!stats || historyData.length < 30) return null;

  const periodLabel = period === '5y' ? t('currency.period_5y') : period === '1y' ? t('currency.period_1y') : period === '6m' ? t('currency.period_6m') : period === '3m' ? t('currency.period_3m') : t('currency.period_1m');

  return (
    <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/20 dark:to-indigo-950/20 rounded-2xl border border-blue-200 dark:border-blue-800 p-6 space-y-5">
      <div className="flex items-center gap-3">
        <div className="p-2 bg-blue-100 dark:bg-blue-900/40 rounded-xl">
          <BarChart3 size={24} className="text-blue-600 dark:text-blue-400" />
        </div>
        <div>
          <h3 className="text-xl font-extrabold text-slate-800 dark:text-slate-100">📊 {t('currency.weighted_avg_stats')}</h3>
          <p className="text-sm text-slate-600 dark:text-slate-500">
            {t('currency.weighted_avg_desc', { period: periodLabel })}
          </p>
        </div>
      </div>

      {/* Key Averages */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 text-center border border-slate-200 dark:border-slate-700">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{t('currency.current_rate')}</div>
          <div className="text-xl font-black text-indigo-600">{currentRate.toFixed(4)}</div>
          <div className={`text-[10px] font-bold ${stats.currentVsWeighted >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {stats.currentVsWeighted >= 0 ? '↑' : '↓'} {Math.abs(stats.currentVsWeighted).toFixed(2)}% vs {t('currency.vs_average')}
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 text-center border border-slate-200 dark:border-slate-700">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{t('currency.simple_average')}</div>
          <div className="text-xl font-black text-slate-700 dark:text-slate-200">{stats.simpleAvg.toFixed(4)}</div>
          <div className="text-[10px] text-slate-500">{historyData.length} {t('currency.data_points')}</div>
        </div>
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 text-center border-2 border-blue-300 dark:border-blue-700">
          <div className="text-[10px] font-bold text-blue-600 uppercase tracking-wider">{t('currency.weighted_average')}</div>
          <div className="text-xl font-black text-blue-700 dark:text-blue-300">{stats.weightedAvg.toFixed(4)}</div>
          <div className="text-[10px] text-blue-500">⭐ {t('currency.more_reliable')}</div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 text-center border border-slate-200 dark:border-slate-700">
          <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">{t('currency.exponential_average')}</div>
          <div className="text-xl font-black text-slate-700 dark:text-slate-200">{stats.ewa.toFixed(4)}</div>
          <div className="text-[10px] text-slate-500">{t('currency.adaptive_ema')}</div>
        </div>
      </div>

      {/* Yearly Chart */}
      {stats.yearlyAvgs.length > 1 && (
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
          <h4 className="font-bold text-sm text-slate-700 dark:text-slate-300 mb-3 flex items-center gap-2">
            <Calendar size={14} /> {t('currency.yearly_avg_rate')}
          </h4>
          <div className="h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.yearlyAvgs} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="year" tick={{ fontSize: 12 }} />
                <YAxis domain={[
                  Math.min(...stats.yearlyAvgs.map(d => d.avg)) * 0.998,
                  Math.max(...stats.yearlyAvgs.map(d => d.avg)) * 1.002
                ]} tick={{ fontSize: 11 }} tickFormatter={(v: number) => v.toFixed(3)} />
                <Tooltip formatter={(v: number) => v.toFixed(5)} />
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

      {/* Impact Calculator */}
      <div className="bg-gradient-to-r from-indigo-500 to-blue-600 rounded-xl p-5 text-white space-y-3">
        <h4 className="font-extrabold text-sm flex items-center gap-2">💰 {t('currency.impact_frontaliere')}</h4>
        <div className="grid sm:grid-cols-3 gap-3 text-center">
          <div className="bg-white/15 rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-wider text-white/70">{t('currency.at_current_rate')}</div>
            <div className="text-xl font-black">€ {stats.currentMonthly.toFixed(0)}/{t('currency.month_abbr')}</div>
          </div>
          <div className="bg-white/15 rounded-lg p-3">
            <div className="text-[10px] uppercase tracking-wider text-white/70">{t('currency.at_weighted_avg')}</div>
            <div className="text-xl font-black">€ {stats.avgMonthly.toFixed(0)}/{t('currency.month_abbr')}</div>
          </div>
          <div className="bg-white/25 rounded-lg p-3 ring-2 ring-white/50">
            <div className="text-[10px] uppercase tracking-wider text-white/90">{t('currency.annual_difference')}</div>
            <div className={`text-xl font-black ${stats.annualDiff >= 0 ? 'text-emerald-300' : 'text-amber-300'}`}>
              {stats.annualDiff >= 0 ? '+' : ''}€ {stats.annualDiff.toFixed(0)}
            </div>
            <div className="text-[10px] text-white/70">
              {stats.annualDiff >= 0 ? `✅ ${t('currency.rate_favors_you')}` : `⚠️ ${t('currency.rate_below_average')}`}
            </div>
          </div>
        </div>
        {stats.annualTrend !== 0 && (
          <p className="text-[11px] text-white/60 text-center">
            {t('currency.avg_trend')}: {stats.annualTrend >= 0 ? '+' : ''}{stats.annualTrend.toFixed(3)}% {t('currency.annual')}
            {stats.annualTrend > 0 ? ` (${t('currency.eur_strengthens')})` : ` (${t('currency.chf_strengthens')})`}
          </p>
        )}
      </div>
    </div>
  );
};

const CurrencyExchange: React.FC = () => {
  const { t } = useTranslation();
  const [amount, setAmount] = useState<number>(1000);
  const [realRate, setRealRate] = useState<number>(0.95);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [historyPeriod, setHistoryPeriod] = useState<'1m' | '3m' | '6m' | '1y' | '5y'>('6m');
  const [historyData, setHistoryData] = useState<Array<{ date: string; rate: number }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [exchangeSubTab, setExchangeSubTab] = useState<'overview' | 'statistics'>('overview');

  const fetchRealRate = async () => {
    setLoading(true);
    try {
      const res = await fetch('https://api.frankfurter.app/latest?from=CHF&to=EUR');
      const data = await res.json();
      if (data?.rates?.EUR) {
        setRealRate(data.rates.EUR);
        setLastUpdate(new Date());
      }
    } catch (e) {
      console.error("Failed to fetch rate", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRealRate();
    const interval = setInterval(fetchRealRate, 60000); // Update every minute
    return () => clearInterval(interval);
  }, []);

  // Fetch historical exchange rate data
  const fetchHistory = async (period: string) => {
    setHistoryLoading(true);
    try {
      const end = new Date();
      const start = new Date();
      switch (period) {
        case '1m': start.setMonth(end.getMonth() - 1); break;
        case '3m': start.setMonth(end.getMonth() - 3); break;
        case '6m': start.setMonth(end.getMonth() - 6); break;
        case '1y': start.setFullYear(end.getFullYear() - 1); break;
        case '5y': start.setFullYear(end.getFullYear() - 5); break;
      }
      const startStr = start.toISOString().split('T')[0];
      const endStr = end.toISOString().split('T')[0];
      const res = await fetch(`https://api.frankfurter.app/${startStr}..${endStr}?from=CHF&to=EUR`);
      const data = await res.json();
      if (data?.rates) {
        const points = Object.entries(data.rates).map(([date, rates]: [string, any]) => ({
          date,
          rate: rates.EUR,
        }));
        setHistoryData(points);
      }
    } catch (e) {
      console.error('Failed to fetch history', e);
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory(historyPeriod);
    Analytics.trackUIInteraction('comparatori', 'cambio_valuta', 'periodo_storico', 'cambio', historyPeriod);
  }, [historyPeriod]);

  const calculateExchange = (provider: ExchangeProvider) => {
    let markup = provider.exchangeRateMarkup;
    let commPct = provider.commissionPercent;

    // Revolut: free up to 1000 EUR/month, 1% fee above that
    if (provider.name === 'Revolut') {
      const freeLimit = 1000; // EUR/month free tier (Standard plan)
      const amountEur = amount * realRate;
      if (amountEur > freeLimit) {
        // Fair usage: 1% on the amount exceeding free limit
        const excessEur = amountEur - freeLimit;
        const fairUsageFee = excessEur * 0.01; // 1%
        commPct = (fairUsageFee / amountEur) * 100; // effective % on total
      } else {
        markup = 0; // Within free tier, no markup
      }
    }

    // Wise: volume discount above 22k EUR/month (0.20% instead of 0.35%)
    if (provider.name === 'Wise (TransferWise)') {
      const amountEur = amount * realRate;
      if (amountEur >= 22000) {
        commPct = 0.20; // Discounted rate for high volume
      }
    }

    const appliedRate = realRate * (1 - markup);
    const grossAmount = amount * appliedRate;
    const commissionFlat = provider.commission;
    const commissionPercent = grossAmount * (commPct / 100);
    const totalCommission = commissionFlat + commissionPercent;
    const netAmount = grossAmount - totalCommission;
    const effectiveRate = netAmount / amount;
    const totalCost = amount - netAmount / realRate; // Cost in CHF
    const costPercent = (totalCost / amount) * 100;

    return {
      appliedRate,
      grossAmount,
      commissionFlat,
      commissionPercent,
      totalCommission,
      netAmount,
      effectiveRate,
      totalCost,
      costPercent
    };
  };

  const results = providers.map(p => ({
    provider: p,
    ...calculateExchange(p)
  })).sort((a, b) => b.netAmount - a.netAmount);

  const best = results[0];
  const worst = results[results.length - 1];
  const savingsVsWorst = worst.totalCost - best.totalCost;

  return (
    <div className="max-w-7xl mx-auto space-y-6 animate-fade-in">
      {/* Header */}
      <div className="bg-gradient-to-br from-indigo-500 via-purple-500 to-pink-500 rounded-3xl p-8 text-white shadow-2xl">
        <div className="flex items-center gap-4 mb-4">
          <div className="p-3 bg-white/20 rounded-2xl backdrop-blur-sm">
            <ArrowRightLeft size={32} />
          </div>
          <div>
            <h1 className="text-3xl font-extrabold">{t('currency.title')}</h1>
            <p className="text-indigo-100 mt-1">{t('currency.subtitle')}</p>
          </div>
        </div>

        {/* Important Notice */}
        <div className="mt-6 p-4 bg-white/10 backdrop-blur-sm rounded-2xl border border-white/20">
          <div className="flex items-start gap-3">
            <AlertCircle size={24} className="flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-bold mb-2">⚠️ {t('currency.notice_title')}</p>
              <p className="text-indigo-100 leading-relaxed">
                {t('currency.notice_text')}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Sub-tab navigation */}
      <div className="flex gap-2 bg-white dark:bg-slate-800 rounded-2xl p-2 border border-slate-200 dark:border-slate-700 shadow-sm">
        <button
          onClick={() => { setExchangeSubTab('overview'); Analytics.trackUIInteraction('comparatori', 'cambio_valuta', 'tab_vista', 'click', 'overview'); }}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold transition-all ${
            exchangeSubTab === 'overview'
              ? 'bg-indigo-600 text-white shadow-lg'
              : 'text-slate-600 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700'
          }`}
        >
          <ArrowLeftRight size={16} />
          {t('currency.tab_compare')}
        </button>
        <button
          onClick={() => { setExchangeSubTab('statistics'); Analytics.trackUIInteraction('comparatori', 'cambio_valuta', 'tab_vista', 'click', 'statistics'); }}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold transition-all ${
            exchangeSubTab === 'statistics'
              ? 'bg-indigo-600 text-white shadow-lg'
              : 'text-slate-600 dark:text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-700'
          }`}
        >
          <ChartBar size={16} />
          {t('currency.tab_statistics')}
        </button>
      </div>

      {exchangeSubTab === 'overview' ? (
      <>
      {/* Calculator + History Side by Side */}
      <div className="grid lg:grid-cols-2 gap-6">
      {/* Calculator */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
            <Calculator size={20} className="text-indigo-600" />
            {t('currency.calculate_exchange')}
          </h3>
          <button
            onClick={fetchRealRate}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 rounded-xl text-xs font-bold hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-all disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {t('currency.refresh_rate')}
          </button>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-500 dark:text-slate-500 uppercase tracking-wide">{t('currency.amount_to_convert')}</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <span className="text-slate-500 font-bold">CHF</span>
              </div>
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(Math.max(0, parseFloat(e.target.value) || 0))}
                className="w-full pl-14 pr-4 py-3 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 outline-none transition-all font-bold text-slate-800 dark:text-slate-100 text-lg"
                placeholder="1000"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-500 dark:text-slate-500 uppercase tracking-wide flex items-center gap-2">
              {t('currency.real_market_rate')}
              <div className="group relative inline-flex items-center cursor-help">
                <Info size={12} className="text-slate-500" />
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-48 p-2.5 bg-slate-800 text-white text-[10px] font-medium leading-relaxed rounded-xl shadow-xl border border-slate-600 pointer-events-none z-50 text-center">
                  {t('currency.mid_market_tooltip')}
                </div>
              </div>
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <span className="text-slate-500 text-sm">1 CHF =</span>
              </div>
              <input
                type="text"
                value={`${realRate.toFixed(4)} EUR`}
                disabled
                className="w-full pl-20 pr-4 py-3 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-600 dark:text-slate-300 text-lg"
              />
            </div>
            {lastUpdate && (
              <p className="text-[10px] text-slate-500 text-right">
                {t('currency.updated')}: {lastUpdate.toLocaleTimeString('it-IT')}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* History Chart */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
            <BarChart3 size={20} className="text-indigo-600" />
            {t('currency.history_title')}
          </h3>
          <div className="flex gap-1.5">
            {(['1m', '3m', '6m', '1y', '5y'] as const).map(p => (
              <button key={p}
                onClick={() => setHistoryPeriod(p)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${historyPeriod === p ? 'bg-indigo-600 text-white shadow' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-600'}`}
              >
                {p === '1m' ? '1M' : p === '3m' ? '3M' : p === '6m' ? '6M' : p === '1y' ? '1A' : '5A'}
              </button>
            ))}
          </div>
        </div>
        {historyLoading ? (
          <div className="h-64 flex items-center justify-center text-slate-500">
            <RefreshCw size={24} className="animate-spin" />
          </div>
        ) : historyData.length > 0 ? (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={historyData}>
              <defs>
                <linearGradient id="colorRate" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v) => { const d = new Date(v); return `${d.getDate()}/${d.getMonth()+1}`; }} interval="preserveStartEnd" />
              <YAxis domain={['auto', 'auto']} tick={{ fontSize: 11 }} tickFormatter={(v: number) => v.toFixed(3)} />
              <Tooltip
                formatter={(value: number) => [`${value.toFixed(4)} EUR`, '1 CHF']}
                labelFormatter={(label) => new Date(label).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })}
              />
              <Area type="monotone" dataKey="rate" stroke="#6366f1" fill="url(#colorRate)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-64 flex items-center justify-center text-slate-500 text-sm">
            {t('currency.no_data_available')}
          </div>
        )}
        {historyData.length > 1 && (
          <div className="flex justify-between mt-3 text-xs text-slate-500">
            <span>Min: {Math.min(...historyData.map(d => d.rate)).toFixed(4)}</span>
            <span>{t('currency.average')}: {(historyData.reduce((s, d) => s + d.rate, 0) / historyData.length).toFixed(4)}</span>
            <span>Max: {Math.max(...historyData.map(d => d.rate)).toFixed(4)}</span>
          </div>
        )}
      </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {best.provider.referralUrl ? (
          <a
            href={best.provider.referralUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 rounded-2xl border-2 border-emerald-200 dark:border-emerald-800 p-6 hover:shadow-lg hover:border-emerald-400 transition-all cursor-pointer"
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-emerald-500 rounded-xl">
                <TrendingUp className="text-white" size={20} />
              </div>
              <div>
                <div className="text-xs font-bold text-emerald-600 dark:text-emerald-400 uppercase">{t('currency.best_offer')}</div>
                <div className="text-xl font-extrabold text-slate-800 dark:text-slate-100">{best.provider.name}</div>
              </div>
            </div>
            <div className="text-3xl font-extrabold text-emerald-600 mb-1">
              € {best.netAmount.toFixed(2)}
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-500">
              {t('currency.total_cost')}: <strong>CHF {best.totalCost.toFixed(2)}</strong> ({best.costPercent.toFixed(2)}%)
            </div>
            <div className="text-xs text-emerald-600 dark:text-emerald-400 mt-2 font-bold">
              👆 {t('currency.click_referral')}
            </div>
          </a>
        ) : (
          <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 rounded-2xl border-2 border-emerald-200 dark:border-emerald-800 p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-emerald-500 rounded-xl">
                <TrendingUp className="text-white" size={20} />
              </div>
              <div>
                <div className="text-xs font-bold text-emerald-600 dark:text-emerald-400 uppercase">{t('currency.best_offer')}</div>
                <div className="text-xl font-extrabold text-slate-800 dark:text-slate-100">{best.provider.name}</div>
              </div>
            </div>
            <div className="text-3xl font-extrabold text-emerald-600 mb-1">
              € {best.netAmount.toFixed(2)}
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-500">
              {t('currency.total_cost')}: <strong>CHF {best.totalCost.toFixed(2)}</strong> ({best.costPercent.toFixed(2)}%)
            </div>
          </div>
        )}

        <div className="bg-gradient-to-br from-red-50 to-orange-50 dark:from-red-950/30 dark:to-orange-950/30 rounded-2xl border-2 border-red-200 dark:border-red-800 p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 bg-red-500 rounded-xl">
              <TrendingDown className="text-white" size={20} />
            </div>
            <div>
              <div className="text-xs font-bold text-red-600 dark:text-red-400 uppercase">{t('currency.worst_offer')}</div>
              <div className="text-xl font-extrabold text-slate-800 dark:text-slate-100">{worst.provider.name}</div>
            </div>
          </div>
          <div className="text-3xl font-extrabold text-red-600 mb-1">
            € {worst.netAmount.toFixed(2)}
          </div>
          <div className="text-sm text-slate-600 dark:text-slate-500">
            {t('currency.total_cost')}: <strong>CHF {worst.totalCost.toFixed(2)}</strong> ({worst.costPercent.toFixed(2)}%)
          </div>
        </div>
      </div>

      <div className="bg-gradient-to-r from-amber-50 to-yellow-50 dark:from-amber-950/30 dark:to-yellow-950/30 rounded-2xl border border-amber-200 dark:border-amber-800 p-4">
        <div className="flex items-start gap-3">
          <DollarSign size={24} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-slate-700 dark:text-slate-300">
            <strong>{t('currency.potential_savings')}:</strong> {t('currency.savings_text', { best: best.provider.name, worst: worst.provider.name })} <strong className="text-amber-600">CHF {savingsVsWorst.toFixed(2)}</strong> {t('currency.on_this_conversion')}!
          </div>
        </div>
      </div>

      {/* Comparison Table */}
      <div>
        <h2 className="text-2xl font-extrabold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-4">
          <Percent size={24} className="text-indigo-600" />
          {t('currency.detailed_comparison')}
        </h2>
        <div className="grid md:grid-cols-2 gap-4">
        {results.map((result, idx) => {
          const isBest = idx === 0;
          const isWorst = idx === results.length - 1;
          
          const CardWrapper = result.provider.referralUrl ? 'a' : 'div';
          const cardProps = result.provider.referralUrl ? {
            href: result.provider.referralUrl,
            target: '_blank',
            rel: 'noopener noreferrer',
            className: `block bg-white dark:bg-slate-800 rounded-2xl border-2 p-6 hover:shadow-lg transition-all cursor-pointer ${
              isBest ? 'border-emerald-500 ring-2 ring-emerald-500/20 hover:ring-emerald-500/40' : isWorst ? 'border-red-500 ring-2 ring-red-500/20' : 'border-slate-200 dark:border-slate-700 hover:border-emerald-400'
            }`
          } : {
            className: `bg-white dark:bg-slate-800 rounded-2xl border-2 p-6 hover:shadow-lg transition-all ${
              isBest ? 'border-emerald-500 ring-2 ring-emerald-500/20' : isWorst ? 'border-red-500 ring-2 ring-red-500/20' : 'border-slate-200 dark:border-slate-700'
            }`
          };
          
          return (
            <CardWrapper
              key={result.provider.name}
              {...cardProps}
            >
              {isBest && (
                <div className="mb-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-500 text-white text-xs font-bold rounded-full">
                  <CheckCircle2 size={14} />
                  {t('currency.best_choice')}
                </div>
              )}

              <div className="flex items-start justify-between gap-4 mb-4">
                <div className="flex items-center gap-3">
                  <div className={`text-4xl p-3 bg-gradient-to-br ${result.provider.color} rounded-2xl`}>
                    {result.provider.logo}
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">{result.provider.name}</h3>
                    <p className="text-sm text-slate-500 dark:text-slate-500">{t(`currency.${result.provider.transferTimeKey}`)}</p>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">
                    € {result.netAmount.toFixed(2)}
                  </div>
                  <div className={`text-sm font-bold ${isBest ? 'text-emerald-600' : isWorst ? 'text-red-600' : 'text-slate-600 dark:text-slate-500'}`}>
                    {t('currency.cost')}: {result.costPercent.toFixed(2)}%
                  </div>
                </div>
              </div>

              <div className="grid md:grid-cols-3 gap-4 mb-4">
                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-xl">
                  <div className="text-xs text-slate-500 dark:text-slate-500 mb-1">{t('currency.applied_rate')}</div>
                  <div className="text-lg font-bold text-slate-800 dark:text-slate-100">
                    {result.appliedRate.toFixed(4)}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-500">
                    {result.provider.exchangeRateMarkup > 0 ? (
                      <span className="text-red-600">-{(result.provider.exchangeRateMarkup * 100).toFixed(2)}% spread</span>
                    ) : (
                      <span className="text-emerald-600">✓ {t('currency.real_rate')}</span>
                    )}
                  </div>
                </div>

                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-xl">
                  <div className="text-xs text-slate-500 dark:text-slate-500 mb-1">{t('currency.declared_commission')}</div>
                  <div className="text-lg font-bold text-slate-800 dark:text-slate-100">
                    {result.totalCommission.toFixed(2)} EUR
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-500">
                    {result.provider.commission > 0 && `CHF ${result.provider.commission} + `}
                    {result.provider.commissionPercent}%
                  </div>
                </div>

                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-xl">
                  <div className="text-xs text-slate-500 dark:text-slate-500 mb-1">{t('currency.real_total_cost')}</div>
                  <div className="text-lg font-bold text-slate-800 dark:text-slate-100">
                    CHF {result.totalCost.toFixed(2)}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-500">
                    {t('currency.commissions_spread')}
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-200 dark:border-slate-700 pt-3">
                <div className="flex flex-wrap gap-2">
                  {result.provider.featureKeys.map((featureKey, fidx) => (
                    <span
                      key={fidx}
                      className="px-2.5 py-1 bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-xs font-medium rounded-lg"
                    >
                      {t(`currency.${featureKey}`)}
                    </span>
                  ))}
                </div>
              </div>
            </CardWrapper>
          );
        })}
        </div>
      </div>

      {/* Experimental: Exchange Timing Analysis */}
      {/* Moved to Statistics subtab */}

      {/* Educational Section */}
      <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 rounded-2xl border border-blue-200 dark:border-blue-800 p-6">
        <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
          <Info size={20} className="text-blue-600" />
          {t('currency.how_hidden_spread_works')}
        </h3>
        
        <div className="space-y-4 text-sm text-slate-700 dark:text-slate-300">
          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-blue-600 mb-2">📊 {t('currency.practical_example_title')}:</p>
            <ul className="space-y-2 ml-4">
              <li><strong>{t('currency.example_real_rate')}:</strong> {t('currency.example_real_rate_text')}</li>
              <li><strong>{t('currency.example_traditional_bank')}:</strong> {t('currency.example_traditional_bank_text')}</li>
              <li><strong>{t('currency.example_hidden_cost')}:</strong> {t('currency.example_hidden_cost_text')}</li>
              <li><strong>{t('currency.example_wise')}:</strong> {t('currency.example_wise_text')}</li>
              <li><strong>{t('currency.example_savings')}:</strong> <strong className="text-emerald-600">{t('currency.example_savings_text')}</strong></li>
            </ul>
          </div>

          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-indigo-600 mb-2">💡 {t('currency.tips_to_save_title')}:</p>
            <ul className="space-y-1 ml-4 list-disc">
              <li>{t('currency.tip_use_wise')}</li>
              <li>{t('currency.tip_revolut_small')}</li>
              <li>{t('currency.tip_avoid_traditional')}</li>
              <li>{t('currency.tip_check_effective_rate')}</li>
              <li>{t('currency.tip_large_amounts')}</li>
            </ul>
          </div>
        </div>
      </div>
      </>
      ) : (
      <>
      {/* Statistics Sub-tab Content */}
      <WeightedAverageStats historyData={historyData} currentRate={realRate} period={historyPeriod} />
      <ExchangeTimingSection historyData={historyData} />
      </>
      )}
    </div>
  );
};

export default CurrencyExchange;
