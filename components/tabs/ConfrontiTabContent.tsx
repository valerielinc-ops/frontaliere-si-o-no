import React, { Suspense } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { useNavigation } from '@/services/NavigationContext';
import { useTabContent } from '@/services/TabContentContext';

const AdSenseBanner = lazyRetry(() => import('@/components/shared/AdSenseBanner'));
import { AD_SLOTS } from '@/services/adsenseSlots';
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
 <div className="max-w-7xl mx-auto min-h-[60vh] space-y-8">
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

 {/* AdSense — mid-content display ad */}
 {confrontiSubTab && (
 <Suspense fallback={null}>
 <AdSenseBanner adSlot={AD_SLOTS.HOMEPAGE_MID_DISPLAY.slot} adFormat={AD_SLOTS.HOMEPAGE_MID_DISPLAY.format} fullWidthResponsive={AD_SLOTS.HOMEPAGE_MID_DISPLAY.fullWidthResponsive} className="my-6" />
 </Suspense>
 )}

 {/* AdSense — bottom multiplex */}
 <Suspense fallback={null}>
 <AdSenseBanner adSlot={AD_SLOTS.ARTICLE_END_MULTIPLEX.slot} adFormat={AD_SLOTS.ARTICLE_END_MULTIPLEX.format} className="mt-8 mb-4" />
 </Suspense>
 </div>
 );
}
