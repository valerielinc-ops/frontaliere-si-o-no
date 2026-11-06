import { describe, expect, it, vi } from 'vitest';

import { getTikTokAccessToken, persistTikTokRefreshToken } from '../scripts/lib/tiktok-access-token.mjs';

const tokenResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

describe('TikTok access token rotation', () => {
  it('persists a replacement refresh token before returning the access token', async () => {
    const env = {
      TIKTOK_REFRESH_TOKEN: 'old-refresh',
      TIKTOK_CLIENT_KEY: 'client-key',
      TIKTOK_CLIENT_SECRET: 'client-secret',
    };
    const persistRefreshToken = vi.fn(async () => true);
    const log = vi.fn();

    await expect(getTikTokAccessToken({
      env,
      persistRefreshToken,
      log,
      fetchImpl: async () => tokenResponse({ access_token: 'new-access', refresh_token: 'new-refresh' }),
    })).resolves.toBe('new-access');

    expect(persistRefreshToken).toHaveBeenCalledWith('new-refresh', { env });
    expect(log.mock.calls.flat().join(' ')).not.toContain('new-refresh');
  });

  it('does not write Remote Config when TikTok returns the same refresh token', async () => {
    const persistRefreshToken = vi.fn(async () => true);
    await getTikTokAccessToken({
      env: {
        TIKTOK_REFRESH_TOKEN: 'same-refresh',
        TIKTOK_CLIENT_KEY: 'client-key',
        TIKTOK_CLIENT_SECRET: 'client-secret',
      },
      persistRefreshToken,
      fetchImpl: async () => tokenResponse({ access_token: 'new-access', refresh_token: 'same-refresh' }),
    });
    expect(persistRefreshToken).not.toHaveBeenCalled();
  });

  it('fails closed when a rotated refresh token cannot be persisted', async () => {
    const persistRefreshToken = vi.fn(async () => { throw new Error('Remote Config unavailable'); });
    await expect(getTikTokAccessToken({
      env: {
        TIKTOK_REFRESH_TOKEN: 'old-refresh',
        TIKTOK_CLIENT_KEY: 'client-key',
        TIKTOK_CLIENT_SECRET: 'client-secret',
        TIKTOK_ACCESS_TOKEN: 'static-access',
      },
      persistRefreshToken,
      fetchImpl: async () => tokenResponse({ access_token: 'new-access', refresh_token: 'new-refresh' }),
    })).rejects.toThrow('Remote Config unavailable');
  });

  it('writes the rotated value to the top-level Remote Config parameter', async () => {
    let input: Record<string, unknown> | undefined;
    await expect(persistTikTokRefreshToken('rotated-refresh', {
      env: { FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ project_id: 'test-project', client_email: 'test@example.invalid', private_key: 'fake-key' }) },
      setRemoteConfigParam: async (options: Record<string, unknown>) => {
        input = options;
        return { ok: true, changed: true, attempt: 1 };
      },
    })).resolves.toBe(true);
    expect(input).toMatchObject({
      name: 'SERVER_TIKTOK_REFRESH_TOKEN',
      value: 'rotated-refresh',
      credentials: { project_id: 'test-project' },
    });
  });
});
