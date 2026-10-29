import React from 'react';
import { Briefcase, Search } from 'lucide-react';

import { useTranslation, getCantonI18nParams, type Locale } from '@/services/i18n';
import {
  JOB_BOARD_PREFIX,
  JOB_BOARD_PREFIX_LEGACY_DE,
  JOB_BOARD_CANTON_AGGREGATE,
  getAggregatorJobBoardSlug,
} from '@/services/jobBoardSlugs';

const NON_ITALIAN_LOCALE_PREFIXES = new Set(['en', 'de', 'fr']);
const JOB_BOARD_PATH_PREFIXES = [
  ...Object.values(JOB_BOARD_PREFIX),
  JOB_BOARD_PREFIX_LEGACY_DE,
].map((prefix) => prefix.toLowerCase());

/** True for job-board roots and their nested pages in every supported locale. */
export function isJobBoardPath(pathname: string): boolean {
  const segments = String(pathname || '')
    .split(/[?#]/, 1)[0]
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());

  if (NON_ITALIAN_LOCALE_PREFIXES.has(segments[0] || '')) segments.shift();
  const firstSegment = segments[0] || '';
  return JOB_BOARD_PATH_PREFIXES.some((prefix) => firstSegment.startsWith(prefix));
}

/** Build the canonical Switzerland-wide job-search route for the active locale. */
export function buildJobSearchHref(locale: Locale): string {
  const localePrefix = locale === 'it' ? '' : `/${locale}`;
  return `${localePrefix}/${getAggregatorJobBoardSlug(locale)}/`;
}

const JobSearchFloatingButton: React.FC = () => {
  const { t, locale } = useTranslation();
  const pathname = typeof window !== 'undefined' ? window.location.pathname : '';

  if (isJobBoardPath(pathname)) return null;

  const label = t(
    'jobBoard.homeCta.mobile.title',
    getCantonI18nParams(JOB_BOARD_CANTON_AGGREGATE),
  );

  return (
    <a
      href={buildJobSearchHref(locale)}
      aria-label={label}
      title={label}
      data-testid="job-search-floating-button"
      className="fixed right-3 md:right-4 bottom-[4.5rem] md:bottom-6 z-[53] w-12 h-12 md:w-14 md:h-14 rounded-full bg-accent hover:bg-accent-hover text-on-accent shadow-lg hover:shadow-xl transition-[color,background-color,border-color,box-shadow,transform] flex items-center justify-center group mb-[env(safe-area-inset-bottom,0px)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
    >
      <span
        aria-hidden="true"
        className="relative block w-8 h-8 md:w-9 md:h-9 group-hover:scale-105 transition-transform"
      >
        <Briefcase
          size={27}
          strokeWidth={2.2}
          className="absolute right-0 top-0 md:w-8 md:h-8"
        />
        <Search
          size={17}
          strokeWidth={2.4}
          className="absolute left-0 bottom-0 md:w-5 md:h-5"
        />
      </span>
    </a>
  );
};

export default JobSearchFloatingButton;
