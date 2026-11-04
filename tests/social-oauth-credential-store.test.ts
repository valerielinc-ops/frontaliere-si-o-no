import { describe, expect, it, vi } from 'vitest';
import {
  persistSocialOAuthCredentials,
  readSocialOAuthStorageCredentials,
  validateSocialOAuthCredentialStorage,
} from '../scripts/lib/social-oauth-credential-store.mjs';

const credentials = {
  client_email: 'social-publisher@example.iam.gserviceaccount.com',
  private_key: 'test-private-key',
  project_id: 'test-project',
};

describe('social OAuth credential storage', () => {
  it('requires a service account before an auth code can be requested', () => {
    expect(() => readSocialOAuthStorageCredentials({}, 'reddit'))
      .toThrow(/service-account credentials are unavailable/);
    expect(() => readSocialOAuthStorageCredentials({
      FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify(credentials),
    }, 'reddit')).not.toThrow();
  });

  it('validates write access in the private server namespace without publishing the probe', async () => {
    let request;
    const updateConfig = vi.fn(async (options) => {
      request = options;
      const staged = options.stage({ parameters: {} });
      expect(staged.changed).toBe(true);
      expect(Object.keys(staged.template.parameters)[0])
        .toMatch(/^SOCIAL_REDDIT_PREFLIGHT_[A-F0-9]{12}$/);
      return { ok: true, validated: true };
    });

    await expect(validateSocialOAuthCredentialStorage({
      credentials,
      platform: 'reddit',
      updateConfig,
    })).resolves.toBe(true);
    expect(request.namespace).toBe('firebase-server');
    expect(request.validateOnly).toBe(true);
    expect(updateConfig).toHaveBeenCalledTimes(1);
  });

  it('writes only allowlisted credentials to the private namespace and returns no values', async () => {
    let request;
    const updateConfig = vi.fn(async (options) => {
      request = options;
      const staged = options.stage({ parameters: {} });
      return { ok: true, changed: staged.changed };
    });

    const result = await persistSocialOAuthCredentials({
      credentials,
      platform: 'linkedin-member',
      parameters: {
        SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN: 'secret-access',
        SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN_EXPIRES_AT: '2027-01-01T00:00:00.000Z',
      },
      updateConfig,
    });

    expect(request.namespace).toBe('firebase-server');
    expect(request.stage({ parameters: {} }).template.parameters)
      .toMatchObject({
        SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN: { defaultValue: { value: 'secret-access' } },
        SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN_EXPIRES_AT: { defaultValue: { value: '2027-01-01T00:00:00.000Z' } },
      });
    expect(result).toEqual({ changed: true, parameterCount: 2, removedParameterCount: 0 });
    expect(JSON.stringify(result)).not.toContain('secret-access');
  });

  it('removes a stale refresh token when the provider does not issue a replacement', async () => {
    const updateConfig = vi.fn(async (options) => {
      const staged = options.stage({
        parameters: {
          SERVER_LINKEDIN_MEMBER_REFRESH_TOKEN: { defaultValue: { value: 'old-secret' } },
        },
      });
      expect(staged.template.parameters).not.toHaveProperty('SERVER_LINKEDIN_MEMBER_REFRESH_TOKEN');
      return { ok: true, changed: staged.changed };
    });

    await expect(persistSocialOAuthCredentials({
      credentials,
      platform: 'linkedin-member',
      parameters: { SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN: 'new-secret' },
      removeParameters: ['SERVER_LINKEDIN_MEMBER_REFRESH_TOKEN'],
      updateConfig,
    })).resolves.toMatchObject({ changed: true, removedParameterCount: 1 });
  });

  it('rejects client namespace parameter names and unapproved fields', async () => {
    await expect(persistSocialOAuthCredentials({
      credentials,
      platform: 'reddit',
      parameters: { REDDIT_REFRESH_TOKEN: 'secret' },
      updateConfig: vi.fn(),
    })).rejects.toThrow(/Invalid private OAuth credential fields/);
  });

  it('fails without including credential values when Remote Config rejects a write', async () => {
    await expect(persistSocialOAuthCredentials({
      credentials,
      platform: 'reddit',
      parameters: { SERVER_REDDIT_REFRESH_TOKEN: 'secret-refresh-token' },
      updateConfig: vi.fn(async () => ({ ok: false, detail: 'provider echoed secret-refresh-token' })),
    })).rejects.toThrow(/could not store reddit OAuth credentials/);
  });
});
