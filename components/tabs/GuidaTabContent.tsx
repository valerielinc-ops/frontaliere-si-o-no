import React, { Suspense } from 'react';
import { lazyRetry } from '@/services/lazyRetry';
import { useTranslation } from '@/services/i18n';
import { useNavigation } from '@/services/NavigationContext';
import { useTabContent } from '@/services/TabContentContext';
import DataFreshness from '@/components/shared/DataFreshness';

const AdSenseBanner = lazyRetry(() => import('@/components/shared/AdSenseBanner'));
import { AD_SLOTS } from '@/services/adsenseSlots';
const SeoContentBlock = lazyRetry(() => import('@/components/shared/SeoContentBlock'));
const FrontierGuide = lazyRetry(() => import('@/components/guide/FrontierGuide'));
const TrafficAlerts = lazyRetry(() => import('@/components/guide/TrafficAlerts'));
const CarCostCalculator = lazyRetry(() => import('@/components/guide/CarCostCalculator'));
const PermitCompare = lazyRetry(() => import('@/components/guide/PermitCompare'));
const BorderMunicipalitiesMap = lazyRetry(() => import('@/components/guide/BorderMunicipalitiesMap'));

export default function GuidaTabContent() {
 const { t } = useTranslation();
 const { guidaSubTab } = useNavigation();
 const { userProfile, borderCrossing } = useTabContent();

 return (
 <div className="max-w-7xl mx-auto">
 <div data-speakable>
 <h1 className="text-base sm:text-2xl font-bold font-display text-heading mb-2 sm:mb-4">{t('seoContent.guida.title')}</h1>
 </div>
 <DataFreshness lastUpdated="2026-04" source={t('freshness.source.ufficiMigrazione')} sourceUrl="https://www.sem.admin.ch" variant="badge" />
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

 {/* AdSense — bottom multiplex */}
 <Suspense fallback={null}>
 <AdSenseBanner adSlot={AD_SLOTS.ARTICLE_END_MULTIPLEX.slot} adFormat={AD_SLOTS.ARTICLE_END_MULTIPLEX.format} className="mt-8 mb-4" />
 </Suspense>
 </div>
 );
}
