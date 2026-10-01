/**
 * Wait-time tone (ok / warn / bad / unknown) shared by the static border-wait
 * pages and the live hydration asset.
 *
 * The pages colour every minute pill and status tile at build time from the
 * snapshot; the hydration script replaces the number with the live reading a
 * few seconds later. Both sides must agree on where "ok" ends and which
 * semantic tokens paint each tone, otherwise a live 20 min stays in the green
 * pill the snapshot painted for 0 min. One module, interpolated into the
 * hydration IIFE, keeps the two from drifting.
 */

export type BorderWaitTone = 'ok' | 'warn' | 'bad' | 'unknown';

/** A wait below this many minutes is "ok" (short). */
export const BORDER_WAIT_OK_BELOW_MINUTES = 5;
/** A wait below this many minutes (and not ok) is "warn" (moderate); above is "bad". */
export const BORDER_WAIT_WARN_BELOW_MINUTES = 15;

export const BORDER_WAIT_TONE_COLORS: Record<BorderWaitTone, { bg: string; border: string; text: string }> = {
  ok: {
    bg: 'var(--color-success-subtle)',
    border: 'var(--color-success-border)',
    text: 'var(--color-success)',
  },
  warn: {
    bg: 'var(--color-warning-subtle)',
    border: 'var(--color-warning-border)',
    text: 'var(--color-warning)',
  },
  bad: {
    bg: 'var(--color-danger-subtle)',
    border: 'var(--color-danger-border)',
    text: 'var(--color-danger)',
  },
  unknown: {
    bg: 'var(--color-surface-alt)',
    border: 'var(--color-edge)',
    text: 'var(--color-subtle)',
  },
};

export function borderWaitTone(waitMinutes: number | null): BorderWaitTone {
  if (waitMinutes === null) return 'unknown';
  if (waitMinutes < BORDER_WAIT_OK_BELOW_MINUTES) return 'ok';
  if (waitMinutes < BORDER_WAIT_WARN_BELOW_MINUTES) return 'warn';
  return 'bad';
}
