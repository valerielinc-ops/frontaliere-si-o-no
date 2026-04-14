import React, { Suspense } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { useTranslation } from '@/services/i18n';
import { useNavigation } from '@/services/NavigationContext';
import { useTabContent } from '@/services/TabContentContext';
import { SkeletonFisco } from '@/components/shared/Skeletons';
import AiExtractableTable from '@/components/shared/AiExtractableTable';
import FaqAccordion from '@/components/shared/FaqAccordion';
import DataFreshness from '@/components/shared/DataFreshness';

const AdSenseBanner = lazyRetry(() => import('@/components/shared/AdSenseBanner'));
import { AD_SLOTS } from '@/services/adsenseSlots';
const SeoContentBlock = lazyRetry(() => import('@/components/shared/SeoContentBlock'));
const FrontierGuide = lazyRetry(() => import('@/components/guide/FrontierGuide'));
const TaxReturnGuide = lazyRetry(() => import('@/components/fisco/TaxReturnGuide'));
const WithholdingRatesHub = lazyRetry(() => import('@/components/fisco/WithholdingRatesHub'));
const NewFrontierTaxSimHub = lazyRetry(() => import('@/components/fisco/NewFrontierTaxSimHub'));
const TaxCalendar = lazyRetry(() => import('@/components/fisco/TaxCalendar'));
const RistorniTracker = lazyRetry(() => import('@/components/fisco/RistorniTracker'));
const PensionPlanner = lazyRetry(() => import('@/components/fisco/PensionPlanner'));
const Pillar3Simulator = lazyRetry(() => import('@/components/fisco/Pillar3Simulator'));
const WeeklyQuiz = lazyRetry(() => import('@/components/fisco/WeeklyQuiz'));
const TaxCreditCalculator = lazyRetry(() => import('@/components/fisco/TaxCreditCalculator'));

export default function FiscoTabContent() {
 const { t } = useTranslation();
 const { fiscoSubTab } = useNavigation();
 const { taxReturnCountry, setTaxReturnCountry, userProfile } = useTabContent();

 return (
 <div className="max-w-7xl mx-auto">
 <div data-speakable>
 <h1 className="text-base sm:text-2xl font-bold text-heading mb-2 sm:mb-4">{t('seoContent.fisco.title')}</h1>
 </div>
 <DataFreshness lastUpdated="2026-04" source={t('freshness.source.cantonTicino')} sourceUrl="https://www4.ti.ch/dfe/dc" variant="badge" />
 <Suspense fallback={<div className="min-h-[44px]" />}>
 <SeoContentBlock context="fisco" />
 </Suspense>
 {fiscoSubTab === 'tax-return' ? (
 <TaxReturnGuide initialCountry={taxReturnCountry} onCountryChange={setTaxReturnCountry} />
 ) : fiscoSubTab === 'withholding-rates' ? (
 <Suspense fallback={<SkeletonFisco />}><WithholdingRatesHub /></Suspense>
 ) : fiscoSubTab === 'calendar' ? (
 <Suspense fallback={<SkeletonFisco />}><TaxCalendar /></Suspense>
 ) : fiscoSubTab === 'holidays' ? (
 <FrontierGuide activeSection="holidays" />
 ) : fiscoSubTab === 'ristorni' ? (
 <RistorniTracker />
 ) : fiscoSubTab === 'pension' ? (
 <PensionPlanner userProfile={userProfile} />
 ) : fiscoSubTab === 'pillar3' ? (
 <Pillar3Simulator />
 ) : fiscoSubTab === 'quiz' ? (
 <Suspense fallback={<SkeletonFisco />}><WeeklyQuiz /></Suspense>
 ) : fiscoSubTab === 'tax-credit' ? (
 <Suspense fallback={<SkeletonFisco />}><TaxCreditCalculator /></Suspense>
 ) : fiscoSubTab === 'new-frontier-tax-sim' ? (
 <Suspense fallback={<SkeletonFisco />}><NewFrontierTaxSimHub /></Suspense>
 ) : null}

 {/* AI-extractable comparison table + FAQ — in <details> for crawlability without breaking page flow */}
 {!fiscoSubTab && (
 <details className="mt-6 group">
 <summary className="cursor-pointer list-none flex items-center gap-2 text-sm font-medium text-accent hover:text-stripe-800 dark:hover:text-stripe-300 transition-colors">
 <svg className="w-4 h-4 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
 {t('fisco.table.caption')}
 </summary>
 <div className="mt-3">
 <AiExtractableTable
 caption={t('fisco.table.caption')}
 columns={[
 { header: t('fisco.table.col.aspect'), accessor: 'aspect' },
 { header: t('fisco.table.col.old'), accessor: 'old' },
 { header: t('fisco.table.col.new'), accessor: 'new' },
 ]}
 rows={[
 { aspect: t('fisco.table.row1.aspect'), old: t('fisco.table.row1.old'), new: t('fisco.table.row1.new') },
 { aspect: t('fisco.table.row2.aspect'), old: t('fisco.table.row2.old'), new: t('fisco.table.row2.new') },
 { aspect: t('fisco.table.row3.aspect'), old: t('fisco.table.row3.old'), new: t('fisco.table.row3.new') },
 { aspect: t('fisco.table.row4.aspect'), old: t('fisco.table.row4.old'), new: t('fisco.table.row4.new') },
 { aspect: t('fisco.table.row5.aspect'), old: t('fisco.table.row5.old'), new: t('fisco.table.row5.new') },
 ]}
 source={t('fisco.table.source')}
 />
 <FaqAccordion
 title={t('fisco.faq.title')}
 items={[
 { question: t('fisco.faq.q1'), answer: t('fisco.faq.a1') },
 { question: t('fisco.faq.q2'), answer: t('fisco.faq.a2') },
 { question: t('fisco.faq.q3'), answer: t('fisco.faq.a3') },
 ]}
 className="mt-4"
 />
 </div>
 </details>
 )}

 {/* AdSense — bottom multiplex */}
 <Suspense fallback={null}>
 <AdSenseBanner adSlot={AD_SLOTS.ARTICLE_END_MULTIPLEX.slot} adFormat={AD_SLOTS.ARTICLE_END_MULTIPLEX.format} className="mt-8 mb-4" />
 </Suspense>
 </div>
 );
}
