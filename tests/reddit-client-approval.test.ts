import { describe, expect, it, vi } from 'vitest';

import { getAccessToken, submitPost } from '../scripts/lib/reddit-client.mjs';
import { RC_TO_ENV } from '../scripts/load-rc-env.mjs';

describe('Reddit Data API explicit approval guard', () => {
  const credentials = {
    REDDIT_CLIENT_ID: 'client-id',
    REDDIT_CLIENT_SECRET: 'client-secret',
    REDDIT_USERNAME: 'poster',
    REDDIT_PASSWORD: 'password',
    REDDIT_USER_AGENT: 'web:frontaliere-test:v1 (by /u/test)',
  };

  it('does not mint a token from credentials alone', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(getAccessToken(credentials, fetchImpl as unknown as typeof fetch)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not submit with a supplied token unless approval is explicit', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    await expect(submitPost({
      env: credentials,
      token: 'existing-token',
      subreddit: 'frontaliere',
      kind: 'link',
      title: 'Article',
      url: 'https://frontaliereticino.ch/articoli-frontaliere/test/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).resolves.toMatchObject({ ok: false, error: 'Reddit Data API access is not explicitly approved' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('uses the API only after the explicit approval marker is true', async () => {
    const env = { ...credentials, REDDIT_DATA_API_APPROVED: 'true' };
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ access_token: 'token' }), { status: 200 }));

    await expect(getAccessToken(env, fetchImpl as unknown as typeof fetch)).resolves.toBe('token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps the approval marker from Remote Config into the publisher environment', () => {
    expect(RC_TO_ENV.REDDIT_DATA_API_APPROVED).toEqual(['REDDIT_DATA_API_APPROVED']);
  });
});
