import React, { useState, useMemo, useEffect, lazy, Suspense } from 'react';
import { useTranslation } from '@/services/i18n';
import { SimulationInputs, SimulationResult } from '@/types';

const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));
import { calculateMunicipalityTaxImpact } from '@/services/calculationService';
import { useExchangeRate } from '@/services/exchangeRateService';
import { Hammer, Euro, Calculator, Info, CheckCircle2, Home, Leaf, Zap, ChevronDown, ChevronUp, AlertTriangle, HelpCircle, TrendingUp, BarChart3, FileText, CreditCard, Clock } from 'lucide-react';

// Swiss renovation deduction categories
interface RenovationCategory {
  key: string;
  deductible: boolean;
  maxPercent: number | null;
  icon: React.ElementType;
  examples: string[];
}

const RENOVATION_CATEGORIES: RenovationCategory[] = [
  { key: 'energySaving', deductible: true, maxPercent: null, icon: Zap, examples: ['insulation', 'windows', 'heatPump', 'solar'] },
  { key: 'maintenance', deductible: true, maxPercent: null, icon: Hammer, examples: ['painting', 'plumbing', 'electrical', 'roof'] },
  { key: 'luxuryUpgrade', deductible: false, maxPercent: null, icon: Home, examples: ['pool', 'sauna', 'extension', 'garage'] },
  { key: 'environmental', deductible: true, maxPercent: null, icon: Leaf, examples: ['asbestos', 'contamination', 'energyCert'] },
];

// Italian renovation bonuses (2026 — Legge di Bilancio)
// Ristrutturazione: 50% prima casa (max €96.000), 36% seconda casa (max €48.000)
const IT_BONUSES = [
  { key: 'ristrutturazione', percent: 50, maxAmount: 96000, years: 10, secondaCasa: { percent: 36, maxAmount: 48000 } },
  { key: 'ecobonus', percent: 65, maxAmount: 100000, years: 10, secondaCasa: null },
  { key: 'sismabonus', percent: 50, maxAmount: 96000, years: 5, secondaCasa: null },
  { key: 'mobili', percent: 50, maxAmount: 5000, years: 10, secondaCasa: null },
  { key: 'verdi', percent: 36, maxAmount: 5000, years: 10, secondaCasa: null },
] as const;

const FAQ_KEYS = ['frontaliereBonusAccess', 'capienzaFiscale', 'quadroRP', 'excessDeduction', 'vecchioAccordo'];

interface RenovationCalculatorProps {
  simulationResult?: SimulationResult;
  simulationInputs?: SimulationInputs;
}

