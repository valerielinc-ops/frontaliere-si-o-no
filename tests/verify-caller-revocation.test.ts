import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: mocks.verifyIdToken }) }));
vi.mock('firebase-admin/firestore', () => ({ FieldValue: {}, getFirestore: vi.fn(), Timestamp: {} }));
vi.mock('../functions/src/remoteConfigSecrets.js', () => ({ bridgeEmailCascadeCredentialsToEnv: vi.fn(), getRemoteConfigValue: vi.fn() }));
vi.mock('../functions/src/emailCascade.js', () => ({ sendEmailCascade: vi.fn() }));
vi.mock('../functions/src/publisherPendingReapCore.js', () => ({ revertPendingJobsToDraft: vi.fn() }));
vi.mock('../functions/src/recaptchaVerification.js', () => ({ createAssessment: vi.fn() }));
vi.mock('../functions/src/githubProxy.js', () => ({ GITHUB_API: 'https://api.github.com', getRepoConfig: vi.fn() }));
import { verifyCaller } from '../functions/src/stripePublisherCore.js';
const req = { get: () => 'Bearer test-id-token' };
beforeEach(() => mocks.verifyIdToken.mockReset());

describe('caller verification for session grants', () => {
  it('preserves the default verification policy for existing callers', async () => {
    mocks.verifyIdToken.mockResolvedValue({ uid: 'test-user' });
    expect(await verifyCaller(req)).toEqual({ uid: 'test-user' });
    expect(mocks.verifyIdToken).toHaveBeenCalledWith('test-id-token');
  });
  it('enforces revocation when the session-grant caller opts in', async () => {
    mocks.verifyIdToken.mockRejectedValue(Object.assign(new Error('revoked'), { code: 'auth/id-token-revoked' }));
    expect(await verifyCaller(req, { checkRevoked: true })).toBeNull();
    expect(mocks.verifyIdToken).toHaveBeenCalledWith('test-id-token', true);
  });
});
