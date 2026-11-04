import { describe, expect, it, vi } from 'vitest';

import {
  getLinkedInMemberAccessToken,
  persistLinkedInMemberRefreshToken,
} from '../scripts/lib/linkedin-member-access-token.mjs';

const tokenResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('LinkedIn member access token rotation', () => {
  it('persists a replacement refresh token before returning the access token', async () => {
    const env = {
      LINKEDIN_MEMBER_REFRESH_TOKEN: 'old-refresh',
      LINKEDIN_MEMBER_CLIENT_ID: 'client-id',
      LINKEDIN_MEMBER_CLIENT_SECRET: 'client-secret',
    };
    const persistRefreshToken = vi.fn(async () => true);
    const log = vi.fn();

    await expect(getLinkedInMemberAccessToken({
      env,
      persistRefreshToken,
      log,
      fetchImpl: async () => tokenResponse({ access_token: 'new-access', refresh_token: 'new-refresh' }),
    })).resolves.toBe('new-access');

    expect(persistRefreshToken).toHaveBeenCalledWith('new-refresh', { env });
    expect(log.mock.calls.flat().join(' ')).not.toContain('new-refresh');
  });

  it('does not write Remote Config when LinkedIn returns the same refresh token', async () => {
    const persistRefreshToken = vi.fn(async () => true);
    await getLinkedInMemberAccessToken({
      env: {
        LINKEDIN_MEMBER_REFRESH_TOKEN: 'same-refresh',
        LINKEDIN_MEMBER_CLIENT_ID: 'client-id',
        LINKEDIN_MEMBER_CLIENT_SECRET: 'client-secret',
      },
      persistRefreshToken,
      fetchImpl: async () => tokenResponse({ access_token: 'new-access', refresh_token: 'same-refresh' }),
    });
    expect(persistRefreshToken).not.toHaveBeenCalled();
  });

  it('fails closed when a rotated refresh token cannot be persisted', async () => {
    const persistRefreshToken = vi.fn(async () => { throw new Error('Remote Config unavailable'); });
    await expect(getLinkedInMemberAccessToken({
      env: {
        LINKEDIN_MEMBER_REFRESH_TOKEN: 'old-refresh',
        LINKEDIN_MEMBER_CLIENT_ID: 'client-id',
        LINKEDIN_MEMBER_CLIENT_SECRET: 'client-secret',
        LINKEDIN_MEMBER_ACCESS_TOKEN: 'static-access',
      },
      persistRefreshToken,
      fetchImpl: async () => tokenResponse({ access_token: 'new-access', refresh_token: 'new-refresh' }),
    })).rejects.toThrow('Remote Config unavailable');
  });

  it('writes the replacement to the top-level Remote Config parameter', async () => {
    let input: Record<string, unknown> | undefined;
    await expect(persistLinkedInMemberRefreshToken('rotated-refresh', {
      env: { FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: 'test-project', client_email: 'test@example.invalid', private_key: 'fake-key' }) },
      setRemoteConfigParam: async (options: Record<string, unknown>) => {
        input = options;
        return { ok: true, changed: true, attempt: 1 };
      },
    })).resolves.toBe(true);
    expect(input).toMatchObject({
      name: 'SERVER_LINKEDIN_MEMBER_REFRESH_TOKEN',
      value: 'rotated-refresh',
      namespace: 'firebase-server',
      credentials: { project_id: 'test-project' },
    });
  });
});
