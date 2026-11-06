// Helpers for the committed AI Assistant channel history. Keeping the record
// shape and trend eligibility here makes the persistence contract observable
// without running the networked analytics report.

function normalizeVerdict(verdict) {
  return {
    reliable: verdict?.reliable === true,
    reason: verdict?.reason ?? null,
    unreliableDates: Array.isArray(verdict?.unreliableDates)
      ? [...verdict.unreliableDates]
      : [],
  };
}

/**
 * Build one JSONL record for the AI Assistant channel report.
 *
 * The top-level reliability fields preserve the original compact history
 * contract. The nested verdicts and suppression count explain why a number
 * may be present in history even when the full-window trend must not use it.
 * `fullWindowVerdict` is the raw per-day verdict; callers can provide the
 * effective full-window verdict separately when the aggregate is also used
 * as a fallback.
 */
export function buildAiChannelHistoryEntry({
  date,
  windowDays,
  sessions,
  engagedSessions,
  engagementRate,
  bySource = [],
  fullWindowVerdict,
  effectiveWindowVerdict = fullWindowVerdict,
  settledWindowVerdict,
  highBouncePaths = [],
}) {
  const fullVerdict = normalizeVerdict(fullWindowVerdict);
  const effectiveVerdict = normalizeVerdict(effectiveWindowVerdict);
  const settledVerdict = normalizeVerdict(settledWindowVerdict);
  const highBouncePathCount = Array.isArray(highBouncePaths) ? highBouncePaths.length : 0;

  return {
    date,
    windowDays,
    sessions,
    engagedSessions,
    engagementRate,
    engagementReliable: effectiveVerdict.reliable,
    engagementUnreliableReason: effectiveVerdict.reason,
    fullWindowVerdict: fullVerdict,
    settledWindowVerdict: settledVerdict,
    highBouncePathsCount: highBouncePathCount,
    highBouncePathsSuppressedByFullWindow: effectiveVerdict.reliable ? 0 : highBouncePathCount,
    bySource: (Array.isArray(bySource) ? bySource : []).map((row) => ({
      source: row?.source,
      sessions: row?.sessions,
    })),
  };
}

/**
 * Return the latest reliable prior record for the same report window.
 * Legacy rows without an explicit `true` verdict are deliberately excluded.
 */
export function selectPreviousReliableAiChannelEntry(entries, today, windowDays) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => (
      entry
      && entry.date
      && entry.date !== today
      && entry.engagementReliable === true
      && (windowDays == null || Number(entry.windowDays) === Number(windowDays))
    ))
    .at(-1) ?? null;
}

/**
 * Build a trend only when both sides have an explicit reliable verdict.
 */
export function buildAiChannelTrend({ current, previous }) {
  if (
    !current
    || current.engagementReliable !== true
    || !previous
    || previous.engagementReliable !== true
  ) {
    return null;
  }

  const sessions = Number(current.sessions);
  const previousSessions = Number(previous.sessions);
  const engagementRate = Number(current.engagementRate);
  const previousEngagementRate = Number(previous.engagementRate);
  if (![sessions, previousSessions, engagementRate, previousEngagementRate].every(Number.isFinite)) {
    return null;
  }

  return {
    previousDate: previous.date,
    sessionsDelta: sessions - previousSessions,
    engagementRateDelta: Number((engagementRate - previousEngagementRate).toFixed(4)),
  };
}
