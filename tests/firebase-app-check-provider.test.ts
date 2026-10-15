import { describe, expect, it, vi } from 'vitest';

const { createRecaptchaAppCheckProvider } = await vi.importActual<typeof import('@/services/firebase')>('@/services/firebase');

class FakeReCaptchaV3Provider {
  constructor(public readonly siteKey: string) {}
}

class FakeReCaptchaEnterpriseProvider {
  constructor(public readonly siteKey: string) {}
}

describe('createRecaptchaAppCheckProvider', () => {
  const moduleLike = {
    ReCaptchaV3Provider: FakeReCaptchaV3Provider,
    ReCaptchaEnterpriseProvider: FakeReCaptchaEnterpriseProvider,
  };

  it('uses the enterprise provider when the loaded client is enterprise-only', () => {
    const provider = createRecaptchaAppCheckProvider(moduleLike as any, 'test-site-key', {
      grecaptcha: {
        enterprise: {
          ready: () => {},
        },
      },
    } as any);

    expect(provider).toBeInstanceOf(FakeReCaptchaEnterpriseProvider);
  });

  it('falls back to the v3 provider for legacy grecaptcha.ready clients', () => {
    const provider = createRecaptchaAppCheckProvider(moduleLike as any, 'test-site-key', {
      grecaptcha: {
        ready: () => {},
      },
    } as any);

    expect(provider).toBeInstanceOf(FakeReCaptchaV3Provider);
  });
});
