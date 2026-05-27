import React, { Suspense } from 'react';
import { Fuel, Heart, TrendingUp } from 'lucide-react';
import { lazyRetry } from '@/services/lazyRetry';
import { useTranslation } from '@/services/i18n';
import { useNavigation } from '@/services/NavigationContext';
import DataFreshness from '@/components/shared/DataFreshness';
import { buildFuelTodayPath } from '@/build-plugins/fuelDailyData';
import { buildHealthPremiumsCantonPath } from '@/build-plugins/healthPremiumsData';
import { buildHubPath as buildJobMarketHubPath } from '@/build-plugins/jobMarketSnapshotData';
import { useKillSwitches } from '@/hooks/useKillSwitches';

const AdSenseBanner = lazyRetry(() => import('@/components/shared/AdSenseBanner'));
import { AD_SLOTS } from '@/services/adsenseSlots';
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

interface StatsSeoBannerProps {
  readonly href: string;
  readonly Icon: typeof Fuel;
  readonly iconBgClass: string;
  readonly iconColorClass: string;
  readonly message: string;
  readonly cta: string;
  readonly ariaLabel: string;
}

function StatsSeoBanner({ href, Icon, iconBgClass, iconColorClass, message, cta, ariaLabel }: StatsSeoBannerProps) {
  return (
    <aside
      aria-label={ariaLabel}
      className="mb-4 rounded-xl border border-edge bg-surface px-4 py-3 flex items-start gap-3"
      data-testid="stats-seo-banner"
    >
      <div className={`p-2 rounded-lg shrink-0 ${iconBgClass}`} aria-hidden="true">
        <Icon size={18} className={iconColorClass} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-body leading-snug m-0">{message}</p>
        <a
          href={href}
          className="inline-block text-xs font-semibold text-accent hover:underline mt-1 no-underline"
        >
          {cta} →
        </a>
      </div>
    </aside>
  );
}

export default function StatsTabContent() {
 const { t, locale } = useTranslation();
 const { statsSubTab } = useNavigation();
 const killSwitches = useKillSwitches();

 return (
 <div className="max-w-7xl mx-auto">
 <div data-speakable>
 <h1 className="text-base sm:text-2xl font-bold font-display text-heading mb-2 sm:mb-4">{t('seoContent.stats.title')}</h1>
 </div>
 <DataFreshness lastUpdated="2026-04" source={t('freshness.source.bfs')} sourceUrl="https://www.bfs.admin.ch" variant="badge" />
 <Suspense fallback={<div className="min-h-[44px]" />}>
 <SeoContentBlock context="stats" />
 </Suspense>
 {/* Layer 2C — Internal linking: stats subtab banners pointing to static SEO pages */}
 {statsSubTab === 'fuel-prices' && !killSwitches.fuelDaily && (
 <StatsSeoBanner
 href={buildFuelTodayPath(locale, 'diesel')}
 Icon={Fuel}
 iconBgClass="bg-warning-subtle"
 iconColorClass="text-warning"
 message={t('seoLinks.stats.fuelBanner')}
 cta={t('seoLinks.stats.fuelBannerCta')}
 ariaLabel={t('seoLinks.stats.fuelBannerCta')}
 />
 )}
 {statsSubTab === 'health-premiums' && !killSwitches.healthPremiums && (
 <StatsSeoBanner
 href={buildHealthPremiumsCantonPath(locale, 'ticino')}
 Icon={Heart}
 iconBgClass="bg-success-subtle"
 iconColorClass="text-success"
 message={t('seoLinks.stats.healthBanner')}
 cta={t('seoLinks.stats.healthBannerCta')}
 ariaLabel={t('seoLinks.stats.healthBannerCta')}
 />
 )}
 {statsSubTab === 'jobs-observatory' && !killSwitches.jobMarket && (
 <StatsSeoBanner
 href={buildJobMarketHubPath(locale)}
 Icon={TrendingUp}
 iconBgClass="bg-accent-subtle"
 iconColorClass="text-accent"
 message={t('seoLinks.stats.jobsBanner')}
 cta={t('seoLinks.stats.jobsBannerCta')}
 ariaLabel={t('seoLinks.stats.jobsBannerCta')}
 />
 )}
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
 <AdSenseBanner adSlot={AD_SLOTS.ARTICLE_END_MULTIPLEX.slot} adFormat={AD_SLOTS.ARTICLE_END_MULTIPLEX.format} className="mt-8 mb-4" />
 </Suspense>
 </div>
 );
}
