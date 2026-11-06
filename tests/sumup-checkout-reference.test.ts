import { describe, expect, it } from 'vitest';
import { sumUpCheckoutReference, sumUpCheckoutEntityId, matchesSumUpCheckoutReference } from '../functions/src/sumupCheckoutReference.js';

describe('SumUp renewal references', () => {
  it('keeps historical checkout references and deterministically separates renewals', () => {
    expect(sumUpCheckoutReference('order-1')).toBe('order-1');
    expect(sumUpCheckoutReference('order-1', 2)).toBe('order-1~sumup~2');
    expect(sumUpCheckoutReference('order-1', 3)).toBe('order-1~sumup~3');
    expect(sumUpCheckoutEntityId('order-1~sumup~2')).toBe('order-1');
    expect(matchesSumUpCheckoutReference('order-1~sumup~2', 'order-1')).toBe(true);
    expect(matchesSumUpCheckoutReference('order-10~sumup~2', 'order-1')).toBe(false);
  });

  it.each(['order-1~sumup~0', 'order-1~sumup~1', 'order-1~sumup~02', 'order-1~sumup~2.5', '~sumup~2', 'order-1~sumup~2~sumup~3'])('rejects ambiguous reference %s', (reference) => {
    expect(sumUpCheckoutEntityId(reference)).toBe('');
    expect(matchesSumUpCheckoutReference(reference, 'order-1')).toBe(false);
  });

  it('enforces the provider length and unambiguous attempt identity', () => {
    expect(() => sumUpCheckoutReference('x'.repeat(60), 2)).toThrow('sumup_checkout_reference_invalid');
    expect(() => sumUpCheckoutReference('order~sumup~2')).toThrow('sumup_checkout_reference_invalid');
    expect(() => sumUpCheckoutReference('order', Number.POSITIVE_INFINITY)).toThrow();
    expect(() => sumUpCheckoutReference('order', 0)).toThrow();
    expect(sumUpCheckoutEntityId('x'.repeat(65))).toBe('');
  });
});
