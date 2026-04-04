/**
 * MortgageComparison — Confronto Mutui Italia vs Svizzera
 *
 * Interactive mortgage simulator for cross-border workers comparing:
 * - Monthly payments (rata mensile) IT vs CH
 * - Total interest cost over the loan duration
 * - Tax deductibility (detraibilità interessi)
 * - Swiss-specific rules: 20% equity, Tragbarkeit 33% @ 5% imputed rate
 * - Italian-specific rules: 19% deduction on max €4,000/yr interest
 *
 * Rate data sourced from:
 * - SNB SARON (global-rates.com, Feb 2026): -0.06%
 * - Euribor 3m (global-rates.com, Feb 2026): 2.01%
 * - ECB Refi Rate (Jun 2025): 2.15%
 * - Numbeo (Mar 2026): CH 20yr fixed 2.13% avg
 */

import { useState, useMemo, useCallback, useEffect, lazy, Suspense } from 'react';
import { useExchangeRate } from '@/services/exchangeRateService';

const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));
import { useTranslation } from '@/services/i18n';
import {
  Home,
  TrendingUp,
  Calculator,
  ChevronDown,
  ChevronUp,
  Info,
  AlertTriangle,
  Building2,
  Landmark,
  ArrowRightLeft,
  PiggyBank,
  BadgePercent,
  Receipt,
  Shield,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
} from 'recharts';

// ── Default rates (March 2026, verified from SNB/ECB/Numbeo/global-rates) ──

/** Swiss mortgage rates — SARON-based variable & fixed terms */
const CH_RATES = {
  variable: { label: 'SARON', rate: 1.20, description: 'SARON (-0.06%) + margine bancario ~1.25%' },
  fixed2:   { label: '2 anni fisso', rate: 1.15, description: 'Tasso fisso 2 anni' },
  fixed5:   { label: '5 anni fisso', rate: 1.40, description: 'Tasso fisso 5 anni' },
  fixed10:  { label: '10 anni fisso', rate: 1.75, description: 'Tasso fisso 10 anni' },
  fixed15:  { label: '15 anni fisso', rate: 2.10, description: 'Tasso fisso 15 anni' },
} as const;

/** Italian mortgage rates — Euribor variable & IRS-based fixed */
const IT_RATES = {
  variable: { label: 'Variabile (Euribor)', rate: 3.30, description: 'Euribor 3m (2.01%) + spread ~1.30%' },
  fixed20:  { label: '20 anni fisso', rate: 2.90, description: 'IRS 20y + spread bancario' },
  fixed25:  { label: '25 anni fisso', rate: 3.10, description: 'IRS 25y + spread bancario' },
  fixed30:  { label: '30 anni fisso', rate: 3.20, description: 'IRS 30y + spread bancario' },
} as const;

/** Swiss Tragbarkeit calculation uses imputed 5% rate */
const CH_IMPUTED_RATE = 5.0;
/** Swiss max housing cost as share of gross income */
const CH_TRAGBARKEIT_RATIO = 0.33;
/** Swiss minimum equity requirement */
const CH_MIN_EQUITY_RATIO = 0.20;
/** Italian max LTV for standard mortgages */
const IT_MAX_LTV = 0.80;
/** Italian interest tax deduction rate for prima casa */
const IT_DEDUCTION_RATE = 0.19;
/** Italian max annual interest deductible */
const IT_MAX_DEDUCTIBLE = 4000;
/** Italian substitute tax rate for prima casa */
const IT_IMPOSTA_SOSTITUTIVA = 0.0025;

type ChRateKey = keyof typeof CH_RATES;
type ItRateKey = keyof typeof IT_RATES;

interface AmortizationRow {
  month: number;
  payment: number;
  principal: number;
  interest: number;
  balance: number;
}

