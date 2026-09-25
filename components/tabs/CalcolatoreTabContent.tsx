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
import DesktopTopBanner from '@/components/shared/DesktopTopBanner';

// Eagerly load InputCard in THIS chunk so it parses only when CalcolatoreTabContent loads.
// This removes InputCard and MobileCalcLayout from the main App bundle.
const InputCard = lazyRetry(() => import('@/components/calculator/InputCard').then(m => ({ default: m.InputCard as any })));
const MobileCalcLayout = lazyRetry(() => import('@/components/calculator/MobileCalcLayout'));
const ResultsView = lazyRetry(() => import('@/components/calculator/ResultsView').then(m => ({ default: m.ResultsView as any })));
const NewFrontierOver20KmHub = lazyRetry(() => import('@/components/calculator/NewFrontierOver20KmHub'));
const SeasonalNaspiSimulator = lazyRetry(() => import('@/components/calculator/SeasonalNaspiSimulator'));
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


/* CLS fix (#3529): the ResultsView chunk resolves >500ms after the toggle /
   idle auto-calc, so its Suspense swap counts as layout shift. A 34px
   fallback (the old LazyFallback) understated the real pane by ~2700px;
   h-full + a tall min-height keeps the desktop grid row (and everything
   below it) far more stable while the chunk loads. */
