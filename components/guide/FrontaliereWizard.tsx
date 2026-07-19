/**
 * FrontaliereWizard — "Sei pronto a diventare frontaliere?"
 *
 * Qualification wizard: 7 questions (distance from the border, permit status,
 * job situation, family, sector, language, financial prep) → a readiness score
 * and a PERSONALIZED, ordered action plan whose steps each link to an existing
 * guide / comparator / calculator (≥5 internal links, all trailing-slash via
 * buildPath). Closes with an email-capture CTA (existing newsletter pipeline,
 * dedicated acquisitionSource) and a shareable result card.
 *
 * Pattern: components/guide/PermitQuiz.tsx + components/calculator/SalaryQuiz.tsx.
 * Standalone route: activeTab 'frontaliere-wizard'.
 */

import React, { useState, useCallback, useMemo, Suspense } from 'react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import { buildPath, type AppRoute, type ActiveTab } from '@/services/router';
import { useNavigationOptional } from '@/services/NavigationContext';
import { addXp } from '@/services/gamificationService';
import { lazyRetry } from '@/services/lazyRetry';
import {
 Compass, MapPin, FileCheck, Briefcase, Users, Languages, Wallet,
 ArrowLeft, ArrowRight, ChevronRight, RotateCcw, Sparkles, CheckCircle2,
 Calculator, Building2, Heart, Search, TrendingUp, Route as RouteIcon,
} from 'lucide-react';

const Newsletter = lazyRetry(() => import('@/components/community/Newsletter'));
const ShareableResultCard = lazyRetry(() => import('@/components/shared/ShareableResultCard'));

// ─── Types ──────────────────────────────────────────────────────────────

interface WizardOption {
 value: string;
 /** Readiness contribution 0 (agli inizi) … 3 (già pronto) for this answer. */
 score: number;
}

interface WizardQuestion {
 id: string;
 icon: typeof Compass;
 options: WizardOption[];
}

interface Answer {
 questionId: string;
 value: string;
 score: number;
}

type Tier = 'ready' | 'almost' | 'starting';

interface PlanStep {
 id: string;
 icon: typeof Compass;
 route: AppRoute;
 /** (tab, subTab) for SPA navigation via NavigationContext. */
 nav: [ActiveTab, string?];
 /**
  * Relevance given the current answers — higher floats to the top of the plan.
  * Every step is always shown (a full frontaliere roadmap), only the ORDER is
  * personalized, so the plan always carries ≥5 pertinent internal links.
  */
 priority: (a: Record<string, string>) => number;
}

// ─── Wizard configuration ─────────────────────────────────────────────────

const QUESTIONS: WizardQuestion[] = [
 {
 id: 'distance',
 icon: MapPin,
 options: [
 { value: 'border', score: 3 },
 { value: 'near', score: 2 },
 { value: 'far', score: 1 },
 { value: 'switzerland', score: 2 },
 ],
 },
 {
 id: 'permit',
 icon: FileCheck,
 options: [
 { value: 'have_g', score: 3 },
 { value: 'need_g', score: 1 },
 { value: 'have_offer_no_permit', score: 2 },
 { value: 'unsure', score: 0 },
 ],
 },
 {
 id: 'job',
 icon: Briefcase,
 options: [
 { value: 'have_offer', score: 3 },
 { value: 'interviewing', score: 2 },
 { value: 'searching', score: 1 },
 { value: 'exploring', score: 0 },
 ],
 },
 {
 id: 'family',
 icon: Users,
 options: [
 { value: 'single', score: 3 },
 { value: 'couple', score: 2 },
 { value: 'family_children', score: 1 },
 ],
 },
 {
 id: 'sector',
 icon: Briefcase,
 options: [
 { value: 'healthcare', score: 3 },
 { value: 'it_engineering', score: 3 },
 { value: 'finance', score: 2 },
 { value: 'construction_trades', score: 2 },
 { value: 'hospitality_retail', score: 1 },
 { value: 'other', score: 1 },
 ],
 },
 {
 id: 'language',
 icon: Languages,
 options: [
 { value: 'multilingual', score: 3 },
 { value: 'italian_plus', score: 2 },
 { value: 'italian_only', score: 1 },
 ],
 },
 {
 id: 'finance',
 icon: Wallet,
 options: [
 { value: 'ready', score: 3 },
 { value: 'partial', score: 2 },
 { value: 'not_yet', score: 0 },
 ],
 },
];

