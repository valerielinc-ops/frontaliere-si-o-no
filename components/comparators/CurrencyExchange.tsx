import React, { useState, useEffect, useMemo, Suspense } from 'react';
import { ArrowRightLeft, TrendingDown, TrendingUp, AlertCircle, CheckCircle2, Info, DollarSign, Percent, Calculator, RefreshCw, Share2, Check, ArrowLeftRight, ChartBar, BarChart3 } from 'lucide-react';
import { Analytics } from '@/services/analytics';
import { useTranslation } from '@/services/i18n';
import DataFreshness from '@/components/shared/DataFreshness';
import PartnerRecommendations from '@/components/shared/PartnerRecommendations';
import { useExchangeRate } from '@/services/exchangeRateService';
import { reportCaughtError } from '@/services/errorReporter';

function appendUtm(url: string, providerName: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}utm_source=frontaliereticino&utm_medium=referral&utm_campaign=exchange_compare&utm_content=${encodeURIComponent(providerName.toLowerCase().replace(/\s+/g, '-'))}`;
}

// Lazy-load Recharts to avoid 386KB vendor-charts blocking main thread (TBT fix)
const LazyExchangeChart = React.lazy(() =>
  import('recharts').then(({ AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer }) => ({
    default: ({ data }: { data: Array<{ date: string; rate: number }> }) => {
      const isDark = typeof window !== 'undefined' && document.documentElement.classList.contains('dark');
      return (
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={data}>
            <defs>
              <linearGradient id="colorRate" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" opacity={0.3} stroke={isDark ? '#334155' : '#e2e8f0'} />
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: isDark ? '#94a3b8' : '#64748b' }} tickFormatter={(v) => { const d = new Date(v); return `${d.getDate()}/${d.getMonth()+1}`; }} interval="preserveStartEnd" />
            <YAxis domain={['auto', 'auto']} tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b' }} tickFormatter={(v: number) => v.toFixed(3)} />
            <Tooltip
              formatter={(value: number) => [`${value.toFixed(4)} EUR`, '1 CHF']}
              labelFormatter={(label) => new Date(label).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })}
              contentStyle={{ backgroundColor: isDark ? '#1e293b' : '#ffffff', border: `1px solid ${isDark ? '#334155' : '#e2e8f0'}`, color: isDark ? '#e2e8f0' : '#1e293b' }}
            />
            <Area type="monotone" dataKey="rate" stroke="#6366f1" fill="url(#colorRate)" strokeWidth={2} dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      );
    },
  }))
);

const LazyCurrencyExchangeStats = React.lazy(() => import('@/components/comparators/CurrencyExchangeStats'));
const LeadMagnetCTA = React.lazy(() => import('@/components/shared/LeadMagnetCTA'));
const RelatedTools = React.lazy(() => import('@/components/shared/RelatedTools'));

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
    commissionPercent: 0.25, // Placeholder, calcolato dinamicamente
    exchangeRateMarkup: 0, // Uses real mid-market rate
    minAmount: 1,
    maxAmount: 1000000,
    transferTime: '1-2 giorni lavorativi',
    transferTimeKey: '1_2_business_days',
    color: 'from-emerald-500 to-teal-600',
    features: ['Tasso medio di mercato reale', 'Trasparenza totale', 'Commissione scalare Wise aggiornata', 'Iscriviti da qui: bonus referral'],
    featureKeys: ['feature_real_market_rate', 'feature_total_transparency', 'feature_wise_volume_discount', 'feature_wise_referral_bonus'],
    type: 'service',
    referralUrl: 'https://wise.com/invite/ihpn/luigis147'
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
    color: 'from-stripe-500 to-stripe-700',
    features: ['Cambio gratuito fino a 1000 EUR/mese (Standard)', 'Oltre limite: 1% commissione uso corretto', 'Weekend: markup 1%'],
    featureKeys: ['feature_free_exchange_1000', 'feature_fair_usage_1pct', 'feature_weekend_markup_1pct'],
    type: 'neobank',
    referralUrl: 'https://revolut.com/referral/?referral-code=luigi4mdv!FEB1-26-AR-H1&geo-redirect'
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
    color: 'from-rose-500 to-pink-600',
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
    color: 'from-sky-500 to-stripe-600',
    features: ['Banca digitale italiana', 'Commissione 0.5%', 'Spread nascosto ~1.8%'],
    featureKeys: ['feature_italian_digital_bank', 'feature_commission_05', 'feature_hidden_spread_18'],
    type: 'traditional',
    referralUrl: 'https://fineco.mobi/passaparola'
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
    color: 'from-stripe-600 to-stripe-800',
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
    type: 'traditional',
    referralUrl: 'https://www.credit-agricole.it/invito?mgm=LUIGSAGG112A'
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
    name: 'Cambiavalute.ch',
    logo: '🇨🇭',
    commission: 0,
    commissionPercent: 0,
    exchangeRateMarkup: 0.0035, // ~0.35% spread
    minAmount: 100,
    maxAmount: 500000,
    transferTime: '1-2 giorni lavorativi',
    transferTimeKey: '1_2_business_days',
    color: 'from-teal-500 to-stripe-600',
    features: ['Servizio svizzero specializzato', 'Spread competitivo ~0.35%', 'Bonifico diretto su conto italiano', '🎁 Da frontalieticino.ch: 25€ in regalo con 3000 CHF di ordini nei primi 30 giorni'],
    featureKeys: ['feature_swiss_specialized_service', 'feature_competitive_spread_035', 'feature_direct_transfer_italy', 'feature_cambiavalute_referral_bonus'],
    type: 'service',
    referralUrl: 'https://dashboard.cambiavalute.ch/r/28693'
  }
];


const CurrencyExchange: React.FC = () => {
  const { t } = useTranslation();
  const [amount, setAmount] = useState<number>(1000);
  // Centralized exchange rate (TwelveData → Firestore cache)
  const { rate: realRate, loading, lastUpdate, refresh } = useExchangeRate();
  const [historyPeriod, setHistoryPeriod] = useState<'1m' | '3m' | '6m' | '1y' | '5y'>('6m');
  const [historyData, setHistoryData] = useState<Array<{ date: string; rate: number }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [exchangeSubTab, setExchangeSubTab] = useState<'overview' | 'statistics'>('overview');
  const [shareState, setShareState] = useState<'idle' | 'copied'>('idle');
  const handleShare = async () => {
    const url = window.location.href;
    const title = t('comparators.exchange');
    try {
      if (navigator.share) {
        await navigator.share({ title, url });
      } else if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        setShareState('copied');
        setTimeout(() => setShareState('idle'), 2500);
      }
      Analytics.trackShare('link', 'currency_exchange');
    } catch { /* user cancelled */ }
  };

  // Historical time-series data — cached in Firestore (shared across all users)
  // Only fetches from external APIs when the cache is stale (older than yesterday)
  const fetchHistory = async (period: string) => {
    setHistoryLoading(true);
    try {
      const { fetchExchangeHistory } = await import('@/services/exchangeRateService');
      const points = await fetchExchangeHistory(
        period as import('@/services/exchangeRateService').HistoryPeriod,
        realRate,
      );
      if (points.length > 0) {
        setHistoryData(points);
      }
    } catch (e) {
      console.error('Failed to fetch history', e);
      reportCaughtError(e, 'currencyExchange.fetchHistory');
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory(historyPeriod);
    Analytics.trackCurrencyExchange('convert', undefined, amount);
  }, [historyPeriod]);

  const calculateExchange = (provider: ExchangeProvider) => {
    let markup = provider.exchangeRateMarkup;
    let commPct = provider.commissionPercent;
    let extraCommissionEur = 0;

    // Revolut: spread always applies; fair-usage fee (1%) on the amount above 1000 EUR/month
    if (provider.name === 'Revolut') {
      const freeLimit = 1000; // EUR/month free tier (Standard plan)
      const amountEur = amount * realRate;
      if (amountEur > freeLimit) {
        // Fair usage: 1% on the amount exceeding free limit
        const excessEur = amountEur - freeLimit;
        extraCommissionEur = excessEur * 0.01;
      }
    }

    // Wise: modello scalare commissione
    if (provider.name === 'Wise (TransferWise)') {
      const amountChf = amount;
      // Soglie e percentuali
      const brackets = [
        { limit: 1000, pct: 0.35 },
        { limit: 1500, pct: 0.31 },
        { limit: 2000, pct: 0.29 },
        { limit: 3000, pct: 0.27 },
        { limit: 4000, pct: 0.26 },
        { limit: 5000, pct: 0.255 },
        { limit: 6000, pct: 0.25 },
        { limit: 7000, pct: 0.246 },
        { limit: 8000, pct: 0.244 },
        { limit: 9000, pct: 0.242 },
        { limit: 10000, pct: 0.2415 },
      ];
      let pct = 0.24; // Default sopra 10000
      for (let i = 0; i < brackets.length; i++) {
        if (amountChf <= brackets[i].limit) {
          if (i === 0) {
            pct = brackets[0].pct;
          } else {
            // Media tra bracket superiore e inferiore
            const lower = brackets[i - 1];
            const upper = brackets[i];
            const range = upper.limit - lower.limit;
            const pos = (amountChf - lower.limit) / range;
            pct = lower.pct + (upper.pct - lower.pct) * pos;
          }
          break;
        }
      }
      commPct = pct;
    }

    // Conversion model:
    // 1) convert CHF -> EUR at real rate
    // 2) apply provider spread
    // 3) sum provider commissions (flat + percent + dynamic extras)
    // 4) subtract total commissions from post-spread amount
    const grossAtRealRate = amount * realRate;
    const spreadCost = grossAtRealRate * markup;
    const grossAmount = grossAtRealRate - spreadCost;
    const appliedRate = realRate * (1 - markup);
    const commissionFlat = provider.commission * realRate; // provider flat fee is in CHF
    const commissionPercent = grossAmount * (commPct / 100);
    const totalCommission = commissionFlat + commissionPercent + extraCommissionEur;
    const netAmount = grossAmount - totalCommission;
    const declaredCommissionPercent =
      grossAmount > 0 ? ((commissionPercent + extraCommissionEur) / grossAmount) * 100 : 0;
    const effectiveRate = netAmount / amount;
    const totalCost = amount - netAmount / realRate; // Cost in CHF
    const costPercent = (totalCost / amount) * 100;

    return {
      appliedMarkup: markup,
      appliedRate,
      spreadCost,
      grossAmount,
      declaredCommissionPercent,
      commissionFlat,
      commissionPercent,
      extraCommissionEur,
      totalCommission,
      netAmount,
      effectiveRate,
      totalCost,
      costPercent
    };
  };

  const results = useMemo(() => providers.map(p => ({
    provider: p,
    ...calculateExchange(p)
  })).sort((a, b) => {
    // Compare by displayed net (2 decimals) to avoid float-noise ranking flips
    const netACents = Math.round(a.netAmount * 100);
    const netBCents = Math.round(b.netAmount * 100);
    const diff = netBCents - netACents;
    if (diff !== 0) return diff;
    // At equal net amount, prefer Wise
    if (a.provider.name === 'Wise (TransferWise)') return -1;
    if (b.provider.name === 'Wise (TransferWise)') return 1;
    return 0;
  }), [amount, realRate]);

  const best = results[0];
  const worst = results[results.length - 1];
  const savingsVsWorst = worst.totalCost - best.totalCost;

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-emerald-700 to-teal-800 rounded-2xl sm:rounded-3xl p-4 sm:p-8 text-white">
        <div className="flex items-center gap-3 sm:gap-4 mb-4">
          <ArrowRightLeft size={28} className="sm:w-8 sm:h-8" />
          <div>
            <h1 className="text-xl sm:text-3xl font-extrabold">{t('currency.title')}</h1>
            <p className="text-emerald-100 text-sm sm:text-base mt-1">{t('currency.subtitle')}</p>
          </div>
        </div>

        {/* Important Notice */}
        <div className="mt-6 p-4 bg-white/10 rounded-2xl border border-white/20">
          <div className="flex items-start gap-3">
            <AlertCircle size={24} className="flex-shrink-0 mt-0.5" />
            <div className="text-sm">
              <p className="font-bold mb-2">⚠️ {t('currency.notice_title')}</p>
              <p className="text-emerald-100 leading-relaxed">
                {t('currency.notice_text')}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Sub-tab navigation */}
      <div className="flex gap-2 bg-surface rounded-2xl p-2 border border-edge shadow-sm">
        <button
          onClick={() => { setExchangeSubTab('overview'); Analytics.trackCurrencyExchange('provider_view', 'overview'); }}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold transition-[color,background-color,border-color,box-shadow] ${
            exchangeSubTab === 'overview'
              ? 'bg-emerald-700 text-white shadow-lg'
              : 'text-subtle hover:bg-slate-100 dark:hover:bg-slate-700'
          }`}
        >
          <ArrowLeftRight size={16} />
          {t('currency.tab_compare')}
        </button>
        <button
          onClick={() => { setExchangeSubTab('statistics'); Analytics.trackCurrencyExchange('provider_view', 'statistics'); }}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-bold transition-[color,background-color,border-color,box-shadow] ${
            exchangeSubTab === 'statistics'
              ? 'bg-emerald-700 text-white shadow-lg'
              : 'text-subtle hover:bg-slate-100 dark:hover:bg-slate-700'
          }`}
        >
          <ChartBar size={16} />
          {t('currency.tab_statistics')}
        </button>
      </div>

      {exchangeSubTab === 'overview' ? (
      <>
      {/* Calculator + History Side by Side */}
      <div className="grid lg:grid-cols-2 gap-6 min-h-[420px]">
      {/* Calculator */}
      <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
            <Calculator size={20} className="text-emerald-700" />
            {t('currency.calculate_exchange')}
          </h2>
          <button
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-2 px-3 py-2 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 rounded-xl text-xs font-bold hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-[color,background-color,border-color,opacity] disabled:opacity-50"
          >
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
            {t('currency.refresh_rate')}
          </button>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <label htmlFor="exchange-amount" className="text-xs font-bold text-muted uppercase tracking-wide">{t('currency.amount_to_convert')}</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <span className="text-muted font-bold">CHF</span>
              </div>
              <input
                id="exchange-amount"
                type="number"
                inputMode="numeric"
                value={amount}
                onChange={(e) => setAmount(Math.max(0, parseFloat(e.target.value) || 0))}
                className="w-full pl-14 pr-4 py-3 bg-surface-alt border border-edge rounded-xl focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/10 outline-none transition-[color,background-color,border-color,box-shadow] font-bold text-slate-800 dark:text-slate-100 text-lg"
                placeholder="1000"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label htmlFor="exchange-rate" className="text-xs font-bold text-muted uppercase tracking-wide flex items-center gap-2">
              {t('currency.real_market_rate')}
              <div className="group relative inline-flex items-center cursor-help">
                <button type="button" onClick={(e) => { const tip = e.currentTarget.nextElementSibling; if (tip) tip.classList.toggle('hidden'); }} aria-label="Info" className="inline-flex">
                  <Info size={12} className="text-muted" />
                </button>
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block w-48 p-2.5 bg-slate-800 text-white text-xs font-medium leading-relaxed rounded-xl shadow-xl border border-slate-600 z-50 text-center">
                  {t('currency.mid_market_tooltip')}
                </div>
              </div>
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                <span className="text-muted text-sm">1 CHF =</span>
              </div>
              <input
                id="exchange-rate"
                type="text"
                value={`${realRate.toFixed(4)} EUR`}
                disabled
                aria-label="Tasso di cambio CHF/EUR"
                className="w-full pl-20 pr-4 py-3 bg-slate-100 dark:bg-slate-900 border border-edge rounded-xl font-bold text-slate-600 dark:text-slate-300 text-lg"
              />
            </div>
            <p className="text-sm text-muted text-right min-h-[16px]">
              {lastUpdate ? `${t('currency.updated')}: ${lastUpdate.toLocaleTimeString('it-IT')}` : '\u00A0'}
            </p>
          </div>
        </div>
      </div>

      {/* History Chart */}
      <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
          <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
            <BarChart3 size={20} className="text-emerald-700" />
            {t('currency.history_title')}
          </h2>
          <div className="flex gap-1.5">
            {(['1m', '3m', '6m', '1y', '5y'] as const).map(p => (
              <button key={p}
                onClick={() => setHistoryPeriod(p)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors ${historyPeriod === p ? 'bg-emerald-700 text-white shadow' : 'bg-surface-raised text-subtle hover:bg-slate-200 dark:hover:bg-slate-600'}`}
              >
                {p === '1m' ? '1M' : p === '3m' ? '3M' : p === '6m' ? '6M' : p === '1y' ? '1A' : '5A'}
              </button>
            ))}
          </div>
        </div>
        {historyLoading ? (
          <div className="h-[280px] flex items-center justify-center text-muted">
            <RefreshCw size={24} className="animate-spin" />
          </div>
        ) : historyData.length > 0 ? (
          <div role="img" aria-label="Grafico tasso di cambio CHF/EUR" tabIndex={0}>
            <Suspense fallback={<div className="h-[280px] flex items-center justify-center text-muted"><RefreshCw size={24} className="animate-spin" /></div>}>
              <LazyExchangeChart data={historyData} />
            </Suspense>
          </div>
        ) : (
          <div className="h-[280px] flex items-center justify-center text-muted text-sm">
            {t('currency.no_data_available')}
          </div>
        )}
        {historyData.length > 1 && (
          <div className="flex justify-between mt-3 text-xs text-muted min-h-[20px]">
            <span>Min: {Math.min(...historyData.map(d => d.rate)).toFixed(4)}</span>
            <span>{t('currency.average')}: {(historyData.reduce((s, d) => s + d.rate, 0) / historyData.length).toFixed(4)}</span>
            <span>Max: {Math.max(...historyData.map(d => d.rate)).toFixed(4)}</span>
          </div>
        )}
        {historyData.length <= 1 && <div className="min-h-[20px] mt-3" />}
      </div>
      </div>

      <div className="grid sm:grid-cols-2 gap-3 sm:gap-4">
        {best.provider.referralUrl ? (
          <a
            href={appendUtm(best.provider.referralUrl, best.provider.name)}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => Analytics.trackExternalLink(best.provider.referralUrl!, best.provider.name)}
            className="bg-emerald-50 dark:bg-emerald-950/30 rounded-xl sm:rounded-2xl border border-emerald-200 dark:border-emerald-800 p-3 sm:p-5 hover:shadow-md hover:border-emerald-400 transition-[color,background-color,border-color,box-shadow] cursor-pointer"
          >
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="text-emerald-600 dark:text-emerald-400" size={16} />
              <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 uppercase">{t('currency.best_offer')}</span>
            </div>
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-1">{best.provider.name}</div>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
              <span className="font-semibold text-emerald-700 dark:text-emerald-400">€ {best.netAmount.toFixed(2)}</span>
              <span className="text-muted">{t('currency.total_cost')}: CHF {best.totalCost.toFixed(2)} ({best.costPercent.toFixed(2)}%)</span>
            </div>
            <div className="text-sm text-emerald-700 dark:text-emerald-400 mt-2 font-semibold">
              👆 {t('currency.click_referral')}
            </div>
          </a>
        ) : (
          <div className="bg-emerald-50 dark:bg-emerald-950/30 rounded-xl sm:rounded-2xl border border-emerald-200 dark:border-emerald-800 p-3 sm:p-5">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="text-emerald-600 dark:text-emerald-400" size={16} />
              <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-400 uppercase">{t('currency.best_offer')}</span>
            </div>
            <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-1">{best.provider.name}</div>
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
              <span className="font-semibold text-emerald-700 dark:text-emerald-400">€ {best.netAmount.toFixed(2)}</span>
              <span className="text-muted">{t('currency.total_cost')}: CHF {best.totalCost.toFixed(2)} ({best.costPercent.toFixed(2)}%)</span>
            </div>
          </div>
        )}

        <div className="bg-red-50 dark:bg-red-950/30 rounded-xl sm:rounded-2xl border border-red-200 dark:border-red-800 p-3 sm:p-5">
          <div className="flex items-center gap-2 mb-2">
            <TrendingDown className="text-red-600 dark:text-red-400" size={16} />
            <span className="text-xs font-semibold text-red-700 dark:text-red-400 uppercase">{t('currency.worst_offer')}</span>
          </div>
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-1">{worst.provider.name}</div>
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
            <span className="font-semibold text-red-600 dark:text-red-400">€ {worst.netAmount.toFixed(2)}</span>
            <span className="text-muted">{t('currency.total_cost')}: CHF {worst.totalCost.toFixed(2)} ({worst.costPercent.toFixed(2)}%)</span>
          </div>
        </div>
      </div>

      <div className="bg-gradient-to-r from-amber-50 to-yellow-50 dark:from-amber-950/30 dark:to-yellow-950/30 rounded-2xl border border-amber-200 dark:border-amber-800 p-4">
        <div className="flex items-start gap-3">
          <DollarSign size={24} className="text-amber-700 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-body">
            <strong>{t('currency.potential_savings')}:</strong> {t('currency.savings_prefix')} <strong>{best.provider.name}</strong> {t('currency.savings_middle')} <strong>{worst.provider.name}</strong> {t('currency.savings_suffix')} <strong className="text-amber-700">CHF {savingsVsWorst.toFixed(2)}</strong> {t('currency.on_this_conversion')}!
          </div>
        </div>
      </div>

      {/* Comparison Table */}
      <div>
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg sm:text-2xl font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
            <Percent size={20} className="text-emerald-700 sm:w-6 sm:h-6" />
            {t('currency.detailed_comparison')}
          </h2>
          <button onClick={handleShare} aria-label={t('common.share')} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-surface-raised hover:bg-slate-200 dark:hover:bg-slate-600 transition-colors text-sm font-semibold text-slate-600 dark:text-slate-300">
            {shareState === 'copied' ? <><Check size={16} className="text-emerald-500" /> {t('common.linkCopied')}</> : <><Share2 size={16} /> {t('common.share')}</>}
          </button>
        </div>
        <div className="grid sm:grid-cols-2 gap-3 sm:gap-4 overflow-hidden">
        {results.map((result, idx) => {
          const isBest = idx === 0;
          const isWorst = idx === results.length - 1;
          
          const CardWrapper = result.provider.referralUrl ? 'a' : 'div';
          const cardProps = result.provider.referralUrl ? {
            href: appendUtm(result.provider.referralUrl, result.provider.name),
            target: '_blank',
            rel: 'noopener noreferrer',
            onClick: () => Analytics.trackExternalLink(result.provider.referralUrl!, result.provider.name),
            'aria-label': result.provider.name,
            className: `block min-w-0 bg-surface rounded-xl sm:rounded-2xl border-2 p-3 sm:p-6 hover:shadow-lg transition-[color,background-color,border-color,box-shadow] cursor-pointer ${
              isBest ? 'border-emerald-500 ring-2 ring-emerald-500/20 hover:ring-emerald-500/40' : isWorst ? 'border-red-500 ring-2 ring-red-500/20' : 'border-edge hover:border-emerald-400'
            }`
          } : {
            'aria-label': result.provider.name,
            className: `min-w-0 bg-surface rounded-xl sm:rounded-2xl border-2 p-3 sm:p-6 hover:shadow-lg transition-[color,background-color,border-color,box-shadow] ${
              isBest ? 'border-emerald-500 ring-2 ring-emerald-500/20' : isWorst ? 'border-red-500 ring-2 ring-red-500/20' : 'border-edge'
            }`
          };
          
          return (
            <CardWrapper
              key={result.provider.name}
              {...cardProps}
            >
              {isBest && (
                <div className="mb-3 inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-700 text-white text-xs font-bold rounded-full">
                  <CheckCircle2 size={14} />
                  {t('currency.best_choice')}
                </div>
              )}

              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`text-2xl sm:text-4xl p-2 sm:p-3 bg-gradient-to-br ${result.provider.color} rounded-xl sm:rounded-2xl shrink-0`}>
                    {result.provider.logo}
                  </div>
                  <div className="min-w-0">
                    <h3 className="text-base sm:text-xl font-bold text-slate-800 dark:text-slate-100">{result.provider.name}</h3>
                    <p className="text-xs sm:text-sm text-muted">{t(`currency.${result.provider.transferTimeKey}`)}</p>
                  </div>
                </div>

                <div className="flex items-center justify-between sm:block sm:text-right pl-11 sm:pl-0">
                  <div className="text-xl sm:text-2xl font-bold text-slate-800 dark:text-slate-100">
                    € {result.netAmount.toFixed(2)}
                  </div>
                  <div className="flex sm:flex-col items-center sm:items-end gap-1.5 sm:gap-0">
                    <div className="text-xs text-muted hidden sm:block">
                      {t('currency.net_after_fees')}
                    </div>
                    <div className={`text-xs sm:text-sm font-bold ${isBest ? 'text-emerald-700' : isWorst ? 'text-red-600' : 'text-subtle'}`}>
                      {t('currency.cost')}: {result.costPercent.toFixed(2)}%
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2 sm:gap-4 mb-4">
                <div className="p-2 sm:p-3 bg-surface-alt rounded-lg sm:rounded-xl">
                  <div className="text-xs text-muted mb-1">{t('currency.applied_rate')}</div>
                  <div className="text-sm sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                    {result.appliedRate.toFixed(4)}
                  </div>
                  <div className="text-xs text-muted">
                    {result.appliedMarkup > 0 ? (
                      <span className="text-red-600">-{(result.appliedMarkup * 100).toFixed(2)}%</span>
                    ) : (
                      <span className="text-emerald-700">✓ {t('currency.real_rate')}</span>
                    )}
                  </div>
                </div>

                <div className="p-2 sm:p-3 bg-surface-alt rounded-lg sm:rounded-xl">
                  <div className="text-xs text-muted mb-1">{t('currency.declared_commission')}</div>
                  <div className="text-sm sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                    {result.totalCommission.toFixed(2)} €
                  </div>
                  <div className="text-xs text-muted">
                    {result.provider.commission > 0 && `CHF ${result.provider.commission}+ `}
                    {result.declaredCommissionPercent.toFixed(2)}%
                  </div>
                </div>

                <div className="p-2 sm:p-3 bg-surface-alt rounded-lg sm:rounded-xl">
                  <div className="text-xs text-muted mb-1">{t('currency.real_total_cost')}</div>
                  <div className="text-sm sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                    CHF {result.totalCost.toFixed(2)}
                  </div>
                  <div className="text-xs text-muted">
                    {t('currency.commissions_spread')}
                  </div>
                </div>
              </div>

              <div className="border-t border-edge pt-2 sm:pt-3">
                <div className="flex flex-wrap gap-1.5 sm:gap-2">
                  {result.provider.featureKeys.map((featureKey, fidx) => (
                    <span
                      key={fidx}
                      className="px-2 sm:px-2.5 py-0.5 sm:py-1 bg-slate-100 dark:bg-slate-900 text-body text-xs font-medium rounded-md sm:rounded-lg"
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
      <div className="bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/30 dark:to-teal-950/30 rounded-2xl border border-emerald-200 dark:border-emerald-800 p-6">
        <h2 className="text-xl font-bold text-slate-800 dark:text-slate-100 mb-4 flex items-center gap-2">
          <Info size={20} className="text-stripe-600" />
          {t('currency.how_hidden_spread_works')}
        </h2>
        
        <div className="space-y-4 text-sm text-body">
          <div className="p-4 bg-surface/50 rounded-xl">
            <p className="font-bold text-stripe-600 mb-2">📊 {t('currency.practical_example_title')}:</p>
            <ul className="space-y-2 ml-4">
              <li><strong>{t('currency.example_real_rate')}:</strong> {t('currency.example_real_rate_text')}</li>
              <li><strong>{t('currency.example_traditional_bank')}:</strong> {t('currency.example_traditional_bank_text')}</li>
              <li><strong>{t('currency.example_hidden_cost')}:</strong> {t('currency.example_hidden_cost_text')}</li>
              <li><strong>{t('currency.example_wise')}:</strong> {t('currency.example_wise_text')}</li>
              <li><strong>{t('currency.example_savings')}:</strong> <strong className="text-emerald-700">{t('currency.example_savings_text')}</strong></li>
            </ul>
          </div>

          <div className="p-4 bg-surface/50 rounded-xl">
            <p className="font-bold text-emerald-700 mb-2">💡 {t('currency.tips_to_save_title')}:</p>
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
      <Suspense fallback={<div className="min-h-[400px] flex items-center justify-center" style={{ contain: 'layout' }}><RefreshCw className="animate-spin text-stripe-500" size={32} /></div>}>
        <LazyCurrencyExchangeStats historyData={historyData} currentRate={realRate} period={historyPeriod} />
      </Suspense>
      )}

      {/* Data freshness + source — AI SEO citability */}
      {lastUpdate && (
        <div className="mt-6">
          <DataFreshness
            lastUpdated={lastUpdate}
            source="TwelveData / BCE"
            sourceUrl="https://twelvedata.com"
            variant="badge"
          />
        </div>
      )}
      <div className="mt-3 p-4 bg-surface-alt/50 rounded-xl border border-edge">
        <p className="text-sm text-muted leading-relaxed">
          <strong>{t('exchange.methodology.title')}</strong>{' '}
          {t('exchange.methodology.description')}
        </p>
      </div>

      <PartnerRecommendations context="exchange" />
      <Suspense fallback={<div className="min-h-[180px]" style={{ contain: 'layout' }} />}>
        <LeadMagnetCTA variant="generic" delay={0} />
      </Suspense>
      <Suspense fallback={<div className="min-h-[100px]" style={{ contain: 'layout' }} />}>
        <RelatedTools context="exchange" />
      </Suspense>
    </div>
  );
};

export default CurrencyExchange;
