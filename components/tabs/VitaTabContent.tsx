import React, { Suspense } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { useNavigation } from '@/services/NavigationContext';
import { useTabContent } from '@/services/TabContentContext';
import { SkeletonComparator } from '@/components/shared/Skeletons';

const AdSenseBanner = lazyRetry(() => import('@/components/shared/AdSenseBanner'));
const SeoContentBlock = lazyRetry(() => import('@/components/shared/SeoContentBlock'));
const FrontierGuide = lazyRetry(() => import('@/components/guide/FrontierGuide'));
const TicinoCompanies = lazyRetry(() => import('@/components/vita/TicinoCompanies'));
const NurseryComparator = lazyRetry(() => import('@/components/comparators/NurseryComparator'));
const TransportCalculator = lazyRetry(() => import('@/components/vita/TransportCalculator'));

export default function VitaTabContent() {
  const { vitaSubTab } = useNavigation();
  const { userProfile } = useTabContent();

  return (
    <div className="max-w-7xl mx-auto">
      <Suspense fallback={<div className="min-h-[44px]" />}>
        <SeoContentBlock context="vita" />
      </Suspense>
      {vitaSubTab === 'living-ch' ? (
        <FrontierGuide activeSection="living-ch" />
      ) : vitaSubTab === 'living-it' ? (
        <FrontierGuide activeSection="living-it" />
      ) : vitaSubTab === 'companies' ? (
        <Suspense fallback={<SkeletonComparator />}><TicinoCompanies /></Suspense>
      ) : vitaSubTab === 'schools' ? (
        <FrontierGuide activeSection="schools" />
      ) : vitaSubTab === 'nursery' ? (
        <NurseryComparator userProfile={userProfile} />
      ) : vitaSubTab === 'places' ? (
        <FrontierGuide activeSection="places" />
      ) : vitaSubTab === 'transport' ? (
        <TransportCalculator />
      ) : vitaSubTab === 'municipalities' ? (
        <FrontierGuide activeSection="municipalities" />
      ) : null}

      {/* AdSense — bottom multiplex */}
      <Suspense fallback={null}>
        <AdSenseBanner adSlot="5196931137" adFormat="autorelaxed" className="mt-8 mb-4" />
      </Suspense>
    </div>
  );
}
