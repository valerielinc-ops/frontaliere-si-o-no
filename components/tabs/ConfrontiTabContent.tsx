import React, { Suspense } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { useNavigation } from '@/services/NavigationContext';
import { useTabContent } from '@/services/TabContentContext';

const SeoContentBlock = lazyRetry(() => import('@/components/shared/SeoContentBlock'));
const CurrencyExchange = lazyRetry(() => import('@/components/comparators/CurrencyExchange'));
const BankComparison = lazyRetry(() => import('@/components/comparators/BankComparison'));
const HealthInsurance = lazyRetry(() => import('@/components/comparators/HealthInsurance'));
const MobileOperators = lazyRetry(() => import('@/components/comparators/MobileOperators'));
const ShoppingCalculator = lazyRetry(() => import('@/components/comparators/ShoppingCalculator'));
const CostOfLiving = lazyRetry(() => import('@/components/comparators/CostOfLiving'));
const JobComparator = lazyRetry(() => import('@/components/comparators/JobComparator'));
const RenovationCalculator = lazyRetry(() => import('@/components/comparators/RenovationCalculator'));

export default function ConfrontiTabContent() {
  const { confrontiSubTab } = useNavigation();
  const { result, inputs, userProfile } = useTabContent();

  return (
    <div className="max-w-7xl mx-auto min-h-[60vh]">
      <Suspense fallback={<div className="min-h-[44px]" />}>
        <SeoContentBlock context="confronti" />
      </Suspense>
      {confrontiSubTab === 'exchange' ? (
        <CurrencyExchange />
      ) : confrontiSubTab === 'banks' ? (
        <BankComparison />
      ) : confrontiSubTab === 'health' ? (
        <HealthInsurance />
      ) : confrontiSubTab === 'mobile' ? (
        <MobileOperators />
      ) : confrontiSubTab === 'shopping' ? (
        <ShoppingCalculator />
      ) : confrontiSubTab === 'cost-of-living' ? (
        <CostOfLiving />
      ) : confrontiSubTab === 'jobs' ? (
        <JobComparator userProfile={userProfile} />
      ) : confrontiSubTab === 'renovation' ? (
        <RenovationCalculator simulationResult={result ?? undefined} simulationInputs={inputs} />
      ) : null}
    </div>
  );
}
