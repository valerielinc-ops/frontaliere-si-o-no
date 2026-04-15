/**
 * PermitQuiz — Interactive quiz:"Meglio Permesso B o G?"
 *
 * Step-by-step quiz that asks 6-8 questions about the user's situation
 * and recommends the best permit type with a personalized score.
 * Email-gates the detailed recommendation PDF.
 *
 * Target keyword:"meglio permesso b o g svizzera" (~600/mo)
 */

import React, { useState, useCallback, lazy, Suspense } from 'react';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analytics';
import {
 HelpCircle, ArrowRight, ArrowLeft, CheckCircle2, MapPin, Briefcase, Home,
 Heart, Clock, TrendingUp, Shield, Wallet, Users, FileText, RotateCcw,
 ChevronRight, Sparkles
} from 'lucide-react';

const LeadMagnetCTA = lazy(() => import('@/components/shared/LeadMagnetCTA'));
const ShareableResultCard = lazy(() => import('@/components/shared/ShareableResultCard'));

// ─── Types ──────────────────────────────────────────────────────────────

interface QuizAnswer {
 questionId: string;
 value: string;
 bScore: number; // Points toward Permit B
 gScore: number; // Points toward Permit G
}

interface QuizQuestion {
 id: string;
 icon: typeof HelpCircle;
 options: {
 value: string;
 bScore: number;
 gScore: number;
 }[];
}

// ─── Quiz Configuration ─────────────────────────────────────────────────

const QUIZ_QUESTIONS: QuizQuestion[] = [
 {
 id: 'residence',
 icon: Home,
 options: [
 { value: 'italy_border', bScore: 0, gScore: 3 },
 { value: 'italy_far', bScore: 1, gScore: 2 },
 { value: 'switzerland', bScore: 3, gScore: 0 },
 { value: 'undecided', bScore: 1, gScore: 1 },
 ],
 },
 {
 id: 'family',
 icon: Users,
 options: [
 { value: 'single', bScore: 2, gScore: 1 },
 { value: 'partner_italy', bScore: 0, gScore: 3 },
 { value: 'partner_ch', bScore: 3, gScore: 0 },
 { value: 'children_italy', bScore: 0, gScore: 3 },
 { value: 'children_ch', bScore: 3, gScore: 0 },
 ],
 },
 {
 id: 'salary',
 icon: Wallet,
 options: [
 { value: 'under_60k', bScore: 1, gScore: 2 },
 { value: '60k_80k', bScore: 1, gScore: 2 },
 { value: '80k_100k', bScore: 2, gScore: 1 },
 { value: 'over_100k', bScore: 3, gScore: 1 },
 ],
 },
 {
 id: 'duration',
 icon: Clock,
 options: [
 { value: 'short_term', bScore: 0, gScore: 3 },
 { value: 'medium_term', bScore: 1, gScore: 2 },
 { value: 'long_term', bScore: 3, gScore: 1 },
 { value: 'permanent', bScore: 3, gScore: 0 },
 ],
 },
 {
 id: 'priority',
 icon: TrendingUp,
 options: [
 { value: 'max_net', bScore: 2, gScore: 2 },
 { value: 'stability', bScore: 3, gScore: 1 },
 { value: 'flexibility', bScore: 1, gScore: 3 },
 { value: 'pension', bScore: 3, gScore: 1 },
 ],
 },
 {
 id: 'healthcare',
 icon: Heart,
 options: [
 { value: 'lamal', bScore: 3, gScore: 1 },
 { value: 'cme', bScore: 0, gScore: 3 },
 { value: 'unsure', bScore: 1, gScore: 1 },
 ],
 },
 {
 id: 'property',
 icon: MapPin,
 options: [
 { value: 'own_italy', bScore: 0, gScore: 3 },
 { value: 'rent_italy', bScore: 1, gScore: 2 },
 { value: 'own_ch', bScore: 3, gScore: 0 },
 { value: 'rent_ch', bScore: 2, gScore: 1 },
 { value: 'none', bScore: 1, gScore: 1 },
 ],
 },
 {
 id: 'commute',
 icon: Briefcase,
 options: [
 { value: 'under_30min', bScore: 1, gScore: 3 },
 { value: '30_60min', bScore: 1, gScore: 2 },
 { value: 'over_60min', bScore: 2, gScore: 1 },
 { value: 'remote', bScore: 3, gScore: 1 },
 ],
 },
];

