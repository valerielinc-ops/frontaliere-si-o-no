/** Public send facts and the order-wide fence against a second application. */
import { isUnconfirmedSubmission } from './assistedApplicationSubmissionGuard.js';

const roundRecords = submission => Object.entries(submission || {})
  .filter(([key]) => /^r[1-9]\d*$/.test(key)).map(([, record]) => record);

/** The current round's durable SENT fact does not depend on mutable draft materials. */
export function publicSubmissionState({ order = {}, flow = {}, submission = {} }) {
  const state = flow?.state || 'drafting';
  // A read must not reopen a withdrawn/deleted/closed slot or promote an older round.
  if (order?.withdrawnAt || order?.retentionPurgedAt || flow?.state === 'withdrawn'
    || ['withdrawn', 'closed', 'cancelled', 'refunded'].includes(order?.submissionStatus)) return state;
  return submission?.[`r${Number(flow?.round) || 1}`]?.state === 'sent' ? 'submitted' : state;
}

/** Approval history is not proof of sending. Any actual send/unknown outcome fences every round. */
export function submissionIrreversibility({ submission = {} }) {
  const records = roundRecords(submission);
  if (records.some(record => record?.state === 'sent')) return 'already_sent';
  if (records.some(isUnconfirmedSubmission)) return 'submission_unconfirmed';
  return null;
}
