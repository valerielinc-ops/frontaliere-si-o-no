/**
 * PopularSearchChips.tsx — 1-tap chips for the top real internal-search
 * terms mined from PostHog onsite `search` events (issue #4301,
 * `scripts/mine-search-location-gaps.mjs` → `data/search-location-gaps.json`
 * → `topRawSearchTerms`).
 *
 * Self-contained, single mount point in JobBoard.tsx: reads its own data,
 * dedupes autocomplete-keystroke fragments (e.g. "inf"/"infermier"/"infer"
 * are all prefixes of the already-present "infermiere" term — a byproduct
 * of the mining source recording every debounced onsite search keystroke,
 * not a mining bug), and calls back into the caller's existing
 * `applySearchQuery` — no new search state, no new component-local index.
 */
import React from 'react';
import { TrendingUp } from 'lucide-react';
import { useTranslation } from '@/services/i18n';
import searchGapsData from '@/data/search-location-gaps.json';

interface RawSearchTerm {
  rank: number;
  term: string;
  count: number;
}

const MIN_CHIP_TERM_LENGTH = 3;

/**
 * Dedupes prefix-fragment noise from the mined raw term list (partial
 * keystrokes captured mid-typing share a common full-word ancestor already
 * present with a higher search count) and returns up to `limit` terms in
 * mined-rank order. Pure + exported for unit testing.
 */
export function getPopularSearchChipTerms(
  rawTerms: readonly RawSearchTerm[],
  limit = 10,
): string[] {
  const sorted = [...rawTerms].sort((a, b) => a.rank - b.rank);
  const selected: string[] = [];
  for (const { term } of sorted) {
    const clean = term.trim();
    if (clean.length < MIN_CHIP_TERM_LENGTH) continue;
    const lower = clean.toLowerCase();
    const isPrefixOfSelected = selected.some((s) => {
      const sLower = s.toLowerCase();
      return sLower.startsWith(lower) || lower.startsWith(sLower);
    });
    if (isPrefixOfSelected) continue;
    selected.push(clean);
    if (selected.length >= limit) break;
  }
  return selected;
}

const POPULAR_CHIP_TERMS: readonly string[] = getPopularSearchChipTerms(
  (searchGapsData as { topRawSearchTerms?: RawSearchTerm[] }).topRawSearchTerms ?? [],
  10,
);

export interface PopularSearchChipsProps {
  /** Called with the tapped term; caller drives its own search state. */
  readonly onSelect: (term: string) => void;
  /** Current search box value, used only to highlight an active chip. */
  readonly activeTerm?: string;
  readonly className?: string;
}

function PopularSearchChips({
  onSelect,
  activeTerm,
  className,
}: PopularSearchChipsProps): React.ReactElement | null {
  const { t } = useTranslation();
  if (POPULAR_CHIP_TERMS.length < 3) return null;

  const activeLower = (activeTerm ?? '').trim().toLowerCase();

  return (
    <div className={className ?? 'space-y-1.5'}>
      <span className="text-xs font-semibold text-muted uppercase tracking-wider inline-flex items-center gap-1">
        <TrendingUp className="w-3.5 h-3.5" aria-hidden="true" />
        {t('jobBoard.popularSearches.label')}
      </span>
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-hide" role="group" aria-label={t('jobBoard.popularSearches.label')}>
        {POPULAR_CHIP_TERMS.map((term) => {
          const active = term.toLowerCase() === activeLower;
          return (
            <button
              key={term}
              type="button"
              onClick={() => onSelect(active ? '' : term)}
              className={`flex-shrink-0 inline-flex items-center px-3 py-1.5 min-h-11 text-xs font-medium rounded-full border transition-[color,background-color,border-color,box-shadow] capitalize ${
                active
                  ? 'bg-accent-strong border-accent text-on-accent shadow-sm shadow-accent/20'
                  : 'bg-surface border-edge text-subtle hover:bg-surface-raised hover:border-accent'
              }`}
              aria-pressed={active}
            >
              {term}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default React.memo(PopularSearchChips);
