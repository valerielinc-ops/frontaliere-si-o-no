import React, { useState, useEffect, useMemo } from 'react';
import { ArrowRightLeft, TrendingDown, TrendingUp, AlertCircle, CheckCircle2, Info, DollarSign, Percent, Calculator, RefreshCw, BarChart3, Clock, Calendar, FlaskConical, Zap } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell } from 'recharts';
import { Analytics } from '@/services/analytics';

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
}

const providers: ExchangeProvider[] = [
  {
    name: 'Wise (TransferWise)',
    logo: '🌍',
    commission: 0,
    commissionPercent: 0.43,
    exchangeRateMarkup: 0, // Uses real mid-market rate
    minAmount: 1,
    maxAmount: 1000000,
    transferTime: '1-2 giorni lavorativi',
    color: 'from-emerald-500 to-teal-600',
    features: ['Tasso medio di mercato reale', 'Trasparenza totale', 'App mobile eccellente'],
    type: 'service',
    referralUrl: 'https://wise.com/invite/dic/luigis147'
  },
  {
    name: 'Revolut',
    logo: '💳',
    commission: 0,
    commissionPercent: 0,
    exchangeRateMarkup: 0.005, // 0.5% markup on weekends, 0% on weekdays for premium
    minAmount: 0,
    maxAmount: 50000,
    transferTime: 'Istantaneo',
    color: 'from-blue-500 to-indigo-600',
    features: ['Cambio gratuito fino a 1000 CHF/mese', 'Weekend: markup 0.5-1%', 'Carta multi-valuta'],
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
    color: 'from-purple-500 to-pink-600',
    features: ['100% digitale', 'Nessuna commissione dichiarata', 'Spread nascosto ~0.9%'],
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
    color: 'from-yellow-500 to-orange-600',
    features: ['Nessuna commissione dichiarata', 'Tasso sfavorevole', 'Spread nascosto ~2-3%'],
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
    color: 'from-red-500 to-pink-600',
    features: ['Commissioni fisse + spread', 'Tasso molto sfavorevole', 'Costi nascosti elevati'],
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
    color: 'from-slate-500 to-gray-600',
    features: ['Commissioni + spread', 'Servizio tradizionale', 'Poco trasparente'],
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
    color: 'from-sky-500 to-blue-600',
    features: ['Banca digitale italiana', 'Commissione 0.5%', 'Spread nascosto ~1.8%'],
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
    color: 'from-blue-600 to-indigo-700',
    features: ['Commissione fissa + 0.25%', 'Spread molto elevato', 'Servizio bancario classico'],
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
    color: 'from-green-600 to-teal-700',
    features: ['Commissione 4 CHF + 0.3%', 'Spread nascosto ~2.8%', 'Gruppo Crédit Agricole'],
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
    color: 'from-red-600 to-rose-700',
    features: ['Commissione 5 CHF + 0.2%', 'Spread ~3%', 'Banca europea'],
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
    color: 'from-orange-600 to-amber-700',
    features: ['Commissione 4.5 CHF + 0.25%', 'Spread nascosto ~2.9%', 'Gruppo bancario italiano'],
    type: 'traditional'
  }
];

