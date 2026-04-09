/**
 * TaxCreditCalculator — Credito d'Imposta per Doppia Imposizione
 *
 * Auto-calculates the Italian tax credit from the user's gross salary
 * using the live CHF-EUR exchange rate. Swiss withholding tax and social
 * deductions are derived automatically from the same formulas as the
 * main calculator. The user only enters gross salary + optional other
 * Italian income.
 */

import React, { useState, useMemo, useEffect, useRef, lazy, Suspense } from 'react';
import { Info, ChevronDown, ChevronUp, HelpCircle, Receipt, RefreshCw, Users, Plus, Minus } from 'lucide-react';

const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { unlockAchievement } from '@/services/gamificationService';
import { useExchangeRate } from '@/services/exchangeRateService';
import { getTicinoTaxRate, adjustRateForChildren, calculateLombardiaRegionale, calculateProgressiveWorkDeduction, calculateProportionalTaxCredit } from '@/services/calculationService';
import { DEFAULT_TECH_PARAMS, FRANCHIGIA_NUOVI_FRONTALIERI } from '@/constants';

// ─── Constants ───────────────────────────────────────────────

// 2026 IRPEF brackets
const IRPEF_BRACKETS = [
  { upTo: 28000, rate: 0.23 },
  { upTo: 50000, rate: 0.35 },
  { upTo: Infinity, rate: 0.43 },
];

const ADDIZIONALE_COMUNALE_RATE = 0.008; // Common average

const EDIT_FIELD_CLASS =
  'w-full h-12 bg-slate-50 dark:bg-slate-900 px-4 rounded-xl border border-slate-200 dark:border-slate-700 text-sm font-semibold text-slate-800 dark:text-slate-100 outline-none focus-visible:border-indigo-500 focus-visible:ring-4 focus-visible:ring-indigo-500/10 transition-[color,background-color,border-color,box-shadow] placeholder-slate-500';

const STEPPER_SHELL_CLASS =
  'flex items-center bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl overflow-hidden h-12 shadow-sm focus-within:ring-2 focus-within:ring-indigo-500/20 focus-within:border-indigo-500 transition-[color,background-color,border-color,box-shadow,transform]';

const STEP_BTN_CLASS =
  'w-10 shrink-0 h-full flex items-center justify-center text-slate-500 dark:text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 active:scale-90 transition-[color,background-color,border-color,box-shadow,transform]';

type NumberStepperProps = {
  id: string;
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  ariaLabel: string;
};

const NumberStepper: React.FC<NumberStepperProps> = ({ id, value, min, max, onChange, ariaLabel }) => (
  <div className={STEPPER_SHELL_CLASS}>
    <button
      type="button"
      className={`${STEP_BTN_CLASS} border-r border-slate-100 dark:border-slate-800`}
      onClick={() => onChange(Math.max(min, value - 1))}
      aria-label={`${ariaLabel}: diminuisci`}
    >
      <Minus size={16} strokeWidth={2.5} />
    </button>
    <div className="flex-1 min-w-[40px] h-full relative flex items-center justify-center bg-white/50 dark:bg-slate-900/50">
      <input
        id={id}
        type="number"
        inputMode="numeric"
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          let next = parseInt(e.target.value, 10);
          if (Number.isNaN(next)) next = min;
          next = Math.max(min, Math.min(max, next));
          onChange(next);
        }}
        className="w-full h-full min-h-[48px] bg-transparent text-center font-bold text-base text-slate-700 dark:text-slate-200 outline-none focus-visible:ring-2 focus-visible:ring-blue-500 appearance-none px-1 py-3"
        aria-label={ariaLabel}
      />
    </div>
    <button
      type="button"
      className={`${STEP_BTN_CLASS} border-l border-slate-100 dark:border-slate-800`}
      onClick={() => onChange(Math.min(max, value + 1))}
      aria-label={`${ariaLabel}: aumenta`}
    >
      <Plus size={16} strokeWidth={2.5} />
    </button>
  </div>
);

