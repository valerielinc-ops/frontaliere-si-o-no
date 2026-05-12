import React, { Suspense } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { useNavigation } from '@/services/NavigationContext';
import { useTabContent } from '@/services/TabContentContext';
import { useTranslation, getCantonI18nParams } from '@/services/i18n';
import { Analytics } from '@/services/analyticsProxy';
import { pushRoute } from '@/services/router';
import type { ActiveTab, CalcolatoreSubTab, BlogArticleId } from '@/services/router';
import { Briefcase } from 'lucide-react';
import {
 SkeletonNewsTicker,
 SkeletonWeeklyFact,
 SkeletonInputCard,
 SkeletonMobileCalc,
} from '@/components/shared/Skeletons';
import AiExtractableTable from '@/components/shared/AiExtractableTable';
import FaqAccordion from '@/components/shared/FaqAccordion';
import { SilentErrorBoundary } from '@/components/shared/ErrorBoundary';

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
const AdSenseBanner = lazyRetry(() => import('@/components/shared/AdSenseBanner'));
import { AD_SLOTS } from '@/services/adsenseSlots';


const LazyFallback = () => <SkeletonWeeklyFact />;

export default function CalcolatoreTabContent() {
 const { calcolatoreSubTab } = useNavigation();
 const {
 inputs, setInputs, result, isResultStale, handleCalculate,
 showDeferredHomeWidgets, seoLanding, userProfile,
 setActiveTab, setBlogArticle, navigateTo,
 } = useTabContent();
 const { t } = useTranslation();

 if (calcolatoreSubTab === 'calculator') {
 return (
 <div className="space-y-8">
 {seoLanding === 'new-frontier-over20km' ? (
 <Suspense fallback={<div className="h-64 rounded-3xl bg-surface-raised animate-pulse mb-6" />}>
 <NewFrontierOver20KmHub />
 </Suspense>
 ) : (
 <>
 <h1 className="text-xl sm:text-2xl font-extrabold font-display text-heading tracking-tight mb-1">
 {t('seoContent.calculator.title')}
 </h1>
 <p className="text-sm text-muted mb-4">
 {t('seoContent.calculator.subtitle')}
 </p>

 {showDeferredHomeWidgets ? (
 // SilentErrorBoundary contains React #31 / render errors in the home
 // widgets cluster (NewsFeed, DailyDialectPhrase, job-board CTA) so a
 // transient failure does not blank the whole homepage. Errors are still
 // reported to Analytics with a `home-widgets-desktop` label.
 <SilentErrorBoundary boundary="home-widgets-desktop" fallback={
 <div className="hidden md:block space-y-2 mb-4" aria-hidden="true">
 <div className="grid grid-cols-1 md:grid-cols-20 gap-2 items-stretch">
 <div className="md:col-span-13 h-full"><SkeletonNewsTicker /></div>
 <div className="md:col-span-7 h-full"><div className="h-[34px] rounded-xl bg-surface-raised animate-pulse" /></div>
 </div>
 </div>
 }>
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
 <a
 href="/cerca-lavoro-ticino/"
 onClick={(e) => { e.preventDefault(); Analytics.trackSelectContent('job_board_cta', 'desktop'); navigateTo('job-board' as any); }}
 className="w-full flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-accent-strong to-accent-strong-hover hover:from-accent-strong-hover hover:to-accent-strong-hover rounded-xl text-on-accent transition-[color,background-color,border-color,box-shadow] hover:shadow-md text-left cursor-pointer"
 >
 <div className="p-1.5 bg-on-accent/20 rounded-lg flex-shrink-0">
 <Briefcase size={16} className="text-on-accent" />
 </div>
 <div className="min-w-0">
 <div className="text-sm font-bold leading-tight line-clamp-2">{t('jobBoard.homeCta.title', getCantonI18nParams())}</div>
 <div className="text-xs text-on-accent/70 line-clamp-1">{t('jobBoard.homeCta.desc', getCantonI18nParams())}</div>
 </div>
 <div className="ml-auto flex-shrink-0 text-xs font-semibold text-on-accent/70 whitespace-nowrap hidden lg:block">{t('jobBoard.homeCta.button')}</div>
 </a>
 </div>
 </div>
 </SilentErrorBoundary>
 ) : (
 <div className="hidden md:block space-y-2 mb-4" aria-hidden="true">
 <div className="grid grid-cols-1 md:grid-cols-20 gap-2 items-stretch">
 <div className="md:col-span-13 h-full"><SkeletonNewsTicker /></div>
 <div className="md:col-span-7 h-full"><div className="h-[34px] rounded-xl bg-surface-raised animate-pulse" /></div>
 </div>
 <div className="mt-2"><div className="h-12 rounded-xl bg-gradient-to-r from-surface-raised to-edge animate-pulse" /></div>
 </div>
 )}

 {/* Mobile: Results-first bottom-sheet layout.
   CLS fix (2026-05-12): the Suspense fallback MUST match the real
   MobileCalcLayout height. Previously used SkeletonInputCard (~750px
   tall desktop form skeleton) which created a ~440px upward layout
   shift the moment the mobile-calc chunk arrived — root cause of the
   home@mobile CLS=1.05 regression (CrUX, 28-day rolling). The compact
   SkeletonMobileCalc mirrors the real component (~260px). */}
 <div className={`md:hidden transition-opacity duration-200${isResultStale ? ' opacity-50' : ''}`}>
 <Suspense fallback={<SkeletonMobileCalc />}>
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
 <div className="md:col-span-4 lg:col-span-4 xl:col-span-3 h-full">
 <Suspense fallback={<SkeletonInputCard />}>
 <InputCard inputs={inputs} setInputs={setInputs} onCalculate={handleCalculate} result={result} />
 </Suspense>
 </div>
 <div className={`md:col-span-8 lg:col-span-8 xl:col-span-9 h-full transition-opacity duration-200${isResultStale ? ' opacity-50' : ''}`}>
 {result && (
 <Suspense fallback={<LazyFallback />}>
 <ResultsView result={result} inputs={inputs} />
 </Suspense>
 )}
 </div>
 </div>

 {/* Mobile: widgets below results — stable outer div prevents CLS during skeleton→real swap.
     Inline style mirrors the Tailwind utility so the reservation applies even if Tailwind
     hasn't loaded yet (async CSS). Without it, deferred widgets cause +0.16 CLS on mobile.
     CLS fix (2026-05-12): bumped 160 → 192 to cover the realistic max real-content
     height (NewsFeed 34 + WeeklyFact 34-50 + JobCTA ~52 + DailyDialect 34 + gaps).
     The previous 160 was sized for the all-skeleton fallback (4 × 34 + 24 gaps = 160)
     and undersized once the real JobBoard CTA + line-clamp-2 WeeklyFact rendered.
     Skeleton fallback inside enlarged to four h-[44px] slots so the fallback itself
     also fills the reserved space, preventing a 32px upward shift when fallback shows. */}
 <div className="md:hidden space-y-2 mt-6 min-h-[192px]" style={{ minHeight: 192 }}>
 {showDeferredHomeWidgets ? (
 // Same as desktop: contain render errors in mobile home widgets so a
 // failure does not blank the homepage on small screens. The whole
 // results-and-input layout above stays usable even if widgets crash.
 <SilentErrorBoundary boundary="home-widgets-mobile" fallback={
 <div aria-hidden="true" className="space-y-2">
 <SkeletonNewsTicker />
 <SkeletonWeeklyFact />
 <div className="h-[44px] rounded-xl bg-surface-raised animate-pulse" />
 <div className="h-[34px] rounded-xl bg-surface-raised animate-pulse" />
 </div>
 }>
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
 <a
 href="/cerca-lavoro-ticino/"
 onClick={(e) => { e.preventDefault(); Analytics.trackSelectContent('job_board_cta', 'mobile'); navigateTo('job-board' as any); }}
 className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-gradient-to-r from-accent-strong to-accent-strong-hover hover:from-accent-strong-hover hover:to-accent-strong-hover rounded-xl text-on-accent transition-[color,background-color,border-color,transform] active:scale-[0.98]"
 >
 <div className="flex items-center gap-2.5 min-w-0">
 <Briefcase size={18} className="text-on-accent flex-shrink-0" />
 <span className="text-sm font-bold line-clamp-1">{t('jobBoard.homeCta.mobile.title', getCantonI18nParams())}</span>
 </div>
 <span className="text-xs font-semibold text-on-accent/70 flex-shrink-0">{t('jobBoard.homeCta.mobile.button')} →</span>
 </a>
 </div>
 <Suspense fallback={<div className="h-[34px]" />}>
 <DailyDialectPhrase />
 </Suspense>
 </SilentErrorBoundary>
 ) : (
 <div aria-hidden="true" className="space-y-2">
 <SkeletonNewsTicker />
 <SkeletonWeeklyFact />
 <div className="h-[44px] rounded-xl bg-surface-raised animate-pulse" />
 <div className="h-[34px] rounded-xl bg-surface-raised animate-pulse" />
 </div>
 )}
 </div>

 {result && (
 <div className="mt-3">
 <Suspense fallback={<div className="h-[34px]" />}><SocialProofBadge fullWidth /></Suspense>
 </div>
 )}
 {result && (
 <div className="hidden md:block mt-6 w-full">
 <Suspense fallback={<SkeletonWeeklyFact />}><WeeklyFact /></Suspense>
 </div>
 )}
 {/* AdSense — homepage mid-content display (reserveSpace prevents CLS when result appears) */}
 <Suspense fallback={null}>
 <AdSenseBanner
 adSlot={AD_SLOTS.HOMEPAGE_MID_DISPLAY.slot}
 adFormat={AD_SLOTS.HOMEPAGE_MID_DISPLAY.format}
 fullWidthResponsive={AD_SLOTS.HOMEPAGE_MID_DISPLAY.fullWidthResponsive}
 className="mt-6 mb-4"
 enabled={!!result}
 reserveSpace
 />
 </Suspense>

 {/* AI-extractable comparison table + FAQ — in <details> for crawlability without breaking page flow */}
 <details className="mt-6 group">
 <summary className="cursor-pointer list-none flex items-center gap-2 text-sm font-medium text-accent hover:text-accent transition-colors">
 <svg className="w-4 h-4 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
 {t('calc.table.caption')}
 </summary>
 <div className="mt-3">
 <AiExtractableTable
 caption={t('calc.table.caption')}
 columns={[
 { header: t('calc.table.col.aspect'), accessor: 'aspect' },
 { header: t('calc.table.col.permitB'), accessor: 'permitB' },
 { header: t('calc.table.col.permitG'), accessor: 'permitG' },
 ]}
 rows={[
 { aspect: t('calc.table.row1.aspect'), permitB: t('calc.table.row1.permitB'), permitG: t('calc.table.row1.permitG') },
 { aspect: t('calc.table.row2.aspect'), permitB: t('calc.table.row2.permitB'), permitG: t('calc.table.row2.permitG') },
 { aspect: t('calc.table.row3.aspect'), permitB: t('calc.table.row3.permitB'), permitG: t('calc.table.row3.permitG') },
 { aspect: t('calc.table.row4.aspect'), permitB: t('calc.table.row4.permitB'), permitG: t('calc.table.row4.permitG') },
 { aspect: t('calc.table.row5.aspect'), permitB: t('calc.table.row5.permitB'), permitG: t('calc.table.row5.permitG') },
 ]}
 source={t('calc.table.source')}
 />
 <FaqAccordion
 title={t('calc.faq.title')}
 items={[
 { question: t('calc.faq.q1'), answer: t('calc.faq.a1') },
 { question: t('calc.faq.q2'), answer: t('calc.faq.a2') },
 { question: t('calc.faq.q3'), answer: t('calc.faq.a3') },
 ]}
 className="mt-4"
 />
 </div>
 </details>
 {/* Homepage end-of-page multiplex — only shown after a result so we don't
  * compete with the hero/input on first paint. Backfills the home undermonetization
  * (only HOMEPAGE_MID_DISPLAY was previously firing here, €0.21/30d). */}
 <Suspense fallback={null}>
 <AdSenseBanner
 adSlot={AD_SLOTS.ARTICLE_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.ARTICLE_END_MULTIPLEX.format}
 className="mt-8 mb-4"
 />
 </Suspense>
 </>
 )}
 </div>
 );
 }

 // ── Sub-calculator views — each gets a bottom AdSense multiplex ──
 const adBottom = (
 <Suspense fallback={null}>
 <AdSenseBanner adSlot={AD_SLOTS.ARTICLE_END_MULTIPLEX.slot} adFormat={AD_SLOTS.ARTICLE_END_MULTIPLEX.format} className="mt-8 mb-4" />
 </Suspense>
 );

 if (calcolatoreSubTab === 'payslip') {
 return <div className="w-full"><PayslipSimulator userProfile={userProfile} />{adBottom}</div>;
 }
 if (calcolatoreSubTab === 'whatif') {
 return (
 <div className={`w-full transition-opacity duration-200${isResultStale ? ' opacity-50' : ''}`}>
 {result && <WhatIfSimulator baseInputs={inputs} baseResult={result} userProfile={userProfile} />}
 {adBottom}
 </div>
 );
 }
 if (calcolatoreSubTab === 'ral') {
 return <div className="max-w-7xl mx-auto"><RalComparator userProfile={userProfile} />{adBottom}</div>;
 }
 if (calcolatoreSubTab === 'bonus') {
 return <div className="max-w-7xl mx-auto"><BonusCalculator userProfile={userProfile} />{adBottom}</div>;
 }
 if (calcolatoreSubTab === 'parental-leave') {
 return <div className="max-w-7xl mx-auto"><ParentalLeaveCalculator userProfile={userProfile} />{adBottom}</div>;
 }
 if (calcolatoreSubTab === 'residency') {
 return <div className="max-w-7xl mx-auto"><ResidencySimulator />{adBottom}</div>;
 }
 if (calcolatoreSubTab === 'salary-quiz') {
 return <div className="max-w-7xl mx-auto"><SalaryQuiz />{adBottom}</div>;
 }
 return null;
}
