/**
 * TredicesimalCalculator — Calcolatore Tredicesima e Quattordicesima
 *
 * Calculates 13th and 14th month salary (mensilità) for cross-border workers.
 * Handles both Swiss (13th salary) and Italian (13th + 14th) scenarios.
 * Target keyword:"calcolo tredicesima frontaliere" (~200/mo)
 */

import React, { useState, useMemo, lazy, Suspense, useCallback, useEffect } from 'react';
import { useExchangeRate } from '@/services/exchangeRateService';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import {
 Gift, Calculator, Info, Euro, ChevronDown, ChevronUp,
 Calendar, Building2, HelpCircle, TrendingUp, Award
} from 'lucide-react';

const LeadMagnetCTA = lazy(() => import('@/components/shared/LeadMagnetCTA'));
const ShareableResultCard = lazy(() => import('@/components/shared/ShareableResultCard'));
const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));

// ─── Types ──────────────────────────────────────────────────────────────

type ContractType = 'swiss' | 'italian_ccnl' | 'italian_other';
type PaymentFrequency = '12' | '13' | '14';

interface TredInputs {
 annualGross: number;
 contractType: ContractType;
 monthsWorked: number; // months worked in the current year (pro-rata)
 paymentFrequency: PaymentFrequency;
 hasQuattordicesima: boolean;
 exchangeRate: number;
}

interface TredResult {
 monthlyGross: number;
 tredicesima: number;
 quattordicesima: number;
 totalExtra: number;
 proRataFactor: number;
 monthlySalaryWith13: number;
 monthlySalaryWith14: number;
 annualNetBenefit: number;
 currency: string;
}

// ─── Calculation ────────────────────────────────────────────────────────

function calculateTredicesima(inputs: TredInputs): TredResult {
 const {
 annualGross, contractType, monthsWorked,
 paymentFrequency, hasQuattordicesima, exchangeRate
 } = inputs;

 const isSwiss = contractType === 'swiss';
 const currency = isSwiss ? 'CHF' : 'EUR';

 // Monthly gross based on payment frequency
 const divisor = parseInt(paymentFrequency);
 const monthlyGross = annualGross / divisor;

 // Pro-rata factor (e.g., 6 months worked = 50%)
 const proRataFactor = Math.min(monthsWorked, 12) / 12;

 // Tredicesima: 1 extra month (usually December)
 // In Switzerland, typically the 13th salary is already included in the annual gross for 13-month contracts
 // For Italian contracts, calculated separately
 let tredicesima = 0;
 if (isSwiss) {
 // Swiss 13th salary: annual / 12 (one extra month), pro-rated
 tredicesima = (annualGross / 12) * proRataFactor;
 // If already paid in 13 installments, the tredicesima is already in the monthly pay
 if (paymentFrequency === '13') {
 tredicesima = monthlyGross * proRataFactor; // Already distributed
 }
 } else {
 // Italian: tredicesima = monthly gross × pro-rata
 tredicesima = monthlyGross * proRataFactor;
 }

 // Quattordicesima: only for some Italian CCNL contracts (commercial, tourism, etc.)
 let quattordicesima = 0;
 if (hasQuattordicesima && !isSwiss) {
 quattordicesima = monthlyGross * proRataFactor;
 }

 const totalExtra = tredicesima + quattordicesima;

 // What the equivalent monthly salary would be if 13th/14th were spread across 12 months
 const totalAnnualPay = annualGross + (isSwiss && paymentFrequency === '12' ? tredicesima : 0) + (hasQuattordicesima ? quattordicesima : 0);
 const monthlySalaryWith13 = totalAnnualPay / 12;
 const monthlySalaryWith14 = (totalAnnualPay + (hasQuattordicesima ? 0 : quattordicesima)) / 12;

 // Convert to EUR for frontalieri comparison
 const annualNetBenefit = isSwiss ? totalExtra * exchangeRate : totalExtra;

 return {
 monthlyGross,
 tredicesima,
 quattordicesima,
 totalExtra,
 proRataFactor,
 monthlySalaryWith13,
 monthlySalaryWith14,
 annualNetBenefit,
 currency,
 };
}

