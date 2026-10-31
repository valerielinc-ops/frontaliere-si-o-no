import { describe, expect, it } from 'vitest';
import { submissionEmailHandoff, submissionEmployerAckProof } from '../functions/src/lib/submissionReceiptContract.js';
const slotHash = 'a'.repeat(64);
const handoff = () => ({ messageId: '<aa-fixture@candidature.example.test>', recipient: 'hr@example.test', slotHash });
const ack = () => ({ orderId: 'receipt_fixture', round: 1, channel: 'email', leftAt: 1000, recordHash: 'b'.repeat(64),
  messageId: 'inbox_message_123', providerReceivedAt: 2000, slotHash });

describe('distinct SMTP handoff and verified inbox outcome records', () => {
  it('copies only the exact actual-payload handoff tuple', () => {
    const input = handoff(); const copy = submissionEmailHandoff(input);
    input.recipient = 'changed@example.test';
    expect(copy).toEqual(handoff());
    expect(submissionEmailHandoff({ ...handoff(), source: 'client' })).toBeNull();
  });

  it.each(['messageId', 'recipient', 'slotHash'])('rejects a malformed email %s', field => {
    expect(submissionEmailHandoff({ ...handoff(), [field]: field === 'messageId' ? 'inbox_message_123' : field === 'recipient' ? 'hr@example.test\r\nBcc: other@example.test' : 'short' })).toBeNull();
  });

  it.each(['\u0000', '\u007f'])('rejects control %j in outgoing header identity', control => {
    expect(submissionEmailHandoff({ ...handoff(), messageId: `<aa${control}@example.test>` })).toBeNull();
    expect(submissionEmailHandoff({ ...handoff(), recipient: `hr${control}@example.test` })).toBeNull();
  });

  it('accepts an inbox document ID instead of misreading it as the outgoing Message-ID header', () => {
    const input = ack(); const copy = submissionEmployerAckProof(input);
    input.messageId = 'different_inbox_message';
    expect(copy).toEqual(ack());
    expect(submissionEmployerAckProof({ ...ack(), authority: true })).toBeNull();
  });

  it.each(['wrong_channel', 'earlier_receipt', 'bad_hash', 'bad_round', 'slash_id', 'control_id'])('rejects %s outcome proof metadata', fault => {
    const mutation = fault === 'wrong_channel' ? { channel: 'portal' } : fault === 'earlier_receipt' ? { providerReceivedAt: 999 }
      : fault === 'bad_hash' ? { recordHash: 'short' } : fault === 'bad_round' ? { round: 1.5 }
        : fault === 'slash_id' ? { messageId: 'inbox/other' } : { messageId: 'inbox\nother' };
    expect(submissionEmployerAckProof({ ...ack(), ...mutation })).toBeNull();
  });
});
