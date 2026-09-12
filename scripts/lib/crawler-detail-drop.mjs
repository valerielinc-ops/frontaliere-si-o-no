/**
 * Shared accounting for non-fatal Coop-family detail drops (issue 7885).
 *
 * The detail enricher can drop a withdrawn or unusable detail page while the
 * remaining rows are still publishable. These fields keep that erosion in the
 * crawler summary so health can advise without turning a valid partial result
 * into a broken status.
 */

// Advisory is deliberately below the enricher's 0.5 abort ratio: operators
// need the signal before the source drift becomes a hard failure.
export const DETAIL_DROP_ADVISORY_RATIO = 0.15;
export const DETAIL_DROP_ADVISORY_MIN_CANDIDATES = 10;

const finite = (value) => {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
};

export function normalizeDetailDrop(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const candidates = finite(raw.candidates);
  const gone = finite(raw.gone);
  const rejected = finite(raw.rejected);
  if (candidates === null || gone === null || rejected === null) return null;
  if (candidates < 0 || gone < 0 || rejected < 0) return null;
  if (gone + rejected > candidates) return null;
  return { candidates, gone, rejected, dropped: gone + rejected };
}

/** Summary-slice fields, or an empty object when the crawler did not measure. */
export function detailDropSummaryFields(raw) {
  const drop = normalizeDetailDrop(raw);
  if (!drop) return {};
  return {
    detailCandidates: drop.candidates,
    detailGone: drop.gone,
    detailRejected: drop.rejected,
  };
}

/** Read the canonical drop shape from a summary slice. */
export function detailDropFromSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  return normalizeDetailDrop({
    candidates: summary.detailCandidates,
    gone: summary.detailGone,
    rejected: summary.detailRejected,
  });
}

/** Return the advisory text, or null when the signal is absent/under threshold. */
export function detailDropAdvisoryReason(raw) {
  const drop = normalizeDetailDrop(raw);
  if (!drop || drop.candidates < DETAIL_DROP_ADVISORY_MIN_CANDIDATES) return null;
  const ratio = drop.dropped / drop.candidates;
  if (ratio < DETAIL_DROP_ADVISORY_RATIO) return null;
  const pct = Math.round(ratio * 100);
  return [
    drop.dropped,
    '/',
    drop.candidates,
    ' detail pages dropped (',
    pct,
    '% >= ',
    Math.round(DETAIL_DROP_ADVISORY_RATIO * 100),
    '%: ',
    drop.gone,
    ' gone, ',
    drop.rejected,
    ' rejected) — non-fatal; published rows remain valid and status stays unchanged',
  ].join('');
}
