import { describe, expect, it, vi } from 'vitest';

import { collectTikTokAudienceSnapshot } from '../scripts/lib/tiktok-audience-insights.mjs';

const AS_OF = new Date('2026-11-03T12:00:00.000Z');

function response(user: Record<string, unknown>) {
  return new Response(JSON.stringify({
    data: { user },
    error: { code: 'ok', message: '' },
  }), { status: 200 });
}

describe('TikTok audience identity validation', () => {
  it('requires an expected account identity before calling the Display API', async () => {
    const fetchImpl = vi.fn();
    const result = await collectTikTokAudienceSnapshot({
      accessToken: 'fixture-token',
      expectedOpenId: '',
      asOf: AS_OF,
      fetchImpl: fetchImpl as any,
    });

    expect(result).toMatchObject({ status: 'identity-unverified', snapshot: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('stores follower metrics only for the exact authenticated open_id', async () => {
    const fetchImpl = vi.fn(async () => response({ open_id: 'target-open-id', follower_count: 42 }));
    const result = await collectTikTokAudienceSnapshot({
      accessToken: 'fixture-token',
      expectedOpenId: 'target-open-id',
      asOf: AS_OF,
      fetchImpl: fetchImpl as any,
    });

    expect(result).toMatchObject({
      status: 'available',
      snapshot: { channel: 'tiktok', metric: 'followers', value: 42 },
    });
    const requestUrl = new URL(String(fetchImpl.mock.calls[0][0]));
    expect(requestUrl.searchParams.get('fields')).toBe('open_id,follower_count');
  });

  it('rejects missing or mismatched account identities without creating a snapshot', async () => {
    const missing = await collectTikTokAudienceSnapshot({
      accessToken: 'fixture-token',
      expectedOpenId: 'target-open-id',
      asOf: AS_OF,
      fetchImpl: vi.fn(async () => response({ follower_count: 42 })) as any,
    });
    const mismatched = await collectTikTokAudienceSnapshot({
      accessToken: 'fixture-token',
      expectedOpenId: 'target-open-id',
      asOf: AS_OF,
      fetchImpl: vi.fn(async () => response({ open_id: 'other-account', follower_count: 999 })) as any,
    });

    expect(missing).toMatchObject({ status: 'identity-unverified', snapshot: null });
    expect(mismatched).toMatchObject({ status: 'identity-mismatch', snapshot: null });
  });
});
