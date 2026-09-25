/**
 * QuickLinksGrid — homepage internal-linking section that promotes the
 * highest-traffic "today" / "hub" SEO pages to depth 2 (home → target).
 *
 * Why this exists:
 *   Semrush crawl found 7,384 pages at depth >3 (mostly /traffico-dogane/
 *   /{crossing}/oggi/, /prezzi-diesel/*, weekly-employers) and 4,548 orphan
 *   sitemap pages. Rendering this grid on the home lifts the top crossings
 *   + fuel hub + traffic hub from depth 5-6 to depth 2, which reduces crawl
 *   waste and concentrates link equity on intent-heavy landings.
 *
 * Design rules respected:
 *   - Every link has accessible text (no icon-only anchors)
 *   - Semantic CSS tokens only (text-heading, text-subtle, bg-surface …)
 *   - No `dark:` prefixes
 *   - Responsive grid: 2 cols mobile, 3 cols sm, 4 cols lg
 *   - All icons are aria-hidden; anchors carry aria-label for screen readers
 *   - Pure static links (no fetch on mount)
 */

import React from 'react';
import {
  Car,
  Fuel,
  MapPin,
} from 'lucide-react';
import { useTranslation, type Locale } from '@/services/i18n';
import { buildFuelTodayPath } from '@/build-plugins/fuelDailyData';
import {
  buildRootHubPath as buildBorderRootHubPath,
  buildOggiPath as buildBorderOggiPath,
  BORDER_CROSSING_DISPLAY,
  type BorderCrossingSlug,
  type BorderWaitLocale,
} from '@/build-plugins/borderWaitData';
import { useKillSwitches } from '@/hooks/useKillSwitches';

/** Top-5 highest-GSC-traffic crossings — hardcoded order mirrors the Semrush report. */
const TOP_CROSSINGS: readonly BorderCrossingSlug[] = [
  'chiasso-brogeda',
  'gaggiolo',
  'ponte-tresa',
  'ronago-novazzano',
  'chiasso-strada',
] as const;

export interface QuickLinksGridProps {
  /** Locale for URL building (defaults to current app locale). */
  readonly locale?: Locale;
  /** Optional className for wrapper overrides. */
  readonly className?: string;
}

interface QuickLink {
  readonly href: string;
  readonly label: string;
  readonly description?: string;
  readonly Icon: typeof Car;
}

export default function QuickLinksGrid({
  locale: propLocale,
  className,
}: QuickLinksGridProps): React.ReactElement | null {
  const { t, locale: appLocale } = useTranslation();
  const locale = propLocale ?? appLocale;
  const killSwitches = useKillSwitches();
  const borderLocale = locale as BorderWaitLocale;

  const links: QuickLink[] = [];

  // Traffic / dogane hub — no kill switch (border-wait pages aren't gated).
  links.push({
    href: buildBorderRootHubPath(borderLocale),
    label: t('seoLinks.quickLinks.trafficHub'),
    description: t('seoLinks.quickLinks.trafficHubDesc'),
    Icon: Car,
  });

  // Fuel today — gated by KILL_FUEL_DAILY_LINKS.
  if (!killSwitches.fuelDaily) {
    links.push({
      href: buildFuelTodayPath(locale, 'diesel'),
      label: t('seoLinks.quickLinks.fuelToday'),
      description: t('seoLinks.quickLinks.fuelTodayDesc'),
      Icon: Fuel,
    });
  }

  // Top-5 crossings "oggi" pages.
  for (const crossing of TOP_CROSSINGS) {
    links.push({
      href: buildBorderOggiPath(borderLocale, crossing),
      label: BORDER_CROSSING_DISPLAY[crossing],
      description: t('seoLinks.quickLinks.crossingDesc'),
      Icon: MapPin,
    });
  }

  if (links.length === 0) return null;

  return (
    <nav
      aria-label={t('seoLinks.quickLinks.ariaLabel')}
      className={`w-full ${className ?? ''}`.trim()}
      data-testid="home-quick-links"
    >
      <h2 className="text-sm font-bold uppercase tracking-wider text-subtle mb-3">
        {t('seoLinks.quickLinks.title')}
      </h2>
      <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 list-none p-0 m-0">
        {links.map((link) => (
          <li key={link.href} className="flex">
            <a
              href={link.href}
              aria-label={link.description ? `${link.label} — ${link.description}` : link.label}
              className="group flex-1 flex items-start gap-2 px-3 py-2 bg-surface border border-edge hover:border-accent-border rounded-lg text-strong transition-[color,background-color,border-color,box-shadow] hover:shadow-sm no-underline"
            >
              <div
                className="p-1.5 rounded-md shrink-0 bg-accent-subtle"
                aria-hidden="true"
              >
                <link.Icon size={14} className="text-accent" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-xs sm:text-sm font-semibold leading-tight text-heading line-clamp-1">
                  {link.label}
                </div>
                {link.description ? (
                  <div className="text-[11px] sm:text-xs text-subtle mt-0.5 line-clamp-1">
                    {link.description}
                  </div>
                ) : null}
              </div>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
