import React, { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { Coins, TrainFront, Check, ChevronUp, ArrowDown, Settings2, Home, Briefcase, TrendingUp, TrendingDown, Ruler, Mail, X, Loader2, CheckCircle2 } from 'lucide-react';
import { SimulationInputs, SimulationResult } from '../../types';
import { useTranslation, getCantonI18nParams } from '../../services/i18n';
import { lazyRetry } from '@/services/lazyRetry';
import { Analytics } from '@/services/analytics';
import { upsertNewsletterSubscriber, requestConfirmationEmail, markNewsletterSubscribedLocally } from '@/services/newsletterSubscribers';
import { useAuth, renderGoogleButtonWithReadiness, isLinkedInSignInAvailable, signInWithLinkedIn } from '@/services/authService';
import InlineNetDeltaBadge from './InlineNetDeltaBadge';

const ShareableResultCard = lazyRetry(() => import('@/components/shared/ShareableResultCard'));
const SubscriptionCTA = lazyRetry(() => import('@/components/shared/SubscriptionCTA'));

const NEWSLETTER_GATE_DISMISSED_KEY = 'newsletter_gate_dismissed';
const SUBSCRIBED_KEY = 'newsletter_subscribed';

interface Props {
 inputs: SimulationInputs;
 setInputs: React.Dispatch<React.SetStateAction<SimulationInputs>>;
 onCalculate: () => void;
 result: SimulationResult | null;
 /** Render callback — ResultsView JS is only loaded when the user opens full analysis */
 renderResultView?: (
 focusArea?: 'CH' | 'IT' | null,
 onProfileTagClick?: (field: 'age' | 'maritalStatus' | 'children') => void
 ) => React.ReactNode;
 /** Render callback — InputCard JS is only loaded when the bottom sheet opens */
 renderInputCard?: (
 focusField?: 'age' | 'maritalStatus' | 'children' | null,
 focusRequestId?: number
 ) => React.ReactNode;
}

const SALARY_PRESETS = [50000, 60000, 75000, 90000, 100000, 120000, 150000];
const SALARY_MIN = 0;
const SALARY_MAX = 1_000_000;
const formatCHF = (v: number) => Math.round(v).toLocaleString('it-IT');
const formatEUR = (v: number) => Math.round(Math.abs(v)).toLocaleString('it-IT');
const formatCurrency = (v: number) => Math.round(v).toLocaleString('it-IT');

function useNetDelta(value: number | null): { delta: number; key: number } {
 const prevRef = useRef<number | null>(null);
 const [state, setState] = useState({ delta: 0, key: 0 });

 useEffect(() => {
 if (value === null || Number.isNaN(value)) return;
 if (prevRef.current === null) {
 prevRef.current = value;
 return;
 }
 const diff = Math.round(value - prevRef.current);
 prevRef.current = value;
 if (Math.abs(diff) < 1) return;
 setState((prev) => ({ delta: diff, key: prev.key + 1 }));
 }, [value]);

 return state;
}

/**
 * Mobile-only results-first calculator layout (Proposal D).
 *
 * The page flow:
 * 1. Compact salary input + frontier type selector (always visible, ~1 screen)
 * 2. Results card (auto-calculated, immediately visible)
 * 3."Customize" button → slides up a bottom sheet with the full InputCard
 *
 * The bottom sheet uses CSS transforms for a smooth native-app-like feel.
 */
const MobileCalcLayout: React.FC<Props> = ({
 inputs, setInputs, onCalculate, result, renderResultView, renderInputCard,
}) => {
 const { t, locale } = useTranslation();
 const [sheetOpen, setSheetOpen] = useState(false);
 const [sheetEverOpened, setSheetEverOpened] = useState(false);
 const [showFullResults, setShowFullResults] = useState(false);
 const [fullResultsEverShown, setFullResultsEverShown] = useState(false);
 const [analysisFocus, setAnalysisFocus] = useState<'CH' | 'IT' | null>(null);
 const [pendingFocusField, setPendingFocusField] = useState<'age' | 'maritalStatus' | 'children' | null>(null);
 const [focusRequestId, setFocusRequestId] = useState(0);
 const [showNewsletterGate, setShowNewsletterGate] = useState(false);
 const [gateEmail, setGateEmail] = useState('');
 const [gateStatus, setGateStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
 const pendingAnalysisAction = useRef<(() => void) | null>(null);
 const sheetRef = useRef<HTMLDivElement>(null);
 const backdropRef = useRef<HTMLDivElement>(null);
 const { user: authUser, signIn: googleSignIn } = useAuth();
 const [linkedInAvailable, setLinkedInAvailable] = useState(false);
 const [gateGoogleButtonReady, setGateGoogleButtonReady] = useState(false);
 const gateGoogleButtonRef = useRef<HTMLDivElement>(null);

 // Format number for salary input
 const formatNumber = (val: number) => val === 0 ? '' : val.toLocaleString('it-IT');
 const parseNumber = (val: string) => {
 const clean = val.replace(/\./g, '').replace(/[^0-9]/g, '');
 return clean === '' ? 0 : Math.min(1_000_000, parseInt(clean, 10));
 };

 const handleChange = useCallback((field: keyof SimulationInputs, value: any) => {
 setInputs(prev => ({ ...prev, [field]: value }));
 }, [setInputs]);

 // Track first open for deferred rendering
 const openSheet = useCallback((focusField?: 'age' | 'maritalStatus' | 'children') => {
 if (focusField) {
 setPendingFocusField(focusField);
 setFocusRequestId(prev => prev + 1);
 }
 setSheetEverOpened(true);
 setSheetOpen(true);
 }, []);

 const shouldShowGate = useCallback(() => {
 if (typeof window === 'undefined') return false;
 if (localStorage.getItem(SUBSCRIBED_KEY) === 'true') return false;
 if (localStorage.getItem(NEWSLETTER_GATE_DISMISSED_KEY) === 'true') return false;
 if (fullResultsEverShown) return false;
 if (authUser) return false;
 return true;
 }, [fullResultsEverShown, authUser]);

 const proceedToAnalysis = useCallback((action: () => void) => {
 if (shouldShowGate()) {
 pendingAnalysisAction.current = action;
 setShowNewsletterGate(true);
 Analytics.trackEvent('newsletter_gate_shown', { source: 'full_analysis' });
 } else {
 action();
 }
 }, [shouldShowGate]);

 const dismissGate = useCallback(() => {
 setShowNewsletterGate(false);
 localStorage.setItem(NEWSLETTER_GATE_DISMISSED_KEY, 'true');
 Analytics.trackEvent('newsletter_gate_dismissed', { source: 'full_analysis' });
 pendingAnalysisAction.current?.();
 pendingAnalysisAction.current = null;
 }, []);

 const handleGateSubscribe = useCallback(async () => {
 const email = gateEmail.trim().toLowerCase();
 if (!email || !email.includes('@')) return;
 setGateStatus('loading');
 try {
 const [
 { getFirestore }, { getApp },
 { unlockAchievement },
 ] = await Promise.all([
 import('firebase/firestore'),
 import('@/services/firebase'),
 import('@/services/gamificationService'),
 ]);
 const db = getFirestore(await getApp());
 await upsertNewsletterSubscriber(db, { email, source: 'analysis_gate' });
 await requestConfirmationEmail(email);
 markNewsletterSubscribedLocally();
 unlockAchievement('newsletter_subscriber');
 Analytics.trackEvent('newsletter_gate_subscribed', { source: 'full_analysis' });
 setGateStatus('success');
 setTimeout(() => {
 setShowNewsletterGate(false);
 pendingAnalysisAction.current?.();
 pendingAnalysisAction.current = null;
 }, 1500);
 } catch {
 setGateStatus('error');
 }
 }, [gateEmail]);

 useEffect(() => { isLinkedInSignInAvailable().then(setLinkedInAvailable).catch(() => {}); }, []);

 useEffect(() => {
 if (!showNewsletterGate || authUser || gateStatus === 'success') {
 if (gateGoogleButtonRef.current) gateGoogleButtonRef.current.innerHTML = '';
 setGateGoogleButtonReady(false);
 return;
 }
 let cancelled = false;
 const timer = setTimeout(async () => {
 if (!gateGoogleButtonRef.current || cancelled) return;
 try {
 const ready = await renderGoogleButtonWithReadiness(gateGoogleButtonRef.current, {
 theme: 'outline', size: 'large', text: 'continue_with', width: 280, locale,
 });
 if (!cancelled) setGateGoogleButtonReady(ready);
 } catch {
 if (!cancelled) setGateGoogleButtonReady(false);
 }
 }, 100);
 return () => { cancelled = true; clearTimeout(timer); };
 }, [showNewsletterGate, authUser, gateStatus, locale]);

 useEffect(() => {
 if (!authUser || !showNewsletterGate) return;
 markNewsletterSubscribedLocally();
 Analytics.trackEvent('newsletter_gate_subscribed', { source: 'full_analysis', method: 'social' });
 setGateStatus('success');
 setTimeout(() => {
 setShowNewsletterGate(false);
 pendingAnalysisAction.current?.();
 pendingAnalysisAction.current = null;
 }, 800);
 }, [authUser, showNewsletterGate]);

 const toggleFullResults = useCallback(() => {
 const action = () => {
 setShowFullResults(prev => {
 if (!prev) {
 setFullResultsEverShown(true);
 setAnalysisFocus(null);
 }
 return !prev;
 });
 };
 if (!showFullResults) {
 proceedToAnalysis(action);
 } else {
 action();
 }
 }, [showFullResults, proceedToAnalysis]);

 const openFullAnalysisFocused = useCallback((focus: 'CH' | 'IT') => {
 proceedToAnalysis(() => {
 setAnalysisFocus(focus);
 setFullResultsEverShown(true);
 setShowFullResults(true);
 });
 }, [proceedToAnalysis]);

 // Lock body scroll when sheet is open
 useEffect(() => {
 if (sheetOpen) {
 document.body.style.overflow = 'hidden';
 } else {
 document.body.style.overflow = '';
 }
 return () => { document.body.style.overflow = ''; };
 }, [sheetOpen]);

 const isBetterIT = result ? result.savingsCHF > 0 : null; // savingsCHF > 0 means frontaliere is better
 const savingsMonthly = result ? Math.abs(result.savingsEUR / (result.monthsBasis || 12)) : 0;
 const chNetMonthly = result ? (result.chResident.swissNetIncomeMonthlyCHF ?? result.chResident.netIncomeMonthly) : null;
 const itNetMonthly = result ? result.itResident.netIncomeMonthly : null;
 const chDelta = useNetDelta(chNetMonthly);
 const itDelta = useNetDelta(itNetMonthly);

 return (
 <div className="space-y-4 pb-3">
 {/* ─── SECTION 1: Compact Input ─── */}
 <div className="bg-surface rounded-2xl shadow-lg border border-edge overflow-hidden">
 {/* Salary */}
 <div className="p-4 pb-3.5">
 <label htmlFor="mc-salary" className="text-xs font-bold text-muted uppercase tracking-wider flex items-center gap-1.5 mb-2">
 <Coins size={12} className="text-warning" />
 {t('mobileCalc.salary')}
 </label>
 <div className="flex items-stretch gap-2">
 <button
 onClick={() => handleChange('annualIncomeCHF', Math.max(SALARY_MIN, inputs.annualIncomeCHF - 5000))}
 className="w-12 shrink-0 flex items-center justify-center rounded-xl bg-surface-raised border-2 border-edge text-subtle text-xl font-bold hover:bg-surface-raised active:scale-95 transition-[color,background-color,transform]"
 aria-label="Diminuisci stipendio di 5000"
 type="button"
 >−</button>
 <div className="relative flex-1">
 <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
 <span className="text-muted font-bold text-base">CHF</span>
 </div>
 <input
 id="mc-salary"
 type="text"
 inputMode="numeric"
 value={formatNumber(inputs.annualIncomeCHF)}
 onChange={(e) => handleChange('annualIncomeCHF', parseNumber(e.target.value))}
 className="w-full pl-14 pr-3 py-3.5 bg-surface-alt border-2 border-edge rounded-xl focus-visible:ring-4 focus-visible:border-accent focus-visible:ring-accent/10 outline-none transition-[color,border-color,box-shadow] font-bold text-strong text-2xl tracking-tight text-center"
 placeholder="0"
 />
 </div>
 <button
 onClick={() => handleChange('annualIncomeCHF', Math.min(SALARY_MAX, inputs.annualIncomeCHF + 5000))}
 className="w-12 shrink-0 flex items-center justify-center rounded-xl bg-surface-raised border-2 border-edge text-subtle text-xl font-bold hover:bg-surface-raised active:scale-95 transition-[color,background-color,transform]"
 aria-label="Aumenta stipendio di 5000"
 type="button"
 >+</button>
 </div>
 {/* Quick salary pills — flex-wrap + overflow-hidden shows only what fits in one row */}
 <div className="flex flex-wrap gap-1.5 mt-2.5 pb-0.5 max-h-[28px] overflow-hidden">
 {SALARY_PRESETS.map(s => (
 <button
 key={s}
 onClick={() => handleChange('annualIncomeCHF', s)}
 className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-bold transition-colors ${
 inputs.annualIncomeCHF === s
 ? 'bg-accent-strong text-on-accent shadow-sm'
 : 'bg-surface-raised text-muted hover:bg-surface-raised'
 }`}
 >
 {(s / 1000)}k
 </button>
 ))}
 </div>
 </div>

 {/* Frontier type toggle */}
 <div className="px-4 pb-4">
 <label className="text-xs font-bold text-muted uppercase tracking-wider flex items-center gap-1.5 mb-2">
 <TrainFront size={12} className="text-success" />
 {t('input.frontierType')}
 </label>
 <div className="grid grid-cols-2 gap-2.5">
 <button
 onClick={() => { handleChange('frontierWorkerType', 'NEW'); handleChange('distanceZone', 'WITHIN_20KM'); }}
 className={`relative p-2.5 rounded-xl border-2 transition-[color,background-color,border-color] flex flex-col items-center gap-0.5 ${
 inputs.frontierWorkerType === 'NEW'
 ? 'border-accent bg-accent-subtle'
 : 'border-edge bg-surface-alt'
 }`}
 >
 {inputs.frontierWorkerType === 'NEW' && (
 <div className="absolute top-1.5 right-1.5 bg-accent-strong text-on-accent rounded-full p-0.5"><Check size={8} strokeWidth={4} /></div>
 )}
 <span className={`font-bold text-xs ${inputs.frontierWorkerType === 'NEW' ? 'text-accent' : 'text-subtle'}`}>
 {t('input.newFrontier')}
 </span>
 <span className="text-sm text-muted font-medium">{t('input.postDate')}</span>
 </button>
 <button
 onClick={() => handleChange('frontierWorkerType', 'OLD')}
 className={`relative p-2.5 rounded-xl border-2 transition-[color,background-color,border-color] flex flex-col items-center gap-0.5 ${
 inputs.frontierWorkerType === 'OLD'
 ? 'border-success bg-success-subtle'
 : 'border-edge bg-surface-alt'
 }`}
 >
 {inputs.frontierWorkerType === 'OLD' && (
 <div className="absolute top-1.5 right-1.5 bg-success-strong text-on-accent rounded-full p-0.5"><Check size={8} strokeWidth={4} /></div>
 )}
 <span className={`font-bold text-xs ${inputs.frontierWorkerType === 'OLD' ? 'text-success' : 'text-subtle'}`}>
 {t('input.oldFrontier')}
 </span>
 <span className="text-sm text-muted font-medium">{t('input.preDate')}</span>
 </button>
 </div>
 {/* Distance zone for NEW */}
 {inputs.frontierWorkerType === 'NEW' && (
 <div className="flex bg-surface-raised p-1 rounded-xl mt-2.5">
 {[
 { label: t('input.within20km'), value: 'WITHIN_20KM' },
 { label: t('input.over20km'), value: 'OVER_20KM' },
 ].map(opt => (
 <button
 key={opt.value}
 onClick={() => handleChange('distanceZone', opt.value)}
 className={`flex-1 flex items-center justify-center gap-1 text-xs font-bold py-2 rounded-lg transition-[color,background-color,box-shadow] ${
 inputs.distanceZone === opt.value
 ? 'text-accent bg-surface shadow-sm'
 : 'text-subtle'
 }`}
 >
 <Ruler size={10} />
 {opt.label}
 </button>
 ))}
 </div>
 )}
 </div>
 </div>

 {/* ─── SECTION 2: Instant Result Card ─── */}
 {result && (
 <div className={`rounded-2xl shadow-lg border overflow-hidden transition-colors duration-300 ${
 isBetterIT
 ? 'bg-gradient-to-br from-success-subtle to-surface border-success-border'
 : 'bg-gradient-to-br from-accent-subtle to-surface border-accent-border'
 }`}>
 {/* Verdict banner */}
 <div className={`px-4 py-3 flex items-center gap-3 ${
 isBetterIT
 ? 'bg-success'
 : 'bg-accent'
 }`}>
 <div className="p-1.5 bg-on-accent/20 rounded-lg">
 {isBetterIT
 ? <TrendingUp size={20} className="text-on-accent" />
 : <TrendingDown size={20} className="text-on-accent" />
 }
 </div>
 <div className="flex-1">
 <div className="text-on-accent font-bold text-sm tracking-tight">
 {isBetterIT ? t('mobileCalc.betterIT') : t('mobileCalc.betterCH')}
 </div>
 <div className="text-on-accent/80 text-xs font-bold">
 {t('mobileCalc.savings')}: +€{formatEUR(savingsMonthly)}{t('mobileCalc.perMonth')}
 </div>
 </div>
 </div>

 {/* Side-by-side comparison */}
 <div className="p-4">
 <div className="grid grid-cols-2 gap-3">
 {/* CH */}
 <button
 type="button"
 onClick={() => openFullAnalysisFocused('CH')}
 className={`w-full text-left p-3 rounded-xl transition-[color,background-color,transform] active:scale-[0.99] ${
 !isBetterIT
 ? 'bg-accent-subtle ring-2 ring-accent'
 : 'bg-surface/60 hover:bg-accent-subtle'
 }`}
 aria-label={`${t('mobileCalc.viewFullAnalysis')} (${t('mobileCalc.liveInCH')})`}
 >
 <div className="flex items-center gap-1.5 mb-1.5">
 <Home size={13} className="text-link" />
 <span className="text-xs font-bold text-subtle uppercase">{t('mobileCalc.liveInCH')}</span>
 </div>
 <div className="flex flex-wrap items-center gap-1.5">
 <div className="text-lg font-bold text-strong tracking-tight">
 CHF {formatCHF(chNetMonthly ?? 0)}
 </div>
 {chDelta.key > 0 && (
 <InlineNetDeltaBadge key={`ch-${chDelta.key}`} delta={chDelta.delta} size="mobile" />
 )}
 </div>
 <div className="text-xs text-muted font-semibold">{t('mobileCalc.perMonth')}</div>
 </button>

 {/* IT Frontaliere */}
 <button
 type="button"
 onClick={() => openFullAnalysisFocused('IT')}
 className={`w-full text-left p-3 rounded-xl transition-[color,background-color,transform] active:scale-[0.99] ${
 isBetterIT
 ? 'bg-success-subtle ring-2 ring-success-border'
 : 'bg-surface/60 hover:bg-success-subtle'
 }`}
 aria-label={`${t('mobileCalc.viewFullAnalysis')} (${t('mobileCalc.crossBorderIT')})`}
 >
 <div className="flex items-center gap-1.5 mb-1.5">
 <Briefcase size={13} className="text-success" />
 <span className="text-xs font-bold text-subtle uppercase">{t('mobileCalc.crossBorderIT')}</span>
 </div>
 <div className="flex flex-wrap items-center gap-1.5">
 <div className="text-lg font-bold text-strong tracking-tight">
 CHF {formatCHF(itNetMonthly ?? 0)}
 </div>
 {itDelta.key > 0 && (
 <InlineNetDeltaBadge key={`it-${itDelta.key}`} delta={itDelta.delta} size="mobile" />
 )}
 </div>
 <div className="text-xs text-muted font-semibold">{t('mobileCalc.perMonth')}</div>
 </button>
 </div>

 {/* Action buttons */}
 <div className="flex gap-2 mt-3">
 <button
 onClick={toggleFullResults}
 className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-[color,background-color,transform] active:scale-95 ${
 isBetterIT
 ? 'bg-success-strong hover:bg-success-strong-hover text-on-accent shadow-lg shadow-success-strong/20'
 : 'bg-accent hover:bg-accent-hover text-on-accent shadow-lg shadow-accent/20'
 }`}
 >
 {showFullResults ? <ChevronUp size={14} className="inline mr-1" /> : <ArrowDown size={14} className="inline mr-1" />}
 {t('mobileCalc.viewFullAnalysis')}
 </button>
 <button
 onClick={openSheet}
 className="px-4 py-2.5 rounded-xl text-xs font-bold bg-surface-raised text-subtle border border-edge hover:bg-surface-raised transition-[color,background-color,transform] active:scale-95"
 aria-label={t('mobileCalc.customize')}
 >
 <Settings2 size={16} />
 </button>
 </div>
 </div>
 </div>
 )}

 {/* Customize hint (when no sheet open and no full results) */}
 {result && !showFullResults && !sheetOpen && (
 <button
 onClick={openSheet}
 className="w-full flex items-center justify-center gap-2 py-2 text-xs font-semibold text-muted hover:text-body transition-colors"
 >
 <Settings2 size={12} />
 {t('mobileCalc.adjustParams')}
 </button>
 )}

 {/* Shareable result card + Newsletter CTA (only when full results are collapsed) */}
 {result && !showFullResults && (
 <>
 <Suspense fallback={<div className="min-h-[120px]" />}>
 <ShareableResultCard
 title={t('results.shareTitle') || 'Simulazione Stipendio Netto'}
 subtitle={`${inputs.annualIncomeCHF?.toLocaleString('it-IT') || '0'} CHF/anno`}
 rows={[
 { label: t('results.net.chf') || 'Netto CH (CHF)', value: `CHF ${formatCurrency(result.chResident.netIncomeAnnual)}`, highlight: true, color: 'blue' },
 { label: t('results.net.eur') || 'Netto IT (EUR)', value: `€ ${formatCurrency(Math.round(result.itResident.netIncomeAnnual * result.exchangeRate))}`, highlight: true, color: 'emerald' },
 { label: t('results.taxes.ch') || 'Imposte CH', value: `CHF ${formatCurrency(Math.abs(result.chResident.taxes))}` },
 { label: t('results.taxes.it') || 'Imposte IT', value: `€ ${formatCurrency(Math.abs(Math.round(result.itResident.taxes * result.exchangeRate)))}` },
 ]}
 accent="blue"
 context="salary-simulation-mobile"
 />
 </Suspense>
 <Suspense fallback={<div className="min-h-[60px]" />}>
 <SubscriptionCTA />
 </Suspense>
 </>
 )}

 {/* ─── SECTION 3: Full ResultsView (deferred — JS loads on first open) ─── */}
 {fullResultsEverShown && result && (
 <div className={`animate-fade-in ${showFullResults ? '' : 'hidden'}`}>
 {renderResultView?.(analysisFocus, openSheet)}
 </div>
 )}

 {/* ─── Newsletter Gate Modal (FRO-31) ─── */}
 {showNewsletterGate && (
 <>
 <div className="fixed inset-0 bg-black/50 z-[70] animate-fade-in" role="button" tabIndex={0} onClick={dismissGate} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dismissGate(); } }} aria-label="Chiudi modale" />
 <div role="dialog" aria-modal="true" aria-label={t('newsletterGate.title') || 'Iscriviti alla newsletter'} className="fixed inset-x-4 top-1/2 -translate-y-1/2 z-[71] bg-surface rounded-2xl shadow-2xl max-w-sm mx-auto overflow-hidden animate-fade-in">
 <div className="bg-gradient-to-r from-info-strong to-success-strong px-5 py-4 text-center">
 <Mail size={28} className="text-on-accent mx-auto mb-2" />
 <h3 className="text-on-accent font-bold font-display text-lg">{t('newsletterGate.title')}</h3>
 <p className="text-on-accent/80 text-xs mt-1">{t('newsletterGate.subtitle')}</p>
 </div>
 <div className="p-5 space-y-3">
 <div className="space-y-2 text-sm text-subtle">
 <div className="flex items-start gap-2">
 <TrendingUp size={14} className="text-accent mt-0.5 shrink-0" />
 <span>{t('newsletterGate.benefit1')}</span>
 </div>
 <div className="flex items-start gap-2">
 <Briefcase size={14} className="text-success mt-0.5 shrink-0" />
 <span>{t('newsletterGate.benefit2', getCantonI18nParams())}</span>
 </div>
 <div className="flex items-start gap-2">
 <Coins size={14} className="text-warning mt-0.5 shrink-0" />
 <span>{t('newsletterGate.benefit3')}</span>
 </div>
 </div>
 {gateStatus === 'success' ? (
 <div className="flex items-center justify-center gap-2 py-3 text-success font-semibold text-sm">
 <CheckCircle2 size={18} />
 {t('newsletterGate.success')}
 </div>
 ) : (
 <>
 <div className="space-y-2">
 <div ref={gateGoogleButtonRef} className="flex min-h-[44px] w-full items-center justify-center overflow-hidden rounded-xl" />
 {!gateGoogleButtonReady && (
 <button type="button" onClick={() => googleSignIn()} className="w-full min-h-[40px] grid grid-cols-[20px_1fr_20px] items-center px-4 py-2 bg-surface border border-edge rounded-xl text-body text-xs font-semibold hover:bg-surface-raised transition-colors">
 <svg viewBox="0 0 24 24" className="w-4 h-4" aria-hidden="true"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
 <span className="text-center">{t('newsletter.popup.googleSignIn')}</span>
 <span aria-hidden="true" />
 </button>
 )}
 {linkedInAvailable && (
 <button type="button" onClick={() => signInWithLinkedIn()} className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[#0A66C2] hover:bg-[#004182] text-on-accent text-sm font-semibold transition-colors">
 <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>
 {locale === 'it' ? 'Continua con LinkedIn' : locale === 'de' ? 'Mit LinkedIn fortfahren' : locale === 'fr' ? 'Continuer avec LinkedIn' : 'Continue with LinkedIn'}
 </button>
 )}
 </div>
 <div className="flex items-center gap-3">
 <div className="flex-1 h-px bg-surface-raised" />
 <span className="text-xs text-muted">{locale === 'it' ? 'oppure con email' : locale === 'de' ? 'oder per E-Mail' : locale === 'fr' ? 'ou par email' : 'or by email'}</span>
 <div className="flex-1 h-px bg-surface-raised" />
 </div>
 <div className="flex gap-2">
 <input
 type="email"
 value={gateEmail}
 onChange={(e) => setGateEmail(e.target.value)}
 placeholder={t('newsletter.emailPlaceholder')}
 className="flex-1 px-3 py-2.5 rounded-lg border border-edge bg-surface-alt text-sm text-strong focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-transparent outline-none"
 aria-label={t('newsletter.emailPlaceholder')}
 onKeyDown={(e) => e.key === 'Enter' && handleGateSubscribe()}
 />
 </div>
 <button
 onClick={handleGateSubscribe}
 disabled={gateStatus === 'loading' || !gateEmail.includes('@')}
 className="w-full py-2.5 rounded-xl text-sm font-bold bg-accent hover:bg-accent-hover text-on-accent transition-[color,background-color,opacity] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
 >
 {gateStatus === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
 {t('newsletterGate.subscribe')}
 </button>
 {gateStatus === 'error' && (
 <p className="text-xs text-danger text-center">{t('newsletterGate.error')}</p>
 )}
 </>
 )}
 <button
 onClick={dismissGate}
 className="w-full text-center text-xs text-muted hover:text-body py-1"
 >
 {t('newsletterGate.skip')}
 </button>
 </div>
 </div>
 </>
 )}

 {/* ─── BOTTOM SHEET: Full InputCard ─── */}
 {/* Backdrop */}
 <div
 ref={backdropRef}
 onClick={() => setSheetOpen(false)}
 className={`fixed inset-0 bg-black/40 z-[60] transition-opacity duration-300 ${
 sheetOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
 }`}
 />

 {/* Sheet */}
 <div
 ref={sheetRef}
 className={`fixed inset-x-0 bottom-0 z-[70] transition-transform duration-500 ease-out ${
 sheetOpen ? 'translate-y-0' : 'translate-y-full'
 }`}
 style={{ maxHeight: '85vh' }}
 >
 <div className="bg-surface rounded-t-3xl shadow-2xl border-t border-edge flex flex-col" style={{ maxHeight: '85vh' }}>
 {/* Handle + header */}
 <div className="flex-shrink-0 pt-3 pb-2 px-4">
 <div className="w-10 h-1 bg-surface-raised rounded-full mx-auto mb-3" />
 <div className="flex items-center justify-between">
 <h3 className="text-sm font-bold text-strong flex items-center gap-2">
 <Settings2 size={16} className="text-link" />
 {t('mobileCalc.customize')}
 </h3>
 <button
 onClick={() => setSheetOpen(false)}
 className="px-3 py-1.5 rounded-lg text-xs font-bold bg-surface-raised text-subtle hover:bg-surface-raised transition-colors"
 >
 {t('mobileCalc.close')}
 </button>
 </div>
 </div>

 {/* Scrollable content — InputCard rendered only after first sheet open */}
 <div className="flex-1 overflow-y-auto overscroll-contain px-2 pb-8">
 {sheetEverOpened && renderInputCard?.(pendingFocusField, focusRequestId)}
 </div>
 </div>
 </div>
 </div>
 );
};

export default MobileCalcLayout;
