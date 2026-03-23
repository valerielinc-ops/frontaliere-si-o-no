import React, { Suspense } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { useNavigation } from '@/services/NavigationContext';
import { useTabContent } from '@/services/TabContentContext';
import { SkeletonFisco } from '@/components/shared/Skeletons';

const SeoContentBlock = lazyRetry(() => import('@/components/shared/SeoContentBlock'));
const FrontierGuide = lazyRetry(() => import('@/components/guide/FrontierGuide'));
const TaxReturnGuide = lazyRetry(() => import('@/components/fisco/TaxReturnGuide'));
const WithholdingRatesHub = lazyRetry(() => import('@/components/fisco/WithholdingRatesHub'));
const TaxCalendar = lazyRetry(() => import('@/components/fisco/TaxCalendar'));
const RistorniTracker = lazyRetry(() => import('@/components/fisco/RistorniTracker'));
const PensionPlanner = lazyRetry(() => import('@/components/fisco/PensionPlanner'));
const Pillar3Simulator = lazyRetry(() => import('@/components/fisco/Pillar3Simulator'));
const WeeklyQuiz = lazyRetry(() => import('@/components/fisco/WeeklyQuiz'));
const TaxCreditCalculator = lazyRetry(() => import('@/components/fisco/TaxCreditCalculator'));

export default function FiscoTabContent() {
  const { fiscoSubTab } = useNavigation();
  const { taxReturnCountry, setTaxReturnCountry, userProfile } = useTabContent();

  return (
    <div className="max-w-7xl mx-auto">
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
      ) : null}
    </div>
  );
}
