import { buildAlertProfile, mergeAlertSubscriberSignals } from '../../services/jobAlertMatching.mjs';
import { classifyZeroMatchCause } from './job-alert-zero-match-diagnosis.mjs';

const unique = (emails) => [...new Set((emails || [])
  .map((email) => String(email || '').toLowerCase())
  .filter(Boolean))];

/**
 * Build the per-run Firestore profile references used by send-job-alerts.
 *
 * Default: the two common parent documents per recipient (newsletter +
 * job-alert). `includeAuxiliary`: the two auxiliary documents per recipient
 * (personalization + first-discovery). `only` narrows the common read to ONE of
 * the two parents (perf-plan PR 6: `job_alert_subscribers` is read for every
 * recipient because it carries cadence and exclusion, `newsletter_subscribers`
 * only for the recipients that can actually be sent today).
 */
export function buildJobAlertProfileRefs(db, emails, { includeAuxiliary = false, only = null } = {}) {
  const uniqueEmails = unique(emails);
  return uniqueEmails.flatMap((email) => {
    if (includeAuxiliary) {
      return [
        db.collection('newsletter_subscribers').doc(email).collection('private').doc('personalization'),
        db.collection('job_alert_subscribers').doc(email).collection('delivery_state').doc('first_discovery'),
      ];
    }
    if (only === 'job_alert') return [db.collection('job_alert_subscribers').doc(email)];
    if (only === 'newsletter') return [db.collection('newsletter_subscribers').doc(email)];
    return [
      db.collection('newsletter_subscribers').doc(email),
      db.collection('job_alert_subscribers').doc(email),
    ];
  });
}

/**
 * Auxiliary reads with an explicit layout (perf-plan PR 6). The personalization
 * document is read for every due recipient; the first-discovery document only
 * for the recipients in `discoveryEmails` (those with an empty profile, the only
 * ones the discovery path can ever pick). `entries[i]` says what `refs[i]` is,
 * so the caller maps snapshots by position without assuming a fixed stride.
 *
 * @returns {{refs: object[], entries: Array<{email: string, kind: 'personalization'|'first_discovery'}>}}
 */
export function buildJobAlertAuxiliaryReadPlan(db, emails, { discoveryEmails = null } = {}) {
  const refs = [];
  const entries = [];
  for (const email of unique(emails)) {
    refs.push(db.collection('newsletter_subscribers').doc(email).collection('private').doc('personalization'));
    entries.push({ email, kind: 'personalization' });
    if (discoveryEmails === null || discoveryEmails.has(email)) {
      refs.push(db.collection('job_alert_subscribers').doc(email).collection('delivery_state').doc('first_discovery'));
      entries.push({ email, kind: 'first_discovery' });
    }
  }
  return { refs, entries };
}

/**
 * Could this recipient's alert end up with an EMPTY profile in the planner?
 *
 * Used only to decide who needs the first-discovery document. It must be a
 * SUPERSET of the recipients the planner will classify as `empty-profile`: the
 * planner's profile carries every signal this one has plus more (browsing
 * locations and tokens, CV skills, clicked and source-job geography), and adding
 * a signal can only make a profile non-empty. Computing it here from the stored
 * subscriber and channel documents alone therefore over-includes at worst, and
 * an over-included recipient costs one extra read, never a wrong send.
 */
export function mayHaveEmptyProfile(alert, newsletterDoc = null, channelDoc = null) {
  const profile = buildAlertProfile(alert, mergeAlertSubscriberSignals(newsletterDoc, channelDoc), {});
  return classifyZeroMatchCause(profile) === 'empty-profile';
}
