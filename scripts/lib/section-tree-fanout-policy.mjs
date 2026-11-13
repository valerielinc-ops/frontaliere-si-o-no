export const DEFAULT_FANOUT_AUTO_THRESHOLD_PCT = 40;
export const MAX_FANOUT_AUTO_THRESHOLD_PCT = 80;

export function parseFanoutAutoThreshold(value = DEFAULT_FANOUT_AUTO_THRESHOLD_PCT) {
  const threshold = Number(value);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > MAX_FANOUT_AUTO_THRESHOLD_PCT) {
    throw new Error(`FANOUT_AUTO_THRESHOLD_PCT must be greater than 0 and at most ${MAX_FANOUT_AUTO_THRESHOLD_PCT}`);
  }
  return threshold;
}

export function decideSectionTreeFanout({ percent, threshold = DEFAULT_FANOUT_AUTO_THRESHOLD_PCT, alreadyFanned = false }) {
  const checkedThreshold = parseFanoutAutoThreshold(threshold);
  const checkedPercent = Number(percent);
  if (!Number.isFinite(checkedPercent) || checkedPercent < 0) {
    throw new Error('tree percentage must be a finite non-negative number');
  }
  if (alreadyFanned) return 'already';
  return checkedPercent >= checkedThreshold ? 'fan' : 'keep';
}