/** French amortization schedule calculation */
function computeAmortization(principal: number, annualRate: number, months: number): AmortizationRow[] {
  const r = annualRate / 100 / 12;
  if (r === 0) {
    const payment = principal / months;
    return Array.from({ length: months }, (_, i) => ({
      month: i + 1,
      payment,
      principal: payment,
      interest: 0,
      balance: principal - payment * (i + 1),
    }));
  }
  const payment = principal * (r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
  const rows: AmortizationRow[] = [];
  let balance = principal;
  for (let i = 0; i < months; i++) {
    const interest = balance * r;
    const princ = payment - interest;
    balance -= princ;
    rows.push({
      month: i + 1,
      payment,
      principal: princ,
      interest,
      balance: Math.max(0, balance),
    });
  }
  return rows;
}

/** Format number as currency */
function fmt(n: number, currency = '€'): string {
  return `${currency}${n.toLocaleString('it-IT', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function fmtDec(n: number, currency = '€'): string {
  return `${currency}${n.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

// ── Component ──

export default function MortgageComparison() {
  const { t } = useTranslation();

  // ─ Inputs
  const [propertyValue, setPropertyValue] = useState(350000);
  const [downPaymentPct, setDownPaymentPct] = useState(20);
  const [durationYears, setDurationYears] = useState(20);
  const [chRateKey, setChRateKey] = useState<ChRateKey>('fixed10');
  const [itRateKey, setItRateKey] = useState<ItRateKey>('fixed20');
  const [chCustomRate, setChCustomRate] = useState<number | null>(null);
  const [itCustomRate, setItCustomRate] = useState<number | null>(null);
  const [grossIncomeCHF, setGrossIncomeCHF] = useState(7000);
  const { rate: _liveRate } = useExchangeRate();
  const [exchangeRate, setExchangeRate] = useState(_liveRate);
  // Sync from live rate on first load
  useEffect(() => { if (_liveRate > 0) setExchangeRate(_liveRate); }, [_liveRate]);

  // ─ UI state
  const [showAmortization, setShowAmortization] = useState(false);
  const [showRules, setShowRules] = useState(false);

  const [isDark, setIsDark] = useState(() =>
    document.documentElement.classList.contains('dark')
  );
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
    return () => observer.disconnect();
  }, []);

  // ─ Derived values
  const loanAmount = propertyValue * (1 - downPaymentPct / 100);
  const months = durationYears * 12;
  const chRate = chCustomRate ?? CH_RATES[chRateKey].rate;
  const itRate = itCustomRate ?? IT_RATES[itRateKey].rate;

  // Swiss values in CHF, Italian in EUR — for comparison convert CH to EUR
  const propertyValueCHF = propertyValue / exchangeRate; // if buying in CH
  const loanAmountCHF = loanAmount / exchangeRate;

  // ─ Amortization
  const chAmort = useMemo(() => computeAmortization(loanAmount, chRate, months), [loanAmount, chRate, months]);
  const itAmort = useMemo(() => computeAmortization(loanAmount, itRate, months), [loanAmount, itRate, months]);

  const chMonthlyPayment = chAmort[0]?.payment ?? 0;
  const itMonthlyPayment = itAmort[0]?.payment ?? 0;

  const chTotalInterest = chAmort.reduce((s, r) => s + r.interest, 0);
  const itTotalInterest = itAmort.reduce((s, r) => s + r.interest, 0);

  const chTotalCost = chAmort.reduce((s, r) => s + r.payment, 0);
  const itTotalCost = itAmort.reduce((s, r) => s + r.payment, 0);

  // ─ Tax benefits
  // Italy: 19% on max €4,000/yr interest for prima casa
  const itAnnualInterests = useMemo(() => {
    const yearly: number[] = [];
    for (let y = 0; y < durationYears; y++) {
      const yearInterest = chAmort.slice(y * 12, (y + 1) * 12).reduce((s, r) => s + r.interest, 0);
      yearly.push(yearInterest);
    }
    return yearly;
  }, [chAmort, durationYears]);

  const itAnnualInterestsIT = useMemo(() => {
    const yearly: number[] = [];
    for (let y = 0; y < durationYears; y++) {
      const yearInterest = itAmort.slice(y * 12, (y + 1) * 12).reduce((s, r) => s + r.interest, 0);
      yearly.push(yearInterest);
    }
    return yearly;
  }, [itAmort, durationYears]);

  const itTaxSavings = useMemo(() => {
    return itAnnualInterestsIT.reduce((total, yearInt) => {
      const deductible = Math.min(yearInt, IT_MAX_DEDUCTIBLE);
      return total + deductible * IT_DEDUCTION_RATE;
    }, 0);
  }, [itAnnualInterestsIT]);

  // Swiss: interest deductible from taxable income (marginal tax rate ~25-35%)
  // We use 30% as typical marginal rate for a frontaliero
  const chMarginalTaxRate = 0.30;
  const chTaxSavings = chTotalInterest * chMarginalTaxRate;

  // ─ Tragbarkeit check (Swiss affordability)
  const chImputedAnnualCost = loanAmountCHF * (CH_IMPUTED_RATE / 100) + propertyValueCHF * 0.01; // 1% maintenance
  const chGrossAnnualIncome = grossIncomeCHF * 12;
  const chTragbarkeit = chGrossAnnualIncome > 0 ? chImputedAnnualCost / chGrossAnnualIncome : 1;
  const chTragbarkeitOk = chTragbarkeit <= CH_TRAGBARKEIT_RATIO;

  // ─ Equity check
  const equityAmount = propertyValue * (downPaymentPct / 100);
  const chEquityOk = downPaymentPct >= CH_MIN_EQUITY_RATIO * 100;
  const itLtvOk = (1 - downPaymentPct / 100) <= IT_MAX_LTV;

  // Imposta sostitutiva
  const itImpostaSostitutiva = loanAmount * IT_IMPOSTA_SOSTITUTIVA;

  // ─ Chart data: yearly comparison
  const yearlyChartData = useMemo(() => {
    const data = [];
    for (let y = 0; y < durationYears; y++) {
      const chYearPrincipal = chAmort.slice(y * 12, (y + 1) * 12).reduce((s, r) => s + r.principal, 0);
      const chYearInterest = chAmort.slice(y * 12, (y + 1) * 12).reduce((s, r) => s + r.interest, 0);
      const itYearPrincipal = itAmort.slice(y * 12, (y + 1) * 12).reduce((s, r) => s + r.principal, 0);
      const itYearInterest = itAmort.slice(y * 12, (y + 1) * 12).reduce((s, r) => s + r.interest, 0);
      data.push({
        year: y + 1,
        chInterest: Math.round(chYearInterest),
        itInterest: Math.round(itYearInterest),
        chPrincipal: Math.round(chYearPrincipal),
        itPrincipal: Math.round(itYearPrincipal),
      });
    }
    return data;
  }, [chAmort, itAmort, durationYears]);

  // ─ Balance over time chart
  const balanceChartData = useMemo(() => {
    const data = [];
    for (let y = 0; y <= durationYears; y++) {
      const monthIdx = Math.min(y * 12, months) - 1;
      data.push({
        year: y,
        ch: y === 0 ? loanAmount : Math.round(chAmort[monthIdx]?.balance ?? 0),
        it: y === 0 ? loanAmount : Math.round(itAmort[monthIdx]?.balance ?? 0),
      });
    }
    return data;
  }, [chAmort, itAmort, durationYears, months, loanAmount]);

  const savings = itTotalCost - chTotalCost;
  const savingsLabel = savings > 0 ? t('mortgage.cheaperInCH') : t('mortgage.cheaperInIT');

  const handleReset = useCallback(() => {
    setPropertyValue(350000);
    setDownPaymentPct(20);
    setDurationYears(20);
    setChRateKey('fixed10');
    setItRateKey('fixed20');
    setChCustomRate(null);
    setItCustomRate(null);
    setGrossIncomeCHF(7000);
    setExchangeRate(0.94);
  }, []);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="text-center space-y-2">
        <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 text-sm font-medium">
          <Home size={16} />
          {t('mortgage.badge')}
        </div>
        <h1 className="text-2xl sm:text-3xl font-bold text-slate-800 dark:text-slate-100">
          {t('mortgage.title')}
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400 max-w-2xl mx-auto">
          {t('mortgage.subtitle')}
        </p>
        <p className="text-sm text-slate-600 dark:text-slate-300 mt-3 leading-relaxed max-w-2xl mx-auto">
          {t('comparatori.mortgage.intro.p1')}
        </p>
      </div>

      {/* Input Panel */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-300 dark:border-slate-600 p-4 sm:p-6 space-y-5 shadow-sm">
        <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
          <Calculator size={20} className="text-purple-600 dark:text-purple-400" />
          {t('mortgage.parameters')}
        </h2>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {/* Property value */}
          <div className="bg-slate-50 dark:bg-slate-750 rounded-lg p-3">
            <label htmlFor="propertyValue" className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
              {t('mortgage.propertyValue')} (€)
            </label>
            <input
              id="propertyValue"
              type="range"
              min={100000}
              max={1500000}
              step={10000}
              value={propertyValue}
              onChange={(e) => setPropertyValue(Number(e.target.value))}
              className="w-full accent-purple-600"
            />
            <div className="text-sm font-bold text-purple-700 dark:text-purple-300 mt-0.5">{fmt(propertyValue)}</div>
          </div>

          {/* Down payment */}
          <div className="bg-slate-50 dark:bg-slate-750 rounded-lg p-3">
            <label htmlFor="downPayment" className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
              {t('mortgage.downPayment')} (%)
            </label>
            <input
              id="downPayment"
              type="range"
              min={5}
              max={50}
              step={1}
              value={downPaymentPct}
              onChange={(e) => setDownPaymentPct(Number(e.target.value))}
              className="w-full accent-purple-600"
            />
            <div className="text-sm font-bold text-purple-700 dark:text-purple-300 mt-0.5">
              {downPaymentPct}% — {fmt(equityAmount)}
            </div>
          </div>

          {/* Duration */}
          <div className="bg-slate-50 dark:bg-slate-750 rounded-lg p-3">
            <label htmlFor="duration" className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
              {t('mortgage.duration')} ({t('mortgage.years')})
            </label>
            <input
              id="duration"
              type="range"
              min={5}
              max={30}
              step={1}
              value={durationYears}
              onChange={(e) => setDurationYears(Number(e.target.value))}
              className="w-full accent-purple-600"
            />
            <div className="text-sm font-bold text-purple-700 dark:text-purple-300 mt-0.5">{durationYears} {t('mortgage.years')}</div>
          </div>

          {/* Gross income for Tragbarkeit */}
          <div className="bg-slate-50 dark:bg-slate-750 rounded-lg p-3">
            <label htmlFor="grossIncome" className="block text-xs font-bold text-slate-700 dark:text-slate-300 mb-1">
              {t('mortgage.grossIncome')} (CHF/mese)
            </label>
            <input
              id="grossIncome"
              type="range"
              min={3000}
              max={20000}
              step={500}
              value={grossIncomeCHF}
              onChange={(e) => setGrossIncomeCHF(Number(e.target.value))}
              className="w-full accent-purple-600"
            />
            <div className="text-sm font-bold text-purple-700 dark:text-purple-300 mt-0.5">CHF {grossIncomeCHF.toLocaleString('it-IT')}</div>
          </div>
        </div>

        {/* Rate selection */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-slate-300 dark:border-slate-600">
          {/* CH Rate */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-lg">🇨🇭</span>
              <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{t('mortgage.chRate')}</span>
            </div>
            <select
              id="chRate"
              value={chRateKey}
              onChange={(e) => { setChRateKey(e.target.value as ChRateKey); setChCustomRate(null); }}
              className="w-full rounded-lg border border-slate-400 dark:border-slate-500 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200 text-sm py-2 px-3 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition-colors"
              aria-label={t('mortgage.chRate')}
            >
              {Object.entries(CH_RATES).map(([key, { label, rate }]) => (
                <option key={key} value={key}>{label} — {fmtPct(rate)}</option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <label htmlFor="chCustomRate" className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('mortgage.customRate')}:</label>
              <input
                id="chCustomRate"
                type="number"
                step={0.05}
                min={0}
                max={10}
                placeholder={CH_RATES[chRateKey].rate.toString()}
                value={chCustomRate ?? ''}
                onChange={(e) => setChCustomRate(e.target.value ? Number(e.target.value) : null)}
                className="w-20 rounded border border-slate-400 dark:border-slate-500 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200 text-sm py-1 px-2 focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              />
              <span className="text-xs font-medium text-slate-600 dark:text-slate-400">%</span>
            </div>
          </div>

          {/* IT Rate */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-lg">🇮🇹</span>
              <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{t('mortgage.itRate')}</span>
            </div>
            <select
              id="itRate"
              value={itRateKey}
              onChange={(e) => { setItRateKey(e.target.value as ItRateKey); setItCustomRate(null); }}
              className="w-full rounded-lg border border-slate-400 dark:border-slate-500 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200 text-sm py-2 px-3 focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition-colors"
              aria-label={t('mortgage.itRate')}
            >
              {Object.entries(IT_RATES).map(([key, { label, rate }]) => (
                <option key={key} value={key}>{label} — {fmtPct(rate)}</option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <label htmlFor="itCustomRate" className="text-xs font-medium text-slate-600 dark:text-slate-300">{t('mortgage.customRate')}:</label>
              <input
                id="itCustomRate"
                type="number"
                step={0.05}
                min={0}
                max={10}
                placeholder={IT_RATES[itRateKey].rate.toString()}
                value={itCustomRate ?? ''}
                onChange={(e) => setItCustomRate(e.target.value ? Number(e.target.value) : null)}
                className="w-20 rounded border border-slate-400 dark:border-slate-500 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200 text-sm py-1 px-2 focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
              />
              <span className="text-xs font-medium text-slate-600 dark:text-slate-400">%</span>
            </div>
          </div>
        </div>

        {/* Exchange rate */}
        <div className="flex items-center gap-3 pt-3 border-t border-slate-300 dark:border-slate-600">
          <ArrowRightLeft size={16} className="text-purple-500 dark:text-purple-400" />
          <label htmlFor="exchangeRate" className="text-xs font-bold text-slate-700 dark:text-slate-300">
            {t('mortgage.exchangeRate')} (1 CHF = € ...)
          </label>
          <input
            id="exchangeRate"
            type="number"
            step={0.01}
            min={0.5}
            max={1.5}
            value={exchangeRate}
            onChange={(e) => setExchangeRate(Number(e.target.value))}
            className="w-20 rounded border border-slate-400 dark:border-slate-500 bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-200 text-sm py-1 px-2 focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
          />
          <button
            onClick={handleReset}
            className="ml-auto text-xs text-purple-600 dark:text-purple-400 hover:underline"
            aria-label={t('mortgage.reset')}
          >
            {t('mortgage.reset')}
          </button>
        </div>
      </div>

      {/* KPI Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Monthly payment comparison */}
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-300 dark:border-slate-600 p-4 text-center shadow-sm">
          <div className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{t('mortgage.monthlyPayment')} 🇨🇭</div>
          <div className="text-xl font-bold text-red-600 dark:text-red-400">{fmtDec(chMonthlyPayment)}</div>
          <div className="text-xs font-medium text-slate-600 dark:text-slate-400">{t('mortgage.rate')}: {fmtPct(chRate)}</div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-300 dark:border-slate-600 p-4 text-center shadow-sm">
          <div className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{t('mortgage.monthlyPayment')} 🇮🇹</div>
          <div className="text-xl font-bold text-green-600 dark:text-green-400">{fmtDec(itMonthlyPayment)}</div>
          <div className="text-xs font-medium text-slate-600 dark:text-slate-400">{t('mortgage.rate')}: {fmtPct(itRate)}</div>
        </div>
        <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-300 dark:border-slate-600 p-4 text-center shadow-sm">
          <div className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{t('mortgage.totalInterest')}</div>
          <div className="text-lg font-bold text-slate-700 dark:text-slate-200">
            <span className="text-red-600 dark:text-red-400">{fmt(Math.round(chTotalInterest))}</span>
            <span className="text-slate-500 dark:text-slate-400 mx-1">vs</span>
            <span className="text-green-600 dark:text-green-400">{fmt(Math.round(itTotalInterest))}</span>
          </div>
        </div>
        <div className={`rounded-xl border p-4 text-center ${
          savings > 0
            ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
            : 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
        }`}>
          <div className="text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">{t('mortgage.savings')}</div>
          <div className={`text-xl font-bold ${savings > 0 ? 'text-red-600 dark:text-red-400' : 'text-green-600 dark:text-green-400'}`}>
            {fmt(Math.round(Math.abs(savings)))}
          </div>
          <div className="text-xs text-slate-600 dark:text-slate-400">{savingsLabel}</div>
        </div>
      </div>

      {/* Affordability & Rules Checks */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {/* Swiss Tragbarkeit */}
        <div className={`bg-white dark:bg-slate-800 rounded-xl border p-4 ${
          chTragbarkeitOk
            ? 'border-emerald-200 dark:border-emerald-800'
            : 'border-amber-200 dark:border-amber-800'
        }`}>
          <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-3">
            <Shield size={16} className="text-red-500" />
            🇨🇭 {t('mortgage.tragbarkeit')}
          </h3>
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-600 dark:text-slate-400">{t('mortgage.imputedRate')}</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200">{fmtPct(CH_IMPUTED_RATE)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600 dark:text-slate-400">{t('mortgage.annualCost')}</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200">{fmt(Math.round(chImputedAnnualCost), 'CHF ')}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600 dark:text-slate-400">{t('mortgage.costToIncomeRatio')}</span>
              <span className={`font-bold ${chTragbarkeitOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                {fmtPct(chTragbarkeit * 100)} {chTragbarkeitOk ? '✓' : '✗'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600 dark:text-slate-400">{t('mortgage.maxAllowed')}</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200">{fmtPct(CH_TRAGBARKEIT_RATIO * 100)}</span>
            </div>
            {!chTragbarkeitOk && (
              <div className="flex items-start gap-1.5 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-2 mt-1">
                <AlertTriangle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
                <span className="text-amber-700 dark:text-amber-300">{t('mortgage.tragbarkeitWarning')}</span>
              </div>
            )}
          </div>
        </div>

        {/* Equity & LTV checks */}
        <div className={`bg-white dark:bg-slate-800 rounded-xl border p-4 ${
          chEquityOk && itLtvOk
            ? 'border-emerald-200 dark:border-emerald-800'
            : 'border-amber-200 dark:border-amber-800'
        }`}>
          <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-3">
            <PiggyBank size={16} className="text-purple-500" />
            {t('mortgage.equityCheck')}
          </h3>
          <div className="space-y-2 text-xs">
            <div className="flex justify-between">
              <span className="text-slate-600 dark:text-slate-400">{t('mortgage.yourEquity')}</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200">{fmt(equityAmount)} ({downPaymentPct}%)</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600 dark:text-slate-400">🇨🇭 {t('mortgage.minEquity')}</span>
              <span className={`font-bold ${chEquityOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                20% — {fmt(propertyValue * 0.2)} {chEquityOk ? '✓' : '✗'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600 dark:text-slate-400">🇮🇹 Max LTV</span>
              <span className={`font-bold ${itLtvOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                80% — {fmt(propertyValue * 0.8)} {itLtvOk ? '✓' : '✗'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-600 dark:text-slate-400">{t('mortgage.loanAmount')}</span>
              <span className="font-semibold text-slate-800 dark:text-slate-200">{fmt(loanAmount)}</span>
            </div>
            {!chEquityOk && (
              <div className="flex items-start gap-1.5 bg-amber-50 dark:bg-amber-900/20 rounded-lg p-2 mt-1">
                <AlertTriangle size={14} className="text-amber-500 flex-shrink-0 mt-0.5" />
                <span className="text-amber-700 dark:text-amber-300">{t('mortgage.equityWarning')}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Tax Benefits Comparison */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6">
        <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-4">
          <Receipt size={20} className="text-purple-600 dark:text-purple-400" />
          {t('mortgage.taxBenefits')}
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Swiss tax benefits */}
          <div className="bg-red-50 dark:bg-red-900/10 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">🇨🇭</span>
              <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{t('mortgage.chTaxBenefits')}</span>
            </div>
            <div className="text-xs space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-slate-400">{t('mortgage.interestDeduction')}</span>
                <span className="font-semibold text-slate-800 dark:text-slate-200">{t('mortgage.fromTaxableIncome')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-slate-400">{t('mortgage.totalInterestPaid')}</span>
                <span className="font-semibold text-slate-800 dark:text-slate-200">{fmt(Math.round(chTotalInterest))}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-slate-400">{t('mortgage.estimatedTaxSaving')}</span>
                <span className="font-bold text-emerald-600 dark:text-emerald-400">~{fmt(Math.round(chTaxSavings))}</span>
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 italic mt-1">
                {t('mortgage.chTaxNote')}
              </div>
            </div>
          </div>

          {/* Italian tax benefits */}
          <div className="bg-green-50 dark:bg-green-900/10 rounded-xl p-4 space-y-2">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-lg">🇮🇹</span>
              <span className="text-sm font-bold text-slate-700 dark:text-slate-200">{t('mortgage.itTaxBenefits')}</span>
            </div>
            <div className="text-xs space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-slate-400">{t('mortgage.interestDeduction')}</span>
                <span className="font-semibold text-slate-800 dark:text-slate-200">19% {t('mortgage.onMax')} €4.000/{t('mortgage.year')}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-slate-400">{t('mortgage.totalInterestPaid')}</span>
                <span className="font-semibold text-slate-800 dark:text-slate-200">{fmt(Math.round(itTotalInterest))}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-slate-400">{t('mortgage.estimatedTaxSaving')}</span>
                <span className="font-bold text-emerald-600 dark:text-emerald-400">{fmt(Math.round(itTaxSavings))}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-600 dark:text-slate-400">{t('mortgage.impostaSostitutiva')}</span>
                <span className="font-semibold text-amber-600 dark:text-amber-400">{fmt(Math.round(itImpostaSostitutiva))}</span>
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 italic mt-1">
                {t('mortgage.itTaxNote')}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Interest vs Principal Chart (Yearly) */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6">
        <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-4">
          <TrendingUp size={20} className="text-purple-600 dark:text-purple-400" />
          {t('mortgage.interestChart')}
        </h2>
        <div className="h-64 sm:h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={yearlyChartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#334155' : '#e2e8f0'} />
              <XAxis dataKey="year" tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b' }} label={{ value: t('mortgage.year'), position: 'insideBottom', offset: -3, style: { fontSize: 11 }, fill: isDark ? '#94a3b8' : '#64748b' }} />
              <YAxis tick={{ fontSize: 10, fill: isDark ? '#94a3b8' : '#64748b' }} tickFormatter={(v: number) => `€${(v / 1000).toFixed(0)}k`} />
              <RechartsTooltip
                contentStyle={{ borderRadius: '8px', backgroundColor: isDark ? '#1e293b' : '#fff', color: isDark ? '#e2e8f0' : '#1e293b', border: isDark ? '1px solid #334155' : '1px solid #e2e8f0' }}
                formatter={(value: number, name: string) => [fmt(value), name]}
                labelFormatter={(y: number) => `${t('mortgage.year')} ${y}`}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: isDark ? '#94a3b8' : '#64748b' }} />
              <Bar dataKey="chInterest" name="🇨🇭 Interessi" stackId="ch" fill="#ef4444" radius={[0, 0, 0, 0]} />
              <Bar dataKey="chPrincipal" name="🇨🇭 Capitale" stackId="ch" fill="#fca5a5" radius={[4, 4, 0, 0]} />
              <Bar dataKey="itInterest" name="🇮🇹 Interessi" stackId="it" fill="#22c55e" radius={[0, 0, 0, 0]} />
              <Bar dataKey="itPrincipal" name="🇮🇹 Capitale" stackId="it" fill="#86efac" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Remaining Balance Chart */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6">
        <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-4">
          <BadgePercent size={20} className="text-purple-600 dark:text-purple-400" />
          {t('mortgage.balanceChart')}
        </h2>
        <div className="h-56 sm:h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={balanceChartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? '#334155' : '#e2e8f0'} />
              <XAxis dataKey="year" tick={{ fontSize: 11, fill: isDark ? '#94a3b8' : '#64748b' }} label={{ value: t('mortgage.year'), position: 'insideBottom', offset: -3, style: { fontSize: 11 }, fill: isDark ? '#94a3b8' : '#64748b' }} />
              <YAxis tick={{ fontSize: 10, fill: isDark ? '#94a3b8' : '#64748b' }} tickFormatter={(v: number) => `€${(v / 1000).toFixed(0)}k`} />
              <RechartsTooltip
                contentStyle={{ borderRadius: '8px', backgroundColor: isDark ? '#1e293b' : '#fff', color: isDark ? '#e2e8f0' : '#1e293b', border: isDark ? '1px solid #334155' : '1px solid #e2e8f0' }}
                formatter={(value: number, name: string) => [fmt(value), name]}
                labelFormatter={(y: number) => `${t('mortgage.year')} ${y}`}
              />
              <Legend wrapperStyle={{ fontSize: 11, color: isDark ? '#94a3b8' : '#64748b' }} />
              <Line type="monotone" dataKey="ch" name="🇨🇭 Debito residuo" stroke="#ef4444" strokeWidth={2} dot={false} />
              <Line type="monotone" dataKey="it" name="🇮🇹 Debito residuo" stroke="#22c55e" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Detailed Summary Table */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6">
        <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-4">
          <Landmark size={20} className="text-purple-600 dark:text-purple-400" />
          {t('mortgage.summaryTable')}
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-700">
                <th className="text-left py-2 px-3 text-slate-600 dark:text-slate-400 font-semibold">{t('mortgage.parameter')}</th>
                <th className="text-right py-2 px-3 text-red-600 dark:text-red-400 font-semibold">🇨🇭 {t('mortgage.switzerland')}</th>
                <th className="text-right py-2 px-3 text-green-600 dark:text-green-400 font-semibold">🇮🇹 {t('mortgage.italy')}</th>
                <th className="text-right py-2 px-3 text-purple-600 dark:text-purple-400 font-semibold">{t('mortgage.difference')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
              <tr>
                <td className="py-2 px-3 text-slate-700 dark:text-slate-300">{t('mortgage.rate')}</td>
                <td className="py-2 px-3 text-right font-semibold text-slate-800 dark:text-slate-200">{fmtPct(chRate)}</td>
                <td className="py-2 px-3 text-right font-semibold text-slate-800 dark:text-slate-200">{fmtPct(itRate)}</td>
                <td className="py-2 px-3 text-right font-semibold text-purple-600 dark:text-purple-400">{fmtPct(Math.abs(itRate - chRate))}</td>
              </tr>
              <tr>
                <td className="py-2 px-3 text-slate-700 dark:text-slate-300">{t('mortgage.monthlyPayment')}</td>
                <td className="py-2 px-3 text-right font-semibold text-slate-800 dark:text-slate-200">{fmtDec(chMonthlyPayment)}</td>
                <td className="py-2 px-3 text-right font-semibold text-slate-800 dark:text-slate-200">{fmtDec(itMonthlyPayment)}</td>
                <td className="py-2 px-3 text-right font-semibold text-purple-600 dark:text-purple-400">{fmtDec(Math.abs(itMonthlyPayment - chMonthlyPayment))}</td>
              </tr>
              <tr>
                <td className="py-2 px-3 text-slate-700 dark:text-slate-300">{t('mortgage.totalInterest')}</td>
                <td className="py-2 px-3 text-right font-semibold text-slate-800 dark:text-slate-200">{fmt(Math.round(chTotalInterest))}</td>
                <td className="py-2 px-3 text-right font-semibold text-slate-800 dark:text-slate-200">{fmt(Math.round(itTotalInterest))}</td>
                <td className="py-2 px-3 text-right font-semibold text-purple-600 dark:text-purple-400">{fmt(Math.round(Math.abs(itTotalInterest - chTotalInterest)))}</td>
              </tr>
              <tr>
                <td className="py-2 px-3 text-slate-700 dark:text-slate-300">{t('mortgage.totalCost')}</td>
                <td className="py-2 px-3 text-right font-bold text-red-600 dark:text-red-400">{fmt(Math.round(chTotalCost))}</td>
                <td className="py-2 px-3 text-right font-bold text-green-600 dark:text-green-400">{fmt(Math.round(itTotalCost))}</td>
                <td className="py-2 px-3 text-right font-bold text-purple-600 dark:text-purple-400">{fmt(Math.round(Math.abs(savings)))}</td>
              </tr>
              <tr>
                <td className="py-2 px-3 text-slate-700 dark:text-slate-300">{t('mortgage.taxSaving')}</td>
                <td className="py-2 px-3 text-right font-semibold text-emerald-600 dark:text-emerald-400">~{fmt(Math.round(chTaxSavings))}</td>
                <td className="py-2 px-3 text-right font-semibold text-emerald-600 dark:text-emerald-400">{fmt(Math.round(itTaxSavings))}</td>
                <td className="py-2 px-3 text-right font-semibold text-purple-600 dark:text-purple-400">{fmt(Math.round(Math.abs(chTaxSavings - itTaxSavings)))}</td>
              </tr>
              <tr>
                <td className="py-2 px-3 text-slate-700 dark:text-slate-300">{t('mortgage.netCost')}</td>
                <td className="py-2 px-3 text-right font-bold text-red-600 dark:text-red-400">{fmt(Math.round(chTotalCost - chTaxSavings))}</td>
                <td className="py-2 px-3 text-right font-bold text-green-600 dark:text-green-400">{fmt(Math.round(itTotalCost - itTaxSavings))}</td>
                <td className="py-2 px-3 text-right font-bold text-purple-600 dark:text-purple-400">
                  {fmt(Math.round(Math.abs((chTotalCost - chTaxSavings) - (itTotalCost - itTaxSavings))))}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Amortization table (collapsible) */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700">
        <button
          onClick={() => setShowAmortization(!showAmortization)}
          className="w-full flex items-center justify-between p-4 sm:p-6 text-left"
          aria-expanded={showAmortization}
          aria-label={t('mortgage.amortizationTable')}
        >
          <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
            <Building2 size={20} className="text-purple-600 dark:text-purple-400" />
            {t('mortgage.amortizationTable')}
          </h2>
          {showAmortization ? <ChevronUp size={20} className="text-slate-500 dark:text-slate-400" /> : <ChevronDown size={20} className="text-slate-500 dark:text-slate-400" />}
        </button>
        {showAmortization && (
          <div className="px-4 sm:px-6 pb-4 sm:pb-6 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-200 dark:border-slate-700">
                  <th className="text-left py-2 px-2 text-slate-600 dark:text-slate-400">{t('mortgage.year')}</th>
                  <th className="text-right py-2 px-2 text-red-600 dark:text-red-400">🇨🇭 {t('mortgage.payment')}</th>
                  <th className="text-right py-2 px-2 text-red-600 dark:text-red-400">🇨🇭 {t('mortgage.interestLabel')}</th>
                  <th className="text-right py-2 px-2 text-red-600 dark:text-red-400">🇨🇭 {t('mortgage.balance')}</th>
                  <th className="text-right py-2 px-2 text-green-600 dark:text-green-400">🇮🇹 {t('mortgage.payment')}</th>
                  <th className="text-right py-2 px-2 text-green-600 dark:text-green-400">🇮🇹 {t('mortgage.interestLabel')}</th>
                  <th className="text-right py-2 px-2 text-green-600 dark:text-green-400">🇮🇹 {t('mortgage.balance')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-700">
                {Array.from({ length: durationYears }, (_, y) => {
                  const chYearPayment = chAmort.slice(y * 12, (y + 1) * 12).reduce((s, r) => s + r.payment, 0);
                  const chYearInterest = chAmort.slice(y * 12, (y + 1) * 12).reduce((s, r) => s + r.interest, 0);
                  const chYearEndBalance = chAmort[Math.min((y + 1) * 12 - 1, months - 1)]?.balance ?? 0;
                  const itYearPayment = itAmort.slice(y * 12, (y + 1) * 12).reduce((s, r) => s + r.payment, 0);
                  const itYearInterest = itAmort.slice(y * 12, (y + 1) * 12).reduce((s, r) => s + r.interest, 0);
                  const itYearEndBalance = itAmort[Math.min((y + 1) * 12 - 1, months - 1)]?.balance ?? 0;
                  return (
                    <tr key={y} className="hover:bg-slate-50 dark:hover:bg-slate-700/50">
                      <td className="py-1.5 px-2 font-semibold text-slate-700 dark:text-slate-300">{y + 1}</td>
                      <td className="py-1.5 px-2 text-right text-slate-800 dark:text-slate-200">{fmt(Math.round(chYearPayment))}</td>
                      <td className="py-1.5 px-2 text-right text-red-600 dark:text-red-400">{fmt(Math.round(chYearInterest))}</td>
                      <td className="py-1.5 px-2 text-right text-slate-800 dark:text-slate-200">{fmt(Math.round(chYearEndBalance))}</td>
                      <td className="py-1.5 px-2 text-right text-slate-800 dark:text-slate-200">{fmt(Math.round(itYearPayment))}</td>
                      <td className="py-1.5 px-2 text-right text-green-600 dark:text-green-400">{fmt(Math.round(itYearInterest))}</td>
                      <td className="py-1.5 px-2 text-right text-slate-800 dark:text-slate-200">{fmt(Math.round(itYearEndBalance))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Rules & Info (collapsible) */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700">
        <button
          onClick={() => setShowRules(!showRules)}
          className="w-full flex items-center justify-between p-4 sm:p-6 text-left"
          aria-expanded={showRules}
          aria-label={t('mortgage.rulesTitle')}
        >
          <h2 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
            <Info size={20} className="text-purple-600 dark:text-purple-400" />
            {t('mortgage.rulesTitle')}
          </h2>
          {showRules ? <ChevronUp size={20} className="text-slate-500 dark:text-slate-400" /> : <ChevronDown size={20} className="text-slate-500 dark:text-slate-400" />}
        </button>
        {showRules && (
          <div className="px-4 sm:px-6 pb-4 sm:pb-6 space-y-4">
            {/* Swiss rules */}
            <div className="bg-red-50/50 dark:bg-red-900/10 rounded-xl p-4">
              <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-2">
                🇨🇭 {t('mortgage.chRulesTitle')}
              </h3>
              <ul className="text-xs text-slate-600 dark:text-slate-400 space-y-1.5 list-disc list-inside">
                <li>{t('mortgage.chRule1')}</li>
                <li>{t('mortgage.chRule2')}</li>
                <li>{t('mortgage.chRule3')}</li>
                <li>{t('mortgage.chRule4')}</li>
                <li>{t('mortgage.chRule5')}</li>
                <li>{t('mortgage.chRule6')}</li>
              </ul>
            </div>
            {/* Italian rules */}
            <div className="bg-green-50/50 dark:bg-green-900/10 rounded-xl p-4">
              <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-2">
                🇮🇹 {t('mortgage.itRulesTitle')}
              </h3>
              <ul className="text-xs text-slate-600 dark:text-slate-400 space-y-1.5 list-disc list-inside">
                <li>{t('mortgage.itRule1')}</li>
                <li>{t('mortgage.itRule2')}</li>
                <li>{t('mortgage.itRule3')}</li>
                <li>{t('mortgage.itRule4')}</li>
                <li>{t('mortgage.itRule5')}</li>
                <li>{t('mortgage.itRule6')}</li>
              </ul>
            </div>
            {/* Frontaliero-specific */}
            <div className="bg-purple-50/50 dark:bg-purple-900/10 rounded-xl p-4">
              <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2 mb-2">
                🔑 {t('mortgage.frontalieroRulesTitle')}
              </h3>
              <ul className="text-xs text-slate-600 dark:text-slate-400 space-y-1.5 list-disc list-inside">
                <li>{t('mortgage.frontRule1')}</li>
                <li>{t('mortgage.frontRule2')}</li>
                <li>{t('mortgage.frontRule3')}</li>
                <li>{t('mortgage.frontRule4')}</li>
              </ul>
            </div>
          </div>
        )}
      </div>

      {/* Data sources disclaimer */}
      <div className="text-center text-xs text-slate-500 dark:text-slate-400 space-y-0.5 pb-4">
        <p>{t('mortgage.dataSource')}</p>
        <p>{t('mortgage.disclaimer')}</p>
      </div>
      <Suspense fallback={null}><RelatedTools context="exchange" /></Suspense>
    </div>
  );
}
