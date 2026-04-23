/**
 * WeeklyEmployersTeaser — footer strip that links to the 10 highest-value
 * {company × city} weekly-employers pages so the orphan sitemap closes.
 *
 * Why this exists:
 *   Semrush found 4,548 orphan pages listed in `sitemap-weekly-employers.xml`
 *   (/aziende-che-assumono/{city}/{company}/settimana-corrente/). The pages
 *   are generated on every build but no internal anchor pointed to them,
 *   so Google kept them at low priority / depth ∞ in the link graph. This
 *   component surfaces 10 hand-picked combos in every footer render,
 *   instantly giving every one of them a depth-2 incoming link.
 *
 * Data:
 *   Hardcoded top-10 list based on the Semrush report and the active
 *   crawler set. The list is safer than reading runtime data at build-time
 *   because it never depends on whether the weekly-employers JSON snapshot
 *   is fresh when the footer renders; stale entries still point at valid
 *   static pages (the company-city path generator always runs for every
 *   qualifying employer with ≥3 active jobs).
 *
 * Design rules respected:
 *   - Every link has accessible text
 *   - Semantic CSS tokens only
 *   - No `dark:` prefixes
 *   - Kill-switch aware (hidden when KILL_WEEKLY_EMPLOYERS_LINKS=true)
 *   - Pure static links, no fetch on mount
 */

import React from 'react';
import { Building2 } from 'lucide-react';
import { useTranslation, type Locale } from '@/services/i18n';
import {
  buildCompanyCityCurrentPath,
  canonicalCompanySlug,
  type WeeklyEmployersCompanyCity,
  type WeeklyEmployersLocale,
} from '@/build-plugins/weeklyEmployersData';
import { useKillSwitches } from '@/hooks/useKillSwitches';

interface EmployerEntry {
  readonly company: string;
  readonly companyKey?: string;
  readonly city: WeeklyEmployersCompanyCity;
}

/**
 * Top-10 high-traffic employer × city combos. Ordering follows Semrush +
 * GSC impressions for queries like "EOC lavoro bellinzona", "migrolino
 * assume", "armasuisse lavoro" etc.
 */
const TOP_EMPLOYERS: readonly EmployerEntry[] = [
  { company: 'EOC Ente Ospedaliero Cantonale', city: 'bellinzona' },
  { company: 'Swisscom', city: 'bellinzona' },
  { company: 'Migrolino', city: 'bellinzona' },
  { company: 'Allianz Suisse', city: 'lugano' },
  { company: 'AFRY', city: 'lugano' },
  { company: 'Swisscom', city: 'lugano' },
  { company: 'Lidl', companyKey: 'lidl', city: 'mendrisio' },
  { company: 'EOC Ente Ospedaliero Cantonale', city: 'lugano' },
  { company: 'Pemsa', city: 'chiasso' },
  { company: 'Amministrazione Cantonale Ticino', city: 'bellinzona' },
] as const;

export interface WeeklyEmployersTeaserProps {
  /** Locale for URL building (defaults to current app locale). */
  readonly locale?: Locale;
  /** Optional className for wrapper overrides. */
  readonly className?: string;
}

export default function WeeklyEmployersTeaser({
  locale: propLocale,
  className,
}: WeeklyEmployersTeaserProps): React.ReactElement | null {
  const { t, locale: appLocale } = useTranslation();
  const locale = (propLocale ?? appLocale) as WeeklyEmployersLocale;
  const killSwitches = useKillSwitches();

  if (killSwitches.weeklyEmployers) return null;

  const entries = TOP_EMPLOYERS.map((entry) => {
    const slug = canonicalCompanySlug(entry.company, entry.companyKey);
    const href = buildCompanyCityCurrentPath(locale, entry.city, slug);
    const cityLabel = entry.city.charAt(0).toUpperCase() + entry.city.slice(1);
    return {
      href,
      company: entry.company,
      city: cityLabel,
    };
  });

  return (
    <nav
      aria-label={t('seoLinks.footer.weeklyEmployersTeaser.title')}
      data-testid="footer-weekly-employers-teaser"
      className={`border-t border-edge/50 pt-3 pb-2 ${className ?? ''}`.trim()}
    >
      <h3 className="text-xs font-bold uppercase tracking-wider text-subtle mb-2 text-center">
        {t('seoLinks.footer.weeklyEmployersTeaser.title')}
      </h3>
      <ul className="flex flex-wrap items-center justify-center gap-x-3 gap-y-2 list-none p-0 m-0">
        {entries.map((entry) => (
          <li key={entry.href}>
            <a
              href={entry.href}
              aria-label={`${entry.company} — ${entry.city}`}
              className="inline-flex items-center gap-1 text-xs text-subtle hover:text-accent transition-colors no-underline"
            >
              <Building2 className="w-3 h-3" aria-hidden="true" />
              <span className="font-medium">{entry.company}</span>
              <span className="text-edge">·</span>
              <span>{entry.city}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
