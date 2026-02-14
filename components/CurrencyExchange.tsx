import React, { useState, useEffect } from 'react';
import { ArrowRightLeft, TrendingDown, TrendingUp, AlertCircle, CheckCircle2, Info, DollarSign, Percent, Calculator, RefreshCw, BarChart3 } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
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
