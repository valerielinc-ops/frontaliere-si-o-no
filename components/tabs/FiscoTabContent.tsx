import React, { Suspense } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { useTranslation } from '@/services/i18n';
import { useNavigation } from '@/services/NavigationContext';
import { useTabContent } from '@/services/TabContentContext';
import { SkeletonFisco } from '@/components/shared/Skeletons';

const AdSenseBanner = lazyRetry(() => import('@/components/shared/AdSenseBanner'));
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
      <h1 className="text-2xl font-bold text-slate-800 dark:text-white mb-4">{t('seoContent.fisco.title')}</h1>
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

      {/* AdSense — bottom multiplex */}
      <Suspense fallback={null}>
        <AdSenseBanner adSlot="5196931137" adFormat="autorelaxed" className="mt-8 mb-4" />
      </Suspense>
    </div>
  );
}