const MAX_SCORE = QUESTIONS.length * 3;

// Personalized action plan. Every step links an existing internal page.
const PLAN_STEPS: PlanStep[] = [
 {
 id: 'permit',
 icon: FileCheck,
 route: { activeTab: 'permit-quiz' },
 nav: ['permit-quiz'],
 priority: (a) => (a.permit === 'unsure' || a.permit === 'need_g' ? 100 : 40),
 },
 {
 id: 'job',
 icon: Search,
 route: { activeTab: 'job-board' },
 nav: ['job-board'],
 priority: (a) => (a.job === 'searching' || a.job === 'exploring' ? 95 : a.job === 'interviewing' ? 60 : 30),
 },
 {
 id: 'netSalary',
 icon: Calculator,
 route: { activeTab: 'calculator', calcolatoreSubTab: 'calculator' },
 nav: ['calculator', 'calculator'],
 priority: () => 80,
 },
 {
 id: 'salaryQuiz',
 icon: TrendingUp,
 route: { activeTab: 'calculator', calcolatoreSubTab: 'salary-quiz' },
 nav: ['calculator', 'salary-quiz'],
 priority: (a) => (a.job === 'exploring' || a.job === 'searching' ? 75 : 45),
 },
 {
 id: 'bank',
 icon: Building2,
 route: { activeTab: 'confronti', confrontiSubTab: 'banks' },
 nav: ['confronti', 'banks'],
 priority: (a) => (a.finance === 'not_yet' || a.finance === 'partial' ? 70 : 35),
 },
 {
 id: 'health',
 icon: Heart,
 route: { activeTab: 'confronti', confrontiSubTab: 'health' },
 nav: ['confronti', 'health'],
 priority: (a) => (a.family === 'family_children' || a.family === 'couple' ? 65 : 40),
 },
 {
 id: 'border',
 icon: RouteIcon,
 route: { activeTab: 'guida', guidaSubTab: 'border' },
 nav: ['guida', 'border'],
 priority: (a) => (a.distance === 'far' || a.distance === 'near' ? 60 : 25),
 },
 {
 id: 'firstDay',
 icon: CheckCircle2,
 route: { activeTab: 'guida', guidaSubTab: 'first-day' },
 nav: ['guida', 'first-day'],
 priority: (a) => (a.job === 'have_offer' ? 85 : 50),
 },
];

// ─── Component ──────────────────────────────────────────────────────────

