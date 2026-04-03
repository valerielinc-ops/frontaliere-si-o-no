import React, { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { Coins, TrainFront, Check, ChevronUp, ArrowDown, Settings2, Home, Briefcase, TrendingUp, TrendingDown, Ruler, Mail, X, Loader2, CheckCircle2 } from 'lucide-react';
import { SimulationInputs, SimulationResult } from '../../types';
import { useTranslation } from '../../services/i18n';
import { lazyRetry } from '@/services/lazyRetry';
import { Analytics } from '@/services/analytics';
import { upsertNewsletterSubscriber, requestConfirmationEmail, markNewsletterSubscribedLocally } from '@/services/newsletterSubscribers';
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
 *  1. Compact salary input + frontier type selector (always visible, ~1 screen)
 *  2. Results card (auto-calculated, immediately visible)
 *  3. "Customize" button → slides up a bottom sheet with the full InputCard
 *
 * The bottom sheet uses CSS transforms for a smooth native-app-like feel.
 */
const MobileCalcLayout: React.FC<Props> = ({
  inputs, setInputs, onCalculate, result, renderResultView, renderInputCard,
}) => {
  const { t } = useTranslation();
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
    return true;
  }, [fullResultsEverShown]);

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
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-lg border border-slate-200/80 dark:border-slate-800 overflow-hidden">
        {/* Salary */}
        <div className="p-4 pb-3.5">
          <label htmlFor="mc-salary" className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1.5 mb-2">
            <Coins size={12} className="text-amber-500" />
            {t('mobileCalc.salary')}
          </label>
          <div className="flex items-stretch gap-2">
            <button
              onClick={() => handleChange('annualIncomeCHF', Math.max(SALARY_MIN, inputs.annualIncomeCHF - 5000))}
              className="w-12 shrink-0 flex items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 border-2 border-slate-100 dark:border-slate-700 text-slate-600 dark:text-slate-400 text-xl font-bold hover:bg-slate-200 dark:hover:bg-slate-700 active:scale-95 transition-[color,background-color,transform]"
              aria-label="Diminuisci stipendio di 5000"
              type="button"
            >−</button>
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <span className="text-slate-500 dark:text-slate-600 font-bold text-base">CHF</span>
              </div>
              <input
                id="mc-salary"
                type="text"
                inputMode="numeric"
                value={formatNumber(inputs.annualIncomeCHF)}
                onChange={(e) => handleChange('annualIncomeCHF', parseNumber(e.target.value))}
                className="w-full pl-14 pr-3 py-3.5 bg-slate-50 dark:bg-slate-800 border-2 border-slate-100 dark:border-slate-700 rounded-xl focus:ring-4 focus:border-blue-500 focus:ring-blue-500/10 outline-none transition-[color,border-color,box-shadow] font-bold text-slate-800 dark:text-slate-100 text-2xl tracking-tight text-center"
                placeholder="0"
              />
            </div>
            <button
              onClick={() => handleChange('annualIncomeCHF', Math.min(SALARY_MAX, inputs.annualIncomeCHF + 5000))}
              className="w-12 shrink-0 flex items-center justify-center rounded-xl bg-slate-100 dark:bg-slate-800 border-2 border-slate-100 dark:border-slate-700 text-slate-600 dark:text-slate-400 text-xl font-bold hover:bg-slate-200 dark:hover:bg-slate-700 active:scale-95 transition-[color,background-color,transform]"
              aria-label="Aumenta stipendio di 5000"
              type="button"
            >+</button>
          </div>
          {/* Quick salary pills */}
          <div className="flex gap-1.5 mt-2.5 overflow-x-auto scrollbar-none pb-0.5">
            {SALARY_PRESETS.map(s => (
              <button
                key={s}
                onClick={() => handleChange('annualIncomeCHF', s)}
                className={`shrink-0 px-2.5 py-1 rounded-lg text-xs font-bold transition-colors ${
                  inputs.annualIncomeCHF === s
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200'
                }`}
              >
                {(s / 1000)}k
              </button>
            ))}
          </div>
        </div>

        {/* Frontier type toggle */}
        <div className="px-4 pb-4">
          <label className="text-xs font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider flex items-center gap-1.5 mb-2">
            <TrainFront size={12} className="text-emerald-600" />
            {t('input.frontierType')}
          </label>
          <div className="grid grid-cols-2 gap-2.5">
            <button
              onClick={() => { handleChange('frontierWorkerType', 'NEW'); handleChange('distanceZone', 'WITHIN_20KM'); }}
              className={`relative p-2.5 rounded-xl border-2 transition-[color,background-color,border-color] flex flex-col items-center gap-0.5 ${
                inputs.frontierWorkerType === 'NEW'
                  ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30'
                  : 'border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800'
              }`}
            >
              {inputs.frontierWorkerType === 'NEW' && (
                <div className="absolute top-1.5 right-1.5 bg-blue-500 text-white rounded-full p-0.5"><Check size={8} strokeWidth={4} /></div>
              )}
              <span className={`font-bold text-xs ${inputs.frontierWorkerType === 'NEW' ? 'text-blue-700 dark:text-blue-300' : 'text-slate-600 dark:text-slate-400'}`}>
                {t('input.newFrontier')}
              </span>
              <span className="text-[11px] text-slate-500 font-medium">{t('input.postDate')}</span>
            </button>
            <button
              onClick={() => handleChange('frontierWorkerType', 'OLD')}
              className={`relative p-2.5 rounded-xl border-2 transition-[color,background-color,border-color] flex flex-col items-center gap-0.5 ${
                inputs.frontierWorkerType === 'OLD'
                  ? 'border-emerald-500 bg-emerald-50 dark:bg-emerald-900/30'
                  : 'border-slate-100 dark:border-slate-700 bg-slate-50 dark:bg-slate-800'
              }`}
            >
              {inputs.frontierWorkerType === 'OLD' && (
                <div className="absolute top-1.5 right-1.5 bg-emerald-700 text-white rounded-full p-0.5"><Check size={8} strokeWidth={4} /></div>
              )}
              <span className={`font-bold text-xs ${inputs.frontierWorkerType === 'OLD' ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-600 dark:text-slate-400'}`}>
                {t('input.oldFrontier')}
              </span>
              <span className="text-[11px] text-slate-500 font-medium">{t('input.preDate')}</span>
            </button>
          </div>
          {/* Distance zone for NEW */}
          {inputs.frontierWorkerType === 'NEW' && (
            <div className="flex bg-slate-100 dark:bg-slate-800 p-1 rounded-xl mt-2.5">
              {[
                { label: t('input.within20km'), value: 'WITHIN_20KM' },
                { label: t('input.over20km'), value: 'OVER_20KM' },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => handleChange('distanceZone', opt.value)}
                  className={`flex-1 flex items-center justify-center gap-1 text-xs font-bold py-2 rounded-lg transition-[color,background-color,box-shadow] ${
                    inputs.distanceZone === opt.value
                      ? 'text-blue-700 dark:text-blue-300 bg-white dark:bg-slate-700 shadow-sm'
                      : 'text-slate-600 dark:text-slate-400'
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
            ? 'bg-gradient-to-br from-emerald-50 to-white dark:from-emerald-950/60 dark:to-slate-900 border-emerald-200 dark:border-emerald-800'
            : 'bg-gradient-to-br from-blue-50 to-white dark:from-blue-950/60 dark:to-slate-900 border-blue-200 dark:border-blue-800'
        }`}>
          {/* Verdict banner */}
          <div className={`px-4 py-3 flex items-center gap-3 ${
            isBetterIT
              ? 'bg-emerald-600 dark:bg-emerald-700'
              : 'bg-blue-600 dark:bg-blue-700'
          }`}>
            <div className="p-1.5 bg-white/20 dark:bg-slate-700/50 rounded-lg">
              {isBetterIT
                ? <TrendingUp size={20} className="text-white" />
                : <TrendingDown size={20} className="text-white" />
              }
            </div>
            <div className="flex-1">
              <div className="text-white font-bold text-sm tracking-tight">
                {isBetterIT ? t('mobileCalc.betterIT') : t('mobileCalc.betterCH')}
              </div>
              <div className="text-white/80 text-xs font-bold">
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
                    ? 'bg-blue-100/50 dark:bg-blue-900/30 ring-2 ring-blue-300 dark:ring-blue-700'
                    : 'bg-white/60 dark:bg-slate-800/60 hover:bg-blue-50/70 dark:hover:bg-blue-900/20'
                }`}
                aria-label={`${t('mobileCalc.viewFullAnalysis')} (${t('mobileCalc.liveInCH')})`}
              >
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Home size={13} className="text-blue-600 dark:text-blue-400" />
                  <span className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase">{t('mobileCalc.liveInCH')}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="text-lg font-bold text-slate-800 dark:text-slate-100 tracking-tight">
                    CHF {formatCHF(chNetMonthly ?? 0)}
                  </div>
                  {chDelta.key > 0 && (
                    <InlineNetDeltaBadge key={`ch-${chDelta.key}`} delta={chDelta.delta} size="mobile" />
                  )}
                </div>
                <div className="text-xs text-slate-500 font-semibold">{t('mobileCalc.perMonth')}</div>
              </button>

              {/* IT Frontaliere */}
              <button
                type="button"
                onClick={() => openFullAnalysisFocused('IT')}
                className={`w-full text-left p-3 rounded-xl transition-[color,background-color,transform] active:scale-[0.99] ${
                  isBetterIT
                    ? 'bg-emerald-100/50 dark:bg-emerald-900/30 ring-2 ring-emerald-300 dark:ring-emerald-700'
                    : 'bg-white/60 dark:bg-slate-800/60 hover:bg-emerald-50/70 dark:hover:bg-emerald-900/20'
                }`}
                aria-label={`${t('mobileCalc.viewFullAnalysis')} (${t('mobileCalc.crossBorderIT')})`}
              >
                <div className="flex items-center gap-1.5 mb-1.5">
                  <Briefcase size={13} className="text-emerald-600 dark:text-emerald-400" />
                  <span className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase">{t('mobileCalc.crossBorderIT')}</span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <div className="text-lg font-bold text-slate-800 dark:text-slate-100 tracking-tight">
                    CHF {formatCHF(itNetMonthly ?? 0)}
                  </div>
                  {itDelta.key > 0 && (
                    <InlineNetDeltaBadge key={`it-${itDelta.key}`} delta={itDelta.delta} size="mobile" />
                  )}
                </div>
                <div className="text-xs text-slate-500 font-semibold">{t('mobileCalc.perMonth')}</div>
              </button>
            </div>

            {/* Action buttons */}
            <div className="flex gap-2 mt-3">
              <button
                onClick={toggleFullResults}
                className={`flex-1 py-2.5 rounded-xl text-xs font-bold transition-[color,background-color,transform] active:scale-95 ${
                  isBetterIT
                    ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg shadow-emerald-500/20'
                    : 'bg-blue-600 hover:bg-blue-700 text-white shadow-lg shadow-blue-500/20'
                }`}
              >
                {showFullResults ? <ChevronUp size={14} className="inline mr-1" /> : <ArrowDown size={14} className="inline mr-1" />}
                {t('mobileCalc.viewFullAnalysis')}
              </button>
              <button
                onClick={openSheet}
                className="px-4 py-2.5 rounded-xl text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700 hover:bg-slate-200 dark:hover:bg-slate-700 transition-[color,background-color,transform] active:scale-95"
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
          className="w-full flex items-center justify-center gap-2 py-2 text-xs font-semibold text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-400 transition-colors"
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
          <div role="dialog" aria-modal="true" aria-label={t('newsletterGate.title') || 'Iscriviti alla newsletter'} className="fixed inset-x-4 top-1/2 -translate-y-1/2 z-[71] bg-white dark:bg-slate-800 rounded-2xl shadow-2xl max-w-sm mx-auto overflow-hidden animate-fade-in">
            <div className="bg-gradient-to-r from-blue-600 to-violet-600 px-5 py-4 text-center">
              <Mail size={28} className="text-white mx-auto mb-2" />
              <h3 className="text-white font-bold text-lg">{t('newsletterGate.title')}</h3>
              <p className="text-white/80 text-xs mt-1">{t('newsletterGate.subtitle')}</p>
            </div>
            <div className="p-5 space-y-3">
              <div className="space-y-2 text-sm text-slate-600 dark:text-slate-400">
                <div className="flex items-start gap-2">
                  <TrendingUp size={14} className="text-blue-600 mt-0.5 shrink-0" />
                  <span>{t('newsletterGate.benefit1')}</span>
                </div>
                <div className="flex items-start gap-2">
                  <Briefcase size={14} className="text-emerald-600 mt-0.5 shrink-0" />
                  <span>{t('newsletterGate.benefit2')}</span>
                </div>
                <div className="flex items-start gap-2">
                  <Coins size={14} className="text-amber-600 mt-0.5 shrink-0" />
                  <span>{t('newsletterGate.benefit3')}</span>
                </div>
              </div>
              {gateStatus === 'success' ? (
                <div className="flex items-center justify-center gap-2 py-3 text-emerald-600 dark:text-emerald-400 font-semibold text-sm">
                  <CheckCircle2 size={18} />
                  {t('newsletterGate.success')}
                </div>
              ) : (
                <>
                  <div className="flex gap-2">
                    <input
                      type="email"
                      value={gateEmail}
                      onChange={(e) => setGateEmail(e.target.value)}
                      placeholder={t('newsletter.emailPlaceholder')}
                      className="flex-1 px-3 py-2.5 rounded-lg border border-slate-200 dark:border-slate-600 bg-slate-50 dark:bg-slate-700 text-sm text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none"
                      aria-label={t('newsletter.emailPlaceholder')}
                      onKeyDown={(e) => e.key === 'Enter' && handleGateSubscribe()}
                    />
                  </div>
                  <button
                    onClick={handleGateSubscribe}
                    disabled={gateStatus === 'loading' || !gateEmail.includes('@')}
                    className="w-full py-2.5 rounded-xl text-sm font-bold bg-blue-600 hover:bg-blue-700 text-white transition-[color,background-color,opacity] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
                  >
                    {gateStatus === 'loading' ? <Loader2 size={16} className="animate-spin" /> : <Mail size={16} />}
                    {t('newsletterGate.subscribe')}
                  </button>
                  {gateStatus === 'error' && (
                    <p className="text-xs text-red-500 text-center">{t('newsletterGate.error')}</p>
                  )}
                </>
              )}
              <button
                onClick={dismissGate}
                className="w-full text-center text-xs text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-300 py-1"
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
        <div className="bg-white dark:bg-slate-900 rounded-t-3xl shadow-2xl border-t border-slate-200 dark:border-slate-700 flex flex-col" style={{ maxHeight: '85vh' }}>
          {/* Handle + header */}
          <div className="flex-shrink-0 pt-3 pb-2 px-4">
            <div className="w-10 h-1 bg-slate-300 dark:bg-slate-600 rounded-full mx-auto mb-3" />
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                <Settings2 size={16} className="text-blue-600 dark:text-blue-400" />
                {t('mobileCalc.customize')}
              </h3>
              <button
                onClick={() => setSheetOpen(false)}
                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors"
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
