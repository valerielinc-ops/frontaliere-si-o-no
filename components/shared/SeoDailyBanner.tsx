/**
 * SeoDailyBanner — home page 3-card strip that funnels traffic from the
 * calculator hero down to the 3 highest-value daily/weekly SEO feature
 * pages (fuel-daily today, job-market-snapshot weekly, weekly-employers).
 *
 * Internal linking — layer 2A. Sits above the fold but BELOW the hero/CTA
 * so it doesn't compete with the primary conversion. Links use real HTTP
 * URLs (not SPA soft-nav) because the targets are server-rendered static
 * pages; browsers treat the transition as a full navigation, which matches
 * user expectation for "today's prices / this week's jobs" content.
 */

import React from 'react';
import { Fuel, TrendingUp, Building2 } from 'lucide-react';
import { useTranslation, type Locale } from '@/services/i18n';
import { buildFuelTodayPath } from '@/build-plugins/fuelDailyData';
import { buildCurrentWeekPath } from '@/build-plugins/weeklyEmployersData';
import { buildHubPath as buildJobMarketHubPath } from '@/build-plugins/jobMarketSnapshotData';
import { useKillSwitches, type KillSwitchKey } from '@/hooks/useKillSwitches';

interface BannerCard {
  readonly titleKey: string;
  readonly descKey: string;
  readonly ctaKey: string;
  readonly href: string;
  readonly Icon: typeof Fuel;
  readonly iconBgClass: string;
  readonly iconColorClass: string;
  readonly killSwitch: KillSwitchKey;
}

export interface SeoDailyBannerProps {
  /** Locale for URL building (defaults to current app locale). */
  readonly locale?: Locale;
  /** Optional className for wrapper overrides. */
  readonly className?: string;
}

export default function SeoDailyBanner({
  locale: propLocale,
  className,
}: SeoDailyBannerProps) {
  const { t, locale: appLocale } = useTranslation();
  const locale = propLocale ?? appLocale;
  const killSwitches = useKillSwitches();

  const cards: readonly BannerCard[] = [
    {
      titleKey: 'seoLinks.banner.fuelTitle',
      descKey: 'seoLinks.banner.fuelDesc',
      ctaKey: 'seoLinks.banner.fuelCta',
      href: buildFuelTodayPath(locale, 'diesel'),
      Icon: Fuel,
      iconBgClass: 'bg-warning-subtle',
      iconColorClass: 'text-warning',
      killSwitch: 'fuelDaily',
    },
    {
      titleKey: 'seoLinks.banner.jobsTitle',
      descKey: 'seoLinks.banner.jobsDesc',
      ctaKey: 'seoLinks.banner.jobsCta',
      href: buildJobMarketHubPath(locale),
      Icon: TrendingUp,
      iconBgClass: 'bg-accent-subtle',
      iconColorClass: 'text-accent',
      killSwitch: 'jobMarket',
    },
    {
      titleKey: 'seoLinks.banner.employersTitle',
      descKey: 'seoLinks.banner.employersDesc',
      ctaKey: 'seoLinks.banner.employersCta',
      href: buildCurrentWeekPath(locale, 'ticino'),
      Icon: Building2,
      iconBgClass: 'bg-success-subtle',
      iconColorClass: 'text-success',
      killSwitch: 'weeklyEmployers',
    },
  ] as const;

  const visibleCards = cards.filter((card) => !killSwitches[card.killSwitch]);

  // If every card is killed, render nothing — avoids an empty <nav> shell.
  if (visibleCards.length === 0) {
    return null;
  }

  return (
    <nav
      aria-label={t('seoLinks.banner.ariaLabel')}
      className={`w-full ${className ?? ''}`.trim()}
      data-testid="seo-daily-banner"
    >
      <ul className="grid grid-cols-1 sm:grid-cols-3 gap-3 list-none p-0 m-0">
        {visibleCards.map((card) => (
          <li key={card.href} className="flex">
            <a
              href={card.href}
              aria-label={`${t(card.titleKey)} — ${t(card.ctaKey)}`}
              className="group flex-1 flex items-start gap-3 px-4 py-3 bg-surface border border-edge hover:border-accent-border rounded-xl text-strong transition-[color,background-color,border-color,box-shadow] hover:shadow-sm no-underline"
            >
              <div
                className={`p-2 rounded-lg shrink-0 ${card.iconBgClass}`}
                aria-hidden="true"
              >
                <card.Icon size={18} className={card.iconColorClass} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold leading-tight">
                  {t(card.titleKey)}
                </div>
                <div className="text-xs text-subtle mt-0.5 line-clamp-2">
                  {t(card.descKey)}
                </div>
                <div className="text-xs text-accent font-semibold mt-1 group-hover:underline">
                  {t(card.ctaKey)} →
                </div>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
