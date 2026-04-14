import React, { useState, useMemo, useEffect, lazy, Suspense } from 'react';
import { useTranslation } from '@/services/i18n';
import { useExchangeRate } from '@/services/exchangeRateService';
import { Gift, Euro, Calculator, Info, TrendingUp, ChevronDown, ChevronUp, ArrowUpRight, RefreshCw } from 'lucide-react';

const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));
import type { UserProfileData } from '@/components/pages/UserProfile';
import { calculateProgressiveWorkDeduction, calculateProportionalTaxCredit } from '@/services/calculationService';
import { FRANCHIGIA_NUOVI_FRONTALIERI } from '@/constants';

// Swiss bonus types for frontalieri
const BONUS_TYPES = [
 { key: '13th', inKind: false },
 { key: 'performance', inKind: false },
 { key: 'signing', inKind: false },
 { key: 'childAllowance', inKind: false },
 { key: 'mealVouchers', inKind: true },
 { key: 'transport', inKind: true },
 { key: 'relocation', inKind: false },
];

// Swiss social contribution rates (2026)
const AVS_RATE = 0.053;
const AC_RATE = 0.011;
const AANP_RATE = 0.007;
const IJM_RATE = 0.008;
const TOTAL_SOCIAL = AVS_RATE + AC_RATE + AANP_RATE + IJM_RATE;

// Italian IRPEF brackets 2026
const IRPEF_BRACKETS = [
 { upTo: 28000, rate: 0.23 },
 { upTo: 50000, rate: 0.35 },
 { upTo: Infinity, rate: 0.43 },
];

/** Calculate progressive IRPEF tax (not just marginal rate) */
const calculateIrpefTax = (taxableIncome: number): number => {
 if (taxableIncome <= 0) return 0;
 let tax = 0;
 let prev = 0;
 for (const bracket of IRPEF_BRACKETS) {
 const slice = Math.min(taxableIncome, bracket.upTo) - prev;
 if (slice <= 0) break;
 tax += slice * bracket.rate;
 prev = bracket.upTo;
 }
 return tax;
};

const calculateIrpefMarginalRate = (annualIncome: number): number => {
 for (const bracket of IRPEF_BRACKETS) {
 if (annualIncome <= bracket.upTo) return bracket.rate;
 }
 return 0.43;
};

/** Get IRPEF bracket label for a given income */
const getIrpefBracketLabel = (annualIncome: number): string => {
 if (annualIncome <= 28000) return '23% (≤€28k)';
 if (annualIncome <= 50000) return '35% (€28k-50k)';
 return '43% (>€50k)';
};

// Swiss withholding rate approximation based on annual gross
const estimateSwissWithholding = (annualGrossCHF: number, isMarried: boolean, children: number): number => {
 let rate = 0;
 if (annualGrossCHF <= 40000) rate = 0.02;
 else if (annualGrossCHF <= 60000) rate = 0.05;
 else if (annualGrossCHF <= 80000) rate = 0.08;
 else if (annualGrossCHF <= 120000) rate = 0.10;
 else if (annualGrossCHF <= 160000) rate = 0.12;
 else rate = 0.14;

 if (isMarried) rate *= 0.85;
 rate -= children * 0.01;
 return Math.max(0, rate);
};

interface BonusCalcProps {
 userProfile?: UserProfileData | null;
}

