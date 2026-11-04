import { describe, expect, it } from 'vitest';

import { provisionFacebookPageCredentials } from '../scripts/lib/facebook-token-setup.mjs';

const credentials = {
  client_email: 'firebase@example.test',
  private_key: 'private-key-fixture',
  project_id: 'project-fixture',
};

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function graphFixture({ scopes = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'instagram_basic', 'instagram_content_publish'], pages = null } = {}) {
  const requests: Array<{ url: URL; options: RequestInit }> = [];
  const fetchImpl = async (input: URL | RequestInfo, options: RequestInit = {}) => {
    const url = new URL(String(input));
    requests.push({ url, options });
    if (url.pathname.endsWith('/oauth/access_token')) {
      return response({ access_token: 'long-user-token-fixture', expires_in: 5184000 });
    }
    if (url.pathname.endsWith('/debug_token')) {
      const token = url.searchParams.get('input_token');
      return response({
        data: {
          is_valid: true,
          app_id: 'meta-app-fixture',
          scopes,
          expires_at: token === 'page-token-fixture' ? 0 : 1_800_000_000,
        },
      });
    }
    if (url.pathname.endsWith('/me/accounts')) {
      return response({ data: pages ?? [{
        id: 'page-fixture',
        name: 'Fixture Page',
        access_token: 'page-token-fixture',
        instagram_business_account: { id: 'ig-fixture' },
      }] });
    }
    if (url.pathname.endsWith('/ig-fixture')) return response({ id: 'ig-fixture' });
    throw new Error('unexpected Graph API request');
  };
  return { fetchImpl, requests };
}

describe('Facebook token setup', () => {
  it('verifies scopes and writes tokens plus expiry metadata to private Remote Config without returning token values', async () => {
    const { fetchImpl, requests } = graphFixture();
    let published: Record<string, any> | null = null;
    let updateNamespace = '';
    let removedClientKeys: string[] = [];
    const updateConfig = async ({ stage, namespace }: { stage: (template: any) => any; namespace: string }) => {
      const staged = stage({
        parameters: { INSTAGRAM_BUSINESS_ACCOUNT_ID: { defaultValue: { value: 'ig-fixture' } } },
        parameterGroups: {},
      });
      updateNamespace = namespace;
      published = staged.template?.parameters;
      return { ok: true, changed: staged.changed };
    };
    const removeClientConfig = async ({ names, namespace }: { names: string[]; namespace: string }) => {
      expect(namespace).toBe('firebase');
      removedClientKeys = names;
      return { ok: true, changed: true };
    };
    const result = await provisionFacebookPageCredentials({
      shortLivedUserToken: 'short-user-token-fixture',
      appId: 'meta-app-fixture',
      appSecret: 'app-secret-fixture',
      expectedInstagramAccountId: 'ig-fixture',
      credentials,
      fetchImpl,
      updateConfig,
      removeClientConfig,
      now: new Date('2026-11-04T00:00:00.000Z'),
    });

    expect(result).toEqual({
      pageId: 'page-fixture',
      userTokenExpiresAt: '2027-01-03T00:00:00.000Z',
      pageTokenExpiresAt: '0',
      instagramPublisherConfigured: true,
      changed: true,
    });
    expect(JSON.stringify(result)).not.toContain('short-user-token-fixture');
    expect(JSON.stringify(result)).not.toContain('long-user-token-fixture');
    expect(JSON.stringify(result)).not.toContain('page-token-fixture');
    expect(updateNamespace).toBe('firebase-server');
    expect(removedClientKeys).toEqual([
      'SERVER_FB_USER_ACCESS_TOKEN',
      'SERVER_FB_USER_ACCESS_TOKEN_EXPIRES_AT',
      'SERVER_FB_PAGE_ACCESS_TOKEN',
      'SERVER_FB_PAGE_ACCESS_TOKEN_EXPIRES_AT',
      'SERVER_INSTAGRAM_ACCESS_TOKEN',
      'SERVER_INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT',
    ]);
    expect(published).toMatchObject({
      FB_PAGE_ID: { defaultValue: { value: 'page-fixture' } },
      SERVER_FB_USER_ACCESS_TOKEN: { defaultValue: { value: 'long-user-token-fixture' } },
      SERVER_FB_USER_ACCESS_TOKEN_EXPIRES_AT: { defaultValue: { value: '2027-01-03T00:00:00.000Z' } },
      SERVER_FB_PAGE_ACCESS_TOKEN: { defaultValue: { value: 'page-token-fixture' } },
      SERVER_FB_PAGE_ACCESS_TOKEN_EXPIRES_AT: { defaultValue: { value: '0' } },
      SERVER_INSTAGRAM_ACCESS_TOKEN: { defaultValue: { value: 'page-token-fixture' } },
      SERVER_INSTAGRAM_ACCESS_TOKEN_EXPIRES_AT: { defaultValue: { value: '0' } },
    });
    expect(requests.find(({ url }) => url.pathname.endsWith('/me/accounts'))?.options.headers)
      .toMatchObject({ Authorization: 'Bearer long-user-token-fixture' });
  });

  it('fails closed when the Page token lacks the publish or read grant', async () => {
    const { fetchImpl } = graphFixture({ scopes: ['pages_show_list', 'pages_manage_posts'] });
    let published = false;

    await expect(provisionFacebookPageCredentials({
      shortLivedUserToken: 'short-user-token-fixture',
      appId: 'meta-app-fixture',
      appSecret: 'app-secret-fixture',
      credentials,
      fetchImpl,
      updateConfig: async () => { published = true; return { ok: true, changed: true }; },
    })).rejects.toThrow('pages_read_engagement');
    expect(published).toBe(false);
  });

  it('requires an exact Page selection when the Meta user manages multiple Pages', async () => {
    const pages = [
      { id: 'page-one', name: 'One', access_token: 'page-one-token' },
      { id: 'page-two', name: 'Two', access_token: 'page-two-token' },
    ];
    const { fetchImpl } = graphFixture({ pages });
    let published = false;

    await expect(provisionFacebookPageCredentials({
      shortLivedUserToken: 'short-user-token-fixture',
      appId: 'meta-app-fixture',
      appSecret: 'app-secret-fixture',
      credentials,
      fetchImpl,
      updateConfig: async () => { published = true; return { ok: true, changed: true }; },
    })).rejects.toThrow('META_TARGET_PAGE_ID');
    expect(published).toBe(false);
  });

  it('does not configure the Instagram publisher token unless Meta verifies the configured linked account and publish grants', async () => {
    const { fetchImpl } = graphFixture();
    let published: Record<string, any> | null = null;
    const updateConfig = async ({ stage }: { stage: (template: any) => any }) => {
      const staged = stage({
        parameters: { INSTAGRAM_BUSINESS_ACCOUNT_ID: { defaultValue: { value: 'another-instagram-account' } } },
        parameterGroups: {},
      });
      published = staged.template?.parameters;
      return { ok: true, changed: staged.changed };
    };

    const result = await provisionFacebookPageCredentials({
      shortLivedUserToken: 'short-user-token-fixture',
      appId: 'meta-app-fixture',
      appSecret: 'app-secret-fixture',
      credentials,
      fetchImpl,
      updateConfig,
      removeClientConfig: async () => ({ ok: true, changed: false }),
    });
    expect(result.instagramPublisherConfigured).toBe(false);
    expect(published).not.toHaveProperty('SERVER_INSTAGRAM_ACCESS_TOKEN');
  });
});
