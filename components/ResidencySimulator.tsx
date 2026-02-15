import React, { useState, useMemo } from 'react';
import { useTranslation } from '@/services/i18n';
import { useExchangeRate } from '@/services/exchangeRateService';
import { ArrowLeftRight, MapPin, TrendingUp, AlertCircle, ChevronDown, ChevronUp, Clock, Euro, Home, Briefcase, RefreshCw } from 'lucide-react';

// ─── Simulation Engine ───────────────────────────────────────

interface Location {
  id: string;
  country: 'IT' | 'CH';
  avgRent: number; // monthly EUR or CHF
  groceries: number; // monthly
  healthInsurance: number; // monthly
  transport: number; // monthly commuting or local
  utilities: number; // monthly
  currency: 'EUR' | 'CHF';
}

const LOCATIONS: Record<string, Location> = {
  como: { id: 'como', country: 'IT', avgRent: 750, groceries: 400, healthInsurance: 0, transport: 200, utilities: 150, currency: 'EUR' },
  varese: { id: 'varese', country: 'IT', avgRent: 650, groceries: 380, healthInsurance: 0, transport: 250, utilities: 140, currency: 'EUR' },
  sondrio: { id: 'sondrio', country: 'IT', avgRent: 420, groceries: 350, healthInsurance: 0, transport: 300, utilities: 130, currency: 'EUR' },
  verbania: { id: 'verbania', country: 'IT', avgRent: 500, groceries: 370, healthInsurance: 0, transport: 280, utilities: 135, currency: 'EUR' },
  lugano: { id: 'lugano', country: 'CH', avgRent: 1600, groceries: 700, healthInsurance: 350, transport: 100, utilities: 200, currency: 'CHF' },
  bellinzona: { id: 'bellinzona', country: 'CH', avgRent: 1300, groceries: 650, healthInsurance: 340, transport: 80, utilities: 180, currency: 'CHF' },
  mendrisio: { id: 'mendrisio', country: 'CH', avgRent: 1400, groceries: 670, healthInsurance: 345, transport: 90, utilities: 185, currency: 'CHF' },
  locarno: { id: 'locarno', country: 'CH', avgRent: 1350, groceries: 660, healthInsurance: 342, transport: 85, utilities: 182, currency: 'CHF' },
};

interface OneTimeCost {
  label: string;
  amount: number;
  currency: 'EUR' | 'CHF';
}

const ONE_TIME_IT_TO_CH: OneTimeCost[] = [
  { label: 'residency.onetime.deposit', amount: 4800, currency: 'CHF' },
  { label: 'residency.onetime.moving', amount: 3000, currency: 'EUR' },
  { label: 'residency.onetime.permitB', amount: 150, currency: 'CHF' },
  { label: 'residency.onetime.adminFees', amount: 500, currency: 'CHF' },
  { label: 'residency.onetime.furniture', amount: 2000, currency: 'EUR' },
];

const ONE_TIME_CH_TO_IT: OneTimeCost[] = [
  { label: 'residency.onetime.deposit', amount: 2250, currency: 'EUR' },
  { label: 'residency.onetime.moving', amount: 2500, currency: 'EUR' },
  { label: 'residency.onetime.agency', amount: 500, currency: 'EUR' },
  { label: 'residency.onetime.adminFees', amount: 300, currency: 'EUR' },
];

// ─── Component ───────────────────────────────────────────────