// ─── Component ──────────────────────────────────────────────────────────

const PermitQuiz: React.FC = () => {
 const { t } = useTranslation();
 const [currentStep, setCurrentStep] = useState(0);
 const [answers, setAnswers] = useState<QuizAnswer[]>([]);
 const [showResults, setShowResults] = useState(false);

 const totalQuestions = QUIZ_QUESTIONS.length;
 const progress = Math.round((currentStep / totalQuestions) * 100);

 const handleAnswer = useCallback((questionId: string, option: { value: string; bScore: number; gScore: number }) => {
 const newAnswers = [...answers.filter(a => a.questionId !== questionId), {
 questionId,
 value: option.value,
 bScore: option.bScore,
 gScore: option.gScore,
 }];
 setAnswers(newAnswers);

 // Auto-advance to next question after a short delay
 setTimeout(() => {
 if (currentStep < totalQuestions - 1) {
 setCurrentStep(prev => prev + 1);
 } else {
 setShowResults(true);
 Analytics.trackUIInteraction('permit_quiz', 'quiz', 'complete', `answers_${newAnswers.length}`);
 }
 }, 300);
 }, [answers, currentStep, totalQuestions]);

 const goBack = useCallback(() => {
 if (currentStep > 0) {
 setCurrentStep(prev => prev - 1);
 }
 }, [currentStep]);

 const restart = useCallback(() => {
 setCurrentStep(0);
 setAnswers([]);
 setShowResults(false);
 }, []);

 // ─── Results Calculation ────────────────────────────────────────────

 const results = (() => {
 const totalB = answers.reduce((sum, a) => sum + a.bScore, 0);
 const totalG = answers.reduce((sum, a) => sum + a.gScore, 0);
 const max = totalB + totalG || 1;
 const bPercent = Math.round((totalB / max) * 100);
 const gPercent = Math.round((totalG / max) * 100);

 let recommendation: 'b' | 'g' | 'similar';
 if (Math.abs(bPercent - gPercent) < 10) {
 recommendation = 'similar';
 } else if (bPercent > gPercent) {
 recommendation = 'b';
 } else {
 recommendation = 'g';
 }

 return { totalB, totalG, bPercent, gPercent, recommendation };
 })();

 // ─── Results View ───────────────────────────────────────────────────

 if (showResults) {
 const { bPercent, gPercent, recommendation } = results;

 const recSemantic = recommendation === 'b'
 ? 'info' : recommendation === 'g'
 ? 'success' : 'warning';

 return (
 <div className="max-w-2xl mx-auto">
 {/* Header */}
 <div className="text-center mb-8">
 <h2 className="text-2xl font-bold font-display text-strong flex items-center justify-center gap-3">
 <Sparkles size={24} className="text-warning" />
 {t('permitQuiz.results.title')}
 </h2>
 <p className="text-subtle mt-2">
 {t('permitQuiz.results.subtitle')}
 </p>
 </div>

 {/* Score Bars */}
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 mb-6">
 <div className="space-y-4">
 {/* Permit B */}
 <div>
 <div className="flex items-center justify-between mb-2">
 <span className="font-semibold text-body">
 {t('permitQuiz.results.permitB')}
 </span>
 <span className="text-lg font-bold text-link">{bPercent}%</span>
 </div>
 <div className="h-4 bg-surface-raised rounded-full overflow-hidden">
 <div
 className="h-full bg-gradient-to-r from-accent-strong to-accent-strong rounded-full transition-transform duration-1000 origin-left"
 style={{ transform: `scaleX(${bPercent / 100})` }}
 />
 </div>
 </div>

 {/* Permit G */}
 <div>
 <div className="flex items-center justify-between mb-2">
 <span className="font-semibold text-body">
 {t('permitQuiz.results.permitG')}
 </span>
 <span className="text-lg font-bold text-success">{gPercent}%</span>
 </div>
 <div className="h-4 bg-surface-raised rounded-full overflow-hidden">
 <div
 className="h-full bg-gradient-to-r from-success-strong to-success-strong rounded-full transition-transform duration-1000 origin-left"
 style={{ transform: `scaleX(${gPercent / 100})` }}
 />
 </div>
 </div>
 </div>
 </div>

 {/* Recommendation */}
 <div className={`bg-${recSemantic}-subtle border border-${recSemantic}-border rounded-2xl p-4 sm:p-6 mb-6`}>
 <div className="flex items-start gap-4">
 <div className={`w-12 h-12 rounded-xl bg-${recSemantic}-subtle flex items-center justify-center shrink-0`}>
 <CheckCircle2 size={24} className={`text-${recSemantic}`} />
 </div>
 <div>
 <h3 className="font-bold font-display text-lg text-strong">
 {t(`permitQuiz.results.rec.${recommendation}`)}
 </h3>
 <p className="text-subtle mt-1 text-sm">
 {t(`permitQuiz.results.recDesc.${recommendation}`)}
 </p>
 </div>
 </div>
 </div>

 {/* Key Factors */}
 <div className="bg-surface rounded-2xl border border-edge p-4 sm:p-6 mb-6">
 <h3 className="font-bold text-strong mb-4 flex items-center gap-2">
 <FileText size={18} className="text-warning" />
 {t('permitQuiz.results.factors')}
 </h3>
 <div className="space-y-3">
 {answers.map(a => {
 const dominant = a.bScore > a.gScore ? 'B' : a.gScore > a.bScore ? 'G' : '=';
 return (
 <div key={a.questionId} className="flex items-center justify-between py-2 border-b border-edge last:border-0">
 <span className="text-sm text-subtle">
 {t(`permitQuiz.q.${a.questionId}.title`)}
 </span>
 <div className="flex items-center gap-2">
 <span className="text-sm text-muted">
 {t(`permitQuiz.q.${a.questionId}.opt.${a.value}`)}
 </span>
 <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
 dominant === 'B' ? 'bg-accent-subtle text-accent' :
 dominant === 'G' ? 'bg-success-subtle text-success' :
 'bg-warning-subtle text-warning'
 }`}>
 {dominant === '=' ? '≈' : `→ ${dominant}`}
 </span>
 </div>
 </div>
 );
 })}
 </div>
 </div>

 {/* Lead Magnet CTA */}
 <Suspense fallback={null}>
 <LeadMagnetCTA variant="relocation" delay={3000} />
 </Suspense>

 {/* Shareable result card */}
 <Suspense fallback={null}>
 <ShareableResultCard
 title={t('permitQuiz.results.title') || 'Quiz Permesso B o G'}
 subtitle={t(`permitQuiz.results.${recommendation}`) || ''}
 rows={[
 { label: 'Permesso B', value: `${bPercent}%`, highlight: recommendation === 'b', color: 'blue' },
 { label: 'Permesso G', value: `${gPercent}%`, highlight: recommendation === 'g', color: 'emerald' },
 ]}
 accent="violet"
 context="permit-quiz"
 />
 </Suspense>

 {/* Restart */}
 <div className="text-center mt-6">
 <button
 onClick={restart}
 className="inline-flex items-center gap-2 text-sm text-muted hover:text-strong transition-colors"
 aria-label={t('permitQuiz.restart')}
 >
 <RotateCcw size={14} />
 {t('permitQuiz.restart')}
 </button>
 </div>
 </div>
 );
 }

 // ─── Quiz Steps ─────────────────────────────────────────────────────

 const question = QUIZ_QUESTIONS[currentStep];
 const Icon = question.icon;
 const currentAnswer = answers.find(a => a.questionId === question.id);

 return (
 <div className="max-w-2xl mx-auto">
 {/* Header */}
 <div className="text-center mb-8">
 <div className="w-14 h-14 bg-gradient-to-br from-warning-strong to-warning-strong rounded-2xl flex items-center justify-center mx-auto mb-4">
 <HelpCircle size={24} className="text-on-accent" />
 </div>
 <h2 className="text-2xl font-bold font-display text-strong">
 {t('permitQuiz.title')}
 </h2>
 <p className="text-subtle mt-2 text-sm">
 {t('permitQuiz.subtitle')}
 </p>
 </div>

 {/* Progress */}
 <div className="mb-6">
 <div className="flex items-center justify-between text-xs text-muted mb-2">
 <span>{t('permitQuiz.question')} {currentStep + 1} / {totalQuestions}</span>
 <span>{progress}%</span>
 </div>
 <div className="h-2 bg-surface-raised rounded-full overflow-hidden">
 <div
 className="h-full bg-gradient-to-r from-warning-strong to-warning-strong rounded-full transition-transform duration-500 origin-left"
 style={{ transform: `scaleX(${progress / 100})` }}
 />
 </div>
 </div>

 {/* Question */}
 <div className="bg-surface rounded-2xl border border-edge p-6">
 <div className="flex items-center gap-3 mb-5">
 <div className="w-10 h-10 rounded-xl bg-warning-subtle flex items-center justify-center">
 <Icon size={20} className="text-warning" />
 </div>
 <h3 className="font-bold font-display text-lg text-strong">
 {t(`permitQuiz.q.${question.id}.title`)}
 </h3>
 </div>

 <p className="text-sm text-subtle mb-4">
 {t(`permitQuiz.q.${question.id}.desc`)}
 </p>

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
 ? 'border-warning bg-warning-subtle border-warning-border ring-2 ring-warning-border'
 : 'border-edge hover:border-warning-border hover:bg-warning-subtle'
 }`}
 aria-label={t(`permitQuiz.q.${question.id}.opt.${opt.value}`)}
 >
 <div className="flex items-center gap-3">
 <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center ${
 isSelected ? 'border-warning bg-warning-strong' : 'border-edge'
 }`}>
 {isSelected && <div className="w-2 h-2 rounded-full bg-surface" />}
 </div>
 <span className={`text-sm ${isSelected ? 'font-semibold text-warning' : 'text-body'}`}>
 {t(`permitQuiz.q.${question.id}.opt.${opt.value}`)}
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
 aria-label={t('permitQuiz.back')}
 >
 <ArrowLeft size={16} />
 {t('permitQuiz.back')}
 </button>

 {currentAnswer && currentStep < totalQuestions - 1 && (
 <button
 onClick={() => setCurrentStep(prev => prev + 1)}
 className="flex items-center gap-2 text-sm bg-warning-strong hover:bg-warning-strong-hover text-on-accent px-4 py-2 rounded-xl transition-colors"
 aria-label={t('permitQuiz.next')}
 >
 {t('permitQuiz.next')}
 <ArrowRight size={16} />
 </button>
 )}

 {currentAnswer && currentStep === totalQuestions - 1 && (
 <button
 onClick={() => { setShowResults(true); Analytics.trackUIInteraction('permit_quiz', 'quiz', 'complete', `answers_${answers.length}`); }}
 className="flex items-center gap-2 text-sm bg-warning-strong hover:bg-warning-strong-hover text-on-accent px-4 py-2 rounded-xl transition-colors"
 aria-label={t('permitQuiz.showResults')}
 >
 {t('permitQuiz.showResults')}
 <ChevronRight size={16} />
 </button>
 )}
 </div>
 </div>
 );
};

export default PermitQuiz;
