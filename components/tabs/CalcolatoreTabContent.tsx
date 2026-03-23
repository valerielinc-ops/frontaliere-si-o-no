import React, { Suspense } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { useNavigation } from '@/services/NavigationContext';
import { useTabContent } from '@/services/TabContentContext';
import { useTranslation } from '@/services/i18n';
import { Analytics } from '@/services/analyticsProxy';
import { pushRoute } from '@/services/router';
import type { ActiveTab, CalcolatoreSubTab, BlogArticleId } from '@/services/router';
import {
  ArrowRightLeft, Layers, Shield, Briefcase,
} from 'lucide-react';
import {
  SkeletonNewsTicker,
  SkeletonWeeklyFact,
  SkeletonInputCard,
} from '@/components/shared/Skeletons';

// Eagerly load InputCard in THIS chunk so it parses only when CalcolatoreTabContent loads.
// This removes InputCard and MobileCalcLayout from the main App bundle.
const InputCard = lazyRetry(() => import('@/components/calculator/InputCard').then(m => ({ default: m.InputCard as any })));
const MobileCalcLayout = lazyRetry(() => import('@/components/calculator/MobileCalcLayout'));
const ResultsView = lazyRetry(() => import('@/components/calculator/ResultsView').then(m => ({ default: m.ResultsView as any })));
const NewFrontierOver20KmHub = lazyRetry(() => import('@/components/calculator/NewFrontierOver20KmHub'));
const PayslipSimulator = lazyRetry(() => import('@/components/calculator/PayslipSimulator'));
const WhatIfSimulator = lazyRetry(() => import('@/components/calculator/WhatIfSimulator'));
const RalComparator = lazyRetry(() => import('@/components/calculator/RalComparator'));
const BonusCalculator = lazyRetry(() => import('@/components/calculator/BonusCalculator'));
const ParentalLeaveCalculator = lazyRetry(() => import('@/components/calculator/ParentalLeaveCalculator'));
const ResidencySimulator = lazyRetry(() => import('@/components/calculator/ResidencySimulator'));
const SalaryQuiz = lazyRetry(() => import('@/components/calculator/SalaryQuiz'));
const NewsFeed = lazyRetry(() => import('@/components/community/NewsFeed'));
const WeeklyFact = lazyRetry(() => import('@/components/vita/WeeklyFact'));
const DailyDialectPhrase = lazyRetry(() => import('@/components/vita/DailyDialectPhrase'));
const SocialProofBadge = lazyRetry(() => import('@/components/shared/SocialProofBadge'));

const LazyFallback = () => <SkeletonWeeklyFact />;

