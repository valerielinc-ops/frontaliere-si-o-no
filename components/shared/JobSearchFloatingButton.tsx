import React, { useEffect, useState } from 'react';
import { Briefcase, Search } from 'lucide-react';

import { useTranslation, getCantonI18nParams, type Locale } from '@/services/i18n';
import { hasActiveSlot, subscribe } from '@/services/popupQueue';

import { hasVisibleBottomOverlay } from './visibleBottomOverlay';
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

function useFloatingButtonBlocked(): boolean {
  const [blocked, setBlocked] = useState(
    () => hasActiveSlot() || hasVisibleBottomOverlay(),
  );

  useEffect(() => {
    const sync = () => {
      setBlocked(hasActiveSlot() || hasVisibleBottomOverlay());
    };

    sync();
    const unsubscribe = subscribe(sync);
    const observer = typeof MutationObserver !== 'undefined' && document.body
      ? new MutationObserver(sync)
      : null;

    observer?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['aria-hidden', 'class', 'hidden', 'style'],
    });
    window.addEventListener('resize', sync, { passive: true });

    return () => {
      unsubscribe();
      observer?.disconnect();
      window.removeEventListener('resize', sync);
    };
  }, []);

  return blocked;
}

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
  const blocked = useFloatingButtonBlocked();

  if (isJobBoardPath(pathname) || blocked) return null;

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
      className="fixed right-3 md:right-4 bottom-[4.5rem] md:bottom-6 z-[53] flex h-12 w-12 items-center justify-center rounded-full bg-accent text-on-accent shadow-stripe-md transition-[color,background-color,border-color,box-shadow,transform] hover:bg-accent-hover hover:shadow-stripe-lg motion-reduce:transition-none group mb-[env(safe-area-inset-bottom,0px)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 md:h-14 md:w-14"
    >
      <span
        aria-hidden="true"
        className="inline-flex items-center justify-center gap-0.5 motion-safe:transition-transform motion-safe:duration-150 motion-safe:group-hover:scale-105"
      >
        <Briefcase
          aria-hidden="true"
          className="h-6 w-6 md:h-7 md:w-7"
          strokeWidth={2}
        />
        <Search
          aria-hidden="true"
          className="h-4 w-4 md:h-[18px] md:w-[18px]"
          strokeWidth={2}
        />
      </span>
    </a>
  );
};

export default JobSearchFloatingButton;
