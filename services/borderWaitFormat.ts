// Shared minute-formatting helpers for the border-wait ranking feature.
// Used by both the React widget (components/blog/InlineBorderWaitRanking.tsx)
// and the deterministic content builder (scripts/lib/border-wait-ranking-content.mjs,
// which runs under `tsx` and can import `.ts` modules directly) so the two
// never drift into two different "N.NN min" vs "N min" renderings of the same
// number (AGENTS.md §6 sibling-pattern-fix).

/** Whole-minute display, e.g. `fmtMinutes(6.257211538461538)` → `"6 min"`. */
export function fmtMinutes(minutes: number): string {
  return `${Math.max(0, Math.round(minutes))} min`;
}

/** Signed week-over-week delta, e.g. `+3 min` / `−2 min` / `±0 min`. */
export function fmtSignedMinutesDelta(deltaMinutes: number): string {
  const rounded = Math.round(Math.abs(deltaMinutes));
  if (rounded === 0) return '±0 min';
  return `${deltaMinutes > 0 ? '+' : '−'}${rounded} min`;
}
