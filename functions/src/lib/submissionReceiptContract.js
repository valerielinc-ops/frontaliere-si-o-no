/** Server-owned, content-free identity of an attempted submission and its slot. */
import { createHash } from 'node:crypto';
import { qualificationCounterContextHash } from './qualificationCounterContext.js';
export const submissionAttemptHash = attemptId => createHash('sha256').update(String(attemptId)).digest('hex');
export const submissionSlotHash = ({ orderId, order = {} }) => qualificationCounterContextHash({ orderId: String(orderId),
  jobId: order.jobId ?? null, jobUrl: order.jobUrl ?? null,
  parentServiceId: order.parentServiceId ?? null, parentProposalId: order.parentProposalId ?? null });
