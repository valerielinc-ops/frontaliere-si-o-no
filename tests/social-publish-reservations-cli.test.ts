import { describe, expect, it, vi } from 'vitest';
import { loadConfiguredValues, runSocialPublishReservationsCli } from '../scripts/social-publish-reservations.mjs';

function emptyFirestore() {
  return {
    collection: () => ({
      doc: () => ({
        get: async () => ({ exists: false, data: () => undefined }),
      }),
    }),
  };
}

describe('social publish reservations aggregate report', () => {
  it('reads publishing credentials from private server parameters and never falls back to client copies', async () => {
    const loadTemplates = vi.fn(async () => ({
      template: {
        parameters: {
          FB_PAGE_ID: { defaultValue: { value: 'client-page-id' } },
          FB_PAGE_ACCESS_TOKEN: { defaultValue: { value: 'legacy-client-token' } },
          INSTAGRAM_BUSINESS_ACCOUNT_ID: { defaultValue: { value: 'client-instagram-id' } },
          TELEGRAM_CHANNEL_ID: { defaultValue: { value: 'client-channel-id' } },
        },
      },
      serverTemplate: {
        parameters: {
          SERVER_FB_PAGE_ACCESS_TOKEN: { defaultValue: { value: 'private-server-token' } },
          SERVER_INSTAGRAM_ACCESS_TOKEN: { defaultValue: { value: 'private-instagram-token' } },
          SERVER_LINKEDIN_MEMBER_URN: { defaultValue: { value: 'urn:li:member:private' } },
          SERVER_LINKEDIN_MEMBER_ACCESS_TOKEN: { defaultValue: { value: 'private-linkedin-token' } },
          SERVER_TELEGRAM_BOT_TOKEN: { defaultValue: { value: 'private-telegram-token' } },
        },
      },
      available: true,
    }));

    const configured = await Promise.all([
      loadConfiguredValues('facebook', {}, { loadTemplates }),
      loadConfiguredValues('instagram', {}, { loadTemplates }),
      loadConfiguredValues('linkedinMember', {}, { loadTemplates }),
      loadConfiguredValues('telegram', {}, { loadTemplates }),
    ]);

    expect(configured).toEqual([
      { accountId: 'client-page-id', accessToken: 'private-server-token' },
      { accountId: 'client-instagram-id', accessToken: 'private-instagram-token' },
      { accountId: 'urn:li:member:private', accessToken: 'private-linkedin-token' },
      { accountId: 'client-channel-id', accessToken: 'private-telegram-token' },
    ]);
    await expect(loadConfiguredValues('facebook', {}, {
      loadTemplates: async () => ({
        template: {
          parameters: {
            FB_PAGE_ID: { defaultValue: { value: 'client-page-id' } },
            FB_PAGE_ACCESS_TOKEN: { defaultValue: { value: 'legacy-client-token' } },
          },
        },
        serverTemplate: null,
        available: false,
      }),
    })).resolves.toEqual({ accountId: 'client-page-id', accessToken: '' });
  });

  it('reports stale counts for every configured scope without exposing identities or credentials', async () => {
    const log = vi.fn();
    const report = await runSocialPublishReservationsCli(['--summary-all'], {
      env: { FB_PAGE_ACCESS_TOKEN: 'private-token' },
      getDb: async () => emptyFirestore(),
      loadAccountIds: async () => ({
        facebook: 'private-page-id',
        instagram: 'private-instagram-id',
        linkedinMember: 'private-member-urn',
        telegram: 'private-channel-id',
      }),
      now: () => new Date('2026-11-03T12:00:00.000Z'),
      log,
    });

    expect(report).toMatchObject({ status: 'ok', totalStaleCount: 0 });
    expect(report.reservations).toHaveLength(5);
    expect(report.reservations.every((row: { status: string; staleCount: number }) => row.status === 'ok' && row.staleCount === 0)).toBe(true);
    const output = String(log.mock.calls[0][0]);
    expect(output).toContain('## Stale social publish reservations');
    expect(output).toContain('Content fingerprint stored');
    expect(output).toContain('do not verify API read grants');
    for (const privateValue of ['private-token', 'private-page-id', 'private-instagram-id', 'private-member-urn', 'private-channel-id']) {
      expect(output).not.toContain(privateValue);
    }
  });

  it('marks account scopes without configured accounts instead of reporting zero activity', async () => {
    const report = await runSocialPublishReservationsCli(['--summary-all'], {
      getDb: async () => emptyFirestore(),
      loadAccountIds: async () => ({ facebook: 'configured-page' }),
      now: () => new Date('2026-11-03T12:00:00.000Z'),
      log: () => undefined,
    });

    expect(report.reservations.find((row: { platform: string; capGroup: string }) => row.platform === 'instagram' && row.capGroup === 'feed'))
      .toMatchObject({ status: 'not-configured', staleCount: null });
  });

  it('fails with unknown scopes when Remote Config cannot be read', async () => {
    const log = vi.fn();
    await expect(runSocialPublishReservationsCli(['--summary-all'], {
      getDb: async () => emptyFirestore(),
      loadAccountIds: async () => ({ remoteConfigAvailable: false, accounts: {} }),
      now: () => new Date('2026-11-03T12:00:00.000Z'),
      log,
    })).rejects.toThrow('could not be read or configured');

    const output = String(log.mock.calls[0][0]);
    expect(output).toContain('config-unknown');
    expect(output).toContain('unknown scopes: **5**');
    expect(output).toContain('across **0** readable scopes');
    expect(output).not.toContain('Total stale reservations: **0**');
  });

  it('rejects summary-all when a reservation scope or identifier is supplied', async () => {
    await expect(runSocialPublishReservationsCli(['--summary-all', '--platform=facebook'], {
      getDb: async () => emptyFirestore(),
      loadAccountIds: async () => ({}),
      log: () => undefined,
    })).rejects.toThrow('does not accept platform');
  });
});
