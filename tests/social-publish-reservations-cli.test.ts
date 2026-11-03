import { describe, expect, it, vi } from 'vitest';
import { runSocialPublishReservationsCli } from '../scripts/social-publish-reservations.mjs';

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
