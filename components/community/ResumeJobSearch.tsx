import React from 'react';
import { Search, X } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import {
  countJobBoardSearchResumeFilters,
  hasUsefulJobBoardSearchResume,
  type JobBoardSearchResume,
} from '@/services/jobBoardSearchResume';

interface ResumeJobSearchProps {
  search: JobBoardSearchResume;
  cantonLabel: string;
  onResume: () => void;
  onClear: () => void;
}

export default function ResumeJobSearch({ search, cantonLabel, onResume, onClear }: ResumeJobSearchProps) {
  const { t } = useTranslation();
  if (!hasUsefulJobBoardSearchResume(search)) return null;

  const routeCity = search.routeSlug?.replace(/^(?:localita|location|standort|localite)-/, '')
    .split('-')
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase('en')}${part.slice(1)}`)
    .join(' ');
  const selectedLocation = search.location === 'all'
    ? ''
    : search.location.split(' ').map((part) => `${part.charAt(0).toLocaleUpperCase('en')}${part.slice(1)}`).join(' ');
  const locationParts = Array.from(new Set([routeCity, selectedLocation].filter(Boolean)));
  const locationSummary = locationParts.length ? ` · ${locationParts.join(', ')}` : '';

  const summary = search.keyword
    ? t('jobBoard.resumeSearch.keywordSummary', { query: search.keyword, canton: cantonLabel, location: locationSummary })
    : t('jobBoard.resumeSearch.filterSummary', {
      count: countJobBoardSearchResumeFilters(search),
      canton: cantonLabel,
      location: locationSummary,
    });

  return (
    <section
      role="status"
      data-testid="resume-job-search"
      className="flex flex-wrap items-center gap-3 rounded-xl border border-accent-border/50 bg-accent-subtle px-3 py-3 text-sm text-body"
    >
      <Search className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold text-heading">{t('jobBoard.resumeSearch.title')}</p>
        <p className="truncate text-xs text-subtle" title={summary}>{summary}</p>
      </div>
      <button
        type="button"
        onClick={onResume}
        data-testid="resume-job-search-action"
        className="min-h-[44px] shrink-0 rounded-lg bg-accent px-3 text-sm font-semibold text-on-accent hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
      >
        {t('jobBoard.resumeSearch.resume')}
      </button>
      <button
        type="button"
        onClick={onClear}
        aria-label={t('jobBoard.resumeSearch.clear')}
        data-testid="resume-job-search-clear"
        className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-raised hover:text-body focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </section>
  );
}