const ResultsPaneFallback = () => (
 <div aria-hidden="true" className="h-full min-h-[600px] rounded-2xl bg-surface-raised animate-pulse" />
);

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
 <>
 {/* Dedicated desktop top-banner (GPT/GAM leaderboard) above the H1 —
 replaces reliance on the variable-height Auto Ad whose box left a blank
 band above the fold. Outside space-y-8 so the hidden (mobile) slot adds
 no phantom top gap. */}
 <DesktopTopBanner />
 <div className="space-y-8">
 {seoLanding === 'new-frontier-over20km' ? (
 <Suspense fallback={<div className="h-64 rounded-3xl bg-surface-raised animate-pulse mb-6" />}>
 <NewFrontierOver20KmHub />
 </Suspense>
 ) : seoLanding === 'seasonal-vs-annual-naspi' ? (
 <Suspense fallback={<div className="h-64 rounded-3xl bg-surface-raised animate-pulse mb-6" />}>
 <SeasonalNaspiSimulator />
 </Suspense>
 ) : (
 <>
 <h1 className="text-xl sm:text-2xl font-extrabold font-display text-heading tracking-tight mb-1">
 {t('seoContent.calculator.title')}
 </h1>
 <p className="text-sm text-muted mb-4">
 {t('seoContent.calculator.subtitle')}
 </p>

 {/* Regime scope (issue #4545 follow-up). The engine is hardwired to the
     Italy-Switzerland regime — Ticino withholding tables plus Italian IRPEF
     and FRANCHIGIA_NUOVI_FRONTALIERI — and takes no country-of-residence
     input, yet the France/Germany/Austria/Liechtenstein border-municipality
     pages all link here. Without this line a Lörrach resident reads an
     Italian-regime net as if it were theirs: a wrong NUMBER, which is
     believed more readily than wrong prose. Delete this together with
     build-plugins/shared/calculatorRegimeScope.ts once the calculator
     accepts a residence country. */}
 <p className="text-xs text-muted mb-4 border-l-2 border-edge pl-3" data-testid="calculator-regime-scope">
 {t('calculator.regimeScope.notice')}
 </p>

 {/* Above-the-fold job-board onward-nav CTA (follow-up #2814; same intent as
     the static data pages' renderAboveFoldJobCta shipped in #2798). Rendered at
     FIRST PAINT — NOT behind the showDeferredHomeWidgets idle flip — right after
     the hero and before the calculator + long content, to capture the homepage's
     ~71.5% bounce (cross-border job-seekers who leave before the idle-deferred
     widgets / below-results CTA ever paint). Links only (no ad slot → ad-regression
     guards unaffected); single-line fixed height, present from first paint and
     never re-flowed → zero CLS. Supersedes the redundant idle desktop widget-row
     CTA removed below. Reuses the shipped jobBoard.homeCta.* keys (all 4 locales). */}
 <a
 href="/cerca-lavoro-ticino/"
 onClick={(e) => { e.preventDefault(); Analytics.trackSelectContent('job_board_cta', 'home_above_fold'); navigateTo('job-board' as any); }}
 className="mb-4 w-full flex items-center gap-3 px-4 py-3 bg-gradient-to-r from-accent-strong to-accent-strong-hover hover:from-accent-strong-hover hover:to-accent-strong-hover rounded-xl text-on-accent transition-[color,background-color,border-color,box-shadow] hover:shadow-md text-left cursor-pointer no-underline"
 >
 <div className="p-1.5 bg-on-accent/20 rounded-lg flex-shrink-0">
 <Briefcase size={16} className="text-on-accent" />
 </div>
 <div className="min-w-0">
 <div className="text-sm font-bold leading-tight line-clamp-2">{t('jobBoard.homeCta.title', getCantonI18nParams())}</div>
 <div className="text-xs text-on-accent/70 line-clamp-1">{t('jobBoard.homeCta.desc', getCantonI18nParams())}</div>
 </div>
 <div className="ml-auto flex-shrink-0 text-xs font-semibold text-on-accent/70 whitespace-nowrap hidden sm:block">{t('jobBoard.homeCta.button')}</div>
 </a>

 {/* Persistent SilentErrorBoundary (see mobile block below for rationale):
 keeping it mounted across the showDeferredHomeWidgets idle-flip and
 swapping only its children avoids a subtree unmount/remount that
 collapses this cluster and shifts layout. Contains React #31 / render
 errors in the desktop home widgets, reported as `home-widgets-desktop`. */}
 <SilentErrorBoundary boundary="home-widgets-desktop" fallback={
 <div className="hidden md:block space-y-2 mb-4" aria-hidden="true">
 <div className="grid grid-cols-1 md:grid-cols-20 gap-2 items-stretch">
 <div className="md:col-span-13 h-full"><SkeletonNewsTicker /></div>
 <div className="md:col-span-7 h-full"><div className="h-[34px] rounded-xl bg-surface-raised animate-pulse" /></div>
 </div>
 </div>
 }>
 {showDeferredHomeWidgets ? (
 <div className="hidden md:block space-y-2 mb-4">
 <div className="grid grid-cols-1 md:grid-cols-20 gap-2 items-stretch">
 <div className="md:col-span-13 h-full">
 <Suspense fallback={<SkeletonNewsTicker />}>
 <NewsFeed onNavigate={(tab, article, slug) => {
 setActiveTab(tab as ActiveTab);
 if (article) setBlogArticle(article as BlogArticleId);
 // Prefer the ticker-provided localized slug: pushes the canonical
 // /<blog>/<slug>/ URL without the lazy BLOG_SLUGS chunk (#3532).
 pushRoute(article && slug
 ? { activeTab: tab as ActiveTab, blogSlug: slug }
 : { activeTab: tab as ActiveTab, blogArticle: article as BlogArticleId });
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
 </div>
 ) : (
 <div className="hidden md:block space-y-2 mb-4" aria-hidden="true">
 <div className="grid grid-cols-1 md:grid-cols-20 gap-2 items-stretch">
 <div className="md:col-span-13 h-full"><SkeletonNewsTicker /></div>
 <div className="md:col-span-7 h-full"><div className="h-[34px] rounded-xl bg-surface-raised animate-pulse" /></div>
 </div>
 </div>
 )}
 </SilentErrorBoundary>

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
 <Suspense fallback={<ResultsPaneFallback />}>
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

 {/* Desktop: side-by-side layout. Form holds 4/12 (33%) across all desktop
     tiers — it was xl:col-span-3 (25%), but on desktop the calculator now
     always sits inside the side-rail grid (sideRailEligible), so 25% squeezed
     the form below the width its CHF income input + steppers need and clipped
     them on narrower desktops. 4/12 keeps the form usable; results take 8/12,
     still ample for the dual Svizzera|Italia comparison. */}
 <div className="hidden md:grid grid-cols-12 gap-6 h-full">
 <div className="md:col-span-4 lg:col-span-4 xl:col-span-4 h-full">
 <Suspense fallback={<SkeletonInputCard />}>
 <InputCard inputs={inputs} setInputs={setInputs} onCalculate={handleCalculate} result={result} />
 </Suspense>
 </div>
 <div className={`md:col-span-8 lg:col-span-8 xl:col-span-8 h-full transition-opacity duration-200${isResultStale ? ' opacity-50' : ''}`}>
 {result && (
 <Suspense fallback={<ResultsPaneFallback />}>
 <ResultsView result={result} inputs={inputs} />
 </Suspense>
 )}
 </div>
 </div>

 {/* Mobile: widgets below results — stable outer div prevents CLS during skeleton→real swap.
     min-h-[192px] reserves space so the page doesn't shift when the skeleton first shows
     (content fills ~186px; 6px buffer covers sub-pixel rounding).
     CLS fix (2026-05-12): bumped 160 → 192 (NewsFeed 34 + WeeklyFact slot 50 + JobCTA 44 + DailyDialect 34 + gaps 24 = 186).
     CLS fix follow-up (#2322): WeeklyFact Suspense now wrapped in min-h-[50px] — WeeklyFact
     renders min-h-[34px] with line-clamp-2, so real content is 34–50px depending on text
     length; the 16px growth was causing ~0.12 CLS when the Suspense resolved to its taller
     variant. min-h-[50px] on the wrapper holds the slot at 50px regardless, so the Suspense
     → real swap is height-neutral. Both skeleton branches (SilentErrorBoundary error fallback
     + false-state) also use min-h-[50px] so the false→true idle-flip is height-neutral too
     (both total ~186px). */}
 <div className="md:hidden space-y-2 mt-6 min-h-[192px]">
 {/* SilentErrorBoundary stays mounted across the showDeferredHomeWidgets
 flip (fired at idle ~2.3s via requestIdleCallback). Previously it lived
 only in the `true` branch, so the idle flip mounted/unmounted the whole
 boundary subtree — a transient unmount that collapsed this block to 0
 height mid-viewport (Playwright live: 0.122 = 72% of mobile homepage
 CLS @2303ms). Keeping the boundary persistent and swapping only its
 children reconciles in place: no unmount, no collapse. Contains React
 #31 / render errors in the mobile home widgets either way. */}
 <SilentErrorBoundary boundary="home-widgets-mobile" fallback={
 <div aria-hidden="true" className="space-y-2">
 <SkeletonNewsTicker />
 <div className="min-h-[50px] rounded-xl bg-surface-raised animate-pulse" />
 <div className="h-[44px] rounded-xl bg-surface-raised animate-pulse" />
 <div className="h-[34px] rounded-xl bg-surface-raised animate-pulse" />
 </div>
 }>
 {showDeferredHomeWidgets ? (
 /* Sole child = <div className="space-y-2"> mirroring the FALSE/skeleton branch
    below, so the idle showDeferredHomeWidgets flip reconciles this wrapper IN
    PLACE. The previous <>…</> fragment (different element at index 0 vs the
    skeleton div) forced React to remove+add the container — a transient collapse
    of this min-h-[192px] block ≈0.12 mobile CLS (Playwright MutationObserver:
    REMOVE+ADD div.space-y-2 at the flip). Matches the desktop branch pattern. */
 <div className="space-y-2">
 <Suspense fallback={<SkeletonNewsTicker />}>
 <NewsFeed onNavigate={(tab, article, slug) => {
 setActiveTab(tab as ActiveTab);
 if (article) setBlogArticle(article as BlogArticleId);
 // Prefer the ticker-provided localized slug: pushes the canonical
 // /<blog>/<slug>/ URL without the lazy BLOG_SLUGS chunk (#3532).
 pushRoute(article && slug
 ? { activeTab: tab as ActiveTab, blogSlug: slug }
 : { activeTab: tab as ActiveTab, blogArticle: article as BlogArticleId });
 window.scrollTo({ top: 0, behavior: 'instant' });
 }} />
 </Suspense>
 <div className="space-y-2">
 <div className="min-h-[50px]">
 <Suspense fallback={<div className="min-h-[50px] rounded-xl bg-surface-raised animate-pulse" />}><WeeklyFact /></Suspense>
 </div>
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
 </div>
 ) : (
 <div aria-hidden="true" className="space-y-2">
 <SkeletonNewsTicker />
 <div className="min-h-[50px] rounded-xl bg-surface-raised animate-pulse" />
 <div className="h-[44px] rounded-xl bg-surface-raised animate-pulse" />
 <div className="h-[34px] rounded-xl bg-surface-raised animate-pulse" />
 </div>
 )}
 </SilentErrorBoundary>
 </div>

 {/* CLS fix (#3529): slots below stay in flow from first paint and only
     their CONTENT is result-gated. The result now arrives via the idle
     auto-calc (~1–2.5s, hooks/useSimulationState.ts) — mounting these
     wrappers at that moment shifted everything below them. */}
 <div className="mt-3 min-h-[34px]">
 {result && <Suspense fallback={<div className="h-[34px]" />}><SocialProofBadge fullWidth /></Suspense>}
 </div>
 <div className="hidden md:block mt-6 w-full min-h-[34px]">
 {result && <Suspense fallback={<SkeletonWeeklyFact />}><WeeklyFact /></Suspense>}
 </div>
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
 {/* Homepage end-of-page multiplex — complements the compact post-result slot
  * in ResultsView without competing with the hero/input on first paint. */}
 <Suspense fallback={<div style={{ ['--ad-mh']: `${AD_SLOTS.ARTICLE_END_MULTIPLEX.placeholderMinHeight}px` } as React.CSSProperties} className="mt-8 mb-4 min-h-[var(--ad-mh)] xl:min-h-[600px] [contain:content]" />}>
 <AdSenseBanner
 adSlot={AD_SLOTS.ARTICLE_END_MULTIPLEX.slot}
 adFormat={AD_SLOTS.ARTICLE_END_MULTIPLEX.format}
 className="mt-8 mb-4"
 />
 </Suspense>
 </>
 )}
 </div>
 </>
 );
 }

 // ── Sub-calculator views — each gets a bottom AdSense multiplex ──
 const adBottom = (
 <Suspense fallback={<div style={{ ['--ad-mh']: `${AD_SLOTS.ARTICLE_END_MULTIPLEX.placeholderMinHeight}px` } as React.CSSProperties} className="mt-8 mb-4 min-h-[var(--ad-mh)] xl:min-h-[600px] [contain:content]" />}>
 <AdSenseBanner adSlot={AD_SLOTS.ARTICLE_END_MULTIPLEX.slot} adFormat={AD_SLOTS.ARTICLE_END_MULTIPLEX.format} className="mt-8 mb-4" />
 </Suspense>
 );

 if (calcolatoreSubTab === 'payslip') {
 return (
 <>
 <DesktopTopBanner />
 <div className="w-full"><PayslipSimulator userProfile={userProfile} />{adBottom}</div>
 </>
 );
 }
 if (calcolatoreSubTab === 'whatif') {
 return (
 <>
 <DesktopTopBanner />
 <div className={`w-full transition-opacity duration-200${isResultStale ? ' opacity-50' : ''}`}>
 {result && <WhatIfSimulator baseInputs={inputs} baseResult={result} userProfile={userProfile} />}
 {adBottom}
 </div>
 </>
 );
 }
 if (calcolatoreSubTab === 'ral') {
 return (
 <>
 <DesktopTopBanner />
 <div className="max-w-7xl mx-auto"><RalComparator userProfile={userProfile} />{adBottom}</div>
 </>
 );
 }
 if (calcolatoreSubTab === 'bonus') {
 return (
 <>
 <DesktopTopBanner />
 <div className="max-w-7xl mx-auto"><BonusCalculator userProfile={userProfile} />{adBottom}</div>
 </>
 );
 }
 if (calcolatoreSubTab === 'parental-leave') {
 return (
 <>
 <DesktopTopBanner />
 <div className="max-w-7xl mx-auto"><ParentalLeaveCalculator userProfile={userProfile} />{adBottom}</div>
 </>
 );
 }
 if (calcolatoreSubTab === 'residency') {
 return (
 <>
 <DesktopTopBanner />
 <div className="max-w-7xl mx-auto"><ResidencySimulator />{adBottom}</div>
 </>
 );
 }
 if (calcolatoreSubTab === 'salary-quiz') {
 return (
 <>
 <DesktopTopBanner />
 <div className="max-w-7xl mx-auto"><SalaryQuiz />{adBottom}</div>
 </>
 );
 }
 return null;
}
