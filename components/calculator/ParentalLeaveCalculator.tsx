import React, { useState, useMemo, useEffect, lazy, Suspense } from 'react';
import { useTranslation } from '@/services/i18n';
import { useExchangeRate } from '@/services/exchangeRateService';
import { Baby, Info, Calendar, ChevronDown, ChevronUp, FileText, CheckCircle2, RefreshCw } from 'lucide-react';

const RelatedTools = lazy(() => import('@/components/shared/RelatedTools'));
import type { UserProfileData } from '@/components/pages/UserProfile';

// ─── Swiss IPG (Maternity/Paternity Insurance) ──────────────────────────

// Switzerland: Mutterschaftsentschädigung (MSE)
// - 14 weeks (98 days) maternity leave, 80% of insured salary (max CHF 220/day = CHF 6'720/month)
// - Paternity: 2 weeks (10 working days), 80% of salary (max CHF 220/day)
const IPG_DAILY_MAX_CHF = 220;
const IPG_RATE = 0.80;
const MATERNITY_WEEKS_CH = 14;
const PATERNITY_WEEKS_CH = 2;
const WORKING_DAYS_PER_WEEK = 5;

// Italy: INPS Maternità obbligatoria
// - 5 months (2 before + 3 after OR 1 before + 4 after), 80% of salary
// - Paternity: 10 days at 100%
// - Congedo parentale: 6 months additional at 30%
const MATERNITY_MONTHS_IT = 5;
const MATERNITY_RATE_IT = 0.80;
const PATERNITY_DAYS_IT = 10;
const PATERNITY_RATE_IT = 1.0;
const PARENTAL_MONTHS_IT = 6;
const PARENTAL_RATE_IT = 0.30;

interface LeaveResult {
 dailyAllowance: number;
 totalAllowance: number;
 duration: string;
 rate: number;
 maxMonthly: number;
 notes: string[];
}

function calculateSwissLeave(grossMonthlyCHF: number, type: 'maternity' | 'paternity'): LeaveResult {
 const dailySalary = (grossMonthlyCHF * 12) / 260; // 260 working days/year
 const dailyAllowance = Math.min(dailySalary * IPG_RATE, IPG_DAILY_MAX_CHF);
 const weeks = type === 'maternity' ? MATERNITY_WEEKS_CH : PATERNITY_WEEKS_CH;
 const days = weeks * WORKING_DAYS_PER_WEEK;
 const totalAllowance = dailyAllowance * days;

 return {
 dailyAllowance,
 totalAllowance,
 duration: type === 'maternity' ? '14 settimane (98 giorni)' : '2 settimane (10 giorni lavorativi)',
 rate: IPG_RATE,
 maxMonthly: IPG_DAILY_MAX_CHF * 21.7,
 notes: type === 'maternity'
 ? ['leave.ch.maternity.note1', 'leave.ch.maternity.note2', 'leave.ch.maternity.note3']
 : ['leave.ch.paternity.note1', 'leave.ch.paternity.note2'],
 };
}

function calculateItalianLeave(grossMonthlyEUR: number, type: 'maternity' | 'paternity'): LeaveResult {
 if (type === 'paternity') {
 const dailySalary = grossMonthlyEUR / 21.7;
 return {
 dailyAllowance: dailySalary * PATERNITY_RATE_IT,
 totalAllowance: dailySalary * PATERNITY_RATE_IT * PATERNITY_DAYS_IT,
 duration: '10 giorni lavorativi',
 rate: PATERNITY_RATE_IT,
 maxMonthly: grossMonthlyEUR,
 notes: ['leave.it.paternity.note1', 'leave.it.paternity.note2'],
 };
 }
 // Maternity
 const monthlyAllowance = grossMonthlyEUR * MATERNITY_RATE_IT;
 return {
 dailyAllowance: monthlyAllowance / 21.7,
 totalAllowance: monthlyAllowance * MATERNITY_MONTHS_IT,
 duration: '5 mesi (2+3 o 1+4)',
 rate: MATERNITY_RATE_IT,
 maxMonthly: monthlyAllowance,
 notes: ['leave.it.maternity.note1', 'leave.it.maternity.note2', 'leave.it.maternity.note3'],
 };
}

