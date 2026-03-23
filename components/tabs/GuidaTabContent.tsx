import React, { Suspense } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { useNavigation } from '@/services/NavigationContext';
import { useTabContent } from '@/services/TabContentContext';

const SeoContentBlock = lazyRetry(() => import('@/components/shared/SeoContentBlock'));
const FrontierGuide = lazyRetry(() => import('@/components/guide/FrontierGuide'));
const TrafficAlerts = lazyRetry(() => import('@/components/guide/TrafficAlerts'));
const CarCostCalculator = lazyRetry(() => import('@/components/guide/CarCostCalculator'));
const PermitCompare = lazyRetry(() => import('@/components/guide/PermitCompare'));
const BorderMunicipalitiesMap = lazyRetry(() => import('@/components/guide/BorderMunicipalitiesMap'));

export default function GuidaTabContent() {
  const { guidaSubTab } = useNavigation();
  const { userProfile, borderCrossing } = useTabContent();

  return (
    <div className="max-w-7xl mx-auto">
      <Suspense fallback={<div className="min-h-[44px]" />}>
        <SeoContentBlock context="guida" />
      </Suspense>
      {guidaSubTab === 'first-day' ? (
        <FrontierGuide activeSection="first-day" />
      ) : guidaSubTab === 'permits' ? (
        <FrontierGuide activeSection="permits" />
      ) : guidaSubTab === 'border' ? (
        <TrafficAlerts initialCrossingId={borderCrossing || undefined} />
      ) : guidaSubTab === 'unemployment' ? (
        <FrontierGuide activeSection="unemployment" />
      ) : guidaSubTab === 'car-transfer' ? (
        <FrontierGuide activeSection="car-transfer" />
      ) : guidaSubTab === 'car-cost' ? (
        <CarCostCalculator />
      ) : guidaSubTab === 'permit-compare' ? (
        <PermitCompare userProfile={userProfile} />
      ) : guidaSubTab === 'border-map' ? (
        <BorderMunicipalitiesMap userProfile={userProfile} />
      ) : null}
    </div>
  );
}