const TaxCreditCalculator: React.FC = () => {
  const { t } = useTranslation();
  const { rate: liveRate, loading: rateLoading, refresh: refreshRate } = useExchangeRate();

  // ─── State ───
  const [grossSalaryCHF, setGrossSalaryCHF] = useState(70000);
  const [maritalStatus, setMaritalStatus] = useState<'SINGLE' | 'MARRIED'>('SINGLE');
  const [children, setChildren] = useState(0);
  const [spouseWorks, setSpouseWorks] = useState(false);
  const [withinTwentyKm, setWithinTwentyKm] = useState(true);
  const [otherItalianIncome, setOtherItalianIncome] = useState(0);
  const [age, setAge] = useState(35);
  const [showDetails, setShowDetails] = useState(false);
  const trackedRef = useRef(false);

  // Track first interaction for gamification
  useEffect(() => {
    if (!trackedRef.current) {
      trackedRef.current = true;
      unlockAchievement('tax_expert');
      Analytics.trackUIInteraction('tax_credit', 'calculator', 'view', 'first');
    }
  }, []);

  const exchangeRate = liveRate;

  // ─── Calculations ───
  const result = useMemo(() => {
    // Social deductions (same as main calculator)
    const { avsRate, acRate, laaRate, ijmRate, lppRate25_34, lppRate35_44, lppRate45_54, lppRate55_plus, itWorkDeduction } = DEFAULT_TECH_PARAMS;
    const lppRate = age < 25 ? 0 : age <= 34 ? lppRate25_34 : age <= 44 ? lppRate35_44 : age <= 54 ? lppRate45_54 : lppRate55_plus;
    const totalSocialRate = avsRate + acRate + laaRate + ijmRate + lppRate;
    const socialDeductionsCHF = grossSalaryCHF * totalSocialRate;
    const socialDeductionsEUR = socialDeductionsCHF * exchangeRate;

    // Swiss withholding tax (imposta alla fonte) — same tables as main calculator
    const { rate: baseRate, tableCode } = getTicinoTaxRate(grossSalaryCHF, maritalStatus, children, spouseWorks);
    const effectiveSwissRate = adjustRateForChildren(baseRate, tableCode, children);
    const swissTaxCHF = grossSalaryCHF * effectiveSwissRate;

    // Within 20km: CH retains 80% of source tax; beyond 20km: CH retains 100%
    const chTaxShare = withinTwentyKm ? 0.8 : 1.0;
    const paidSourceTaxCHF = swissTaxCHF * chTaxShare;

    const grossEUR = grossSalaryCHF * exchangeRate;
    const swissTaxEUR = swissTaxCHF * exchangeRate;
    const paidSourceTaxEUR = paidSourceTaxCHF * exchangeRate;

    // Franchigia for new frontalieri (2026 agreement) — always applies
    const franchigia = FRANCHIGIA_NUOVI_FRONTALIERI;
    const taxableInItaly = Math.max(0, grossEUR - socialDeductionsEUR - franchigia);

    // Total Italian income (foreign + other)
    const totalIncome = taxableInItaly + otherItalianIncome;

    // Calculate IRPEF on total income
    let irpef = 0;
    let prevLimit = 0;
    for (const bracket of IRPEF_BRACKETS) {
      const bracketWidth = bracket.upTo === Infinity ? Infinity : bracket.upTo - prevLimit;
      const taxableInBracket = Math.min(Math.max(0, totalIncome - prevLimit), bracketWidth);
      irpef += taxableInBracket * bracket.rate;
      prevLimit = bracket.upTo === Infinity ? prevLimit : bracket.upTo;
      if (totalIncome <= bracket.upTo) break;
    }

    // Progressive work deduction per Art. 13 TUIR
    const progressiveWorkDeduction = calculateProgressiveWorkDeduction(totalIncome);
    const itDeductions = progressiveWorkDeduction + (maritalStatus === 'MARRIED' && !spouseWorks ? 690 : 0) + (children * 950);

    // Addizionali (use real Lombardia progressive brackets for regional)
    const addizionaleRegionale = calculateLombardiaRegionale(totalIncome);
    const addizionaleComunale = totalIncome * ADDIZIONALE_COMUNALE_RATE;
    const totalItalianTax = Math.max(0, irpef + addizionaleRegionale + addizionaleComunale - itDeductions);

    // Proportional foreign tax credit per Art. 165 c.10 TUIR + Ris. 38/E/2017
    // Step 1: Reduce Swiss tax proportionally (taxable base vs gross foreign income)
    const proportionalSwissTax = calculateProportionalTaxCredit(paidSourceTaxEUR, taxableInItaly, grossEUR);
    // Step 2: Cap at Italian tax attributable to foreign income
    const foreignIncomeRatio = totalIncome > 0 ? taxableInItaly / totalIncome : 0;
    const italianTaxOnForeignIncome = totalItalianTax * foreignIncomeRatio;
    const taxCredit = Math.min(proportionalSwissTax, italianTaxOnForeignIncome);

    // Net Italian tax after credit
    const netItalianTax = Math.max(0, totalItalianTax - taxCredit);

    // Total tax burden (Swiss + net Italian)
    const totalTaxBurden = swissTaxEUR + netItalianTax;
    const effectiveRate = grossEUR > 0 ? (totalTaxBurden / grossEUR) * 100 : 0;

    return {
      grossEUR: Math.round(grossEUR),
      swissTaxCHF: Math.round(swissTaxCHF),
      swissTaxEUR: Math.round(swissTaxEUR),
      paidSourceTaxEUR: Math.round(paidSourceTaxEUR),
      socialDeductionsEUR: Math.round(socialDeductionsEUR),
      effectiveSwissRate: (effectiveSwissRate * 100).toFixed(1),
      tableCode,
      franchigia,
      itDeductions: Math.round(itDeductions),
      taxableInItaly: Math.round(taxableInItaly),
      totalIncome: Math.round(totalIncome),
      irpef: Math.round(irpef),
      addizionaleRegionale: Math.round(addizionaleRegionale),
      addizionaleComunale: Math.round(addizionaleComunale),
      totalItalianTax: Math.round(totalItalianTax),
      foreignIncomeRatio: Math.round(foreignIncomeRatio * 100),
      italianTaxOnForeignIncome: Math.round(italianTaxOnForeignIncome),
      taxCredit: Math.round(taxCredit),
      netItalianTax: Math.round(netItalianTax),
      totalTaxBurden: Math.round(totalTaxBurden),
      effectiveRate: effectiveRate.toFixed(1),
    };
  }, [grossSalaryCHF, exchangeRate, withinTwentyKm, otherItalianIncome, maritalStatus, children, spouseWorks, age]);

  const fmt = (n: number) => n.toLocaleString('it-IT');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2 rounded-xl bg-emerald-100 dark:bg-emerald-900/30">
            <Receipt size={24} className="text-emerald-700 dark:text-emerald-300" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">{t('taxCredit.title')}</h2>
            <p className="text-sm text-slate-600 dark:text-slate-400">{t('taxCredit.subtitle')}</p>
          </div>
        </div>

        {/* Info box */}
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4 mb-6">
          <div className="flex gap-2">
            <Info size={18} className="text-blue-700 dark:text-blue-300 mt-0.5 shrink-0" />
            <p className="text-sm text-blue-700 dark:text-blue-300">{t('taxCredit.info')}</p>
          </div>
        </div>

        {/* Live exchange rate badge */}
        <div className="flex items-center gap-2 mb-4 bg-slate-50 dark:bg-slate-900/50 rounded-lg px-3 py-2">
          <span className="text-xs text-slate-600 dark:text-slate-400">{t('taxCredit.exchangeRate')}:</span>
          <span className="text-sm font-semibold text-slate-900 dark:text-white">
            1 CHF = {exchangeRate.toFixed(4)} EUR
          </span>
          <button
            onClick={refreshRate}
            disabled={rateLoading}
            className="ml-auto p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
            aria-label={t('taxCredit.refreshRate')}
          >
            <RefreshCw size={14} className={`text-slate-500 dark:text-slate-400 ${rateLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Input fields */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Gross salary */}
          <div>
            <label htmlFor="tc-gross" className="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wide mb-1">
              {t('taxCredit.grossSalary')}
            </label>
            <div className="relative">
              <input
                id="tc-gross"
                type="number"
                inputMode="numeric"
                value={grossSalaryCHF}
                onChange={(e) => setGrossSalaryCHF(Number(e.target.value))}
                className={EDIT_FIELD_CLASS}
                min={0}
              />
              <span className="absolute right-4 top-3.5 text-xs font-bold text-slate-500 dark:text-slate-400">CHF</span>
            </div>
          </div>

          {/* Age */}
          <div>
            <label htmlFor="tc-age" className="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wide mb-1">
              👤 {t('taxCredit.age')}
            </label>
            <NumberStepper
              id="tc-age"
              value={age}
              min={18}
              max={70}
              onChange={setAge}
              ariaLabel={t('taxCredit.age')}
            />
          </div>

          {/* Marital status */}
          <div>
            <label htmlFor="tc-marital" className="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wide mb-1">
              <Users size={14} className="inline mr-1" />
              {t('taxCredit.maritalStatus')}
            </label>
            <select
              id="tc-marital"
              value={maritalStatus}
              onChange={(e) => setMaritalStatus(e.target.value as 'SINGLE' | 'MARRIED')}
              className={EDIT_FIELD_CLASS}
            >
              <option value="SINGLE">{t('taxCredit.single')}</option>
              <option value="MARRIED">{t('taxCredit.married')}</option>
            </select>
          </div>

          {/* Children */}
          <div>
            <label htmlFor="tc-children" className="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wide mb-1">
              👶 {t('taxCredit.children')}
            </label>
            <NumberStepper
              id="tc-children"
              value={children}
              min={0}
              max={10}
              onChange={setChildren}
              ariaLabel={t('taxCredit.children')}
            />
          </div>

          {/* Spouse works (only if married) */}
          {maritalStatus === 'MARRIED' && (
            <div className="sm:col-span-2">
              <label htmlFor="tc-spouse" className="flex items-center gap-3 cursor-pointer">
                <div className="relative inline-flex items-center">
                  <input
                    id="tc-spouse"
                    type="checkbox"
                    checked={spouseWorks}
                    onChange={(e) => setSpouseWorks(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-blue-300 dark:peer-focus-visible:ring-blue-800 rounded-full peer dark:bg-slate-600 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-transform dark:after:border-slate-500 peer-checked:bg-blue-600"></div>
                </div>
                <span className="text-sm font-medium text-slate-700 dark:text-slate-300">{t('taxCredit.spouseWorks')}</span>
              </label>
            </div>
          )}

          {/* Other Italian income */}
          <div className="sm:col-span-2">
            <label htmlFor="tc-other" className="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wide mb-1">
              {t('taxCredit.otherIncome')}
            </label>
            <div className="relative">
              <input
                id="tc-other"
                type="number"
                inputMode="numeric"
                value={otherItalianIncome}
                onChange={(e) => setOtherItalianIncome(Number(e.target.value))}
                className={EDIT_FIELD_CLASS}
                min={0}
              />
              <span className="absolute right-4 top-3.5 text-xs font-bold text-slate-500 dark:text-slate-400">EUR</span>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{t('taxCredit.otherIncomeHelp')}</p>
          </div>
        </div>

        {/* Distance from border selector */}
        <div className="mt-4">
          <label htmlFor="tc-distance" className="block text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-wide mb-1">
            {t('taxCredit.distanceLabel')}
          </label>
          <select
            id="tc-distance"
            value={withinTwentyKm ? 'within' : 'beyond'}
            onChange={(e) => setWithinTwentyKm(e.target.value === 'within')}
            className={`${EDIT_FIELD_CLASS} sm:w-auto sm:min-w-[320px]`}
          >
            <option value="within">{t('taxCredit.within20km')}</option>
            <option value="beyond">{t('taxCredit.beyond20km')}</option>
          </select>
          <div className="flex items-center gap-1 mt-1">
            <HelpCircle size={14} className="text-slate-500 dark:text-slate-400" />
            <span className="text-xs text-slate-500 dark:text-slate-400">{t('taxCredit.distanceHelp')}</span>
          </div>
        </div>

        {/* Computed Swiss tax info */}
        <div className="mt-4 bg-slate-50 dark:bg-slate-900/50 rounded-xl p-3 space-y-1">
          <p className="text-xs font-medium text-slate-500 dark:text-slate-400">{t('taxCredit.autoCalculated')}</p>
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span className="text-sm text-slate-700 dark:text-slate-300">
              {t('taxCredit.swissTax')}: <span className="font-semibold">CHF {fmt(result.swissTaxCHF)}</span>
              <span className="text-xs text-slate-500 dark:text-slate-400 ml-1">({t('taxCredit.table')} {result.tableCode}, {result.effectiveSwissRate}%)</span>
            </span>
            <span className="text-sm text-slate-700 dark:text-slate-300">
              {t('taxCredit.socialDeductions')}: <span className="font-semibold">€{fmt(result.socialDeductionsEUR)}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Results — always visible, updates automatically */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 p-4 sm:p-6">
        <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-4">{t('taxCredit.results')}</h3>

        {/* Summary cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-4 border border-emerald-200 dark:border-emerald-800">
            <p className="text-xs font-medium text-emerald-700 dark:text-emerald-300 mb-1">{t('taxCredit.creditAmount')}</p>
            <p className="text-2xl font-bold text-emerald-700 dark:text-emerald-300">€{fmt(result.taxCredit)}</p>
          </div>
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 border border-blue-200 dark:border-blue-800">
            <p className="text-xs font-medium text-blue-700 dark:text-blue-300 mb-1">{t('taxCredit.netItalianTax')}</p>
            <p className="text-2xl font-bold text-blue-700 dark:text-blue-300">€{fmt(result.netItalianTax)}</p>
          </div>
          <div className="bg-violet-50 dark:bg-violet-900/20 rounded-xl p-4 border border-violet-200 dark:border-violet-800">
            <p className="text-xs font-medium text-violet-700 dark:text-violet-300 mb-1">{t('taxCredit.effectiveRate')}</p>
            <p className="text-2xl font-bold text-violet-700 dark:text-violet-300">{result.effectiveRate}%</p>
          </div>
        </div>

        {/* Details toggle */}
        <button
          onClick={() => setShowDetails(!showDetails)}
          className="flex items-center gap-2 text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 transition-colors"
        >
          {showDetails ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          {t('taxCredit.showDetails')}
        </button>

        {showDetails && (
          <div className="mt-4 space-y-3">
            <div className="bg-slate-50 dark:bg-slate-900/50 rounded-xl p-4 space-y-2">
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3">{t('taxCredit.breakdown')}</h4>
              {[
                [t('taxCredit.grossEUR'), `€${fmt(result.grossEUR)}`],
                [t('taxCredit.socialDeductions'), `- €${fmt(result.socialDeductionsEUR)}`],
                [t('taxCredit.swissTaxEUR'), `€${fmt(result.swissTaxEUR)}`],
                [t('taxCredit.paidSourceTax'), `€${fmt(result.paidSourceTaxEUR)}`],
                ...(result.franchigia > 0 ? [[t('taxCredit.franchigiaLabel'), `- €${fmt(result.franchigia)}`]] : []),
                [t('taxCredit.taxableInItaly'), `€${fmt(result.taxableInItaly)}`],
                [t('taxCredit.irpef'), `€${fmt(result.irpef)}`],
                [t('taxCredit.addizionaleRegionale'), `€${fmt(result.addizionaleRegionale)}`],
                [t('taxCredit.addizionaleComunale'), `€${fmt(result.addizionaleComunale)}`],
                [t('taxCredit.deductions'), `- €${fmt(result.itDeductions)}`],
                [t('taxCredit.totalItalianTax'), `€${fmt(result.totalItalianTax)}`],
                [t('taxCredit.foreignIncomeRatio'), `${result.foreignIncomeRatio}%`],
                [t('taxCredit.italianTaxOnForeign'), `€${fmt(result.italianTaxOnForeignIncome)}`],
              ].map(([label, value], i) => (
                <div key={i} className="flex justify-between text-sm">
                  <span className="text-slate-600 dark:text-slate-400">{label}</span>
                  <span className="font-medium text-slate-900 dark:text-white">{value}</span>
                </div>
              ))}
              <div className="border-t border-slate-200 dark:border-slate-700 pt-2 mt-2">
                <div className="flex justify-between text-sm font-bold">
                  <span className="text-emerald-700 dark:text-emerald-300">{t('taxCredit.creditAmount')}</span>
                  <span className="text-emerald-700 dark:text-emerald-300">€{fmt(result.taxCredit)}</span>
                </div>
              </div>
            </div>

            {/* Explanation */}
            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4">
              <p className="text-sm text-amber-700 dark:text-amber-300">
                {t('taxCredit.explanation')}
              </p>
            </div>
          </div>
        )}
      </div>
      <Suspense fallback={null}><RelatedTools context="tax" /></Suspense>
    </div>
  );
};

export default TaxCreditCalculator;
