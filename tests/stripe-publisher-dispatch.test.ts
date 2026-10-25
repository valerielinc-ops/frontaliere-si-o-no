import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase-admin/auth', () => ({
  getAuth: () => ({}),
}));
vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => '__timestamp__' },
  getFirestore: () => ({}),
  Timestamp: {},
}));
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({
  bridgeEmailCascadeCredentialsToEnv: vi.fn(),
  getRemoteConfigValue: vi.fn(),
}));
vi.mock('../functions/src/emailCascade.js', () => ({
  sendEmailCascade: vi.fn(),
}));
vi.mock('../functions/src/publisherPendingReapCore.js', () => ({
  revertPendingJobsToDraft: vi.fn(),
}));
vi.mock('../functions/src/recaptchaVerification.js', () => ({
  createAssessment: vi.fn(),
}));
vi.mock('../functions/src/githubProxy.js', () => ({
  GITHUB_API: 'https://api.github.com',
  getRepoConfig: vi.fn(),
}));

const { dispatchPublisherSync } = await import('../functions/src/stripePublisherCore.js');

const repoConfig = { pat: 'test-pat', owner: 'test-owner', repo: 'test-repo' };

describe('publisher sync workflow dispatch', () => {
  it('uses a bounded signal without changing the dispatch contract', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204 }));

    await expect(dispatchPublisherSync({
      fetchImpl,
      getRepoConfigImpl: async () => repoConfig,
    })).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/test-owner/test-repo/actions/workflows/publisher-jobs-sync.yml/dispatches');
    expect(options.method).toBe('POST');
    expect(JSON.parse(String(options.body))).toEqual({ ref: 'main' });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal?.aborted).toBe(false);
  });

  it('keeps the existing error shape for a rejected dispatch response', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 502,
      text: async () => 'upstream failure',
    }));

    await expect(dispatchPublisherSync({
      fetchImpl,
      getRepoConfigImpl: async () => repoConfig,
    })).rejects.toThrow('dispatch_failed:502:upstream failure');
  });
});
