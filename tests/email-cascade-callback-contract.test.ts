import { describe, expect, it } from 'vitest';
import { sendEmailCascade } from '../scripts/lib/email-cascade.mjs';

type CascadeOptions = NonNullable<Parameters<typeof sendEmailCascade>[1]>;

const onSent: NonNullable<CascadeOptions['onSent']> = (item, result) => {
  const recipientEmail: string | undefined = item.recipient?.email;
  const provider: string = result.provider;
  const ack: 'identified' | 'unidentifiable' = result.ack;
  const persistFailed: boolean | undefined = result.persistFailed;
  void recipientEmail;
  void provider;
  void ack;
  void persistFailed;
};

const onAmbiguous: NonNullable<CascadeOptions['onAmbiguous']> = (item, error) => {
  const recipientEmail: string | undefined = item.recipient?.email;
  const provider: string | null | undefined = error.provider;
  const ambiguous: boolean | undefined = error.ambiguousDelivery;
  void recipientEmail;
  void provider;
  void ambiguous;
};

describe('email cascade callback contract', () => {
  it('exposes recipient, provider, acknowledgement, and ambiguity fields', () => {
    expect(onSent).toBeTypeOf('function');
    expect(onAmbiguous).toBeTypeOf('function');
  });
});
