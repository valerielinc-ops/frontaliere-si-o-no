import React, { Suspense } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { useNavigation } from '@/services/NavigationContext';

const AdSenseBanner = lazyRetry(() => import('@/components/shared/AdSenseBanner'));
const SeoContentBlock = lazyRetry(() => import('@/components/shared/SeoContentBlock'));
const StatsView = lazyRetry(() => import('@/components/pages/StatsView').then(m => ({ default: m.StatsView as any })));
const LivabilityIndex = lazyRetry(() => import('@/components/vita/LivabilityIndex'));
const JobsSalaryObservatory = lazyRetry(() => import('@/components/pages/JobsSalaryObservatory'));
const SalaryCompare = lazyRetry(() => import('@/components/comparators/SalaryCompare'));
const TrafficHistory = lazyRetry(() => import('@/components/guide/TrafficHistory'));
const UnemploymentStats = lazyRetry(() => import('@/components/pages/UnemploymentStats'));
const MortgageComparison = lazyRetry(() => import('@/components/comparators/MortgageComparison'));
const FuelPriceStats = lazyRetry(() => import('@/components/pages/FuelPriceStats'));
const HealthPremiumStats = lazyRetry(() => import('@/components/pages/HealthPremiumStats'));

export default function StatsTabContent() {
  const { statsSubTab } = useNavigation();

  return (
    <div className="max-w-7xl mx-auto">
      <Suspense fallback={<div className="min-h-[44px]" />}>
        <SeoContentBlock context="stats" />
      </Suspense>
      {statsSubTab === 'overview' ? (
        <StatsView />
      ) : statsSubTab === 'livability' ? (
        <LivabilityIndex />
      ) : statsSubTab === 'jobs-observatory' ? (
        <JobsSalaryObservatory />
      ) : statsSubTab === 'salary-compare' ? (
        <SalaryCompare />
      ) : statsSubTab === 'traffic-history' ? (
        <TrafficHistory />
      ) : statsSubTab === 'unemployment' ? (
        <UnemploymentStats />
      ) : statsSubTab === 'mortgage' ? (
        <MortgageComparison />
      ) : statsSubTab === 'fuel-prices' ? (
        <FuelPriceStats />
      ) : statsSubTab === 'health-premiums' ? (
        <HealthPremiumStats />
      ) : null}

      {/* AdSense — bottom multiplex */}
      <Suspense fallback={null}>
        <AdSenseBanner adSlot="5196931137" adFormat="autorelaxed" className="mt-8 mb-4" />
      </Suspense>
    </div>
  );
}
