import { describe, expect, it } from 'vitest';
import { isRecaptchaClientReady } from '@/services/recaptchaReady';

describe('isRecaptchaClientReady', () => {
  it('returns true for reCAPTCHA Enterprise clients', () => {
    const fakeWindow = {
      grecaptcha: {
        enterprise: {
          ready: () => {},
        },
      },
    } as any;

    expect(isRecaptchaClientReady(fakeWindow)).toBe(true);
  });

  it('returns true for legacy grecaptcha.ready clients', () => {
    const fakeWindow = {
      grecaptcha: {
        ready: () => {},
      },
    } as any;

    expect(isRecaptchaClientReady(fakeWindow)).toBe(true);
  });

  it('returns false when the client is missing', () => {
    expect(isRecaptchaClientReady(undefined as any)).toBe(false);
    expect(isRecaptchaClientReady({} as any)).toBe(false);
  });
});