// ─── Documents Checklist ─────────────────────────────────────────────────

interface DocumentItem {
 key: string;
 country: 'CH' | 'IT' | 'both';
}

const MATERNITY_DOCS: DocumentItem[] = [
 { key: 'leave.doc.medical', country: 'both' },
 { key: 'leave.doc.ipgForm', country: 'CH' },
 { key: 'leave.doc.inpsDomanda', country: 'IT' },
 { key: 'leave.doc.birthCert', country: 'both' },
 { key: 'leave.doc.employerNotice', country: 'both' },
 { key: 'leave.doc.e104', country: 'both' },
];

const PATERNITY_DOCS: DocumentItem[] = [
 { key: 'leave.doc.birthCert', country: 'both' },
 { key: 'leave.doc.ipgFormPat', country: 'CH' },
 { key: 'leave.doc.inpsDomandaPat', country: 'IT' },
 { key: 'leave.doc.employerNotice', country: 'both' },
];

// ─── Component ───────────────────────────────────────────────────────────

interface ParentalLeaveProps {
 userProfile?: UserProfileData | null;
}

const ParentalLeaveCalculator: React.FC<ParentalLeaveProps> = ({ userProfile }) => {
 const { t } = useTranslation();
 const { rate: chfEurRate, loading: rateLoading } = useExchangeRate();
 const [grossMonthlyCHF, setGrossMonthlyCHF] = useState(8333);
 const [leaveType, setLeaveType] = useState<'maternity' | 'paternity'>('maternity');
 const [showDocs, setShowDocs] = useState(false);
 const [showParental, setShowParental] = useState(false);

 // Prefill from user profile when available
 useEffect(() => {
 if (!userProfile) return;
 if (userProfile.grossSalary) {
 const salary = parseFloat(userProfile.grossSalary);
 if (!isNaN(salary) && salary > 0) setGrossMonthlyCHF(Math.round(salary / 12));
 }
 }, [userProfile]);

 // CHF→EUR rate from API (e.g. 0.94)
 const grossMonthlyEUR = grossMonthlyCHF * chfEurRate;

 const chResult = useMemo(() => calculateSwissLeave(grossMonthlyCHF, leaveType), [grossMonthlyCHF, leaveType]);
 const itResult = useMemo(() => calculateItalianLeave(grossMonthlyEUR, leaveType), [grossMonthlyEUR, leaveType]);

 // Frontalieri: get BOTH — CH IPG + IT integration if applicable
 const totalFrontaliereEUR = (chResult.totalAllowance * chfEurRate);
 
 // Parental leave (congedo parentale) — only available in Italy after maternity
 const parentalMonthlyEUR = grossMonthlyEUR * PARENTAL_RATE_IT;
 const parentalTotalEUR = parentalMonthlyEUR * PARENTAL_MONTHS_IT;

 const fmt = (n: number, c: string = '€') => `${c} ${Math.round(n).toLocaleString('it-IT')}`;
 const docs = leaveType === 'maternity' ? MATERNITY_DOCS : PATERNITY_DOCS;

 return (
 <div className="space-y-6">
 {/* Header */}
 <div className="bg-gradient-to-br from-warning-subtle to-warning-subtle rounded-2xl p-4 sm:p-6 border border-warning-border">
 <div className="flex items-center gap-3 mb-2">
 <div className="p-2 bg-warning-subtle rounded-xl">
 <Baby className="w-6 h-6 text-warning" />
 </div>
 <h2 className="text-2xl font-bold text-warning">{t('leave.title')}</h2>
 </div>
 <p className="text-warning text-sm">{t('leave.subtitle')}</p>
 </div>

 {/* Type Selector */}
 <div className="flex gap-2 bg-surface rounded-xl p-1.5 border border-edge max-w-md">
 <button
 onClick={() => setLeaveType('maternity')}
 className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-bold rounded-lg transition-colors ${
 leaveType === 'maternity' ? 'bg-pink-600 text-white shadow-sm' : 'text-subtle hover:bg-surface-raised'
 }`}
 >
 <Baby size={16} />
 {t('leave.maternity')}
 </button>
 <button
 onClick={() => setLeaveType('paternity')}
 className={`flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-bold rounded-lg transition-colors ${
 leaveType === 'paternity' ? 'bg-stripe-600 text-white shadow-sm' : 'text-subtle hover:bg-surface-raised'
 }`}
 >
 <Baby size={16} />
 {t('leave.paternity')}
 </button>
 </div>

 {/* Inputs */}
 <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
 <div className="bg-surface rounded-xl p-4 border border-edge">
 <label className="block text-sm font-bold text-body mb-2">{t('leave.grossMonthlyCHF')}</label>
 <input
 type="number"
 inputMode="numeric"
 value={grossMonthlyCHF}
 onChange={(e) => setGrossMonthlyCHF(Number(e.target.value) || 0)}
 className="w-full px-4 py-2.5 rounded-lg border border-edge bg-surface-alt text-strong font-bold"
 min={3000}
 max={25000}
 step={100}
 aria-label="Stipendio lordo mensile in CHF"
 />
 <input type="range" min={3000} max={15000} step={100} value={grossMonthlyCHF}
 onChange={(e) => setGrossMonthlyCHF(Number(e.target.value))}
 className="w-full mt-2 accent-pink-600"
 aria-label="Regola stipendio lordo mensile"
 />
 </div>

 <div className="bg-surface rounded-xl p-4 border border-edge">
 <label className="block text-sm font-bold text-body mb-2">{t('leave.exchangeRate')}</label>
 <div className="flex items-center gap-2 px-4 py-2.5 rounded-lg border border-edge bg-surface-alt">
 <span className="font-bold text-strong">1 CHF = {chfEurRate.toFixed(4)} EUR</span>
 {rateLoading && <RefreshCw size={14} className="animate-spin text-muted" />}
 </div>
 <p className="text-xs text-muted mt-1">{t('exchange.liveRate') || 'Tasso di cambio live CHF/EUR'}</p>
 </div>
 </div>

 {/* Results */}
 <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
 {/* Swiss IPG */}
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
 <div className="bg-red-600 h-1.5" />
 <div className="p-5 space-y-3">
 <div className="flex items-center gap-2">
 <span className="text-xl">🇨🇭</span>
 <h3 className="font-bold text-strong">{t('leave.chTitle')}</h3>
 </div>

 <div className="space-y-2 text-sm">
 <div className="flex justify-between">
 <span className="text-muted">{t('leave.duration')}</span>
 <span className="font-bold">{chResult.duration}</span>
 </div>
 <div className="flex justify-between">
 <span className="text-muted">{t('leave.rate')}</span>
 <span className="font-bold">{(chResult.rate * 100).toFixed(0)}% {t('leave.ofSalary')}</span>
 </div>
 <div className="flex justify-between">
 <span className="text-muted">{t('leave.dailyAllowance')}</span>
 <span className="font-bold">{fmt(chResult.dailyAllowance, 'CHF')}</span>
 </div>
 <div className="flex justify-between">
 <span className="text-muted">{t('leave.maxDaily')}</span>
 <span className="text-sm text-muted">CHF {IPG_DAILY_MAX_CHF}/giorno</span>
 </div>
 <hr className="border-edge" />
 <div className="flex justify-between">
 <span className="font-bold">{t('leave.totalAllowance')}</span>
 <span className="font-bold text-lg text-success">{fmt(chResult.totalAllowance, 'CHF')}</span>
 </div>
 <div className="flex justify-between text-muted">
 <span>{t('leave.inEUR')}</span>
 <span className="font-bold">{fmt(chResult.totalAllowance * chfEurRate)}</span>
 </div>
 </div>

 <div className="space-y-1 mt-3">
 {chResult.notes.map((note, i) => (
 <p key={i} className="text-xs text-muted flex items-start gap-1">
 <Info className="w-3 h-3 mt-0.5 shrink-0" />
 {t(note)}
 </p>
 ))}
 </div>
 </div>
 </div>

 {/* Italian INPS */}
 <div className="bg-surface rounded-2xl border border-edge overflow-hidden">
 <div className="bg-gradient-to-r from-green-600 via-white to-red-600 h-1.5" />
 <div className="p-5 space-y-3">
 <div className="flex items-center gap-2">
 <span className="text-xl">🇮🇹</span>
 <h3 className="font-bold text-strong">{t('leave.itTitle')}</h3>
 </div>

 <div className="space-y-2 text-sm">
 <div className="flex justify-between">
 <span className="text-muted">{t('leave.duration')}</span>
 <span className="font-bold">{itResult.duration}</span>
 </div>
 <div className="flex justify-between">
 <span className="text-muted">{t('leave.rate')}</span>
 <span className="font-bold">{(itResult.rate * 100).toFixed(0)}% {t('leave.ofSalary')}</span>
 </div>
 <div className="flex justify-between">
 <span className="text-muted">{t('leave.dailyAllowance')}</span>
 <span className="font-bold">{fmt(itResult.dailyAllowance)}</span>
 </div>
 <hr className="border-edge" />
 <div className="flex justify-between">
 <span className="font-bold">{t('leave.totalAllowance')}</span>
 <span className="font-bold text-lg text-success">{fmt(itResult.totalAllowance)}</span>
 </div>
 </div>

 <div className="space-y-1 mt-3">
 {itResult.notes.map((note, i) => (
 <p key={i} className="text-xs text-muted flex items-start gap-1">
 <Info className="w-3 h-3 mt-0.5 shrink-0" />
 {t(note)}
 </p>
 ))}
 </div>
 </div>
 </div>
 </div>

 {/* Frontaliere Summary */}
 <div className="bg-gradient-to-r from-info-subtle to-success-subtle rounded-2xl p-5 border border-info-border">
 <h4 className="font-bold text-info mb-3 flex items-center gap-2">
 <Calendar className="w-5 h-5" />
 {t('leave.frontaliereTitle')}
 </h4>
 <p className="text-sm text-info mb-3">{t('leave.frontaliereDesc')}</p>
 <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
 <div className="bg-surface/60 rounded-lg p-3">
 <p className="text-muted">{t('leave.chIPG')}</p>
 <p className="font-bold text-lg">{fmt(chResult.totalAllowance, 'CHF')}</p>
 <p className="text-xs text-muted">≈ {fmt(totalFrontaliereEUR)}</p>
 </div>
 <div className="bg-surface/60 rounded-lg p-3">
 <p className="text-muted">{t('leave.monthlySalaryLoss')}</p>
 <p className="font-bold text-lg text-warning">-{fmt(grossMonthlyCHF - chResult.maxMonthly / (leaveType === 'maternity' ? 3.5 : 1), 'CHF')}</p>
 <p className="text-xs text-muted">{t('leave.vsFullSalary')}</p>
 </div>
 </div>
 </div>

 {/* Congedo Parentale (after maternity) */}
 {leaveType === 'maternity' && (
 <>
 <button
 onClick={() => setShowParental(!showParental)}
 className="flex items-center gap-2 text-sm font-bold text-accent hover:text-stripe-800 transition-colors"
 >
 {showParental ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
 {t('leave.parentalTitle')}
 </button>

 {showParental && (
 <div className="bg-surface rounded-2xl border border-edge p-5 space-y-3">
 <h4 className="font-bold text-strong">{t('leave.parentalTitle')}</h4>
 <p className="text-sm text-muted">{t('leave.parentalDesc')}</p>
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
 <div className="bg-surface-alt rounded-lg p-3">
 <p className="text-muted">{t('leave.duration')}</p>
 <p className="font-bold">6 {t('leave.months')}</p>
 </div>
 <div className="bg-surface-alt rounded-lg p-3">
 <p className="text-muted">{t('leave.rate')}</p>
 <p className="font-bold">30% {t('leave.ofSalary')}</p>
 </div>
 <div className="bg-surface-alt rounded-lg p-3">
 <p className="text-muted">{t('leave.total')}</p>
 <p className="font-bold text-success">{fmt(parentalTotalEUR)}</p>
 </div>
 </div>
 </div>
 )}
 </>
 )}

 {/* Documents Checklist */}
 <button
 onClick={() => setShowDocs(!showDocs)}
 className="flex items-center gap-2 text-sm font-bold text-muted hover:text-body transition-colors"
 >
 <FileText size={16} />
 {showDocs ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
 {t('leave.docsTitle')}
 </button>

 {showDocs && (
 <div className="bg-surface rounded-2xl border border-edge p-5">
 <div className="space-y-2">
 {docs.map((doc, i) => (
 <div key={i} className="flex items-center gap-3 p-2 rounded-lg hover:bg-surface-raised/50 transition-colors">
 <CheckCircle2 className="w-4 h-4 text-edge shrink-0" />
 <span className="text-sm text-body flex-1">{t(doc.key)}</span>
 <span className={`text-xs px-2 py-0.5 rounded-full font-bold ${
 doc.country === 'CH' ? 'bg-danger-subtle text-danger' :
 doc.country === 'IT' ? 'bg-success-subtle text-success' :
 'bg-accent-subtle text-accent'
 }`}>
 {doc.country === 'both' ? 'CH + IT' : doc.country}
 </span>
 </div>
 ))}
 </div>
 </div>
 )}

 {/* LPP Impact */}
 <div className="bg-surface rounded-2xl border border-edge p-5">
 <h4 className="font-bold text-strong mb-3 flex items-center gap-2">
 <Info className="w-4 h-4 text-stripe-600" />
 {t('leave.lppImpactTitle')}
 </h4>
 <p className="text-sm text-muted mb-3">
 {t('leave.lppImpactDesc')}
 </p>
 <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-sm">
 <div className="bg-accent-subtle rounded-lg p-3">
 <p className="text-xs text-link font-bold uppercase">AVS/AHV</p>
 <p className="text-body">{t('leave.lppAvs')}</p>
 </div>
 <div className="bg-accent-subtle rounded-lg p-3">
 <p className="text-xs text-link font-bold uppercase">LPP/BVG</p>
 <p className="text-body">{t('leave.lppBvg')}</p>
 </div>
 <div className="bg-accent-subtle rounded-lg p-3">
 <p className="text-xs text-link font-bold uppercase">INPS</p>
 <p className="text-body">{t('leave.lppInps')}</p>
 </div>
 </div>
 </div>

 {/* INPS Application Steps */}
 {leaveType === 'maternity' && (
 <div className="bg-success-subtle rounded-2xl border border-success-border p-5">
 <h4 className="font-bold text-success mb-3 flex items-center gap-2">
 <FileText className="w-4 h-4" />
 {t('leave.inpsGuideTitle')}
 </h4>
 <div className="space-y-3">
 {[1, 2, 3, 4, 5].map((step) => (
 <div key={step} className="flex gap-3">
 <div className="w-7 h-7 rounded-full bg-success-border flex items-center justify-center text-xs font-bold text-success shrink-0">
 {step}
 </div>
 <div>
 <p className="text-sm font-bold text-body">{t(`leave.inpsStep${step}Title`)}</p>
 <p className="text-xs text-muted">{t(`leave.inpsStep${step}Desc`)}</p>
 </div>
 </div>
 ))}
 </div>
 </div>
 )}

 {/* Disclaimer */}
 <div className="p-3 bg-warning-subtle rounded-xl border border-warning-border">
 <p className="text-sm text-warning">
 <Info className="inline w-3 h-3 mr-1" />
 {t('leave.disclaimer')}
 </p>
 </div>
 <Suspense fallback={null}><RelatedTools context="guide" /></Suspense>
 </div>
 );
};

export default ParentalLeaveCalculator;
