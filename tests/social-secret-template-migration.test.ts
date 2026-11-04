import { describe, expect, it, vi } from 'vitest';

import {
  migrateSocialSecrets,
  planSocialSecretMigration,
} from '../scripts/migrate-social-secrets-to-server-rc.mjs';

const credentials = {
  client_email: 'firebase@example.test',
  private_key: 'fixture-key',
  project_id: 'project-fixture',
};

describe('social credential Remote Config migration', () => {
  it('copies exact legacy aliases and schedules every source key for client cleanup', () => {
    const plan = planSocialSecretMigration({
      parameters: {
        SERVER_META_CAPI_ACCESS_TOKEN: { defaultValue: { value: 'fixture-meta-capi-token' } },
        FB_PAGE_ACCESS_TOKEN: { defaultValue: { value: 'fixture-page-token' } },
        TELEGRAM_BOT_TOKEN: { defaultValue: { value: 'fixture-telegram-token' } },
        FB_PAGE_ID: { defaultValue: { value: 'public-page-id' } },
      },
    });

    expect(plan.targetValues).toEqual({
      SERVER_META_CAPI_ACCESS_TOKEN: 'fixture-meta-capi-token',
      SERVER_FB_PAGE_ACCESS_TOKEN: 'fixture-page-token',
      SERVER_TELEGRAM_BOT_TOKEN: 'fixture-telegram-token',
    });
    expect(plan.removeClientKeys).toEqual(['SERVER_META_CAPI_ACCESS_TOKEN', 'FB_PAGE_ACCESS_TOKEN', 'TELEGRAM_BOT_TOKEN']);
    expect(plan.removeClientKeys).not.toContain('FB_PAGE_ID');
  });

  it('migrates TikTok app keys, access tokens, refresh tokens, and expiry metadata as separate server values', () => {
    const plan = planSocialSecretMigration({
      parameters: {
        TIKTOK_CLIENT_KEY: { defaultValue: { value: 'production-client-key' } },
        TIKTOK_CLIENT_SECRET: { defaultValue: { value: 'production-client-secret' } },
        TIKTOK_ACCESS_TOKEN: { defaultValue: { value: 'production-access-token' } },
        TIKTOK_ACCESS_TOKEN_EXPIRES_AT: { defaultValue: { value: '2027-01-01T00:00:00.000Z' } },
        TIKTOK_REFRESH_TOKEN: { defaultValue: { value: 'production-refresh-token' } },
        TIKTOK_SANDBOX_CLIENT_KEY: { defaultValue: { value: 'sandbox-client-key' } },
        TIKTOK_SANDBOX_CLIENT_SECRET: { defaultValue: { value: 'sandbox-client-secret' } },
        TIKTOK_SANDBOX_REFRESH_TOKEN: { defaultValue: { value: 'sandbox-refresh-token' } },
      },
    });

    expect(plan.targetValues).toEqual({
      SERVER_TIKTOK_CLIENT_KEY: 'production-client-key',
      SERVER_TIKTOK_CLIENT_SECRET: 'production-client-secret',
      SERVER_TIKTOK_ACCESS_TOKEN: 'production-access-token',
      SERVER_TIKTOK_ACCESS_TOKEN_EXPIRES_AT: '2027-01-01T00:00:00.000Z',
      SERVER_TIKTOK_REFRESH_TOKEN: 'production-refresh-token',
      SERVER_TIKTOK_SANDBOX_CLIENT_KEY: 'sandbox-client-key',
      SERVER_TIKTOK_SANDBOX_CLIENT_SECRET: 'sandbox-client-secret',
      SERVER_TIKTOK_SANDBOX_REFRESH_TOKEN: 'sandbox-refresh-token',
    });
    expect(plan.removeClientKeys).toHaveLength(8);
  });

  it('rejects conflicting aliases before any write', () => {
    expect(() => planSocialSecretMigration({
      parameters: {
        FB_PAGE_ACCESS_TOKEN: { defaultValue: { value: 'fixture-old-token' } },
        SERVER_FB_PAGE_ACCESS_TOKEN: { defaultValue: { value: 'fixture-new-token' } },
      },
    })).toThrow('conflicting client aliases for SERVER_FB_PAGE_ACCESS_TOKEN');
  });

  it('rejects conditional client values rather than guessing which credential is active', () => {
    expect(() => planSocialSecretMigration({
      parameters: {
        SERVER_FB_PAGE_ACCESS_TOKEN: {
          defaultValue: { value: 'fixture-token' },
          conditionalValues: { production: { value: 'another-fixture-token' } },
        },
      },
    })).toThrow('conditional client value is ambiguous');
  });

  it('writes the private server copy before removing client parameters and returns no values', async () => {
    const order: string[] = [];
    const updateConfig = vi.fn(async ({ namespace, stage }: { namespace: string; stage: (template: any) => any }) => {
      order.push(`write:${namespace}`);
      const staged = stage({ parameters: {} });
      return { ok: true, changed: staged.changed };
    });
    const removeClientConfig = vi.fn(async ({ namespace, names }: { namespace: string; names: string[] }) => {
      order.push(`remove:${namespace}`);
      expect(names).toContain('FB_PAGE_ACCESS_TOKEN');
      return { ok: true, changed: true };
    });

    const result = await migrateSocialSecrets({
      credentials,
      clientTemplate: { parameters: { FB_PAGE_ACCESS_TOKEN: { defaultValue: { value: 'fixture-page-token' } } } },
      updateConfig,
      removeClientConfig,
    });

    expect(order).toEqual(['write:firebase-server', 'remove:firebase']);
    expect(result).toEqual({ movedParameterCount: 1, removedClientParameterCount: 1, changed: true });
    expect(JSON.stringify(result)).not.toContain('fixture-page-token');
  });

  it('does not remove client values when publishing the server copy fails', async () => {
    const removeClientConfig = vi.fn();
    await expect(migrateSocialSecrets({
      credentials,
      clientTemplate: { parameters: { FB_PAGE_ACCESS_TOKEN: { defaultValue: { value: 'fixture-page-token' } } } },
      updateConfig: async () => ({ ok: false, detail: 'HTTP 403' }),
      removeClientConfig,
    })).rejects.toThrow('client values were not removed');
    expect(removeClientConfig).not.toHaveBeenCalled();
  });
});