// ─── Component ──────────────────────────────────────────────────────────

const TredicesimalCalculator: React.FC = () => {
 const { t } = useTranslation();
 const [showInfo, setShowInfo] = useState(false);
 const [calculated, setCalculated] = useState(false);

 // Inputs
 const [annualGross, setAnnualGross] = useState(72000);
 const [contractType, setContractType] = useState<ContractType>('swiss');
 const [monthsWorked, setMonthsWorked] = useState(12);
 const [paymentFrequency, setPaymentFrequency] = useState<PaymentFrequency>('13');
 const [hasQuattordicesima, setHasQuattordicesima] = useState(false);
 const { rate: _liveRate } = useExchangeRate();
 const [exchangeRate, setExchangeRate] = useState(_liveRate);
 useEffect(() => { if (_liveRate > 0) setExchangeRate(_liveRate); }, [_liveRate]);

 const inputs: TredInputs = useMemo(() => ({
 annualGross, contractType, monthsWorked,
 paymentFrequency, hasQuattordicesima, exchangeRate,
 }), [annualGross, contractType, monthsWorked, paymentFrequency, hasQuattordicesima, exchangeRate]);

 const result = useMemo(() => calculateTredicesima(inputs), [inputs]);

 const handleCalc = useCallback(() => {
 setCalculated(true);
 Analytics.trackUIInteraction('tredicesima_calc', 'calculator', 'calculate', `${contractType}_${monthsWorked}m`);
 }, [contractType, monthsWorked]);

 const formatCurrency = useCallback((amount: number, cur: string) => {
 return `${cur} ${amount.toLocaleString('it-CH', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`; }, []); return ( <div className="max-w-2xl mx-auto"> {/* Header */} <div className="text-center mb-8"> <h2 className="text-2xl font-bold text-heading flex items-center justify-center gap-3"> <Gift size={24} className="text-warning" /> {t('tredicesima.title')} </h2> <p className="text-subtle mt-2 text-sm max-w-md mx-auto"> {t('tredicesima.subtitle')} </p> </div> {/* Info Toggle */} <button onClick={() => setShowInfo(!showInfo)} className="w-full flex items-center justify-between px-4 py-3 bg-warning-subtle border border-warning-border rounded-xl mb-6 text-sm transition-colors" aria-label={t('tredicesima.whatIs')} > <span className="flex items-center gap-2 font-medium text-warning"> <HelpCircle size={16} /> {t('tredicesima.whatIs')} </span> {showInfo ? <ChevronUp size={16} className="text-warning" /> : <ChevronDown size={16} className="text-warning" />} </button> {showInfo && ( <div className="bg-surface rounded-2xl border border-edge p-5 mb-6 text-sm text-subtle space-y-3"> <p><strong className="text-body">{t('tredicesima.info.swiss.title')}</strong>: {t('tredicesima.info.swiss.desc')}</p> <p><strong className="text-body">{t('tredicesima.info.italian.title')}</strong>: {t('tredicesima.info.italian.desc')}</p> <p><strong className="text-body">{t('tredicesima.info.quattordicesima.title')}</strong>: {t('tredicesima.info.quattordicesima.desc')}</p> </div> )} {/* Input Form */} <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 mb-6 space-y-5"> {/* Contract Type */} <div> <label htmlFor="tred-contract" className="block text-sm font-medium text-body mb-1"> <Building2 size={14} className="inline mr-1" /> {t('tredicesima.contractType')} </label> <select id="tred-contract" value={contractType} onChange={e => { setContractType(e.target.value as ContractType); setCalculated(false); }} className="w-full px-3 py-2 rounded-xl border border-edge bg-surface text-strong text-sm" > <option value="swiss">{t('tredicesima.contract.swiss')}</option> <option value="italian_ccnl">{t('tredicesima.contract.italianCcnl')}</option> <option value="italian_other">{t('tredicesima.contract.italianOther')}</option> </select> </div> {/* Annual Gross */} <div> <label htmlFor="tred-gross" className="block text-sm font-medium text-body mb-1"> <Euro size={14} className="inline mr-1" /> {t('tredicesima.annualGross')} ({contractType === 'swiss' ? 'CHF' : 'EUR'}) </label> <input id="tred-gross" type="number" inputMode="numeric" value={annualGross} onChange={e => { setAnnualGross(Number(e.target.value)); setCalculated(false); }} className="w-full px-3 py-2 rounded-xl border border-edge bg-surface text-strong text-sm" min={0} step={1000} /> </div> {/* Payment Frequency */} <div> <label htmlFor="tred-freq" className="block text-sm font-medium text-body mb-1"> <Calendar size={14} className="inline mr-1" /> {t('tredicesima.paymentFreq')} </label> <select id="tred-freq" value={paymentFrequency} onChange={e => { setPaymentFrequency(e.target.value as PaymentFrequency); setCalculated(false); }} className="w-full px-3 py-2 rounded-xl border border-edge bg-surface text-strong text-sm" > <option value="12">{t('tredicesima.freq.12')}</option> <option value="13">{t('tredicesima.freq.13')}</option> <option value="14">{t('tredicesima.freq.14')}</option> </select> </div> {/* Months Worked */} <div> <label htmlFor="tred-months" className="block text-sm font-medium text-body mb-1"> <Calendar size={14} className="inline mr-1" /> {t('tredicesima.monthsWorked')} </label> <input id="tred-months" type="range" min={1} max={12} value={monthsWorked} onChange={e => { setMonthsWorked(Number(e.target.value)); setCalculated(false); }} className="w-full accent-warning" /> <p className="text-xs text-muted mt-1"> {monthsWorked} {t('tredicesima.months')} </p> </div> {/* Quattordicesima toggle (Italian only) */} {contractType !== 'swiss' && ( <div className="flex items-center justify-between"> <label htmlFor="tred-quattordicesima" className="text-sm font-medium text-body"> <Award size={14} className="inline mr-1" /> {t('tredicesima.hasQuattordicesima')} </label> <button id="tred-quattordicesima" role="switch" aria-checked={hasQuattordicesima} aria-label={t('tredicesima.hasQuattordicesima')} onClick={() => { setHasQuattordicesima(!hasQuattordicesima); setCalculated(false); }} className={`w-12 h-6 rounded-full transition-colors ${
 hasQuattordicesima ? 'bg-warning-strong' : 'bg-surface-raised'
 }`}
 >
 <div className={`w-5 h-5 bg-surface rounded-full shadow transition-transform ${
 hasQuattordicesima ? 'translate-x-6' : 'translate-x-0.5'
 }`} /> </button> </div> )} {/* Exchange Rate (Swiss only) */} {contractType === 'swiss' && ( <div> <label htmlFor="tred-rate" className="block text-sm font-medium text-body mb-1"> <TrendingUp size={14} className="inline mr-1" /> {t('tredicesima.exchangeRate')} </label> <input id="tred-rate" type="number" inputMode="decimal" value={exchangeRate} onChange={e => { setExchangeRate(Number(e.target.value)); setCalculated(false); }} className="w-full px-3 py-2 rounded-xl border border-edge bg-surface text-heading text-sm" min={0.5} max={1.5} step={0.01} /> </div> )} {/* Calculate Button */} <button onClick={handleCalc} className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-warning-strong hover:bg-warning-strong-hover text-on-accent font-semibold rounded-xl transition-colors" aria-label={t('tredicesima.calculate')} > <Calculator size={18} /> {t('tredicesima.calculate')} </button> </div> {/* Results */} {calculated && ( <> <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 mb-6"> <h3 className="font-bold text-lg text-strong mb-4 flex items-center gap-2"> <Gift size={18} className="text-warning" /> {t('tredicesima.results.title')} </h3> <div className="grid grid-cols-2 gap-4"> {/* Monthly Gross */} <div className="bg-surface-alt rounded-xl p-4 text-center"> <p className="text-xs text-muted mb-1">{t('tredicesima.results.monthlyGross')}</p> <p className="text-lg font-bold text-strong">{formatCurrency(result.monthlyGross, result.currency)}</p> </div> {/* Tredicesima */} <div className="bg-warning-subtle rounded-xl p-4 text-center"> <p className="text-xs text-warning mb-1">{t('tredicesima.results.tredicesima')}</p> <p className="text-lg font-bold text-warning">{formatCurrency(result.tredicesima, result.currency)}</p> </div> {/* Quattordicesima (if applicable) */} {hasQuattordicesima && contractType !== 'swiss' && ( <div className="bg-warning-subtle rounded-xl p-4 text-center"> <p className="text-xs text-warning mb-1">{t('tredicesima.results.quattordicesima')}</p> <p className="text-lg font-bold text-warning">{formatCurrency(result.quattordicesima, result.currency)}</p> </div> )} {/* Total Extra */} <div className="bg-success-subtle rounded-xl p-4 text-center"> <p className="text-xs text-success mb-1">{t('tredicesima.results.totalExtra')}</p> <p className="text-lg font-bold text-success">{formatCurrency(result.totalExtra, result.currency)}</p> </div> </div> {/* Pro-rata info */} {monthsWorked < 12 && ( <div className="mt-4 flex items-start gap-2 text-xs text-muted bg-surface-alt rounded-xl p-3"> <Info size={14} className="mt-0.5 shrink-0" /> <span>{t('tredicesima.results.proRata', { months: String(monthsWorked), percent: String(Math.round(result.proRataFactor * 100)) })}</span> </div> )} {/* EUR equivalent for Swiss contracts */} {contractType === 'swiss' && ( <div className="mt-4 text-center text-sm text-subtle"> {t('tredicesima.results.eurEquiv')}: <strong className="text-strong">EUR {Math.round(result.annualNetBenefit).toLocaleString('it-CH')}</strong> </div> )} </div> {/* Lead Magnet CTA */} <Suspense fallback={null}> <LeadMagnetCTA variant="salary_guide" delay={3000} /> </Suspense> {/* Shareable result card */} <Suspense fallback={null}> <ShareableResultCard title={t('tredicesima.title') || 'Calcolo Tredicesima'} subtitle={`${inputs.annualGross.toLocaleString('it-CH')} ${result.currency}/anno`}
 rows={[
 { label: t('tredicesima.results.monthlyGross') || 'Lordo mensile', value: `${result.currency} ${Math.round(result.monthlyGross).toLocaleString('it-CH')}` },
 { label: t('tredicesima.results.tredicesima') || 'Tredicesima', value: `${result.currency} ${Math.round(result.tredicesima).toLocaleString('it-CH')}`, highlight: true, color: 'amber' },
 ...(result.quattordicesima > 0 ? [{ label: t('tredicesima.results.quattordicesima') || 'Quattordicesima', value: `${result.currency} ${Math.round(result.quattordicesima).toLocaleString('it-CH')}`, color: 'amber' as const }] : []),
 { label: t('tredicesima.results.totalExtra') || 'Totale extra', value: `${result.currency} ${Math.round(result.totalExtra).toLocaleString('it-CH')}`, highlight: true, color: 'emerald' },
 ]}
 accent="amber"
 context="tredicesima"
 />
 </Suspense>
 </>
 )}
 <Suspense fallback={null}><RelatedTools context="payslip" /></Suspense>
 </div>
 );
};

export default TredicesimalCalculator;
