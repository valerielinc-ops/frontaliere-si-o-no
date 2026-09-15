/**
 * True if the job's source description length drifted >15% from the snapshot
 * taken when it was suppressed — i.e. a re-crawl rewrote the content, so the
 * give-up no longer applies and we should retry. Callers that normalize or
 * otherwise derive the authoritative source description can pass it explicitly.
 */
export function sourceChangedSinceSuppression(job, sourceDescription = job.description) {
  const snap = job.localeMismatchSuppressedLen;
  if (typeof snap !== 'number') return true; // no snapshot → treat as changed (retry)
  const now = String(sourceDescription || '').trim().length;
  return Math.abs(now - snap) > snap * 0.15;
}
