import React, { useState, useMemo, useCallback, lazy, Suspense } from 'react';
import { useExchangeRate } from '@/services/exchangeRateService';
import { useTranslation } from '@/services/i18n';
import { buildPath } from '@/services/router';

const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));
import {
  Calculator, Info, AlertTriangle, ArrowRight, PiggyBank,
  TrendingUp, Euro, Banknote, Scale, HelpCircle, ExternalLink,
  Share2, Check, ChevronDown, ChevronUp, Clock
} from 'lucide-react';

// ── Constants ─────────────────────────────────────────────────

/** LPP (2° pilastro) contribution rates by age bracket — employer + employee total */
const LPP_RATES: { minAge: number; maxAge: number; rate: number }[] = [
  { minAge: 25, maxAge: 34, rate: 0.07 },
  { minAge: 35, maxAge: 44, rate: 0.10 },
  { minAge: 45, maxAge: 54, rate: 0.15 },
  { minAge: 55, maxAge: 65, rate: 0.18 },
];

/** BVG/LPP minimum interest rate (2026) */
const LPP_INTEREST_RATE = 0.0125;

/** LPP coordination deduction 2026 */
const LPP_COORD_DEDUCTION = 25_725;

/** LPP maximum insured salary 2026 */
const LPP_MAX_INSURED = 88_200;

/** LPP conversion rate at age 65 */
const LPP_CONVERSION_RATE = 0.068;

/** Italian TFR formula constants */
const TFR_DIVISOR = 13.5;
const TFR_FIXED_REVALUATION = 0.015; // 1.5% fixed
const TFR_INFLATION_SHARE = 0.75;   // 75% of ISTAT inflation

/** Default ISTAT inflation assumption */
const DEFAULT_INFLATION = 0.02; // 2%

/** CHF→EUR exchange rate fallback (overridden by useExchangeRate hook) */
const CHF_EUR_FALLBACK = 1.06;

// ── Types ────────────────────────────────────────────────────

interface TfrInputs {
  grossSalaryCHF: number;
  grossSalaryEUR: number;
  currentAge: number;
  yearsToSimulate: number;
  inflationRate: number;
  lppInterestRate: number;
  /** Whether the user has an Italian employment (for TFR comparison) */
  compareFiscalImpact: boolean;
}

interface YearlyRow {
  year: number;
  age: number;
  tfrAccrual: number;
  tfrRevaluation: number;
  tfrCumulative: number;
  lppContribution: number;
  lppInterest: number;
  lppCumulative: number;
}

interface SimulationResult {
  rows: YearlyRow[];
  tfrTotal: number;
  lppTotal: number;
  difference: number;
  differencePercent: number;
  lppMonthlyPension: number;
  tfrMonthlyEquivalent: number;
}

// ── Helpers ──────────────────────────────────────────────────

function getLppRate(age: number): number {
  for (const bracket of LPP_RATES) {
    if (age >= bracket.minAge && age <= bracket.maxAge) return bracket.rate;
  }
  return 0;
}

function getCoordinatedSalary(grossCHF: number): number {
  const insured = Math.min(grossCHF, LPP_MAX_INSURED);
  return Math.max(0, insured - LPP_COORD_DEDUCTION);
}

function calculateTfrRevaluation(previousTotal: number, inflationRate: number): number {
  // TFR revaluation formula: 1.5% + 75% of ISTAT inflation
  const rate = TFR_FIXED_REVALUATION + TFR_INFLATION_SHARE * inflationRate;
  return previousTotal * rate;
}

// ── Info tooltip ──────────────────────────────────────────────