export default function CalcolatoreTabContent() {
  const { calcolatoreSubTab } = useNavigation();
  const {
    inputs, setInputs, result, handleCalculate,
    showDeferredHomeWidgets, seoLanding, userProfile,
    setActiveTab, setBlogArticle, navigateTo,
  } = useTabContent();
  const { t } = useTranslation();

  if (calcolatoreSubTab === 'calculator') {
    return (
      <div className="space-y-6">
        {seoLanding === 'new-frontier-over20km' ? (
          <Suspense fallback={<div className="h-64 rounded-3xl bg-slate-200 dark:bg-slate-800 animate-pulse mb-6" />}>
            <NewFrontierOver20KmHub />
          </Suspense>
        ) : (
          <>
            {showDeferredHomeWidgets ? (
              <div className="hidden md:block space-y-2 mb-4">
                <div className="grid grid-cols-1 md:grid-cols-20 gap-2 items-stretch">
                  <div className="md:col-span-13 h-full">
                    <Suspense fallback={<SkeletonNewsTicker />}>
                      <NewsFeed onNavigate={(tab, article) => {
                        setActiveTab(tab as ActiveTab);
                        if (article) setBlogArticle(article as BlogArticleId);
                        pushRoute({ activeTab: tab as ActiveTab, blogArticle: article as BlogArticleId });
                        window.scrollTo({ top: 0, behavior: 'instant' });
                      }} />
                    </Suspense>
                  </div>
                  <div className="md:col-span-7 h-full">
                    <Suspense fallback={<div className="h-[34px]" />}>
                      <DailyDialectPhrase />
                    </Suspense>
                  </div>
                </div>
                <div className="mt-2">
                  <button
                    onClick={() => { Analytics.trackSelectContent('job_board_cta', 'desktop'); navigateTo('job-board' as any); }}
                    className="w-full flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 rounded-xl text-white transition-all hover:shadow-md text-left cursor-pointer"
                  >
                    <div className="p-1.5 bg-white/20 rounded-lg flex-shrink-0">
                      <Briefcase size={16} className="text-white" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-bold leading-tight truncate">{t('jobBoard.homeCta.title')}</div>
                      <div className="text-xs text-blue-100 line-clamp-1">{t('jobBoard.homeCta.desc')}</div>
                    </div>
                    <div className="ml-auto flex-shrink-0 text-xs font-semibold text-blue-100 whitespace-nowrap hidden lg:block">{t('jobBoard.homeCta.button')}</div>
                  </button>
                </div>
              </div>
            ) : (
              <div className="hidden md:block space-y-2 mb-4" aria-hidden="true">
                <div className="grid grid-cols-1 md:grid-cols-20 gap-2 items-stretch">
                  <div className="md:col-span-13 h-full"><SkeletonNewsTicker /></div>
                  <div className="md:col-span-7 h-full"><div className="h-[34px] rounded-xl bg-slate-200 dark:bg-slate-700 animate-pulse" /></div>
                </div>
                <div className="mt-2"><div className="h-12 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 animate-pulse" /></div>
              </div>
            )}

            {/* Mobile: Results-first bottom-sheet layout */}
            <div className="md:hidden">
              <Suspense fallback={<SkeletonInputCard />}>
                <MobileCalcLayout
                  inputs={inputs}
                  setInputs={setInputs}
                  onCalculate={handleCalculate}
                  result={result}
                  renderResultView={(focusArea, onProfileTagClick) =>
                    result ? (
                      <Suspense fallback={<LazyFallback />}>
                        <ResultsView result={result} inputs={inputs} focusArea={focusArea ?? null} onProfileTagClick={onProfileTagClick} />
                      </Suspense>
                    ) : null
                  }
                  renderInputCard={(focusField, focusRequestId) => (
                    <Suspense fallback={<SkeletonInputCard />}>
                      <InputCard
                        inputs={inputs}
                        setInputs={setInputs}
                        onCalculate={handleCalculate}
                        focusField={focusField}
                        focusRequestId={focusRequestId}
                      />
                    </Suspense>
                  )}
                />
              </Suspense>
            </div>

            {/* Desktop: side-by-side layout */}
            <div className="hidden md:grid grid-cols-12 gap-6 h-full">
              <div className="transition-all duration-500 ease-in-out md:col-span-4 lg:col-span-4 xl:col-span-3 h-full">
                <Suspense fallback={<SkeletonInputCard />}>
                  <InputCard inputs={inputs} setInputs={setInputs} onCalculate={handleCalculate} />
                </Suspense>
              </div>
              <div className="transition-all duration-500 ease-in-out md:col-span-8 lg:col-span-8 xl:col-span-9 h-full">
                {result && (
                  <Suspense fallback={<LazyFallback />}>
                    <ResultsView result={result} inputs={inputs} />
                  </Suspense>
                )}
              </div>
            </div>

            {/* Mobile: widgets below results */}
            {showDeferredHomeWidgets ? (
              <div className="md:hidden space-y-2 mt-2">
                <Suspense fallback={<SkeletonNewsTicker />}>
                  <NewsFeed onNavigate={(tab, article) => {
                    setActiveTab(tab as ActiveTab);
                    if (article) setBlogArticle(article as BlogArticleId);
                    pushRoute({ activeTab: tab as ActiveTab, blogArticle: article as BlogArticleId });
                    window.scrollTo({ top: 0, behavior: 'instant' });
                  }} />
                </Suspense>
                <div className="space-y-2">
                  <Suspense fallback={<SkeletonWeeklyFact />}><WeeklyFact /></Suspense>
                  <button
                    onClick={() => { Analytics.trackSelectContent('job_board_cta', 'mobile'); navigateTo('job-board' as any); }}
                    className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 rounded-xl text-white transition-all active:scale-[0.98]"
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <Briefcase size={18} className="text-white flex-shrink-0" />
                      <span className="text-sm font-bold truncate">{t('jobBoard.homeCta.mobile.title')}</span>
                    </div>
                    <span className="text-xs font-semibold text-blue-100 flex-shrink-0">{t('jobBoard.homeCta.mobile.button')} →</span>
                  </button>
                </div>
                <Suspense fallback={<div className="h-[34px]" />}>
                  <DailyDialectPhrase />
                </Suspense>
              </div>
            ) : (
              <div className="md:hidden space-y-2 mt-2" aria-hidden="true">
                <SkeletonNewsTicker />
                <SkeletonWeeklyFact />
                <div className="h-[34px] rounded-xl bg-slate-200 dark:bg-slate-700 animate-pulse" />
                <div className="h-[34px] rounded-xl bg-slate-200 dark:bg-slate-700 animate-pulse" />
              </div>
            )}

            {/* Popular Tools CTA */}
            {result && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-2">
                {([
                  { icon: ArrowRightLeft, label: t('nav.confronti'), desc: t('cta.confrontiDesc'), color: 'from-violet-500 to-purple-600', tab: 'confronti' as ActiveTab, sub: undefined as CalcolatoreSubTab | undefined },
                  { icon: Layers, label: t('cta.whatif'), desc: t('cta.whatifDesc'), color: 'from-amber-500 to-orange-600', tab: 'calculator' as ActiveTab, sub: 'whatif' as CalcolatoreSubTab },
                  { icon: Shield, label: t('nav.fisco'), desc: t('cta.fiscalDesc'), color: 'from-emerald-500 to-teal-600', tab: 'fisco' as ActiveTab, sub: undefined as CalcolatoreSubTab | undefined },
                  { icon: Briefcase, label: t('nav.guida'), desc: t('cta.guidaDesc'), color: 'from-blue-500 to-indigo-600', tab: 'guida' as ActiveTab, sub: undefined as CalcolatoreSubTab | undefined },
                ]).map(({ icon: Icon, label, desc, color, tab, sub }) => (
                  <button
                    key={tab + (sub || '')}
                    onClick={() => navigateTo(tab, sub)}
                    className="flex items-start gap-3 p-4 bg-white dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700 hover:shadow-md hover:-translate-y-0.5 transition-all text-left group"
                  >
                    <div className={`p-2 rounded-lg bg-gradient-to-br ${color} flex-shrink-0`}>
                      <Icon size={18} className="text-white" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-slate-800 dark:text-slate-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">{label}</div>
                      <div className="text-xs text-slate-600 dark:text-slate-500 line-clamp-2">{desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
            {result && (
              <div className="mt-3">
                <Suspense fallback={<div className="h-[34px]" />}><SocialProofBadge fullWidth /></Suspense>
              </div>
            )}
            {result && (
              <div className="mt-2 w-full">
                <Suspense fallback={<SkeletonWeeklyFact />}><WeeklyFact /></Suspense>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  if (calcolatoreSubTab === 'payslip') {
    return <div className="w-full"><PayslipSimulator userProfile={userProfile} /></div>;
  }
  if (calcolatoreSubTab === 'whatif') {
    return (
      <div className="w-full">
        {result && <WhatIfSimulator baseInputs={inputs} baseResult={result} userProfile={userProfile} />}
      </div>
    );
  }
  if (calcolatoreSubTab === 'ral') {
    return <div className="max-w-7xl mx-auto"><RalComparator userProfile={userProfile} /></div>;
  }
  if (calcolatoreSubTab === 'bonus') {
    return <div className="max-w-7xl mx-auto"><BonusCalculator userProfile={userProfile} /></div>;
  }
  if (calcolatoreSubTab === 'parental-leave') {
    return <div className="max-w-7xl mx-auto"><ParentalLeaveCalculator userProfile={userProfile} /></div>;
  }
  if (calcolatoreSubTab === 'residency') {
    return <div className="max-w-7xl mx-auto"><ResidencySimulator /></div>;
  }
  if (calcolatoreSubTab === 'salary-quiz') {
    return <div className="max-w-7xl mx-auto"><SalaryQuiz /></div>;
  }
  return null;
}