const ResidencySimulator: React.FC = () => {
  const { t } = useTranslation();
  const { rate: chfEurRate, loading: rateLoading } = useExchangeRate();
  const [from, setFrom] = useState('como');
  const [to, setTo] = useState('lugano');
  const [grossMonthlyCHF, setGrossMonthlyCHF] = useState(6500);
  const [showDetails, setShowDetails] = useState(false);

  const fromLoc = LOCATIONS[from];
  const toLoc = LOCATIONS[to];

  // EUR/CHF derived from API CHF→EUR rate
  const eurChfRate = chfEurRate > 0 ? 1 / chfEurRate : 1.06;

  const swapLocations = () => {
    setFrom(to);
    setTo(from);
  };

  // Calculate monthly costs in EUR for comparison
  const result = useMemo(() => {
    const toEUR = (amount: number, currency: 'EUR' | 'CHF') =>
      currency === 'CHF' ? amount * chfEurRate : amount;
    const toCHF = (amount: number, currency: 'EUR' | 'CHF') =>
      currency === 'EUR' ? amount * eurChfRate : amount;

    const fromMonthly = toEUR(
      fromLoc.avgRent + fromLoc.groceries + fromLoc.healthInsurance + fromLoc.transport + fromLoc.utilities,
      fromLoc.currency
    );
    const toMonthly = toEUR(
      toLoc.avgRent + toLoc.groceries + toLoc.healthInsurance + toLoc.transport + toLoc.utilities,
      toLoc.currency
    );

    const monthlyDiff = toMonthly - fromMonthly;

    // One-time costs
    const direction = fromLoc.country === 'IT' && toLoc.country === 'CH' ? 'IT_TO_CH'
      : fromLoc.country === 'CH' && toLoc.country === 'IT' ? 'CH_TO_IT'
      : fromLoc.country === 'IT' ? 'IT_TO_IT' : 'CH_TO_CH';

    const oneTimeCosts = direction === 'IT_TO_CH' ? ONE_TIME_IT_TO_CH
      : direction === 'CH_TO_IT' ? ONE_TIME_CH_TO_IT
      : direction === 'IT_TO_IT' ? [
          { label: 'residency.onetime.deposit', amount: 2250, currency: 'EUR' as const },
          { label: 'residency.onetime.moving', amount: 1500, currency: 'EUR' as const },
        ]
      : [
          { label: 'residency.onetime.deposit', amount: 4200, currency: 'CHF' as const },
          { label: 'residency.onetime.moving', amount: 2000, currency: 'CHF' as const },
        ];

    const totalOneTime = oneTimeCosts.reduce((sum, c) => sum + toEUR(c.amount, c.currency), 0);

    // Tax impact (simplified)
    let taxNote = '';
    if (direction === 'IT_TO_CH') {
      taxNote = 'residency.tax.itToCh';
    } else if (direction === 'CH_TO_IT') {
      taxNote = 'residency.tax.chToIt';
    }

    // Break-even: if monthly costs go up, how many months until one-time costs are "absorbed"
    // (only meaningful if moving saves money monthly)
    let breakEvenMonths: number | null = null;
    if (monthlyDiff < 0) {
      // Moving saves money — break-even after one-time costs are recovered
      breakEvenMonths = Math.ceil(totalOneTime / Math.abs(monthlyDiff));
    }

    return {
      fromMonthly,
      toMonthly,
      monthlyDiff,
      totalOneTime,
      oneTimeCosts,
      breakEvenMonths,
      direction,
      taxNote,
    };
  }, [from, to, chfEurRate, eurChfRate, fromLoc, toLoc]);

  const itLocations = Object.entries(LOCATIONS).filter(([, l]) => l.country === 'IT');
  const chLocations = Object.entries(LOCATIONS).filter(([, l]) => l.country === 'CH');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-br from-indigo-50 to-violet-50 dark:from-indigo-950/30 dark:to-violet-950/30 rounded-2xl p-6 border border-indigo-200 dark:border-indigo-800">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-indigo-100 dark:bg-indigo-900/50 rounded-xl">
            <Home className="w-6 h-6 text-indigo-600 dark:text-indigo-400" />
          </div>
          <h2 className="text-2xl font-bold text-indigo-900 dark:text-indigo-100">{t('residency.title')}</h2>
        </div>
        <p className="text-indigo-700 dark:text-indigo-300 text-sm">{t('residency.subtitle')}</p>
      </div>

      {/* Inputs */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-[1fr,auto,1fr] gap-4 items-end">
          {/* From */}
          <div>
            <label className="block text-xs font-bold text-slate-500 mb-1">{t('residency.from')}</label>
            <select
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm font-bold"
            >
              <optgroup label="🇮🇹 Italia">
                {itLocations.map(([id]) => (
                  <option key={id} value={id}>{t(`residency.loc.${id}`)}</option>
                ))}
              </optgroup>
              <optgroup label="🇨🇭 Svizzera">
                {chLocations.map(([id]) => (
                  <option key={id} value={id}>{t(`residency.loc.${id}`)}</option>
                ))}
              </optgroup>
            </select>
          </div>

          {/* Swap button */}
          <button
            onClick={swapLocations}
            className="p-2.5 rounded-xl bg-indigo-100 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-200 dark:hover:bg-indigo-900/50 transition-colors self-end"
          >
            <ArrowLeftRight className="w-5 h-5" />
          </button>

          {/* To */}
          <div>
            <label className="block text-xs font-bold text-slate-500 mb-1">{t('residency.to')}</label>
            <select
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm font-bold"
            >
              <optgroup label="🇮🇹 Italia">
                {itLocations.map(([id]) => (
                  <option key={id} value={id}>{t(`residency.loc.${id}`)}</option>
                ))}
              </optgroup>
              <optgroup label="🇨🇭 Svizzera">
                {chLocations.map(([id]) => (
                  <option key={id} value={id}>{t(`residency.loc.${id}`)}</option>
                ))}
              </optgroup>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-bold text-slate-500 mb-1">{t('residency.grossMonthly')}</label>
            <input
              type="number"
              value={grossMonthlyCHF}
              onChange={(e) => setGrossMonthlyCHF(+e.target.value)}
              className="w-full px-3 py-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-sm font-bold"
            />
          </div>
          <div>
            <label className="block text-xs font-bold text-slate-500 mb-1">{t('residency.exchangeRate')}</label>
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
              <span className="text-sm font-bold text-slate-800 dark:text-slate-200">1 CHF = {chfEurRate.toFixed(4)} EUR</span>
              {rateLoading && <RefreshCw size={12} className="animate-spin text-slate-500" />}
            </div>
            <p className="text-[10px] text-slate-500 mt-0.5">{t('exchange.liveRate') || 'Tasso live'}</p>
          </div>
        </div>
      </div>

      {/* Results */}
      {/* Monthly comparison */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* From card */}
        <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2 mb-3">
            <MapPin className="w-4 h-4 text-slate-500" />
            <h3 className="font-bold text-sm text-slate-500">{t(`residency.loc.${from}`)} ({t('residency.current')})</h3>
          </div>
          <p className="text-2xl font-black text-slate-800 dark:text-slate-200">€{Math.round(result.fromMonthly).toLocaleString('it-IT')}</p>
          <p className="text-xs text-slate-500">{t('residency.perMonth')}</p>
          <div className="mt-3 space-y-1 text-xs text-slate-500">
            <p>🏠 {t('residency.rent')}: {fromLoc.currency === 'CHF' ? 'CHF' : '€'}{fromLoc.avgRent}</p>
            <p>🛒 {t('residency.groceries')}: {fromLoc.currency === 'CHF' ? 'CHF' : '€'}{fromLoc.groceries}</p>
            <p>🚗 {t('residency.transport')}: {fromLoc.currency === 'CHF' ? 'CHF' : '€'}{fromLoc.transport}</p>
            <p>💡 {t('residency.utilities')}: {fromLoc.currency === 'CHF' ? 'CHF' : '€'}{fromLoc.utilities}</p>
            {fromLoc.healthInsurance > 0 && (
              <p>🏥 LAMal: CHF{fromLoc.healthInsurance}</p>
            )}
          </div>
        </div>

        {/* Difference card */}
        <div className={`rounded-xl p-5 border-2 flex flex-col items-center justify-center ${
          result.monthlyDiff > 0
            ? 'bg-red-50 dark:bg-red-950/20 border-red-200 dark:border-red-800'
            : 'bg-emerald-50 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800'
        }`}>
          <TrendingUp className={`w-6 h-6 mb-2 ${result.monthlyDiff > 0 ? 'text-red-500 rotate-0' : 'text-emerald-500 rotate-180'}`} />
          <p className={`text-3xl font-black ${result.monthlyDiff > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
            {result.monthlyDiff > 0 ? '+' : ''}€{Math.round(result.monthlyDiff).toLocaleString('it-IT')}
          </p>
          <p className="text-xs text-slate-500 mt-1">{t('residency.monthlyDiff')}</p>

          {result.breakEvenMonths && (
            <div className="mt-3 flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
              <Clock className="w-3 h-3" />
              <span>{t('residency.breakEven', { months: result.breakEvenMonths.toString() })}</span>
            </div>
          )}
        </div>

        {/* To card */}
        <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
          <div className="flex items-center gap-2 mb-3">
            <MapPin className="w-4 h-4 text-indigo-400" />
            <h3 className="font-bold text-sm text-indigo-500">{t(`residency.loc.${to}`)} ({t('residency.new')})</h3>
          </div>
          <p className="text-2xl font-black text-slate-800 dark:text-slate-200">€{Math.round(result.toMonthly).toLocaleString('it-IT')}</p>
          <p className="text-xs text-slate-500">{t('residency.perMonth')}</p>
          <div className="mt-3 space-y-1 text-xs text-slate-500">
            <p>🏠 {t('residency.rent')}: {toLoc.currency === 'CHF' ? 'CHF' : '€'}{toLoc.avgRent}</p>
            <p>🛒 {t('residency.groceries')}: {toLoc.currency === 'CHF' ? 'CHF' : '€'}{toLoc.groceries}</p>
            <p>🚗 {t('residency.transport')}: {toLoc.currency === 'CHF' ? 'CHF' : '€'}{toLoc.transport}</p>
            <p>💡 {t('residency.utilities')}: {toLoc.currency === 'CHF' ? 'CHF' : '€'}{toLoc.utilities}</p>
            {toLoc.healthInsurance > 0 && (
              <p>🏥 LAMal: CHF{toLoc.healthInsurance}</p>
            )}
          </div>
        </div>
      </div>

      {/* One-time costs */}
      <div className="bg-white dark:bg-slate-800 rounded-xl p-5 border border-slate-200 dark:border-slate-700">
        <button onClick={() => setShowDetails(!showDetails)} className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <Euro className="w-5 h-5 text-amber-500" />
            <h3 className="font-bold text-slate-800 dark:text-slate-200">{t('residency.oneTimeCosts')}</h3>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-black text-amber-600 dark:text-amber-400">€{Math.round(result.totalOneTime).toLocaleString('it-IT')}</span>
            {showDetails ? <ChevronUp size={16} className="text-slate-500" /> : <ChevronDown size={16} className="text-slate-500" />}
          </div>
        </button>

        {showDetails && (
          <div className="mt-4 space-y-2">
            {result.oneTimeCosts.map((cost, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-slate-100 dark:border-slate-700 last:border-0">
                <span className="text-sm text-slate-600 dark:text-slate-500">{t(cost.label)}</span>
                <span className="text-sm font-bold text-slate-800 dark:text-slate-200">
                  {cost.currency === 'CHF' ? 'CHF' : '€'}{cost.amount.toLocaleString('it-IT')}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tax note */}
      {result.taxNote && (
        <div className="bg-indigo-50 dark:bg-indigo-950/20 rounded-xl p-4 border border-indigo-200 dark:border-indigo-800 flex items-start gap-3">
          <Briefcase className="w-5 h-5 text-indigo-500 shrink-0 mt-0.5" />
          <p className="text-sm text-indigo-700 dark:text-indigo-300">{t(result.taxNote)}</p>
        </div>
      )}

      {/* Disclaimer */}
      <div className="bg-amber-50 dark:bg-amber-950/20 rounded-xl p-4 border border-amber-200 dark:border-amber-800 flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
        <p className="text-xs text-amber-700 dark:text-amber-300">{t('residency.disclaimer')}</p>
      </div>
    </div>
  );
};

export default ResidencySimulator;
