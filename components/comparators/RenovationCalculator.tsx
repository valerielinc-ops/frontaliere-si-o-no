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
 <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge space-y-4">
 <h3 className="font-bold text-strong flex items-center gap-2">
 <Calculator size={18} className="text-orange-600" /> {t('renovation.inputs')}
 </h3>
 <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
 <div>
 <label htmlFor="reno-cost" className="block text-xs font-semibold text-subtle mb-1">
 {t('renovation.totalCost')}
 </label>
 <input
 id="reno-cost"
 type="number"
 inputMode="numeric"
 value={totalCost}
 onChange={e => setTotalCost(Number(e.target.value))}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 />
 </div>
 <div>
 <label htmlFor="reno-country" className="block text-xs font-semibold text-subtle mb-1">
 {t('renovation.propertyLocation')}
 </label>
 <select
 id="reno-country"
 value={countryOfProperty}
 onChange={e => setCountryOfProperty(e.target.value as 'CH' | 'IT')}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 >
 <option value="IT">🇮🇹 Italia</option>
 <option value="CH">🇨🇭 Svizzera</option>
 </select>
 </div>
 {countryOfProperty === 'IT' ? (
 <div>
 <label htmlFor="reno-bonus" className="block text-xs font-semibold text-subtle mb-1">
 {t('renovation.bonusType')}
 </label>
 <select
 id="reno-bonus"
 value={selectedITBonus}
 onChange={e => setSelectedITBonus(e.target.value)}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 >
 {IT_BONUSES.map(b => (
 <option key={b.key} value={b.key}>{t(`renovation.bonus.${b.key}`)}</option>
 ))}
 </select>
 </div>
 ) : (
 <div>
 <label htmlFor="reno-category" className="block text-xs font-semibold text-subtle mb-1">
 {t('renovation.category')}
 </label>
 <select
 id="reno-category"
 value={selectedCategory}
 onChange={e => setSelectedCategory(e.target.value)}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
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
 <label className="block text-sm font-semibold text-subtle mb-2">
 {t('renovation.propertyType')}
 </label>
 <div className="flex gap-2">
 <button
 onClick={() => setPropertyType('prima_casa')}
 className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
 propertyType === 'prima_casa'
 ? 'bg-orange-100 dark:bg-orange-900/30 text-warning border-2 border-orange-400 dark:border-orange-600'
 : 'bg-surface-alt text-subtle border-2 border-transparent hover:border-edge'
 }`}
 >
 🏠 {t('renovation.primaCasa')}
 </button>
 <button
 onClick={() => setPropertyType('seconda_casa')}
 className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
 propertyType === 'seconda_casa'
 ? 'bg-orange-100 dark:bg-orange-900/30 text-warning border-2 border-orange-400 dark:border-orange-600'
 : 'bg-surface-alt text-subtle border-2 border-transparent hover:border-edge'
 }`} > 🏡 {t('renovation.secondaCasa')} </button> </div> {propertyType === 'seconda_casa' && rawBonus.secondaCasa && ( <p className="text-xs text-warning mt-1.5 flex items-center gap-1"> <AlertTriangle size={12} /> {t('renovation.secondaCasaNote')} </p> )} </div> )} {/* Gross salary input — for standalone IRPEF/capienza calculation */} {countryOfProperty === 'IT' && ( <div> <label htmlFor="stipendio-lordo" className="block text-xs font-semibold text-subtle mb-1"> {t('capienza.grossSalary')} (CHF) </label> <input id="stipendio-lordo" type="number" inputMode="numeric" min={0} step={1000} value={stipendioLordo || ''} onChange={e => setStipendioLordo(Math.max(0, Number(e.target.value)))} className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong" placeholder="100000" /> {stipendioLordo > 0 && redditoImponibile > 0 && ( <p className="text-sm text-success mt-1 font-medium"> {t('capienza.derivedBase', { base: redditoImponibile.toLocaleString() })} </p> )} <p className="text-sm text-muted mt-1"> {hasSimulation ? t('capienza.autoPopulated') : t('capienza.grossSalaryHelp') } </p> </div> )} </div> {/* Result */} <div className="bg-surface rounded-2xl border border-edge overflow-hidden"> <button onClick={() => toggleSection('result')} className="w-full flex items-center justify-between p-4"> <h3 className="font-bold text-strong flex items-center gap-2"> <Euro size={18} className="text-emerald-700" /> {t('renovation.result')} </h3> {openSections.has('result') ? <ChevronUp size={18} className="text-muted" /> : <ChevronDown size={18} className="text-muted" />} </button> {openSections.has('result') && ( <div className="px-4 pb-4 space-y-4 border-t border-edge pt-4 animate-fade-in"> <div className="grid grid-cols-2 sm:grid-cols-4 gap-3"> <div className="bg-accent-subtle rounded-xl p-3 text-center"> <p className="text-xs text-link font-semibold">{t('renovation.totalCostLabel')}</p> <p className="text-lg font-bold text-accent">{result.currency} {totalCost.toLocaleString()}</p> </div> <div className="bg-success-subtle rounded-xl p-3 text-center"> <p className="text-sm text-success font-semibold">{t('renovation.totalDeduction')}</p> <p className="text-lg font-bold text-success">{result.currency} {result.totalDeduction.toLocaleString()}</p> </div> <div className="bg-accent-subtle rounded-xl p-3 text-center"> <p className="text-xs text-accent font-semibold">{t('renovation.yearlyDeduction')}</p> <p className="text-lg font-bold text-accent">{result.currency} {result.yearlyDeduction.toLocaleString()}/{t('renovation.year')}</p> </div> <div className="bg-warning-subtle rounded-xl p-3 text-center"> <p className="text-xs text-warning font-semibold">{t('renovation.netCost')}</p> <p className="text-lg font-bold text-warning">{result.currency} {result.netCost.toLocaleString()}</p> </div> </div> {countryOfProperty === 'IT' && ( <> <div className="bg-surface-alt rounded-xl p-3 text-xs text-muted"> <p> <CheckCircle2 size={14} className="inline mr-1 text-emerald-500" /> {t('renovation.deductionInfo', { percent: String(result.percent), years: String(result.years) })} </p> </div> {/* Capienza fiscale — dynamic simulation section */} <div className="bg-surface rounded-xl border border-edge overflow-hidden"> <button onClick={() => toggleSection('capienza')} className="w-full flex items-center justify-between p-4"> <h3 className="font-bold text-strong flex items-center gap-2"> <BarChart3 size={16} className="text-accent" /> {t('capienza.title')} </h3> {openSections.has('capienza') ? <ChevronUp size={18} className="text-muted" /> : <ChevronDown size={18} className="text-muted" />} </button> {openSections.has('capienza') && ( <div className="px-4 pb-4 space-y-3"> {stipendioLordo > 0 && redditoImponibile > 0 ? (() => { const grossTax = computedIrpef; const yearlyDed = result.yearlyDeduction; const surplus = grossTax - yearlyDed; const coveragePct = grossTax > 0 ? Math.min(Math.round((grossTax / yearlyDed) * 100), 100) : 0; const isFullyCovered = surplus >= 0; const deficit = isFullyCovered ? 0 : Math.abs(surplus); const statusColor = isFullyCovered ? 'emerald' : (coveragePct >= 60 ? 'amber' : 'red'); return ( <> {/* IRPEF breakdown card */} <div className="bg-surface-alt rounded-lg p-3 space-y-2"> <p className="text-xs font-semibold text-slate-600 flex items-center gap-1.5"> <FileText size={13} className="text-stripe-500" /> {t('capienza.irpefBreakdown')} </p> <div className="grid grid-cols-2 gap-2 text-xs"> <div className="flex justify-between"> <span className="text-muted">{t('capienza.taxableBase')}</span> <span className="font-medium text-body text-strong">€{redditoImponibile.toLocaleString()}</span> </div> <div className="flex justify-between"> <span className="text-muted">{t('capienza.grossIrpef')}</span> <span className="font-medium text-body">€{Math.round(taxResult?.irpefGross ?? 0).toLocaleString()}</span> </div> {taxResult && ( <> <div className="flex justify-between"> <span className="text-muted">{t('capienza.addizionali')}</span> <span className="font-medium text-body">€{Math.round(taxResult.totalAddizionali).toLocaleString()}</span> </div> <div className="flex justify-between"> <span className="text-muted">{t('capienza.swissCredit')}</span> <span className="font-medium text-body">−€{Math.round(taxResult.swissTaxCredit).toLocaleString()}</span> </div> <div className="flex justify-between col-span-2 pt-1 border-t border-edge"> <span className="text-subtle font-semibold">{t('capienza.netTax')}</span> <span className="font-bold text-strong">€{Math.round(taxResult.finalItalianTaxEUR).toLocaleString()}</span> </div> </> )} </div> </div> {/* Capienza vs Deduction card */} <div className={`rounded-lg p-3 border ${
 statusColor === 'emerald' ? 'bg-success-subtle border-success-border' :
 statusColor === 'amber' ? 'bg-warning-subtle border-warning-border' :
 'bg-danger-subtle border-danger-border'
 }`}>
 <div className="flex items-center justify-between mb-2">
 <div className="flex items-center gap-2">
 <TrendingUp size={14} className={
 statusColor === 'emerald' ? 'text-success' :
 statusColor === 'amber' ? 'text-warning' :
 'text-danger'
 } />
 <span className={`text-xs font-semibold ${
 statusColor === 'emerald' ? 'text-success' :
 statusColor === 'amber' ? 'text-warning' :
 'text-danger'
 }`}>{t('capienza.vsDeduction')}</span>
 </div>
 <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
 statusColor === 'emerald' ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-800/40 dark:text-emerald-300' :
 statusColor === 'amber' ? 'bg-warning-subtle text-warning' :
 'bg-red-100 text-red-700 dark:bg-red-800/40 dark:text-red-300'
 }`}>
 {coveragePct}%
 </span>
 </div>

 <div className="grid grid-cols-2 gap-2 text-xs mb-2">
 <div>
 <p className="text-muted">{t('capienza.yourCapienza')}</p>
 <p className="font-bold text-body">€{Math.round(grossTax).toLocaleString()}/{t('capienza.year')}</p>
 </div>
 <div>
 <p className="text-muted">{t('capienza.yearlyQuota')}</p>
 <p className="font-bold text-body">€{yearlyDed.toLocaleString()}/{t('capienza.year')}</p>
 </div>
 </div>

 {/* Progress bar */}
 <div className="w-full bg-surface-raised rounded-full h-2 overflow-hidden">
 <div
 className={`h-2 rounded-full transition-transform origin-left ${
 statusColor === 'emerald' ? 'bg-emerald-700' :
 statusColor === 'amber' ? 'bg-amber-500' :
 'bg-red-500'
 }`}
 style={{ transform: `scaleX(${coveragePct / 100})` }}
 />
 </div>

 {/* Verdict */}
 <p className={`text-xs mt-2 leading-relaxed ${
 statusColor === 'emerald' ? 'text-success' :
 statusColor === 'amber' ? 'text-warning' :
 'text-danger'
 }`}>
 {isFullyCovered
 ? t('capienza.verdictOk', { irpef: Math.round(grossTax).toLocaleString(), deduction: yearlyDed.toLocaleString() })
 : t('capienza.verdictLoss', { irpef: Math.round(grossTax).toLocaleString(), deduction: yearlyDed.toLocaleString(), loss: Math.round(deficit).toLocaleString() })
 }
 </p>
 </div>

 {/* Year-by-year table when deficit */}
 {!isFullyCovered && (
 <div className="bg-surface-alt rounded-lg p-3 space-y-2">
 <p className="text-xs font-semibold text-subtle flex items-center gap-1.5">
 <Clock size={13} className="text-amber-500" /> {t('capienza.yearByYear')}
 </p>
 <div className="overflow-x-auto">
 <table className="w-full text-xs">
 <thead>
 <tr className="border-b border-edge">
 <th className="text-left py-1 text-muted font-medium">{t('capienza.thYear')}</th>
 <th className="text-right py-1 text-muted font-medium">{t('capienza.thQuota')}</th>
 <th className="text-right py-1 text-muted font-medium">{t('capienza.thAbsorbed')}</th>
 <th className="text-right py-1 text-muted font-medium">{t('capienza.thLost')}</th>
 </tr>
 </thead>
 <tbody>
 {Array.from({ length: result.years }, (_, i) => {
 const absorbed = Math.min(yearlyDed, Math.round(grossTax));
 const lost = yearlyDed - absorbed;
 return (
 <tr key={i} className="border-b border-edge">
 <td className="py-1 text-body">{i + 1}</td>
 <td className="py-1 text-right text-body">€{yearlyDed.toLocaleString()}</td>
 <td className="py-1 text-right text-success">€{absorbed.toLocaleString()}</td>
 <td className="py-1 text-right text-danger">{lost > 0 ? `€${lost.toLocaleString()}` : '—'}</td>
 </tr>
 );
 })}
 <tr className="font-semibold">
 <td className="py-1 text-body">{t('capienza.total')}</td>
 <td className="py-1 text-right text-body">€{result.totalDeduction.toLocaleString()}</td>
 <td className="py-1 text-right text-success">€{(Math.min(yearlyDed, Math.round(grossTax)) * result.years).toLocaleString()}</td>
 <td className="py-1 text-right text-danger">€{(Math.max(0, yearlyDed - Math.round(grossTax)) * result.years).toLocaleString()}</td>
 </tr>
 </tbody>
 </table>
 </div>
 </div>
 )}

 {/* Tip cards */}
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
 <div className="bg-accent-subtle rounded-lg p-2.5 border border-accent-border">
 <p className="text-sm text-accent flex items-center gap-1">
 <CreditCard size={12} /> {t('capienza.tipOtherIncome')}
 </p>
 </div>
 <div className="bg-accent-subtle rounded-lg p-2.5 border border-accent-border">
 <p className="text-xs text-accent flex items-center gap-1">
 <FileText size={12} /> {t('capienza.tipSplitYears')}
 </p>
 </div>
 </div>
 </>
 );
 })() : (
 /* No base imponibile entered — prompt user */
 <div className="flex items-start gap-2.5">
 <Info size={16} className="text-link mt-0.5 shrink-0" />
 <div>
 <p className="text-sm text-subtle leading-relaxed">{t('capienza.enterGrossSalary')}</p>
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
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
 <button onClick={() => toggleSection('bonuses')} className="w-full flex items-center justify-between p-4">
 <h3 className="font-bold text-strong flex items-center gap-2">
 <Info size={18} className="text-stripe-600" /> {t('renovation.availableBonuses')}
 </h3>
 {openSections.has('bonuses') ? <ChevronUp size={18} className="text-muted" /> : <ChevronDown size={18} className="text-muted" />}
 </button>
 {openSections.has('bonuses') && (
 <div className="px-4 pb-4 space-y-3 border-t border-edge pt-4 animate-fade-in">
 {IT_BONUSES.map(b => {
 const effective = propertyType === 'seconda_casa' && b.secondaCasa
 ? { percent: b.secondaCasa.percent, maxAmount: b.secondaCasa.maxAmount }
 : { percent: b.percent, maxAmount: b.maxAmount };
 return (
 <div
 key={b.key}
 className={`rounded-xl p-3 border ${
 selectedITBonus === b.key
 ? 'bg-success-subtle border-success-border'
 : 'bg-surface-alt border-edge'
 } cursor-pointer transition-colors`}
 onClick={() => setSelectedITBonus(b.key)}
 role="button"
 tabIndex={0}
 onKeyDown={e => e.key === 'Enter' && setSelectedITBonus(b.key)}
 >
 <div className="flex items-center justify-between">
 <h4 className="font-semibold text-sm text-strong">{t(`renovation.bonus.${b.key}`)}</h4>
 <div className="flex items-center gap-1.5">
 {b.secondaCasa && propertyType === 'seconda_casa' && (
 <span className="text-xs bg-warning-subtle text-warning px-1.5 py-0.5 rounded-full font-medium">
 {t('renovation.secondaCasa')}
 </span>
 )}
 <span className="text-sm font-bold text-success">{effective.percent}%</span>
 </div>
 </div>
 <p className="text-sm text-muted mt-1">
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
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
 <button onClick={() => toggleSection('categories')} className="w-full flex items-center justify-between p-4">
 <h3 className="font-bold text-strong flex items-center gap-2">
 <Info size={18} className="text-stripe-600" /> {t('renovation.swissCategories')}
 </h3>
 {openSections.has('categories') ? <ChevronUp size={18} className="text-muted" /> : <ChevronDown size={18} className="text-muted" />}
 </button>
 {openSections.has('categories') && (
 <div className="px-4 pb-4 space-y-3 border-t border-edge pt-4 animate-fade-in">
 {RENOVATION_CATEGORIES.map(cat => {
 const Icon = cat.icon;
 return (
 <div
 key={cat.key}
 className={`rounded-xl p-3 border ${
 selectedCategory === cat.key
 ? 'bg-success-subtle border-success-border'
 : 'bg-surface-alt border-edge'
 } cursor-pointer transition-colors`}
 onClick={() => setSelectedCategory(cat.key)}
 role="button"
 tabIndex={0}
 onKeyDown={e => e.key === 'Enter' && setSelectedCategory(cat.key)}
 >
 <div className="flex items-center gap-2 mb-1">
 <Icon size={16} className={cat.deductible ? 'text-emerald-700' : 'text-red-500'} />
 <h4 className="font-semibold text-sm text-strong">{t(`renovation.cat.${cat.key}`)}</h4>
 <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${
 cat.deductible
 ? 'bg-success-subtle text-success'
 : 'bg-danger-subtle text-danger'
 }`}>
 {cat.deductible ? t('renovation.deductible') : t('renovation.notDeductible')}
 </span>
 </div>
 <p className="text-sm text-muted">{t(`renovation.catDesc.${cat.key}`)}</p>
 </div>
 );
 })}
 </div>
 )}
 </div>
 )}

 {/* FAQ Section — Frontalieri & renovation bonuses */}
 {countryOfProperty === 'IT' && (
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
 <button onClick={() => toggleSection('faq')} className="w-full flex items-center justify-between p-4">
 <h3 className="font-bold text-strong flex items-center gap-2">
 <HelpCircle size={18} className="text-stripe-600" /> {t('renovation.faqTitle')}
 </h3>
 {openSections.has('faq') ? <ChevronUp size={18} className="text-muted" /> : <ChevronDown size={18} className="text-muted" />}
 </button>
 {openSections.has('faq') && (
 <div className="px-4 pb-4 space-y-2 border-t border-edge pt-4 animate-fade-in">
 {FAQ_KEYS.map(fk => (
 <div key={fk} className="rounded-xl border border-edge overflow-hidden">
 <button
 onClick={() => setExpandedFaq(expandedFaq === fk ? null : fk)}
 className="w-full flex items-center justify-between p-3 text-left" aria-expanded={expandedFaq === fk}
 >
 <span className="text-sm font-medium text-body pr-2">{t(`renovation.faq.${fk}.q`)}</span>
 {expandedFaq === fk
 ? <ChevronUp size={16} className="text-muted shrink-0" />
 : <ChevronDown size={16} className="text-muted shrink-0" />}
 </button>
 {expandedFaq === fk && (
 <div className="px-3 pb-3 text-xs text-subtle leading-relaxed border-t border-edge pt-2">
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