const FrontaliereWizard: React.FC = () => {
 const { t, locale } = useTranslation();
 const nav = useNavigationOptional();
 const [currentStep, setCurrentStep] = useState(0);
 const [answers, setAnswers] = useState<Answer[]>([]);
 const [showResults, setShowResults] = useState(false);

 const totalQuestions = QUESTIONS.length;
 const progress = Math.round((currentStep / totalQuestions) * 100);

 const answerMap = useMemo(() => {
 const m: Record<string, string> = {};
 for (const a of answers) m[a.questionId] = a.value;
 return m;
 }, [answers]);

 const complete = useCallback((finalAnswers: Answer[]) => {
 setShowResults(true);
 addXp(20);
 Analytics.trackEvent('frontaliere_wizard_complete', { answered: finalAnswers.length });
 Analytics.trackUIInteraction('frontaliere_wizard', 'wizard', 'complete', `answers_${finalAnswers.length}`);
 }, []);

 const handleAnswer = useCallback((questionId: string, option: WizardOption) => {
 const newAnswers = [...answers.filter(a => a.questionId !== questionId), {
 questionId,
 value: option.value,
 score: option.score,
 }];
 setAnswers(newAnswers);
 Analytics.trackEvent('frontaliere_wizard_step', { step: currentStep + 1, question: questionId, answer: option.value });

 setTimeout(() => {
 if (currentStep < totalQuestions - 1) {
 setCurrentStep(prev => prev + 1);
 } else {
 complete(newAnswers);
 }
 }, 280);
 }, [answers, currentStep, totalQuestions, complete]);

 const goBack = useCallback(() => {
 if (currentStep > 0) setCurrentStep(prev => prev - 1);
 }, [currentStep]);

 const restart = useCallback(() => {
 setCurrentStep(0);
 setAnswers([]);
 setShowResults(false);
 }, []);

 const navigateStep = useCallback((e: React.MouseEvent<HTMLAnchorElement>, step: PlanStep) => {
 e.preventDefault();
 Analytics.trackSelectContent('frontaliere_wizard_plan', step.id);
 if (nav) {
 nav.navigateTo(step.nav[0], step.nav[1]);
 window.scrollTo({ top: 0, behavior: 'instant' });
 } else {
 window.location.href = e.currentTarget.getAttribute('href') || '/';
 }
 }, [nav]);

 // ─── Results ──────────────────────────────────────────────────────────

 const result = useMemo(() => {
 const total = answers.reduce((sum, a) => sum + a.score, 0);
 const percent = Math.round((total / MAX_SCORE) * 100);
 const tier: Tier = percent >= 70 ? 'ready' : percent >= 45 ? 'almost' : 'starting';
 const orderedPlan = [...PLAN_STEPS].sort((s1, s2) => s2.priority(answerMap) - s1.priority(answerMap));
 return { total, percent, tier, orderedPlan };
 }, [answers, answerMap]);

 if (showResults) {
 const { percent, tier, orderedPlan } = result;
 const tierSemantic = tier === 'ready' ? 'success' : tier === 'almost' ? 'info' : 'warning';

 return (
 <div className="max-w-2xl mx-auto">
 {/* Header */}
 <div className="text-center mb-8">
 <h2 className="text-2xl font-bold font-display text-strong flex items-center justify-center gap-3">
 <Sparkles size={24} className="text-warning" />
 {t('frontaliereWizard.results.title')}
 </h2>
 <p className="text-subtle mt-2">{t('frontaliereWizard.results.subtitle')}</p>
 </div>

 {/* Readiness score */}
 <div className={`bg-${tierSemantic}-subtle border border-${tierSemantic}-border rounded-2xl p-4 sm:p-6 mb-6`}>
 <div className="flex items-center justify-between mb-2">
 <span className="font-semibold text-body">{t('frontaliereWizard.results.scoreLabel')}</span>
 <span className={`text-2xl font-bold text-${tierSemantic}`}>{percent}%</span>
 </div>
 <div className="h-4 bg-surface-raised rounded-full overflow-hidden mb-4">
 <div
 className={`h-full bg-gradient-to-r from-${tierSemantic}-strong to-${tierSemantic}-strong rounded-full transition-transform duration-1000 origin-left [transform:var(--sx)]`}
 style={{ ['--sx']: `scaleX(${percent / 100})` } as React.CSSProperties}
 />
 </div>
 <div className="flex items-start gap-3">
 <div className={`w-10 h-10 rounded-xl bg-${tierSemantic}-subtle flex items-center justify-center shrink-0`}>
 <CheckCircle2 size={20} className={`text-${tierSemantic}`} />
 </div>
 <div>
 <h3 className="font-bold font-display text-lg text-strong">{t(`frontaliereWizard.results.tier.${tier}.title`)}</h3>
 <p className="text-subtle mt-1 text-sm">{t(`frontaliereWizard.results.tier.${tier}.desc`)}</p>
 </div>
 </div>
 </div>

 {/* Personalized plan */}
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 mb-6">
 <h3 className="font-bold font-display text-lg text-strong mb-1 flex items-center gap-2">
 <Compass size={18} className="text-accent" />
 {t('frontaliereWizard.results.planTitle')}
 </h3>
 <p className="text-sm text-subtle mb-4">{t('frontaliereWizard.results.planSubtitle')}</p>
 <ol className="space-y-2 list-none p-0 m-0">
 {orderedPlan.map((step, i) => {
 const Icon = step.icon;
 return (
 <li key={step.id}>
 <a
 href={buildPath(step.route, locale)}
 onClick={(e) => navigateStep(e, step)}
 className="flex items-center gap-3 px-3 py-3 rounded-xl border border-edge hover:border-accent hover:bg-accent-subtle transition-colors no-underline group"
 >
 <span className="w-7 h-7 rounded-full bg-surface-raised text-subtle text-sm font-bold flex items-center justify-center shrink-0 group-hover:bg-accent group-hover:text-on-accent transition-colors">{i + 1}</span>
 <span className="w-9 h-9 rounded-lg bg-accent-subtle flex items-center justify-center shrink-0">
 <Icon size={18} className="text-accent" />
 </span>
 <span className="min-w-0 flex-grow">
 <span className="block text-sm font-semibold text-body group-hover:text-accent">{t(`frontaliereWizard.step.${step.id}.title`)}</span>
 <span className="block text-xs text-muted line-clamp-1">{t(`frontaliereWizard.step.${step.id}.desc`)}</span>
 </span>
 <ChevronRight size={18} className="text-muted group-hover:text-accent shrink-0" />
 </a>
 </li>
 );
 })}
 </ol>
 </div>

 {/* Email capture — existing newsletter pipeline, dedicated acquisitionSource */}
 <div className="mb-6">
 <Suspense fallback={<div className="min-h-[168px] rounded-2xl bg-surface-raised animate-pulse" />}>
 <Newsletter
 compact
 acquisitionSource="frontaliere_wizard"
 headingOverride={t('frontaliereWizard.email.title')}
 subtitleOverride={t('frontaliereWizard.email.subtitle')}
 />
 </Suspense>
 </div>

 {/* Shareable result card */}
 <div className="mb-2">
 <p className="text-sm font-semibold text-body mb-2 flex items-center gap-2">
 <Sparkles size={16} className="text-warning" />
 {t('frontaliereWizard.shareTitle')}
 </p>
 <Suspense fallback={null}>
 <ShareableResultCard
 title={t('frontaliereWizard.title')}
 subtitle={t(`frontaliereWizard.results.tier.${tier}.title`)}
 rows={[
 { label: t('frontaliereWizard.results.scoreLabel'), value: `${percent}%`, highlight: true, color: 'emerald' },
 { label: t('frontaliereWizard.results.planTitle'), value: `${orderedPlan.length}`, color: 'blue' },
 ]}
 accent="emerald"
 context="frontaliere-wizard"
 />
 </Suspense>
 </div>

 {/* Disclaimer */}
 <div className="bg-warning-subtle border border-warning-border rounded-xl p-4 mt-4">
 <p className="text-sm text-warning">{t('frontaliereWizard.disclaimer')}</p>
 </div>

 {/* Restart */}
 <div className="text-center mt-6">
 <button
 onClick={restart}
 className="inline-flex items-center gap-2 text-sm text-muted hover:text-strong transition-colors"
 aria-label={t('frontaliereWizard.restart')}
 >
 <RotateCcw size={14} />
 {t('frontaliereWizard.restart')}
 </button>
 </div>
 </div>
 );
 }

 // ─── Question steps ───────────────────────────────────────────────────

 const question = QUESTIONS[currentStep];
 const Icon = question.icon;
 const currentAnswer = answers.find(a => a.questionId === question.id);

 return (
 <div className="max-w-2xl mx-auto">
 {/* Header */}
 <div className="text-center mb-8">
 <div className="inline-flex items-center gap-2 bg-gradient-to-r from-success-strong to-info-strong text-on-accent px-4 py-2 rounded-full text-xs font-bold mb-4">
 <Compass size={16} />
 {t('frontaliereWizard.badge')}
 </div>
 <h2 className="text-2xl font-bold font-display text-strong">{t('frontaliereWizard.title')}</h2>
 <p className="text-subtle mt-2 text-sm">{t('frontaliereWizard.subtitle')}</p>
 </div>

 {/* Progress */}
 <div className="mb-6">
 <div className="flex items-center justify-between text-xs text-muted mb-2">
 <span>{t('frontaliereWizard.question')} {currentStep + 1} / {totalQuestions}</span>
 <span>{progress}%</span>
 </div>
 <div className="h-2 bg-surface-raised rounded-full overflow-hidden">
 <div
 className="h-full bg-gradient-to-r from-success-strong to-info-strong rounded-full transition-transform duration-500 origin-left [transform:var(--sx)]"
 style={{ ['--sx']: `scaleX(${progress / 100})` } as React.CSSProperties}
 />
 </div>
 </div>

 {/* Question */}
 <div className="bg-surface rounded-2xl border border-edge p-6">
 <div className="flex items-center gap-3 mb-5">
 <div className="w-10 h-10 rounded-xl bg-success-subtle flex items-center justify-center">
 <Icon size={20} className="text-success" />
 </div>
 <h3 className="font-bold font-display text-lg text-strong">{t(`frontaliereWizard.q.${question.id}.title`)}</h3>
 </div>
 <p className="text-sm text-subtle mb-4">{t(`frontaliereWizard.q.${question.id}.desc`)}</p>

 {/* Options */}
 <div className="space-y-2">
 {question.options.map(opt => {
 const isSelected = currentAnswer?.value === opt.value;
 return (
 <button
 key={opt.value}
 onClick={() => handleAnswer(question.id, opt)}
 className={`w-full text-left px-4 py-3 rounded-xl border transition-colors ${
 isSelected
 ? 'border-success bg-success-subtle border-success-border ring-2 ring-success-border'
 : 'border-edge hover:border-success-border hover:bg-success-subtle'
 }`}
 aria-label={t(`frontaliereWizard.q.${question.id}.opt.${opt.value}`)}
 >
 <div className="flex items-center gap-3">
 <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
 isSelected ? 'border-success bg-success-strong' : 'border-edge'
 }`}>
 {isSelected && <div className="w-2 h-2 rounded-full bg-surface" />}
 </div>
 <span className={`text-sm ${isSelected ? 'font-semibold text-success' : 'text-body'}`}>
 {t(`frontaliereWizard.q.${question.id}.opt.${opt.value}`)}
 </span>
 </div>
 </button>
 );
 })}
 </div>
 </div>

 {/* Navigation */}
 <div className="flex items-center justify-between mt-6">
 <button
 onClick={goBack}
 disabled={currentStep === 0}
 className="flex items-center gap-2 text-sm text-muted hover:text-strong disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
 aria-label={t('frontaliereWizard.back')}
 >
 <ArrowLeft size={16} />
 {t('frontaliereWizard.back')}
 </button>

 {currentAnswer && currentStep < totalQuestions - 1 && (
 <button
 onClick={() => setCurrentStep(prev => prev + 1)}
 className="flex items-center gap-2 text-sm bg-success-strong hover:bg-success-strong-hover text-on-accent px-4 py-2 rounded-xl transition-colors"
 aria-label={t('frontaliereWizard.next')}
 >
 {t('frontaliereWizard.next')}
 <ArrowRight size={16} />
 </button>
 )}

 {currentAnswer && currentStep === totalQuestions - 1 && (
 <button
 onClick={() => complete(answers)}
 className="flex items-center gap-2 text-sm bg-success-strong hover:bg-success-strong-hover text-on-accent px-4 py-2 rounded-xl transition-colors"
 aria-label={t('frontaliereWizard.showResults')}
 >
 {t('frontaliereWizard.showResults')}
 <ChevronRight size={16} />
 </button>
 )}
 </div>
 </div>
 );
};

export default FrontaliereWizard;
