import { expect, it } from 'vitest';
import { createMemoryFirestore } from './helpers/memoryFirestore';
import { employerResponseView, loadEmployerResponse, mergeEmployerResponse } from '../functions/src/assistedApplicationEmployerResponse.js';
import { conciergeProposalDisplayStatus } from '../services/applicationConciergeService';
import { parseEmployerResponse } from '../services/assistedApplicationEmployerResponse';

const message = (category: string, receivedAt: number, id = category) => ({ category, receivedAt, messageId: id, needsReply: category === 'question' });

it('shows a receipt independently from the submitted state without implying selection', () => {
  const reply = employerResponseView(message('auto_acknowledgement', 1000));
  expect(reply).toEqual({ category: 'auto_acknowledgement', receivedAt: 1000, needsReply: false });
  expect(conciergeProposalDisplayStatus({ status: 'accepted', childCandidateStatus: 'submitted', childSendState: 'sent', childEmployerResponse: reply } as any)).toBe('employer_auto_acknowledgement');
  expect(conciergeProposalDisplayStatus({ status: 'declined', childEmployerResponse: reply } as any)).toBe('declined');
});

it('does not let a later receipt or account verification erase a meaningful update', () => {
  const messages = [message('interview_invite', 2000), message('auto_acknowledgement', 3000), message('question', 1000), message('verification', 4000)];
  const inOrder = messages.reduce<ReturnType<typeof mergeEmployerResponse>>(mergeEmployerResponse, null);
  expect(inOrder).toEqual([...messages].reverse().reduce<ReturnType<typeof mergeEmployerResponse>>(mergeEmployerResponse, null));
  expect(inOrder?.category).toBe('interview_invite');
  expect(mergeEmployerResponse(inOrder, message('rejection', 5000))?.category).toBe('rejection');
  expect(mergeEmployerResponse(inOrder, message('question', 1000))?.category).toBe('interview_invite');
});

it('keeps duplicate delivery idempotent and resolves equal timestamps deterministically', () => {
  const first = message('documents_request', 1000, 'a');
  expect(mergeEmployerResponse(first, first)).toEqual(first);
  const second = message('question', 1000, 'b');
  expect(mergeEmployerResponse(first, second)).toEqual(mergeEmployerResponse(second, first));
});

it('recovers existing processed messages, including a receipt hidden by a later account email', async () => {
  const root = 'assisted_applications/order_test';
  const store = createMemoryFirestore({
    [root + '/inbox/receipt']: { ...message('auto_acknowledgement', 1000), status: 'processed' },
    [root + '/inbox/interview']: { ...message('interview_invite', 2000), status: 'processed' },
    [root + '/inbox/account']: { ...message('verification', 3000), status: 'processed' },
    [root + '/inbox/unprocessed']: { ...message('rejection', 4000), status: 'received' },
  });
  expect(await loadEmployerResponse(store.db.collection('assisted_applications').doc('order_test'), { employerReplies: 3, lastEmployerReplyCategory: 'verification', lastEmployerReplyAt: 3000 })).toMatchObject({ category: 'interview_invite', receivedAt: 2000 });
});

it('does not query an inbox without received messages and omits private ids from the public API', async () => {
  expect(await loadEmployerResponse(undefined, {})).toBeNull();
  const reply = message('question', 1000, 'private-inbox-id');
  expect(parseEmployerResponse(reply)).toEqual({ category: 'question', receivedAt: 1000, needsReply: true });
  expect(JSON.stringify(employerResponseView(reply))).not.toContain('private-inbox-id');
});

it.each(['verification', 'other', '__proto__', 'unknown'])('does not project unsupported category %s', category => {
  expect(parseEmployerResponse(message(category, 1000))).toBeNull();
});

it.each([NaN, Infinity, -1, 0, 1e30])('rejects an invalid received date %s', date => {
  expect(parseEmployerResponse(message('offer', date))).toBeNull();
});