// --- Exchange Timing Analysis (Experimental) ---
const DAYS_IT = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
const MONTHS_IT = ['Gen', 'Feb', 'Mar', 'Apr', 'Mag', 'Giu', 'Lug', 'Ago', 'Set', 'Ott', 'Nov', 'Dic'];

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
    day: DAYS_IT[i],
    avgRate: b.count > 0 ? b.sum / b.count : 0,
    sampleCount: b.count,
  }));

  const monthOfYear = monthBuckets.map((b, i) => ({
    month: MONTHS_IT[i],
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
            <h3 className="text-xl font-extrabold text-slate-800 dark:text-slate-100">Quando Conviene Cambiare?</h3>
            <span className="px-2 py-0.5 bg-amber-200 dark:bg-amber-800 text-amber-800 dark:text-amber-200 text-[10px] font-black uppercase rounded-full tracking-wider">Sperimentale</span>
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">
            Analisi basata sullo storico del tasso CHF→EUR. Tendenze statistiche, non garanzie future.
          </p>
        </div>
      </div>

      {/* Recommendations */}
      <div className="grid md:grid-cols-2 gap-4">
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp size={18} className="text-emerald-600" />
            <span className="font-bold text-emerald-700 dark:text-emerald-400 text-sm">Momento Migliore</span>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-slate-600 dark:text-slate-400">Giorno della settimana</span>
              <span className="font-extrabold text-emerald-600">{timing.bestDay}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-600 dark:text-slate-400">Mese dell'anno</span>
              <span className="font-extrabold text-emerald-600">{timing.bestMonth}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-600 dark:text-slate-400">Orario consigliato</span>
              <span className="font-extrabold text-emerald-600">10:00–12:00</span>
            </div>
          </div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-red-200 dark:border-red-800">
          <div className="flex items-center gap-2 mb-3">
            <TrendingDown size={18} className="text-red-600" />
            <span className="font-bold text-red-700 dark:text-red-400 text-sm">Da Evitare</span>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between items-center">
              <span className="text-slate-600 dark:text-slate-400">Giorno della settimana</span>
              <span className="font-extrabold text-red-600">{timing.worstDay}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-600 dark:text-slate-400">Mese dell'anno</span>
              <span className="font-extrabold text-red-600">{timing.worstMonth}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-slate-600 dark:text-slate-400">Orario sfavorevole</span>
              <span className="font-extrabold text-red-600">Weekend / 17:00+</span>
            </div>
          </div>
        </div>
      </div>

      {/* Day of Week Chart */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-4 border border-slate-200 dark:border-slate-700">
        <h4 className="font-bold text-sm text-slate-700 dark:text-slate-300 mb-3 flex items-center gap-2">
          <Calendar size={14} /> Tasso Medio per Giorno della Settimana
        </h4>
        <div className="h-[180px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={timing.dayOfWeek.filter(d => d.sampleCount > 0)} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="day" tick={{ fontSize: 12 }} />
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
          <Clock size={14} /> Tasso Medio per Mese dell'Anno
        </h4>
        <div className="h-[200px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={timing.monthOfYear} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="month" tick={{ fontSize: 11 }} />
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
            <p className="font-bold text-amber-800 dark:text-amber-300">Consigli pratici per il timing:</p>
            <ul className="list-disc ml-4 space-y-1 text-slate-600 dark:text-slate-400">
              <li><strong>Mattina (10-12):</strong> I mercati europei sono aperti e il tasso tende a stabilizzarsi</li>
              <li><strong>Evita il weekend:</strong> Molte piattaforme (es. Revolut) applicano un markup extra sabato e domenica</li>
              <li><strong>Fine mese:</strong> Attento ai flussi salariali che possono influenzare il tasso</li>
              <li><strong>Non aspettare troppo:</strong> La differenza tra giorni è spesso marginale (&lt; 0.1%)</li>
            </ul>
          </div>
        </div>
      </div>

      {/* Volatility Analysis */}
      {volatility && (
        <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-purple-200 dark:border-purple-800 space-y-4">
          <h4 className="font-extrabold text-sm text-purple-700 dark:text-purple-300 flex items-center gap-2">
            📈 Analisi Volatilità & Trend
          </h4>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div className="bg-purple-50 dark:bg-purple-900/20 rounded-lg p-3 text-center">
              <div className="text-[10px] font-bold text-purple-500 uppercase tracking-wider">Tasso Attuale</div>
              <div className="text-lg font-black text-purple-700 dark:text-purple-300">{volatility.current.toFixed(4)}</div>
              <div className="text-[10px] text-slate-500">
                {volatility.percentile > 70 ? '🟢 Alto nel range' : volatility.percentile < 30 ? '🔴 Basso nel range' : '🟡 Nella media'}
              </div>
            </div>
            <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 text-center">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Range (Min–Max)</div>
              <div className="text-sm font-bold text-slate-700 dark:text-slate-200">{volatility.min.toFixed(4)} – {volatility.max.toFixed(4)}</div>
              <div className="text-[10px] text-slate-500">Δ {(volatility.range * 100).toFixed(2)}%</div>
            </div>
            <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 text-center">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Volatilità (σ)</div>
              <div className="text-sm font-bold text-slate-700 dark:text-slate-200">{volatility.stdDev.toFixed(5)}</div>
              <div className="text-[10px] text-slate-500">{volatility.stdDev < 0.005 ? '😴 Stabile' : volatility.stdDev < 0.015 ? '⚡ Moderata' : '🌊 Alta'}</div>
            </div>
            <div className="bg-slate-50 dark:bg-slate-700/30 rounded-lg p-3 text-center">
              <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider">Trend Attuale</div>
              <div className="text-sm font-bold text-slate-700 dark:text-slate-200">
                {volatility.streakDirection === 'up' ? '📈' : volatility.streakDirection === 'down' ? '📉' : '➡️'} {volatility.currentStreak}gg {volatility.streakDirection === 'up' ? 'in salita' : volatility.streakDirection === 'down' ? 'in discesa' : 'stabile'}
              </div>
              <div className="text-[10px] text-slate-500">
                {volatility.streakDirection === 'up' ? '✅ Buon momento per cambiare' : volatility.streakDirection === 'down' ? '⏳ Forse meglio aspettare' : '🤷 Neutro'}
              </div>
            </div>
          </div>
          {/* Percentile bar */}
          <div className="space-y-1">
            <div className="flex justify-between text-[10px] text-slate-500">
              <span>Min {volatility.min.toFixed(4)}</span>
              <span>Posizione attuale nel range storico</span>
              <span>Max {volatility.max.toFixed(4)}</span>
            </div>
            <div className="h-3 bg-gradient-to-r from-red-400 via-yellow-400 to-emerald-400 rounded-full relative">
              <div
                className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-slate-800 dark:border-white rounded-full shadow-lg"
                style={{ left: `calc(${Math.max(2, Math.min(98, volatility.percentile))}% - 8px)` }}
              />
            </div>
            <div className="text-center text-xs font-bold text-slate-600 dark:text-slate-400">
              Percentile: {volatility.percentile.toFixed(0)}%
              {volatility.percentile > 70 ? ' — 🎯 Momento favorevole!' : volatility.percentile < 30 ? ' — ⏰ Tasso basso, valuta di aspettare' : ' — Nella norma'}
            </div>
          </div>
        </div>
      )}

      {/* Life Hacks */}
      <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/20 dark:to-teal-950/20 rounded-xl p-5 border border-emerald-200 dark:border-emerald-800 space-y-3">
        <h4 className="font-extrabold text-sm text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
          🎯 Life Hacks per il Cambio del Frontaliere
        </h4>
        <div className="grid sm:grid-cols-2 gap-2">
          {[
            { emoji: '🏧', text: 'Preleva CHF dal Bancomat in IT il lunedì mattina — tassi migliori post-weekend' },
            { emoji: '📱', text: 'Usa Wise/Revolut per cambio sotto 1000 CHF — zero commissioni' },
            { emoji: '📅', text: 'Cambia lo stipendio a fine mese — i tassi tendono a essere più favorevoli' },
            { emoji: '💡', text: 'Dividi il cambio: 50% subito, 50% tra 2 settimane — media il rischio' },
            { emoji: '⚡', text: 'Evita il venerdì pomeriggio — spread più alti prima del weekend' },
            { emoji: '🔔', text: 'Imposta alert su Wise per il tuo tasso target — non perdere il momento giusto' },
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
          <h4 className="font-extrabold text-sm flex items-center gap-2">🧮 Quanto cambia davvero?</h4>
          <div className="grid sm:grid-cols-3 gap-3 text-center">
            <div className="bg-white/15 rounded-lg p-3">
              <div className="text-[10px] uppercase tracking-wider text-white/70">1000 CHF al miglior tasso</div>
              <div className="text-xl font-black">€ {(1000 * volatility.max).toFixed(2)}</div>
            </div>
            <div className="bg-white/15 rounded-lg p-3">
              <div className="text-[10px] uppercase tracking-wider text-white/70">1000 CHF al peggior tasso</div>
              <div className="text-xl font-black">€ {(1000 * volatility.min).toFixed(2)}</div>
            </div>
            <div className="bg-white/25 rounded-lg p-3 ring-2 ring-white/50">
              <div className="text-[10px] uppercase tracking-wider text-white/90">Differenza potenziale</div>
              <div className="text-xl font-black text-amber-300">€ {(1000 * volatility.range).toFixed(2)}</div>
              <div className="text-[10px] text-white/70">su 1000 CHF nel periodo</div>
            </div>
          </div>
          <p className="text-[11px] text-white/60 text-center mt-1">
            Su 5000 CHF/mese, la differenza annuale può essere fino a <strong>€ {(5000 * volatility.range * 12).toFixed(0)}</strong>!
          </p>
        </div>
      )}
    </div>
  );
};

const CurrencyExchange: React.FC = () => {
  const [amount, setAmount] = useState<number>(1000);
  const [realRate, setRealRate] = useState<number>(0.95);
  const [loading, setLoading] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [historyPeriod, setHistoryPeriod] = useState<'1m' | '3m' | '6m' | '1y' | '5y'>('6m');
  const [historyData, setHistoryData] = useState<Array<{ date: string; rate: number }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

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
    Analytics.trackUIInteraction('CurrencyExchange', 'history_period', historyPeriod);
  }, [historyPeriod]);

  const calculateExchange = (provider: ExchangeProvider) => {
    const appliedRate = realRate * (1 - provider.exchangeRateMarkup);
    const grossAmount = amount * appliedRate;
    const commissionFlat = provider.commission;
    const commissionPercent = grossAmount * (provider.commissionPercent / 100);
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
            <h1 className="text-3xl font-extrabold">Confronto Cambio Valuta CHF → EUR</h1>
            <p className="text-indigo-100 mt-1">Scopri qual è la piattaforma più conveniente per convertire i tuoi franchi</p>
          </div>
        </div>

        {/* Important Notice */}
        <div className="mt-6 p-4 bg-white/10 backdrop-blur-sm rounded-2xl border border-white/20">
          <div className="flex items-start gap-3">
            <AlertCircle size={24} className="flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-bold mb-2">⚠️ Non guardare solo le commissioni!</p>
              <p className="text-indigo-100 leading-relaxed">
                Molte banche tradizionali pubblicizzano <strong>"zero commissioni"</strong> ma applicano un <strong>tasso di cambio sfavorevole</strong> con uno spread nascosto del 2-3%. 
                Questo significa che perdi più soldi rispetto a servizi come Wise che dichiarano una commissione trasparente (~0.4%) ma usano il <strong>tasso di mercato reale</strong>.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Calculator */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
            <Calculator size={20} className="text-indigo-600" />
            Calcola il Tuo Cambio
          </h3>
          <button
            onClick={fetchRealRate}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 rounded-xl text-xs font-bold hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-all disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            Aggiorna Tasso
          </button>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide">Importo da Convertire</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <span className="text-slate-400 font-bold">CHF</span>
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
            <label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wide flex items-center gap-2">
              Tasso di Mercato Reale
              <div className="group relative inline-flex items-center cursor-help">
                <Info size={12} className="text-slate-400" />
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-48 p-2.5 bg-slate-800 text-white text-[10px] font-medium leading-relaxed rounded-xl shadow-xl border border-slate-600 pointer-events-none z-50 text-center">
                  Tasso medio di mercato (mid-market rate) senza markup
                </div>
              </div>
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <span className="text-slate-400 text-sm">1 CHF =</span>
              </div>
              <input
                type="text"
                value={`${realRate.toFixed(4)} EUR`}
                disabled
                className="w-full pl-20 pr-4 py-3 bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl font-bold text-slate-600 dark:text-slate-300 text-lg"
              />
            </div>
            {lastUpdate && (
              <p className="text-[10px] text-slate-400 text-right">
                Aggiornato: {lastUpdate.toLocaleTimeString('it-IT')}
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
            Storico Tasso CHF/EUR
          </h3>
          <div className="flex gap-1.5">
            {(['1m', '3m', '6m', '1y', '5y'] as const).map(p => (
              <button key={p}
                onClick={() => setHistoryPeriod(p)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${historyPeriod === p ? 'bg-indigo-600 text-white shadow' : 'bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-600'}`}
              >
                {p === '1m' ? '1M' : p === '3m' ? '3M' : p === '6m' ? '6M' : p === '1y' ? '1A' : '5A'}
              </button>
            ))}
          </div>
        </div>
        {historyLoading ? (
          <div className="h-64 flex items-center justify-center text-slate-400">
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
          <div className="h-64 flex items-center justify-center text-slate-400 text-sm">
            Nessun dato disponibile
          </div>
        )}
        {historyData.length > 1 && (
          <div className="flex justify-between mt-3 text-xs text-slate-500">
            <span>Min: {Math.min(...historyData.map(d => d.rate)).toFixed(4)}</span>
            <span>Media: {(historyData.reduce((s, d) => s + d.rate, 0) / historyData.length).toFixed(4)}</span>
            <span>Max: {Math.max(...historyData.map(d => d.rate)).toFixed(4)}</span>
          </div>
        )}
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
                <div className="text-xs font-bold text-emerald-600 dark:text-emerald-400 uppercase">Migliore Offerta</div>
                <div className="text-xl font-extrabold text-slate-800 dark:text-slate-100">{best.provider.name}</div>
              </div>
            </div>
            <div className="text-3xl font-extrabold text-emerald-600 mb-1">
              € {best.netAmount.toFixed(2)}
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400">
              Costo totale: <strong>CHF {best.totalCost.toFixed(2)}</strong> ({best.costPercent.toFixed(2)}%)
            </div>
            <div className="text-xs text-emerald-600 dark:text-emerald-400 mt-2 font-bold">
              👆 Clicca per iscriverti con referral
            </div>
          </a>
        ) : (
          <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 rounded-2xl border-2 border-emerald-200 dark:border-emerald-800 p-6">
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-emerald-500 rounded-xl">
                <TrendingUp className="text-white" size={20} />
              </div>
              <div>
                <div className="text-xs font-bold text-emerald-600 dark:text-emerald-400 uppercase">Migliore Offerta</div>
                <div className="text-xl font-extrabold text-slate-800 dark:text-slate-100">{best.provider.name}</div>
              </div>
            </div>
            <div className="text-3xl font-extrabold text-emerald-600 mb-1">
              € {best.netAmount.toFixed(2)}
            </div>
            <div className="text-sm text-slate-600 dark:text-slate-400">
              Costo totale: <strong>CHF {best.totalCost.toFixed(2)}</strong> ({best.costPercent.toFixed(2)}%)
            </div>
          </div>
        )}

        <div className="bg-gradient-to-br from-red-50 to-orange-50 dark:from-red-950/30 dark:to-orange-950/30 rounded-2xl border-2 border-red-200 dark:border-red-800 p-6">
          <div className="flex items-center gap-3 mb-3">
            <div className="p-2 bg-red-500 rounded-xl">
              <TrendingDown className="text-white" size={20} />
            </div>
            <div>
              <div className="text-xs font-bold text-red-600 dark:text-red-400 uppercase">Peggiore Offerta</div>
              <div className="text-xl font-extrabold text-slate-800 dark:text-slate-100">{worst.provider.name}</div>
            </div>
          </div>
          <div className="text-3xl font-extrabold text-red-600 mb-1">
            € {worst.netAmount.toFixed(2)}
          </div>
          <div className="text-sm text-slate-600 dark:text-slate-400">
            Costo totale: <strong>CHF {worst.totalCost.toFixed(2)}</strong> ({worst.costPercent.toFixed(2)}%)
          </div>
        </div>
      </div>

      <div className="bg-gradient-to-r from-amber-50 to-yellow-50 dark:from-amber-950/30 dark:to-yellow-950/30 rounded-2xl border border-amber-200 dark:border-amber-800 p-4">
        <div className="flex items-start gap-3">
          <DollarSign size={24} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-slate-700 dark:text-slate-300">
            <strong>Risparmio potenziale:</strong> Usando <strong>{best.provider.name}</strong> invece di <strong>{worst.provider.name}</strong> risparmi <strong className="text-amber-600">CHF {savingsVsWorst.toFixed(2)}</strong> su questa conversione!
          </div>
        </div>
      </div>

      {/* Comparison Table */}
      <div className="space-y-4">
        <h2 className="text-2xl font-extrabold text-slate-800 dark:text-slate-100 flex items-center gap-2">
          <Percent size={24} className="text-indigo-600" />
          Confronto Dettagliato
        </h2>

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
                  Miglior Scelta
                </div>
              )}

              <div className="flex items-start justify-between gap-4 mb-4">
                <div className="flex items-center gap-3">
                  <div className={`text-4xl p-3 bg-gradient-to-br ${result.provider.color} rounded-2xl`}>
                    {result.provider.logo}
                  </div>
                  <div>
                    <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100">{result.provider.name}</h3>
                    <p className="text-sm text-slate-500 dark:text-slate-400">{result.provider.transferTime}</p>
                  </div>
                </div>

                <div className="text-right">
                  <div className="text-2xl font-extrabold text-slate-800 dark:text-slate-100">
                    € {result.netAmount.toFixed(2)}
                  </div>
                  <div className={`text-sm font-bold ${isBest ? 'text-emerald-600' : isWorst ? 'text-red-600' : 'text-slate-600 dark:text-slate-400'}`}>
                    Costo: {result.costPercent.toFixed(2)}%
                  </div>
                </div>
              </div>

              <div className="grid md:grid-cols-3 gap-4 mb-4">
                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-xl">
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Tasso Applicato</div>
                  <div className="text-lg font-bold text-slate-800 dark:text-slate-100">
                    {result.appliedRate.toFixed(4)}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {result.provider.exchangeRateMarkup > 0 ? (
                      <span className="text-red-600">-{(result.provider.exchangeRateMarkup * 100).toFixed(2)}% spread</span>
                    ) : (
                      <span className="text-emerald-600">✓ Tasso reale</span>
                    )}
                  </div>
                </div>

                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-xl">
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Commissione Dichiarata</div>
                  <div className="text-lg font-bold text-slate-800 dark:text-slate-100">
                    {result.totalCommission.toFixed(2)} EUR
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {result.provider.commission > 0 && `CHF ${result.provider.commission} + `}
                    {result.provider.commissionPercent}%
                  </div>
                </div>

                <div className="p-3 bg-slate-50 dark:bg-slate-900 rounded-xl">
                  <div className="text-xs text-slate-500 dark:text-slate-400 mb-1">Costo Totale Reale</div>
                  <div className="text-lg font-bold text-slate-800 dark:text-slate-100">
                    CHF {result.totalCost.toFixed(2)}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    Commissioni + Spread
                  </div>
                </div>
              </div>

              <div className="border-t border-slate-200 dark:border-slate-700 pt-3">
                <div className="flex flex-wrap gap-2">
                  {result.provider.features.map((feature, fidx) => (
                    <span
                      key={fidx}
                      className="px-2.5 py-1 bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-300 text-xs font-medium rounded-lg"
                    >
                      {feature}
                    </span>
                  ))}
                </div>
              </div>
            </CardWrapper>
          );
        })}
      </div>

      {/* Experimental: Exchange Timing Analysis */}
      <ExchangeTimingSection historyData={historyData} />

      {/* Educational Section */}
      <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-950/30 dark:to-indigo-950/30 rounded-2xl border border-blue-200 dark:border-blue-800 p-6">
        <h3 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
          <Info size={20} className="text-blue-600" />
          Come Funziona lo Spread Nascosto?
        </h3>
        
        <div className="space-y-4 text-sm text-slate-700 dark:text-slate-300">
          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-blue-600 mb-2">📊 Esempio Pratico con CHF 1000:</p>
            <ul className="space-y-2 ml-4">
              <li><strong>Tasso reale di mercato:</strong> 1 CHF = 0.95 EUR → Dovresti ricevere 950 EUR</li>
              <li><strong>Banca tradizionale (zero commissioni, spread 2.5%):</strong> Applica 1 CHF = 0.9262 EUR → Ricevi solo 926.20 EUR</li>
              <li><strong>Costo nascosto:</strong> 950 - 926.20 = <strong className="text-red-600">23.80 EUR persi</strong> (2.5%)</li>
              <li><strong>Wise (commissione 0.43%, spread 0%):</strong> Commissione 4.09 EUR → Ricevi 945.91 EUR</li>
              <li><strong>Risparmio con Wise:</strong> <strong className="text-emerald-600">19.71 EUR</strong> rispetto alla banca!</li>
            </ul>
          </div>

          <div className="p-4 bg-white/50 dark:bg-slate-900/50 rounded-xl">
            <p className="font-bold text-indigo-600 mb-2">💡 Consigli per Risparmiare:</p>
            <ul className="space-y-1 ml-4 list-disc">
              <li>Usa servizi come <strong>Wise</strong> per trasferimenti regolari (massima trasparenza)</li>
              <li><strong>Revolut</strong> è ottimo per piccoli importi e conversioni nei giorni feriali</li>
              <li>Evita le banche tradizionali per il cambio valuta (spread nascosto 2-3%)</li>
              <li>Controlla sempre il <strong>tasso effettivo</strong>, non solo le commissioni dichiarate</li>
              <li>Per grandi importi, anche 0.5% di differenza significa centinaia di euro risparmiati</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

export default CurrencyExchange;