const InfoTooltip = ({ text }: { text: string }) => {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('touchstart', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('touchstart', close); };
  }, [open]);
  return (
    <button ref={ref} type="button" onClick={() => setOpen(v => !v)} aria-label="Info" className="group relative inline-flex items-center ml-1.5 cursor-help">
      <Info size={14} className="text-muted hover:text-teal-600 transition-colors" />
      <div className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-3 bg-slate-800 dark:bg-slate-700 text-white text-xs leading-relaxed rounded-xl shadow-2xl z-50 border border-slate-600 ${open ? 'block' : 'hidden group-hover:block'}`}>
        {text}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-slate-800 dark:border-t-slate-700"></div>
      </div>
    </button>
  );
};

// ── Component ────────────────────────────────────────────────

const TfrCalculator: React.FC = () => {
  const { t } = useTranslation();
  const { rate: CHF_EUR } = useExchangeRate();

  const [inputs, setInputs] = useState<TfrInputs>({
    grossSalaryCHF: 80_000,
    grossSalaryEUR: Math.round(80_000 / CHF_EUR_FALLBACK),
    currentAge: 30,
    yearsToSimulate: 20,
    inflationRate: DEFAULT_INFLATION * 100,
    lppInterestRate: LPP_INTEREST_RATE * 100,
    compareFiscalImpact: true,
  });

  const [showTable, setShowTable] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleChange = useCallback((field: keyof TfrInputs, value: number | boolean) => {
    setInputs(prev => {
      const next = { ...prev, [field]: value };
      // Sync EUR salary when CHF changes
      if (field === 'grossSalaryCHF') {
        next.grossSalaryEUR = Math.round((value as number) / CHF_EUR);
      }
      if (field === 'grossSalaryEUR') {
        next.grossSalaryCHF = Math.round((value as number) * CHF_EUR);
      }
      return next;
    });
  }, []);

  // ── Simulation ──────────────────────────────────────────────

  const result = useMemo<SimulationResult>(() => {
    const rows: YearlyRow[] = [];
    let tfrCumulative = 0;
    let lppCumulative = 0;
    const inflationDecimal = inputs.inflationRate / 100;
    const lppInterestDecimal = inputs.lppInterestRate / 100;

    for (let i = 0; i < inputs.yearsToSimulate; i++) {
      const age = inputs.currentAge + i;

      // ── TFR ──
      const tfrAccrual = inputs.grossSalaryEUR / TFR_DIVISOR;
      const tfrRevaluation = i > 0 ? calculateTfrRevaluation(tfrCumulative, inflationDecimal) : 0;
      tfrCumulative += tfrAccrual + tfrRevaluation;

      // ── LPP ──
      const lppRate = getLppRate(age);
      const coordSalary = getCoordinatedSalary(inputs.grossSalaryCHF);
      const lppContribution = coordSalary * lppRate;
      const lppInterest = lppCumulative * lppInterestDecimal;
      lppCumulative += lppContribution + lppInterest;

      rows.push({
        year: i + 1,
        age,
        tfrAccrual: Math.round(tfrAccrual),
        tfrRevaluation: Math.round(tfrRevaluation),
        tfrCumulative: Math.round(tfrCumulative),
        lppContribution: Math.round(lppContribution),
        lppInterest: Math.round(lppInterest),
        lppCumulative: Math.round(lppCumulative),
      });
    }

    const lppTotalEUR = Math.round(lppCumulative / CHF_EUR);
    const tfrTotal = Math.round(tfrCumulative);
    const difference = lppTotalEUR - tfrTotal;

    return {
      rows,
      tfrTotal,
      lppTotal: lppTotalEUR,
      difference,
      differencePercent: tfrTotal > 0 ? Math.round((difference / tfrTotal) * 100) : 0,
      lppMonthlyPension: Math.round((lppCumulative * LPP_CONVERSION_RATE) / 12),
      tfrMonthlyEquivalent: tfrTotal > 0 ? Math.round(tfrTotal / (inputs.yearsToSimulate * 12)) : 0,
    };
  }, [inputs]);

  // ── Share ──
  const handleShare = useCallback(async () => {
    const text = `${t('tfr.shareText')}: TFR €${result.tfrTotal.toLocaleString()} vs LPP €${result.lppTotal.toLocaleString()} (${result.differencePercent > 0 ? '+' : ''}${result.differencePercent}%) — ${window.location.origin}${buildPath({ activeTab: 'tfr-calculator' })}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: t('tfr.title'), text });
      } else {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch { /* user cancelled */ }
  }, [result, t]);

  // ── Format helpers ──
  const fmt = (n: number) => n.toLocaleString('it-CH');
  const fmtEur = (n: number) => `€ ${fmt(n)}`;
  const fmtChf = (n: number) => `CHF ${fmt(n)}`;

  const [showInfoCards, setShowInfoCards] = useState(false);

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="text-center space-y-2">
        <span className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-semibold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300 rounded-full">
          <Calculator size={14} /> {t('tfr.badge')}
        </span>
        <h1 className="text-2xl font-bold text-slate-900 dark:text-white">{t('tfr.title')}</h1>
        <p className="text-sm text-subtle max-w-2xl mx-auto">{t('tfr.subtitle')}</p>
      </div>

      {/* ── Info toggle (mobile) / always visible (desktop) ── */}
      <button
        type="button"
        onClick={() => setShowInfoCards(p => !p)}
        className="sm:hidden w-full flex items-center justify-between px-4 py-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl text-sm font-semibold text-amber-700 dark:text-amber-300"
        aria-label={t('tfr.noTfrTitle')}
      >
        <span className="flex items-center gap-2">
          <AlertTriangle size={16} />
          {t('tfr.noTfrTitle')}
        </span>
        {showInfoCards ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>

      <div className={`space-y-6 ${showInfoCards ? '' : 'hidden sm:block'}`}>
      {/* ── Key info card: TFR doesn't exist in Switzerland ── */}
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl p-5 space-y-3">
        <div className="flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="space-y-2">
            <h2 className="font-bold text-slate-900 dark:text-white text-sm">{t('tfr.noTfrTitle')}</h2>
            <p className="text-sm text-body leading-relaxed">{t('tfr.noTfrText')}</p>
          </div>
        </div>
      </div>

      {/* ── Explanation: What replaces TFR in Switzerland ── */}
      <div className="bg-surface border border-edge rounded-2xl p-5 space-y-4">
        <h2 className="font-bold text-slate-900 dark:text-white text-lg flex items-center gap-2">
          <PiggyBank className="w-5 h-5 text-link" />
          {t('tfr.whatReplacesTitle')}
        </h2>

        <div className="grid sm:grid-cols-2 gap-4">
          {/* TFR side */}
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4 space-y-2">
            <h3 className="font-semibold text-red-700 dark:text-red-300 text-sm flex items-center gap-2">
              🇮🇹 {t('tfr.tfrLabel')}
            </h3>
            <ul className="text-xs text-body space-y-1.5">
              <li className="flex items-start gap-1.5"><span className="text-red-500">•</span> {t('tfr.tfrPoint1')}</li>
              <li className="flex items-start gap-1.5"><span className="text-red-500">•</span> {t('tfr.tfrPoint2')}</li>
              <li className="flex items-start gap-1.5"><span className="text-red-500">•</span> {t('tfr.tfrPoint3')}</li>
              <li className="flex items-start gap-1.5"><span className="text-red-500">•</span> {t('tfr.tfrPoint4')}</li>
            </ul>
          </div>

          {/* LPP side */}
          <div className="bg-stripe-50 dark:bg-stripe-900/20 border border-stripe-200 dark:border-stripe-800 rounded-xl p-4 space-y-2">
            <h3 className="font-semibold text-stripe-700 dark:text-stripe-300 text-sm flex items-center gap-2">
              🇨🇭 {t('tfr.lppLabel')}
            </h3>
            <ul className="text-xs text-body space-y-1.5">
              <li className="flex items-start gap-1.5"><span className="text-stripe-500">•</span> {t('tfr.lppPoint1')}</li>
              <li className="flex items-start gap-1.5"><span className="text-stripe-500">•</span> {t('tfr.lppPoint2')}</li>
              <li className="flex items-start gap-1.5"><span className="text-stripe-500">•</span> {t('tfr.lppPoint3')}</li>
              <li className="flex items-start gap-1.5"><span className="text-stripe-500">•</span> {t('tfr.lppPoint4')}</li>
            </ul>
          </div>
        </div>
      </div>
      </div>

      {/* ── Simulator inputs ── */}
      <div className="bg-surface border border-edge rounded-2xl p-5 space-y-5">
        <h2 className="font-bold text-slate-900 dark:text-white text-lg flex items-center gap-2">
          <Calculator className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          {t('tfr.simulatorTitle')}
        </h2>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Gross salary CHF */}
          <div>
            <label htmlFor="tfr-salary-chf" className="block text-xs font-medium text-body mb-1">
              {t('tfr.salaryChf')}
              <InfoTooltip text={t('tfr.salaryChfInfo')} />
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted">CHF</span>
              <input
                id="tfr-salary-chf"
                type="number"
                inputMode="numeric"
                value={inputs.grossSalaryCHF}
                onChange={(e) => handleChange('grossSalaryCHF', Number(e.target.value))}
                className="w-full pl-12 pr-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm focus-visible:ring-2 focus-visible:ring-stripe-500 focus-visible:border-stripe-500"
                min={20000}
                max={300000}
                step={5000}
              />
            </div>
          </div>

          {/* Gross salary EUR (synced) */}
          <div>
            <label htmlFor="tfr-salary-eur" className="block text-xs font-medium text-body mb-1">
              {t('tfr.salaryEur')}
              <InfoTooltip text={t('tfr.salaryEurInfo')} />
            </label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted">€</span>
              <input
                id="tfr-salary-eur"
                type="number"
                inputMode="numeric"
                value={inputs.grossSalaryEUR}
                onChange={(e) => handleChange('grossSalaryEUR', Number(e.target.value))}
                className="w-full pl-8 pr-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm focus-visible:ring-2 focus-visible:ring-stripe-500 focus-visible:border-stripe-500"
                min={15000}
                max={280000}
                step={5000}
              />
            </div>
          </div>

          {/* Current age */}
          <div>
            <label htmlFor="tfr-age" className="block text-xs font-medium text-body mb-1">
              {t('tfr.currentAge')}
            </label>
            <input
              id="tfr-age"
              type="number"
              inputMode="numeric"
              value={inputs.currentAge}
              onChange={(e) => handleChange('currentAge', Number(e.target.value))}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm focus-visible:ring-2 focus-visible:ring-stripe-500 focus-visible:border-stripe-500"
              min={18}
              max={60}
            />
          </div>

          {/* Years to simulate */}
          <div>
            <label htmlFor="tfr-years" className="block text-xs font-medium text-body mb-1">
              {t('tfr.yearsToSimulate')}
              <InfoTooltip text={t('tfr.yearsToSimulateInfo')} />
            </label>
            <input
              id="tfr-years"
              type="number"
              inputMode="numeric"
              value={inputs.yearsToSimulate}
              onChange={(e) => handleChange('yearsToSimulate', Math.min(45, Math.max(1, Number(e.target.value))))}
              className="w-full px-3 py-2 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm focus-visible:ring-2 focus-visible:ring-stripe-500 focus-visible:border-stripe-500"
              min={1}
              max={45}
            />
          </div>

          {/* Inflation rate */}
          <div>
            <label htmlFor="tfr-inflation" className="block text-xs font-medium text-body mb-1">
              {t('tfr.inflationRate')}
              <InfoTooltip text={t('tfr.inflationRateInfo')} />
            </label>
            <div className="relative">
              <input
                id="tfr-inflation"
                type="number"
                inputMode="decimal"
                value={inputs.inflationRate}
                onChange={(e) => handleChange('inflationRate', Number(e.target.value))}
                className="w-full px-3 py-2 pr-8 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm focus-visible:ring-2 focus-visible:ring-stripe-500 focus-visible:border-stripe-500"
                min={0}
                max={10}
                step={0.1}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">%</span>
            </div>
          </div>

          {/* LPP interest rate */}
          <div>
            <label htmlFor="tfr-lpp-rate" className="block text-xs font-medium text-body mb-1">
              {t('tfr.lppInterestRate')}
              <InfoTooltip text={t('tfr.lppInterestRateInfo')} />
            </label>
            <div className="relative">
              <input
                id="tfr-lpp-rate"
                type="number"
                inputMode="decimal"
                value={inputs.lppInterestRate}
                onChange={(e) => handleChange('lppInterestRate', Number(e.target.value))}
                className="w-full px-3 py-2 pr-8 border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-700 text-slate-900 dark:text-white text-sm focus-visible:ring-2 focus-visible:ring-stripe-500 focus-visible:border-stripe-500"
                min={0}
                max={5}
                step={0.25}
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted">%</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── Results ── */}
      <div className="bg-surface border border-edge rounded-2xl p-5 space-y-5">
        <h2 className="font-bold text-slate-900 dark:text-white text-lg flex items-center gap-2">
          <Scale className="w-5 h-5 text-stripe-600 dark:text-stripe-400" />
          {t('tfr.resultsTitle')}
          <span className="text-xs font-normal text-muted">
            ({inputs.yearsToSimulate} {t('tfr.years')})
          </span>
        </h2>

        <div className="grid sm:grid-cols-3 gap-4">
          {/* TFR Total */}
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-xl p-4 text-center space-y-1">
            <p className="text-xs font-medium text-red-600 dark:text-red-400">🇮🇹 {t('tfr.tfrAccumulated')}</p>
            <p className="text-xl font-bold text-red-700 dark:text-red-300">{fmtEur(result.tfrTotal)}</p>
            <p className="text-xs text-muted">
              {t('tfr.monthlyEquivalent')}: {fmtEur(result.tfrMonthlyEquivalent)}/mese
            </p>
          </div>

          {/* LPP Total (in EUR) */}
          <div className="bg-stripe-50 dark:bg-stripe-900/20 border border-stripe-200 dark:border-stripe-800 rounded-xl p-4 text-center space-y-1">
            <p className="text-xs font-medium text-link">🇨🇭 {t('tfr.lppAccumulated')}</p>
            <p className="text-xl font-bold text-stripe-700 dark:text-stripe-300">{fmtEur(result.lppTotal)}</p>
            <p className="text-xs text-muted">
              {t('tfr.lppPension')}: {fmtChf(result.lppMonthlyPension)}/mese
            </p>
          </div>

          {/* Difference */}
          <div className={`${result.difference >= 0 ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800' : 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800'} border rounded-xl p-4 text-center space-y-1`}>
            <p className="text-xs font-medium text-subtle">{t('tfr.difference')}</p>
            <p className={`text-xl font-bold ${result.difference >= 0 ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}`}>
              {result.difference >= 0 ? '+' : ''}{fmtEur(result.difference)}
            </p>
            <p className="text-xs text-muted">
              ({result.differencePercent >= 0 ? '+' : ''}{result.differencePercent}% {t('tfr.vsItalianTfr')})
            </p>
          </div>
        </div>

        {/* Share button */}
        <div className="flex justify-end">
          <button
            onClick={handleShare}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-subtle bg-surface-raised hover:bg-slate-200 dark:hover:bg-slate-600 rounded-lg transition-colors"
            aria-label={t('tfr.shareResult')}
          >
            {copied ? <Check size={14} className="text-emerald-500" /> : <Share2 size={14} />}
            {copied ? t('tfr.copied') : t('tfr.shareResult')}
          </button>
        </div>
      </div>

      {/* ── Yearly breakdown table ── */}
      <div className="bg-surface border border-edge rounded-2xl p-5 space-y-4">
        <button
          onClick={() => setShowTable(!showTable)}
          className="w-full flex items-center justify-between text-left"
          aria-expanded={showTable}
        >
          <h2 className="font-bold text-slate-900 dark:text-white text-sm flex items-center gap-2">
            <Clock className="w-4 h-4 text-subtle" />
            {t('tfr.yearlyBreakdown')}
          </h2>
          {showTable ? <ChevronUp size={16} className="text-muted" /> : <ChevronDown size={16} className="text-muted" />}
        </button>

        {showTable && (
          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 dark:bg-slate-700/50">
                  <th className="px-2 py-2 text-left font-semibold text-body">{t('tfr.tableYear')}</th>
                  <th className="px-2 py-2 text-left font-semibold text-body">{t('tfr.tableAge')}</th>
                  <th className="px-2 py-2 text-right font-semibold text-red-600 dark:text-red-400">{t('tfr.tableTfrAccrual')}</th>
                  <th className="px-2 py-2 text-right font-semibold text-red-600 dark:text-red-400">{t('tfr.tableTfrReval')}</th>
                  <th className="px-2 py-2 text-right font-semibold text-red-700 dark:text-red-300">{t('tfr.tableTfrTotal')}</th>
                  <th className="px-2 py-2 text-right font-semibold text-link">{t('tfr.tableLppContrib')}</th>
                  <th className="px-2 py-2 text-right font-semibold text-link">{t('tfr.tableLppInterest')}</th>
                  <th className="px-2 py-2 text-right font-semibold text-stripe-700 dark:text-stripe-300">{t('tfr.tableLppTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row) => (
                  <tr key={row.year} className="border-t border-slate-100 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-700/30">
                    <td className="px-2 py-1.5 text-body">{row.year}</td>
                    <td className="px-2 py-1.5 text-body">{row.age}</td>
                    <td className="px-2 py-1.5 text-right text-red-600 dark:text-red-400">{fmtEur(row.tfrAccrual)}</td>
                    <td className="px-2 py-1.5 text-right text-red-600 dark:text-red-400">{fmtEur(row.tfrRevaluation)}</td>
                    <td className="px-2 py-1.5 text-right font-semibold text-red-700 dark:text-red-300">{fmtEur(row.tfrCumulative)}</td>
                    <td className="px-2 py-1.5 text-right text-link">{fmtChf(row.lppContribution)}</td>
                    <td className="px-2 py-1.5 text-right text-link">{fmtChf(row.lppInterest)}</td>
                    <td className="px-2 py-1.5 text-right font-semibold text-stripe-700 dark:text-stripe-300">{fmtChf(row.lppCumulative)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Key differences explained ── */}
      <div className="bg-surface border border-edge rounded-2xl p-5 space-y-4">
        <h2 className="font-bold text-slate-900 dark:text-white text-lg flex items-center gap-2">
          <HelpCircle className="w-5 h-5 text-stripe-600 dark:text-stripe-400" />
          {t('tfr.keyDifferencesTitle')}
        </h2>

        <div className="grid sm:grid-cols-2 gap-4">
          {/* Access to funds */}
          <div className="bg-slate-50 dark:bg-slate-700/30 rounded-xl p-4 space-y-2">
            <h3 className="font-semibold text-sm text-slate-900 dark:text-white flex items-center gap-2">
              <Banknote size={16} className="text-emerald-600" /> {t('tfr.diffAccessTitle')}
            </h3>
            <div className="space-y-1">
              <p className="text-xs text-body"><span className="font-medium text-red-600 dark:text-red-400">🇮🇹 TFR:</span> {t('tfr.diffAccessTfr')}</p>
              <p className="text-xs text-body"><span className="font-medium text-link">🇨🇭 LPP:</span> {t('tfr.diffAccessLpp')}</p>
            </div>
          </div>

          {/* Taxation */}
          <div className="bg-slate-50 dark:bg-slate-700/30 rounded-xl p-4 space-y-2">
            <h3 className="font-semibold text-sm text-slate-900 dark:text-white flex items-center gap-2">
              <Euro size={16} className="text-amber-600" /> {t('tfr.diffTaxTitle')}
            </h3>
            <div className="space-y-1">
              <p className="text-xs text-body"><span className="font-medium text-red-600 dark:text-red-400">🇮🇹 TFR:</span> {t('tfr.diffTaxTfr')}</p>
              <p className="text-xs text-body"><span className="font-medium text-link">🇨🇭 LPP:</span> {t('tfr.diffTaxLpp')}</p>
            </div>
          </div>

          {/* Revaluation / returns */}
          <div className="bg-slate-50 dark:bg-slate-700/30 rounded-xl p-4 space-y-2">
            <h3 className="font-semibold text-sm text-slate-900 dark:text-white flex items-center gap-2">
              <TrendingUp size={16} className="text-stripe-600" /> {t('tfr.diffReturnTitle')}
            </h3>
            <div className="space-y-1">
              <p className="text-xs text-body"><span className="font-medium text-red-600 dark:text-red-400">🇮🇹 TFR:</span> {t('tfr.diffReturnTfr')}</p>
              <p className="text-xs text-body"><span className="font-medium text-link">🇨🇭 LPP:</span> {t('tfr.diffReturnLpp')}</p>
            </div>
          </div>

          {/* Frontaliere specifics */}
          <div className="bg-slate-50 dark:bg-slate-700/30 rounded-xl p-4 space-y-2">
            <h3 className="font-semibold text-sm text-slate-900 dark:text-white flex items-center gap-2">
              <ArrowRight size={16} className="text-stripe-600" /> {t('tfr.diffFrontaliereTitle')}
            </h3>
            <div className="space-y-1.5">
              <p className="text-xs text-body">{t('tfr.diffFrontaliereText1')}</p>
              <p className="text-xs text-body">{t('tfr.diffFrontaliereText2')}</p>
            </div>
          </div>
        </div>
      </div>

      {/* ── FAQ section ── */}
      <div className="bg-surface border border-edge rounded-2xl p-5 space-y-4">
        <h2 className="font-bold text-slate-900 dark:text-white text-lg flex items-center gap-2">
          <HelpCircle className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
          {t('tfr.faqTitle')}
        </h2>

        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map(i => (
            <details key={i} className="group bg-slate-50 dark:bg-slate-700/30 rounded-xl overflow-hidden">
              <summary className="px-4 py-3 cursor-pointer text-sm font-medium text-slate-900 dark:text-white hover:bg-slate-100 dark:hover:bg-slate-700/50 transition-colors list-none flex items-center justify-between">
                {t(`tfr.faq${i}Q`)}
                <ChevronDown size={14} className="text-muted group-open:rotate-180 transition-transform" />
              </summary>
              <div className="px-4 pb-3 text-xs text-body leading-relaxed">
                {t(`tfr.faq${i}A`)}
              </div>
            </details>
          ))}
        </div>
      </div>

      {/* ── Related tools CTA ── */}
      <div className="bg-gradient-to-r from-stripe-50 to-stripe-100 dark:from-stripe-900/20 dark:to-stripe-800/20 border border-stripe-200 dark:border-stripe-800 rounded-2xl p-5 space-y-3">
        <h3 className="font-bold text-sm text-slate-900 dark:text-white">{t('tfr.relatedTitle')}</h3>
        <div className="flex flex-wrap gap-2">
          <a
            href={buildPath({ activeTab: 'fisco', fiscoSubTab: 'pension' })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-stripe-600 hover:bg-stripe-700 text-white rounded-lg transition-colors no-underline"
          >
            <PiggyBank size={14} /> {t('tfr.linkPension')}
          </a>
          <a
            href={buildPath({ activeTab: 'fisco', fiscoSubTab: 'pillar3' })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-stripe-600 hover:bg-stripe-700 text-white rounded-lg transition-colors no-underline"
          >
            <TrendingUp size={14} /> {t('tfr.linkPillar3')}
          </a>
          <a
            href={buildPath({ activeTab: 'calculator', calcolatoreSubTab: 'payslip' })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition-colors no-underline"
          >
            <Calculator size={14} /> {t('tfr.linkPayslip')}
          </a>
        </div>
      </div>

      {/* ── Disclaimer ── */}
      <div className="bg-surface-alt/50 border border-edge rounded-xl p-4">
        <p className="text-xs text-muted leading-relaxed">
          <AlertTriangle size={10} className="inline mr-1 -mt-0.5" />
          {t('tfr.disclaimer')}
        </p>
      </div>
      <Suspense fallback={null}><RelatedTools context="payslip" /></Suspense>
    </div>
  );
};

export default TfrCalculator;