const BonusCalculator: React.FC<BonusCalcProps> = ({ userProfile }) => {
 const { t } = useTranslation();
 const { rate: liveRate, loading: rateLoading, refresh: refreshRate } = useExchangeRate();

 const [monthlyGrossCHF, setMonthlyGrossCHF] = useState(7692);
 const [bonusAmountCHF, setBonusAmountCHF] = useState(5000);
 const [selectedBonus, setSelectedBonus] = useState('performance');
 const [isMarried, setIsMarried] = useState(false);
 const [children, setChildren] = useState(1);
 const [rateOverride, setRateOverride] = useState<number | null>(null);
 const [expandedSection, setExpandedSection] = useState<string | null>('result');

 // Prefill from user profile when available
 useEffect(() => {
 if (!userProfile) return;
 if (userProfile.grossSalary) {
 const salary = parseFloat(userProfile.grossSalary);
 if (!isNaN(salary) && salary > 0) setMonthlyGrossCHF(Math.round(salary / 13));
 }
 if (userProfile.familySituation) {
 setIsMarried(userProfile.familySituation === 'married');
 }
 if (userProfile.children) {
 const n = parseInt(userProfile.children, 10);
 if (!isNaN(n)) setChildren(n);
 }
 }, [userProfile]);

 // Use live rate unless user has manually overridden
 const exchangeRate = rateOverride ?? liveRate;

 const annualGross = monthlyGrossCHF * 13; // 13th included

 const result = useMemo(() => {
 // --- Without bonus (base salary only) ---
 const baseSwissRate = estimateSwissWithholding(annualGross, isMarried, children);
 const baseGrossEUR = annualGross * exchangeRate;
 const baseSocialCHF = annualGross * TOTAL_SOCIAL;
 const baseSocialEUR = baseSocialCHF * exchangeRate;
 // Italian taxable base: gross EUR - social - franchigia (Art. 1 c.175 L.147/2013)
 const baseTaxableEUR = Math.max(0, baseGrossEUR - baseSocialEUR - FRANCHIGIA_NUOVI_FRONTALIERI);
 const baseMarginalRate = calculateIrpefMarginalRate(baseTaxableEUR);
 const baseDetrazioni = calculateProgressiveWorkDeduction(baseTaxableEUR);
 const baseIrpefTax = Math.max(0, calculateIrpefTax(baseTaxableEUR) - baseDetrazioni);
 const baseEffectiveIrpef = baseGrossEUR > 0 ? baseIrpefTax / baseGrossEUR : 0;

 // --- With bonus (salary + bonus in the same period) ---
 const totalAnnualGross = annualGross + bonusAmountCHF;
 const withBonusSwissRate = estimateSwissWithholding(totalAnnualGross, isMarried, children);
 const withBonusGrossEUR = totalAnnualGross * exchangeRate;
 const withBonusSocialCHF = totalAnnualGross * TOTAL_SOCIAL;
 const withBonusSocialEUR = withBonusSocialCHF * exchangeRate;
 const withBonusTaxableEUR = Math.max(0, withBonusGrossEUR - withBonusSocialEUR - FRANCHIGIA_NUOVI_FRONTALIERI);
 const withBonusMarginalRate = calculateIrpefMarginalRate(withBonusTaxableEUR);
 const withBonusDetrazioni = calculateProgressiveWorkDeduction(withBonusTaxableEUR);
 const withBonusIrpefTax = Math.max(0, calculateIrpefTax(withBonusTaxableEUR) - withBonusDetrazioni);
 const withBonusEffectiveIrpef = withBonusGrossEUR > 0 ? withBonusIrpefTax / withBonusGrossEUR : 0;

 // --- Bonus-specific calculations ---
 const socialDeductions = bonusAmountCHF * TOTAL_SOCIAL;
 const swissTax = bonusAmountCHF * withBonusSwissRate;
 const netCH = bonusAmountCHF - socialDeductions - swissTax;

 const bonusEUR = bonusAmountCHF * exchangeRate;
 const additionalIrpef = Math.max(0, withBonusIrpefTax - baseIrpefTax);
 // Proportional Swiss tax credit per Art. 165 c.10 TUIR
 const swissTaxCreditEUR = calculateProportionalTaxCredit(
 swissTax * exchangeRate, withBonusTaxableEUR, withBonusGrossEUR
 );
 const netAdditionalIrpef = Math.max(0, additionalIrpef - swissTaxCreditEUR);
 const netBonusEUR = bonusEUR - netAdditionalIrpef;

 // --- Tax impact analysis ---
 const swissRateDelta = withBonusSwissRate - baseSwissRate;
 const irpefRateDelta = withBonusEffectiveIrpef - baseEffectiveIrpef;
 const bracketJumped = withBonusMarginalRate > baseMarginalRate;

 // Tax on bonus at base rate vs actual rate
 const taxAtBaseRate = bonusAmountCHF * baseSwissRate;
 const extraSwissTax = Math.round(swissTax - taxAtBaseRate);

 // Effective rate on bonus only (what % of the bonus goes to taxes total)
 const totalTaxOnBonus = socialDeductions + swissTax + netAdditionalIrpef;
 const effectiveBonusRate = bonusEUR > 0 ? Math.round((totalTaxOnBonus / bonusAmountCHF) * 100) : 0;

 return {
 grossCHF: bonusAmountCHF,
 socialDeductions: Math.round(socialDeductions),
 swissTax: Math.round(swissTax),
 swissTaxRate: withBonusSwissRate,
 netCH: Math.round(netCH),
 bonusEUR: Math.round(bonusEUR),
 marginalRate: withBonusMarginalRate,
 additionalIrpef: Math.round(netAdditionalIrpef),
 netBonusEUR: Math.round(netBonusEUR),
 effectiveTaxRate: effectiveBonusRate,
 // Tax impact fields
 baseSwissRate,
 withBonusSwissRate,
 swissRateDelta,
 baseMarginalRate,
 withBonusMarginalRate,
 baseEffectiveIrpef,
 withBonusEffectiveIrpef,
 irpefRateDelta,
 bracketJumped,
 extraSwissTax,
 baseIncomeEUR: Math.round(baseGrossEUR),
 withBonusIncomeEUR: Math.round(withBonusGrossEUR),
 baseBracketLabel: getIrpefBracketLabel(baseTaxableEUR),
 withBonusBracketLabel: getIrpefBracketLabel(withBonusTaxableEUR),
 };
 }, [bonusAmountCHF, annualGross, isMarried, children, exchangeRate]);

 const toggleSection = (key: string) => {
 setExpandedSection(expandedSection === key ? null : key);
 };

 return (
 <div className="space-y-6">
 {/* Header */}
 <div className="bg-success rounded-2xl p-4 sm:p-6 text-on-accent">
 <div className="flex items-center gap-3 mb-2">
 <Gift size={28} />
 <h2 className="text-2xl font-bold">{t('bonus.title')}</h2>
 </div>
 <p className="text-success text-sm">{t('bonus.subtitle')}</p>
 </div>

 {/* Input section */}
 <div className="bg-surface rounded-2xl p-4 sm:p-6 border border-edge space-y-4">
 <h3 className="font-bold text-strong flex items-center gap-2">
 <Calculator size={18} className="text-success" /> {t('bonus.inputs')}
 </h3>
 <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
 <div>
 <label htmlFor="bonus-salary" className="block text-xs font-semibold text-subtle mb-1">
 {t('bonus.monthlySalary')} (CHF)
 </label>
 <input
 id="bonus-salary"
 type="number"
 inputMode="numeric"
 value={monthlyGrossCHF}
 onChange={e => setMonthlyGrossCHF(Number(e.target.value))}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 />
 </div>
 <div>
 <label htmlFor="bonus-amount" className="block text-xs font-semibold text-subtle mb-1">
 {t('bonus.amount')} (CHF)
 </label>
 <input
 id="bonus-amount"
 type="number"
 inputMode="numeric"
 value={bonusAmountCHF}
 onChange={e => setBonusAmountCHF(Number(e.target.value))}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 />
 </div>
 <div>
 <label htmlFor="bonus-type" className="block text-xs font-semibold text-subtle mb-1">
 {t('bonus.type')}
 </label>
 <select
 id="bonus-type"
 value={selectedBonus}
 onChange={e => setSelectedBonus(e.target.value)}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 >
 {BONUS_TYPES.map(bt => (
 <option key={bt.key} value={bt.key}>{t(`bonus.types.${bt.key}`)}</option>
 ))}
 </select>
 </div>
 <div>
 <label htmlFor="bonus-married" className="block text-xs font-semibold text-subtle mb-1">
 {t('bonus.maritalStatus')}
 </label>
 <select
 id="bonus-married"
 value={isMarried ? 'married' : 'single'}
 onChange={e => setIsMarried(e.target.value === 'married')}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 >
 <option value="single">{t('bonus.single')}</option>
 <option value="married">{t('bonus.married')}</option>
 </select>
 </div>
 <div>
 <label htmlFor="bonus-children" className="block text-xs font-semibold text-subtle mb-1">
 {t('bonus.children')}
 </label>
 <input
 id="bonus-children"
 type="number"
 inputMode="numeric"
 min={0}
 max={10}
 value={children}
 onChange={e => setChildren(Number(e.target.value))}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 />
 </div>
 <div>
 <label htmlFor="bonus-exchange" className="block text-xs font-semibold text-subtle mb-1">
 {t('bonus.exchangeRate')} (CHF→EUR)
 </label>
 <div className="flex gap-1">
 <input
 id="bonus-exchange"
 type="number"
 inputMode="decimal"
 step={0.01}
 value={Number(exchangeRate.toFixed(4))}
 onChange={e => setRateOverride(Number(e.target.value))}
 className="w-full px-3 py-2 rounded-lg border border-edge bg-surface-alt text-sm text-strong"
 />
 <button
 onClick={() => { setRateOverride(null); refreshRate(); }}
 className="px-2 py-2 rounded-lg border border-edge bg-surface-alt hover:bg-surface-raised transition-colors"
 aria-label={t('bonus.refreshRate')}
 title={t('bonus.refreshRate')}
 >
 <RefreshCw size={14} className={`text-muted ${rateLoading ? 'animate-spin' : ''}`} />
 </button>
 </div>
 {rateOverride !== null && (
 <p className="text-xs text-warning mt-0.5">{t('bonus.manualRate')}</p>
 )}
 </div>
 </div>
 </div>

 {/* Result */}
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
 <button onClick={() => toggleSection('result')} className="w-full flex items-center justify-between p-4" aria-expanded={expandedSection === 'result'}>
 <h3 className="font-bold text-strong flex items-center gap-2">
 <Euro size={18} className="text-success" /> {t('bonus.result')}
 </h3>
 {expandedSection === 'result' ? <ChevronUp size={18} className="text-muted" /> : <ChevronDown size={18} className="text-muted" />}
 </button>
 {expandedSection === 'result' && (
 <div className="px-4 pb-4 space-y-4 border-t border-edge pt-4 animate-fade-in">
 {/* Swiss breakdown */}
 <div className="space-y-2">
 <h4 className="text-sm font-bold text-body">🇨🇭 {t('bonus.swissBreakdown')}</h4>
 <div className="grid grid-cols-2 gap-2">
 <ResultRow label={t('bonus.grossBonus')} value={`CHF ${result.grossCHF.toLocaleString()}`} />
 <ResultRow label={t('bonus.socialDeductions')} value={`- CHF ${result.socialDeductions.toLocaleString()}`} negative />
 <ResultRow label={`${t('bonus.withholding')} (${(result.swissTaxRate * 100).toFixed(1)}%)`} value={`- CHF ${result.swissTax.toLocaleString()}`} negative />
 <ResultRow label={t('bonus.netCH')} value={`CHF ${result.netCH.toLocaleString()}`} highlight />
 </div>
 </div>
 {/* Italian breakdown */}
 <div className="space-y-2">
 <h4 className="text-sm font-bold text-body">🇮🇹 {t('bonus.italianBreakdown')}</h4>
 <div className="grid grid-cols-2 gap-2">
 <ResultRow label={t('bonus.bonusEUR')} value={`€${result.bonusEUR.toLocaleString()}`} />
 <ResultRow label={`IRPEF ${t('bonus.marginal')} (${(result.marginalRate * 100).toFixed(0)}%)`} value={`- €${result.additionalIrpef.toLocaleString()}`} negative />
 <ResultRow label={t('bonus.netEUR')} value={`€${result.netBonusEUR.toLocaleString()}`} highlight />
 </div>
 </div>
 {/* Effective rate */}
 <div className="bg-surface-alt rounded-xl p-4 text-center">
 <p className="text-xs text-muted mb-1">{t('bonus.effectiveRate')}</p>
 <p className={`text-3xl font-bold ${result.effectiveTaxRate > 40 ? 'text-danger' : result.effectiveTaxRate > 25 ? 'text-warning' : 'text-success'}`}>
 {result.effectiveTaxRate}%
 </p>
 </div>
 </div>
 )}
 </div>

 {/* Tax rate impact simulation */}
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
 <button onClick={() => toggleSection('taxImpact')} className="w-full flex items-center justify-between p-4" aria-expanded={expandedSection === 'taxImpact'}>
 <h3 className="font-bold text-strong flex items-center gap-2">
 <TrendingUp size={18} className="text-warning" /> {t('bonus.taxImpact')}
 </h3>
 {expandedSection === 'taxImpact' ? <ChevronUp size={18} className="text-muted" /> : <ChevronDown size={18} className="text-muted" />}
 </button>
 {expandedSection === 'taxImpact' && (
 <div className="px-4 pb-4 space-y-4 border-t border-edge pt-4 animate-fade-in">
 <p className="text-xs text-muted">{t('bonus.taxImpactDesc')}</p>

 {/* Comparison table */}
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
 {/* Header row */}
 <div className="font-semibold text-subtle" />
 <div className="font-bold text-body text-center bg-surface-alt rounded-lg p-2">{t('bonus.withoutBonus')}</div>
 <div className="font-bold text-body text-center bg-warning-subtle rounded-lg p-2">{t('bonus.withBonus')}</div>

 {/* Annual income */}
 <div className="text-subtle flex items-center">{t('bonus.annualIncome')}</div>
 <div className="text-center font-semibold text-body bg-surface-alt rounded-lg p-2">CHF {annualGross.toLocaleString()}</div>
 <div className="text-center font-semibold text-body bg-warning-subtle rounded-lg p-2">CHF {(annualGross + bonusAmountCHF).toLocaleString()}</div>

 {/* Swiss withholding rate */}
 <div className="text-subtle flex items-center">{t('bonus.swissRate')}</div>
 <div className="text-center font-semibold text-body bg-surface-alt rounded-lg p-2">{(result.baseSwissRate * 100).toFixed(1)}%</div>
 <div className={`text-center font-semibold rounded-lg p-2 ${result.swissRateDelta > 0 ? 'text-danger bg-danger-subtle' : 'text-body bg-warning-subtle'}`}>
 {(result.withBonusSwissRate * 100).toFixed(1)}%
 {result.swissRateDelta > 0 && <span className="ml-1 text-xs">+{(result.swissRateDelta * 100).toFixed(1)}%</span>}
 </div>

 {/* IRPEF bracket */}
 <div className="text-subtle flex items-center">{t('bonus.irpefBracket')}</div>
 <div className="text-center font-semibold text-body bg-surface-alt rounded-lg p-2">{result.baseBracketLabel}</div>
 <div className={`text-center font-semibold rounded-lg p-2 ${result.bracketJumped ? 'text-danger bg-danger-subtle' : 'text-body bg-warning-subtle'}`}>
 {result.withBonusBracketLabel}
 {result.bracketJumped && <ArrowUpRight size={12} className="inline ml-1" />}
 </div>

 {/* IRPEF effective */}
 <div className="text-subtle flex items-center">{t('bonus.irpefEffective')}</div>
 <div className="text-center font-semibold text-body bg-surface-alt rounded-lg p-2">{(result.baseEffectiveIrpef * 100).toFixed(1)}%</div>
 <div className={`text-center font-semibold rounded-lg p-2 ${result.irpefRateDelta > 0.005 ? 'text-danger bg-danger-subtle' : 'text-body bg-warning-subtle'}`}>
 {(result.withBonusEffectiveIrpef * 100).toFixed(1)}%
 {result.irpefRateDelta > 0.005 && <span className="ml-1 text-xs">+{(result.irpefRateDelta * 100).toFixed(1)}%</span>}
 </div>
 </div>

 {/* Impact summary cards */}
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
 {result.swissRateDelta > 0 && (
 <div className="bg-warning-subtle border border-warning-border rounded-xl p-3">
 <p className="text-xs font-bold text-warning mb-1">{t('bonus.extraSwissTax')}</p>
 <p className="text-lg font-bold text-warning">+ CHF {result.extraSwissTax.toLocaleString()}</p>
 <p className="text-xs text-warning mt-1">{t('bonus.extraSwissTaxDesc')}</p>
 </div>
 )}
 {result.bracketJumped && (
 <div className="bg-danger-subtle border border-danger-border rounded-xl p-3">
 <p className="text-xs font-bold text-danger mb-1 flex items-center gap-1">
 <ArrowUpRight size={14} /> {t('bonus.bracketJump')}
 </p>
 <p className="text-lg font-bold text-danger">{result.baseBracketLabel} → {result.withBonusBracketLabel}</p>
 <p className="text-sm text-danger mt-1">{t('bonus.bracketJumpDesc')}</p>
 </div>
 )}
 {result.swissRateDelta === 0 && !result.bracketJumped && (
 <div className="bg-success-subtle border border-success-border rounded-xl p-3 sm:col-span-2">
 <p className="text-xs font-bold text-success mb-1">{t('bonus.noImpact')}</p>
 <p className="text-sm text-success">{t('bonus.noImpactDesc')}</p>
 </div>
 )}
 </div>

 {/* Effective rate on bonus only */}
 <div className="bg-surface-alt rounded-xl p-4 text-center">
 <p className="text-xs text-muted mb-1">{t('bonus.effectiveBonusRate')}</p>
 <p className={`text-2xl font-bold ${result.effectiveTaxRate > 40 ? 'text-danger' : result.effectiveTaxRate > 25 ? 'text-warning' : 'text-success'}`}>
 {result.effectiveTaxRate}%
 </p>
 <p className="text-xs text-muted mt-1">{t('bonus.effectiveBonusRateDesc')}</p>
 </div>
 </div>
 )}
 </div>

 {/* Info about bonus types */}
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
 <button onClick={() => toggleSection('info')} className="w-full flex items-center justify-between p-4" aria-expanded={expandedSection === 'info'}>
 <h3 className="font-bold text-strong flex items-center gap-2">
 <Info size={18} className="text-accent" /> {t('bonus.typesInfo')}
 </h3>
 {expandedSection === 'info' ? <ChevronUp size={18} className="text-muted" /> : <ChevronDown size={18} className="text-muted" />}
 </button>
 {expandedSection === 'info' && (
 <div className="px-4 pb-4 space-y-3 border-t border-edge pt-4 animate-fade-in">
 {BONUS_TYPES.map(bt => (
 <div key={bt.key} className="bg-surface-alt rounded-xl p-3">
 <div className="flex items-center gap-2 mb-1">
 <h4 className="font-semibold text-sm text-strong">{t(`bonus.types.${bt.key}`)}</h4>
 {bt.inKind && (
 <span className="text-xs font-bold bg-accent-subtle text-accent px-1.5 py-0.5 rounded-full">
 {t('bonus.inKind')}
 </span>
 )}
 </div>
 <p className="text-xs text-muted">{t(`bonus.typesDesc.${bt.key}`)}</p>
 </div>
 ))}
 </div>
 )}
 </div>
 <Suspense fallback={null}><RelatedTools context="payslip" /></Suspense>
 </div>
 );
};

const ResultRow: React.FC<{ label: string; value: string; negative?: boolean; highlight?: boolean }> = ({ label, value, negative, highlight }) => (
 <>
 <span className="text-sm text-subtle">{label}</span>
 <span className={`text-sm font-bold text-right ${
 highlight ? 'text-success' :
 negative ? 'text-danger' :
 'text-strong'
 }`}>
 {value}
 </span>
 </>
);

export default BonusCalculator;