const RenovationCalculator: React.FC<RenovationCalculatorProps> = ({ simulationResult, simulationInputs }) => {
  const { t } = useTranslation();
  const { rate: exchangeRate } = useExchangeRate();
  const [totalCost, setTotalCost] = useState(50000);
  const [selectedCategory, setSelectedCategory] = useState('energySaving');
  const [countryOfProperty, setCountryOfProperty] = useState<'CH' | 'IT'>('IT');
  const [selectedITBonus, setSelectedITBonus] = useState('ristrutturazione');
  const [propertyType, setPropertyType] = useState<'prima_casa' | 'seconda_casa'>('prima_casa');
  const [openSections, setOpenSections] = useState<Set<string>>(new Set(['result', 'bonuses', 'categories', 'faq', 'capienza']));
  const [expandedFaq, setExpandedFaq] = useState<string | null>(null);
  const [stipendioLordo, setStipendioLordo] = useState(100000);

  // Check if simulation data is available
  const hasSimulation = !!simulationResult && !!simulationInputs;

  // Auto-populate gross salary from simulation when available (CHF)
  useEffect(() => {
    if (hasSimulation && simulationInputs) {
      setStipendioLordo(Math.round(simulationInputs.annualIncomeCHF));
    }
  }, [hasSimulation, simulationInputs]);

  // Full IRPEF calculation from gross salary (CHF) via calculateMunicipalityTaxImpact
  // This matches the main calculator logic: social deductions, franchigia, brackets, addizionali, Swiss credit
  const taxResult = useMemo(() => {
    if (stipendioLordo <= 0) return null;
    return calculateMunicipalityTaxImpact(stipendioLordo, exchangeRate, 0.8, '1', 35);
  }, [stipendioLordo]);

  const redditoImponibile = taxResult?.italianTaxableBaseEUR ? Math.round(taxResult.italianTaxableBaseEUR) : 0;
  const computedIrpef = taxResult?.finalItalianTaxEUR ?? 0;

  const rawBonus = IT_BONUSES.find(b => b.key === selectedITBonus)!;
  const category = RENOVATION_CATEGORIES.find(c => c.key === selectedCategory)!;

  // Apply prima/seconda casa override for ristrutturazione (2026 Legge di Bilancio)
  const itBonus = useMemo(() => {
    if (propertyType === 'seconda_casa' && rawBonus.secondaCasa) {
      return { ...rawBonus, percent: rawBonus.secondaCasa.percent, maxAmount: rawBonus.secondaCasa.maxAmount };
    }
    return rawBonus;
  }, [rawBonus, propertyType]);

  const result = useMemo(() => {
    if (countryOfProperty === 'IT') {
      const eligibleAmount = Math.min(totalCost, itBonus.maxAmount);
      const totalDeduction = eligibleAmount * (itBonus.percent / 100);
      const yearlyDeduction = Math.round(totalDeduction / itBonus.years);
      const netCostAfterBonus = totalCost - totalDeduction;
      return {
        eligibleAmount,
        totalDeduction: Math.round(totalDeduction),
        yearlyDeduction,
        years: itBonus.years,
        percent: itBonus.percent,
        netCost: Math.round(netCostAfterBonus),
        currency: '€',
      };
    } else {
      // Swiss property: deductible maintenance vs non-deductible upgrades
      const isDeductible = category.deductible;
      const deductibleAmount = isDeductible ? totalCost : 0;
      // Simplified: assuming 30% marginal tax rate for Swiss imposta alla fonte
      const taxSaving = Math.round(deductibleAmount * 0.30);
      return {
        eligibleAmount: deductibleAmount,
        totalDeduction: taxSaving,
        yearlyDeduction: taxSaving, // deducted in same year
        years: 1,
        percent: isDeductible ? 100 : 0,
        netCost: totalCost - taxSaving,
        currency: 'CHF',
      };
    }
  }, [totalCost, countryOfProperty, itBonus, selectedCategory, category]);

  const toggleSection = (key: string) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-orange-500 to-amber-600 rounded-2xl p-4 sm:p-6 text-white">
        <div className="flex items-center gap-3 mb-2">
          <Hammer size={28} />
          <h2 className="text-2xl font-bold">{t('renovation.title')}</h2>
        </div>
        <p className="text-orange-100 text-sm">{t('renovation.subtitle')}</p>
        <span className="inline-block mt-2 text-xs font-semibold bg-white/20 rounded-full px-2.5 py-0.5">
          {t('renovation.updated2026')}
        </span>
      </div>

      {/* Input section */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl p-4 sm:p-6 border border-slate-200 dark:border-slate-700 space-y-4">
        <h3 className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
          <Calculator size={18} className="text-orange-600" /> {t('renovation.inputs')}
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <div>
            <label htmlFor="reno-cost" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
              {t('renovation.totalCost')}
            </label>
            <input
              id="reno-cost"
              type="number"
              value={totalCost}
              onChange={e => setTotalCost(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm text-slate-800 dark:text-slate-200"
            />
          </div>
          <div>
            <label htmlFor="reno-country" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
              {t('renovation.propertyLocation')}
            </label>
            <select
              id="reno-country"
              value={countryOfProperty}
              onChange={e => setCountryOfProperty(e.target.value as 'CH' | 'IT')}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm text-slate-800 dark:text-slate-200"
            >
              <option value="IT">🇮🇹 Italia</option>
              <option value="CH">🇨🇭 Svizzera</option>
            </select>
          </div>
          {countryOfProperty === 'IT' ? (
            <div>
              <label htmlFor="reno-bonus" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                {t('renovation.bonusType')}
              </label>
              <select
                id="reno-bonus"
                value={selectedITBonus}
                onChange={e => setSelectedITBonus(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm text-slate-800 dark:text-slate-200"
              >
                {IT_BONUSES.map(b => (
                  <option key={b.key} value={b.key}>{t(`renovation.bonus.${b.key}`)}</option>
                ))}
              </select>
            </div>
          ) : (
            <div>
              <label htmlFor="reno-category" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                {t('renovation.category')}
              </label>
              <select
                id="reno-category"
                value={selectedCategory}
                onChange={e => setSelectedCategory(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm text-slate-800 dark:text-slate-200"
              >
                {RENOVATION_CATEGORIES.map(cat => (
                  <option key={cat.key} value={cat.key}>{t(`renovation.cat.${cat.key}`)}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Property type selector (prima/seconda casa) — only for IT properties */}
        {countryOfProperty === 'IT' && (
          <div>
            <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-2">
              {t('renovation.propertyType')}
            </label>
            <div className="flex gap-2">
              <button
                onClick={() => setPropertyType('prima_casa')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  propertyType === 'prima_casa'
                    ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 border-2 border-orange-400 dark:border-orange-600'
                    : 'bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-400 border-2 border-transparent hover:border-slate-300 dark:hover:border-slate-600'
                }`}
              >
                🏠 {t('renovation.primaCasa')}
              </button>
              <button
                onClick={() => setPropertyType('seconda_casa')}
                className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  propertyType === 'seconda_casa'
                    ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300 border-2 border-orange-400 dark:border-orange-600'
                    : 'bg-slate-50 dark:bg-slate-700 text-slate-600 dark:text-slate-400 border-2 border-transparent hover:border-slate-300 dark:hover:border-slate-600'
                }`}
              >
                🏡 {t('renovation.secondaCasa')}
              </button>
            </div>
            {propertyType === 'seconda_casa' && rawBonus.secondaCasa && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-1.5 flex items-center gap-1">
                <AlertTriangle size={12} />
                {t('renovation.secondaCasaNote')}
              </p>
            )}
          </div>
        )}

        {/* Gross salary input — for standalone IRPEF/capienza calculation */}
        {countryOfProperty === 'IT' && (
          <div>
            <label htmlFor="stipendio-lordo" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
              {t('capienza.grossSalary')} (CHF)
            </label>
            <input
              id="stipendio-lordo"
              type="number"
              min={0}
              step={1000}
              value={stipendioLordo || ''}
              onChange={e => setStipendioLordo(Math.max(0, Number(e.target.value)))}
              className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-sm text-slate-800 dark:text-slate-200"
              placeholder="100000"
            />
            {stipendioLordo > 0 && redditoImponibile > 0 && (
              <p className="text-xs text-emerald-700 dark:text-emerald-400 mt-1 font-medium">
                {t('capienza.derivedBase', { base: redditoImponibile.toLocaleString() })}
              </p>
            )}
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
              {hasSimulation
                ? t('capienza.autoPopulated')
                : t('capienza.grossSalaryHelp')
              }
            </p>
          </div>
        )}
      </div>

      {/* Result */}
      <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
        <button onClick={() => toggleSection('result')} className="w-full flex items-center justify-between p-4">
          <h3 className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
            <Euro size={18} className="text-emerald-700" /> {t('renovation.result')}
          </h3>
          {openSections.has('result') ? <ChevronUp size={18} className="text-slate-500 dark:text-slate-400" /> : <ChevronDown size={18} className="text-slate-500 dark:text-slate-400" />}
        </button>
        {openSections.has('result') && (
          <div className="px-4 pb-4 space-y-4 border-t border-slate-100 dark:border-slate-700 pt-4 animate-fade-in">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3 text-center">
                <p className="text-xs text-blue-600 dark:text-blue-400 font-semibold">{t('renovation.totalCostLabel')}</p>
                <p className="text-lg font-bold text-blue-700 dark:text-blue-300">{result.currency} {totalCost.toLocaleString()}</p>
              </div>
              <div className="bg-emerald-50 dark:bg-emerald-900/20 rounded-xl p-3 text-center">
                <p className="text-xs text-emerald-700 dark:text-emerald-400 font-semibold">{t('renovation.totalDeduction')}</p>
                <p className="text-lg font-bold text-emerald-700 dark:text-emerald-300">{result.currency} {result.totalDeduction.toLocaleString()}</p>
              </div>
              <div className="bg-violet-50 dark:bg-violet-900/20 rounded-xl p-3 text-center">
                <p className="text-xs text-violet-600 dark:text-violet-400 font-semibold">{t('renovation.yearlyDeduction')}</p>
                <p className="text-lg font-bold text-violet-700 dark:text-violet-300">{result.currency} {result.yearlyDeduction.toLocaleString()}/{t('renovation.year')}</p>
              </div>
              <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-3 text-center">
                <p className="text-xs text-amber-600 dark:text-amber-400 font-semibold">{t('renovation.netCost')}</p>
                <p className="text-lg font-bold text-amber-700 dark:text-amber-300">{result.currency} {result.netCost.toLocaleString()}</p>
              </div>
            </div>
            {countryOfProperty === 'IT' && (
              <>
                <div className="bg-slate-50 dark:bg-slate-700/50 rounded-xl p-3 text-xs text-slate-500 dark:text-slate-400">
                  <p>
                    <CheckCircle2 size={14} className="inline mr-1 text-emerald-500" />
                    {t('renovation.deductionInfo', { percent: String(result.percent), years: String(result.years) })}
                  </p>
                </div>
                {/* Capienza fiscale — dynamic simulation section */}
                <div className="bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden">
                  <button onClick={() => toggleSection('capienza')} className="w-full flex items-center justify-between p-4">
                    <h3 className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                      <BarChart3 size={16} className="text-violet-600 dark:text-violet-400" /> {t('capienza.title')}
                    </h3>
                    {openSections.has('capienza') ? <ChevronUp size={18} className="text-slate-500 dark:text-slate-400" /> : <ChevronDown size={18} className="text-slate-500 dark:text-slate-400" />}
                  </button>
                  {openSections.has('capienza') && (
                    <div className="px-4 pb-4 space-y-3">
                      {stipendioLordo > 0 && redditoImponibile > 0 ? (() => {
                        const grossTax = computedIrpef;
                        const yearlyDed = result.yearlyDeduction;
                        const surplus = grossTax - yearlyDed;
                        const coveragePct = grossTax > 0 ? Math.min(Math.round((grossTax / yearlyDed) * 100), 100) : 0;
                        const isFullyCovered = surplus >= 0;
                        const deficit = isFullyCovered ? 0 : Math.abs(surplus);
                        const statusColor = isFullyCovered ? 'emerald' : (coveragePct >= 60 ? 'amber' : 'red');

                        return (
                          <>
                            {/* IRPEF breakdown card */}
                            <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-3 space-y-2">
                              <p className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                                <FileText size={13} className="text-blue-500" /> {t('capienza.irpefBreakdown')}
                              </p>
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <div className="flex justify-between">
                                  <span className="text-slate-500 dark:text-slate-400">{t('capienza.taxableBase')}</span>
                                  <span className="font-medium text-slate-700 dark:text-slate-200">€{redditoImponibile.toLocaleString()}</span>
                                </div>
                                <div className="flex justify-between">
                                  <span className="text-slate-500 dark:text-slate-400">{t('capienza.grossIrpef')}</span>
                                  <span className="font-medium text-slate-700 dark:text-slate-200">€{Math.round(taxResult?.irpefGross ?? 0).toLocaleString()}</span>
                                </div>
                                {taxResult && (
                                  <>
                                    <div className="flex justify-between">
                                      <span className="text-slate-500 dark:text-slate-400">{t('capienza.addizionali')}</span>
                                      <span className="font-medium text-slate-700 dark:text-slate-200">€{Math.round(taxResult.totalAddizionali).toLocaleString()}</span>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-slate-500 dark:text-slate-400">{t('capienza.swissCredit')}</span>
                                      <span className="font-medium text-slate-700 dark:text-slate-200">−€{Math.round(taxResult.swissTaxCredit).toLocaleString()}</span>
                                    </div>
                                    <div className="flex justify-between col-span-2 pt-1 border-t border-slate-200 dark:border-slate-600">
                                      <span className="text-slate-600 dark:text-slate-300 font-semibold">{t('capienza.netTax')}</span>
                                      <span className="font-bold text-slate-800 dark:text-slate-100">€{Math.round(taxResult.finalItalianTaxEUR).toLocaleString()}</span>
                                    </div>
                                  </>
                                )}
                              </div>
                            </div>

                            {/* Capienza vs Deduction card */}
                            <div className={`rounded-lg p-3 border ${
                              statusColor === 'emerald' ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800' :
                              statusColor === 'amber' ? 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800' :
                              'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
                            }`}>
                              <div className="flex items-center justify-between mb-2">
                                <div className="flex items-center gap-2">
                                  <TrendingUp size={14} className={
                                    statusColor === 'emerald' ? 'text-emerald-700 dark:text-emerald-400' :
                                    statusColor === 'amber' ? 'text-amber-600 dark:text-amber-400' :
                                    'text-red-600 dark:text-red-400'
                                  } />
                                  <span className={`text-xs font-semibold ${
                                    statusColor === 'emerald' ? 'text-emerald-700 dark:text-emerald-300' :
                                    statusColor === 'amber' ? 'text-amber-700 dark:text-amber-300' :
                                    'text-red-700 dark:text-red-300'
                                  }`}>{t('capienza.vsDeduction')}</span>
                                </div>
                                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                                  statusColor === 'emerald' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-800/40 dark:text-emerald-300' :
                                  statusColor === 'amber' ? 'bg-amber-100 text-amber-700 dark:bg-amber-800/40 dark:text-amber-300' :
                                  'bg-red-100 text-red-700 dark:bg-red-800/40 dark:text-red-300'
                                }`}>
                                  {coveragePct}%
                                </span>
                              </div>

                              <div className="grid grid-cols-2 gap-2 text-xs mb-2">
                                <div>
                                  <p className="text-slate-500 dark:text-slate-400">{t('capienza.yourCapienza')}</p>
                                  <p className="font-bold text-slate-700 dark:text-slate-200">€{Math.round(grossTax).toLocaleString()}/{t('capienza.year')}</p>
                                </div>
                                <div>
                                  <p className="text-slate-500 dark:text-slate-400">{t('capienza.yearlyQuota')}</p>
                                  <p className="font-bold text-slate-700 dark:text-slate-200">€{yearlyDed.toLocaleString()}/{t('capienza.year')}</p>
                                </div>
                              </div>

                              {/* Progress bar */}
                              <div className="w-full bg-slate-200 dark:bg-slate-600 rounded-full h-2 overflow-hidden">
                                <div
                                  className={`h-2 rounded-full transition-all ${
                                    statusColor === 'emerald' ? 'bg-emerald-700' :
                                    statusColor === 'amber' ? 'bg-amber-500' :
                                    'bg-red-500'
                                  }`}
                                  style={{ width: `${coveragePct}%` }}
                                />
                              </div>

                              {/* Verdict */}
                              <p className={`text-xs mt-2 leading-relaxed ${
                                statusColor === 'emerald' ? 'text-emerald-700 dark:text-emerald-300' :
                                statusColor === 'amber' ? 'text-amber-700 dark:text-amber-300' :
                                'text-red-700 dark:text-red-300'
                              }`}>
                                {isFullyCovered
                                  ? t('capienza.verdictOk', { irpef: Math.round(grossTax).toLocaleString(), deduction: yearlyDed.toLocaleString() })
                                  : t('capienza.verdictLoss', { irpef: Math.round(grossTax).toLocaleString(), deduction: yearlyDed.toLocaleString(), loss: Math.round(deficit).toLocaleString() })
                                }
                              </p>
                            </div>

                            {/* Year-by-year table when deficit */}
                            {!isFullyCovered && (
                              <div className="bg-slate-50 dark:bg-slate-700/50 rounded-lg p-3 space-y-2">
                                <p className="text-xs font-semibold text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
                                  <Clock size={13} className="text-amber-500" /> {t('capienza.yearByYear')}
                                </p>
                                <div className="overflow-x-auto">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="border-b border-slate-200 dark:border-slate-600">
                                        <th className="text-left py-1 text-slate-500 dark:text-slate-400 font-medium">{t('capienza.thYear')}</th>
                                        <th className="text-right py-1 text-slate-500 dark:text-slate-400 font-medium">{t('capienza.thQuota')}</th>
                                        <th className="text-right py-1 text-slate-500 dark:text-slate-400 font-medium">{t('capienza.thAbsorbed')}</th>
                                        <th className="text-right py-1 text-slate-500 dark:text-slate-400 font-medium">{t('capienza.thLost')}</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {Array.from({ length: result.years }, (_, i) => {
                                        const absorbed = Math.min(yearlyDed, Math.round(grossTax));
                                        const lost = yearlyDed - absorbed;
                                        return (
                                          <tr key={i} className="border-b border-slate-100 dark:border-slate-600/50">
                                            <td className="py-1 text-slate-700 dark:text-slate-300">{i + 1}</td>
                                            <td className="py-1 text-right text-slate-700 dark:text-slate-300">€{yearlyDed.toLocaleString()}</td>
                                            <td className="py-1 text-right text-emerald-700 dark:text-emerald-400">€{absorbed.toLocaleString()}</td>
                                            <td className="py-1 text-right text-red-600 dark:text-red-400">{lost > 0 ? `€${lost.toLocaleString()}` : '—'}</td>
                                          </tr>
                                        );
                                      })}
                                      <tr className="font-semibold">
                                        <td className="py-1 text-slate-700 dark:text-slate-300">{t('capienza.total')}</td>
                                        <td className="py-1 text-right text-slate-700 dark:text-slate-300">€{result.totalDeduction.toLocaleString()}</td>
                                        <td className="py-1 text-right text-emerald-700 dark:text-emerald-400">€{(Math.min(yearlyDed, Math.round(grossTax)) * result.years).toLocaleString()}</td>
                                        <td className="py-1 text-right text-red-600 dark:text-red-400">€{(Math.max(0, yearlyDed - Math.round(grossTax)) * result.years).toLocaleString()}</td>
                                      </tr>
                                    </tbody>
                                  </table>
                                </div>
                              </div>
                            )}

                            {/* Tip cards */}
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-2.5 border border-blue-100 dark:border-blue-800">
                                <p className="text-xs text-blue-700 dark:text-blue-300 flex items-center gap-1">
                                  <CreditCard size={12} /> {t('capienza.tipOtherIncome')}
                                </p>
                              </div>
                              <div className="bg-violet-50 dark:bg-violet-900/20 rounded-lg p-2.5 border border-violet-100 dark:border-violet-800">
                                <p className="text-xs text-violet-700 dark:text-violet-300 flex items-center gap-1">
                                  <FileText size={12} /> {t('capienza.tipSplitYears')}
                                </p>
                              </div>
                            </div>
                          </>
                        );
                      })() : (
                        /* No base imponibile entered — prompt user */
                        <div className="flex items-start gap-2.5">
                          <Info size={16} className="text-blue-600 dark:text-blue-400 mt-0.5 shrink-0" />
                          <div>
                            <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">{t('capienza.enterGrossSalary')}</p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Italian bonuses detail */}
      {countryOfProperty === 'IT' && (
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          <button onClick={() => toggleSection('bonuses')} className="w-full flex items-center justify-between p-4">
            <h3 className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
              <Info size={18} className="text-blue-600" /> {t('renovation.availableBonuses')}
            </h3>
            {openSections.has('bonuses') ? <ChevronUp size={18} className="text-slate-500 dark:text-slate-400" /> : <ChevronDown size={18} className="text-slate-500 dark:text-slate-400" />}
          </button>
          {openSections.has('bonuses') && (
            <div className="px-4 pb-4 space-y-3 border-t border-slate-100 dark:border-slate-700 pt-4 animate-fade-in">
              {IT_BONUSES.map(b => {
                const effective = propertyType === 'seconda_casa' && b.secondaCasa
                  ? { percent: b.secondaCasa.percent, maxAmount: b.secondaCasa.maxAmount }
                  : { percent: b.percent, maxAmount: b.maxAmount };
                return (
                  <div
                    key={b.key}
                    className={`rounded-xl p-3 border ${
                      selectedITBonus === b.key
                        ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-300 dark:border-emerald-700'
                        : 'bg-slate-50 dark:bg-slate-700/50 border-slate-200 dark:border-slate-600'
                    } cursor-pointer transition-all`}
                    onClick={() => setSelectedITBonus(b.key)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => e.key === 'Enter' && setSelectedITBonus(b.key)}
                  >
                    <div className="flex items-center justify-between">
                      <h4 className="font-semibold text-sm text-slate-800 dark:text-slate-200">{t(`renovation.bonus.${b.key}`)}</h4>
                      <div className="flex items-center gap-1.5">
                        {b.secondaCasa && propertyType === 'seconda_casa' && (
                          <span className="text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 rounded-full font-medium">
                            {t('renovation.secondaCasa')}
                          </span>
                        )}
                        <span className="text-sm font-bold text-emerald-700 dark:text-emerald-300">{effective.percent}%</span>
                      </div>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                      {t(`renovation.bonusDesc.${b.key}`)} · Max €{effective.maxAmount.toLocaleString()} · {b.years} {t('renovation.years')}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Swiss categories */}
      {countryOfProperty === 'CH' && (
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          <button onClick={() => toggleSection('categories')} className="w-full flex items-center justify-between p-4">
            <h3 className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
              <Info size={18} className="text-blue-600" /> {t('renovation.swissCategories')}
            </h3>
            {openSections.has('categories') ? <ChevronUp size={18} className="text-slate-500 dark:text-slate-400" /> : <ChevronDown size={18} className="text-slate-500 dark:text-slate-400" />}
          </button>
          {openSections.has('categories') && (
            <div className="px-4 pb-4 space-y-3 border-t border-slate-100 dark:border-slate-700 pt-4 animate-fade-in">
              {RENOVATION_CATEGORIES.map(cat => {
                const Icon = cat.icon;
                return (
                  <div
                    key={cat.key}
                    className={`rounded-xl p-3 border ${
                      selectedCategory === cat.key
                        ? 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-300 dark:border-emerald-700'
                        : 'bg-slate-50 dark:bg-slate-700/50 border-slate-200 dark:border-slate-600'
                    } cursor-pointer transition-all`}
                    onClick={() => setSelectedCategory(cat.key)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => e.key === 'Enter' && setSelectedCategory(cat.key)}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <Icon size={16} className={cat.deductible ? 'text-emerald-700' : 'text-red-500'} />
                      <h4 className="font-semibold text-sm text-slate-800 dark:text-slate-200">{t(`renovation.cat.${cat.key}`)}</h4>
                      <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${
                        cat.deductible
                          ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300'
                          : 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                      }`}>
                        {cat.deductible ? t('renovation.deductible') : t('renovation.notDeductible')}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400">{t(`renovation.catDesc.${cat.key}`)}</p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* FAQ Section — Frontalieri & renovation bonuses */}
      {countryOfProperty === 'IT' && (
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
          <button onClick={() => toggleSection('faq')} className="w-full flex items-center justify-between p-4">
            <h3 className="font-bold text-slate-800 dark:text-slate-200 flex items-center gap-2">
              <HelpCircle size={18} className="text-violet-600" /> {t('renovation.faqTitle')}
            </h3>
            {openSections.has('faq') ? <ChevronUp size={18} className="text-slate-500 dark:text-slate-400" /> : <ChevronDown size={18} className="text-slate-500 dark:text-slate-400" />}
          </button>
          {openSections.has('faq') && (
            <div className="px-4 pb-4 space-y-2 border-t border-slate-100 dark:border-slate-700 pt-4 animate-fade-in">
              {FAQ_KEYS.map(fk => (
                <div key={fk} className="rounded-xl border border-slate-200 dark:border-slate-600 overflow-hidden">
                  <button
                    onClick={() => setExpandedFaq(expandedFaq === fk ? null : fk)}
                    className="w-full flex items-center justify-between p-3 text-left" aria-expanded={expandedFaq === fk}
                  >
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-300 pr-2">{t(`renovation.faq.${fk}.q`)}</span>
                    {expandedFaq === fk
                      ? <ChevronUp size={16} className="text-slate-500 dark:text-slate-400 shrink-0" />
                      : <ChevronDown size={16} className="text-slate-500 dark:text-slate-400 shrink-0" />}
                  </button>
                  {expandedFaq === fk && (
                    <div className="px-3 pb-3 text-xs text-slate-600 dark:text-slate-400 leading-relaxed border-t border-slate-100 dark:border-slate-700 pt-2">
                      {t(`renovation.faq.${fk}.a`)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <Suspense fallback={null}><RelatedTools context="tax" /></Suspense>
    </div>
  );
};

export default RenovationCalculator;
